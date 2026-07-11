import {
  AUTOPILOT_COORDINATION_SNAPSHOT_SCHEMA,
  AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
  AUTOPILOT_COORDINATOR_REQUEST_SCHEMA,
  AUTOPILOT_COORDINATOR_RESPONSE_SCHEMA,
  COORDINATION_ACQUISITION_STATES,
  COORDINATION_CHILD_STATUSES,
  COORDINATION_CLAIM_MODES,
  COORDINATION_MESSAGE_STATUSES,
  COORDINATION_OPERATION_STAGES,
  COORDINATION_RELEASE_CONDITION_TYPES,
  COORDINATION_REQUEST_STATUSES,
  COORDINATION_RUN_STATUSES,
  COORDINATION_SESSION_STATUSES,
  COORDINATION_UNIT_STATES,
} from './types.ts';

export type CoordinationJsonSchema = Readonly<Record<string, unknown>>;

const boundedString = (maxLength = 512): CoordinationJsonSchema => ({ type: 'string', minLength: 1, maxLength });
const identifier = (): CoordinationJsonSchema => ({ type: 'string', minLength: 1, maxLength: 192, pattern: '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$' });
const integer = (minimum = 0): CoordinationJsonSchema => ({ type: 'integer', minimum });
const nullable = (schema: CoordinationJsonSchema): CoordinationJsonSchema => ({ oneOf: [schema, { type: 'null' }] });
const enumeration = (values: readonly string[]): CoordinationJsonSchema => ({ type: 'string', enum: [...values] });
const exactObject = (schemaVersion: string, properties: Readonly<Record<string, CoordinationJsonSchema>>, required: readonly string[] = Object.keys(properties)): CoordinationJsonSchema => ({
  $id: `urn:pi-autopilot:coordination:${schemaVersion}`,
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', ...required],
  properties: {
    schema_version: { const: schemaVersion },
    ...properties,
  },
});
const evidence = (): CoordinationJsonSchema => ({
  type: 'object', additionalProperties: false, required: ['ref', 'sha256'], properties: {
    ref: boundedString(1024), sha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
  },
});
const owner = (): CoordinationJsonSchema => ({
  type: 'object', additionalProperties: false, required: ['repo_id', 'autopilot_id', 'workstream_run', 'unit_id', 'attempt'], properties: {
    repo_id: identifier(), autopilot_id: identifier(), workstream_run: identifier(), unit_id: identifier(), attempt: integer(1),
  },
});
const condition = (): CoordinationJsonSchema => ({
  type: 'object', additionalProperties: false, required: ['condition_type', 'target_id', 'evidence'], properties: {
    condition_type: enumeration(COORDINATION_RELEASE_CONDITION_TYPES), target_id: identifier(), evidence: nullable(evidence()),
  },
});
const requestedLease = (): CoordinationJsonSchema => ({
  type: 'object', additionalProperties: false, required: ['path', 'mode', 'purpose'], properties: {
    path: boundedString(512), mode: enumeration(COORDINATION_CLAIM_MODES), purpose: boundedString(512),
  },
});
const table = (items: CoordinationJsonSchema, maxItems = 10_000): CoordinationJsonSchema => ({ type: 'array', maxItems, items });

export const COORDINATION_REPOSITORY_SCHEMA = exactObject('autopilot.coordination_repository.v1', {
  repo_id: identifier(), repo_key: identifier(), canonical_root: boundedString(1024), git_common_dir: boundedString(1024), created_event_seq: integer(), version: integer(1),
});
export const COORDINATION_RUN_SCHEMA = exactObject('autopilot.coordination_run.v1', {
  repo_id: identifier(), autopilot_id: identifier(), workstream: identifier(), workstream_run: identifier(), status: enumeration(COORDINATION_RUN_STATUSES), active_session_generation: integer(), created_event_seq: integer(), version: integer(1),
});
export const COORDINATION_SESSION_LEASE_SCHEMA = exactObject('autopilot.session_lease.v1', {
  session_lease_id: identifier(), repo_id: identifier(), workstream_run: identifier(), session_id: identifier(), session_generation: integer(1), pid: integer(1), boot_id: identifier(), lease_expires_at: boundedString(32), status: enumeration(COORDINATION_SESSION_STATUSES), attached_event_seq: integer(), version: integer(1),
});
export const COORDINATION_CHILD_LEASE_SCHEMA = exactObject('autopilot.child_lease.v1', {
  child_lease_id: identifier(), owner: owner(), pid: integer(1), boot_id: identifier(), lease_expires_at: boundedString(32), status: enumeration(COORDINATION_CHILD_STATUSES), terminal_evidence: nullable(evidence()), version: integer(1),
});
export const COORDINATION_UNIT_ATTEMPT_SCHEMA = exactObject('autopilot.unit_attempt.v1', {
  owner: owner(), state: enumeration(COORDINATION_UNIT_STATES), spec: evidence(), preemptible: { type: 'boolean' }, checkpoint_ordinal: integer(), critical_section: nullable(boundedString(128)), version: integer(1),
});
export const COORDINATION_ACQUISITION_GROUP_SCHEMA = exactObject('autopilot.acquisition_group.v2', {
  acquisition_group_id: identifier(), owner: owner(), requested_leases: { type: 'array', minItems: 1, maxItems: 1024, uniqueItems: true, items: requestedLease() }, reason: boundedString(1024), normal_release_condition: condition(), state: enumeration(COORDINATION_ACQUISITION_STATES), created_event_seq: integer(), fairness_event_seq: integer(), grant_event_seq: nullable(integer()), offer_expires_at: nullable(boundedString(32)), offer_count: integer(), bypass_count: integer(), version: integer(1),
});
export const COORDINATION_EDIT_LEASE_SCHEMA = exactObject('autopilot.edit_lease.v1', {
  edit_lease_id: identifier(), owner: owner(), acquisition_group_id: identifier(), path: boundedString(512), mode: enumeration(COORDINATION_CLAIM_MODES), purpose: boundedString(512), acquired_event_seq: integer(), normal_release_condition: condition(), version: integer(1),
});
export const COORDINATION_CHANGE_RESERVATION_SCHEMA = exactObject('autopilot.change_reservation.v1', {
  reservation_id: identifier(), repo_id: identifier(), autopilot_id: identifier(), workstream_run: identifier(), path: boundedString(512), merge_evidence: evidence(), created_event_seq: integer(), released_event_seq: nullable(integer()), version: integer(1),
});
export const COORDINATION_CLAIM_REQUEST_SCHEMA = exactObject('autopilot.claim_request.v1', {
  request_id: identifier(), acquisition_group_id: identifier(), requester: owner(), owner: owner(), blocking_lease_ids: { type: 'array', minItems: 1, maxItems: 1024, uniqueItems: true, items: identifier() }, requested_leases: { type: 'array', minItems: 1, maxItems: 1024, uniqueItems: true, items: requestedLease() }, reason: boundedString(1024), created_event_seq: integer(), status: enumeration(COORDINATION_REQUEST_STATUSES), owner_reason: nullable(boundedString(1024)), release_condition: nullable(condition()), release_event_seq: nullable(integer()), grant_event_seq: nullable(integer()), version: integer(1),
});
export const COORDINATION_MESSAGE_SCHEMA = exactObject('autopilot.coordination_message.v1', {
  message_id: identifier(), repo_id: identifier(), recipient_workstream_run: identifier(), message_type: enumeration(['claim-request', 'release-notification', 'grant-offer', 'recovery-required']), correlation_id: identifier(), payload: { type: 'object', maxProperties: 256 }, status: enumeration(COORDINATION_MESSAGE_STATUSES), created_event_seq: integer(), delivered_event_seq: nullable(integer()), acknowledged_event_seq: nullable(integer()), version: integer(1),
});
export const COORDINATION_WORKTREE_SCHEMA = exactObject('autopilot.coordination_worktree.v1', {
  worktree_id: identifier(), owner: owner(), canonical_path: boundedString(1024), git_common_dir: boundedString(1024), branch: boundedString(512), state: enumeration(['planned', 'active', 'dirty', 'quarantined', 'terminal', 'removed']), version: integer(1),
});
export const COORDINATION_WORKTREE_OPERATION_SCHEMA = exactObject('autopilot.worktree_operation.v1', {
  operation_id: identifier(), worktree_id: identifier(), owner: owner(), operation_type: enumeration(['create', 'materialize', 'commit', 'merge', 'reset', 'quarantine', 'archive', 'remove']), stage: enumeration(COORDINATION_OPERATION_STAGES), authority_version: integer(1), intent_event_seq: integer(), verification_evidence: nullable(evidence()), error_code: nullable(boundedString(128)), version: integer(1),
});
export const COORDINATION_ESCALATION_SCHEMA = exactObject('autopilot.planning_contradiction.v1', {
  escalation_id: identifier(), repo_id: identifier(), participating_runs: { type: 'array', minItems: 2, maxItems: 32, uniqueItems: true, items: identifier() }, authoritative_refs: { type: 'array', minItems: 2, maxItems: 32, items: evidence() }, conflicting_clauses: { type: 'array', minItems: 2, maxItems: 32, uniqueItems: true, items: boundedString(1024) }, exhausted_alternatives: { type: 'array', minItems: 5, maxItems: 5, uniqueItems: true, items: enumeration(['sequencing', 'partitioning', 'ownership-transfer', 'rebase-revalidation', 'replanning']) }, adjudication: evidence(), decision_options: { type: 'array', minItems: 2, maxItems: 16, uniqueItems: true, items: boundedString(1024) }, created_event_seq: integer(), version: integer(1),
});
export const COORDINATION_EVENT_SCHEMA = exactObject('autopilot.coordination_event.v1', {
  repo_id: identifier(), event_seq: integer(1), event_type: identifier(), entity_type: identifier(), entity_id: identifier(), idempotency_key: identifier(), request_sha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, occurred_at: boundedString(32),
});

export const COORDINATION_SNAPSHOT_SCHEMA = exactObject(AUTOPILOT_COORDINATION_SNAPSHOT_SCHEMA, {
  repository_event_seq: integer(), repositories: table(COORDINATION_REPOSITORY_SCHEMA), runs: table(COORDINATION_RUN_SCHEMA), session_leases: table(COORDINATION_SESSION_LEASE_SCHEMA), child_leases: table(COORDINATION_CHILD_LEASE_SCHEMA), unit_attempts: table(COORDINATION_UNIT_ATTEMPT_SCHEMA), acquisition_groups: table(COORDINATION_ACQUISITION_GROUP_SCHEMA), edit_leases: table(COORDINATION_EDIT_LEASE_SCHEMA), change_reservations: table(COORDINATION_CHANGE_RESERVATION_SCHEMA), claim_requests: table(COORDINATION_CLAIM_REQUEST_SCHEMA), messages: table(COORDINATION_MESSAGE_SCHEMA, 100_000), worktrees: table(COORDINATION_WORKTREE_SCHEMA), worktree_operations: table(COORDINATION_WORKTREE_OPERATION_SCHEMA), escalations: table(COORDINATION_ESCALATION_SCHEMA), events: table(COORDINATION_EVENT_SCHEMA, 100_000),
});

export const COORDINATOR_REQUEST_SCHEMA: CoordinationJsonSchema = {
  $id: 'urn:pi-autopilot:coordination:coordinator-request-v1', type: 'object', additionalProperties: false,
  required: ['schema_version', 'protocol_version', 'request_id', 'action', 'idempotency_key', 'repo_id', 'workstream_run', 'session_id', 'fencing_generation', 'expected_version', 'payload'],
  properties: {
    schema_version: { const: AUTOPILOT_COORDINATOR_REQUEST_SCHEMA }, protocol_version: { const: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION }, request_id: identifier(), action: enumeration(['status', 'doctor', 'export', 'attach-run', 'attach-session', 'detach-session', 'prepare-handoff', 'heartbeat', 'register-child', 'heartbeat-child', 'complete-child', 'drain-mailbox', 'acquire-group', 'acknowledge-grant', 'respond-claim-request', 'cancel-claim-request', 'cancel-acquisition-group', 'supersede-attempt', 'acknowledge-message', 'transition-operation']), idempotency_key: nullable(identifier()), repo_id: identifier(), workstream_run: nullable(identifier()), session_id: nullable(identifier()), fencing_generation: nullable(integer()), expected_version: nullable(integer()), payload: { type: 'object' },
  },
};
export const COORDINATOR_RESPONSE_SCHEMA: CoordinationJsonSchema = {
  $id: 'urn:pi-autopilot:coordination:coordinator-response-v1', type: 'object', additionalProperties: false,
  required: ['schema_version', 'protocol_version', 'request_id', 'ok', 'committed_event_seq', 'error_code', 'retryable', 'payload'],
  properties: {
    schema_version: { const: AUTOPILOT_COORDINATOR_RESPONSE_SCHEMA }, protocol_version: { const: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION }, request_id: identifier(), ok: { type: 'boolean' }, committed_event_seq: nullable(integer()), error_code: nullable(boundedString(128)), retryable: { type: 'boolean' }, payload: { type: 'object' },
  },
};

export const AUTOPILOT_COORDINATION_JSON_SCHEMAS = Object.freeze({
  repository: COORDINATION_REPOSITORY_SCHEMA,
  run: COORDINATION_RUN_SCHEMA,
  session_lease: COORDINATION_SESSION_LEASE_SCHEMA,
  child_lease: COORDINATION_CHILD_LEASE_SCHEMA,
  unit_attempt: COORDINATION_UNIT_ATTEMPT_SCHEMA,
  acquisition_group: COORDINATION_ACQUISITION_GROUP_SCHEMA,
  edit_lease: COORDINATION_EDIT_LEASE_SCHEMA,
  change_reservation: COORDINATION_CHANGE_RESERVATION_SCHEMA,
  claim_request: COORDINATION_CLAIM_REQUEST_SCHEMA,
  message: COORDINATION_MESSAGE_SCHEMA,
  worktree: COORDINATION_WORKTREE_SCHEMA,
  worktree_operation: COORDINATION_WORKTREE_OPERATION_SCHEMA,
  escalation: COORDINATION_ESCALATION_SCHEMA,
  event: COORDINATION_EVENT_SCHEMA,
  snapshot: COORDINATION_SNAPSHOT_SCHEMA,
  coordinator_request: COORDINATOR_REQUEST_SCHEMA,
  coordinator_response: COORDINATOR_RESPONSE_SCHEMA,
});
