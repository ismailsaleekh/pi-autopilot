import { createHash } from 'node:crypto';

import {
  AUTOPILOT_CLOSURE_GATE_STATUS_VALUES,
  AUTOPILOT_EXCEPTION_STATE_VALUES,
  AUTOPILOT_WORK_ITEM_STATE_VALUES,
  parseAutopilotStatusEntry,
} from '../contracts/index.ts';
import type {
  AutopilotMasterPlan,
  AutopilotState,
  AutopilotStatusEntry,
} from '../contracts/types.ts';
import {
  array,
  boolean,
  isJsonObject,
  object,
  str,
  type JsonObject,
} from './d65-semantic-graph.ts';
import { CoordinationRuntimeError } from './failures.ts';

// D65 complete-graph projection-only values. Package contracts intentionally
// preserve absent optional fields, whereas graph projection values encode those
// fields as explicit null. These closed parsers are therefore separate from the
// package parsers and are shared by producer, loader, and store comparison.

export interface D65GraphProjectionMember {
  readonly identity: string;
  readonly kind: 'work_items' | 'bughunt' | 'exceptions';
  readonly value: JsonObject;
}

export interface D65DiscoveredStatus {
  /** Normalized path relative to the exact runtime root. */
  readonly runtime_ref: string;
  readonly status: AutopilotStatusEntry;
}

export interface D65NonCoordinatorProjections {
  readonly work_items: readonly D65GraphProjectionMember[];
  readonly bughunt: readonly D65GraphProjectionMember[];
  readonly exceptions: readonly D65GraphProjectionMember[];
  readonly closure: JsonObject | null;
}

const PROJECTION_ID = /^gp:(?:work-item|bughunt|exception):[a-f0-9]{64}$/u;
const UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const WORK_ITEM_STATES = new Set<string>(AUTOPILOT_WORK_ITEM_STATE_VALUES);
const EXCEPTION_STATES = new Set<string>(AUTOPILOT_EXCEPTION_STATE_VALUES);
const CLOSURE_STATES = new Set<string>(AUTOPILOT_CLOSURE_GATE_STATUS_VALUES);

function fail(issue: string, detail: readonly string[] = []): never {
  throw new CoordinationRuntimeError('invalid-state', `semantic-graph-projection-mismatch: ${issue}`, [...detail]);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedText(record: JsonObject, field: string, label: string, maximum = 4096): string {
  return str(record, field, label, maximum);
}

function nullableText(record: JsonObject, field: string, label: string, maximum = 4096): string | null {
  if (record[field] === null) return null;
  return boundedText(record, field, label, maximum);
}

function stringArray(value: unknown, label: string, maximumItems = 100_000): readonly string[] {
  return Object.freeze(array(value, label, maximumItems).map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 4096 || entry.includes('\u0000')) fail(`${label}[${String(index)}] must be bounded non-empty text`);
    return entry;
  }));
}

function nullableUnitId(record: JsonObject, field: string, label: string): string | null {
  const value = nullableText(record, field, label, 128);
  if (value !== null && !UNIT_ID.test(value)) fail(`${label}.${field} is not a bounded unit id`);
  return value;
}

function sortedMembers<T extends D65GraphProjectionMember>(members: readonly T[]): readonly T[] {
  const sorted = [...members].sort((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]?.identity === sorted[index]?.identity) fail('projection contains a duplicate encoded identity', [sorted[index]?.identity ?? '']);
  }
  return Object.freeze(sorted);
}

/** Exact projection-only encoded identity. Natural bytes are never truncated. */
export function d65GraphProjectionIdentity(namespace: 'work-item' | 'bughunt' | 'exception', naturalIdentity: string): string {
  if (naturalIdentity.length === 0 || (namespace === 'work-item' && naturalIdentity.includes('\u0000'))) fail('projection natural identity is invalid', [namespace]);
  const identity = `gp:${namespace}:${sha256Hex(naturalIdentity)}`;
  if (!PROJECTION_ID.test(identity)) fail('projection identity encoding is invalid', [identity]);
  return identity;
}

export function parseD65WorkItemProjection(value: unknown): JsonObject {
  const label = 'semantic_graph.work_items';
  const record = object(value, label, [
    'work_item_id', 'state', 'source_changing', 'unit_ids', 'implementation_unit_id',
    'validation_unit_id', 'audit_ref', 'status_ref', 'validation_status_ref', 'summary',
  ]);
  const workItemId = boundedText(record, 'work_item_id', label, 192);
  const state = boundedText(record, 'state', label, 64);
  if (!WORK_ITEM_STATES.has(state)) fail(`${label}.state is invalid`, [state]);
  return Object.freeze({
    work_item_id: workItemId,
    state,
    source_changing: boolean(record, 'source_changing', label),
    unit_ids: stringArray(record['unit_ids'], `${label}.unit_ids`),
    implementation_unit_id: nullableUnitId(record, 'implementation_unit_id', label),
    validation_unit_id: nullableUnitId(record, 'validation_unit_id', label),
    audit_ref: nullableText(record, 'audit_ref', label, 1024),
    status_ref: nullableText(record, 'status_ref', label, 1024),
    validation_status_ref: nullableText(record, 'validation_status_ref', label, 1024),
    summary: boundedText(record, 'summary', label, 4096),
  });
}

export function parseD65BughuntProjection(value: unknown): JsonObject {
  const label = 'semantic_graph.bughunt';
  const record = object(value, label, [
    'schema_version', 'workstream', 'unit_id', 'role', 'attempt', 'verdict', 'severity', 'summary',
    'changed_paths', 'findings', 'commands', 'evidence_refs', 'report_ref', 'covered_witness_ids', 'next_action',
  ]);
  if (record['role'] !== 'bughunt') fail(`${label}.role must be bughunt`);
  const coveredWitnessIds = record['covered_witness_ids'];
  if (coveredWitnessIds !== null) stringArray(coveredWitnessIds, `${label}.covered_witness_ids`);
  const packageValue: Record<string, unknown> = { ...record };
  if (coveredWitnessIds === null) delete packageValue['covered_witness_ids'];
  const parsed = parseAutopilotStatusEntry(packageValue);
  if (parsed.role !== 'bughunt') fail(`${label}.role must be bughunt`);
  return Object.freeze({ ...parsed, covered_witness_ids: parsed.covered_witness_ids ?? null });
}

export function parseD65ExceptionProjection(value: unknown): JsonObject {
  const label = 'semantic_graph.exceptions';
  if (!isJsonObject(value)) fail(`${label} must be an object`);
  const exceptionKind = value['exception_kind'];
  if (exceptionKind === 'scope') {
    const record = object(value, label, ['exception_kind', 'exception_id', 'unit_id', 'audit_ref', 'paths', 'state', 'decision_ref', 'summary']);
    const state = boundedText(record, 'state', label, 64);
    if (!EXCEPTION_STATES.has(state)) fail(`${label}.state is invalid`, [state]);
    const unitId = boundedText(record, 'unit_id', label, 128);
    if (!UNIT_ID.test(unitId)) fail(`${label}.unit_id is invalid`, [unitId]);
    return Object.freeze({
      exception_kind: 'scope', exception_id: boundedText(record, 'exception_id', label, 192),
      unit_id: unitId, audit_ref: boundedText(record, 'audit_ref', label, 1024),
      paths: stringArray(record['paths'], `${label}.paths`), state,
      decision_ref: nullableText(record, 'decision_ref', label, 1024), summary: boundedText(record, 'summary', label),
    });
  }
  if (exceptionKind === 'protected-path') {
    const record = object(value, label, ['exception_kind', 'exception_id', 'unit_id', 'audit_ref', 'read_only_paths', 'untouchable_paths', 'state', 'decision_ref', 'summary']);
    const state = boundedText(record, 'state', label, 64);
    if (!EXCEPTION_STATES.has(state)) fail(`${label}.state is invalid`, [state]);
    const unitId = boundedText(record, 'unit_id', label, 128);
    if (!UNIT_ID.test(unitId)) fail(`${label}.unit_id is invalid`, [unitId]);
    return Object.freeze({
      exception_kind: 'protected-path', exception_id: boundedText(record, 'exception_id', label, 192),
      unit_id: unitId, audit_ref: boundedText(record, 'audit_ref', label, 1024),
      read_only_paths: stringArray(record['read_only_paths'], `${label}.read_only_paths`),
      untouchable_paths: stringArray(record['untouchable_paths'], `${label}.untouchable_paths`), state,
      decision_ref: nullableText(record, 'decision_ref', label, 1024), summary: boundedText(record, 'summary', label),
    });
  }
  fail(`${label}.exception_kind is invalid`);
}

export function parseD65ClosureProjection(value: unknown): JsonObject | null {
  if (value === null) return null;
  const label = 'semantic_graph.closure';
  const record = object(value, label, ['status', 'checked_at', 'blocking_reasons', 'bughunt_status_ref', 'decision_ref', 'summary']);
  const status = boundedText(record, 'status', label, 64);
  if (!CLOSURE_STATES.has(status)) fail(`${label}.status is invalid`, [status]);
  return Object.freeze({
    status,
    checked_at: nullableText(record, 'checked_at', label, 32),
    blocking_reasons: stringArray(record['blocking_reasons'], `${label}.blocking_reasons`),
    bughunt_status_ref: nullableText(record, 'bughunt_status_ref', label, 1024),
    decision_ref: nullableText(record, 'decision_ref', label, 1024),
    summary: boundedText(record, 'summary', label),
  });
}

/** Parse and identity-bind all loaded members of one projection-only index. */
export function assertD65ProjectionMembersClosed(kind: string, members: readonly Readonly<{ identity: string; kind: string; value: JsonObject }>[]): void {
  if (kind !== 'work_items' && kind !== 'bughunt' && kind !== 'exceptions') return;
  const seenNatural = new Set<string>();
  for (const member of members) {
    if (member.kind !== kind) fail('projection member kind differs from its index', [kind, member.kind, member.identity]);
    let expected: string;
    let natural: string;
    if (kind === 'work_items') {
      const parsed = parseD65WorkItemProjection(member.value);
      natural = String(parsed['work_item_id']);
      expected = d65GraphProjectionIdentity('work-item', natural);
    } else if (kind === 'bughunt') {
      const parsed = parseD65BughuntProjection(member.value);
      natural = `${String(parsed['unit_id'])}\u0000${String(parsed['attempt'])}`;
      expected = d65GraphProjectionIdentity('bughunt', natural);
    } else if (kind === 'exceptions') {
      const parsed = parseD65ExceptionProjection(member.value);
      natural = `${String(parsed['exception_kind'])}\u0000${String(parsed['exception_id'])}`;
      expected = d65GraphProjectionIdentity('exception', natural);
    } else {
      fail('unreachable non-coordinator projection kind', [kind]);
    }
    if (seenNatural.has(natural)) fail('projection contains a duplicate natural identity', [kind, natural]);
    seenNatural.add(natural);
    if (member.identity !== expected) fail('projection identity does not bind its complete natural identity', [kind, member.identity, expected]);
  }
}

/** Derive all non-coordinator graph projections from independently parsed package authority. */
export function normalizeD65NonCoordinatorProjections(
  masterPlan: AutopilotMasterPlan,
  state: AutopilotState,
  discoveredStatuses: readonly D65DiscoveredStatus[],
): D65NonCoordinatorProjections {
  if (masterPlan.workstream !== state.workstream) fail('master plan and state workstream disagree');
  const planUnitIds = Object.keys(masterPlan.units).sort();
  const stateUnitIds = Object.keys(state.units).sort();
  if (planUnitIds.length !== stateUnitIds.length || planUnitIds.some((unitId, index) => unitId !== stateUnitIds[index])) fail('state unit set does not exactly equal the master-plan unit set');
  const unitIds = new Set(planUnitIds);

  const workItemMembers: D65GraphProjectionMember[] = [];
  for (const [mapKey, workItem] of Object.entries(state.work_items ?? {})) {
    if (mapKey !== workItem.work_item_id) fail('work-item map key differs from embedded work_item_id', [mapKey, workItem.work_item_id]);
    for (const unitId of workItem.unit_ids) if (!unitIds.has(unitId)) fail('work-item names a unit outside the exact plan/state unit set', [mapKey, unitId]);
    if (workItem.implementation_unit_id !== undefined && !unitIds.has(workItem.implementation_unit_id)) fail('work-item implementation unit is outside the exact unit set', [mapKey, workItem.implementation_unit_id]);
    if (workItem.validation_unit_id !== undefined && !unitIds.has(workItem.validation_unit_id)) fail('work-item validation unit is outside the exact unit set', [mapKey, workItem.validation_unit_id]);
    const value = parseD65WorkItemProjection({
      work_item_id: workItem.work_item_id, state: workItem.state, source_changing: workItem.source_changing,
      unit_ids: workItem.unit_ids, implementation_unit_id: workItem.implementation_unit_id ?? null,
      validation_unit_id: workItem.validation_unit_id ?? null, audit_ref: workItem.audit_ref ?? null,
      status_ref: workItem.status_ref ?? null, validation_status_ref: workItem.validation_status_ref ?? null,
      summary: workItem.summary,
    });
    workItemMembers.push(Object.freeze({ identity: d65GraphProjectionIdentity('work-item', mapKey), kind: 'work_items', value }));
  }

  const statusRefs = new Set<string>();
  const bughuntMembers: D65GraphProjectionMember[] = [];
  const bughuntByRef = new Map<string, D65GraphProjectionMember>();
  for (const discovered of discoveredStatuses) {
    if (statusRefs.has(discovered.runtime_ref)) fail('two discovered status authorities use the same runtime ref', [discovered.runtime_ref]);
    statusRefs.add(discovered.runtime_ref);
    if (discovered.status.workstream !== state.workstream) fail('discovered status belongs to a different workstream', [discovered.runtime_ref]);
    if (discovered.status.role !== 'bughunt') continue;
    const natural = `${discovered.status.unit_id}\u0000${String(discovered.status.attempt)}`;
    const value = parseD65BughuntProjection({ ...discovered.status, covered_witness_ids: discovered.status.covered_witness_ids ?? null });
    const member = Object.freeze({ identity: d65GraphProjectionIdentity('bughunt', natural), kind: 'bughunt' as const, value });
    if (bughuntByRef.has(discovered.runtime_ref)) fail('bughunt status ref is ambiguous', [discovered.runtime_ref]);
    bughuntByRef.set(discovered.runtime_ref, member);
    bughuntMembers.push(member);
  }

  const exceptionIds = new Set<string>();
  const exceptionMembers: D65GraphProjectionMember[] = [];
  for (const exception of state.scope_exceptions ?? []) {
    if (exceptionIds.has(exception.exception_id)) fail('duplicate operator-facing exception_id across namespaces', [exception.exception_id]);
    exceptionIds.add(exception.exception_id);
    const value = parseD65ExceptionProjection({ exception_kind: 'scope', exception_id: exception.exception_id, unit_id: exception.unit_id, audit_ref: exception.audit_ref, paths: exception.paths, state: exception.state, decision_ref: exception.decision_ref ?? null, summary: exception.summary });
    exceptionMembers.push(Object.freeze({ identity: d65GraphProjectionIdentity('exception', `scope\u0000${exception.exception_id}`), kind: 'exceptions', value }));
  }
  for (const exception of state.protected_path_exceptions ?? []) {
    if (exceptionIds.has(exception.exception_id)) fail('duplicate operator-facing exception_id across namespaces', [exception.exception_id]);
    exceptionIds.add(exception.exception_id);
    const value = parseD65ExceptionProjection({ exception_kind: 'protected-path', exception_id: exception.exception_id, unit_id: exception.unit_id, audit_ref: exception.audit_ref, read_only_paths: exception.read_only_paths, untouchable_paths: exception.untouchable_paths, state: exception.state, decision_ref: exception.decision_ref ?? null, summary: exception.summary });
    exceptionMembers.push(Object.freeze({ identity: d65GraphProjectionIdentity('exception', `protected-path\u0000${exception.exception_id}`), kind: 'exceptions', value }));
  }

  let closure: JsonObject | null = null;
  if (state.closure_gate !== undefined) {
    const bughuntRef = state.closure_gate.bughunt_status_ref ?? null;
    if (bughuntRef !== null && !bughuntByRef.has(bughuntRef)) fail('closure bughunt_status_ref does not resolve to exactly one discovered bughunt status', [bughuntRef]);
    closure = parseD65ClosureProjection({
      status: state.closure_gate.status, checked_at: state.closure_gate.checked_at ?? null,
      blocking_reasons: state.closure_gate.blocking_reasons, bughunt_status_ref: bughuntRef,
      decision_ref: state.closure_gate.decision_ref ?? null, summary: state.closure_gate.summary,
    });
  }

  return Object.freeze({
    work_items: sortedMembers(workItemMembers),
    bughunt: sortedMembers(bughuntMembers),
    exceptions: sortedMembers(exceptionMembers),
    closure,
  });
}
