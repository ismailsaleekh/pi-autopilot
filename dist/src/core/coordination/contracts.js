import { isAbsolute, normalize } from 'node:path';
import { AUTOPILOT_COORDINATION_SNAPSHOT_SCHEMA, AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, AUTOPILOT_COORDINATOR_REQUEST_SCHEMA, AUTOPILOT_COORDINATOR_RESPONSE_SCHEMA, COORDINATION_ACQUISITION_STATES, COORDINATION_CHILD_STATUSES, COORDINATION_CLAIM_MODES, COORDINATION_MESSAGE_STATUSES, COORDINATION_OPERATION_STAGES, COORDINATION_OPERATION_TYPES, COORDINATION_RELEASE_CONDITION_TYPES, COORDINATION_RECONCILIATION_SOURCES, COORDINATION_REQUEST_STATUSES, COORDINATION_RUN_STATUSES, COORDINATION_SESSION_STATUSES, COORDINATION_UNIT_STATES, COORDINATION_WORKTREE_KINDS, COORDINATION_WORKTREE_STATES, } from "./types.js";
export class CoordinationContractError extends Error {
    name = 'CoordinationContractError';
    code = 'invalid-coordination-contract';
    issues;
    constructor(label, issues) {
        super(`${label} failed coordination contract validation: ${issues.join('; ')}`);
        this.issues = Object.freeze([...issues]);
    }
}
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const CHILD_TOKEN = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/u;
const QUERY_ACTIONS = ['status', 'doctor', 'export'];
const MUTATION_ACTIONS = ['attach-run', 'attach-session', 'detach-session', 'prepare-handoff', 'heartbeat', 'register-child', 'heartbeat-child', 'complete-child', 'drain-mailbox', 'acquire-group', 'acknowledge-grant', 'respond-claim-request', 'cancel-claim-request', 'cancel-acquisition-group', 'supersede-attempt', 'acknowledge-message', 'record-release-evidence', 'reconcile-run', 'prepare-operation', 'transition-operation'];
const MESSAGE_TYPES = ['claim-request', 'release-notification', 'grant-offer', 'recovery-required'];
const WORKTREE_STATES = COORDINATION_WORKTREE_STATES;
const OPERATION_TYPES = COORDINATION_OPERATION_TYPES;
const EXHAUSTED_ALTERNATIVES = ['sequencing', 'partitioning', 'ownership-transfer', 'rebase-revalidation', 'replanning'];
const PAYLOAD_FIELDS = {
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
    'acquire-group': ['acquisition_group_id', 'attempt', 'checkpoint_ordinal', 'normal_release_condition', 'preemptible', 'reason', 'requested_leases', 'session_lease_id', 'session_token', 'spec_ref', 'spec_sha256', 'unit_id'],
    'acknowledge-grant': ['acquisition_group_id', 'session_lease_id', 'session_token'],
    'respond-claim-request': ['owner_reason', 'release_condition', 'request_id', 'response', 'session_lease_id', 'session_token'],
    'cancel-claim-request': ['reason', 'request_id', 'session_lease_id', 'session_token'],
    'cancel-acquisition-group': ['acquisition_group_id', 'reason', 'session_lease_id', 'session_token'],
    'supersede-attempt': ['attempt', 'reason', 'session_lease_id', 'session_token', 'superseded_by_attempt', 'unit_id'],
    'acknowledge-message': ['message_id', 'session_lease_id', 'session_token'],
    'record-release-evidence': ['evidence_ref', 'evidence_sha256', 'source', 'target_id', 'session_lease_id', 'session_token'],
    'reconcile-run': ['reason', 'session_lease_id', 'session_token'],
    'prepare-operation': ['operation', 'session_lease_id', 'session_token', 'worktree'],
    'transition-operation': ['completed_steps', 'current_step', 'error_code', 'operation_id', 'recovery_attempts', 'session_lease_id', 'session_token', 'stage', 'verification_evidence', 'worktree_state'],
};
function fail(label, issue) {
    throw new CoordinationContractError(label, [issue]);
}
function isJsonObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function object(value, label, fields) {
    if (!isJsonObject(value))
        fail(label, 'must be an object');
    const record = value;
    const unknownFields = Object.keys(record).filter((key) => !fields.includes(key));
    if (unknownFields.length > 0)
        fail(label, `contains unknown fields: ${unknownFields.sort().join(', ')}`);
    for (const field of fields) {
        if (!(field in record))
            fail(label, `missing required field ${field}`);
    }
    return record;
}
function string(record, field, label, maxLength = 512) {
    const value = record[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength)
        fail(label, `${field} must be a non-empty string of at most ${String(maxLength)} characters`);
    return value;
}
function nullableString(record, field, label, maxLength = 512) {
    const value = record[field];
    if (value === null)
        return null;
    return string(record, field, label, maxLength);
}
function identifier(record, field, label) {
    const value = string(record, field, label, 192);
    if (!IDENTIFIER.test(value))
        fail(label, `${field} is not a valid bounded identifier`);
    return value;
}
function pathSegmentIdentifier(record, field, label) {
    const value = identifier(record, field, label);
    if (value === '.' || value === '..' || value.includes('/') || value.includes('\\'))
        fail(label, `${field} must be one filesystem-safe identifier segment`);
    return value;
}
function nullablePathSegmentIdentifier(record, field, label) {
    if (record[field] === null)
        return null;
    return pathSegmentIdentifier(record, field, label);
}
function integer(record, field, label, minimum = 0) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
        fail(label, `${field} must be a safe integer >= ${String(minimum)}`);
    return value;
}
function nullableInteger(record, field, label) {
    if (record[field] === null)
        return null;
    return integer(record, field, label);
}
function boolean(record, field, label) {
    const value = record[field];
    if (typeof value !== 'boolean')
        fail(label, `${field} must be boolean`);
    return value;
}
function literal(record, field, expected, label) {
    if (record[field] !== expected)
        fail(label, `${field} must equal ${expected}`);
    return expected;
}
function oneOf(record, field, values, label) {
    const value = record[field];
    if (typeof value !== 'string' || !values.includes(value))
        fail(label, `${field} must be one of ${values.join(', ')}`);
    return value;
}
function timestamp(record, field, label) {
    const value = string(record, field, label, 32);
    if (!ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value)))
        fail(label, `${field} must be an ISO UTC timestamp`);
    return value;
}
function absolutePath(record, field, label) {
    const value = string(record, field, label, 1024);
    if (!isAbsolute(value) || value.includes('\u0000') || normalize(value) !== value)
        fail(label, `${field} must be a normalized absolute path`);
    return value;
}
function repoPath(record, field, label) {
    const value = string(record, field, label, 512);
    const segments = value.split('/');
    if (value.startsWith('/') || value.startsWith('./') || value.endsWith('/') || value.includes('//') || /^[A-Za-z]:/u.test(value) || value.includes('\\') || value.includes('\u0000') || /^\s/u.test(value) || segments.includes('.') || segments.includes('..'))
        fail(label, `${field} must be a normalized repository-relative path`);
    return value;
}
function array(value, label, maxItems = 10_000) {
    if (!Array.isArray(value) || value.length > maxItems)
        fail(label, `must be an array with at most ${String(maxItems)} entries`);
    return value;
}
function boundedJsonValue(value, label, depth) {
    if (depth > 8)
        fail(label, 'exceeds maximum JSON nesting depth');
    if (value === null || typeof value === 'boolean')
        return value;
    if (typeof value === 'string') {
        if (value.length > 4096)
            fail(label, 'contains a string longer than 4096 characters');
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            fail(label, 'contains a non-finite number');
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > 1024)
            fail(label, 'contains an array longer than 1024 entries');
        return Object.freeze(value.map((entry, index) => boundedJsonValue(entry, `${label}[${String(index)}]`, depth + 1)));
    }
    if (!isJsonObject(value))
        fail(label, 'contains a non-JSON value');
    const entries = Object.entries(value);
    if (entries.length > 256)
        fail(label, 'contains an object with more than 256 fields');
    const out = {};
    for (const [key, entry] of entries) {
        if (key.length === 0 || key.length > 128)
            fail(label, 'contains an invalid field name');
        out[key] = boundedJsonValue(entry, `${label}.${key}`, depth + 1);
    }
    return Object.freeze(out);
}
function boundedJsonObject(value, label) {
    const parsed = boundedJsonValue(value, label, 0);
    if (!isJsonObject(parsed))
        fail(label, 'must be a JSON object');
    return parsed;
}
function uniqueStrings(value, label, minItems = 0, maxItems = 1024) {
    const values = array(value, label, maxItems).map((entry, index) => {
        if (typeof entry !== 'string' || entry.length === 0 || entry.length > 1024)
            fail(label, `entry ${String(index)} must be a bounded non-empty string`);
        return entry;
    });
    if (values.length < minItems)
        fail(label, `must contain at least ${String(minItems)} entries`);
    if (new Set(values).size !== values.length)
        fail(label, 'must not contain duplicate entries');
    return Object.freeze(values);
}
function parseEvidence(value, label) {
    const record = object(value, label, ['ref', 'sha256']);
    const digest = string(record, 'sha256', label, 71);
    if (!SHA256.test(digest))
        fail(label, 'sha256 must use sha256:<64 lowercase hex>');
    return { ref: repoPath(record, 'ref', label), sha256: digest };
}
function parseNullableEvidence(value, label) {
    return value === null ? null : parseEvidence(value, label);
}
export function parseCoordinationOwnerIdentity(value, label = 'CoordinationOwnerIdentity') {
    const record = object(value, label, ['attempt', 'autopilot_id', 'repo_id', 'unit_id', 'workstream_run']);
    return {
        repo_id: pathSegmentIdentifier(record, 'repo_id', label),
        autopilot_id: pathSegmentIdentifier(record, 'autopilot_id', label),
        workstream_run: pathSegmentIdentifier(record, 'workstream_run', label),
        unit_id: identifier(record, 'unit_id', label),
        attempt: integer(record, 'attempt', label, 1),
    };
}
export function parseCoordinationReleaseCondition(value, label = 'CoordinationReleaseCondition') {
    const record = object(value, label, ['condition_type', 'evidence', 'target_id']);
    return {
        condition_type: oneOf(record, 'condition_type', COORDINATION_RELEASE_CONDITION_TYPES, label),
        target_id: identifier(record, 'target_id', label),
        evidence: parseNullableEvidence(record['evidence'], `${label}.evidence`),
    };
}
export function parseCoordinationRequestedLease(value, label = 'CoordinationRequestedLease') {
    const record = object(value, label, ['mode', 'path', 'purpose']);
    return {
        path: repoPath(record, 'path', label),
        mode: oneOf(record, 'mode', COORDINATION_CLAIM_MODES, label),
        purpose: string(record, 'purpose', label, 512),
    };
}
function assertRequestedLeaseSet(leases, label) {
    const identities = leases.map((lease) => `${lease.mode}\0${lease.path}`);
    if (new Set(identities).size !== identities.length)
        fail(label, 'requested_leases must not contain duplicate mode/path entries');
    for (let leftIndex = 0; leftIndex < leases.length; leftIndex += 1) {
        const left = leases[leftIndex];
        if (left === undefined)
            continue;
        for (let rightIndex = leftIndex + 1; rightIndex < leases.length; rightIndex += 1) {
            const right = leases[rightIndex];
            if (right !== undefined && coordinationPathsOverlap(left.path, right.path) && claimModesConflict(left.mode, right.mode))
                fail(label, `requested_leases contain internally incompatible authority: ${left.mode} ${left.path} and ${right.mode} ${right.path}`);
        }
    }
}
export function parseCoordinationRepository(value) {
    const label = 'CoordinationRepository';
    const record = object(value, label, ['canonical_root', 'created_event_seq', 'git_common_dir', 'repo_id', 'repo_key', 'schema_version', 'version']);
    return {
        schema_version: literal(record, 'schema_version', 'autopilot.coordination_repository.v1', label),
        repo_id: pathSegmentIdentifier(record, 'repo_id', label),
        repo_key: pathSegmentIdentifier(record, 'repo_key', label),
        canonical_root: absolutePath(record, 'canonical_root', label),
        git_common_dir: absolutePath(record, 'git_common_dir', label),
        created_event_seq: integer(record, 'created_event_seq', label),
        version: integer(record, 'version', label, 1),
    };
}
export function parseCoordinationRun(value) {
    const label = 'CoordinationRun';
    const record = object(value, label, ['active_session_generation', 'autopilot_id', 'created_event_seq', 'repo_id', 'schema_version', 'status', 'version', 'workstream', 'workstream_run']);
    return {
        schema_version: literal(record, 'schema_version', 'autopilot.coordination_run.v1', label),
        repo_id: pathSegmentIdentifier(record, 'repo_id', label),
        autopilot_id: pathSegmentIdentifier(record, 'autopilot_id', label),
        workstream: identifier(record, 'workstream', label),
        workstream_run: pathSegmentIdentifier(record, 'workstream_run', label),
        status: oneOf(record, 'status', COORDINATION_RUN_STATUSES, label),
        active_session_generation: integer(record, 'active_session_generation', label),
        created_event_seq: integer(record, 'created_event_seq', label),
        version: integer(record, 'version', label, 1),
    };
}
export function parseCoordinationSessionLease(value) {
    const label = 'CoordinationSessionLease';
    const record = object(value, label, ['attached_event_seq', 'boot_id', 'lease_expires_at', 'pid', 'repo_id', 'schema_version', 'session_generation', 'session_id', 'session_lease_id', 'status', 'version', 'workstream_run']);
    return {
        schema_version: literal(record, 'schema_version', 'autopilot.session_lease.v1', label),
        session_lease_id: identifier(record, 'session_lease_id', label),
        repo_id: pathSegmentIdentifier(record, 'repo_id', label),
        workstream_run: pathSegmentIdentifier(record, 'workstream_run', label),
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
export function parseCoordinationChildLease(value) {
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
export function parseCoordinationUnitAttempt(value) {
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
export function parseCoordinationAcquisitionGroup(value) {
    const label = 'CoordinationAcquisitionGroup';
    const record = object(value, label, ['acquisition_group_id', 'bypass_count', 'created_event_seq', 'fairness_event_seq', 'grant_event_seq', 'normal_release_condition', 'offer_count', 'offer_expires_at', 'owner', 'reason', 'requested_leases', 'schema_version', 'state', 'version']);
    const requested = array(record['requested_leases'], `${label}.requested_leases`, 1024).map((entry, index) => parseCoordinationRequestedLease(entry, `${label}.requested_leases[${String(index)}]`));
    if (requested.length === 0)
        fail(label, 'requested_leases must not be empty');
    assertRequestedLeaseSet(requested, label);
    return {
        schema_version: literal(record, 'schema_version', 'autopilot.acquisition_group.v2', label),
        acquisition_group_id: identifier(record, 'acquisition_group_id', label),
        owner: parseCoordinationOwnerIdentity(record['owner'], `${label}.owner`),
        requested_leases: requested,
        reason: string(record, 'reason', label, 1024),
        normal_release_condition: parseCoordinationReleaseCondition(record['normal_release_condition'], `${label}.normal_release_condition`),
        state: oneOf(record, 'state', COORDINATION_ACQUISITION_STATES, label),
        created_event_seq: integer(record, 'created_event_seq', label),
        fairness_event_seq: integer(record, 'fairness_event_seq', label),
        grant_event_seq: nullableInteger(record, 'grant_event_seq', label),
        offer_expires_at: record['offer_expires_at'] === null ? null : timestamp(record, 'offer_expires_at', label),
        offer_count: integer(record, 'offer_count', label),
        bypass_count: integer(record, 'bypass_count', label),
        version: integer(record, 'version', label, 1),
    };
}
export function parseCoordinationEditLease(value) {
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
export function parseCoordinationChangeReservation(value) {
    const label = 'CoordinationChangeReservation';
    const record = object(value, label, ['autopilot_id', 'created_event_seq', 'merge_evidence', 'path', 'released_event_seq', 'repo_id', 'reservation_id', 'schema_version', 'version', 'workstream_run']);
    return {
        schema_version: literal(record, 'schema_version', 'autopilot.change_reservation.v1', label),
        reservation_id: identifier(record, 'reservation_id', label),
        repo_id: pathSegmentIdentifier(record, 'repo_id', label),
        autopilot_id: pathSegmentIdentifier(record, 'autopilot_id', label),
        workstream_run: pathSegmentIdentifier(record, 'workstream_run', label),
        path: repoPath(record, 'path', label),
        merge_evidence: parseEvidence(record['merge_evidence'], `${label}.merge_evidence`),
        created_event_seq: integer(record, 'created_event_seq', label),
        released_event_seq: nullableInteger(record, 'released_event_seq', label),
        version: integer(record, 'version', label, 1),
    };
}
export function parseCoordinationClaimRequest(value) {
    const label = 'CoordinationClaimRequest';
    const record = object(value, label, ['acquisition_group_id', 'blocking_lease_ids', 'created_event_seq', 'grant_event_seq', 'owner', 'owner_reason', 'reason', 'release_condition', 'release_event_seq', 'request_id', 'requested_leases', 'requester', 'schema_version', 'status', 'version']);
    const requested = array(record['requested_leases'], `${label}.requested_leases`, 1024).map((entry, index) => parseCoordinationRequestedLease(entry, `${label}.requested_leases[${String(index)}]`));
    if (requested.length === 0)
        fail(label, 'requested_leases must not be empty');
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
export function parseCoordinationMailboxCursor(value) {
    const label = 'CoordinationMailboxCursor';
    const record = object(value, label, ['acknowledged_through_event_seq', 'delivered_through_event_seq', 'repo_id', 'schema_version', 'version', 'workstream_run']);
    const delivered = integer(record, 'delivered_through_event_seq', label);
    const acknowledged = integer(record, 'acknowledged_through_event_seq', label);
    if (acknowledged > delivered)
        fail(label, 'acknowledged cursor cannot exceed delivered cursor');
    return {
        schema_version: literal(record, 'schema_version', 'autopilot.mailbox_cursor.v1', label),
        repo_id: pathSegmentIdentifier(record, 'repo_id', label),
        workstream_run: pathSegmentIdentifier(record, 'workstream_run', label),
        delivered_through_event_seq: delivered,
        acknowledged_through_event_seq: acknowledged,
        version: integer(record, 'version', label, 1),
    };
}
export function parseCoordinationReconciliationEvidence(value) {
    const label = 'CoordinationReconciliationEvidence';
    const record = object(value, label, ['accepted_event_seq', 'autopilot_id', 'reconciliation_evidence_id', 'release_condition', 'repo_id', 'schema_version', 'source', 'version', 'workstream_run']);
    const condition = parseCoordinationReleaseCondition(record['release_condition'], `${label}.release_condition`);
    if (condition.evidence === null)
        fail(label, 'release_condition must carry immutable accepted evidence');
    return {
        schema_version: literal(record, 'schema_version', 'autopilot.reconciliation_evidence.v1', label),
        reconciliation_evidence_id: identifier(record, 'reconciliation_evidence_id', label),
        repo_id: pathSegmentIdentifier(record, 'repo_id', label),
        autopilot_id: pathSegmentIdentifier(record, 'autopilot_id', label),
        workstream_run: pathSegmentIdentifier(record, 'workstream_run', label),
        source: oneOf(record, 'source', COORDINATION_RECONCILIATION_SOURCES, label),
        release_condition: condition,
        accepted_event_seq: integer(record, 'accepted_event_seq', label, 1),
        version: integer(record, 'version', label, 1),
    };
}
export function parseCoordinationMessage(value) {
    const label = 'CoordinationMessage';
    const record = object(value, label, ['acknowledged_event_seq', 'correlation_id', 'created_event_seq', 'delivered_event_seq', 'message_id', 'message_type', 'payload', 'recipient_workstream_run', 'repo_id', 'schema_version', 'status', 'version']);
    return {
        schema_version: literal(record, 'schema_version', 'autopilot.coordination_message.v1', label),
        message_id: identifier(record, 'message_id', label),
        repo_id: pathSegmentIdentifier(record, 'repo_id', label),
        recipient_workstream_run: pathSegmentIdentifier(record, 'recipient_workstream_run', label),
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
export function parseCoordinationWorktree(value) {
    const label = 'CoordinationWorktree';
    const record = object(value, label, ['branch', 'canonical_path', 'git_common_dir', 'kind', 'owner', 'schema_version', 'state', 'version', 'worktree_id']);
    return {
        schema_version: literal(record, 'schema_version', 'autopilot.coordination_worktree.v2', label),
        worktree_id: identifier(record, 'worktree_id', label),
        owner: parseCoordinationOwnerIdentity(record['owner'], `${label}.owner`),
        kind: oneOf(record, 'kind', COORDINATION_WORKTREE_KINDS, label),
        canonical_path: absolutePath(record, 'canonical_path', label),
        git_common_dir: absolutePath(record, 'git_common_dir', label),
        branch: string(record, 'branch', label, 512),
        state: oneOf(record, 'state', WORKTREE_STATES, label),
        version: integer(record, 'version', label, 1),
    };
}
export function parseCoordinationWorktreeOperationIntent(value) {
    const label = 'CoordinationWorktreeOperationIntent';
    const record = object(value, label, ['archive_ref', 'base_sha', 'branch', 'checkout_mode', 'git_common_dir', 'metadata_refs', 'paths', 'reason', 'repo_root', 'sparse_patterns', 'target_sha', 'worktree_path']);
    const nullableGitObject = (field) => {
        const parsed = nullableString(record, field, label, 128);
        if (parsed !== null && !/^[a-f0-9]{7,64}$/u.test(parsed))
            fail(label, `${field} must be a lowercase Git object id`);
        return parsed;
    };
    const checkout = record['checkout_mode'] === null ? null : oneOf(record, 'checkout_mode', ['full', 'claim-minimal', 'exclude-heavy'], label);
    return {
        repo_root: absolutePath(record, 'repo_root', label),
        worktree_path: absolutePath(record, 'worktree_path', label),
        git_common_dir: absolutePath(record, 'git_common_dir', label),
        branch: string(record, 'branch', label, 512),
        reason: string(record, 'reason', label, 1024),
        base_sha: nullableGitObject('base_sha'),
        target_sha: nullableGitObject('target_sha'),
        archive_ref: nullableString(record, 'archive_ref', label, 512),
        checkout_mode: checkout,
        sparse_patterns: uniqueStrings(record['sparse_patterns'], `${label}.sparse_patterns`, 0, 4096),
        paths: uniqueStrings(record['paths'], `${label}.paths`, 0, 4096),
        metadata_refs: uniqueStrings(record['metadata_refs'], `${label}.metadata_refs`, 0, 256),
    };
}
export function parseCoordinationWorktreeOperation(value) {
    const label = 'CoordinationWorktreeOperation';
    const record = object(value, label, ['authority_version', 'completed_steps', 'current_step', 'error_code', 'intent', 'intent_event_seq', 'operation_id', 'operation_type', 'owner', 'recovery_attempts', 'schema_version', 'stage', 'verification_evidence', 'version', 'worktree_id']);
    return {
        schema_version: literal(record, 'schema_version', 'autopilot.worktree_operation.v2', label),
        operation_id: identifier(record, 'operation_id', label),
        worktree_id: identifier(record, 'worktree_id', label),
        owner: parseCoordinationOwnerIdentity(record['owner'], `${label}.owner`),
        operation_type: oneOf(record, 'operation_type', OPERATION_TYPES, label),
        stage: oneOf(record, 'stage', COORDINATION_OPERATION_STAGES, label),
        authority_version: integer(record, 'authority_version', label, 1),
        intent_event_seq: integer(record, 'intent_event_seq', label),
        intent: parseCoordinationWorktreeOperationIntent(record['intent']),
        completed_steps: uniqueStrings(record['completed_steps'], `${label}.completed_steps`, 0, 128),
        current_step: nullableString(record, 'current_step', label, 192),
        recovery_attempts: integer(record, 'recovery_attempts', label),
        verification_evidence: parseNullableEvidence(record['verification_evidence'], `${label}.verification_evidence`),
        error_code: nullableString(record, 'error_code', label, 128),
        version: integer(record, 'version', label, 1),
    };
}
function parseExhaustedAlternative(value, label) {
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
export function parseCoordinationEscalation(value) {
    const label = 'CoordinationEscalation';
    const record = object(value, label, ['adjudication', 'authoritative_refs', 'conflicting_clauses', 'created_event_seq', 'decision_options', 'escalation_id', 'exhausted_alternatives', 'participating_runs', 'repo_id', 'schema_version', 'version']);
    const refs = array(record['authoritative_refs'], `${label}.authoritative_refs`, 32).map((entry, index) => parseEvidence(entry, `${label}.authoritative_refs[${String(index)}]`));
    if (refs.length < 2)
        fail(label, 'authoritative_refs must contain at least two entries');
    const alternativeValues = uniqueStrings(record['exhausted_alternatives'], `${label}.exhausted_alternatives`, EXHAUSTED_ALTERNATIVES.length, EXHAUSTED_ALTERNATIVES.length);
    if (!EXHAUSTED_ALTERNATIVES.every((entry) => alternativeValues.includes(entry)))
        fail(label, 'exhausted_alternatives must contain every required alternative');
    const alternatives = alternativeValues.map((entry) => parseExhaustedAlternative(entry, label));
    return {
        schema_version: literal(record, 'schema_version', 'autopilot.planning_contradiction.v1', label),
        escalation_id: identifier(record, 'escalation_id', label),
        repo_id: pathSegmentIdentifier(record, 'repo_id', label),
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
export function parseCoordinationEvent(value) {
    const label = 'CoordinationEvent';
    const record = object(value, label, ['entity_id', 'entity_type', 'event_seq', 'event_type', 'idempotency_key', 'occurred_at', 'repo_id', 'request_sha256', 'schema_version']);
    const requestDigest = string(record, 'request_sha256', label, 71);
    if (!SHA256.test(requestDigest))
        fail(label, 'request_sha256 must use sha256:<64 lowercase hex>');
    return {
        schema_version: literal(record, 'schema_version', 'autopilot.coordination_event.v1', label),
        repo_id: pathSegmentIdentifier(record, 'repo_id', label),
        event_seq: integer(record, 'event_seq', label, 1),
        event_type: identifier(record, 'event_type', label),
        entity_type: identifier(record, 'entity_type', label),
        entity_id: identifier(record, 'entity_id', label),
        idempotency_key: identifier(record, 'idempotency_key', label),
        request_sha256: requestDigest,
        occurred_at: timestamp(record, 'occurred_at', label),
    };
}
function parseTable(record, field, parser, maxItems = 10_000) {
    return Object.freeze(array(record[field], `CoordinationSnapshot.${field}`, maxItems).map(parser));
}
export function parseCoordinationSnapshot(value) {
    const label = 'CoordinationSnapshot';
    const fields = ['acquisition_groups', 'change_reservations', 'child_leases', 'claim_requests', 'edit_leases', 'escalations', 'events', 'mailbox_cursors', 'messages', 'reconciliation_evidence', 'repositories', 'repository_event_seq', 'runs', 'schema_version', 'session_leases', 'unit_attempts', 'worktree_operations', 'worktrees'];
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
        mailbox_cursors: parseTable(record, 'mailbox_cursors', parseCoordinationMailboxCursor),
        reconciliation_evidence: parseTable(record, 'reconciliation_evidence', parseCoordinationReconciliationEvidence),
        messages: parseTable(record, 'messages', parseCoordinationMessage, 100_000),
        worktrees: parseTable(record, 'worktrees', parseCoordinationWorktree),
        worktree_operations: parseTable(record, 'worktree_operations', parseCoordinationWorktreeOperation),
        escalations: parseTable(record, 'escalations', parseCoordinationEscalation),
        events: parseTable(record, 'events', parseCoordinationEvent, 100_000),
    };
}
function parsePayload(value, action) {
    const label = `CoordinatorRequestEnvelope.payload(${action})`;
    const payload = object(value, label, PAYLOAD_FIELDS[action]);
    for (const field of PAYLOAD_FIELDS[action]) {
        const entry = payload[field];
        if (field === 'pid' || field === 'attempt' || field === 'superseded_by_attempt') {
            if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 1)
                fail(label, `${field} must be a positive safe integer`);
        }
        else if (field === 'checkpoint_ordinal') {
            integer(payload, field, label);
        }
        else if (field === 'preemptible') {
            boolean(payload, field, label);
        }
        else if (field === 'requested_leases') {
            const requested = array(entry, `${label}.requested_leases`, 1024).map((lease, index) => parseCoordinationRequestedLease(lease, `${label}.requested_leases[${String(index)}]`));
            if (requested.length === 0)
                fail(label, 'requested_leases must not be empty');
            assertRequestedLeaseSet(requested, label);
        }
        else if (field === 'normal_release_condition') {
            parseCoordinationReleaseCondition(entry, `${label}.normal_release_condition`);
        }
        else if (field === 'release_condition') {
            if (entry !== null)
                parseCoordinationReleaseCondition(entry, `${label}.release_condition`);
        }
        else if (field === 'owner_reason') {
            if (entry !== null && (typeof entry !== 'string' || entry.length === 0 || entry.length > 1024))
                fail(label, 'owner_reason must be null or bounded non-empty text');
        }
        else if (field === 'lease_expires_at') {
            timestamp(payload, field, label);
        }
        else if (field === 'response') {
            oneOf(payload, field, ['release-now', 'deferred'], label);
        }
        else if (field === 'operation') {
            parseCoordinationWorktreeOperation(entry);
        }
        else if (field === 'worktree') {
            parseCoordinationWorktree(entry);
        }
        else if (field === 'completed_steps') {
            uniqueStrings(entry, `${label}.completed_steps`, 0, 128);
        }
        else if (field === 'current_step' || field === 'error_code') {
            if (entry !== null && (typeof entry !== 'string' || entry.length === 0 || entry.length > 192))
                fail(label, `${field} must be null or bounded non-empty text`);
        }
        else if (field === 'recovery_attempts') {
            integer(payload, field, label);
        }
        else if (field === 'verification_evidence') {
            parseNullableEvidence(entry, `${label}.verification_evidence`);
        }
        else if (field === 'worktree_state') {
            oneOf(payload, field, COORDINATION_WORKTREE_STATES, label);
        }
        else if (field === 'stage') {
            oneOf(payload, field, COORDINATION_OPERATION_STAGES, label);
        }
        else if (field === 'status') {
            oneOf(payload, field, ['terminal', 'recovery-required'], label);
        }
        else if (field === 'source') {
            oneOf(payload, field, COORDINATION_RECONCILIATION_SOURCES, label);
        }
        else if (field === 'output_path' || field === 'canonical_root' || field === 'git_common_dir') {
            absolutePath(payload, field, label);
        }
        else if (field === 'child_token' || field === 'session_token') {
            if (typeof entry !== 'string' || !CHILD_TOKEN.test(entry))
                fail(label, `${field} must be 32 random bytes encoded as lowercase hex`);
        }
        else if (field === 'spec_sha256') {
            if (typeof entry !== 'string' || !SHA256.test(entry))
                fail(label, 'spec_sha256 must use sha256:<64 lowercase hex>');
        }
        else if (field === 'spec_ref') {
            repoPath(payload, field, label);
        }
        else if (field === 'handoff_token' || field === 'evidence_ref' || field === 'evidence_sha256') {
            if (entry !== null && (typeof entry !== 'string' || entry.length === 0 || entry.length > 1024))
                fail(label, `${field} must be null or a bounded non-empty string`);
            if (field === 'evidence_sha256' && typeof entry === 'string' && !SHA256.test(entry))
                fail(label, 'evidence_sha256 must use sha256:<64 lowercase hex>');
        }
        else if (typeof entry !== 'string' || entry.length === 0 || entry.length > 1024) {
            fail(label, `${field} must be a bounded non-empty string`);
        }
    }
    if (action === 'respond-claim-request') {
        const response = payload['response'];
        const ownerReason = payload['owner_reason'];
        const condition = payload['release_condition'];
        if (response === 'deferred' && (typeof ownerReason !== 'string' || condition === null))
            fail(label, 'deferred response requires owner_reason and release_condition');
        if (response === 'release-now' && condition !== null)
            fail(label, 'release-now response must not invent a deferred release condition');
    }
    if (action === 'record-release-evidence') {
        const source = payload['source'];
        const expectedSourceTargets = {
            'unit-merge': 'unit-merged',
            'attempt-reset': 'attempt-reset',
            'quarantine-capture': 'quarantine-captured',
            'run-close': 'run-closed',
            'run-abort': 'run-closed',
        };
        if (typeof source !== 'string' || expectedSourceTargets[source] === undefined)
            fail(label, 'record-release-evidence source must be a parent-owned terminal transition');
    }
    if (action === 'supersede-attempt' && payload['attempt'] === payload['superseded_by_attempt'])
        fail(label, 'superseding attempt must differ from the old attempt');
    return payload;
}
export function parseCoordinatorRequestEnvelope(value) {
    const label = 'CoordinatorRequestEnvelope';
    const record = object(value, label, ['action', 'expected_version', 'fencing_generation', 'idempotency_key', 'payload', 'protocol_version', 'repo_id', 'request_id', 'schema_version', 'session_id', 'workstream_run']);
    const action = oneOf(record, 'action', [...QUERY_ACTIONS, ...MUTATION_ACTIONS], label);
    const mutation = MUTATION_ACTIONS.includes(action);
    const idempotencyKey = nullableString(record, 'idempotency_key', label, 192);
    const workstreamRun = nullablePathSegmentIdentifier(record, 'workstream_run', label);
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
        repo_id: pathSegmentIdentifier(record, 'repo_id', label),
        workstream_run: workstreamRun,
        session_id: sessionId,
        fencing_generation: fencingGeneration,
        expected_version: expectedVersion,
        payload: parsePayload(record['payload'], action),
    };
}
export function parseCoordinatorResponseEnvelope(value) {
    const label = 'CoordinatorResponseEnvelope';
    const record = object(value, label, ['committed_event_seq', 'error_code', 'ok', 'payload', 'protocol_version', 'request_id', 'retryable', 'schema_version']);
    const ok = boolean(record, 'ok', label);
    const committedEventSeq = nullableInteger(record, 'committed_event_seq', label);
    const errorCode = nullableString(record, 'error_code', label, 128);
    if (ok && errorCode !== null)
        fail(label, 'successful response cannot contain error_code');
    if (!ok && errorCode === null)
        fail(label, 'failed response requires error_code');
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
export function claimModesConflict(left, right) {
    return left !== 'READ' || right !== 'READ';
}
export function coordinationPathsOverlap(left, right) {
    const normalize = (value) => value.replace(/\/\*\*$/u, '').replace(/\/$/u, '');
    const a = normalize(left);
    const b = normalize(right);
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
