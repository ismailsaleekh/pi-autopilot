import { createHash } from 'node:crypto';

import { parseAutopilotAuthority } from '../authority.ts';
import {
  parseAutopilotExecutionAudit,
  parseAutopilotExecutionCommit,
  parseAutopilotReceipt,
  parseAutopilotStatusEntry,
  parseAutopilotUnitSpec,
  type AutopilotMasterPlan,
  type AutopilotState,
} from '../contracts/index.ts';
import { parseAutopilotUnitMerge } from '../unit-merge.ts';
import { parseValidationEvidence, parseReservationValidationStaleness } from '../validation-staleness.ts';
import { parseCoordinationIntegrationConflict } from './contracts.ts';
import { COORDINATOR_IMPLEMENTATION_BUILD } from './runtime-constants.ts';
import { parseCentralVersionedUnitFailureIngress, unitFailureProducerForHistoricalFieldSet } from './unit-failure-ingress.ts';
import {
  D65_CAPACITY_DECISION_SCHEMA,
  D65_LAUNCH_POLICY_SCHEMA,
  D65_SUBSCRIPTION_PROBE_SCHEMA,
  parseD65CapacityDecision,
  parseD65LaunchPolicy,
  parseD65SubscriptionProbe,
} from './d65-launch-policy.ts';
import {
  D65_CONTINUATION_EVENT_SCHEMA,
  D65_PARENT_LOSS_SCHEMA,
  parseD65ContinuationEvent,
  parseD65ParentLoss,
} from './d65-continuation.ts';
import {
  D65_COLLECTION_KEYS,
  array,
  boolean,
  bytesSha256,
  integer,
  isJsonObject,
  object,
  str,
  type JsonObject,
} from './d65-semantic-graph.ts';
import { parseAutopilotChildTerminalAcceptance } from './terminal-acceptance.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { UNIT_FAILURE_CURRENT_PRODUCER_GENERATION } from './unit-failure-producer-provenance.ts';
import type { CoordinationAuthoritativeArtifact } from './types.ts';
import type { D65AuthorityInput } from './d65-graph-producer.ts';

// Complete-graph Git authority discovery. This registry is data, not a filename
// heuristic: a fixed root admits only its listed schemas/parser, and every leaf
// is independently read from G. Producer and store call the same pure algorithm
// over independently obtained Git observations.

export type D65GraphAuthorityCollection = (typeof D65_COLLECTION_KEYS)[number];
export interface D65GraphAuthorityParserContext {
  readonly bytes: Uint8Array;
  readonly ref: string;
}

export type D65GraphAuthorityParser = (value: unknown) => unknown;

export interface D65GraphRefExtractor {
  readonly field_path: string;
  readonly base: 'repository' | 'runtime';
  readonly target_collection: D65GraphAuthorityCollection | 'core';
  readonly digest_field_path: string | null;
  readonly byte_count_field_path: string | null;
  readonly traverse: boolean;
  /**
   * `required`: a missing target rejects (a backward reference to an already
   * produced artifact). `declared-output`: the field declares a FUTURE output
   * location (unit-spec status/receipt/evidence outputs); an absent target is
   * legal, a present target must land in the declared collection.
   * `external-optional`: the ref may name external signed evidence outside the
   * run-main repository (parent-loss graph/policy/heartbeat/status/doctor);
   * only a ref present in G's tree is traversed into graph authority.
   */
  readonly presence: 'required' | 'declared-output' | 'external-optional';
  /** `ref` names one file; `directory` recursively includes mode-100644 files. */
  readonly shape: 'ref' | 'directory';
  /** True when the field is an absolute package output path that must resolve beneath the exact runtime root. */
  readonly absolute_runtime_output: boolean;
}

export interface D65GraphAuthoritySchemaRegistration {
  readonly schema_version: string;
  readonly parser: D65GraphAuthorityParser;
  readonly ref_extractors: readonly D65GraphRefExtractor[];
}

export interface D65GraphAuthorityRegistryRow {
  readonly collection: D65GraphAuthorityCollection;
  readonly roots: readonly string[];
  readonly direct_children_only: boolean;
  readonly schemas: readonly D65GraphAuthoritySchemaRegistration[];
  readonly opaque: boolean;
}

export interface D65GraphTreeLeaf {
  readonly ref: string;
  readonly mode: '100644' | '100755' | '120000' | '160000';
  readonly type: 'blob' | 'commit';
  readonly oid: string;
}

export interface D65GraphAuthorityReader {
  readonly entries: readonly D65GraphTreeLeaf[];
  readBlob(ref: string): Uint8Array;
}

export interface D65DiscoveredGraphAuthority {
  readonly collections: Readonly<Record<D65GraphAuthorityCollection, readonly D65AuthorityInput[]>>;
  readonly parsed_by_ref: ReadonlyMap<string, unknown>;
  readonly runtime_prefix: string;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const GIT_OID = /^[a-f0-9]{40}$/u;
const RUNTIME_REF_CHARACTERS = /^[^\u0000-\u001f\u007f\\]+$/u;

function isRuntimeRef(value: string): boolean {
  if (!RUNTIME_REF_CHARACTERS.test(value) || value.startsWith('/')) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function fail(issue: string, detail: readonly string[] = []): never {
  throw new CoordinationRuntimeError('invalid-state', `semantic-graph-discovery-mismatch: ${issue}`, [...detail]);
}

function exact(value: unknown, label: string, fields: readonly string[]): JsonObject {
  return object(value, label, fields);
}

function text(record: JsonObject, field: string, label: string, maximum = 4096): string {
  return str(record, field, label, maximum);
}

function strings(value: unknown, label: string, maximum = 100_000): readonly string[] {
  return Object.freeze(array(value, label, maximum).map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 4096 || entry.includes('\u0000')) fail(`${label}[${String(index)}] must be bounded non-empty text`);
    return entry;
  }));
}

function nullableText(record: JsonObject, field: string, label: string): string | null {
  if (record[field] === null) return null;
  return text(record, field, label);
}

function sha(record: JsonObject, field: string, label: string): `sha256:${string}` {
  const value = text(record, field, label, 71);
  if (!SHA256.test(value)) fail(`${label}.${field} is not a SHA-256 digest`);
  return value as `sha256:${string}`;
}

function timestamp(record: JsonObject, field: string, label: string): string {
  const value = text(record, field, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value))) fail(`${label}.${field} is not an ISO millisecond timestamp`);
  return value;
}

function parseUnitMergeIntent(value: unknown): unknown {
  const label = 'autopilot.unit_merge_intent.v1';
  const row = exact(value, label, ['schema_version','workstream','workstream_run','autopilot_id','unit_id','role','attempt','unit_head','integration_before','created_at']);
  if (row['schema_version'] !== label) fail(`${label}.schema_version is invalid`);
  for (const field of ['workstream','workstream_run','autopilot_id','unit_id','role','unit_head','integration_before'] as const) text(row, field, label);
  integer(row, 'attempt', label, 1); timestamp(row, 'created_at', label);
  return row;
}

const UNIT_MERGE_FIELDS = ['schema_version','workstream','workstream_run','autopilot_id','active_run_epoch','unit_id','role','attempt','unit_branch','main_branch','unit_head','integration_before','integration_after','merge_commit_sha','changed_paths','status_ref','receipt_ref','audit_ref','execution_commit_ref','merged_at'] as const;
function parseClosedUnitMerge(value: unknown): unknown {
  exact(value, 'autopilot.unit_merge.v1', UNIT_MERGE_FIELDS);
  return parseAutopilotUnitMerge(value);
}

function parseIntegrationAnalysis(value: unknown): unknown {
  const label = 'autopilot.integration_analysis.v1';
  const row = exact(value, label, ['schema_version','workstream','workstream_run','unit_id','attempt','integration_before','unit_head','classification','created_at']);
  if (row['schema_version'] !== label) fail(`${label}.schema_version is invalid`);
  for (const field of ['workstream','workstream_run','unit_id','integration_before','unit_head'] as const) text(row, field, label);
  integer(row, 'attempt', label, 1); parseCoordinationIntegrationConflict(row['classification'], `${label}.classification`); timestamp(row, 'created_at', label);
  return row;
}

function parseMergeConflict(value: unknown): unknown {
  const label = 'autopilot.merge_conflict.v1';
  if (!isJsonObject(value)) fail(`${label} must be an object`);
  const hasRef = Object.hasOwn(value, 'integration_analysis_ref');
  const hasClassification = Object.hasOwn(value, 'classification');
  if (hasRef !== hasClassification) fail(`${label} classification-only fields must both be present or both absent`);
  const fields = hasRef
    ? ['schema_version','workstream','workstream_run','unit_id','attempt','unit_branch','integration_head','dirty_paths','abort_status','error','integration_analysis_ref','classification','created_at']
    : ['schema_version','workstream','workstream_run','unit_id','attempt','unit_branch','integration_head','dirty_paths','abort_status','error','created_at'];
  const row = exact(value, label, fields);
  if (row['schema_version'] !== label) fail(`${label}.schema_version is invalid`);
  for (const field of ['workstream','workstream_run','unit_id','unit_branch','integration_head','error'] as const) text(row, field, label);
  integer(row, 'attempt', label, 1);
  const abortStatus = row['abort_status'];
  if (typeof abortStatus !== 'number' || !Number.isSafeInteger(abortStatus) || abortStatus < -1 || abortStatus > 255) fail(`${label}.abort_status is invalid`);
  strings(row['dirty_paths'], `${label}.dirty_paths`); timestamp(row, 'created_at', label);
  if (hasRef) { text(row, 'integration_analysis_ref', label); parseCoordinationIntegrationConflict(row['classification'], `${label}.classification`); }
  return row;
}

function parseUnitFailure(value: unknown, context?: unknown): unknown {
  const label = 'autopilot.unit_failure.v1';
  if (!isJsonObject(value)) fail(`${label} must be an object`);
  if (value['schema_version'] !== label) fail(`${label}.schema_version is invalid`);
  const parserContext = isJsonObject(context) && context['bytes'] instanceof Uint8Array && typeof context['ref'] === 'string'
    ? context as unknown as D65GraphAuthorityParserContext
    : null;
  const bytes = parserContext?.bytes ?? new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  const provenance = (() => {
    if (Object.hasOwn(value, 'producer_build') || Object.hasOwn(value, 'producer_generation')) {
      return Object.freeze({ producer_build: text(value, 'producer_build', label, 192), producer_generation: integer(value, 'producer_generation', label, 1) });
    }
    const historical = unitFailureProducerForHistoricalFieldSet(bytes);
    if (historical === null) fail(`${label} lacks exact BUG-177 producer provenance`);
    return historical;
  })();
  const parsed = parseCentralVersionedUnitFailureIngress({
    bytes,
    producer_build: provenance.producer_build,
    producer_generation: provenance.producer_generation,
    identity: {
      workstream: text(value, 'workstream', label, 192),
      workstreamRun: text(value, 'workstream_run', label, 192),
      unitId: text(value, 'unit_id', label, 192),
      attempt: integer(value, 'attempt', label, 1),
    },
  });
  timestamp(parsed.ingress.normalized_document, 'created_at', label);
  return parsed.ingress.normalized_document;
}

function parseReconciliationIntent(value: unknown): unknown {
  const label = 'autopilot.reconciliation_intent.v1';
  const row = exact(value, label, ['schema_version','repo_id','autopilot_id','workstream_run','source','target_id','evidence_path','evidence_ref','evidence_sha256']);
  if (row['schema_version'] !== label) fail(`${label}.schema_version is invalid`);
  for (const field of ['repo_id','autopilot_id','workstream_run','source','target_id','evidence_path','evidence_ref'] as const) text(row, field, label);
  sha(row, 'evidence_sha256', label); return row;
}

function parseReconciliationSupersession(value: unknown): unknown {
  const label = 'autopilot.reconciliation_intent_supersession.v1';
  const row = exact(value, label, ['schema_version','disposition','repo_id','autopilot_id','workstream_run','source','target_id','evidence_ref','evidence_sha256','pending_intent_sha256','historical_generation','historical_action']);
  if (row['schema_version'] !== label || row['disposition'] !== 'current-evidence-regeneration-required' || row['source'] !== 'attempt-reset') fail(`${label} discriminator fields are invalid`);
  for (const field of ['repo_id','autopilot_id','workstream_run','target_id','evidence_ref','historical_generation','historical_action'] as const) text(row, field, label);
  sha(row, 'evidence_sha256', label); sha(row, 'pending_intent_sha256', label); return row;
}

function parseReservationIntegration(value: unknown): unknown {
  const label = 'autopilot.reservation_integration.v1';
  const row = exact(value, label, ['schema_version','repo_id','autopilot_id','workstream','workstream_run','obligation_id','reservation_id','predecessor_reservation_id','predecessor_released_event_seq','predecessor_terminal_sha','covered_paths','integration_head','integration_before','changed_paths','classification','integrated_at']);
  if (row['schema_version'] !== label) fail(`${label}.schema_version is invalid`);
  for (const field of ['repo_id','autopilot_id','workstream','workstream_run','obligation_id','reservation_id','predecessor_reservation_id','predecessor_terminal_sha','integration_head','integration_before'] as const) text(row, field, label);
  integer(row, 'predecessor_released_event_seq', label, 1); strings(row['covered_paths'], `${label}.covered_paths`); strings(row['changed_paths'], `${label}.changed_paths`); parseCoordinationIntegrationConflict(row['classification'], `${label}.classification`); timestamp(row, 'integrated_at', label); return row;
}

function parseReservationRepair(value: unknown): unknown {
  const label = 'autopilot.reservation_repair.v1';
  const row = exact(value, label, ['schema_version','repo_id','autopilot_id','workstream','workstream_run','obligation_id','reservation_id','predecessor_reservation_id','current_head','predecessor_terminal_sha','overlapping_paths','classification','state','required_next_state','created_at']);
  if (row['schema_version'] !== label || row['state'] !== 'repair-ready' || row['required_next_state'] !== 'repair-then-independent-revalidation') fail(`${label} discriminator fields are invalid`);
  for (const field of ['repo_id','autopilot_id','workstream','workstream_run','obligation_id','reservation_id','predecessor_reservation_id','current_head','predecessor_terminal_sha'] as const) text(row, field, label);
  strings(row['overlapping_paths'], `${label}.overlapping_paths`); parseCoordinationIntegrationConflict(row['classification'], `${label}.classification`); timestamp(row, 'created_at', label); return row;
}

function parseClosedValidationEvidence(value: unknown): unknown {
  exact(value, 'autopilot.validation_evidence.v1', ['schema_version','workstream','source_unit_id','source_attempt','validation_unit_id','validation_attempt','unit_merge_ref','integration_head','covered_paths','covered_path_groups','witness_ids','status_ref','status_sha256','receipt_ref','receipt_sha256','audit_ref','audit_sha256','verdict','validated_at']);
  return parseValidationEvidence(value);
}

function parseValidationStalenessV1(value: unknown): unknown {
  const label = 'autopilot.validation_staleness.v1';
  const row = exact(value, label, ['schema_version','workstream','stale_validation_ref','source_unit_id','source_attempt','invalidating_unit_merge_ref','invalidating_unit_id','invalidating_attempt','overlapping_paths','next_state','created_at']);
  if (row['schema_version'] !== label) fail(`${label}.schema_version is invalid`);
  for (const field of ['workstream','stale_validation_ref','source_unit_id','invalidating_unit_merge_ref','invalidating_unit_id','next_state'] as const) text(row, field, label);
  integer(row, 'source_attempt', label, 1); integer(row, 'invalidating_attempt', label, 1); strings(row['overlapping_paths'], `${label}.overlapping_paths`); timestamp(row, 'created_at', label); return row;
}

function parseClosedValidationStalenessV2(value: unknown): unknown {
  exact(value, 'autopilot.validation_staleness.v2', ['schema_version','workstream','stale_validation_ref','source_unit_id','source_attempt','invalidating_kind','invalidating_ref','invalidating_obligation_id','overlapping_paths','next_state','created_at']);
  return parseReservationValidationStaleness(value);
}

const extractor = (field_path: string, base: 'repository' | 'runtime', target_collection: D65GraphAuthorityCollection | 'core', digest_field_path: string | null = null, byte_count_field_path: string | null = null, options: Partial<Pick<D65GraphRefExtractor, 'presence' | 'shape' | 'absolute_runtime_output'>> = {}): D65GraphRefExtractor => Object.freeze({ field_path, base, target_collection, digest_field_path, byte_count_field_path, traverse: true, presence: options.presence ?? 'required', shape: options.shape ?? 'ref', absolute_runtime_output: options.absolute_runtime_output ?? false });
const schema = (schema_version: string, parser: D65GraphAuthorityParser, ref_extractors: readonly D65GraphRefExtractor[] = []): D65GraphAuthoritySchemaRegistration => Object.freeze({ schema_version, parser, ref_extractors: Object.freeze([...ref_extractors]) });
const row = (collection: D65GraphAuthorityCollection, roots: readonly string[], schemas: readonly D65GraphAuthoritySchemaRegistration[], direct_children_only = false, opaque = false): D65GraphAuthorityRegistryRow => Object.freeze({ collection, roots: Object.freeze([...roots]), direct_children_only, schemas: Object.freeze([...schemas]), opaque });

export const D65_GRAPH_AUTHORITY_REGISTRY: readonly D65GraphAuthorityRegistryRow[] = Object.freeze([
  row('authorities', ['authority/'], [schema('autopilot.authority.v1', parseAutopilotAuthority)], true),
  row('authorities', ['authority/continuation/'], [schema(D65_CONTINUATION_EVENT_SCHEMA, parseD65ContinuationEvent), schema(D65_PARENT_LOSS_SCHEMA, parseD65ParentLoss)]),
  row('specs', ['unit-specs/'], [schema('autopilot.unit_spec.v1', parseAutopilotUnitSpec, [
    extractor('upstream_refs[].status_ref', 'runtime', 'statuses'),
    extractor('upstream_refs[].audit_ref', 'runtime', 'audits'),
    extractor('status_output', 'runtime', 'statuses', null, null, { presence: 'declared-output', absolute_runtime_output: true }),
    extractor('receipt_output', 'runtime', 'receipts', null, null, { presence: 'declared-output', absolute_runtime_output: true }),
    extractor('evidence_dir', 'runtime', 'evidence', null, null, { presence: 'declared-output', shape: 'directory', absolute_runtime_output: true }),
  ])]),
  row('statuses', ['statuses/'], [schema('autopilot.status.v1', parseAutopilotStatusEntry, [
    extractor('findings[].evidence_refs[].path', 'runtime', 'evidence', 'findings[].evidence_refs[].sha256', 'findings[].evidence_refs[].byte_count'),
    extractor('evidence_refs[].path', 'runtime', 'evidence', 'evidence_refs[].sha256', 'evidence_refs[].byte_count'),
    extractor('report_ref.path', 'runtime', 'evidence', 'report_ref.sha256', 'report_ref.byte_count'),
    extractor('commands[].evidence_ref', 'runtime', 'evidence'),
  ])]),
  row('receipts', ['receipts/'], [schema('autopilot.receipt.v1', parseAutopilotReceipt)]),
  row('audits', ['execution-audits/'], [schema('autopilot.execution_audit.v1', parseAutopilotExecutionAudit, [
    extractor('evidence_refs[].path', 'runtime', 'evidence', 'evidence_refs[].sha256', 'evidence_refs[].byte_count'),
  ])]),
  row('execution_commits', ['execution-commits/'], [schema('autopilot.execution_commit.v1', parseAutopilotExecutionCommit, [extractor('status_ref','runtime','statuses'), extractor('receipt_ref','runtime','receipts'), extractor('audit_ref','runtime','audits')])]),
  row('terminal_acceptances', ['terminal-acceptances/'], [schema('autopilot.child_terminal_acceptance.v1', parseAutopilotChildTerminalAcceptance, [extractor('spec.ref','repository','specs','spec.sha256'), extractor('status.ref','repository','statuses','status.sha256'), extractor('receipt.ref','repository','receipts','receipt.sha256'), extractor('audit.ref','repository','audits','audit.sha256')])]),
  row('unit_merge_intents', ['unit-merge-intents/'], [schema('autopilot.unit_merge_intent.v1', parseUnitMergeIntent)]),
  row('unit_merges', ['unit-merges/'], [schema('autopilot.unit_merge.v1', parseClosedUnitMerge, [extractor('status_ref','runtime','statuses'), extractor('receipt_ref','runtime','receipts'), extractor('audit_ref','runtime','audits'), extractor('execution_commit_ref','runtime','execution_commits')])]),
  row('integration_analyses', ['integration-analyses/'], [schema('autopilot.integration_analysis.v1', parseIntegrationAnalysis)]),
  row('integration_analyses', ['merge-conflicts/'], [schema('autopilot.merge_conflict.v1', parseMergeConflict, [extractor('integration_analysis_ref','runtime','integration_analyses')])]),
  row('quarantine', ['quarantine/'], [schema('autopilot.unit_failure.v1', parseUnitFailure)]),
  row('reconciliation', ['coordination-reconciliation/'], [schema('autopilot.reconciliation_intent.v1', parseReconciliationIntent, [extractor('evidence_ref','repository','evidence','evidence_sha256')]), schema('autopilot.reconciliation_intent_supersession.v1', parseReconciliationSupersession, [extractor('evidence_ref','repository','evidence','evidence_sha256')])]),
  row('reconciliation', ['reservation-integration/'], [schema('autopilot.reservation_integration.v1', parseReservationIntegration)]),
  row('reconciliation', ['reservation-repairs/'], [schema('autopilot.reservation_repair.v1', parseReservationRepair)]),
  row('reconciliation', ['validation/'], [schema('autopilot.validation_evidence.v1', parseClosedValidationEvidence, [extractor('unit_merge_ref','runtime','unit_merges'), extractor('status_ref','runtime','statuses','status_sha256'), extractor('receipt_ref','runtime','receipts','receipt_sha256'), extractor('audit_ref','runtime','audits','audit_sha256')])]),
  row('reconciliation', ['validation-staleness/'], [schema('autopilot.validation_staleness.v1', parseValidationStalenessV1, [extractor('stale_validation_ref','runtime','reconciliation'), extractor('invalidating_unit_merge_ref','runtime','unit_merges')]), schema('autopilot.validation_staleness.v2', parseClosedValidationStalenessV2, [extractor('stale_validation_ref','runtime','reconciliation'), extractor('invalidating_ref','runtime','reconciliation')])]),
  row('evidence', ['evidence/'], [], false, true),
]);

// Continuation/parent-loss embedded {ref,sha256,byte_count} evidence bindings.
const CONTINUATION_REF_EXTRACTORS: readonly D65GraphRefExtractor[] = Object.freeze([
  extractor('failed_spec_ref.ref', 'repository', 'specs', 'failed_spec_ref.sha256', 'failed_spec_ref.byte_count'),
  extractor('failed_receipt_ref.ref', 'repository', 'receipts', 'failed_receipt_ref.sha256', 'failed_receipt_ref.byte_count'),
  extractor('evidence_refs[].ref', 'repository', 'evidence', 'evidence_refs[].sha256', 'evidence_refs[].byte_count'),
]);
const PARENT_LOSS_REF_EXTRACTORS: readonly D65GraphRefExtractor[] = Object.freeze([
  extractor('last_graph.ref', 'repository', 'evidence', 'last_graph.sha256', 'last_graph.byte_count', { presence: 'external-optional' }),
  extractor('last_policy.ref', 'repository', 'authorities', 'last_policy.sha256', 'last_policy.byte_count', { presence: 'external-optional' }),
  extractor('last_heartbeat.ref', 'repository', 'evidence', 'last_heartbeat.sha256', 'last_heartbeat.byte_count', { presence: 'external-optional' }),
  extractor('status_ref.ref', 'repository', 'evidence', 'status_ref.sha256', 'status_ref.byte_count', { presence: 'external-optional' }),
  extractor('doctor_ref.ref', 'repository', 'evidence', 'doctor_ref.sha256', 'doctor_ref.byte_count', { presence: 'external-optional' }),
]);

export const D65_GRAPH_EXTERNAL_AUTHORITY_SCHEMAS: readonly D65GraphAuthoritySchemaRegistration[] = Object.freeze([
  schema(D65_LAUNCH_POLICY_SCHEMA, parseD65LaunchPolicy, [extractor('capacity_decision_ref','repository','authorities','capacity_decision_sha256')]),
  schema(D65_CAPACITY_DECISION_SCHEMA, parseD65CapacityDecision, [extractor('audit_ref','repository','evidence','audit_sha256')]),
  schema(D65_SUBSCRIPTION_PROBE_SCHEMA, parseD65SubscriptionProbe, [extractor('trigger_continuation_ref','repository','authorities','trigger_continuation_sha256'), extractor('evidence_refs[]','repository','evidence')]),
  schema(D65_CONTINUATION_EVENT_SCHEMA, parseD65ContinuationEvent, CONTINUATION_REF_EXTRACTORS),
  schema(D65_PARENT_LOSS_SCHEMA, parseD65ParentLoss, PARENT_LOSS_REF_EXTRACTORS),
]);

// Core-seed extractors (accepted amendment §3): state units/work-items/
// exceptions/closure and master-plan mission_ref seed the transitive closure.
export const D65_GRAPH_STATE_REF_EXTRACTORS: readonly D65GraphRefExtractor[] = Object.freeze([
  extractor('units{}.spec_ref', 'runtime', 'specs'),
  extractor('units{}.status_ref', 'runtime', 'statuses'),
  extractor('units{}.receipt_ref', 'runtime', 'receipts'),
  extractor('work_items{}.audit_ref', 'runtime', 'audits'),
  extractor('work_items{}.status_ref', 'runtime', 'statuses'),
  extractor('work_items{}.validation_status_ref', 'runtime', 'statuses'),
  extractor('scope_exceptions[].audit_ref', 'runtime', 'audits'),
  extractor('scope_exceptions[].decision_ref', 'runtime', 'evidence'),
  extractor('protected_path_exceptions[].audit_ref', 'runtime', 'audits'),
  extractor('protected_path_exceptions[].decision_ref', 'runtime', 'evidence'),
  extractor('closure_gate.bughunt_status_ref', 'runtime', 'statuses'),
  extractor('closure_gate.decision_ref', 'runtime', 'evidence'),
]);
export const D65_GRAPH_MASTER_PLAN_REF_EXTRACTORS: readonly D65GraphRefExtractor[] = Object.freeze([
  extractor('mission_ref', 'runtime', 'core'),
]);

function normalizePrefix(prefix: string, workstream: string): string {
  const expected = `.pi/autopilot/${workstream}`;
  if (prefix !== expected || !isRuntimeRef(prefix)) fail('runtime_prefix does not equal the exact run workstream authority root', [prefix, expected]);
  return prefix;
}

function assertRef(ref: string): void {
  if (!isRuntimeRef(ref) || ref.endsWith('/') || ref !== ref.normalize('NFC')) fail('Git authority ref is not one normalized NFC repository-relative path', [ref]);
}

function parseJson(bytes: Uint8Array, ref: string): unknown {
  let textValue: string;
  try { textValue = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) { fail('authority blob is not valid UTF-8', [ref, error instanceof Error ? error.message : String(error)]); }
  try { return JSON.parse(textValue) as unknown; }
  catch (error) { fail('authority blob is not valid JSON', [ref, error instanceof Error ? error.message : String(error)]); }
}

export function d65GraphAuthorityIdentity(collection: D65GraphAuthorityCollection, ref: string): string {
  return `ga:${collection}:${createHash('sha256').update(ref, 'utf8').digest('hex')}`;
}

export function d65GitBlobOid(bytes: Uint8Array): string {
  const header = new TextEncoder().encode(`blob ${String(bytes.byteLength)}\u0000`);
  return createHash('sha1').update(header).update(bytes).digest('hex');
}

function emptyCollections(): Record<D65GraphAuthorityCollection, D65AuthorityInput[]> {
  const out = Object.create(null) as Record<D65GraphAuthorityCollection, D65AuthorityInput[]>;
  for (const key of D65_COLLECTION_KEYS) out[key] = [];
  return out;
}

function registrationForRuntimeRef(runtimeRelativeRef: string): D65GraphAuthorityRegistryRow | null {
  let selected: D65GraphAuthorityRegistryRow | null = null;
  let selectedRootLength = -1;
  for (const candidate of D65_GRAPH_AUTHORITY_REGISTRY) {
    for (const root of candidate.roots) {
      if (!runtimeRelativeRef.startsWith(root)) continue;
      const suffix = runtimeRelativeRef.slice(root.length);
      if (suffix.length === 0 || candidate.direct_children_only && suffix.includes('/')) continue;
      if (root.length > selectedRootLength) { selected = candidate; selectedRootLength = root.length; }
      else if (root.length === selectedRootLength && selected !== candidate) fail('authority ref matches two equal-precedence registry roots', [runtimeRelativeRef, root]);
    }
  }
  return selected;
}

function schemaRegistration(rowValue: D65GraphAuthorityRegistryRow, parsed: unknown, ref: string): D65GraphAuthoritySchemaRegistration | null {
  if (rowValue.opaque) return null;
  if (!isJsonObject(parsed) || typeof parsed['schema_version'] !== 'string') fail('registered authority JSON lacks a string schema_version', [ref]);
  const matching = rowValue.schemas.filter((entry) => entry.schema_version === parsed['schema_version']);
  if (matching.length !== 1 || matching[0] === undefined) fail('authority schema is not admitted at its fixed registry root', [ref, String(parsed['schema_version'])]);
  return matching[0];
}

function runD65GraphAuthorityParser(registration: D65GraphAuthoritySchemaRegistration, parsed: unknown, bytes: Uint8Array, ref: string): unknown {
  if (registration.schema_version === 'autopilot.unit_failure.v1') return (registration.parser as (value: unknown, context: D65GraphAuthorityParserContext) => unknown)(parsed, { bytes, ref });
  return registration.parser(parsed);
}

function externalRegistration(schemaVersion: string): D65GraphAuthoritySchemaRegistration {
  const matching = D65_GRAPH_EXTERNAL_AUTHORITY_SCHEMAS.filter((entry) => entry.schema_version === schemaVersion);
  if (matching.length !== 1 || matching[0] === undefined) fail('accepted run-main task artifact has no external authority registry assignment', [schemaVersion]);
  return matching[0];
}

function assertExternalPath(schemaVersion: string, ref: string, parsed: unknown): void {
  if (!isJsonObject(parsed)) fail('external authority is not an object', [ref]);
  if (schemaVersion === D65_LAUNCH_POLICY_SCHEMA) {
    const id = parsed['policy_id']; if (typeof id !== 'string' || ref !== `authority/launch-policies/${id}.json`) fail('launch policy ref does not bind policy_id', [ref]);
  } else if (schemaVersion === D65_SUBSCRIPTION_PROBE_SCHEMA) {
    const sequence = parsed['probe_sequence']; const id = parsed['probe_id'];
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1 || typeof id !== 'string' || ref !== `authority/subscription-probes/${String(sequence).padStart(20, '0')}-${id}.json`) fail('subscription probe ref does not bind sequence and probe_id', [ref]);
  }
}

// ---- exact transitive-ref extractor execution (accepted amendment §3) -------

interface D65ExtractedRefBinding {
  readonly raw: string;
  readonly sha256: `sha256:${string}` | null;
  readonly byte_count: number | null;
}

function pathSegments(fieldPath: string): readonly string[] {
  return fieldPath.split('.');
}

function segmentKind(segment: string): { readonly name: string; readonly kind: 'field' | 'array' | 'record' } {
  if (segment.endsWith('[]')) return { name: segment.slice(0, -2), kind: 'array' };
  if (segment.endsWith('{}')) return { name: segment.slice(0, -2), kind: 'record' };
  return { name: segment, kind: 'field' };
}

/** Walk all containers addressed by every segment except the final leaf. */
function walkContainers(value: unknown, segments: readonly string[], sourceRef: string, fieldPath: string): readonly unknown[] {
  let cursors: readonly unknown[] = [value];
  for (const segment of segments) {
    const { name, kind } = segmentKind(segment);
    const next: unknown[] = [];
    for (const cursor of cursors) {
      if (cursor === undefined || cursor === null) continue;
      if (!isJsonObject(cursor)) fail('transitive ref extractor path crosses a non-object container', [sourceRef, fieldPath, segment]);
      const child = cursor[name];
      if (child === undefined || child === null) continue;
      if (kind === 'array') {
        if (!Array.isArray(child)) fail('transitive ref extractor expected an array container', [sourceRef, fieldPath, segment]);
        for (const entry of child) next.push(entry);
      } else if (kind === 'record') {
        if (!isJsonObject(child)) fail('transitive ref extractor expected a record container', [sourceRef, fieldPath, segment]);
        for (const entry of Object.values(child)) next.push(entry);
      } else {
        next.push(child);
      }
    }
    cursors = next;
  }
  return cursors;
}

function extractRefBindings(parsed: unknown, extractorRow: D65GraphRefExtractor, sourceRef: string): readonly D65ExtractedRefBinding[] {
  const segments = pathSegments(extractorRow.field_path);
  const container = segments.slice(0, -1);
  const leaf = segments[segments.length - 1];
  if (leaf === undefined) fail('transitive ref extractor has an empty field path', [sourceRef]);
  const digestLeaf = extractorRow.digest_field_path === null ? null : pathSegments(extractorRow.digest_field_path).at(-1) ?? null;
  const countLeaf = extractorRow.byte_count_field_path === null ? null : pathSegments(extractorRow.byte_count_field_path).at(-1) ?? null;
  if (extractorRow.digest_field_path !== null && pathSegments(extractorRow.digest_field_path).slice(0, -1).join('.') !== container.join('.')) fail('transitive ref extractor digest path does not share the ref container', [sourceRef, extractorRow.field_path, extractorRow.digest_field_path]);
  if (extractorRow.byte_count_field_path !== null && pathSegments(extractorRow.byte_count_field_path).slice(0, -1).join('.') !== container.join('.')) fail('transitive ref extractor byte-count path does not share the ref container', [sourceRef, extractorRow.field_path, extractorRow.byte_count_field_path]);
  const bindings: D65ExtractedRefBinding[] = [];
  const leafKind = segmentKind(leaf);
  for (const containerValue of walkContainers(parsed, container, sourceRef, extractorRow.field_path)) {
    if (containerValue === undefined || containerValue === null) continue;
    if (!isJsonObject(containerValue)) fail('transitive ref extractor leaf container is not an object', [sourceRef, extractorRow.field_path]);
    const rawLeaf = containerValue[leafKind.name];
    if (rawLeaf === undefined || rawLeaf === null) continue;
    const digestValue = digestLeaf === null ? null : containerValue[segmentKind(digestLeaf).name];
    const countValue = countLeaf === null ? null : containerValue[segmentKind(countLeaf).name];
    const digest = digestValue === undefined || digestValue === null ? null : (() => {
      if (typeof digestValue !== 'string' || !SHA256.test(digestValue)) fail('transitive ref extractor digest binding is not a canonical SHA-256', [sourceRef, extractorRow.field_path]);
      return digestValue as `sha256:${string}`;
    })();
    const count = countValue === undefined || countValue === null ? null : (() => {
      if (typeof countValue !== 'number' || !Number.isSafeInteger(countValue) || countValue < 0) fail('transitive ref extractor byte-count binding is invalid', [sourceRef, extractorRow.field_path]);
      return countValue;
    })();
    if (leafKind.kind === 'array') {
      if (!Array.isArray(rawLeaf)) fail('transitive ref extractor expected an array leaf', [sourceRef, extractorRow.field_path]);
      for (const entry of rawLeaf) {
        if (typeof entry !== 'string') fail('transitive ref extractor array leaf entry is not a string ref', [sourceRef, extractorRow.field_path]);
        bindings.push(Object.freeze({ raw: entry, sha256: digest, byte_count: count }));
      }
      continue;
    }
    if (typeof rawLeaf !== 'string') fail('transitive ref extractor leaf is not a string ref', [sourceRef, extractorRow.field_path]);
    bindings.push(Object.freeze({ raw: rawLeaf, sha256: digest, byte_count: count }));
  }
  return Object.freeze(bindings);
}

/** Discover every fixed-root and accepted external authority blob from exact G. */
export function discoverD65GraphAuthority(input: {
  readonly readGitAtG: D65GraphAuthorityReader;
  readonly registry?: readonly D65GraphAuthorityRegistryRow[];
  readonly acceptedArtifacts: readonly CoordinationAuthoritativeArtifact[];
  readonly repoId: string;
  readonly workstreamRun: string;
  readonly workstream: string;
  readonly runtimePrefix: string;
  /** Absolute run-main worktree path; mandatory to resolve absolute unit-spec outputs. */
  readonly mainWorktreePath?: string;
  /** Parsed core state/master-plan seeds for the transitive closure. */
  readonly coreSeeds?: Readonly<{ state: AutopilotState; master_plan: AutopilotMasterPlan }>;
}): D65DiscoveredGraphAuthority {
  const registry = input.registry ?? D65_GRAPH_AUTHORITY_REGISTRY;
  if (registry !== D65_GRAPH_AUTHORITY_REGISTRY) fail('alternate graph authority registry is not permitted');
  const runtimePrefix = normalizePrefix(input.runtimePrefix, input.workstream);
  const prefix = `${runtimePrefix}/`;
  const collections = emptyCollections();
  const parsedByRef = new Map<string, unknown>();
  const leaves = new Map<string, D65GraphTreeLeaf>();
  const aliases = new Map<string, string>();
  for (const leaf of input.readGitAtG.entries) {
    assertRef(leaf.ref);
    if (!GIT_OID.test(leaf.oid)) fail('Git authority tree entry has an invalid object id', [leaf.ref, leaf.oid]);
    if (leaves.has(leaf.ref)) fail('Git authority tree contains a duplicate raw path', [leaf.ref]);
    const folded = leaf.ref.normalize('NFC').toLocaleLowerCase('en-US');
    const alias = aliases.get(folded);
    if (alias !== undefined && alias !== leaf.ref) fail('Git authority tree contains an NFC/case-fold alias', [alias, leaf.ref]);
    aliases.set(folded, leaf.ref); leaves.set(leaf.ref, leaf);
  }

  const acceptedByRef = new Map<string, CoordinationAuthoritativeArtifact>();
  for (const artifact of input.acceptedArtifacts) {
    if (artifact.repo_id !== input.repoId || artifact.source_run !== input.workstreamRun || artifact.source_type !== 'task' || artifact.source_scope !== 'run-main') continue;
    if (artifact.document_schema_version === 'autopilot.semantic_graph.v1' || artifact.artifact_id.startsWith('semantic-graph-bootstrap:')) continue;
    const prior = acceptedByRef.get(artifact.evidence.ref);
    if (prior !== undefined) fail('two accepted run-main artifacts claim the same ref', [artifact.evidence.ref, prior.artifact_id, artifact.artifact_id]);
    acceptedByRef.set(artifact.evidence.ref, artifact);
  }

  for (const leaf of leaves.values()) {
    if (!leaf.ref.startsWith(prefix)) continue;
    const runtimeRef = leaf.ref.slice(prefix.length);
    const registration = (() => {
      let selected: D65GraphAuthorityRegistryRow | null = null;
      let length = -1;
      for (const candidate of registry) for (const root of candidate.roots) {
        if (!runtimeRef.startsWith(root)) continue;
        const suffix = runtimeRef.slice(root.length);
        if (suffix.length === 0 || candidate.direct_children_only && suffix.includes('/')) continue;
        if (root.length > length) { selected = candidate; length = root.length; }
        else if (root.length === length && selected !== candidate) fail('authority ref matches ambiguous registry roots', [leaf.ref]);
      }
      return selected;
    })();
    if (registration === null) {
      const underDeclaredRoot = registry.some((candidate) => candidate.roots.some((root) => runtimeRef.startsWith(root)));
      if (underDeclaredRoot) fail('fixed authority root contains an undeclared nested path', [leaf.ref]);
      continue;
    }
    if (leaf.mode !== '100644' || leaf.type !== 'blob') fail('fixed-root authority entry is not a mode-100644 regular Git blob', [leaf.ref, leaf.mode, leaf.type]);
    const bytes = input.readGitAtG.readBlob(leaf.ref);
    if (d65GitBlobOid(bytes) !== leaf.oid) fail('fixed-root authority bytes do not equal the named Git blob object', [leaf.ref, leaf.oid]);
    let parsed: unknown = null;
    let schemaVersion: string | null = null;
    if (!registration.opaque) {
      parsed = parseJson(bytes, leaf.ref);
      const admitted = schemaRegistration(registration, parsed, leaf.ref);
      if (admitted === null) fail('non-opaque registry row lost its parser', [leaf.ref]);
      runD65GraphAuthorityParser(admitted, parsed, bytes, leaf.ref);
      schemaVersion = admitted.schema_version;
      if ((schemaVersion === D65_CONTINUATION_EVENT_SCHEMA || schemaVersion === D65_PARENT_LOSS_SCHEMA) && acceptedByRef.get(leaf.ref)?.document_schema_version !== schemaVersion) fail('continuation authority lacks exactly one matching accepted artifact row', [leaf.ref, schemaVersion]);
    }
    parsedByRef.set(leaf.ref, parsed);
    collections[registration.collection].push(Object.freeze({ identity: d65GraphAuthorityIdentity(registration.collection, leaf.ref), ref: leaf.ref, git_mode: '100644', git_blob_oid: leaf.oid, sha256: bytesSha256(bytes), byte_count: bytes.byteLength, document_schema_version: schemaVersion }));
  }

  for (const artifact of acceptedByRef.values()) {
    const fixedRegistration = artifact.evidence.ref.startsWith(prefix) ? registrationForRuntimeRef(artifact.evidence.ref.slice(prefix.length)) : null;
    if (fixedRegistration !== null) {
      const discovered = collections[fixedRegistration.collection].find((entry) => entry.ref === artifact.evidence.ref);
      if (discovered === undefined || discovered.sha256 !== artifact.evidence.sha256 || discovered.document_schema_version !== artifact.document_schema_version) fail('accepted fixed-root artifact row disagrees with independently discovered G bytes', [artifact.artifact_id, artifact.evidence.ref]);
      continue;
    }
    if (artifact.document_schema_version === D65_CONTINUATION_EVENT_SCHEMA || artifact.document_schema_version === D65_PARENT_LOSS_SCHEMA) fail('continuation/parent-loss accepted artifact is outside its exact runtime authority root', [artifact.artifact_id, artifact.evidence.ref]);
    const admitted = externalRegistration(artifact.document_schema_version);
    const leaf = leaves.get(artifact.evidence.ref);
    if (leaf === undefined || leaf.mode !== '100644' || leaf.type !== 'blob') fail('accepted external authority ref is absent or not a mode-100644 Git blob at G', [artifact.artifact_id, artifact.evidence.ref]);
    const bytes = input.readGitAtG.readBlob(leaf.ref);
    if (d65GitBlobOid(bytes) !== leaf.oid) fail('external authority bytes do not equal the named Git blob object', [leaf.ref, leaf.oid]);
    if (bytesSha256(bytes) !== artifact.evidence.sha256) fail('accepted external authority digest disagrees with G bytes', [artifact.artifact_id, artifact.evidence.ref]);
    const parsed = parseJson(bytes, leaf.ref); runD65GraphAuthorityParser(admitted, parsed, bytes, leaf.ref); assertExternalPath(admitted.schema_version, leaf.ref, parsed);
    parsedByRef.set(leaf.ref, parsed);
    collections.authorities.push(Object.freeze({ identity: d65GraphAuthorityIdentity('authorities', leaf.ref), ref: leaf.ref, git_mode: '100644', git_blob_oid: leaf.oid, sha256: artifact.evidence.sha256, byte_count: bytes.byteLength, document_schema_version: admitted.schema_version }));
  }

  // ---- exact transitive-ref closure (accepted amendment §3) ----------------
  // Every JSON-parsed source (core seeds, fixed-root objects, accepted external
  // authority objects) is enumerated up front, and the only members the closure
  // may ADD are opaque evidence blobs (which carry no extractors), so a single
  // pass over all sources IS the fixed point.
  const assignments = new Map<string, D65GraphAuthorityCollection>();
  for (const key of D65_COLLECTION_KEYS) for (const entry of collections[key]) assignments.set(entry.ref, key);
  const runtimeRootAbs = input.mainWorktreePath === undefined ? null : `${input.mainWorktreePath.replace(/\\/gu, '/').replace(/\/$/u, '')}/${runtimePrefix}`;
  const includeOpaqueEvidence = (ref: string, binding: D65ExtractedRefBinding | null, sourceRef: string, fieldPath: string): void => {
    const existing = assignments.get(ref);
    const leaf = leaves.get(ref);
    if (leaf === undefined) fail('transitive authority ref does not resolve to a Git tree entry at G', [sourceRef, fieldPath, ref]);
    if (leaf.mode !== '100644' || leaf.type !== 'blob') fail('transitive authority target is not a mode-100644 regular Git blob', [sourceRef, ref, leaf.mode]);
    const bytes = input.readGitAtG.readBlob(ref);
    if (d65GitBlobOid(bytes) !== leaf.oid) fail('transitive authority bytes do not equal the named Git blob object', [ref, leaf.oid]);
    if (binding !== null && binding.sha256 !== null && bytesSha256(bytes) !== binding.sha256) fail('transitive authority digest binding does not match target bytes', [sourceRef, fieldPath, ref]);
    if (binding !== null && binding.byte_count !== null && bytes.byteLength !== binding.byte_count) fail('transitive authority byte-count binding does not match target bytes', [sourceRef, fieldPath, ref]);
    if (existing !== undefined) {
      if (existing !== 'evidence') fail('transitive authority ref receives two conflicting collection assignments', [sourceRef, ref, existing, 'evidence']);
      return;
    }
    assignments.set(ref, 'evidence');
    collections.evidence.push(Object.freeze({ identity: d65GraphAuthorityIdentity('evidence', ref), ref, git_mode: '100644', git_blob_oid: leaf.oid, sha256: bytesSha256(bytes), byte_count: bytes.byteLength, document_schema_version: null }));
  };
  const normalizeRef = (raw: string, extractorRow: D65GraphRefExtractor, sourceRef: string): string | null => {
    let value = raw.replace(/\\/gu, '/');
    if (extractorRow.absolute_runtime_output) {
      // Absolute package outputs are authority ONLY when they resolve beneath
      // the exact runtime root; any other absolute path is non-authority and is
      // never traversed (accepted amendment §3).
      if (!value.startsWith('/')) fail('declared-output extractor expected an absolute package output path', [sourceRef, extractorRow.field_path, raw]);
      if (runtimeRootAbs === null) fail('transitive discovery requires the exact main worktree path to resolve absolute unit-spec outputs', [sourceRef, extractorRow.field_path]);
      if (value !== runtimeRootAbs && !value.startsWith(`${runtimeRootAbs}/`)) return null;
      const mainRoot = runtimeRootAbs.slice(0, runtimeRootAbs.length - runtimePrefix.length - 1);
      value = value.slice(mainRoot.length + 1);
    } else {
      if (value.startsWith('/')) return null; // non-authority absolute locator
      if (extractorRow.base === 'runtime') value = `${prefix}${value}`;
    }
    if (value.split('/').some((segment) => segment === '..' || segment === '.' || segment.length === 0)) fail('transitive authority ref contains an alias or empty segment', [sourceRef, extractorRow.field_path, raw]);
    return value;
  };
  const executeExtractor = (parsed: unknown, extractorRow: D65GraphRefExtractor, sourceRef: string): void => {
    for (const binding of extractRefBindings(parsed, extractorRow, sourceRef)) {
      const ref = normalizeRef(binding.raw, extractorRow, sourceRef);
      if (ref === null) continue;
      if (extractorRow.target_collection === 'core') {
        // The only core-target extractor is master-plan mission_ref; it must
        // resolve to the exact core mission blob (verified by core discovery).
        if (ref !== `${prefix}mission.md`) fail('core-target transitive ref does not resolve to the exact core mission blob', [sourceRef, extractorRow.field_path, ref]);
        continue;
      }
      if (extractorRow.shape === 'directory') {
        // Recursively include every mode-100644 file under the declared
        // evidence directory as opaque evidence; absence of the whole directory
        // is legal for a declared output.
        const directoryPrefix = `${ref}/`;
        for (const leaf of leaves.values()) {
          if (!leaf.ref.startsWith(directoryPrefix)) continue;
          includeOpaqueEvidence(leaf.ref, null, sourceRef, extractorRow.field_path);
        }
        continue;
      }
      const leaf = leaves.get(ref);
      if (leaf === undefined) {
        if (extractorRow.presence === 'required') fail('required transitive authority ref is absent at G', [sourceRef, extractorRow.field_path, ref]);
        continue; // declared-output not yet produced, or external signed evidence
      }
      const existing = assignments.get(ref);
      if (existing !== undefined) {
        // Already a fixed-root/external member: its collection must equal the
        // extractor target and any supplied digest/count must match its bytes.
        if (existing !== extractorRow.target_collection) fail('transitive authority ref receives two conflicting collection assignments', [sourceRef, ref, existing, extractorRow.target_collection]);
        if (binding.sha256 !== null || binding.byte_count !== null) {
          const bytes = input.readGitAtG.readBlob(ref);
          if (binding.sha256 !== null && bytesSha256(bytes) !== binding.sha256) fail('transitive authority digest binding does not match target bytes', [sourceRef, extractorRow.field_path, ref]);
          if (binding.byte_count !== null && bytes.byteLength !== binding.byte_count) fail('transitive authority byte-count binding does not match target bytes', [sourceRef, extractorRow.field_path, ref]);
        }
        continue;
      }
      if (extractorRow.target_collection !== 'evidence') fail('transitive authority ref targets a fixed collection but is outside its fixed root', [sourceRef, extractorRow.field_path, ref, extractorRow.target_collection]);
      includeOpaqueEvidence(ref, binding, sourceRef, extractorRow.field_path);
    }
  };
  if (input.coreSeeds !== undefined) {
    for (const extractorRow of D65_GRAPH_STATE_REF_EXTRACTORS) executeExtractor(input.coreSeeds.state, extractorRow, `${prefix}state.json`);
    for (const extractorRow of D65_GRAPH_MASTER_PLAN_REF_EXTRACTORS) executeExtractor(input.coreSeeds.master_plan, extractorRow, `${prefix}master-plan.json`);
  }
  for (const [ref, parsed] of parsedByRef) {
    if (parsed === null || !isJsonObject(parsed)) continue;
    const schemaVersion = parsed['schema_version'];
    if (typeof schemaVersion !== 'string') continue;
    const accepted = acceptedByRef.get(ref);
    const registration = ref.startsWith(prefix) ? registrationForRuntimeRef(ref.slice(prefix.length)) : null;
    const schemaRow = registration !== null
      ? registration.schemas.find((entry) => entry.schema_version === schemaVersion)
      : accepted !== undefined ? D65_GRAPH_EXTERNAL_AUTHORITY_SCHEMAS.find((entry) => entry.schema_version === schemaVersion) : undefined;
    if (schemaRow === undefined) fail('parsed authority source lost its registry schema during closure', [ref, schemaVersion]);
    for (const extractorRow of schemaRow.ref_extractors) executeExtractor(parsed, extractorRow, ref);
  }

  const policies = [...acceptedByRef.values()].filter((artifact) => artifact.document_schema_version === D65_LAUNCH_POLICY_SCHEMA).map((artifact) => ({ artifact, policy: parseD65LaunchPolicy(parsedByRef.get(artifact.evidence.ref)) }));
  const decisions = [...acceptedByRef.values()].filter((artifact) => artifact.document_schema_version === D65_CAPACITY_DECISION_SCHEMA);
  for (const decision of decisions) {
    const bindings = policies.filter(({ policy }) => policy.capacity_decision_ref === decision.evidence.ref && policy.capacity_decision_sha256 === decision.evidence.sha256);
    if (bindings.length !== 1) fail('accepted capacity decision is not bound by exactly one accepted launch policy', [decision.artifact_id, decision.evidence.ref, `bindings=${String(bindings.length)}`]);
  }
  for (const { artifact, policy } of policies) {
    if (policy.capacity_decision_ref === null) continue;
    const decision = decisions.filter((candidate) => candidate.evidence.ref === policy.capacity_decision_ref && candidate.evidence.sha256 === policy.capacity_decision_sha256);
    if (decision.length !== 1) fail('launch policy capacity decision ref/digest does not resolve to exactly one accepted artifact', [artifact.artifact_id, policy.capacity_decision_ref]);
  }

  for (const key of D65_COLLECTION_KEYS) {
    collections[key].sort((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0);
    for (let index = 1; index < collections[key].length; index += 1) if (collections[key][index - 1]?.identity === collections[key][index]?.identity) fail('discovery produced a duplicate authority identity', [key, collections[key][index]?.identity ?? '']);
    Object.freeze(collections[key]);
  }
  return Object.freeze({ collections: Object.freeze(collections), parsed_by_ref: parsedByRef, runtime_prefix: runtimePrefix });
}
