import { createHash } from 'node:crypto';

import { COORDINATOR_IMPLEMENTATION_BUILD } from './runtime-constants.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS, UNIT_FAILURE_CURRENT_PRODUCER_GENERATION } from './unit-failure-producer-provenance.ts';

export interface VersionedIngressAbsentFieldDefault { readonly field: string; readonly value: string | number | boolean | null }
export interface UnitFailureIngressIdentity { readonly workstream: string; readonly workstreamRun: string; readonly unitId: string; readonly attempt: number }
export interface UnitFailureVersionedIngressFacts {
  readonly action: 'quarantine' | 'reset' | 'preserve' | 'abort';
  readonly unitWorktreePath: string;
  readonly captureCommitSha: string | null;
  readonly captureRef: string | null;
  readonly originalSha256: `sha256:${string}`;
  readonly originalFields: readonly string[];
  readonly appliedDefaults: readonly VersionedIngressAbsentFieldDefault[];
}
export interface UnitFailureVersionedIngress {
  readonly kind: 'unit_failure';
  readonly ingress: {
    readonly family: 'autopilot.unit_failure.v1'; readonly schema_version: 'autopilot.unit_failure.v1'; readonly producer_build: string; readonly producer_generation: number; readonly current: boolean; readonly original_sha256: `sha256:${string}`; readonly original_bytes: Uint8Array; readonly document: Readonly<Record<string, unknown>>; readonly normalized_document: Readonly<Record<string, unknown>>; readonly original_fields: readonly string[]; readonly unknown_fields: readonly string[]; readonly applied_defaults: readonly VersionedIngressAbsentFieldDefault[];
  };
  readonly facts: UnitFailureVersionedIngressFacts;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const CURRENT_FIELDS = Object.freeze(['action', 'attempt', 'branch', 'capture_commit_sha', 'capture_ref', 'created_at', 'dirty_paths', 'git_common_dir', 'git_head_after', 'git_head_before', 'postcondition_worktree_clean', 'producer_build', 'producer_generation', 'schema_version', 'summary', 'unit_id', 'unit_worktree_path', 'workstream', 'workstream_run'].sort());
const HISTORICAL_INITIAL_FIELDS = Object.freeze(['action', 'attempt', 'created_at', 'dirty_paths', 'schema_version', 'summary', 'unit_id', 'unit_worktree_path', 'workstream', 'workstream_run'].sort());
const HISTORICAL_CAPTURE_FIELDS = Object.freeze([...HISTORICAL_INITIAL_FIELDS, 'capture_commit_sha'].sort());

function sorted(values: readonly string[]): readonly string[] { return Object.freeze([...new Set(values)].sort()); }
function digest(bytes: Uint8Array): `sha256:${string}` { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function json(bytes: Uint8Array): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as JsonRecord;
  } catch (error) {
    throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence is not valid UTF-8 JSON', [error instanceof Error ? error.message : String(error)]);
  }
}
function text(record: JsonRecord, field: string, max = 1024): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new CoordinationRuntimeError('invalid-state', `unit failure evidence ${field} must be bounded text`);
  return value;
}
function integer(record: JsonRecord, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new CoordinationRuntimeError('invalid-state', `unit failure evidence ${field} must be a positive integer`);
  return value;
}
function nullable(record: JsonRecord, field: string): string | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) throw new CoordinationRuntimeError('invalid-state', `unit failure evidence ${field} must be bounded text or null`);
  return value;
}
function action(record: JsonRecord): 'quarantine' | 'reset' | 'preserve' | 'abort' {
  const value = text(record, 'action', 32);
  if (value !== 'quarantine' && value !== 'reset' && value !== 'preserve' && value !== 'abort') throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence action is invalid');
  return value;
}
function stringArray(record: JsonRecord, field: string): void {
  const value = record[field];
  if (!Array.isArray(value) || value.length > 4096 || value.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 1024)) throw new CoordinationRuntimeError('invalid-state', `unit failure evidence ${field} must be a bounded string array`);
}

export function unitFailureProducerForHistoricalFieldSet(bytes: Uint8Array): { readonly generationName: 'phase2Initial' | 'captureCommitOnly'; readonly producer_build: string; readonly producer_generation: 1 | 2 } | null {
  const fields = Object.keys(json(bytes)).sort();
  if (fields.length === HISTORICAL_INITIAL_FIELDS.length && fields.every((field, index) => field === HISTORICAL_INITIAL_FIELDS[index])) return { generationName: 'phase2Initial', producer_build: BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS.phase2Initial, producer_generation: 1 };
  if (fields.length === HISTORICAL_CAPTURE_FIELDS.length && fields.every((field, index) => field === HISTORICAL_CAPTURE_FIELDS[index])) return { generationName: 'captureCommitOnly', producer_build: BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS.captureCommitOnly, producer_generation: 2 };
  return null;
}

export function parseCentralVersionedUnitFailureIngress(input: { readonly bytes: Uint8Array; readonly producer_build: string; readonly producer_generation: number; readonly identity: UnitFailureIngressIdentity }): UnitFailureVersionedIngress {
  const document = json(input.bytes);
  if (document['schema_version'] !== 'autopilot.unit_failure.v1') throw new CoordinationRuntimeError('schema-mismatch', 'persisted artifact schema_version does not match its selected family', ['autopilot.unit_failure.v1']);
  const fields = sorted(Object.keys(document));
  let exact: readonly string[];
  const defaults: VersionedIngressAbsentFieldDefault[] = [];
  let current = false;
  if (!Number.isSafeInteger(input.producer_generation)) throw new CoordinationRuntimeError('protocol-mismatch', 'persisted artifact producer generation is required explicitly and is never inferred', ['autopilot.unit_failure.v1', input.producer_build]);
  if (input.producer_build === BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS.phase2Initial && input.producer_generation === 1) {
    exact = HISTORICAL_INITIAL_FIELDS; defaults.push({ field: 'capture_commit_sha', value: null }, { field: 'capture_ref', value: null });
  } else if (input.producer_build === BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS.captureCommitOnly && input.producer_generation === 2) {
    exact = HISTORICAL_CAPTURE_FIELDS; defaults.push({ field: 'capture_ref', value: null });
  } else if (input.producer_build === COORDINATOR_IMPLEMENTATION_BUILD && input.producer_generation === UNIT_FAILURE_CURRENT_PRODUCER_GENERATION) {
    exact = CURRENT_FIELDS; current = true;
  } else {
    throw new CoordinationRuntimeError('protocol-mismatch', 'unsupported unit failure producer provenance', [input.producer_build, String(input.producer_generation)]);
  }
  const unknown = fields.filter((field) => !exact.includes(field));
  if (unknown.length > 0) throw new CoordinationRuntimeError('schema-mismatch', 'persisted artifact has unknown fields for its exact producer generation', ['autopilot.unit_failure.v1', ...unknown]);
  for (const field of exact) if (!fields.includes(field)) throw new CoordinationRuntimeError('schema-mismatch', 'persisted artifact is missing a required field for its exact producer generation', ['autopilot.unit_failure.v1', field]);
  if (Object.hasOwn(document, 'producer_build') && document['producer_build'] !== input.producer_build) throw new CoordinationRuntimeError('protocol-mismatch', 'persisted artifact producer_build field differs from selected provenance', ['autopilot.unit_failure.v1']);
  if (Object.hasOwn(document, 'producer_generation') && document['producer_generation'] !== input.producer_generation) throw new CoordinationRuntimeError('protocol-mismatch', 'persisted artifact producer_generation field differs from selected provenance', ['autopilot.unit_failure.v1']);
  const normalized: Record<string, unknown> = { ...document };
  const applied: VersionedIngressAbsentFieldDefault[] = [];
  for (const def of defaults) if (!fields.includes(def.field)) { normalized[def.field] = def.value; applied.push(def); }
  if (text(normalized, 'workstream', 192) !== input.identity.workstream || text(normalized, 'workstream_run', 192) !== input.identity.workstreamRun || text(normalized, 'unit_id', 192) !== input.identity.unitId || integer(normalized, 'attempt') !== input.identity.attempt) throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence identity does not match durable ownership');
  stringArray(normalized, 'dirty_paths');
  const parsedAction = action(normalized);
  const captureCommitSha = nullable(normalized, 'capture_commit_sha');
  const captureRef = nullable(normalized, 'capture_ref');
  if (current) {
    if ((parsedAction === 'quarantine' || parsedAction === 'preserve') && (captureCommitSha === null || captureRef === null)) throw new CoordinationRuntimeError('invalid-state', 'current quarantine/preserve unit failure evidence requires an immutable capture commit and ref');
    if ((parsedAction === 'reset' || parsedAction === 'abort') && (captureCommitSha !== null || captureRef !== null)) throw new CoordinationRuntimeError('invalid-state', 'clean reset/abort evidence cannot claim quarantine capture fields');
    if (normalized['postcondition_worktree_clean'] !== true) throw new CoordinationRuntimeError('invalid-state', 'current unit failure evidence must assert a clean postcondition');
    for (const field of ['git_head_before', 'git_head_after', 'git_common_dir', 'branch'] as const) text(normalized, field, field.startsWith('git_head') ? 64 : 1024);
  } else {
    if (parsedAction === 'quarantine' || parsedAction === 'preserve') throw new CoordinationRuntimeError('recovery-required', 'historical quarantine/preserve unit failure evidence lacks an exact capture ref; edit authority remains retained');
    if (captureCommitSha !== null || captureRef !== null) throw new CoordinationRuntimeError('invalid-state', 'historical reset/abort unit failure evidence cannot carry capture fields after generation defaults');
  }
  const originalSha = digest(input.bytes);
  return Object.freeze({ kind: 'unit_failure', ingress: Object.freeze({ family: 'autopilot.unit_failure.v1', schema_version: 'autopilot.unit_failure.v1', producer_build: input.producer_build, producer_generation: input.producer_generation, current, original_sha256: originalSha, original_bytes: new Uint8Array(input.bytes), document, normalized_document: Object.freeze(normalized), original_fields: fields, unknown_fields: Object.freeze(unknown), applied_defaults: Object.freeze(applied) }), facts: Object.freeze({ action: parsedAction, unitWorktreePath: text(normalized, 'unit_worktree_path', 1024), captureCommitSha, captureRef, originalSha256: originalSha, originalFields: fields, appliedDefaults: Object.freeze(applied) }) });
}
