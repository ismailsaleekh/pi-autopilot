import { isAbsolute, normalize } from 'node:path';

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
  type CoordinationAcquisitionGroup,
  type CoordinationChangeReservation,
  type CoordinationChildLease,
  type CoordinationClaimMode,
  type CoordinationClaimRequest,
  type CoordinationEditLease,
  type CoordinationEscalation,
  type CoordinationEvent,
  type CoordinationEvidenceRef,
  type CoordinationMessage,
  type CoordinationOwnerIdentity,
  type CoordinationReleaseCondition,
  type CoordinationRepository,
  type CoordinationRequestedLease,
  type CoordinationRun,
  type CoordinationSessionLease,
  type CoordinationSnapshot,
  type CoordinationUnitAttempt,
  type CoordinationWorktree,
  type CoordinationWorktreeOperation,
  type CoordinatorMutationAction,
  type CoordinatorQueryAction,
  type CoordinatorRequestEnvelope,
  type CoordinatorResponseEnvelope,
} from './types.ts';

export class CoordinationContractError extends Error {
  override readonly name = 'CoordinationContractError';
  readonly code = 'invalid-coordination-contract';
  readonly issues: readonly string[];

  constructor(label: string, issues: readonly string[]) {
    super(`${label} failed coordination contract validation: ${issues.join('; ')}`);
    this.issues = Object.freeze([...issues]);
  }
}

type JsonObject = Readonly<Record<string, unknown>>;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const CHILD_TOKEN = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/u;
const QUERY_ACTIONS = ['status', 'doctor', 'export'] as const;
const MUTATION_ACTIONS = ['attach-run', 'attach-session', 'detach-session', 'prepare-handoff', 'heartbeat', 'register-child', 'heartbeat-child', 'complete-child', 'drain-mailbox', 'acquire-group', 'acknowledge-grant', 'respond-claim-request', 'cancel-claim-request', 'acknowledge-message', 'transition-operation'] as const;
const MESSAGE_TYPES = ['claim-request', 'release-notification', 'grant-offer', 'recovery-required'] as const;
const WORKTREE_STATES = ['planned', 'active', 'dirty', 'quarantined', 'terminal', 'removed'] as const;
const OPERATION_TYPES = ['create', 'materialize', 'commit', 'merge', 'reset', 'quarantine', 'archive', 'remove'] as const;
const EXHAUSTED_ALTERNATIVES = ['sequencing', 'partitioning', 'ownership-transfer', 'rebase-revalidation', 'replanning'] as const;
const PAYLOAD_FIELDS: Readonly<Record<CoordinatorQueryAction | CoordinatorMutationAction, readonly string[]>> = {
  status: [],
  doctor: [],
  export: ['output_path'],
  'attach-run': ['autopilot_id', 'canonical_root', 'git_common_dir', 'repo_key', 'workstream'],
  'attach-session': ['boot_id', 'handoff_token', 'lease_expires_at', 'pid', 'session_lease_id', 'session_token'],
  'detach-session': ['reason', 'session_lease_id', 'session_token'],
  'prepare-handoff': ['handoff_token', 'session_lease_id', 'session_token'],
  heartbeat: ['lease_expires_at', 'session_lease_id', 'session_token'],
  'register-child': ['attempt', 'autopilot_id', 'boot_id', 'child_lease_id', 'child_token', 'lease_expires_at', 'pid', 'session_lease_id', 'session_token', 'unit_id'],
  'heartbeat-child': ['boot_id', 'child_lease_id', 'child_token', 'lease_expires_at', 'pid'],
  'complete-child': ['boot_id', 'child_lease_id', 'child_token', 'evidence_ref', 'evidence_sha256', 'pid', 'status'],
  'drain-mailbox': ['delivery_id', 'session_lease_id', 'session_token'],
  'acquire-group': ['acquisition_group_id'],
  'acknowledge-grant': ['acquisition_group_id'],
  'respond-claim-request': ['request_id', 'response'],
  'cancel-claim-request': ['request_id'],
  'acknowledge-message': ['message_id', 'session_lease_id', 'session_token'],
  'transition-operation': ['operation_id', 'stage'],
};

function fail(label: string, issue: string): never {
  throw new CoordinationContractError(label, [issue]);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, label: string, fields: readonly string[]): JsonObject {
  if (!isJsonObject(value)) fail(label, 'must be an object');
  const record = value;
  const unknownFields = Object.keys(record).filter((key) => !fields.includes(key));
  if (unknownFields.length > 0) fail(label, `contains unknown fields: ${unknownFields.sort().join(', ')}`);
  for (const field of fields) {
    if (!(field in record)) fail(label, `missing required field ${field}`);
  }
  return record;
}

function string(record: JsonObject, field: string, label: string, maxLength = 512): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) fail(label, `${field} must be a non-empty string of at most ${String(maxLength)} characters`);
  return value;
}

function nullableString(record: JsonObject, field: string, label: string, maxLength = 512): string | null {
  const value = record[field];
  if (value === null) return null;
  return string(record, field, label, maxLength);
}

function identifier(record: JsonObject, field: string, label: string): string {
  const value = string(record, field, label, 192);
  if (!IDENTIFIER.test(value)) fail(label, `${field} is not a valid bounded identifier`);
  return value;
}

function integer(record: JsonObject, field: string, label: string, minimum = 0): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail(label, `${field} must be a safe integer >= ${String(minimum)}`);
  return value;
}

function nullableInteger(record: JsonObject, field: string, label: string): number | null {
  if (record[field] === null) return null;
  return integer(record, field, label);
}

function boolean(record: JsonObject, field: string, label: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') fail(label, `${field} must be boolean`);
  return value;
}

function literal<T extends string>(record: JsonObject, field: string, expected: T, label: string): T {
  if (record[field] !== expected) fail(label, `${field} must equal ${expected}`);
  return expected;
}

function oneOf<T extends readonly string[]>(record: JsonObject, field: string, values: T, label: string): T[number] {
  const value = record[field];
  if (typeof value !== 'string' || !values.includes(value)) fail(label, `${field} must be one of ${values.join(', ')}`);
  return value as T[number];
}

function timestamp(record: JsonObject, field: string, label: string): string {
  const value = string(record, field, label, 32);
  if (!ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) fail(label, `${field} must be an ISO UTC timestamp`);
  return value;
}

function absolutePath(record: JsonObject, field: string, label: string): string {
  const value = string(record, field, label, 1024);
  if (!isAbsolute(value) || value.includes('\u0000') || normalize(value) !== value) fail(label, `${field} must be a normalized absolute path`);
  return value;
}

function repoPath(record: JsonObject, field: string, label: string): string {
  const value = string(record, field, label, 512);
  const segments = value.split('/');
  if (value.startsWith('/') || value.startsWith('./') || value.endsWith('/') || value.includes('//') || /^[A-Za-z]:/u.test(value) || value.includes('\\') || value.includes('\u0000') || /^\s/u.test(value) || segments.includes('.') || segments.includes('..')) fail(label, `${field} must be a normalized repository-relative path`);
  return value;
}

function array(value: unknown, label: string, maxItems = 10_000): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maxItems) fail(label, `must be an array with at most ${String(maxItems)} entries`);
  return value;
}

function boundedJsonValue(value: unknown, label: string, depth: number): unknown {
  if (depth > 8) fail(label, 'exceeds maximum JSON nesting depth');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 4096) fail(label, 'contains a string longer than 4096 characters');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(label, 'contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) fail(label, 'contains an array longer than 256 entries');
    return Object.freeze(value.map((entry, index) => boundedJsonValue(entry, `${label}[${String(index)}]`, depth + 1)));
  }
  if (!isJsonObject(value)) fail(label, 'contains a non-JSON value');
  const entries = Object.entries(value);
  if (entries.length > 256) fail(label, 'contains an object with more than 256 fields');
  const out: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > 128) fail(label, 'contains an invalid field name');
    out[key] = boundedJsonValue(entry, `${label}.${key}`, depth + 1);
  }
  return Object.freeze(out);
}

function boundedJsonObject(value: unknown, label: string): JsonObject {
  const parsed = boundedJsonValue(value, label, 0);
  if (!isJsonObject(parsed)) fail(label, 'must be a JSON object');
  return parsed;
}

function uniqueStrings(value: unknown, label: string, minItems = 0, maxItems = 1024): readonly string[] {
  const values = array(value, label, maxItems).map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 1024) fail(label, `entry ${String(index)} must be a bounded non-empty string`);
    return entry;
  });
  if (values.length < minItems) fail(label, `must contain at least ${String(minItems)} entries`);
  if (new Set(values).size !== values.length) fail(label, 'must not contain duplicate entries');
  return Object.freeze(values);
}

function parseEvidence(value: unknown, label: string): CoordinationEvidenceRef {
  const record = object(value, label, ['ref', 'sha256']);
  const digest = string(record, 'sha256', label, 71);
  if (!SHA256.test(digest)) fail(label, 'sha256 must use sha256:<64 lowercase hex>');
  return { ref: repoPath(record, 'ref', label), sha256: digest as `sha256:${string}` };
}

function parseNullableEvidence(value: unknown, label: string): CoordinationEvidenceRef | null {
  return value === null ? null : parseEvidence(value, label);
}

export function parseCoordinationOwnerIdentity(value: unknown, label = 'CoordinationOwnerIdentity'): CoordinationOwnerIdentity {
  const record = object(value, label, ['attempt', 'autopilot_id', 'repo_id', 'unit_id', 'workstream_run']);
  return {
    repo_id: identifier(record, 'repo_id', label),
    autopilot_id: identifier(record, 'autopilot_id', label),
    workstream_run: identifier(record, 'workstream_run', label),
    unit_id: identifier(record, 'unit_id', label),
    attempt: integer(record, 'attempt', label, 1),
  };
}

export function parseCoordinationReleaseCondition(value: unknown, label = 'CoordinationReleaseCondition'): CoordinationReleaseCondition {
  const record = object(value, label, ['condition_type', 'evidence', 'target_id']);
  return {
    condition_type: oneOf(record, 'condition_type', COORDINATION_RELEASE_CONDITION_TYPES, label),
    target_id: identifier(record, 'target_id', label),
    evidence: parseNullableEvidence(record['evidence'], `${label}.evidence`),
  };
}

function parseRequestedLease(value: unknown, label: string): CoordinationRequestedLease {
  const record = object(value, label, ['mode', 'path', 'purpose']);
  return {
    path: repoPath(record, 'path', label),
    mode: oneOf(record, 'mode', COORDINATION_CLAIM_MODES, label),
    purpose: string(record, 'purpose', label, 512),
  };
}

function assertRequestedLeaseSet(leases: readonly CoordinationRequestedLease[], label: string): void {
  const identities = leases.map((lease) => `${lease.mode}\0${lease.path}`);
  if (new Set(identities).size !== identities.length) fail(label, 'requested_leases must not contain duplicate mode/path entries');
  for (let leftIndex = 0; leftIndex < leases.length; leftIndex += 1) {
    const left = leases[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < leases.length; rightIndex += 1) {
      const right = leases[rightIndex];
      if (right !== undefined && coordinationPathsOverlap(left.path, right.path) && claimModesConflict(left.mode, right.mode)) fail(label, `requested_leases contain internally incompatible authority: ${left.mode} ${left.path} and ${right.mode} ${right.path}`);
    }
  }
}

export function parseCoordinationRepository(value: unknown): CoordinationRepository {
  const label = 'CoordinationRepository';
  const record = object(value, label, ['canonical_root', 'created_event_seq', 'git_common_dir', 'repo_id', 'repo_key', 'schema_version', 'version']);
  return {
    schema_version: literal(record, 'schema_version', 'autopilot.coordination_repository.v1', label),
    repo_id: identifier(record, 'repo_id', label),
    repo_key: identifier(record, 'repo_key', label),
    canonical_root: absolutePath(record, 'canonical_root', label),
    git_common_dir: absolutePath(record, 'git_common_dir', label),
    created_event_seq: integer(record, 'created_event_seq', label),
    version: integer(record, 'version', label, 1),
  };
}

export function parseCoordinationRun(value: unknown): CoordinationRun {
  const label = 'CoordinationRun';
  const record = object(value, label, ['active_session_generation', 'autopilot_id', 'created_event_seq', 'repo_id', 'schema_version', 'status', 'version', 'workstream', 'workstream_run']);
  return {
    schema_version: literal(record, 'schema_version', 'autopilot.coordination_run.v1', label),
    repo_id: identifier(record, 'repo_id', label),
    autopilot_id: identifier(record, 'autopilot_id', label),
    workstream: identifier(record, 'workstream', label),
    workstream_run: identifier(record, 'workstream_run', label),
    status: oneOf(record, 'status', COORDINATION_RUN_STATUSES, label),
    active_session_generation: integer(record, 'active_session_generation', label),
    created_event_seq: integer(record, 'created_event_seq', label),
    version: integer(record, 'version', label, 1),
  };
}

export function parseCoordinationSessionLease(value: unknown): CoordinationSessionLease {
  const label = 'CoordinationSessionLease';
  const record = object(value, label, ['attached_event_seq', 'boot_id', 'lease_expires_at', 'pid', 'repo_id', 'schema_version', 'session_generation', 'session_id', 'session_lease_id', 'status', 'version', 'workstream_run']);
  return {
    schema_version: literal(record, 'schema_version', 'autopilot.session_lease.v1', label),
    session_lease_id: identifier(record, 'session_lease_id', label),
    repo_id: identifier(record, 'repo_id', label),
    workstream_run: identifier(record, 'workstream_run', label),
    session_id: identifier(record, 'session_id', label),
    session_generation: integer(record, 'session_generation', label, 1),
    pid: integer(record, 'pid', label, 1),
    boot_id: identifier(record, 'boot_id', label),
    lease_expires_at: timestamp(record, 'lease_expires_at', label),
    status: oneOf(record, 'status', COORDINATION_SESSION_STATUSES, label),
    attached_event_seq: integer(record, 'attached_event_seq', label),
    version: integer(record, 'version', label, 1),
  };
}

export function parseCoordinationChildLease(value: unknown): CoordinationChildLease {
  const label = 'CoordinationChildLease';
  const record = object(value, label, ['boot_id', 'child_lease_id', 'lease_expires_at', 'owner', 'pid', 'schema_version', 'status', 'terminal_evidence', 'version']);
  return {
    schema_version: literal(record, 'schema_version', 'autopilot.child_lease.v1', label),
    child_lease_id: identifier(record, 'child_lease_id', label),
    owner: parseCoordinationOwnerIdentity(record['owner'], `${label}.owner`),
    pid: integer(record, 'pid', label, 1),
    boot_id: identifier(record, 'boot_id', label),
    lease_expires_at: timestamp(record, 'lease_expires_at', label),
    status: oneOf(record, 'status', COORDINATION_CHILD_STATUSES, label),
    terminal_evidence: parseNullableEvidence(record['terminal_evidence'], `${label}.terminal_evidence`),
    version: integer(record, 'version', label, 1),
  };
}

export function parseCoordinationUnitAttempt(value: unknown): CoordinationUnitAttempt {
  const label = 'CoordinationUnitAttempt';
  const record = object(value, label, ['checkpoint_ordinal', 'critical_section', 'owner', 'preemptible', 'schema_version', 'spec', 'state', 'version']);
  return {
    schema_version: literal(record, 'schema_version', 'autopilot.unit_attempt.v1', label),
    owner: parseCoordinationOwnerIdentity(record['owner'], `${label}.owner`),
    state: oneOf(record, 'state', COORDINATION_UNIT_STATES, label),
    spec: parseEvidence(record['spec'], `${label}.spec`),
    preemptible: boolean(record, 'preemptible', label),
    checkpoint_ordinal: integer(record, 'checkpoint_ordinal', label),
    critical_section: nullableString(record, 'critical_section', label, 128),
    version: integer(record, 'version', label, 1),
  };
}

export function parseCoordinationAcquisitionGroup(value: unknown): CoordinationAcquisitionGroup {
  const label = 'CoordinationAcquisitionGroup';
  const record = object(value, label, ['acquisition_group_id', 'bypass_count', 'created_event_seq', 'grant_event_seq', 'offer_expires_at', 'owner', 'requested_leases', 'schema_version', 'state', 'version']);
  const requested = array(record['requested_leases'], `${label}.requested_leases`, 1024).map((entry, index) => parseRequestedLease(entry, `${label}.requested_leases[${String(index)}]`));
  if (requested.length === 0) fail(label, 'requested_leases must not be empty');
  assertRequestedLeaseSet(requested, label);
  return {
    schema_version: literal(record, 'schema_version', 'autopilot.acquisition_group.v1', label),
    acquisition_group_id: identifier(record, 'acquisition_group_id', label),
    owner: parseCoordinationOwnerIdentity(record['owner'], `${label}.owner`),
    requested_leases: requested,
    state: oneOf(record, 'state', COORDINATION_ACQUISITION_STATES, label),
    created_event_seq: integer(record, 'created_event_seq', label),
    grant_event_seq: nullableInteger(record, 'grant_event_seq', label),
    offer_expires_at: record['offer_expires_at'] === null ? null : timestamp(record, 'offer_expires_at', label),
    bypass_count: integer(record, 'bypass_count', label),
    version: integer(record, 'version', label, 1),
  };
}

export function parseCoordinationEditLease(value: unknown): CoordinationEditLease {
  const label = 'CoordinationEditLease';
  const record = object(value, label, ['acquired_event_seq', 'acquisition_group_id', 'edit_lease_id', 'mode', 'normal_release_condition', 'owner', 'path', 'purpose', 'schema_version', 'version']);
  return {
    schema_version: literal(record, 'schema_version', 'autopilot.edit_lease.v1', label),
    edit_lease_id: identifier(record, 'edit_lease_id', label),
    owner: parseCoordinationOwnerIdentity(record['owner'], `${label}.owner`),
    acquisition_group_id: identifier(record, 'acquisition_group_id', label),
    path: repoPath(record, 'path', label),
    mode: oneOf(record, 'mode', COORDINATION_CLAIM_MODES, label),
    purpose: string(record, 'purpose', label, 512),
    acquired_event_seq: integer(record, 'acquired_event_seq', label),
    normal_release_condition: parseCoordinationReleaseCondition(record['normal_release_condition'], `${label}.normal_release_condition`),
    version: integer(record, 'version', label, 1),
  };
}

export function parseCoordinationChangeReservation(value: unknown): CoordinationChangeReservation {
  const label = 'CoordinationChangeReservation';
  const record = object(value, label, ['autopilot_id', 'created_event_seq', 'merge_evidence', 'path', 'released_event_seq', 'repo_id', 'reservation_id', 'schema_version', 'version', 'workstream_run']);
  return {
    schema_version: literal(record, 'schema_version', 'autopilot.change_reservation.v1', label),
    reservation_id: identifier(record, 'reservation_id', label),
    repo_id: identifier(record, 'repo_id', label),
    autopilot_id: identifier(record, 'autopilot_id', label),
    workstream_run: identifier(record, 'workstream_run', label),
    path: repoPath(record, 'path', label),
    merge_evidence: parseEvidence(record['merge_evidence'], `${label}.merge_evidence`),
    created_event_seq: integer(record, 'created_event_seq', label),
    released_event_seq: nullableInteger(record, 'released_event_seq', label),
    version: integer(record, 'version', label, 1),
  };
}

export function parseCoordinationClaimRequest(value: unknown): CoordinationClaimRequest {
  const label = 'CoordinationClaimRequest';
  const record = object(value, label, ['acquisition_group_id', 'blocking_lease_ids', 'created_event_seq', 'grant_event_seq', 'owner', 'owner_reason', 'reason', 'release_condition', 'release_event_seq', 'request_id', 'requested_leases', 'requester', 'schema_version', 'status', 'version']);
  const requested = array(record['requested_leases'], `${label}.requested_leases`, 1024).map((entry, index) => parseRequestedLease(entry, `${label}.requested_leases[${String(index)}]`));
  if (requested.length === 0) fail(label, 'requested_leases must not be empty');
  assertRequestedLeaseSet(requested, label);
  return {
    schema_version: literal(record, 'schema_version', 'autopilot.claim_request.v1', label),
    request_id: identifier(record, 'request_id', label),
    acquisition_group_id: identifier(record, 'acquisition_group_id', label),
    requester: parseCoordinationOwnerIdentity(record['requester'], `${label}.requester`),
    owner: parseCoordinationOwnerIdentity(record['owner'], `${label}.owner`),
    blocking_lease_ids: uniqueStrings(record['blocking_lease_ids'], `${label}.blocking_lease_ids`, 1),
    requested_leases: requested,
    reason: string(record, 'reason', label, 1024),
    created_event_seq: integer(record, 'created_event_seq', label),
    status: oneOf(record, 'status', COORDINATION_REQUEST_STATUSES, label),
    owner_reason: nullableString(record, 'owner_reason', label, 1024),
    release_condition: record['release_condition'] === null ? null : parseCoordinationReleaseCondition(record['release_condition'], `${label}.release_condition`),
    release_event_seq: nullableInteger(record, 'release_event_seq', label),
    grant_event_seq: nullableInteger(record, 'grant_event_seq', label),
    version: integer(record, 'version', label, 1),
  };
}

export function parseCoordinationMessage(value: unknown): CoordinationMessage {
  const label = 'CoordinationMessage';
  const record = object(value, label, ['acknowledged_event_seq', 'correlation_id', 'created_event_seq', 'delivered_event_seq', 'message_id', 'message_type', 'payload', 'recipient_workstream_run', 'repo_id', 'schema_version', 'status', 'version']);
  return {
    schema_version: literal(record, 'schema_version', 'autopilot.coordination_message.v1', label),
    message_id: identifier(record, 'message_id', label),
    repo_id: identifier(record, 'repo_id', label),
    recipient_workstream_run: identifier(record, 'recipient_workstream_run', label),
    message_type: oneOf(record, 'message_type', MESSAGE_TYPES, label),
    correlation_id: identifier(record, 'correlation_id', label),
    payload: boundedJsonObject(record['payload'], `${label}.payload`),
    status: oneOf(record, 'status', COORDINATION_MESSAGE_STATUSES, label),
    created_event_seq: integer(record, 'created_event_seq', label),
    delivered_event_seq: nullableInteger(record, 'delivered_event_seq', label),
    acknowledged_event_seq: nullableInteger(record, 'acknowledged_event_seq', label),
    version: integer(record, 'version', label, 1),
  };
}

export function parseCoordinationWorktree(value: unknown): CoordinationWorktree {
  const label = 'CoordinationWorktree';
  const record = object(value, label, ['branch', 'canonical_path', 'git_common_dir', 'owner', 'schema_version', 'state', 'version', 'worktree_id']);
  return {
    schema_version: literal(record, 'schema_version', 'autopilot.coordination_worktree.v1', label),
    worktree_id: identifier(record, 'worktree_id', label),
    owner: parseCoordinationOwnerIdentity(record['owner'], `${label}.owner`),
    canonical_path: absolutePath(record, 'canonical_path', label),
    git_common_dir: absolutePath(record, 'git_common_dir', label),
    branch: string(record, 'branch', label, 512),
    state: oneOf(record, 'state', WORKTREE_STATES, label),
    version: integer(record, 'version', label, 1),
  };
}

export function parseCoordinationWorktreeOperation(value: unknown): CoordinationWorktreeOperation {
  const label = 'CoordinationWorktreeOperation';
  const record = object(value, label, ['authority_version', 'error_code', 'intent_event_seq', 'operation_id', 'operation_type', 'owner', 'schema_version', 'stage', 'verification_evidence', 'version', 'worktree_id']);
  return {
    schema_version: literal(record, 'schema_version', 'autopilot.worktree_operation.v1', label),
    operation_id: identifier(record, 'operation_id', label),
    worktree_id: identifier(record, 'worktree_id', label),
    owner: parseCoordinationOwnerIdentity(record['owner'], `${label}.owner`),
    operation_type: oneOf(record, 'operation_type', OPERATION_TYPES, label),
    stage: oneOf(record, 'stage', COORDINATION_OPERATION_STAGES, label),
    authority_version: integer(record, 'authority_version', label, 1),
    intent_event_seq: integer(record, 'intent_event_seq', label),
    verification_evidence: parseNullableEvidence(record['verification_evidence'], `${label}.verification_evidence`),
    error_code: nullableString(record, 'error_code', label, 128),
    version: integer(record, 'version', label, 1),
  };
}

function parseExhaustedAlternative(value: string, label: string): CoordinationEscalation['exhausted_alternatives'][number] {
  switch (value) {
    case 'sequencing':
    case 'partitioning':
    case 'ownership-transfer':
    case 'rebase-revalidation':
    case 'replanning':
      return value;
    default:
      return fail(label, `unsupported exhausted alternative ${value}`);
  }
}

export function parseCoordinationEscalation(value: unknown): CoordinationEscalation {
  const label = 'CoordinationEscalation';
  const record = object(value, label, ['adjudication', 'authoritative_refs', 'conflicting_clauses', 'created_event_seq', 'decision_options', 'escalation_id', 'exhausted_alternatives', 'participating_runs', 'repo_id', 'schema_version', 'version']);
  const refs = array(record['authoritative_refs'], `${label}.authoritative_refs`, 32).map((entry, index) => parseEvidence(entry, `${label}.authoritative_refs[${String(index)}]`));
  if (refs.length < 2) fail(label, 'authoritative_refs must contain at least two entries');
  const alternativeValues = uniqueStrings(record['exhausted_alternatives'], `${label}.exhausted_alternatives`, EXHAUSTED_ALTERNATIVES.length, EXHAUSTED_ALTERNATIVES.length);
  if (!EXHAUSTED_ALTERNATIVES.every((entry) => alternativeValues.includes(entry))) fail(label, 'exhausted_alternatives must contain every required alternative');
  const alternatives = alternativeValues.map((entry) => parseExhaustedAlternative(entry, label));
  return {
    schema_version: literal(record, 'schema_version', 'autopilot.planning_contradiction.v1', label),
    escalation_id: identifier(record, 'escalation_id', label),
    repo_id: identifier(record, 'repo_id', label),
    participating_runs: uniqueStrings(record['participating_runs'], `${label}.participating_runs`, 2, 32),
    authoritative_refs: refs,
    conflicting_clauses: uniqueStrings(record['conflicting_clauses'], `${label}.conflicting_clauses`, 2, 32),
    exhausted_alternatives: alternatives,
    adjudication: parseEvidence(record['adjudication'], `${label}.adjudication`),
    decision_options: uniqueStrings(record['decision_options'], `${label}.decision_options`, 2, 16),
    created_event_seq: integer(record, 'created_event_seq', label),
    version: integer(record, 'version', label, 1),
  };
}

export function parseCoordinationEvent(value: unknown): CoordinationEvent {
  const label = 'CoordinationEvent';
  const record = object(value, label, ['entity_id', 'entity_type', 'event_seq', 'event_type', 'idempotency_key', 'occurred_at', 'repo_id', 'request_sha256', 'schema_version']);
  const requestDigest = string(record, 'request_sha256', label, 71);
  if (!SHA256.test(requestDigest)) fail(label, 'request_sha256 must use sha256:<64 lowercase hex>');
  return {
    schema_version: literal(record, 'schema_version', 'autopilot.coordination_event.v1', label),
    repo_id: identifier(record, 'repo_id', label),
    event_seq: integer(record, 'event_seq', label, 1),
    event_type: identifier(record, 'event_type', label),
    entity_type: identifier(record, 'entity_type', label),
    entity_id: identifier(record, 'entity_id', label),
    idempotency_key: identifier(record, 'idempotency_key', label),
    request_sha256: requestDigest as `sha256:${string}`,
    occurred_at: timestamp(record, 'occurred_at', label),
  };
}

function parseTable<T>(record: JsonObject, field: string, parser: (value: unknown) => T, maxItems = 10_000): readonly T[] {
  return Object.freeze(array(record[field], `CoordinationSnapshot.${field}`, maxItems).map(parser));
}

export function parseCoordinationSnapshot(value: unknown): CoordinationSnapshot {
  const label = 'CoordinationSnapshot';
  const fields = ['acquisition_groups', 'change_reservations', 'child_leases', 'claim_requests', 'edit_leases', 'escalations', 'events', 'messages', 'repositories', 'repository_event_seq', 'runs', 'schema_version', 'session_leases', 'unit_attempts', 'worktree_operations', 'worktrees'] as const;
  const record = object(value, label, fields);
  return {
    schema_version: literal(record, 'schema_version', AUTOPILOT_COORDINATION_SNAPSHOT_SCHEMA, label),
    repository_event_seq: integer(record, 'repository_event_seq', label),
    repositories: parseTable(record, 'repositories', parseCoordinationRepository),
    runs: parseTable(record, 'runs', parseCoordinationRun),
    session_leases: parseTable(record, 'session_leases', parseCoordinationSessionLease),
    child_leases: parseTable(record, 'child_leases', parseCoordinationChildLease),
    unit_attempts: parseTable(record, 'unit_attempts', parseCoordinationUnitAttempt),
    acquisition_groups: parseTable(record, 'acquisition_groups', parseCoordinationAcquisitionGroup),
    edit_leases: parseTable(record, 'edit_leases', parseCoordinationEditLease),
    change_reservations: parseTable(record, 'change_reservations', parseCoordinationChangeReservation),
    claim_requests: parseTable(record, 'claim_requests', parseCoordinationClaimRequest),
    messages: parseTable(record, 'messages', parseCoordinationMessage, 100_000),
    worktrees: parseTable(record, 'worktrees', parseCoordinationWorktree),
    worktree_operations: parseTable(record, 'worktree_operations', parseCoordinationWorktreeOperation),
    escalations: parseTable(record, 'escalations', parseCoordinationEscalation),
    events: parseTable(record, 'events', parseCoordinationEvent, 100_000),
  };
}

function parsePayload(value: unknown, action: CoordinatorQueryAction | CoordinatorMutationAction): JsonObject {
  const label = `CoordinatorRequestEnvelope.payload(${action})`;
  const payload = object(value, label, PAYLOAD_FIELDS[action]);
  for (const field of PAYLOAD_FIELDS[action]) {
    const entry = payload[field];
    if (field === 'pid' || field === 'attempt') {
      if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 1) fail(label, `${field} must be a positive safe integer`);
    } else if (field === 'lease_expires_at') {
      timestamp(payload, field, label);
    } else if (field === 'response') {
      oneOf(payload, field, ['release-now', 'deferred'] as const, label);
    } else if (field === 'stage') {
      oneOf(payload, field, COORDINATION_OPERATION_STAGES, label);
    } else if (field === 'status') {
      oneOf(payload, field, ['terminal', 'recovery-required'] as const, label);
    } else if (field === 'output_path' || field === 'canonical_root' || field === 'git_common_dir') {
      absolutePath(payload, field, label);
    } else if (field === 'child_token' || field === 'session_token') {
      if (typeof entry !== 'string' || !CHILD_TOKEN.test(entry)) fail(label, `${field} must be 32 random bytes encoded as lowercase hex`);
    } else if (field === 'handoff_token' || field === 'evidence_ref' || field === 'evidence_sha256') {
      if (entry !== null && (typeof entry !== 'string' || entry.length === 0 || entry.length > 1024)) fail(label, `${field} must be null or a bounded non-empty string`);
      if (field === 'evidence_sha256' && typeof entry === 'string' && !SHA256.test(entry)) fail(label, 'evidence_sha256 must use sha256:<64 lowercase hex>');
    } else if (typeof entry !== 'string' || entry.length === 0 || entry.length > 1024) {
      fail(label, `${field} must be a bounded non-empty string`);
    }
  }
  return payload;
}

export function parseCoordinatorRequestEnvelope(value: unknown): CoordinatorRequestEnvelope {
  const label = 'CoordinatorRequestEnvelope';
  const record = object(value, label, ['action', 'expected_version', 'fencing_generation', 'idempotency_key', 'payload', 'protocol_version', 'repo_id', 'request_id', 'schema_version', 'session_id', 'workstream_run']);
  const action = oneOf(record, 'action', [...QUERY_ACTIONS, ...MUTATION_ACTIONS] as const, label);
  const mutation = (MUTATION_ACTIONS as readonly string[]).includes(action);
  const idempotencyKey = nullableString(record, 'idempotency_key', label, 192);
  const workstreamRun = nullableString(record, 'workstream_run', label, 192);
  const sessionId = nullableString(record, 'session_id', label, 192);
  const fencingGeneration = nullableInteger(record, 'fencing_generation', label);
  const expectedVersion = nullableInteger(record, 'expected_version', label);
  if (mutation && (idempotencyKey === null || workstreamRun === null || expectedVersion === null)) {
    fail(label, 'mutating requests require idempotency_key, workstream_run, and expected_version');
  }
  const childScoped = action === 'heartbeat-child' || action === 'complete-child';
  if (mutation && action !== 'attach-run' && !childScoped && (sessionId === null || fencingGeneration === null)) {
    fail(label, 'session-scoped mutations require session_id and fencing_generation');
  }
  if ((action === 'attach-run' || childScoped) && (sessionId !== null || fencingGeneration !== null)) {
    fail(label, `${action} must not carry ephemeral session identity`);
  }
  return {
    schema_version: literal(record, 'schema_version', AUTOPILOT_COORDINATOR_REQUEST_SCHEMA, label),
    protocol_version: literal(record, 'protocol_version', AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, label),
    request_id: identifier(record, 'request_id', label),
    action,
    idempotency_key: idempotencyKey,
    repo_id: identifier(record, 'repo_id', label),
    workstream_run: workstreamRun,
    session_id: sessionId,
    fencing_generation: fencingGeneration,
    expected_version: expectedVersion,
    payload: parsePayload(record['payload'], action),
  };
}

export function parseCoordinatorResponseEnvelope(value: unknown): CoordinatorResponseEnvelope {
  const label = 'CoordinatorResponseEnvelope';
  const record = object(value, label, ['committed_event_seq', 'error_code', 'ok', 'payload', 'protocol_version', 'request_id', 'retryable', 'schema_version']);
  const ok = boolean(record, 'ok', label);
  const committedEventSeq = nullableInteger(record, 'committed_event_seq', label);
  const errorCode = nullableString(record, 'error_code', label, 128);
  if (ok && errorCode !== null) fail(label, 'successful response cannot contain error_code');
  if (!ok && errorCode === null) fail(label, 'failed response requires error_code');
  return {
    schema_version: literal(record, 'schema_version', AUTOPILOT_COORDINATOR_RESPONSE_SCHEMA, label),
    protocol_version: literal(record, 'protocol_version', AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, label),
    request_id: identifier(record, 'request_id', label),
    ok,
    committed_event_seq: committedEventSeq,
    error_code: errorCode,
    retryable: boolean(record, 'retryable', label),
    payload: boundedJsonObject(record['payload'], `${label}.payload`),
  };
}

export function claimModesConflict(left: CoordinationClaimMode, right: CoordinationClaimMode): boolean {
  return left !== 'READ' || right !== 'READ';
}

export function coordinationPathsOverlap(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/\/\*\*$/u, '').replace(/\/$/u, '');
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
