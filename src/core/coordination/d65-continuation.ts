import {
  array,
  boolean,
  fail,
  identifier,
  integer,
  literal,
  nullableInteger,
  nullableSha256Field,
  nullableStr,
  object,
  oneOf,
  repoRelativePath,
  sha256Field,
  str,
  timestamp,
  parseD65EvidenceRefWithCount,
  parseD65NullableEvidenceRefWithCount,
  type D65EvidenceRefWithCount,
} from './d65-semantic-graph.ts';

// D65-A3 graph/failure-hook evidence documents (fresh plan §3.1). These are
// immutable task evidence included by the next complete graph, not a fifth
// package consumer. They register through the existing register-authoritative-
// artifact action as source_type=task/source_scope=run-main.

// ---- autopilot.continuation_event.v1 ----------------------------------------

export const D65_CONTINUATION_EVENT_SCHEMA = 'autopilot.continuation_event.v1' as const;

export const D65_CONTINUATION_TRIGGERS = [
  'subscription-failure', 'child-transport-loss', 'terminal-carrier-missing', 'terminal-carrier-invalid',
  'parent-loss', 'planned-turnover', 'coordinator-transport', 'coordinator-integrity', 'external-adc', 'other',
] as const;
export type D65ContinuationTrigger = (typeof D65_CONTINUATION_TRIGGERS)[number];

export const D65_CONTINUATION_CLASSES = [
  'provider-capacity-blocked', 'child-transport-failed', 'terminal-carrier-missing', 'terminal-carrier-invalid',
  'parent-recovering', 'parent-recovery-exhausted', 'handoff-pending', 'coordinator-blocked', 'coordinator-terminal',
  'external-credential-blocked', 'unit-retry-exhausted', 'continuation-unclassified',
] as const;
export type D65ContinuationClass = (typeof D65_CONTINUATION_CLASSES)[number];

export interface D65ContinuationEvent {
  readonly schema_version: typeof D65_CONTINUATION_EVENT_SCHEMA;
  readonly program_id: string;
  readonly event_id: string;
  readonly event_sequence: number;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly trigger: D65ContinuationTrigger;
  readonly class: D65ContinuationClass;
  readonly provider: string | null;
  readonly failed_spec_ref: D65EvidenceRefWithCount | null;
  readonly failed_receipt_ref: D65EvidenceRefWithCount | null;
  readonly unit_id: string | null;
  readonly attempt: number | null;
  readonly session_lease_id: string | null;
  readonly child_lease_id: string | null;
  readonly observed_at: string;
  readonly cooldown_until: string | null;
  readonly retry_ordinal: number | null;
  readonly successor_id: string | null;
  readonly evidence_refs: readonly D65EvidenceRefWithCount[];
  readonly prior_graph_sha256: `sha256:${string}` | null;
  readonly result_graph_sequence: number | null;
  readonly operator_decision_ref: null;
}

export function parseD65ContinuationEvent(value: unknown): D65ContinuationEvent {
  const label = D65_CONTINUATION_EVENT_SCHEMA;
  const record = object(value, label, [
    'schema_version', 'program_id', 'event_id', 'event_sequence', 'repo_id', 'workstream_run', 'trigger', 'class',
    'provider', 'failed_spec_ref', 'failed_receipt_ref', 'unit_id', 'attempt', 'session_lease_id', 'child_lease_id',
    'observed_at', 'cooldown_until', 'retry_ordinal', 'successor_id', 'evidence_refs', 'prior_graph_sha256',
    'result_graph_sequence', 'operator_decision_ref',
  ]);
  literal(record, 'schema_version', D65_CONTINUATION_EVENT_SCHEMA, label);
  const trigger = oneOf(record, 'trigger', D65_CONTINUATION_TRIGGERS, label);
  const klass = oneOf(record, 'class', D65_CONTINUATION_CLASSES, label);
  // `other` maps only to `continuation-unclassified`.
  if (trigger === 'other' && klass !== 'continuation-unclassified') fail(label, 'trigger `other` maps only to class `continuation-unclassified`');
  const provider = nullableStr(record, 'provider', label, 128);
  const failedSpec = parseD65NullableEvidenceRefWithCount(record['failed_spec_ref'], `${label}.failed_spec_ref`);
  const failedReceipt = parseD65NullableEvidenceRefWithCount(record['failed_receipt_ref'], `${label}.failed_receipt_ref`);
  const isSubscription = trigger === 'subscription-failure';
  // provider/failed_spec/failed_receipt are non-null only for subscription failure/exhaustion.
  if (!isSubscription && (provider !== null || failedSpec !== null || failedReceipt !== null)) fail(label, 'provider/failed_spec_ref/failed_receipt_ref are only present for subscription failures');
  if (isSubscription && (provider === null || failedSpec === null || failedReceipt === null)) fail(label, 'a subscription failure requires provider and failed spec/receipt refs');
  const unitId = nullableStr(record, 'unit_id', label, 192);
  const attempt = nullableInteger(record, 'attempt', label, 1);
  const childLeaseId = nullableStr(record, 'child_lease_id', label, 192);
  // Unit/attempt/child fields are non-null only for unit failures.
  const unitFailure = trigger === 'subscription-failure' || trigger === 'child-transport-loss' || trigger === 'terminal-carrier-missing' || trigger === 'terminal-carrier-invalid';
  if (!unitFailure && (unitId !== null || attempt !== null || childLeaseId !== null)) fail(label, 'unit/attempt/child fields are only present for unit failures');
  const evidenceRefs = array(record['evidence_refs'], `${label}.evidence_refs`, 64).map((entry, index) => parseD65EvidenceRefWithCount(entry, `${label}.evidence_refs[${String(index)}]`));
  if (record['operator_decision_ref'] !== null) fail(label, 'operator_decision_ref must be null under D65');
  return {
    schema_version: D65_CONTINUATION_EVENT_SCHEMA,
    program_id: identifier(record, 'program_id', label),
    event_id: identifier(record, 'event_id', label),
    event_sequence: integer(record, 'event_sequence', label, 1),
    repo_id: identifier(record, 'repo_id', label),
    workstream_run: identifier(record, 'workstream_run', label),
    trigger,
    class: klass,
    provider,
    failed_spec_ref: failedSpec,
    failed_receipt_ref: failedReceipt,
    unit_id: unitId,
    attempt,
    session_lease_id: nullableStr(record, 'session_lease_id', label, 192),
    child_lease_id: childLeaseId,
    observed_at: timestamp(record, 'observed_at', label),
    cooldown_until: record['cooldown_until'] === null ? null : timestamp(record, 'cooldown_until', label),
    retry_ordinal: nullableInteger(record, 'retry_ordinal', label, 1),
    successor_id: nullableStr(record, 'successor_id', label, 192),
    evidence_refs: Object.freeze(evidenceRefs),
    prior_graph_sha256: nullableSha256Field(record, 'prior_graph_sha256', label),
    result_graph_sequence: nullableInteger(record, 'result_graph_sequence', label, 1),
    operator_decision_ref: null,
  };
}

// ---- autopilot.parent_loss.v1 -----------------------------------------------

export const D65_PARENT_LOSS_SCHEMA = 'autopilot.parent_loss.v1' as const;

/** A closed physical/coordinator identity object with bounded fields + nulls. */
export interface D65IdentityObject {
  readonly [key: string]: unknown;
}

function boundedIdentityObject(value: unknown, label: string): D65IdentityObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(label, 'must be a closed identity object');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.length > 32) fail(label, 'identity object field count is out of range');
  for (const key of keys) {
    const entry = record[key];
    if (entry === null) continue;
    if (typeof entry === 'string') { if (entry.length > 4096) fail(label, `identity field ${key} is too long`); continue; }
    if (typeof entry === 'number') { if (!Number.isSafeInteger(entry)) fail(label, `identity field ${key} must be a safe integer`); continue; }
    fail(label, `identity field ${key} must be a bounded string, safe integer, or null`);
  }
  return record;
}

export interface D65ParentLoss {
  readonly schema_version: typeof D65_PARENT_LOSS_SCHEMA;
  readonly program_id: string;
  readonly event_id: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly lost_physical_session_file_identity: D65IdentityObject;
  readonly lost_coordinator_session_identity: D65IdentityObject;
  readonly successor_physical_session_file_identity: D65IdentityObject;
  readonly successor_session_id: string;
  readonly successor_session_lease_id: string;
  readonly successor_generation: number;
  readonly successor_pid: number;
  readonly successor_boot_id: string;
  readonly last_graph: D65EvidenceRefWithCount;
  readonly last_policy: D65EvidenceRefWithCount;
  readonly last_heartbeat: D65EvidenceRefWithCount;
  readonly status_ref: D65EvidenceRefWithCount;
  readonly doctor_ref: D65EvidenceRefWithCount;
  readonly observed_at: string;
  readonly successor_budget: 1;
  readonly operator_decision_ref: null;
  readonly issued_at: string;
  readonly trust_anchor_ref: string;
  readonly trust_anchor_sha256: `sha256:${string}`;
  readonly signer_key_id: `sha256:${string}`;
  readonly signature: string;
}

export function parseD65ParentLoss(value: unknown): D65ParentLoss {
  const label = D65_PARENT_LOSS_SCHEMA;
  const record = object(value, label, [
    'schema_version', 'program_id', 'event_id', 'repo_id', 'workstream_run', 'lost_physical_session_file_identity',
    'lost_coordinator_session_identity', 'successor_physical_session_file_identity', 'successor_session_id',
    'successor_session_lease_id', 'successor_generation', 'successor_pid', 'successor_boot_id', 'last_graph',
    'last_policy', 'last_heartbeat', 'status_ref', 'doctor_ref', 'observed_at', 'successor_budget',
    'operator_decision_ref', 'issued_at', 'trust_anchor_ref', 'trust_anchor_sha256', 'signer_key_id', 'signature',
  ]);
  literal(record, 'schema_version', D65_PARENT_LOSS_SCHEMA, label);
  if (record['successor_budget'] !== 1) fail(label, 'successor_budget must be exactly 1');
  if (record['operator_decision_ref'] !== null) fail(label, 'operator_decision_ref must be null under D65');
  const signature = str(record, 'signature', label, 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(signature)) fail(label, 'signature must be unpadded base64url');
  return {
    schema_version: D65_PARENT_LOSS_SCHEMA,
    program_id: identifier(record, 'program_id', label),
    event_id: identifier(record, 'event_id', label),
    repo_id: identifier(record, 'repo_id', label),
    workstream_run: identifier(record, 'workstream_run', label),
    lost_physical_session_file_identity: boundedIdentityObject(record['lost_physical_session_file_identity'], `${label}.lost_physical_session_file_identity`),
    lost_coordinator_session_identity: boundedIdentityObject(record['lost_coordinator_session_identity'], `${label}.lost_coordinator_session_identity`),
    successor_physical_session_file_identity: boundedIdentityObject(record['successor_physical_session_file_identity'], `${label}.successor_physical_session_file_identity`),
    successor_session_id: identifier(record, 'successor_session_id', label),
    successor_session_lease_id: identifier(record, 'successor_session_lease_id', label),
    successor_generation: integer(record, 'successor_generation', label, 1),
    successor_pid: integer(record, 'successor_pid', label, 1),
    successor_boot_id: identifier(record, 'successor_boot_id', label),
    last_graph: parseD65EvidenceRefWithCount(record['last_graph'], `${label}.last_graph`),
    last_policy: parseD65EvidenceRefWithCount(record['last_policy'], `${label}.last_policy`),
    last_heartbeat: parseD65EvidenceRefWithCount(record['last_heartbeat'], `${label}.last_heartbeat`),
    status_ref: parseD65EvidenceRefWithCount(record['status_ref'], `${label}.status_ref`),
    doctor_ref: parseD65EvidenceRefWithCount(record['doctor_ref'], `${label}.doctor_ref`),
    observed_at: timestamp(record, 'observed_at', label),
    successor_budget: 1,
    operator_decision_ref: null,
    issued_at: timestamp(record, 'issued_at', label),
    trust_anchor_ref: repoRelativePath(record, 'trust_anchor_ref', label),
    trust_anchor_sha256: sha256Field(record, 'trust_anchor_sha256', label),
    signer_key_id: sha256Field(record, 'signer_key_id', label),
    signature,
  };
}

// Re-export a primitive so the store consumer can import from one module.
export { boolean };
