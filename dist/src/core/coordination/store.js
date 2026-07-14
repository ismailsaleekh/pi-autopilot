import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { link, mkdir, open as openFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { platform } from 'node:os';
import { backup, DatabaseSync } from 'node:sqlite';
import { claimModesConflict, coordinationPathsOverlap, parseCoordinationAcquisitionGroup, parseCoordinationAdjudicationAssignment, parseCoordinationAuthoritativeArtifact, parseCoordinationChangeReservation, parseCoordinationChildLease, parseCoordinationClaimRequest, parseCoordinationDeadlockResolution, parseCoordinationEditLease, parseCoordinationEscalation, parseCoordinationEvent, parseCoordinationMailboxCursor, parseCoordinationMessage, parseCoordinationMigrationRecoveryWork, parseCoordinationReconciliationEvidence, parseCoordinationReleaseCondition, parseCoordinationRepository, parseCoordinationRequestedLease, parseCoordinationReservationObligation, parseCoordinationRun, parseCoordinationRunResource, parseCoordinationRunTerminalIntent, parseCoordinationSessionLease, parseCoordinationUnitAttempt, parseCoordinationWaitForEdge, parseCoordinationWorktree, parseCoordinationWorktreeOperation, parseCoordinatorRequestEnvelope } from "./contracts.js";
import { buildCoordinationWaitForEdges, compareCoordinationGrantPriority, coordinationOwnerKey, detectCoordinationWaitCycles, MAX_GRANT_BYPASSES, selectCoordinationDeadlockVictim } from "./deadlock.js";
import { validateAuthoritativeCoordinationDocument, validatePlanningContradictionSubmission } from "./escalation.js";
import { CoordinationRuntimeError } from "./failures.js";
import { checkCoordinationInvariants } from "./invariants.js";
import { proveLegacyReadAttemptTerminal } from "./legacy-read-terminal.js";
import { COORDINATOR_BUSY_TIMEOUT_MS, COORDINATOR_DATABASE_SCHEMA_VERSION, COORDINATOR_GRANT_OFFER_TTL_MS, COORDINATOR_PACKAGE_BUILD, enforcePrivateAuthorityPath, enforceWindowsPrivateAcl, ensureCoordinatorPrivateRoots } from "./runtime-paths.js";
import { activeCoordinationMigrationFreeze, assertCoordinationDispatchAllowed, assertCoordinationFrozenMutationAllowed, assertCoordinationMigrationRecoveryOperationAuthorized, coordinationCutoverCommitted } from "./migration-paths.js";
import { parseRunTerminalSha, parseUnitAttemptTarget, parseUnitMergeReservationFacts, validateReconciliationEvidenceDocument, validateReservationIntegrationEvidenceDocument, validateReservationValidationArtifactChain, validateReservationValidationEvidenceDocument } from "./terminal-evidence.js";
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, COORDINATION_WORKTREE_STATES } from "./types.js";
import { assertPrivatePathNoAliases } from "../private-path.js";
const DATABASE_EXPORT_SCHEMA = 'autopilot.coordinator_export.v1';
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_COORDINATION_EVIDENCE_BYTES = 1024 * 1024;
const MAX_ADJUDICATION_BUNDLE_BYTES = 256 * 1024;
export const COORDINATOR_SEMANTIC_REPLAY_SCHEMA = 'autopilot.coordinator_semantic_replay.v1';
export const COORDINATOR_MAX_SEMANTIC_REPLAY_RECORDS = 100_000;
const COORDINATOR_MAX_SEMANTIC_REPLAY_BYTES = 128 * 1024 * 1024;
const COORDINATOR_MAX_SEMANTIC_REPLAY_LINE_BYTES = 1024 * 1024;
const COORDINATOR_SEMANTIC_REPLAY_BATCH_SIZE = 1_000;
const RUN_OWNED_IDEMPOTENCY_ACTIONS = new Set(['resolve-migration-recovery', 'register-attempt', 'acquire-group', 'acknowledge-grant', 'respond-claim-request', 'cancel-claim-request', 'cancel-acquisition-group', 'supersede-attempt', 'record-release-evidence', 'resolve-reservation-obligation', 'prepare-run-terminal', 'cancel-run-terminal', 'reconcile-run', 'prepare-operation', 'transition-operation', 'register-authoritative-artifact', 'assign-adjudication', 'claim-adjudication-assignment', 'submit-planning-contradiction']);
const TERMINAL_SESSION_ACTIONS = new Set(['resolve-migration-recovery', 'detach-session', 'heartbeat', 'drain-mailbox', 'acknowledge-message', 'record-release-evidence', 'reconcile-run', 'prepare-operation', 'transition-operation']);
const MIGRATION_RECOVERY_SESSION_ACTIONS = new Set(['resolve-migration-recovery', 'detach-session', 'heartbeat']);
const systemClock = { now: () => new Date() };
const MIGRATION_1 = `
CREATE TABLE repositories (
  repo_id TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL UNIQUE,
  canonical_root TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  event_seq INTEGER NOT NULL DEFAULT 0 CHECK(event_seq >= 0),
  created_event_seq INTEGER NOT NULL CHECK(created_event_seq >= 1),
  version INTEGER NOT NULL CHECK(version >= 1)
) STRICT;
CREATE TABLE runs (
  repo_id TEXT NOT NULL,
  autopilot_id TEXT NOT NULL,
  workstream TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  status TEXT NOT NULL,
  active_session_generation INTEGER NOT NULL DEFAULT 0 CHECK(active_session_generation >= 0),
  created_event_seq INTEGER NOT NULL CHECK(created_event_seq >= 1),
  version INTEGER NOT NULL CHECK(version >= 1),
  PRIMARY KEY(repo_id, workstream_run),
  FOREIGN KEY(repo_id) REFERENCES repositories(repo_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE session_leases (
  session_lease_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_generation INTEGER NOT NULL CHECK(session_generation >= 1),
  pid INTEGER NOT NULL CHECK(pid >= 1),
  boot_id TEXT NOT NULL,
  session_token_sha256 TEXT NOT NULL CHECK(length(session_token_sha256) = 64),
  lease_expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  attached_event_seq INTEGER NOT NULL CHECK(attached_event_seq >= 1),
  version INTEGER NOT NULL CHECK(version >= 1),
  UNIQUE(repo_id, workstream_run, session_id, session_generation),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE TABLE child_leases (
  child_lease_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  autopilot_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  pid INTEGER NOT NULL CHECK(pid >= 1),
  boot_id TEXT NOT NULL,
  child_token_sha256 TEXT NOT NULL CHECK(length(child_token_sha256) = 64),
  lease_expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  terminal_evidence_ref TEXT,
  terminal_evidence_sha256 TEXT,
  version INTEGER NOT NULL CHECK(version >= 1),
  UNIQUE(repo_id, workstream_run, unit_id, attempt),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE TABLE unit_attempts (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, workstream_run TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT) STRICT;
CREATE TABLE edit_leases (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, workstream_run TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT) STRICT;
CREATE TABLE change_reservations (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, workstream_run TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT) STRICT;
CREATE TABLE claim_requests (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, requester_workstream_run TEXT NOT NULL, owner_workstream_run TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id, requester_workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT, FOREIGN KEY(repo_id, owner_workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT) STRICT;
CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  recipient_workstream_run TEXT NOT NULL,
  message_type TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_event_seq INTEGER NOT NULL CHECK(created_event_seq >= 1),
  delivered_event_seq INTEGER,
  acknowledged_event_seq INTEGER,
  version INTEGER NOT NULL CHECK(version >= 1),
  FOREIGN KEY(repo_id, recipient_workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE TABLE worktrees (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, workstream_run TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT) STRICT;
CREATE TABLE worktree_operations (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, workstream_run TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT) STRICT;
CREATE TABLE merge_operations (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, workstream_run TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT) STRICT;
CREATE TABLE escalations (entity_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, payload_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), FOREIGN KEY(repo_id) REFERENCES repositories(repo_id) ON DELETE RESTRICT) STRICT;
CREATE TABLE handoffs (
  handoff_token TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  from_session_lease_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_event_seq INTEGER NOT NULL CHECK(created_event_seq >= 1),
  consumed_event_seq INTEGER,
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT,
  FOREIGN KEY(from_session_lease_id) REFERENCES session_leases(session_lease_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE events (
  repo_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL CHECK(event_seq >= 1),
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY(repo_id, event_seq),
  UNIQUE(repo_id, idempotency_key),
  FOREIGN KEY(repo_id) REFERENCES repositories(repo_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE idempotency_results (
  repo_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  committed_event_seq INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(repo_id, idempotency_key),
  FOREIGN KEY(repo_id) REFERENCES repositories(repo_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_sessions_run_status ON session_leases(repo_id, workstream_run, status);
CREATE INDEX idx_children_run_status ON child_leases(repo_id, workstream_run, status);
CREATE INDEX idx_messages_mailbox ON messages(repo_id, recipient_workstream_run, status, created_event_seq);
CREATE INDEX idx_events_entity ON events(repo_id, entity_type, entity_id, event_seq);
`;
const MIGRATION_2 = `
CREATE TABLE acquisition_groups (
  entity_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  PRIMARY KEY(repo_id, entity_id),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_acquisition_groups_run ON acquisition_groups(repo_id, workstream_run, entity_id);
CREATE INDEX idx_edit_leases_repo ON edit_leases(repo_id, entity_id);
CREATE INDEX idx_claim_requests_owner_status ON claim_requests(repo_id, owner_workstream_run, entity_id);
CREATE INDEX idx_claim_requests_requester_status ON claim_requests(repo_id, requester_workstream_run, entity_id);
`;
const MIGRATION_3 = `
CREATE TABLE mailbox_cursors (
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  delivered_through_event_seq INTEGER NOT NULL DEFAULT 0 CHECK(delivered_through_event_seq >= 0),
  acknowledged_through_event_seq INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged_through_event_seq >= 0),
  version INTEGER NOT NULL CHECK(version >= 1),
  PRIMARY KEY(repo_id, workstream_run),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
INSERT INTO mailbox_cursors(repo_id, workstream_run, delivered_through_event_seq, acknowledged_through_event_seq, version)
SELECT
  r.repo_id,
  r.workstream_run,
  COALESCE((SELECT MAX(m.created_event_seq) FROM messages m WHERE m.repo_id=r.repo_id AND m.recipient_workstream_run=r.workstream_run AND m.status IN ('delivered','acknowledged')), 0),
  CASE
    WHEN (SELECT MIN(m.created_event_seq) FROM messages m WHERE m.repo_id=r.repo_id AND m.recipient_workstream_run=r.workstream_run AND m.status!='acknowledged') IS NULL
      THEN COALESCE((SELECT MAX(m.created_event_seq) FROM messages m WHERE m.repo_id=r.repo_id AND m.recipient_workstream_run=r.workstream_run AND m.status='acknowledged'), 0)
    ELSE MAX(0, (SELECT MIN(m.created_event_seq) FROM messages m WHERE m.repo_id=r.repo_id AND m.recipient_workstream_run=r.workstream_run AND m.status!='acknowledged') - 1)
  END,
  1
FROM runs r;
UPDATE mailbox_cursors
SET acknowledged_through_event_seq=MIN(acknowledged_through_event_seq, delivered_through_event_seq);
CREATE TABLE reconciliation_evidence (
  entity_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  source TEXT NOT NULL,
  target_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  UNIQUE(repo_id, workstream_run, source, target_id, entity_id),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_reconciliation_evidence_condition ON reconciliation_evidence(repo_id, workstream_run, source, target_id);
CREATE INDEX idx_messages_cursor ON messages(repo_id, recipient_workstream_run, created_event_seq, message_id, status);
`;
const MIGRATION_4 = `
CREATE INDEX IF NOT EXISTS idx_worktree_operations_recovery ON worktree_operations(repo_id, workstream_run, entity_id);
CREATE INDEX IF NOT EXISTS idx_worktrees_owner ON worktrees(repo_id, workstream_run, entity_id);
`;
const MIGRATION_5 = `
ALTER TABLE runs ADD COLUMN coordination_authority TEXT NOT NULL DEFAULT 'legacy-path-claims-v1' CHECK(coordination_authority IN ('legacy-path-claims-v1','coordinator-edit-leases-v1'));
CREATE TABLE run_terminal_intents (
  entity_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_terminal_intents_open ON run_terminal_intents(repo_id, workstream_run) WHERE json_extract(payload_json, '$.state')='prepared';
CREATE TABLE reservation_obligations (
  entity_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  predecessor_reservation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  UNIQUE(repo_id, reservation_id, predecessor_reservation_id),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT,
  FOREIGN KEY(reservation_id) REFERENCES change_reservations(entity_id) ON DELETE RESTRICT,
  FOREIGN KEY(predecessor_reservation_id) REFERENCES change_reservations(entity_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_change_reservations_repo_run ON change_reservations(repo_id, workstream_run, entity_id);
CREATE INDEX IF NOT EXISTS idx_change_reservations_active_path ON change_reservations(repo_id, json_extract(payload_json, '$.released_event_seq'), json_extract(payload_json, '$.path'));
CREATE INDEX IF NOT EXISTS idx_reservation_obligations_run_state ON reservation_obligations(repo_id, workstream_run, json_extract(payload_json, '$.state'), entity_id);
CREATE INDEX IF NOT EXISTS idx_reservation_obligations_predecessor ON reservation_obligations(repo_id, predecessor_reservation_id, entity_id);
`;
const MIGRATION_6 = `
UPDATE unit_attempts SET payload_json=json_set(payload_json, '$.role', 'unknown', '$.version', version + 1), version=version+1;
UPDATE acquisition_groups SET payload_json=json_set(payload_json, '$.acquisition_kind', 'legacy-unknown', '$.version', version + 1), version=version+1;
UPDATE idempotency_results SET payload_json=json_set(payload_json, '$.acquisition_group.acquisition_kind', 'legacy-unknown', '$.acquisition_group.version', json_extract(payload_json, '$.acquisition_group.version') + 1) WHERE json_type(payload_json, '$.acquisition_group')='object' AND json_type(payload_json, '$.acquisition_group.acquisition_kind') IS NULL;
UPDATE idempotency_results SET payload_json=json_set(payload_json, '$.unit_attempt.role', 'unknown', '$.unit_attempt.version', json_extract(payload_json, '$.unit_attempt.version') + 1) WHERE json_type(payload_json, '$.unit_attempt')='object' AND json_type(payload_json, '$.unit_attempt.role') IS NULL;
CREATE TABLE wait_for_edges (
  entity_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  FOREIGN KEY(repo_id) REFERENCES repositories(repo_id) ON DELETE RESTRICT,
  FOREIGN KEY(request_id) REFERENCES claim_requests(entity_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_wait_for_edges_repo_state ON wait_for_edges(repo_id, json_extract(payload_json, '$.state'), entity_id);
CREATE TABLE deadlock_resolutions (
  entity_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  FOREIGN KEY(repo_id) REFERENCES repositories(repo_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_deadlock_resolutions_repo_state ON deadlock_resolutions(repo_id, json_extract(payload_json, '$.state'), entity_id);
CREATE TABLE authoritative_artifacts (
  entity_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  source_run TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  PRIMARY KEY(repo_id, entity_id),
  FOREIGN KEY(repo_id, source_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_authoritative_artifacts_source ON authoritative_artifacts(repo_id, source_run, entity_id);
CREATE TABLE adjudication_assignments (
  entity_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  requesting_run TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  PRIMARY KEY(repo_id, entity_id),
  FOREIGN KEY(repo_id, requesting_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_adjudication_assignments_state ON adjudication_assignments(repo_id, json_extract(payload_json, '$.state'), entity_id);
CREATE TABLE evidence_artifacts (
  entity_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  ref TEXT NOT NULL,
  label TEXT NOT NULL,
  content BLOB NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0 AND size_bytes <= 1048576),
  created_event_seq INTEGER NOT NULL CHECK(created_event_seq >= 1),
  UNIQUE(repo_id, sha256),
  FOREIGN KEY(repo_id) REFERENCES repositories(repo_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_evidence_artifacts_repo_event ON evidence_artifacts(repo_id, created_event_seq, entity_id);
`;
const MIGRATION_7 = `
CREATE TABLE run_resources (
  entity_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  UNIQUE(repo_id, workstream_run),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_run_resources_repo_run ON run_resources(repo_id, workstream_run);
CREATE TABLE coordination_migrations (
  repo_id TEXT PRIMARY KEY,
  migration_id TEXT NOT NULL UNIQUE,
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256) = 71),
  journal_path TEXT NOT NULL,
  state TEXT NOT NULL,
  report_json TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  FOREIGN KEY(repo_id) REFERENCES repositories(repo_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE migration_recovery_work (
  entity_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  recovery_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','resolved')),
  created_event_seq INTEGER NOT NULL CHECK(created_event_seq >= 1),
  version INTEGER NOT NULL CHECK(version >= 1),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_migration_recovery_run_status ON migration_recovery_work(repo_id, workstream_run, status, entity_id);
CREATE TABLE migration_legacy_audit (
  entity_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_event_seq INTEGER NOT NULL CHECK(created_event_seq >= 1),
  FOREIGN KEY(repo_id) REFERENCES repositories(repo_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_migration_legacy_audit_repo_source ON migration_legacy_audit(repo_id, source_kind, entity_id);
`;
const MIGRATION_8 = `
ALTER TABLE session_leases ADD COLUMN attachment_kind TEXT NOT NULL DEFAULT 'dispatch' CHECK(attachment_kind IN ('dispatch','terminal-recovery','migration-recovery'));
ALTER TABLE migration_recovery_work ADD COLUMN resolution_json TEXT;
ALTER TABLE migration_recovery_work ADD COLUMN resolved_event_seq INTEGER CHECK(resolved_event_seq IS NULL OR resolved_event_seq >= 1);
UPDATE idempotency_results
SET payload_json=json_set(
  payload_json,
  '$.session.schema_version', 'autopilot.session_lease.v2',
  '$.session.attachment_kind', CASE WHEN json_extract(payload_json, '$.event_type')='terminal-cleanup-recovery-attached' THEN 'terminal-recovery' ELSE 'dispatch' END
)
WHERE json_type(payload_json, '$.session')='object';
`;
const MIGRATION_9 = `
CREATE TABLE semantic_replays (
  replay_id TEXT PRIMARY KEY,
  record_count INTEGER NOT NULL CHECK(record_count >= 1 AND record_count <= 100000),
  records_sha256 TEXT NOT NULL CHECK(length(records_sha256) = 71),
  applied_at TEXT NOT NULL
) STRICT;
`;
export const COORDINATOR_SCHEMA_MIGRATION_CHECKSUMS = Object.freeze([MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8, MIGRATION_9].map((sql) => createHash('sha256').update(sql, 'utf8').digest('hex')));
function asRow(value, label) {
    if (value === undefined)
        throw new CoordinationRuntimeError('invalid-state', `${label} row is missing`);
    return value;
}
function sqlString(row, field) {
    const value = row[field];
    if (typeof value !== 'string')
        throw new CoordinationRuntimeError('store-corrupt', `database field ${field} is not text`);
    return value;
}
function sqlNullableString(row, field) {
    const value = row[field];
    if (value === null)
        return null;
    if (typeof value !== 'string')
        throw new CoordinationRuntimeError('store-corrupt', `database field ${field} is not nullable text`);
    return value;
}
function sqlInteger(row, field) {
    const value = row[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value))
        throw new CoordinationRuntimeError('store-corrupt', `database field ${field} is not a safe integer`);
    return value;
}
function sqlNullableInteger(row, field) {
    return row[field] === null ? null : sqlInteger(row, field);
}
function payloadString(payload, field) {
    const value = payload[field];
    if (typeof value !== 'string')
        throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be text`);
    return value;
}
function payloadNullableString(payload, field) {
    const value = payload[field];
    if (value === null)
        return null;
    if (typeof value !== 'string')
        throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be nullable text`);
    return value;
}
function payloadInteger(payload, field) {
    const value = payload[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value))
        throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be an integer`);
    return value;
}
function payloadAcquisitionKind(payload, field) {
    const value = payloadString(payload, field);
    if (value === 'initial' || value === 'materialization-read-expansion')
        return value;
    throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be a supported acquisition kind`);
}
function payloadUnitRole(payload, field) {
    const value = payloadString(payload, field);
    switch (value) {
        case 'strategy':
        case 'implement':
        case 'validate':
        case 'fix':
        case 'adjudicate':
        case 'bughunt':
        case 'extract': return value;
        default: throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be a supported unit role`);
    }
}
function payloadBoolean(payload, field) {
    const value = payload[field];
    if (typeof value !== 'boolean')
        throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be boolean`);
    return value;
}
function payloadRequestedLeases(payload) {
    const value = payload['requested_leases'];
    if (!Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-request', 'payload field requested_leases must be an array');
    return Object.freeze(value.map((entry, index) => parseCoordinationRequestedLease(entry, `requested_leases[${String(index)}]`)));
}
function payloadReleaseCondition(payload, field) {
    return parseCoordinationReleaseCondition(payload[field], `payload.${field}`);
}
function ownerIdentityKey(owner) {
    return `${owner.repo_id}\0${owner.autopilot_id}\0${owner.workstream_run}\0${owner.unit_id}\0${String(owner.attempt)}`;
}
function sameOwner(left, right) {
    return ownerIdentityKey(left) === ownerIdentityKey(right);
}
function leaseCoversPath(leasePath, changedPath) {
    const base = leasePath.replace(/\/\*\*$/u, '').replace(/\/$/u, '');
    return changedPath === base || changedPath.startsWith(`${base}/`);
}
function unitAttemptEntityId(owner) {
    return `attempt-${createHash('sha256').update(ownerIdentityKey(owner), 'utf8').digest('hex')}`;
}
function stableEntityId(prefix, parts) {
    return `${prefix}-${createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex')}`;
}
function canonicalJson(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
    if (typeof value !== 'object')
        throw new CoordinationRuntimeError('invalid-request', 'request contains a non-JSON value');
    const entries = Object.entries(value).sort((left, right) => left[0].localeCompare(right[0]));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}
function isCanonicalIsoTimestamp(value) {
    if (typeof value !== 'string' || value.length !== 24)
        return false;
    try {
        return new Date(value).toISOString() === value;
    }
    catch {
        return false;
    }
}
function parseSemanticReplayRequest(value, label) {
    let request;
    try {
        request = parseCoordinatorRequestEnvelope(value);
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-request', `${label} is not a valid coordinator request`, [error instanceof Error ? error.message : String(error)]);
    }
    if (request.protocol_version !== AUTOPILOT_COORDINATOR_PROTOCOL_VERSION)
        throw new CoordinationRuntimeError('protocol-mismatch', `${label} must use the current coordinator protocol`);
    if (request.action === 'status' || request.action === 'doctor' || request.action === 'export' || request.idempotency_key === null)
        throw new CoordinationRuntimeError('invalid-request', `${label} must be an idempotent semantic mutation`);
    return request;
}
function parseSemanticReplayRecord(value, label) {
    return parseSemanticReplayRequest(value, label);
}
function parseSemanticReplayLine(line, label) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-request', `${label} is not valid JSON`, [error instanceof Error ? error.message : String(error)]);
    }
    if (canonicalJson(value) !== line)
        throw new CoordinationRuntimeError('invalid-request', `${label} must be canonical JSON without duplicate or reordered fields`);
    return parseSemanticReplayRecord(value, label);
}
function parseValidatedSemanticReplayLine(line, label) {
    try {
        return parseSemanticReplayRecord(JSON.parse(line), label);
    }
    catch (error) {
        throw new CoordinationRuntimeError('store-corrupt', `${label} changed after canonical contract staging`, [error instanceof Error ? error.message : String(error)]);
    }
}
function parseSemanticReplayHeader(line) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-request', 'semantic replay header is not valid JSON', [error instanceof Error ? error.message : String(error)]);
    }
    if (canonicalJson(value) !== line || typeof value !== 'object' || value === null || Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-request', 'semantic replay header must be a canonical object');
    const record = value;
    const fields = Object.keys(record).sort();
    if (fields.join(',') !== 'record_count,records_sha256,replay_id,schema_version')
        throw new CoordinationRuntimeError('invalid-request', 'semantic replay header fields are closed');
    const replayId = record['replay_id'];
    const count = record['record_count'];
    const sha256 = record['records_sha256'];
    if (record['schema_version'] !== COORDINATOR_SEMANTIC_REPLAY_SCHEMA || typeof replayId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(replayId) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > COORDINATOR_MAX_SEMANTIC_REPLAY_RECORDS || typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256))
        throw new CoordinationRuntimeError('invalid-request', 'semantic replay header identity, count, or digest is invalid');
    return { schema_version: COORDINATOR_SEMANTIC_REPLAY_SCHEMA, replay_id: replayId, record_count: count, records_sha256: sha256 };
}
function semanticReplayReceiptPath(paths, replayId) {
    return join(paths.semanticReplayReceiptsRoot, `${replayId}.json`);
}
function parseSemanticReplayReceipt(text, path) {
    const line = text.endsWith('\n') ? text.slice(0, -1) : text;
    if (line.length === 0 || line.includes('\n'))
        throw new CoordinationRuntimeError('invalid-state', 'semantic replay receipt must contain exactly one JSON record', [path]);
    let value;
    try {
        value = JSON.parse(line);
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-state', 'semantic replay receipt is not valid JSON', [path, error instanceof Error ? error.message : String(error)]);
    }
    if (canonicalJson(value) !== line || typeof value !== 'object' || value === null || Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-state', 'semantic replay receipt must be a canonical object', [path]);
    const record = value;
    if (Object.keys(record).sort().join(',') !== 'applied_at,record_count,records_sha256,replay_id,schema_version')
        throw new CoordinationRuntimeError('invalid-state', 'semantic replay receipt fields are closed', [path]);
    const replayId = record['replay_id'];
    const count = record['record_count'];
    const sha256 = record['records_sha256'];
    const appliedAt = record['applied_at'];
    if (record['schema_version'] !== 'autopilot.coordinator_semantic_replay_receipt.v1' || typeof replayId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(replayId) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > COORDINATOR_MAX_SEMANTIC_REPLAY_RECORDS || typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256) || !isCanonicalIsoTimestamp(appliedAt))
        throw new CoordinationRuntimeError('invalid-state', 'semantic replay receipt identity, count, digest, or timestamp is invalid', [path]);
    return { schema_version: 'autopilot.coordinator_semantic_replay_receipt.v1', replay_id: replayId, record_count: count, records_sha256: sha256, applied_at: appliedAt };
}
function sameSemanticReplayIdentity(receipt, header) {
    return receipt.replay_id === header.replay_id && receipt.record_count === header.record_count && receipt.records_sha256 === header.records_sha256;
}
function syncParentDirectory(path) {
    if (platform() === 'win32')
        return;
    const descriptor = openSync(dirname(path), fsConstants.O_RDONLY);
    try {
        fsyncSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
}
function assertPrivateDirectory(path, label) {
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new CoordinationRuntimeError('permission-denied', `${label} must be a real directory, not a symlink or junction`, [path]);
}
async function ensureSemanticReplayRoots(paths) {
    // This producer is also called directly by the CLI, before server startup.
    // Use the shared authority primitive first: on Windows it installs the
    // protected user-only root DACL before a descendant mkdir/open can inherit
    // an operator override's permissive ACL.
    await ensureCoordinatorPrivateRoots(paths);
    assertPrivateDirectory(paths.stateRoot, 'Autopilot state root');
    for (const path of [paths.coordinatorRoot, paths.semanticReplayReceiptsRoot]) {
        const relativePath = relative(paths.stateRoot, path);
        if (relativePath.length === 0 || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
            throw new CoordinationRuntimeError('permission-denied', 'semantic replay path escapes the Autopilot state root', [path]);
        let current = paths.stateRoot;
        for (const component of relativePath.split(sep)) {
            current = join(current, component);
            assertPrivateDirectory(current, 'semantic replay path ancestor');
        }
    }
    const realStateRoot = realpathSync(paths.stateRoot);
    for (const path of [paths.coordinatorRoot, paths.semanticReplayReceiptsRoot]) {
        const physical = realpathSync(path);
        const physicalRelative = relative(realStateRoot, physical);
        if (physicalRelative === '..' || physicalRelative.startsWith(`..${sep}`) || isAbsolute(physicalRelative))
            throw new CoordinationRuntimeError('permission-denied', 'semantic replay path physically escapes the Autopilot state root', [path]);
    }
}
function replayFileIdentity(descriptor) {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > COORDINATOR_MAX_SEMANTIC_REPLAY_BYTES)
        throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus must be a bounded regular file');
    return { dev: metadata.dev, ino: metadata.ino, size: metadata.size, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs };
}
function sameReplayFileIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
async function* semanticReplayLines(path, descriptor) {
    const stream = descriptor === undefined ? createReadStream(path, { encoding: 'utf8' }) : null;
    async function* chunks() {
        if (stream !== null) {
            for await (const chunk of stream)
                yield chunk;
            return;
        }
        if (descriptor === undefined)
            return;
        const bytes = Buffer.allocUnsafe(1024 * 1024);
        const decoder = new TextDecoder('utf-8', { fatal: true });
        for (;;) {
            const count = readSync(descriptor, bytes, 0, bytes.length, null);
            if (count === 0)
                break;
            yield decoder.decode(bytes.subarray(0, count), { stream: true });
        }
        const tail = decoder.decode();
        if (tail.length > 0)
            yield tail;
    }
    let buffered = '';
    try {
        for await (const chunk of chunks()) {
            buffered += chunk;
            for (;;) {
                const newline = buffered.indexOf('\n');
                if (newline < 0)
                    break;
                const line = buffered.slice(0, newline);
                buffered = buffered.slice(newline + 1);
                if (Buffer.byteLength(line, 'utf8') > COORDINATOR_MAX_SEMANTIC_REPLAY_LINE_BYTES)
                    throw new CoordinationRuntimeError('invalid-request', 'semantic replay record exceeds its per-record byte bound');
                yield line;
            }
            if (Buffer.byteLength(buffered, 'utf8') > COORDINATOR_MAX_SEMANTIC_REPLAY_LINE_BYTES)
                throw new CoordinationRuntimeError('invalid-request', 'semantic replay record exceeds its per-record byte bound');
        }
        if (buffered.length > 0)
            throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus must end with a newline');
    }
    finally {
        stream?.destroy();
    }
}
export async function stageCoordinatorSemanticReplay(paths, replayId, records) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(replayId))
        throw new CoordinationRuntimeError('invalid-request', 'semantic replay id is invalid');
    await ensureSemanticReplayRoots(paths);
    if (existsSync(paths.semanticReplayPath))
        throw new CoordinationRuntimeError('invalid-state', 'a semantic replay corpus is already pending', [paths.semanticReplayPath]);
    const suffix = `${String(process.pid)}.${Date.now().toString(16)}`;
    const bodyPath = `${paths.semanticReplayPath}.${suffix}.body`;
    const candidatePath = `${paths.semanticReplayPath}.${suffix}.candidate`;
    let body = null;
    let candidate = null;
    try {
        body = await openFile(bodyPath, 'wx', 0o600);
        await enforcePrivateAuthorityPath(bodyPath, false);
        const hash = createHash('sha256');
        let count = 0;
        let bytes = 0;
        let buffered = '';
        let bufferedBytes = 0;
        for await (const input of records) {
            const record = parseSemanticReplayRecord(input, `semantic replay record ${String(count + 1)}`);
            const line = `${canonicalJson(record)}\n`;
            count += 1;
            const lineBytes = Buffer.byteLength(line, 'utf8');
            bytes += lineBytes;
            if (lineBytes > COORDINATOR_MAX_SEMANTIC_REPLAY_LINE_BYTES || count > COORDINATOR_MAX_SEMANTIC_REPLAY_RECORDS || bytes > COORDINATOR_MAX_SEMANTIC_REPLAY_BYTES)
                throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus exceeds its record or byte bound');
            hash.update(line, 'utf8');
            buffered += line;
            bufferedBytes += lineBytes;
            if (bufferedBytes >= 1024 * 1024) {
                await body.writeFile(buffered, 'utf8');
                buffered = '';
                bufferedBytes = 0;
            }
        }
        if (buffered.length > 0)
            await body.writeFile(buffered, 'utf8');
        if (count === 0)
            throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus must not be empty');
        await body.sync();
        const recordsSha256 = `sha256:${hash.digest('hex')}`;
        const header = { schema_version: COORDINATOR_SEMANTIC_REPLAY_SCHEMA, replay_id: replayId, record_count: count, records_sha256: recordsSha256 };
        const headerLine = `${canonicalJson(header)}\n`;
        if (bytes + Buffer.byteLength(headerLine, 'utf8') > COORDINATOR_MAX_SEMANTIC_REPLAY_BYTES)
            throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus exceeds its total byte bound');
        candidate = await openFile(candidatePath, 'wx', 0o600);
        await enforcePrivateAuthorityPath(candidatePath, false);
        await candidate.writeFile(headerLine, 'utf8');
        const source = await openFile(bodyPath, 'r');
        try {
            const buffer = Buffer.allocUnsafe(1024 * 1024);
            for (;;) {
                const read = await source.read(buffer, 0, buffer.length, null);
                if (read.bytesRead === 0)
                    break;
                await candidate.write(buffer.subarray(0, read.bytesRead));
            }
        }
        finally {
            await source.close();
        }
        await candidate.sync();
        await candidate.close();
        candidate = null;
        await body.close();
        body = null;
        try {
            await link(candidatePath, paths.semanticReplayPath);
            // The hard link inherits the already-private file object, but enforce and
            // verify the final authority name explicitly before publishing durability.
            await enforcePrivateAuthorityPath(paths.semanticReplayPath, false);
            syncParentDirectory(paths.semanticReplayPath);
        }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
                throw new CoordinationRuntimeError('invalid-state', 'a semantic replay corpus became pending during staging', [paths.semanticReplayPath]);
            throw error;
        }
        await unlink(candidatePath);
        await unlink(bodyPath);
        return { record_count: count, records_sha256: recordsSha256 };
    }
    catch (error) {
        if (candidate !== null)
            await candidate.close().catch(() => undefined);
        if (body !== null)
            await body.close().catch(() => undefined);
        await unlink(candidatePath).catch(() => undefined);
        await unlink(bodyPath).catch(() => undefined);
        throw error;
    }
}
/** Stages operator-supplied canonical request JSONL through the same bounded
 * production producer used by startup recovery. The source is opened once and
 * must remain the same regular file for the complete staging pass. */
export async function stageCoordinatorSemanticReplayFile(paths, replayId, inputPath) {
    const sourcePath = resolve(inputPath);
    const metadata = lstatSync(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > COORDINATOR_MAX_SEMANTIC_REPLAY_BYTES)
        throw new CoordinationRuntimeError('invalid-request', 'semantic replay source must be a bounded regular non-symbolic file', [sourcePath]);
    const descriptor = openSync(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = replayFileIdentity(descriptor);
    async function* records() {
        for await (const line of semanticReplayLines(sourcePath, descriptor))
            yield parseSemanticReplayLine(line, 'operator semantic replay record');
        if (!sameReplayFileIdentity(before, replayFileIdentity(descriptor)))
            throw new CoordinationRuntimeError('invalid-request', 'semantic replay source changed while it was staged', [sourcePath]);
    }
    try {
        return await stageCoordinatorSemanticReplay(paths, replayId, records());
    }
    finally {
        closeSync(descriptor);
    }
}
function requestDigest(request) {
    const runOwnedIdempotency = RUN_OWNED_IDEMPOTENCY_ACTIONS.has(request.action);
    const payload = Object.fromEntries(Object.entries(request.payload).filter(([field]) => field !== 'migration_operation_token' && (!runOwnedIdempotency || field !== 'session_lease_id' && field !== 'session_token')));
    const semantic = {
        schema_version: request.schema_version,
        protocol_version: request.protocol_version,
        action: request.action,
        repo_id: request.repo_id,
        workstream_run: request.workstream_run,
        session_id: runOwnedIdempotency ? null : request.session_id,
        fencing_generation: runOwnedIdempotency ? null : request.fencing_generation,
        expected_version: runOwnedIdempotency ? null : request.expected_version,
        payload,
    };
    return `sha256:${createHash('sha256').update(canonicalJson(semantic), 'utf8').digest('hex')}`;
}
function parseJsonObject(text, label) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        throw new CoordinationRuntimeError('store-corrupt', `${label} contains invalid JSON`, [error instanceof Error ? error.message : String(error)]);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new CoordinationRuntimeError('store-corrupt', `${label} is not an object`);
    return value;
}
function repositoryFromRow(row) {
    return parseCoordinationRepository({
        schema_version: 'autopilot.coordination_repository.v1',
        repo_id: sqlString(row, 'repo_id'),
        repo_key: sqlString(row, 'repo_key'),
        canonical_root: sqlString(row, 'canonical_root'),
        git_common_dir: sqlString(row, 'git_common_dir'),
        created_event_seq: sqlInteger(row, 'created_event_seq'),
        version: sqlInteger(row, 'version'),
    });
}
function runFromRow(row) {
    return parseCoordinationRun({
        schema_version: 'autopilot.coordination_run.v1',
        repo_id: sqlString(row, 'repo_id'),
        autopilot_id: sqlString(row, 'autopilot_id'),
        workstream: sqlString(row, 'workstream'),
        workstream_run: sqlString(row, 'workstream_run'),
        coordination_authority: sqlString(row, 'coordination_authority'),
        status: sqlString(row, 'status'),
        active_session_generation: sqlInteger(row, 'active_session_generation'),
        created_event_seq: sqlInteger(row, 'created_event_seq'),
        version: sqlInteger(row, 'version'),
    });
}
function runResourceFromRow(row) {
    return parseCoordinationRunResource(parseJsonObject(sqlString(row, 'payload_json'), 'run resource'));
}
function sessionFromRow(row) {
    return parseCoordinationSessionLease({
        schema_version: 'autopilot.session_lease.v2',
        session_lease_id: sqlString(row, 'session_lease_id'),
        repo_id: sqlString(row, 'repo_id'),
        workstream_run: sqlString(row, 'workstream_run'),
        session_id: sqlString(row, 'session_id'),
        session_generation: sqlInteger(row, 'session_generation'),
        pid: sqlInteger(row, 'pid'),
        boot_id: sqlString(row, 'boot_id'),
        lease_expires_at: sqlString(row, 'lease_expires_at'),
        attachment_kind: sqlString(row, 'attachment_kind'),
        status: sqlString(row, 'status'),
        attached_event_seq: sqlInteger(row, 'attached_event_seq'),
        version: sqlInteger(row, 'version'),
    });
}
function childFromRow(row) {
    const evidenceRef = sqlNullableString(row, 'terminal_evidence_ref');
    const evidenceSha = sqlNullableString(row, 'terminal_evidence_sha256');
    return parseCoordinationChildLease({
        schema_version: 'autopilot.child_lease.v1',
        child_lease_id: sqlString(row, 'child_lease_id'),
        owner: {
            repo_id: sqlString(row, 'repo_id'),
            autopilot_id: sqlString(row, 'autopilot_id'),
            workstream_run: sqlString(row, 'workstream_run'),
            unit_id: sqlString(row, 'unit_id'),
            attempt: sqlInteger(row, 'attempt'),
        },
        pid: sqlInteger(row, 'pid'),
        boot_id: sqlString(row, 'boot_id'),
        lease_expires_at: sqlString(row, 'lease_expires_at'),
        status: sqlString(row, 'status'),
        terminal_evidence: evidenceRef === null || evidenceSha === null ? null : { ref: evidenceRef, sha256: evidenceSha },
        version: sqlInteger(row, 'version'),
    });
}
function entityFromRow(row, parser, label) {
    const parsed = parser(parseJsonObject(sqlString(row, 'payload_json'), label));
    const version = sqlInteger(row, 'version');
    if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== version)
        throw new CoordinationRuntimeError('store-corrupt', `${label} payload version disagrees with its indexed row`);
    return parsed;
}
function acquisitionGroupFromRow(row) {
    return entityFromRow(row, parseCoordinationAcquisitionGroup, 'acquisition group');
}
function editLeaseFromRow(row) {
    return entityFromRow(row, parseCoordinationEditLease, 'edit lease');
}
function changeReservationFromRow(row) {
    return entityFromRow(row, parseCoordinationChangeReservation, 'change reservation');
}
function reservationObligationFromRow(row) {
    return entityFromRow(row, parseCoordinationReservationObligation, 'reservation obligation');
}
function runTerminalIntentFromRow(row) {
    return entityFromRow(row, parseCoordinationRunTerminalIntent, 'run terminal intent');
}
function claimRequestFromRow(row) {
    return entityFromRow(row, parseCoordinationClaimRequest, 'claim request');
}
function unitAttemptFromRow(row) {
    return entityFromRow(row, parseCoordinationUnitAttempt, 'unit attempt');
}
function worktreeFromRow(row) {
    return entityFromRow(row, parseCoordinationWorktree, 'worktree');
}
function worktreeOperationFromRow(row) {
    return entityFromRow(row, parseCoordinationWorktreeOperation, 'worktree operation');
}
function waitForEdgeFromRow(row) {
    return entityFromRow(row, parseCoordinationWaitForEdge, 'wait-for edge');
}
function deadlockResolutionFromRow(row) {
    return entityFromRow(row, parseCoordinationDeadlockResolution, 'deadlock resolution');
}
function authoritativeArtifactFromRow(row) {
    return entityFromRow(row, parseCoordinationAuthoritativeArtifact, 'authoritative artifact');
}
function adjudicationAssignmentFromRow(row) {
    return entityFromRow(row, parseCoordinationAdjudicationAssignment, 'adjudication assignment');
}
function escalationFromRow(row) {
    return entityFromRow(row, parseCoordinationEscalation, 'planning contradiction');
}
function mailboxCursorFromRow(row) {
    return parseCoordinationMailboxCursor({
        schema_version: 'autopilot.mailbox_cursor.v1',
        repo_id: sqlString(row, 'repo_id'),
        workstream_run: sqlString(row, 'workstream_run'),
        delivered_through_event_seq: sqlInteger(row, 'delivered_through_event_seq'),
        acknowledged_through_event_seq: sqlInteger(row, 'acknowledged_through_event_seq'),
        version: sqlInteger(row, 'version'),
    });
}
function reconciliationEvidenceFromRow(row) {
    return entityFromRow(row, parseCoordinationReconciliationEvidence, 'reconciliation evidence');
}
function messageFromRow(row) {
    return parseCoordinationMessage({
        schema_version: 'autopilot.coordination_message.v1',
        message_id: sqlString(row, 'message_id'),
        repo_id: sqlString(row, 'repo_id'),
        recipient_workstream_run: sqlString(row, 'recipient_workstream_run'),
        message_type: sqlString(row, 'message_type'),
        correlation_id: sqlString(row, 'correlation_id'),
        payload: parseJsonObject(sqlString(row, 'payload_json'), 'message payload'),
        status: sqlString(row, 'status'),
        created_event_seq: sqlInteger(row, 'created_event_seq'),
        delivered_event_seq: row['delivered_event_seq'] === null ? null : sqlInteger(row, 'delivered_event_seq'),
        acknowledged_event_seq: row['acknowledged_event_seq'] === null ? null : sqlInteger(row, 'acknowledged_event_seq'),
        version: sqlInteger(row, 'version'),
    });
}
function eventFromRow(row) {
    return parseCoordinationEvent({
        schema_version: 'autopilot.coordination_event.v1',
        repo_id: sqlString(row, 'repo_id'),
        event_seq: sqlInteger(row, 'event_seq'),
        event_type: sqlString(row, 'event_type'),
        entity_type: sqlString(row, 'entity_type'),
        entity_id: sqlString(row, 'entity_id'),
        idempotency_key: sqlString(row, 'idempotency_key'),
        request_sha256: sqlString(row, 'request_sha256'),
        occurred_at: sqlString(row, 'occurred_at'),
    });
}
function migrationRecordFromRow(row) {
    return Object.freeze({
        schema_version: 'autopilot.coordination_migration_record.v1',
        repo_id: sqlString(row, 'repo_id'),
        migration_id: sqlString(row, 'migration_id'),
        snapshot_sha256: sqlString(row, 'snapshot_sha256'),
        journal_path: sqlString(row, 'journal_path'),
        state: sqlString(row, 'state'),
        report: parseJsonObject(sqlString(row, 'report_json'), 'migration report'),
        imported_at: sqlString(row, 'imported_at'),
        updated_at: sqlString(row, 'updated_at'),
        version: sqlInteger(row, 'version'),
    });
}
function migrationRecoveryFromRow(row) {
    const resolutionJson = sqlNullableString(row, 'resolution_json');
    return parseCoordinationMigrationRecoveryWork({
        schema_version: 'autopilot.migration_recovery_work.v2',
        recovery_id: sqlString(row, 'entity_id'),
        repo_id: sqlString(row, 'repo_id'),
        workstream_run: sqlString(row, 'workstream_run'),
        recovery_type: sqlString(row, 'recovery_type'),
        detail: parseJsonObject(sqlString(row, 'payload_json'), 'migration recovery detail'),
        status: sqlString(row, 'status'),
        resolution: resolutionJson === null ? null : parseJsonObject(resolutionJson, 'migration recovery resolution'),
        created_event_seq: sqlInteger(row, 'created_event_seq'),
        resolved_event_seq: sqlNullableInteger(row, 'resolved_event_seq'),
        version: sqlInteger(row, 'version'),
    });
}
function integrityResult(db) {
    const row = asRow(db.prepare('PRAGMA integrity_check').get(), 'integrity_check');
    const value = row['integrity_check'];
    if (typeof value !== 'string')
        throw new CoordinationRuntimeError('store-corrupt', 'integrity check returned an invalid result');
    return value;
}
function migrationRecoveryCoversRetainedAuthority(db, repoId, finding) {
    const pendingLeaseIds = (workstreamRun) => new Set(db.prepare("SELECT payload_json FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND recovery_type='ambiguous-live-claim' AND status='pending' ORDER BY entity_id").all(repoId, workstreamRun).map((row) => {
        const detail = parseJsonObject(sqlString(row, 'payload_json'), 'pending migration recovery detail');
        const leaseId = detail['edit_lease_id'];
        if (typeof leaseId !== 'string')
            throw new CoordinationRuntimeError('store-corrupt', 'pending migration recovery lacks an exact edit lease identity');
        return leaseId;
    }));
    if (finding.code === 'terminal-attempt-retains-edit-lease') {
        const row = db.prepare('SELECT workstream_run FROM edit_leases WHERE repo_id=? AND entity_id=?').get(repoId, finding.entity);
        return row !== undefined && pendingLeaseIds(sqlString(row, 'workstream_run')).has(finding.entity);
    }
    if (finding.code === 'terminal-run-retains-edit-leases') {
        const actual = db.prepare('SELECT entity_id FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, finding.entity).map((row) => sqlString(row, 'entity_id'));
        const covered = pendingLeaseIds(finding.entity);
        return actual.length > 0 && actual.every((leaseId) => covered.has(leaseId));
    }
    return false;
}
function sqliteFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/busy|locked/u.test(message.toLowerCase()))
        return new CoordinationRuntimeError('coordinator-contention', message);
    if (/readonly|permission|access/u.test(message.toLowerCase()))
        return new CoordinationRuntimeError('permission-denied', message);
    if (/disk|full|i\/o/u.test(message.toLowerCase()))
        return new CoordinationRuntimeError('disk-failure', message);
    if (/malformed|not a database|corrupt/u.test(message.toLowerCase()))
        return new CoordinationRuntimeError('store-corrupt', message);
    return new CoordinationRuntimeError('invalid-state', message);
}
export class CoordinatorStore {
    #db;
    #clock;
    #stateRoot;
    #lastBackupPath;
    #lastStartupReconciliation = null;
    #semanticReplayTransactionActive = false;
    #semanticReplayGraphlessRepositories = new Set();
    #onSemanticReplayBoundary;
    #idempotencyLookup;
    #insertEvent;
    #insertIdempotencyResult;
    #incrementRepositorySequence;
    #runByIdentity;
    #attachedSessionByIdentity;
    #sessionByLeaseId;
    #pendingMigrationRecoveryByRun;
    #updateSessionHeartbeat;
    constructor(db, clock, stateRoot, lastBackupPath, options) {
        this.#db = db;
        this.#clock = clock;
        this.#stateRoot = stateRoot;
        this.#lastBackupPath = lastBackupPath;
        this.#onSemanticReplayBoundary = options.onSemanticReplayBoundary;
        this.#idempotencyLookup = db.prepare('SELECT request_sha256, committed_event_seq, payload_json FROM idempotency_results WHERE repo_id=? AND idempotency_key=?');
        this.#insertEvent = db.prepare('INSERT INTO events(repo_id, event_seq, event_type, entity_type, entity_id, idempotency_key, request_sha256, occurred_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)');
        this.#insertIdempotencyResult = db.prepare('INSERT INTO idempotency_results(repo_id, idempotency_key, request_sha256, committed_event_seq, payload_json) VALUES(?, ?, ?, ?, ?)');
        this.#incrementRepositorySequence = db.prepare('UPDATE repositories SET event_seq=event_seq+1 WHERE repo_id=? RETURNING event_seq');
        this.#runByIdentity = db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?');
        this.#attachedSessionByIdentity = db.prepare("SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? AND session_id=? AND session_generation=? AND status='attached'");
        this.#sessionByLeaseId = db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?');
        this.#pendingMigrationRecoveryByRun = db.prepare("SELECT * FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND status='pending' ORDER BY entity_id");
        this.#updateSessionHeartbeat = db.prepare('UPDATE session_leases SET lease_expires_at=?, version=version+1 WHERE session_lease_id=?');
    }
    static async open(paths, clock = systemClock, options = {}) {
        try {
            await ensureCoordinatorPrivateRoots(paths);
            await ensureSemanticReplayRoots(paths);
            await mkdir(paths.backupsRoot, { recursive: true, mode: 0o700 });
            assertPrivateDirectory(paths.backupsRoot, 'coordinator backups root');
        }
        catch (error) {
            throw sqliteFailure(error);
        }
        let existed;
        try {
            assertPrivatePathNoAliases(paths.databasePath);
            existed = existsSync(paths.databasePath) && statSync(paths.databasePath).size > 0;
        }
        catch (error) {
            throw sqliteFailure(error);
        }
        let db;
        try {
            db = new DatabaseSync(paths.databasePath, { timeout: COORDINATOR_BUSY_TIMEOUT_MS, enableForeignKeyConstraints: true });
        }
        catch (error) {
            throw sqliteFailure(error);
        }
        let lastBackupPath = null;
        try {
            db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE; PRAGMA busy_timeout=${String(COORDINATOR_BUSY_TIMEOUT_MS)}; PRAGMA trusted_schema=OFF;`);
            if (integrityResult(db) !== 'ok')
                throw new CoordinationRuntimeError('store-corrupt', 'coordinator database failed startup integrity check');
            const versionRow = asRow(db.prepare('PRAGMA user_version').get(), 'user_version');
            const currentVersion = sqlInteger(versionRow, 'user_version');
            if (currentVersion > COORDINATOR_DATABASE_SCHEMA_VERSION)
                throw new CoordinationRuntimeError('schema-mismatch', `database schema ${String(currentVersion)} is newer than supported schema ${String(COORDINATOR_DATABASE_SCHEMA_VERSION)}`);
            if (currentVersion === 6 && existed && options.allowExistingSchemaMigration !== true)
                throw new CoordinationRuntimeError('schema-mismatch', 'existing predecessor schema 6 requires the private verified migration path; in-place server migration is forbidden');
            if (currentVersion < COORDINATOR_DATABASE_SCHEMA_VERSION && existed) {
                const stamp = clock.now().toISOString().replace(/[-:.]/gu, '');
                lastBackupPath = join(paths.backupsRoot, `coordinator.pre-v${String(currentVersion)}.${stamp}.db`);
                await backup(db, lastBackupPath);
                await enforcePrivateAuthorityPath(lastBackupPath, false);
                const backupDb = new DatabaseSync(lastBackupPath, { readOnly: true });
                try {
                    if (integrityResult(backupDb) !== 'ok')
                        throw new CoordinationRuntimeError('store-corrupt', 'pre-migration backup failed integrity verification');
                }
                finally {
                    backupDb.close();
                }
            }
            const migrations = [
                { version: 1, sql: MIGRATION_1 },
                { version: 2, sql: MIGRATION_2 },
                { version: 3, sql: MIGRATION_3 },
                { version: 4, sql: MIGRATION_4 },
                { version: 5, sql: MIGRATION_5 },
                { version: 6, sql: MIGRATION_6 },
                { version: 7, sql: MIGRATION_7 },
                { version: 8, sql: MIGRATION_8 },
                { version: 9, sql: MIGRATION_9 },
            ];
            for (const migration of migrations) {
                if (currentVersion >= migration.version)
                    continue;
                const checksum = createHash('sha256').update(migration.sql, 'utf8').digest('hex');
                db.exec('BEGIN IMMEDIATE');
                try {
                    db.exec(migration.sql);
                    db.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(?, ?, ?)').run(migration.version, checksum, clock.now().toISOString());
                    db.exec(`PRAGMA user_version=${String(migration.version)}`);
                    db.exec('COMMIT');
                }
                catch (error) {
                    db.exec('ROLLBACK');
                    throw error;
                }
            }
            for (const migration of migrations) {
                let migrationRow;
                try {
                    migrationRow = db.prepare('SELECT version, checksum FROM schema_migrations WHERE version=?').get(migration.version);
                }
                catch (error) {
                    throw new CoordinationRuntimeError('schema-mismatch', 'coordinator migration journal is unavailable', [error instanceof Error ? error.message : String(error)]);
                }
                const expectedChecksum = createHash('sha256').update(migration.sql, 'utf8').digest('hex');
                if (migrationRow === undefined || sqlInteger(migrationRow, 'version') !== migration.version || sqlString(migrationRow, 'checksum') !== expectedChecksum)
                    throw new CoordinationRuntimeError('schema-mismatch', `coordinator migration ${String(migration.version)} checksum does not match the package schema`);
            }
            if (integrityResult(db) !== 'ok')
                throw new CoordinationRuntimeError('store-corrupt', 'coordinator database failed post-migration integrity check');
            await enforcePrivateAuthorityPath(paths.databasePath, false);
            const store = new CoordinatorStore(db, clock, paths.stateRoot, lastBackupPath, options);
            // A migration freeze protects a whole-database rollback boundary. Startup
            // replay/recovery is therefore deferred until the freeze is removed;
            // explicit target-repository recovery mutations remain separately fenced.
            if (activeCoordinationMigrationFreeze(paths.stateRoot) === null) {
                await store.#replayPendingSemanticEvents(paths);
                store.#recoverDurableTransitionsAfterStartup();
            }
            return store;
        }
        catch (error) {
            db.close();
            if (error instanceof CoordinationRuntimeError)
                throw error;
            throw sqliteFailure(error);
        }
    }
    close() {
        this.#db.close();
    }
    integrity() {
        return integrityResult(this.#db);
    }
    replaySemanticEventBatch(records) {
        if (records.length < 1 || records.length > COORDINATOR_SEMANTIC_REPLAY_BATCH_SIZE)
            throw new CoordinationRuntimeError('invalid-request', 'semantic replay batch size is outside the production bound');
        if (this.#semanticReplayTransactionActive)
            throw new CoordinationRuntimeError('invalid-state', 'nested semantic replay transactions are forbidden');
        const parsed = records.map((record, index) => parseSemanticReplayRecord(record, `semantic replay batch record ${String(index + 1)}`));
        this.#db.exec('BEGIN IMMEDIATE');
        this.#semanticReplayTransactionActive = true;
        try {
            const results = this.#reduceSemanticReplayRecords(parsed, true);
            this.#db.exec('COMMIT');
            return results;
        }
        catch (error) {
            this.#db.exec('ROLLBACK');
            throw error;
        }
        finally {
            this.#semanticReplayTransactionActive = false;
            this.#semanticReplayGraphlessRepositories.clear();
        }
    }
    #reduceSemanticReplayRecords(records, trackReplayState) {
        const results = [];
        for (const record of records) {
            if (record.action !== 'heartbeat')
                this.#semanticReplayGraphlessRepositories.delete(record.repo_id);
            const prior = trackReplayState ? this.#db.prepare('SELECT event_seq FROM events WHERE repo_id=? AND idempotency_key=?').get(record.repo_id, record.idempotency_key) : undefined;
            const response = this.handle(record);
            if (!response.ok || response.committed_event_seq === null)
                throw new CoordinationRuntimeError('invalid-state', 'semantic replay reducer rejected a request', [record.request_id, String(response.error_code), String(response.payload['message'] ?? '')]);
            if (trackReplayState)
                results.push({ committed_event_seq: response.committed_event_seq, replayed: prior !== undefined });
        }
        return Object.freeze(results);
    }
    async #semanticReplayBoundary(boundary) {
        await this.#onSemanticReplayBoundary?.(boundary);
    }
    #allInvariantFindings() {
        const findings = [];
        for (const row of this.#db.prepare('SELECT repo_id FROM repositories ORDER BY repo_id').all())
            findings.push(...checkCoordinationInvariants(this.#snapshotForRepository(sqlString(row, 'repo_id'))));
        return Object.freeze(findings);
    }
    #semanticReplayCompletion(header) {
        const row = this.#db.prepare('SELECT replay_id, record_count, records_sha256, applied_at FROM semantic_replays WHERE replay_id=?').get(header.replay_id);
        if (row === undefined)
            return null;
        const receipt = {
            schema_version: 'autopilot.coordinator_semantic_replay_receipt.v1', replay_id: sqlString(row, 'replay_id'),
            record_count: sqlInteger(row, 'record_count'), records_sha256: sqlString(row, 'records_sha256'), applied_at: sqlString(row, 'applied_at'),
        };
        if (!sameSemanticReplayIdentity(receipt, header))
            throw new CoordinationRuntimeError('idempotency-conflict', 'semantic replay id was reused with a different corpus identity', [header.replay_id]);
        return parseSemanticReplayReceipt(canonicalJson(receipt), 'semantic_replays database row');
    }
    async #projectSemanticReplayReceipt(paths, receipt) {
        await ensureSemanticReplayRoots(paths);
        const receiptPath = semanticReplayReceiptPath(paths, receipt.replay_id);
        const temporaryReceipt = join(paths.semanticReplayReceiptsRoot, `.${receipt.replay_id}.${String(process.pid)}.${Date.now().toString(16)}.tmp`);
        const descriptor = openSync(temporaryReceipt, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
        try {
            writeSync(descriptor, `${canonicalJson(receipt)}\n`);
            fsyncSync(descriptor);
        }
        finally {
            closeSync(descriptor);
        }
        try {
            if (existsSync(receiptPath)) {
                const existing = lstatSync(receiptPath);
                if (existing.isDirectory())
                    throw new CoordinationRuntimeError('permission-denied', 'semantic replay receipt projection refuses to replace a directory', [receiptPath]);
                if (platform() === 'win32')
                    await unlink(receiptPath);
            }
            await rename(temporaryReceipt, receiptPath);
            syncParentDirectory(receiptPath);
            const projected = lstatSync(receiptPath);
            if (!projected.isFile() || projected.isSymbolicLink() || projected.size < 2 || projected.size > 4_096)
                throw new CoordinationRuntimeError('invalid-state', 'semantic replay receipt projection is not a bounded regular file', [receiptPath]);
            const parsed = parseSemanticReplayReceipt(readFileSync(receiptPath, 'utf8'), receiptPath);
            if (canonicalJson(parsed) !== canonicalJson(receipt))
                throw new CoordinationRuntimeError('invalid-state', 'semantic replay receipt projection disagrees with database completion', [receiptPath]);
        }
        finally {
            await unlink(temporaryReceipt).catch(() => undefined);
        }
    }
    async #removeSemanticReplayInbox(paths, expected) {
        if (!existsSync(paths.semanticReplayPath))
            return;
        const descriptor = openSync(paths.semanticReplayPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        try {
            if (!sameReplayFileIdentity(expected, replayFileIdentity(descriptor)))
                throw new CoordinationRuntimeError('invalid-state', 'semantic replay inbox changed after validation; replacement input was preserved', [paths.semanticReplayPath]);
        }
        finally {
            closeSync(descriptor);
        }
        await unlink(paths.semanticReplayPath);
        syncParentDirectory(paths.semanticReplayPath);
    }
    async #replayPendingSemanticEvents(paths) {
        if (!existsSync(paths.semanticReplayPath))
            return;
        await ensureSemanticReplayRoots(paths);
        const descriptor = openSync(paths.semanticReplayPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const initialIdentity = replayFileIdentity(descriptor);
        let transactionOpen = false;
        let header = null;
        let receipt = null;
        try {
            this.#db.exec('CREATE TEMP TABLE IF NOT EXISTS semantic_replay_stage_work (replay_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 1 AND ordinal <= 100000), record_json TEXT NOT NULL, PRIMARY KEY(replay_id, ordinal)) STRICT, WITHOUT ROWID; DELETE FROM semantic_replay_stage_work;');
            this.#db.exec('BEGIN IMMEDIATE');
            transactionOpen = true;
            this.#semanticReplayTransactionActive = true;
            let count = 0;
            const hash = createHash('sha256');
            const insertStagedRecord = this.#db.prepare('INSERT INTO semantic_replay_stage_work(replay_id, ordinal, record_json) VALUES(?, ?, ?)');
            for await (const line of semanticReplayLines(paths.semanticReplayPath, descriptor)) {
                if (header === null) {
                    header = parseSemanticReplayHeader(line);
                    continue;
                }
                parseSemanticReplayLine(line, `semantic replay record ${String(count + 1)}`);
                count += 1;
                if (count > COORDINATOR_MAX_SEMANTIC_REPLAY_RECORDS)
                    throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus exceeds its record bound');
                hash.update(`${line}\n`, 'utf8');
                // parseSemanticReplayLine proved this exact line canonical and contract-valid.
                // Preserve those immutable bytes in the transaction-local stage rather
                // than serializing the same request a second time.
                insertStagedRecord.run(header.replay_id, count, line);
            }
            if (header === null || count !== header.record_count || `sha256:${hash.digest('hex')}` !== header.records_sha256)
                throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus count or digest does not match its header');
            if (!sameReplayFileIdentity(initialIdentity, replayFileIdentity(descriptor)))
                throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus changed during validation', [paths.semanticReplayPath]);
            await this.#semanticReplayBoundary('stage-validated');
            receipt = this.#semanticReplayCompletion(header);
            if (receipt === null) {
                for (let first = 1; first <= header.record_count; first += COORDINATOR_SEMANTIC_REPLAY_BATCH_SIZE) {
                    const rows = this.#db.prepare('SELECT record_json FROM semantic_replay_stage_work WHERE replay_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?').all(header.replay_id, first, COORDINATOR_SEMANTIC_REPLAY_BATCH_SIZE);
                    // Only this transaction can populate the TEMP stage, and every row was
                    // canonicalized and contract-validated above. Revalidate the contract
                    // after decoding without repeating the expensive canonical byte proof.
                    const records = rows.map((row, index) => parseValidatedSemanticReplayLine(sqlString(row, 'record_json'), `staged semantic replay record ${String(first + index)}`));
                    this.#reduceSemanticReplayRecords(records, false);
                    await this.#semanticReplayBoundary('batch-applied');
                }
                await this.#semanticReplayBoundary('records-applied');
                if (integrityResult(this.#db) !== 'ok')
                    throw new CoordinationRuntimeError('store-corrupt', 'coordinator database failed integrity after semantic replay');
                const invariantErrors = this.#allInvariantFindings().filter((finding) => finding.severity === 'error');
                if (invariantErrors.length > 0)
                    throw new CoordinationRuntimeError('invalid-state', 'semantic replay violates coordinator invariants', invariantErrors.slice(0, 100).map((finding) => `${finding.code}:${finding.entity}:${finding.detail}`));
                receipt = { schema_version: 'autopilot.coordinator_semantic_replay_receipt.v1', replay_id: header.replay_id, record_count: header.record_count, records_sha256: header.records_sha256, applied_at: this.#clock.now().toISOString() };
                this.#db.prepare('INSERT INTO semantic_replays(replay_id, record_count, records_sha256, applied_at) VALUES(?, ?, ?, ?)').run(receipt.replay_id, receipt.record_count, receipt.records_sha256, receipt.applied_at);
            }
            this.#db.prepare('DELETE FROM semantic_replay_stage_work WHERE replay_id=?').run(header.replay_id);
            this.#db.exec('COMMIT');
            transactionOpen = false;
            this.#semanticReplayTransactionActive = false;
            this.#semanticReplayGraphlessRepositories.clear();
            await this.#semanticReplayBoundary('database-completed');
        }
        catch (error) {
            if (transactionOpen)
                this.#db.exec('ROLLBACK');
            this.#semanticReplayTransactionActive = false;
            this.#semanticReplayGraphlessRepositories.clear();
            throw error;
        }
        finally {
            closeSync(descriptor);
        }
        if (receipt === null)
            throw new CoordinationRuntimeError('store-corrupt', 'semantic replay completion disappeared after commit');
        await this.#projectSemanticReplayReceipt(paths, receipt);
        await this.#semanticReplayBoundary('receipt-projected');
        await this.#removeSemanticReplayInbox(paths, initialIdentity);
        await this.#semanticReplayBoundary('inbox-cleaned');
    }
    async createVerifiedBackup(outputPath) {
        const target = resolve(outputPath);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        await backup(this.#db, target);
        const backupDb = new DatabaseSync(target, { readOnly: true });
        try {
            if (integrityResult(backupDb) !== 'ok')
                throw new CoordinationRuntimeError('store-corrupt', 'migration backup failed integrity verification', [target]);
        }
        finally {
            backupDb.close();
        }
        if (platform() !== 'win32')
            chmodSync(target, 0o600);
        const sha256 = `sha256:${createHash('sha256').update(readFileSync(target)).digest('hex')}`;
        this.#lastBackupPath = target;
        return { path: target, sha256 };
    }
    importLegacyCoordination(plan) {
        parseCoordinationRepository(plan.repository);
        for (const run of plan.runs)
            parseCoordinationRun(run);
        for (const resource of plan.run_resources)
            parseCoordinationRunResource(resource);
        for (const attempt of plan.unit_attempts)
            parseCoordinationUnitAttempt(attempt);
        for (const group of plan.acquisition_groups)
            parseCoordinationAcquisitionGroup(group);
        for (const lease of plan.edit_leases)
            parseCoordinationEditLease(lease);
        for (const release of plan.terminal_releases) {
            parseCoordinationRequestedLease({ path: release.path, mode: release.mode, purpose: 'migration terminal release proof' }, 'migration terminal release');
            if (!SHA256_PATTERN.test(release.evidence_sha256) || release.evidence_ref.length === 0 || release.evidence_ref.length > 2048)
                throw new CoordinationRuntimeError('invalid-request', 'migration terminal release evidence identity is invalid');
        }
        for (const reservation of plan.change_reservations)
            parseCoordinationChangeReservation(reservation);
        for (const obligation of plan.reservation_obligations)
            parseCoordinationReservationObligation(obligation);
        for (const evidence of plan.reconciliation_evidence)
            parseCoordinationReconciliationEvidence(evidence);
        for (const worktree of plan.worktrees)
            parseCoordinationWorktree(worktree);
        if (!SHA256_PATTERN.test(plan.snapshot_sha256))
            throw new CoordinationRuntimeError('invalid-request', 'migration snapshot digest is invalid');
        const existingMigration = this.#db.prepare('SELECT migration_id, snapshot_sha256, report_json FROM coordination_migrations WHERE repo_id=?').get(plan.repository.repo_id);
        if (existingMigration !== undefined) {
            if (sqlString(existingMigration, 'migration_id') !== plan.migration_id || sqlString(existingMigration, 'snapshot_sha256') !== plan.snapshot_sha256)
                throw new CoordinationRuntimeError('idempotency-conflict', 'repository already has a different migration import');
            return { committedEventSeq: null, payload: { schema_version: 'autopilot.coordination_migration_import_result.v1', replayed: true, report: parseJsonObject(sqlString(existingMigration, 'report_json'), 'migration report') } };
        }
        const now = this.#clock.now().toISOString();
        let seq = 1;
        let importedRunCount = 0;
        let importedAttemptCount = 0;
        let importedLeaseCount = 0;
        let equivalentLeaseCount = 0;
        let importedReservationCount = 0;
        let importedWorktreeCount = 0;
        let importedAuditCount = 0;
        let recoveryWorkCount = 0;
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            const existingRepositoryRow = this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(plan.repository.repo_id);
            if (existingRepositoryRow === undefined) {
                this.#db.prepare('INSERT INTO repositories(repo_id, repo_key, canonical_root, git_common_dir, event_seq, created_event_seq, version) VALUES(?, ?, ?, ?, 1, 1, 1)').run(plan.repository.repo_id, plan.repository.repo_key, plan.repository.canonical_root, plan.repository.git_common_dir);
            }
            else {
                const existingRepository = repositoryFromRow(existingRepositoryRow);
                let samePhysicalRepository = false;
                try {
                    samePhysicalRepository = realpathSync(existingRepository.canonical_root) === realpathSync(plan.repository.canonical_root) && realpathSync(existingRepository.git_common_dir) === realpathSync(plan.repository.git_common_dir);
                }
                catch {
                    samePhysicalRepository = false;
                }
                if (existingRepository.repo_key !== plan.repository.repo_key || !samePhysicalRepository)
                    throw new CoordinationRuntimeError('invalid-state', 'legacy and coordinator repository identities disagree', [plan.repository.repo_id]);
                seq = sqlInteger(existingRepositoryRow, 'event_seq') + 1;
                this.#db.prepare('UPDATE repositories SET event_seq=? WHERE repo_id=?').run(seq, plan.repository.repo_id);
            }
            for (const run of plan.runs) {
                const existingRunRow = this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run);
                if (existingRunRow === undefined) {
                    this.#db.prepare('INSERT INTO runs(repo_id, autopilot_id, workstream, workstream_run, coordination_authority, status, active_session_generation, created_event_seq, version) VALUES(?, ?, ?, ?, ?, ?, 0, ?, 1)').run(run.repo_id, run.autopilot_id, run.workstream, run.workstream_run, 'coordinator-edit-leases-v1', run.status, seq);
                    importedRunCount += 1;
                }
                else {
                    const existingRun = runFromRow(existingRunRow);
                    if (existingRun.autopilot_id !== run.autopilot_id || existingRun.workstream !== run.workstream)
                        throw new CoordinationRuntimeError('invalid-state', 'legacy run disagrees with existing coordinator identity', [run.workstream_run]);
                    if (existingRun.coordination_authority === 'legacy-path-claims-v1')
                        this.#db.prepare("UPDATE runs SET coordination_authority='coordinator-edit-leases-v1', version=version+1 WHERE repo_id=? AND workstream_run=?").run(run.repo_id, run.workstream_run);
                    else if (existingRun.coordination_authority !== 'coordinator-edit-leases-v1')
                        throw new CoordinationRuntimeError('invalid-state', 'existing coordinator run has an unsupported authority', [run.workstream_run]);
                    if (run.status === 'recovering' && existingRun.status !== 'closed' && existingRun.status !== 'aborted')
                        this.#db.prepare("UPDATE runs SET status='recovering', version=version+1 WHERE repo_id=? AND workstream_run=?").run(run.repo_id, run.workstream_run);
                }
                if (this.#db.prepare('SELECT repo_id FROM mailbox_cursors WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run) === undefined)
                    this.#db.prepare('INSERT INTO mailbox_cursors(repo_id, workstream_run, delivered_through_event_seq, acknowledged_through_event_seq, version) VALUES(?, ?, 0, 0, 1)').run(run.repo_id, run.workstream_run);
            }
            for (const resource of plan.run_resources) {
                const row = this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(resource.repo_id, resource.workstream_run);
                if (row === undefined)
                    this.#db.prepare('INSERT INTO run_resources(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(`run-resource:${resource.repo_id}:${resource.workstream_run}`, resource.repo_id, resource.workstream_run, canonicalJson(resource), resource.version);
                else if (canonicalJson(runResourceFromRow(row)) !== canonicalJson(resource))
                    throw new CoordinationRuntimeError('invalid-state', 'legacy run resource disagrees with existing coordinator resource', [resource.workstream_run]);
            }
            for (const attempt of plan.unit_attempts) {
                const entityId = unitAttemptEntityId(attempt.owner);
                const row = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(entityId);
                if (row === undefined) {
                    this.#db.prepare('INSERT INTO unit_attempts(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(entityId, attempt.owner.repo_id, attempt.owner.workstream_run, canonicalJson(attempt), attempt.version);
                    importedAttemptCount += 1;
                }
                else {
                    const existingAttempt = unitAttemptFromRow(row);
                    if (coordinationOwnerKey(existingAttempt.owner) !== coordinationOwnerKey(attempt.owner))
                        throw new CoordinationRuntimeError('invalid-state', 'legacy attempt disagrees with existing coordinator owner', [entityId]);
                }
            }
            const terminallyReleasedLeaseIds = [];
            for (const release of plan.terminal_releases) {
                const matches = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(release.owner.repo_id, release.owner.workstream_run).map(editLeaseFromRow).filter((lease) => coordinationOwnerKey(lease.owner) === coordinationOwnerKey(release.owner) && lease.path === release.path && lease.mode === release.mode);
                for (const lease of matches)
                    this.#releaseOwnedLease(release.owner.repo_id, release.owner.workstream_run, lease.edit_lease_id, terminallyReleasedLeaseIds);
            }
            const existingLeases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? ORDER BY entity_id').all(plan.repository.repo_id).map(editLeaseFromRow);
            for (const group of plan.acquisition_groups) {
                const existingRunRow = this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').get(group.owner.repo_id, group.owner.workstream_run);
                const existingAttemptRow = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(unitAttemptEntityId(group.owner));
                if (existingRunRow === undefined || existingAttemptRow === undefined)
                    throw new CoordinationRuntimeError('invalid-state', 'migration authority owner disappeared during transactional reconciliation', [group.owner.workstream_run, group.owner.unit_id]);
                const groupLeases = plan.edit_leases.filter((lease) => lease.acquisition_group_id === group.acquisition_group_id);
                const uncovered = groupLeases.filter((lease) => !existingLeases.some((candidate) => coordinationOwnerKey(candidate.owner) === coordinationOwnerKey(lease.owner) && candidate.path === lease.path && candidate.mode === lease.mode));
                equivalentLeaseCount += groupLeases.length - uncovered.length;
                if (uncovered.length === 0)
                    continue;
                const adjusted = parseCoordinationAcquisitionGroup({ ...group, requested_leases: uncovered.map((lease) => ({ path: lease.path, mode: lease.mode, purpose: lease.purpose })), created_event_seq: seq, fairness_event_seq: seq, grant_event_seq: seq });
                if (this.#db.prepare('SELECT entity_id FROM acquisition_groups WHERE entity_id=?').get(adjusted.acquisition_group_id) !== undefined)
                    throw new CoordinationRuntimeError('invalid-state', 'migration acquisition group id collides with existing coordinator state', [adjusted.acquisition_group_id]);
                this.#db.prepare('INSERT INTO acquisition_groups(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(adjusted.acquisition_group_id, adjusted.owner.repo_id, adjusted.owner.workstream_run, canonicalJson(adjusted), adjusted.version);
                for (const lease of uncovered) {
                    if (this.#db.prepare('SELECT entity_id FROM edit_leases WHERE entity_id=?').get(lease.edit_lease_id) !== undefined)
                        throw new CoordinationRuntimeError('invalid-state', 'migration lease id collides with existing coordinator state', [lease.edit_lease_id]);
                    this.#db.prepare('INSERT INTO edit_leases(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(lease.edit_lease_id, lease.owner.repo_id, lease.owner.workstream_run, canonicalJson({ ...lease, acquired_event_seq: seq }), lease.version);
                    importedLeaseCount += 1;
                }
            }
            for (const evidence of plan.reconciliation_evidence)
                if (this.#db.prepare('SELECT entity_id FROM reconciliation_evidence WHERE entity_id=?').get(evidence.reconciliation_evidence_id) === undefined)
                    this.#db.prepare('INSERT INTO reconciliation_evidence(entity_id, repo_id, workstream_run, source, target_id, payload_json, version) VALUES(?, ?, ?, ?, ?, ?, ?)').run(evidence.reconciliation_evidence_id, evidence.repo_id, evidence.workstream_run, evidence.source, evidence.release_condition.target_id, canonicalJson({ ...evidence, accepted_event_seq: seq }), evidence.version);
            for (const reservation of plan.change_reservations) {
                const reservationRun = this.#requireRun(reservation.repo_id, reservation.workstream_run);
                if (reservationRun.status === 'closed' || reservationRun.status === 'aborted')
                    continue;
                const equivalent = this.#db.prepare("SELECT entity_id FROM change_reservations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.path')=?").get(reservation.repo_id, reservation.workstream_run, reservation.path);
                if (equivalent === undefined) {
                    this.#db.prepare('INSERT INTO change_reservations(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(reservation.reservation_id, reservation.repo_id, reservation.workstream_run, canonicalJson({ ...reservation, created_event_seq: seq }), reservation.version);
                    importedReservationCount += 1;
                }
            }
            for (const obligation of plan.reservation_obligations)
                if (this.#db.prepare('SELECT entity_id FROM reservation_obligations WHERE entity_id=?').get(obligation.obligation_id) === undefined && this.#db.prepare('SELECT entity_id FROM change_reservations WHERE entity_id=?').get(obligation.reservation_id) !== undefined && this.#db.prepare('SELECT entity_id FROM change_reservations WHERE entity_id=?').get(obligation.predecessor_reservation_id) !== undefined)
                    this.#db.prepare('INSERT INTO reservation_obligations(entity_id, repo_id, workstream_run, reservation_id, predecessor_reservation_id, payload_json, version) VALUES(?, ?, ?, ?, ?, ?, ?)').run(obligation.obligation_id, obligation.repo_id, obligation.workstream_run, obligation.reservation_id, obligation.predecessor_reservation_id, canonicalJson({ ...obligation, created_event_seq: seq }), obligation.version);
            for (const worktree of plan.worktrees) {
                const existing = this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.owner.unit_id')=? AND json_extract(payload_json, '$.owner.attempt')=?").get(worktree.owner.repo_id, worktree.owner.workstream_run, worktree.owner.unit_id, worktree.owner.attempt);
                if (existing === undefined) {
                    this.#db.prepare('INSERT INTO worktrees(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(worktree.worktree_id, worktree.owner.repo_id, worktree.owner.workstream_run, canonicalJson(worktree), worktree.version);
                    importedWorktreeCount += 1;
                }
                else {
                    const current = worktreeFromRow(existing);
                    if (current.canonical_path !== worktree.canonical_path || current.git_common_dir !== worktree.git_common_dir || current.branch !== worktree.branch || current.kind !== worktree.kind)
                        throw new CoordinationRuntimeError('invalid-state', 'legacy worktree disagrees with existing coordinator ownership', [worktree.worktree_id]);
                }
            }
            for (const recovery of plan.recovery_work) {
                if (this.#db.prepare('SELECT repo_id FROM runs WHERE repo_id=? AND workstream_run=?').get(plan.repository.repo_id, recovery.workstream_run) === undefined)
                    throw new CoordinationRuntimeError('invalid-state', 'migration recovery work owner is missing', [recovery.recovery_id]);
                if (this.#db.prepare('SELECT entity_id FROM migration_recovery_work WHERE entity_id=?').get(recovery.recovery_id) === undefined) {
                    this.#db.prepare("INSERT INTO migration_recovery_work(entity_id, repo_id, workstream_run, recovery_type, payload_json, status, created_event_seq, version) VALUES(?, ?, ?, ?, ?, 'pending', ?, 1)").run(recovery.recovery_id, plan.repository.repo_id, recovery.workstream_run, recovery.recovery_type, canonicalJson(recovery.detail), seq);
                    recoveryWorkCount += 1;
                }
                const messageId = `migration-message-${createHash('sha256').update(recovery.recovery_id, 'utf8').digest('hex').slice(0, 24)}`;
                if (this.#db.prepare('SELECT message_id FROM messages WHERE message_id=?').get(messageId) === undefined)
                    this.#db.prepare("INSERT INTO messages(message_id, repo_id, recipient_workstream_run, message_type, correlation_id, payload_json, status, created_event_seq, delivered_event_seq, acknowledged_event_seq, version) VALUES(?, ?, ?, 'recovery-required', ?, ?, 'pending', ?, NULL, NULL, 1)").run(messageId, plan.repository.repo_id, recovery.workstream_run, recovery.recovery_id, canonicalJson({ recovery_id: recovery.recovery_id, recovery_type: recovery.recovery_type, detail: recovery.detail }), seq);
            }
            for (const audit of plan.legacy_audit)
                if (this.#db.prepare('SELECT entity_id FROM migration_legacy_audit WHERE entity_id=?').get(audit.audit_id) === undefined) {
                    this.#db.prepare('INSERT INTO migration_legacy_audit(entity_id, repo_id, source_kind, payload_json, created_event_seq) VALUES(?, ?, ?, ?, ?)').run(audit.audit_id, plan.repository.repo_id, audit.source_kind, canonicalJson(audit.payload), seq);
                    importedAuditCount += 1;
                }
            const exactReport = { ...plan.report, equivalent_lease_count: equivalentLeaseCount, imported_run_count: importedRunCount, imported_attempt_count: importedAttemptCount, imported_lease_count: importedLeaseCount, imported_reservation_count: importedReservationCount, imported_worktree_count: importedWorktreeCount, imported_audit_count: importedAuditCount, recovery_work_count: recoveryWorkCount };
            if (exactReport.classified_claim_count !== exactReport.legacy_claim_count || exactReport.equivalent_lease_count + exactReport.imported_lease_count + exactReport.terminal_leak_count !== exactReport.legacy_claim_count)
                throw new CoordinationRuntimeError('invalid-state', 'migration claim reconciliation did not classify every legacy authority claim', [canonicalJson(exactReport)]);
            const idempotencyKey = `legacy-migration:${plan.migration_id}`;
            this.#db.prepare('INSERT INTO events(repo_id, event_seq, event_type, entity_type, entity_id, idempotency_key, request_sha256, occurred_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(plan.repository.repo_id, seq, 'legacy-coordination-imported', 'migration', plan.migration_id, idempotencyKey, plan.snapshot_sha256, now);
            this.#db.prepare("INSERT INTO coordination_migrations(repo_id, migration_id, snapshot_sha256, journal_path, state, report_json, imported_at, updated_at, version) VALUES(?, ?, ?, ?, 'imported', ?, ?, ?, 1)").run(plan.repository.repo_id, plan.migration_id, plan.snapshot_sha256, plan.journal_path, canonicalJson(exactReport), now, now);
            const invariantFindings = checkCoordinationInvariants(this.#snapshotForRepository(plan.repository.repo_id)).filter((finding) => finding.severity === 'error' && !migrationRecoveryCoversRetainedAuthority(this.#db, plan.repository.repo_id, finding));
            if (invariantFindings.length > 0)
                throw new CoordinationRuntimeError('invalid-state', 'transactional legacy import violates coordinator invariants', invariantFindings.slice(0, 100).map((finding) => `${finding.code}:${finding.entity}:${finding.detail}`));
            this.#db.exec('COMMIT');
        }
        catch (error) {
            this.#db.exec('ROLLBACK');
            throw error;
        }
        if (integrityResult(this.#db) !== 'ok')
            throw new CoordinationRuntimeError('store-corrupt', 'coordinator database failed integrity after transactional legacy import');
        const committedMigration = this.readMigrationImport(plan.repository.repo_id);
        if (committedMigration === null)
            throw new CoordinationRuntimeError('store-corrupt', 'committed migration report disappeared');
        return { committedEventSeq: seq, payload: { schema_version: 'autopilot.coordination_migration_import_result.v1', replayed: false, report: committedMigration.report } };
    }
    readMigrationImport(repoId) {
        const row = this.#db.prepare('SELECT migration_id, snapshot_sha256, state, report_json FROM coordination_migrations WHERE repo_id=?').get(repoId);
        if (row === undefined)
            return null;
        const snapshot = sqlString(row, 'snapshot_sha256');
        if (!SHA256_PATTERN.test(snapshot))
            throw new CoordinationRuntimeError('store-corrupt', 'migration record snapshot digest is invalid');
        const state = sqlString(row, 'state');
        if (!['imported', 'verified', 'cutover-ready', 'cutover-committed', 'legacy-archived'].includes(state))
            throw new CoordinationRuntimeError('store-corrupt', 'migration record state is invalid');
        return { migration_id: sqlString(row, 'migration_id'), snapshot_sha256: snapshot, state: state, report: parseJsonObject(sqlString(row, 'report_json'), 'migration report') };
    }
    verifyMigrationImport(repoId, migrationId) {
        const migration = this.#db.prepare('SELECT migration_id FROM coordination_migrations WHERE repo_id=?').get(repoId);
        if (migration === undefined || sqlString(migration, 'migration_id') !== migrationId)
            throw new CoordinationRuntimeError('invalid-state', 'migration import record is missing or mismatched');
        const integrity = integrityResult(this.#db);
        const findings = checkCoordinationInvariants(this.#snapshotForRepository(repoId));
        const runCount = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM runs WHERE repo_id=? AND status NOT IN ('closed','aborted')").get(repoId), 'migration run count'), 'count');
        const resourceCount = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM run_resources WHERE repo_id=? AND workstream_run IN (SELECT workstream_run FROM runs WHERE repo_id=? AND status NOT IN ('closed','aborted'))").get(repoId, repoId), 'migration resource count'), 'count');
        if (runCount !== resourceCount)
            throw new CoordinationRuntimeError('invalid-state', 'migration verification requires exactly one immutable run resource per run', [`runs=${String(runCount)}`, `resources=${String(resourceCount)}`]);
        const errors = findings.filter((finding) => finding.severity === 'error' && !migrationRecoveryCoversRetainedAuthority(this.#db, repoId, finding));
        if (integrity !== 'ok' || errors.length > 0)
            throw new CoordinationRuntimeError('invalid-state', 'migration verification failed coordinator integrity or invariants', errors.slice(0, 100).map((finding) => `${finding.code}:${finding.entity}:${finding.detail}`));
        return { integrity, invariant_findings: findings };
    }
    databaseDigest() {
        this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        if (integrityResult(this.#db) !== 'ok')
            throw new CoordinationRuntimeError('store-corrupt', 'database failed integrity before cutover digest');
        return `sha256:${createHash('sha256').update(readFileSync(resolve(this.#stateRoot, 'coordinator', 'coordinator.db'))).digest('hex')}`;
    }
    updateMigrationState(repoId, migrationId, state, report) {
        const row = this.#db.prepare('SELECT migration_id, version FROM coordination_migrations WHERE repo_id=?').get(repoId);
        if (row === undefined || sqlString(row, 'migration_id') !== migrationId)
            throw new CoordinationRuntimeError('invalid-state', 'migration import record is missing or mismatched');
        this.#db.prepare('UPDATE coordination_migrations SET state=?, report_json=?, updated_at=?, version=version+1 WHERE repo_id=? AND migration_id=?').run(state, canonicalJson(report), this.#clock.now().toISOString(), repoId, migrationId);
    }
    sweepExpiredGrantOffers() {
        if (activeCoordinationMigrationFreeze(this.#stateRoot) !== null)
            return 0;
        const now = this.#clock.now().toISOString();
        const repoRows = this.#db.prepare("SELECT DISTINCT repo_id FROM acquisition_groups WHERE json_extract(payload_json, '$.state')='grant-ready' AND json_extract(payload_json, '$.offer_expires_at')<=? ORDER BY repo_id").all(now);
        let expiredCount = 0;
        for (const repoRow of repoRows) {
            const repoId = sqlString(repoRow, 'repo_id');
            this.#db.exec('BEGIN IMMEDIATE');
            try {
                const seq = this.#nextEventSequence(repoId);
                const before = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state')='grant-ready' AND json_extract(payload_json, '$.offer_expires_at')<=?").get(repoId, now), 'expired offer count'), 'count');
                if (!this.#expireGrantOffers(repoId, seq)) {
                    this.#db.exec('ROLLBACK');
                    continue;
                }
                this.#reevaluateWaitingGroups(repoId, seq);
                const idempotencyKey = `grant-offer-expiry:${repoId}:${String(seq)}`;
                const digest = `sha256:${createHash('sha256').update(idempotencyKey, 'utf8').digest('hex')}`;
                this.#db.prepare('INSERT INTO events(repo_id, event_seq, event_type, entity_type, entity_id, idempotency_key, request_sha256, occurred_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(repoId, seq, 'grant-offers-expired', 'repository', repoId, idempotencyKey, digest, now);
                this.#db.exec('COMMIT');
                expiredCount += before;
            }
            catch (error) {
                this.#db.exec('ROLLBACK');
                throw error;
            }
        }
        return expiredCount;
    }
    replayLegacyRequest(request) {
        const requestId = request['request_id'];
        const repoId = request['repo_id'];
        const idempotencyKey = request['idempotency_key'];
        const action = request['action'];
        const payload = request['payload'];
        if (typeof requestId !== 'string' || typeof repoId !== 'string' || typeof idempotencyKey !== 'string' || typeof action !== 'string' || typeof payload !== 'object' || payload === null || Array.isArray(payload))
            throw new CoordinationRuntimeError('invalid-request', 'legacy replay request identity is malformed');
        const runOwned = RUN_OWNED_IDEMPOTENCY_ACTIONS.has(action);
        const semanticPayload = Object.fromEntries(Object.entries(payload).filter(([field]) => field !== 'migration_operation_token' && (!runOwned || field !== 'session_lease_id' && field !== 'session_token')));
        const semantic = { schema_version: request['schema_version'], protocol_version: request['protocol_version'], action, repo_id: repoId, workstream_run: request['workstream_run'], session_id: runOwned ? null : request['session_id'], fencing_generation: runOwned ? null : request['fencing_generation'], expected_version: runOwned ? null : request['expected_version'], payload: semanticPayload };
        const digest = `sha256:${createHash('sha256').update(canonicalJson(semantic), 'utf8').digest('hex')}`;
        const prior = this.#db.prepare('SELECT request_sha256, committed_event_seq, payload_json FROM idempotency_results WHERE repo_id=? AND idempotency_key=?').get(repoId, idempotencyKey);
        if (prior === undefined || sqlString(prior, 'request_sha256') !== digest)
            throw new CoordinationRuntimeError('idempotency-conflict', 'legacy request has no exact pre-migration idempotency result');
        return { schema_version: 'autopilot.coordinator_response.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: requestId, ok: true, committed_event_seq: sqlInteger(prior, 'committed_event_seq'), error_code: null, retryable: false, payload: parseJsonObject(sqlString(prior, 'payload_json'), 'legacy idempotency result') };
    }
    handle(request) {
        try {
            const effect = this.#dispatch(request);
            return {
                schema_version: 'autopilot.coordinator_response.v1',
                protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
                request_id: request.request_id,
                ok: true,
                committed_event_seq: effect.committedEventSeq,
                error_code: null,
                retryable: false,
                payload: effect.payload,
            };
        }
        catch (error) {
            const runtime = error instanceof CoordinationRuntimeError ? error : sqliteFailure(error);
            return {
                schema_version: 'autopilot.coordinator_response.v1',
                protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
                request_id: request.request_id,
                ok: false,
                committed_event_seq: null,
                error_code: runtime.code,
                retryable: runtime.retry_policy !== 'never',
                payload: { message: runtime.message, evidence: runtime.evidence },
            };
        }
    }
    #snapshotForRepository(repoId) {
        const repositoryRows = this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').all(repoId);
        const eventSeq = repositoryRows.length === 0 ? 0 : sqlInteger(asRow(repositoryRows[0], 'repository snapshot'), 'event_seq');
        return {
            schema_version: 'autopilot.coordination_snapshot.v1',
            repository_event_seq: eventSeq,
            repositories: repositoryRows.map(repositoryFromRow),
            runs: this.#db.prepare('SELECT * FROM runs WHERE repo_id=? ORDER BY workstream_run').all(repoId).map(runFromRow),
            session_leases: this.#db.prepare('SELECT * FROM session_leases WHERE repo_id=? ORDER BY workstream_run, session_generation').all(repoId).map(sessionFromRow),
            child_leases: this.#db.prepare('SELECT * FROM child_leases WHERE repo_id=? ORDER BY workstream_run, unit_id, attempt').all(repoId).map(childFromRow),
            unit_attempts: this.#db.prepare('SELECT * FROM unit_attempts WHERE repo_id=? ORDER BY entity_id').all(repoId).map(unitAttemptFromRow),
            acquisition_groups: this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? ORDER BY entity_id').all(repoId).map(acquisitionGroupFromRow),
            edit_leases: this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? ORDER BY entity_id').all(repoId).map(editLeaseFromRow),
            change_reservations: this.#db.prepare('SELECT * FROM change_reservations WHERE repo_id=? ORDER BY entity_id').all(repoId).map(changeReservationFromRow),
            reservation_obligations: this.#db.prepare('SELECT * FROM reservation_obligations WHERE repo_id=? ORDER BY entity_id').all(repoId).map(reservationObligationFromRow),
            run_terminal_intents: this.#db.prepare('SELECT * FROM run_terminal_intents WHERE repo_id=? ORDER BY entity_id').all(repoId).map(runTerminalIntentFromRow),
            claim_requests: this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? ORDER BY entity_id').all(repoId).map(claimRequestFromRow),
            mailbox_cursors: this.#db.prepare('SELECT * FROM mailbox_cursors WHERE repo_id=? ORDER BY workstream_run').all(repoId).map(mailboxCursorFromRow),
            reconciliation_evidence: this.#db.prepare('SELECT * FROM reconciliation_evidence WHERE repo_id=? ORDER BY entity_id').all(repoId).map(reconciliationEvidenceFromRow),
            migration_recovery_work: this.#db.prepare('SELECT * FROM migration_recovery_work WHERE repo_id=? ORDER BY entity_id').all(repoId).map(migrationRecoveryFromRow),
            messages: this.#db.prepare('SELECT * FROM messages WHERE repo_id=? ORDER BY created_event_seq, message_id').all(repoId).map(messageFromRow),
            worktrees: this.#db.prepare('SELECT * FROM worktrees WHERE repo_id=? ORDER BY entity_id').all(repoId).map(worktreeFromRow),
            worktree_operations: this.#db.prepare('SELECT * FROM worktree_operations WHERE repo_id=? ORDER BY entity_id').all(repoId).map(worktreeOperationFromRow),
            wait_for_edges: this.#db.prepare('SELECT * FROM wait_for_edges WHERE repo_id=? ORDER BY entity_id').all(repoId).map(waitForEdgeFromRow),
            deadlock_resolutions: this.#db.prepare('SELECT * FROM deadlock_resolutions WHERE repo_id=? ORDER BY entity_id').all(repoId).map(deadlockResolutionFromRow),
            authoritative_artifacts: this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? ORDER BY entity_id').all(repoId).map(authoritativeArtifactFromRow),
            adjudication_assignments: this.#db.prepare('SELECT * FROM adjudication_assignments WHERE repo_id=? ORDER BY entity_id').all(repoId).map(adjudicationAssignmentFromRow),
            escalations: this.#db.prepare('SELECT * FROM escalations WHERE repo_id=? ORDER BY entity_id').all(repoId).map(escalationFromRow),
            events: this.#db.prepare('SELECT * FROM events WHERE repo_id=? ORDER BY event_seq').all(repoId).map(eventFromRow),
        };
    }
    #dispatch(request) {
        const queryActions = new Set(['handshake', 'status', 'doctor', 'export', 'migration-recovery', 'run-catalog']);
        if (!queryActions.has(request.action)) {
            if (request.action === 'attach-migration-recovery')
                assertCoordinationMigrationRecoveryOperationAuthorized(this.#stateRoot, request.payload['migration_operation_token']);
            if (activeCoordinationMigrationFreeze(this.#stateRoot) !== null)
                assertCoordinationFrozenMutationAllowed(this.#stateRoot, request.repo_id, request.action, request.payload['migration_operation_token']);
            else
                assertCoordinationDispatchAllowed(this.#stateRoot, request.repo_id, `coordinator mutation ${request.action}`);
        }
        switch (request.action) {
            case 'handshake': return this.handshake();
            case 'status': return this.status(request.repo_id, request.workstream_run);
            case 'doctor': return this.doctor();
            case 'export': return this.exportTo(payloadString(request.payload, 'output_path'));
            case 'migration-recovery': return this.migrationRecovery(request);
            case 'run-catalog': return this.runCatalog(request.repo_id, request.workstream_run, request.payload);
            case 'attach-run': return this.attachRun(request);
            case 'attach-session': return this.attachSession(request);
            case 'attach-terminal-recovery': return this.attachTerminalRecovery(request);
            case 'attach-migration-recovery': return this.attachMigrationRecovery(request);
            case 'resolve-migration-recovery': return this.resolveMigrationRecovery(request);
            case 'detach-session': return this.detachSession(request);
            case 'prepare-handoff': return this.prepareHandoff(request);
            case 'heartbeat': return this.heartbeatSession(request);
            case 'register-attempt': return this.registerAttempt(request);
            case 'register-child': return this.registerChild(request);
            case 'heartbeat-child': return this.heartbeatChild(request);
            case 'checkpoint-child': return this.checkpointChild(request);
            case 'complete-child': return this.completeChild(request);
            case 'drain-mailbox': return this.drainMailbox(request);
            case 'acknowledge-message': return this.acknowledgeMessage(request);
            case 'acquire-group': return this.acquireGroup(request);
            case 'acknowledge-grant': return this.acknowledgeGrant(request);
            case 'respond-claim-request': return this.respondClaimRequest(request);
            case 'cancel-claim-request': return this.cancelClaimRequest(request);
            case 'cancel-acquisition-group': return this.cancelAcquisitionGroup(request);
            case 'supersede-attempt': return this.supersedeAttempt(request);
            case 'record-release-evidence': return this.recordReleaseEvidence(request);
            case 'resolve-reservation-obligation': return this.resolveReservationObligation(request);
            case 'prepare-run-terminal': return this.prepareRunTerminal(request);
            case 'cancel-run-terminal': return this.cancelRunTerminal(request);
            case 'reconcile-run': return this.reconcileRun(request);
            case 'prepare-operation': return this.prepareOperation(request);
            case 'transition-operation': return this.transitionOperation(request);
            case 'register-authoritative-artifact': return this.registerAuthoritativeArtifact(request);
            case 'assign-adjudication': return this.assignAdjudication(request);
            case 'claim-adjudication-assignment': return this.claimAdjudicationAssignment(request);
            case 'complete-adjudication': return this.completeAdjudication(request);
            case 'submit-planning-contradiction': return this.submitPlanningContradiction(request);
        }
    }
    handshake() {
        return { committedEventSeq: null, payload: { schema_version: 'autopilot.coordinator_handshake.v1', package_build: COORDINATOR_PACKAGE_BUILD, protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION } };
    }
    status(repoId, workstreamRun) {
        const repositories = repoId === 'global'
            ? this.#db.prepare('SELECT * FROM repositories ORDER BY repo_id').all().map(repositoryFromRow)
            : this.#db.prepare('SELECT * FROM repositories WHERE repo_id=? ORDER BY repo_id').all(repoId).map(repositoryFromRow);
        const runs = workstreamRun === null
            ? (repoId === 'global' ? this.#db.prepare('SELECT * FROM runs ORDER BY repo_id, workstream_run').all() : this.#db.prepare('SELECT * FROM runs WHERE repo_id=? ORDER BY workstream_run').all(repoId)).map(runFromRow)
            : this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').all(repoId, workstreamRun).map(runFromRow);
        const runResources = workstreamRun === null
            ? (repoId === 'global' ? this.#db.prepare('SELECT * FROM run_resources ORDER BY repo_id, workstream_run').all() : this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? ORDER BY workstream_run').all(repoId)).map(runResourceFromRow)
            : this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').all(repoId, workstreamRun).map(runResourceFromRow);
        const sessions = workstreamRun === null
            ? (repoId === 'global' ? this.#db.prepare('SELECT * FROM session_leases ORDER BY repo_id, workstream_run, session_generation').all() : this.#db.prepare('SELECT * FROM session_leases WHERE repo_id=? ORDER BY workstream_run, session_generation').all(repoId)).map(sessionFromRow)
            : this.#db.prepare('SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? ORDER BY session_generation').all(repoId, workstreamRun).map(sessionFromRow);
        const children = workstreamRun === null
            ? (repoId === 'global' ? this.#db.prepare('SELECT * FROM child_leases ORDER BY repo_id, workstream_run, unit_id, attempt').all() : this.#db.prepare('SELECT * FROM child_leases WHERE repo_id=? ORDER BY workstream_run, unit_id, attempt').all(repoId)).map(childFromRow)
            : this.#db.prepare('SELECT * FROM child_leases WHERE repo_id=? AND workstream_run=? ORDER BY unit_id, attempt').all(repoId, workstreamRun).map(childFromRow);
        const pendingMessages = workstreamRun === null ? 0 : sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM messages WHERE repo_id=? AND recipient_workstream_run=? AND status!='acknowledged'").get(repoId, workstreamRun), 'message count'), 'count');
        const unitAttempts = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM unit_attempts WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(unitAttemptFromRow);
        const acquisitionGroups = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(acquisitionGroupFromRow);
        const editLeases = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(editLeaseFromRow);
        const reservationObligations = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM reservation_obligations WHERE repo_id=? AND (workstream_run=? OR predecessor_reservation_id IN (SELECT entity_id FROM change_reservations WHERE repo_id=? AND workstream_run=?)) ORDER BY entity_id').all(repoId, workstreamRun, repoId, workstreamRun).map(reservationObligationFromRow);
        const relevantReservationIds = new Set(reservationObligations.flatMap((obligation) => [obligation.reservation_id, obligation.predecessor_reservation_id]));
        const changeReservations = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM change_reservations WHERE repo_id=? ORDER BY entity_id').all(repoId).map(changeReservationFromRow).filter((reservation) => reservation.workstream_run === workstreamRun || relevantReservationIds.has(reservation.reservation_id));
        const runTerminalIntents = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM run_terminal_intents WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(runTerminalIntentFromRow);
        const claimRequests = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? AND (requester_workstream_run=? OR owner_workstream_run=?) ORDER BY entity_id').all(repoId, workstreamRun, workstreamRun).map(claimRequestFromRow);
        const mailboxCursors = workstreamRun === null
            ? (repoId === 'global' ? this.#db.prepare('SELECT * FROM mailbox_cursors ORDER BY repo_id, workstream_run').all() : this.#db.prepare('SELECT * FROM mailbox_cursors WHERE repo_id=? ORDER BY workstream_run').all(repoId)).map(mailboxCursorFromRow)
            : this.#db.prepare('SELECT * FROM mailbox_cursors WHERE repo_id=? AND workstream_run=?').all(repoId, workstreamRun).map(mailboxCursorFromRow);
        const reconciliationEvidence = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM reconciliation_evidence WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(reconciliationEvidenceFromRow);
        const worktrees = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(worktreeFromRow);
        const worktreeOperations = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM worktree_operations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(worktreeOperationFromRow);
        const waitForEdges = workstreamRun === null ? [] : this.#db.prepare("SELECT * FROM wait_for_edges WHERE repo_id=? AND (json_extract(payload_json, '$.requester.workstream_run')=? OR json_extract(payload_json, '$.blocker.workstream_run')=?) ORDER BY entity_id").all(repoId, workstreamRun, workstreamRun).map(waitForEdgeFromRow);
        const relevantEdgeIds = new Set(waitForEdges.map((edge) => edge.edge_id));
        const deadlockResolutions = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM deadlock_resolutions WHERE repo_id=? ORDER BY entity_id').all(repoId).map(deadlockResolutionFromRow).filter((resolution) => resolution.cycle_edge_ids.some((edgeId) => relevantEdgeIds.has(edgeId)));
        const authoritativeArtifacts = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(authoritativeArtifactFromRow);
        const adjudicationAssignments = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM adjudication_assignments WHERE repo_id=? ORDER BY entity_id').all(repoId).map(adjudicationAssignmentFromRow).filter((assignment) => assignment.requesting_run === workstreamRun || assignment.participating_runs.includes(workstreamRun) || assignment.adjudicator.workstream_run === workstreamRun);
        const escalations = workstreamRun === null ? [] : this.#db.prepare('SELECT * FROM escalations WHERE repo_id=? ORDER BY entity_id').all(repoId).map(escalationFromRow).filter((escalation) => escalation.participating_runs.includes(workstreamRun));
        const migrations = (repoId === 'global'
            ? this.#db.prepare('SELECT repo_id, migration_id, snapshot_sha256, journal_path, state, report_json, imported_at, updated_at, version FROM coordination_migrations ORDER BY repo_id').all().map(migrationRecordFromRow)
            : this.#db.prepare('SELECT repo_id, migration_id, snapshot_sha256, journal_path, state, report_json, imported_at, updated_at, version FROM coordination_migrations WHERE repo_id=?').all(repoId).map(migrationRecordFromRow))
            .map((migration) => {
            const report = migration['report'];
            if (typeof report !== 'object' || report === null || Array.isArray(report))
                throw new CoordinationRuntimeError('store-corrupt', 'coordination migration status report is not an object');
            return { ...migration, report: { ...report, recovery: [] } };
        });
        const migrationRecoveryWork = workstreamRun === null
            ? (repoId === 'global' ? this.#db.prepare("SELECT * FROM migration_recovery_work WHERE status='pending' ORDER BY repo_id, workstream_run, entity_id LIMIT 128").all() : this.#db.prepare("SELECT * FROM migration_recovery_work WHERE repo_id=? AND status='pending' ORDER BY workstream_run, entity_id LIMIT 128").all(repoId)).map(migrationRecoveryFromRow)
            : this.#db.prepare("SELECT * FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND status='pending' ORDER BY entity_id LIMIT 128").all(repoId, workstreamRun).map(migrationRecoveryFromRow);
        const pendingMigrationRecoveryCount = workstreamRun === null
            ? (repoId === 'global' ? sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE status='pending'").get(), 'status pending recovery count'), 'count') : sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE repo_id=? AND status='pending'").get(repoId), 'status pending recovery count'), 'count'))
            : sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND status='pending'").get(repoId, workstreamRun), 'status pending recovery count'), 'count');
        const migrationRecoveryTotalCount = workstreamRun === null
            ? (repoId === 'global' ? sqlInteger(asRow(this.#db.prepare('SELECT COUNT(*) AS count FROM migration_recovery_work').get(), 'status recovery total count'), 'count') : sqlInteger(asRow(this.#db.prepare('SELECT COUNT(*) AS count FROM migration_recovery_work WHERE repo_id=?').get(repoId), 'status recovery total count'), 'count'))
            : sqlInteger(asRow(this.#db.prepare('SELECT COUNT(*) AS count FROM migration_recovery_work WHERE repo_id=? AND workstream_run=?').get(repoId, workstreamRun), 'status recovery total count'), 'count');
        return {
            committedEventSeq: null,
            payload: {
                schema_version: 'autopilot.coordinator_status.v1',
                package_build: COORDINATOR_PACKAGE_BUILD,
                protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
                database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION,
                repositories,
                runs,
                run_resources: runResources,
                session_leases: sessions,
                child_leases: children,
                unit_attempts: unitAttempts,
                acquisition_groups: acquisitionGroups,
                edit_leases: editLeases,
                change_reservations: changeReservations,
                reservation_obligations: reservationObligations,
                run_terminal_intents: runTerminalIntents,
                claim_requests: claimRequests,
                mailbox_cursors: mailboxCursors,
                reconciliation_evidence: reconciliationEvidence,
                worktrees,
                worktree_operations: worktreeOperations,
                wait_for_edges: waitForEdges,
                deadlock_resolutions: deadlockResolutions,
                authoritative_artifacts: authoritativeArtifacts,
                adjudication_assignments: adjudicationAssignments,
                escalations,
                coordination_migrations: migrations,
                coordination_migration_report_recovery_omitted: true,
                migration_recovery_work: migrationRecoveryWork,
                migration_recovery_work_complete: migrationRecoveryTotalCount === migrationRecoveryWork.length,
                migration_recovery_total_count: migrationRecoveryTotalCount,
                pending_migration_recovery_count: pendingMigrationRecoveryCount,
                pending_messages: pendingMessages,
            },
        };
    }
    runCatalog(repoId, workstreamRun, payload = {}) {
        const cursorValue = payload['cursor_run'];
        const cursorRun = cursorValue === undefined || cursorValue === null ? null : typeof cursorValue === 'string' ? cursorValue : (() => { throw new CoordinationRuntimeError('invalid-request', 'run catalog cursor_run must be nullable text'); })();
        const limitValue = payload['limit'];
        const limit = limitValue === undefined ? 128 : typeof limitValue === 'number' && Number.isSafeInteger(limitValue) && limitValue >= 1 && limitValue <= 256 ? limitValue : (() => { throw new CoordinationRuntimeError('invalid-request', 'run catalog limit must be an integer from 1 through 256'); })();
        if (workstreamRun !== null && cursorRun !== null)
            throw new CoordinationRuntimeError('invalid-request', 'exact run catalog query cannot carry a pagination cursor');
        const fetchedRuns = workstreamRun === null
            ? this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run>? ORDER BY workstream_run LIMIT ?').all(repoId, cursorRun ?? '', limit + 1).map(runFromRow)
            : this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=? ORDER BY workstream_run').all(repoId, workstreamRun).map(runFromRow);
        const fetchedResources = workstreamRun === null
            ? this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run>? ORDER BY workstream_run LIMIT ?').all(repoId, cursorRun ?? '', limit + 1).map(runResourceFromRow)
            : this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=? ORDER BY workstream_run').all(repoId, workstreamRun).map(runResourceFromRow);
        if (fetchedRuns.length !== fetchedResources.length || fetchedRuns.some((run, index) => fetchedResources[index]?.workstream_run !== run.workstream_run))
            throw new CoordinationRuntimeError('store-corrupt', 'run catalog and immutable run resources are not in exact lockstep');
        const hasMore = workstreamRun === null && fetchedRuns.length > limit;
        const runs = fetchedRuns.slice(0, limit);
        const resources = fetchedResources.slice(0, limit);
        const nextCursor = hasMore ? runs.at(-1)?.workstream_run ?? null : null;
        const pendingRows = workstreamRun === null
            ? this.#db.prepare("SELECT workstream_run, entity_id FROM migration_recovery_work WHERE repo_id=? AND status='pending' ORDER BY workstream_run, entity_id LIMIT 128").all(repoId)
            : this.#db.prepare("SELECT workstream_run, entity_id FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND status='pending' ORDER BY entity_id LIMIT 128").all(repoId, workstreamRun);
        const pendingCount = workstreamRun === null
            ? sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE repo_id=? AND status='pending'").get(repoId), 'run catalog pending recovery count'), 'count')
            : sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND status='pending'").get(repoId, workstreamRun), 'run catalog pending recovery count'), 'count');
        return { committedEventSeq: null, payload: { schema_version: 'autopilot.coordinator_run_catalog.v1', package_build: COORDINATOR_PACKAGE_BUILD, protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION, runs, run_resources: resources, next_cursor: nextCursor, pending_migration_recovery_count: pendingCount, pending_migration_recovery: pendingRows.map((row) => ({ workstream_run: sqlString(row, 'workstream_run'), recovery_id: sqlString(row, 'entity_id') })) } };
    }
    migrationRecovery(request) {
        const includeResolved = payloadBoolean(request.payload, 'include_resolved');
        const recoveryId = payloadNullableString(request.payload, 'recovery_id');
        const cursorRun = payloadNullableString(request.payload, 'cursor_run');
        const cursorRecoveryId = payloadNullableString(request.payload, 'cursor_recovery_id');
        const limit = payloadInteger(request.payload, 'limit');
        if ((cursorRun === null) !== (cursorRecoveryId === null))
            throw new CoordinationRuntimeError('invalid-request', 'migration recovery cursor requires both cursor_run and cursor_recovery_id');
        const pendingCount = request.repo_id === 'global'
            ? request.workstream_run === null
                ? sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE status='pending'").get(), 'migration recovery pending count'), 'count')
                : sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE workstream_run=? AND status='pending'").get(request.workstream_run), 'migration recovery pending count'), 'count')
            : request.workstream_run === null
                ? sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE repo_id=? AND status='pending'").get(request.repo_id), 'migration recovery pending count'), 'count')
                : sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND status='pending'").get(request.repo_id, request.workstream_run), 'migration recovery pending count'), 'count');
        let rows = request.repo_id === 'global'
            ? this.#db.prepare('SELECT * FROM migration_recovery_work ORDER BY repo_id, workstream_run, entity_id').all().map(migrationRecoveryFromRow)
            : this.#db.prepare('SELECT * FROM migration_recovery_work WHERE repo_id=? ORDER BY workstream_run, entity_id').all(request.repo_id).map(migrationRecoveryFromRow);
        if (request.workstream_run !== null)
            rows = rows.filter((work) => work.workstream_run === request.workstream_run);
        if (!includeResolved)
            rows = rows.filter((work) => work.status === 'pending');
        if (recoveryId !== null)
            rows = rows.filter((work) => work.recovery_id === recoveryId);
        if (cursorRun !== null && cursorRecoveryId !== null)
            rows = rows.filter((work) => work.workstream_run > cursorRun || (work.workstream_run === cursorRun && work.recovery_id > cursorRecoveryId));
        const page = rows.slice(0, limit);
        const next = rows.length > limit ? page.at(-1) ?? null : null;
        return {
            committedEventSeq: null,
            payload: {
                schema_version: 'autopilot.migration_recovery_query.v1',
                package_build: COORDINATOR_PACKAGE_BUILD,
                protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
                database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION,
                recovery: page,
                runs: request.workstream_run === null ? [] : this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').all(request.repo_id, request.workstream_run).map(runFromRow),
                pending_migration_recovery_count: pendingCount,
                next_cursor: next === null ? null : { cursor_run: next.workstream_run, cursor_recovery_id: next.recovery_id },
            },
        };
    }
    doctor() {
        const integrity = integrityResult(this.#db);
        const invariantFindings = this.#allInvariantFindings();
        const invariantErrors = invariantFindings.filter((finding) => finding.severity === 'error');
        const now = this.#clock.now().toISOString();
        const expired = this.#db.prepare("SELECT session_lease_id, repo_id, workstream_run, status, lease_expires_at FROM session_leases WHERE status IN ('attached','handoff-pending') AND lease_expires_at < ? ORDER BY repo_id, workstream_run").all(now).map((row) => ({
            session_lease_id: sqlString(row, 'session_lease_id'),
            repo_id: sqlString(row, 'repo_id'),
            workstream_run: sqlString(row, 'workstream_run'),
            status: sqlString(row, 'status'),
            lease_expires_at: sqlString(row, 'lease_expires_at'),
            classification: 'heartbeat-expired-recovery-check',
            write_authority_released: false,
        }));
        const expiredChildren = this.#db.prepare("SELECT child_lease_id, repo_id, workstream_run, lease_expires_at FROM child_leases WHERE status='running' AND lease_expires_at < ? ORDER BY repo_id, workstream_run, child_lease_id").all(now).map((row) => ({
            child_lease_id: sqlString(row, 'child_lease_id'),
            repo_id: sqlString(row, 'repo_id'),
            workstream_run: sqlString(row, 'workstream_run'),
            lease_expires_at: sqlString(row, 'lease_expires_at'),
            classification: 'heartbeat-expired-recovery-check',
            write_authority_released: false,
        }));
        const migrations = this.#db.prepare('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version').all().map((row) => ({ version: sqlInteger(row, 'version'), checksum: sqlString(row, 'checksum'), applied_at: sqlString(row, 'applied_at') }));
        const incompleteOperations = this.#db.prepare("SELECT * FROM worktree_operations WHERE json_extract(payload_json, '$.stage') NOT IN ('committed','compensated','failed') ORDER BY repo_id, workstream_run, entity_id").all().map(worktreeOperationFromRow);
        const pendingReservationObligations = this.#db.prepare("SELECT * FROM reservation_obligations WHERE json_extract(payload_json, '$.state') IN ('waiting-for-predecessor','integration-required') ORDER BY repo_id, workstream_run, entity_id").all().map(reservationObligationFromRow);
        const preparedRunTerminalIntents = this.#db.prepare("SELECT * FROM run_terminal_intents WHERE json_extract(payload_json, '$.state')='prepared' ORDER BY repo_id, workstream_run, entity_id").all().map(runTerminalIntentFromRow);
        const activeWaitForEdges = this.#db.prepare("SELECT * FROM wait_for_edges WHERE json_extract(payload_json, '$.state')='active' ORDER BY repo_id, entity_id").all().map(waitForEdgeFromRow);
        const openDeadlockResolutions = this.#db.prepare("SELECT * FROM deadlock_resolutions WHERE json_extract(payload_json, '$.state')!='resolved' ORDER BY repo_id, entity_id").all().map(deadlockResolutionFromRow);
        const pendingAdjudicationAssignments = this.#db.prepare("SELECT * FROM adjudication_assignments WHERE json_extract(payload_json, '$.state')='assigned' ORDER BY repo_id, entity_id").all().map(adjudicationAssignmentFromRow);
        const immutableEvidenceArtifactCount = sqlInteger(asRow(this.#db.prepare('SELECT COUNT(*) AS count FROM evidence_artifacts').get(), 'evidence artifact count'), 'count');
        const coordinationMigrations = this.#db.prepare('SELECT repo_id, migration_id, snapshot_sha256, journal_path, state, report_json, imported_at, updated_at, version FROM coordination_migrations ORDER BY repo_id').all().map(migrationRecordFromRow).map((migration) => {
            const report = migration['report'];
            if (typeof report !== 'object' || report === null || Array.isArray(report))
                throw new CoordinationRuntimeError('store-corrupt', 'coordination migration doctor report is not an object');
            return { ...migration, report: { ...report, recovery: [] } };
        });
        const pendingMigrationRecoveryCount = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE status='pending'").get(), 'pending migration recovery count'), 'count');
        const pendingMigrationRecovery = this.#db.prepare("SELECT * FROM migration_recovery_work WHERE status='pending' ORDER BY repo_id, workstream_run, entity_id LIMIT 128").all().map(migrationRecoveryFromRow);
        return {
            committedEventSeq: null,
            payload: {
                schema_version: 'autopilot.coordinator_doctor.v1',
                healthy: integrity === 'ok' && invariantErrors.length === 0,
                integrity,
                invariant_findings: invariantFindings,
                invariant_error_count: invariantErrors.length,
                database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION,
                migrations,
                expired_session_classifications: expired,
                expired_child_classifications: expiredChildren,
                last_backup_path: this.#lastBackupPath,
                last_startup_reconciliation: this.#lastStartupReconciliation,
                incomplete_worktree_operations: incompleteOperations,
                pending_reservation_obligations: pendingReservationObligations,
                prepared_run_terminal_intents: preparedRunTerminalIntents,
                active_wait_for_edges: activeWaitForEdges,
                open_deadlock_resolutions: openDeadlockResolutions,
                pending_adjudication_assignments: pendingAdjudicationAssignments,
                immutable_evidence_artifact_count: immutableEvidenceArtifactCount,
                coordination_migrations: coordinationMigrations,
                pending_migration_recovery_count: pendingMigrationRecoveryCount,
                pending_migration_recovery_work: pendingMigrationRecovery,
                max_grant_bypasses: MAX_GRANT_BYPASSES,
            },
        };
    }
    exportTo(outputPath) {
        const target = resolve(outputPath);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const tables = [
            ['repositories', 'repo_id'],
            ['runs', 'repo_id, workstream_run'],
            ['run_resources', 'repo_id, workstream_run'],
            ['session_leases', 'repo_id, workstream_run, session_generation, session_lease_id'],
            ['child_leases', 'repo_id, workstream_run, unit_id, attempt, child_lease_id'],
            ['unit_attempts', 'repo_id, workstream_run, entity_id'],
            ['acquisition_groups', 'repo_id, workstream_run, entity_id'],
            ['edit_leases', 'repo_id, workstream_run, entity_id'],
            ['change_reservations', 'repo_id, workstream_run, entity_id'],
            ['reservation_obligations', 'repo_id, workstream_run, entity_id'],
            ['run_terminal_intents', 'repo_id, workstream_run, entity_id'],
            ['claim_requests', 'repo_id, requester_workstream_run, owner_workstream_run, entity_id'],
            ['mailbox_cursors', 'repo_id, workstream_run'],
            ['reconciliation_evidence', 'repo_id, workstream_run, entity_id'],
            ['messages', 'repo_id, recipient_workstream_run, created_event_seq, message_id'],
            ['worktrees', 'repo_id, workstream_run, entity_id'],
            ['worktree_operations', 'repo_id, workstream_run, entity_id'],
            ['merge_operations', 'repo_id, workstream_run, entity_id'],
            ['wait_for_edges', 'repo_id, entity_id'],
            ['deadlock_resolutions', 'repo_id, entity_id'],
            ['authoritative_artifacts', 'repo_id, source_run, entity_id'],
            ['adjudication_assignments', 'repo_id, requesting_run, entity_id'],
            ['escalations', 'repo_id, entity_id'],
            ['handoffs', 'repo_id, workstream_run, created_event_seq, handoff_token'],
            ['events', 'repo_id, event_seq'],
            ['idempotency_results', 'repo_id, idempotency_key'],
            ['coordination_migrations', 'repo_id'],
            ['migration_recovery_work', 'repo_id, workstream_run, entity_id'],
            ['migration_legacy_audit', 'repo_id, source_kind, entity_id'],
            ['semantic_replays', 'replay_id'],
            ['schema_migrations', 'version'],
        ];
        const tableQueries = new Map(tables.map(([table, order]) => [table, `SELECT * FROM ${table} ORDER BY ${order}`]));
        tableQueries.set('evidence_artifacts', 'SELECT entity_id, repo_id, sha256, ref, label, size_bytes, created_event_seq, lower(hex(content)) AS content_hex FROM evidence_artifacts ORDER BY repo_id, created_event_seq, entity_id');
        const keys = ['schema_version', 'database_schema_version', ...tableQueries.keys()].sort((left, right) => left.localeCompare(right));
        const hash = createHash('sha256');
        const temporary = `${target}.tmp-${String(process.pid)}-${randomBytes(8).toString('hex')}`;
        const descriptor = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        let buffered = '';
        let bufferedBytes = 0;
        const flush = () => {
            if (buffered.length === 0)
                return;
            const bytes = Buffer.from(buffered, 'utf8');
            let offset = 0;
            while (offset < bytes.byteLength) {
                const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
                if (written < 1)
                    throw new CoordinationRuntimeError('system-fatal', 'coordinator export made no progress during a short write');
                offset += written;
            }
            buffered = '';
            bufferedBytes = 0;
        };
        const write = (chunk) => {
            hash.update(chunk, 'utf8');
            buffered += chunk;
            bufferedBytes += Buffer.byteLength(chunk, 'utf8');
            if (bufferedBytes >= 1024 * 1024)
                flush();
        };
        try {
            write('{');
            for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
                const key = keys[keyIndex];
                if (key === undefined)
                    continue;
                if (keyIndex > 0)
                    write(',');
                write(`${JSON.stringify(key)}:`);
                if (key === 'schema_version') {
                    write(JSON.stringify(DATABASE_EXPORT_SCHEMA));
                    continue;
                }
                if (key === 'database_schema_version') {
                    write(String(COORDINATOR_DATABASE_SCHEMA_VERSION));
                    continue;
                }
                const query = tableQueries.get(key);
                if (query === undefined)
                    throw new CoordinationRuntimeError('system-fatal', 'deterministic export table query is missing', [key]);
                write('[');
                let rowIndex = 0;
                for (const row of this.#db.prepare(query).iterate()) {
                    if (rowIndex > 0)
                        write(',');
                    write(canonicalJson(Object.fromEntries(Object.entries(row))));
                    rowIndex += 1;
                }
                write(']');
            }
            write('}');
            write('\n');
            flush();
            fsyncSync(descriptor);
        }
        catch (error) {
            closeSync(descriptor);
            unlinkSync(temporary);
            throw error;
        }
        closeSync(descriptor);
        if (platform() === 'win32')
            enforceWindowsPrivateAcl(temporary, false);
        else
            chmodSync(temporary, 0o600);
        renameSync(temporary, target);
        if (platform() !== 'win32') {
            const parent = openSync(dirname(target), fsConstants.O_RDONLY);
            try {
                fsyncSync(parent);
            }
            finally {
                closeSync(parent);
            }
        }
        return { committedEventSeq: null, payload: { schema_version: 'autopilot.coordinator_export_result.v1', output_path: target, sha256: `sha256:${hash.digest('hex')}` } };
    }
    attachRun(request) {
        return this.#mutation(request, () => {
            const workstreamRun = this.#workstreamRun(request);
            const resource = parseCoordinationRunResource(request.payload['run_resource']);
            if (coordinationCutoverCommitted(this.#stateRoot, request.repo_id) && payloadString(request.payload, 'coordination_authority') !== 'coordinator-edit-leases-v1')
                throw new CoordinationRuntimeError('unauthorized-client', 'post-cutover run attachment cannot create legacy coordination authority');
            if (resource.repo_id !== request.repo_id || resource.workstream_run !== workstreamRun)
                throw new CoordinationRuntimeError('invalid-request', 'run resource identity must match the attached repository/run');
            if (resource.source_repo !== payloadString(request.payload, 'canonical_root') || resource.git_common_dir !== payloadString(request.payload, 'git_common_dir'))
                throw new CoordinationRuntimeError('invalid-request', 'run resource repository identity disagrees with attach-run');
            const existingRepoRow = this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(request.repo_id);
            const existingRunRow = this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').get(request.repo_id, workstreamRun);
            if (existingRunRow !== undefined)
                throw new CoordinationRuntimeError('stale-version', 'run already exists; query status before attachment');
            if (request.expected_version !== 0)
                throw new CoordinationRuntimeError('stale-version', 'new run registration requires expected_version 0');
            const seq = existingRepoRow === undefined ? 1 : this.#nextEventSequence(request.repo_id);
            if (existingRepoRow === undefined) {
                this.#db.prepare('INSERT INTO repositories(repo_id, repo_key, canonical_root, git_common_dir, event_seq, created_event_seq, version) VALUES(?, ?, ?, ?, ?, ?, 1)').run(request.repo_id, payloadString(request.payload, 'repo_key'), payloadString(request.payload, 'canonical_root'), payloadString(request.payload, 'git_common_dir'), seq, seq);
            }
            else {
                const repository = repositoryFromRow(existingRepoRow);
                if (repository.repo_key !== payloadString(request.payload, 'repo_key') || repository.canonical_root !== payloadString(request.payload, 'canonical_root') || repository.git_common_dir !== payloadString(request.payload, 'git_common_dir')) {
                    throw new CoordinationRuntimeError('invalid-state', 'repository identity disagrees with its durable coordinator record');
                }
                this.#db.prepare('UPDATE repositories SET event_seq=? WHERE repo_id=?').run(seq, request.repo_id);
            }
            this.#db.prepare("INSERT INTO runs(repo_id, autopilot_id, workstream, workstream_run, coordination_authority, status, active_session_generation, created_event_seq, version) VALUES(?, ?, ?, ?, ?, 'active', 0, ?, 1)").run(request.repo_id, payloadString(request.payload, 'autopilot_id'), payloadString(request.payload, 'workstream'), workstreamRun, payloadString(request.payload, 'coordination_authority'), seq);
            this.#db.prepare('INSERT INTO run_resources(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(`run-resource:${request.repo_id}:${workstreamRun}`, request.repo_id, workstreamRun, canonicalJson(resource), resource.version);
            this.#db.prepare('INSERT INTO mailbox_cursors(repo_id, workstream_run, delivered_through_event_seq, acknowledged_through_event_seq, version) VALUES(?, ?, 0, 0, 1)').run(request.repo_id, workstreamRun);
            const run = runFromRow(asRow(this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').get(request.repo_id, workstreamRun), 'created run'));
            return { sequence: seq, eventType: 'run-attached', entityType: 'run', entityId: workstreamRun, payload: { run } };
        });
    }
    attachSession(request) {
        return this.#mutation(request, () => {
            const workstreamRun = this.#workstreamRun(request);
            const sessionId = this.#sessionId(request);
            const run = this.#requireRun(request.repo_id, workstreamRun);
            this.#assertVersion(run.version, request.expected_version, 'run');
            if (run.status === 'closed' || run.status === 'aborted')
                throw new CoordinationRuntimeError('invalid-state', `terminal run ${workstreamRun} cannot accept a new parent session`);
            const terminalPreparation = this.#preparedTerminalIntent(run.repo_id, run.workstream_run);
            const pendingRecovery = this.#pendingMigrationRecovery(request.repo_id, workstreamRun);
            if (pendingRecovery.length > 0)
                throw new CoordinationRuntimeError('recovery-required', `run ${workstreamRun} cannot attach ordinary dispatch while migration recovery is pending`, pendingRecovery.map((work) => work.recovery_id));
            const nextGeneration = run.active_session_generation + 1;
            if (request.fencing_generation !== nextGeneration)
                throw new CoordinationRuntimeError('stale-version', `next session generation must be ${String(nextGeneration)}`);
            const suppliedHandoffToken = payloadNullableString(request.payload, 'handoff_token');
            const pendingHandoff = suppliedHandoffToken === null
                ? this.#db.prepare("SELECT handoff_token FROM handoffs WHERE repo_id=? AND workstream_run=? AND status='pending' ORDER BY created_event_seq DESC LIMIT 1").get(request.repo_id, workstreamRun)
                : this.#db.prepare("SELECT handoff_token FROM handoffs WHERE handoff_token=? AND repo_id=? AND workstream_run=? AND status='pending'").get(suppliedHandoffToken, request.repo_id, workstreamRun);
            if (suppliedHandoffToken !== null && pendingHandoff === undefined)
                throw new CoordinationRuntimeError('fenced-session', 'handoff token is missing, consumed, or belongs to another run');
            const effectiveHandoffToken = pendingHandoff === undefined ? null : sqlString(pendingHandoff, 'handoff_token');
            const seq = this.#nextEventSequence(request.repo_id);
            this.#db.prepare("UPDATE session_leases SET status='fenced', version=version+1 WHERE repo_id=? AND workstream_run=? AND status='attached'").run(request.repo_id, workstreamRun);
            if (effectiveHandoffToken !== null) {
                this.#db.prepare("UPDATE session_leases SET status='detached', version=version+1 WHERE session_lease_id=(SELECT from_session_lease_id FROM handoffs WHERE handoff_token=?)").run(effectiveHandoffToken);
                this.#db.prepare("UPDATE handoffs SET status='consumed', consumed_event_seq=? WHERE handoff_token=?").run(seq, effectiveHandoffToken);
            }
            const sessionTokenSha256 = createHash('sha256').update(payloadString(request.payload, 'session_token'), 'utf8').digest('hex');
            this.#db.prepare("INSERT INTO session_leases(session_lease_id, repo_id, workstream_run, session_id, session_generation, pid, boot_id, session_token_sha256, lease_expires_at, status, attached_event_seq, version, attachment_kind) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, 1, 'dispatch')").run(payloadString(request.payload, 'session_lease_id'), request.repo_id, workstreamRun, sessionId, nextGeneration, payloadInteger(request.payload, 'pid'), payloadString(request.payload, 'boot_id'), sessionTokenSha256, payloadString(request.payload, 'lease_expires_at'), seq);
            this.#db.prepare('UPDATE runs SET active_session_generation=?, status=?, version=version+1 WHERE repo_id=? AND workstream_run=?').run(nextGeneration, terminalPreparation === null ? 'active' : 'merging', request.repo_id, workstreamRun);
            const nextRun = this.#requireRun(request.repo_id, workstreamRun);
            const session = sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(payloadString(request.payload, 'session_lease_id')), 'attached session'));
            const reconciliation = this.#reconcileOwnedRun(request.repo_id, workstreamRun, seq);
            return { sequence: seq, eventType: 'session-attached', entityType: 'session-lease', entityId: session.session_lease_id, payload: { run: nextRun, session, reconciliation } };
        });
    }
    attachTerminalRecovery(request) {
        return this.#mutation(request, () => {
            const workstreamRun = this.#workstreamRun(request);
            const sessionId = this.#sessionId(request);
            const run = this.#requireRun(request.repo_id, workstreamRun);
            this.#assertVersion(run.version, request.expected_version, 'terminal recovery run');
            if (run.status !== 'closed' && run.status !== 'aborted')
                throw new CoordinationRuntimeError('invalid-state', `nonterminal run ${workstreamRun} cannot accept a terminal-cleanup recovery attachment`);
            const intent = runTerminalIntentFromRow(asRow(this.#db.prepare("SELECT * FROM run_terminal_intents WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.state')='committed' ORDER BY entity_id LIMIT 1").get(request.repo_id, workstreamRun), 'committed terminal recovery intent'));
            if (intent.terminal_intent_id !== payloadString(request.payload, 'terminal_intent_id'))
                throw new CoordinationRuntimeError('unauthorized-client', 'terminal-cleanup recovery attachment does not match the committed terminal intent');
            if ((run.status === 'closed' ? 'closed' : 'aborted') !== intent.outcome)
                throw new CoordinationRuntimeError('store-corrupt', 'terminal run status disagrees with its committed terminal intent');
            const mainRows = this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.kind')='main' AND json_extract(payload_json, '$.owner.unit_id')='main'").all(request.repo_id, workstreamRun).map(worktreeFromRow);
            if (mainRows.length !== 1 || mainRows[0] === undefined)
                throw new CoordinationRuntimeError('store-corrupt', 'terminal-cleanup recovery requires exactly one durable main worktree');
            if (mainRows[0].state === 'removed')
                throw new CoordinationRuntimeError('invalid-state', 'terminal-cleanup recovery is already complete');
            const nextGeneration = run.active_session_generation + 1;
            if (request.fencing_generation !== nextGeneration)
                throw new CoordinationRuntimeError('stale-version', `next terminal recovery generation must be ${String(nextGeneration)}`);
            const seq = this.#nextEventSequence(request.repo_id);
            this.#db.prepare("UPDATE session_leases SET status='fenced', version=version+1 WHERE repo_id=? AND workstream_run=? AND status IN ('attached','handoff-pending')").run(request.repo_id, workstreamRun);
            const sessionTokenSha256 = createHash('sha256').update(payloadString(request.payload, 'session_token'), 'utf8').digest('hex');
            this.#db.prepare("INSERT INTO session_leases(session_lease_id, repo_id, workstream_run, session_id, session_generation, pid, boot_id, session_token_sha256, lease_expires_at, status, attached_event_seq, version, attachment_kind) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, 1, 'terminal-recovery')").run(payloadString(request.payload, 'session_lease_id'), request.repo_id, workstreamRun, sessionId, nextGeneration, payloadInteger(request.payload, 'pid'), payloadString(request.payload, 'boot_id'), sessionTokenSha256, payloadString(request.payload, 'lease_expires_at'), seq);
            this.#db.prepare('UPDATE runs SET active_session_generation=?, version=version+1 WHERE repo_id=? AND workstream_run=?').run(nextGeneration, request.repo_id, workstreamRun);
            const nextRun = this.#requireRun(request.repo_id, workstreamRun);
            const session = sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(payloadString(request.payload, 'session_lease_id')), 'attached terminal recovery session'));
            const reconciliation = this.#reconcileOwnedRun(request.repo_id, workstreamRun, seq);
            return { sequence: seq, eventType: 'terminal-cleanup-recovery-attached', entityType: 'session-lease', entityId: session.session_lease_id, payload: { run: nextRun, session, reconciliation, terminal_intent: intent } };
        });
    }
    attachMigrationRecovery(request) {
        return this.#mutation(request, () => {
            const workstreamRun = this.#workstreamRun(request);
            const sessionId = this.#sessionId(request);
            const run = this.#requireRun(request.repo_id, workstreamRun);
            this.#assertVersion(run.version, request.expected_version, 'migration recovery run');
            this.#requireCoordinatorEditAuthority(run, 'migration recovery attachment');
            const recoveryId = payloadString(request.payload, 'recovery_id');
            const exactPending = this.#db.prepare("SELECT entity_id FROM migration_recovery_work WHERE entity_id=? AND repo_id=? AND workstream_run=? AND status='pending'").get(recoveryId, request.repo_id, workstreamRun);
            if (exactPending === undefined)
                throw new CoordinationRuntimeError('invalid-state', 'migration recovery attachment requires the exact pending recovery row', [recoveryId]);
            const nextGeneration = run.active_session_generation + 1;
            if (request.fencing_generation !== nextGeneration)
                throw new CoordinationRuntimeError('stale-version', `next migration recovery generation must be ${String(nextGeneration)}`);
            const seq = this.#nextEventSequence(request.repo_id);
            this.#db.prepare("UPDATE session_leases SET status='fenced', version=version+1 WHERE repo_id=? AND workstream_run=? AND status IN ('attached','handoff-pending')").run(request.repo_id, workstreamRun);
            const sessionTokenSha256 = createHash('sha256').update(payloadString(request.payload, 'session_token'), 'utf8').digest('hex');
            this.#db.prepare("INSERT INTO session_leases(session_lease_id, repo_id, workstream_run, session_id, session_generation, pid, boot_id, session_token_sha256, lease_expires_at, status, attached_event_seq, version, attachment_kind) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, 1, 'migration-recovery')").run(payloadString(request.payload, 'session_lease_id'), request.repo_id, workstreamRun, sessionId, nextGeneration, payloadInteger(request.payload, 'pid'), payloadString(request.payload, 'boot_id'), sessionTokenSha256, payloadString(request.payload, 'lease_expires_at'), seq);
            this.#db.prepare('UPDATE runs SET active_session_generation=?, version=version+1 WHERE repo_id=? AND workstream_run=?').run(nextGeneration, request.repo_id, workstreamRun);
            const nextRun = this.#requireRun(request.repo_id, workstreamRun);
            const session = sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(payloadString(request.payload, 'session_lease_id')), 'attached migration recovery session'));
            const pendingRecoveryCount = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND status='pending'").get(request.repo_id, workstreamRun), 'migration recovery attachment pending count'), 'count');
            return { sequence: seq, eventType: 'migration-recovery-attached', entityType: 'session-lease', entityId: session.session_lease_id, payload: { run: nextRun, session, pending_recovery_count: pendingRecoveryCount } };
        });
    }
    resolveMigrationRecovery(request) {
        return this.#mutation(request, () => {
            const session = this.#requireCurrentSession(request);
            if (session.attachment_kind !== 'migration-recovery')
                throw new CoordinationRuntimeError('unauthorized-client', 'migration recovery resolution requires a recovery-only supervisor session');
            const recoveryId = payloadString(request.payload, 'recovery_id');
            const row = asRow(this.#db.prepare('SELECT * FROM migration_recovery_work WHERE entity_id=? AND repo_id=? AND workstream_run=?').get(recoveryId, request.repo_id, this.#workstreamRun(request)), 'migration recovery work');
            const work = migrationRecoveryFromRow(row);
            this.#assertVersion(work.version, request.expected_version, 'migration recovery work');
            if (work.status !== 'pending')
                throw new CoordinationRuntimeError('invalid-state', 'migration recovery work is already terminal; use the original idempotency key to replay its result', [recoveryId]);
            if (work.recovery_type !== 'ambiguous-live-claim')
                throw new CoordinationRuntimeError('recovery-required', `recovery type ${work.recovery_type} has no safe authority mutation`, [recoveryId]);
            const run = this.#requireRun(request.repo_id, work.workstream_run);
            const claim = this.#migrationRecoveryClaim(work);
            const leases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(request.repo_id, work.workstream_run).map(editLeaseFromRow).filter((lease) => lease.edit_lease_id === claim.editLeaseId && lease.owner.unit_id === claim.unitId && lease.owner.attempt === claim.attempt && lease.path === claim.path && lease.mode === claim.mode);
            if (leases.length !== 1 || leases[0] === undefined)
                throw new CoordinationRuntimeError('store-corrupt', 'pending migration recovery no longer has exactly one matching imported authority lease', [recoveryId, claim.editLeaseId]);
            const evidence = { ref: payloadString(request.payload, 'evidence_ref'), sha256: payloadString(request.payload, 'evidence_sha256') };
            const resolutionType = payloadString(request.payload, 'resolution_type');
            const releaseSourceValue = payloadNullableString(request.payload, 'release_source');
            const releaseTargetId = payloadNullableString(request.payload, 'release_target_id');
            const seq = this.#nextEventSequence(request.repo_id);
            let exactPostconditions;
            if (resolutionType === 'authority-retained') {
                if (releaseSourceValue !== null || releaseTargetId !== null)
                    throw new CoordinationRuntimeError('invalid-request', 'authority-retained recovery cannot carry release identity');
                if (run.status === 'closed' || run.status === 'aborted')
                    throw new CoordinationRuntimeError('invalid-state', 'terminal run authority cannot be retained or resurrected during migration recovery', [run.workstream_run]);
                const attempt = this.#requireUnitAttempt(run.repo_id, run.workstream_run, claim.unitId, claim.attempt);
                if (['transport-complete', 'merged', 'failed', 'reset', 'quarantined', 'superseded'].includes(attempt.state))
                    throw new CoordinationRuntimeError('invalid-state', 'terminal attempt authority cannot be retained or resurrected during migration recovery', [claim.unitId, String(claim.attempt), attempt.state]);
                this.#verifyMigrationRetentionEvidence(run, work, claim, evidence);
                exactPostconditions = Object.freeze([`run-status:${run.status}`, `attempt-state:${attempt.state}`, `edit-lease-retained:${claim.editLeaseId}`, `claim:${claim.mode}:${claim.path}`]);
            }
            else if (resolutionType === 'authority-released') {
                if (releaseSourceValue === null || releaseTargetId === null || releaseSourceValue === 'child-process')
                    throw new CoordinationRuntimeError('invalid-request', 'authority-released recovery requires an exact parent-owned release source and target');
                const releaseSource = releaseSourceValue;
                exactPostconditions = this.#verifyMigrationReleasePostconditions(run, work, claim, releaseSource, releaseTargetId, evidence);
                const released = [];
                this.#releaseOwnedLease(run.repo_id, run.workstream_run, claim.editLeaseId, released);
                if (released.length !== 1 || released[0] !== claim.editLeaseId)
                    throw new CoordinationRuntimeError('store-corrupt', 'exact migration authority lease was not released atomically', [claim.editLeaseId]);
            }
            else {
                throw new CoordinationRuntimeError('invalid-request', 'migration recovery resolution type is unsupported');
            }
            const immutableEvidenceBytes = this.#readMigrationRecoveryEvidenceFile(run, evidence);
            this.#persistEvidenceArtifact(run.repo_id, evidence, immutableEvidenceBytes, `migration recovery ${resolutionType}`, seq);
            const resolution = {
                resolution_type: resolutionType,
                evidence,
                release_source: releaseSourceValue,
                release_target_id: releaseTargetId,
                exact_postconditions: exactPostconditions,
            };
            const parsed = parseCoordinationMigrationRecoveryWork({ ...work, status: 'resolved', resolution, resolved_event_seq: seq, version: work.version + 1 });
            const updated = this.#db.prepare("UPDATE migration_recovery_work SET status='resolved', resolution_json=?, resolved_event_seq=?, version=? WHERE entity_id=? AND status='pending' AND version=?").run(canonicalJson(parsed.resolution), seq, parsed.version, parsed.recovery_id, work.version);
            if (updated.changes !== 1)
                throw new CoordinationRuntimeError('coordinator-contention', 'migration recovery work changed during fenced resolution', [recoveryId]);
            this.#db.prepare("UPDATE messages SET status='acknowledged', delivered_event_seq=COALESCE(delivered_event_seq, ?), acknowledged_event_seq=COALESCE(acknowledged_event_seq, ?), version=version+1 WHERE repo_id=? AND recipient_workstream_run=? AND correlation_id=? AND status!='acknowledged'").run(seq, seq, run.repo_id, run.workstream_run, recoveryId);
            this.#advanceMailboxCursor(run.repo_id, run.workstream_run, 'acknowledged');
            const remainingRecoveryCount = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND status='pending'").get(run.repo_id, run.workstream_run), 'remaining migration recovery count'), 'count');
            return { sequence: seq, eventType: 'migration-recovery-resolved', entityType: 'migration-recovery-work', entityId: recoveryId, payload: { recovery_work: parsed, remaining_recovery_count: remainingRecoveryCount, run: this.#requireRun(run.repo_id, run.workstream_run) } };
        });
    }
    detachSession(request) {
        return this.#sessionMutation(request, 'session-detached', (session) => {
            this.#db.prepare("UPDATE session_leases SET status='detached', version=version+1 WHERE session_lease_id=?").run(session.session_lease_id);
            return { entityId: session.session_lease_id, payload: { session: sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(session.session_lease_id), 'detached session')), reason: payloadString(request.payload, 'reason') } };
        });
    }
    prepareHandoff(request) {
        return this.#sessionMutation(request, 'session-handoff-prepared', (session, seq) => {
            const token = payloadString(request.payload, 'handoff_token');
            this.#db.prepare("UPDATE session_leases SET status='handoff-pending', version=version+1 WHERE session_lease_id=?").run(session.session_lease_id);
            this.#db.prepare("INSERT INTO handoffs(handoff_token, repo_id, workstream_run, from_session_lease_id, status, created_event_seq, consumed_event_seq) VALUES(?, ?, ?, ?, 'pending', ?, NULL)").run(token, request.repo_id, this.#workstreamRun(request), session.session_lease_id, seq);
            return { entityId: session.session_lease_id, payload: { handoff_token: token, session: sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(session.session_lease_id), 'handoff session')) } };
        });
    }
    heartbeatSession(request) {
        return this.#sessionMutation(request, 'session-heartbeat', (session, seq) => {
            this.#updateSessionHeartbeat.run(payloadString(request.payload, 'lease_expires_at'), session.session_lease_id);
            const reconciliation = this.#repositoryHasCoordinationGraph(request.repo_id)
                ? this.#reconcileOwnedRun(request.repo_id, session.workstream_run, seq)
                : this.#freezeReconciliationSummary(this.#emptyReconciliationSummary());
            return { entityId: session.session_lease_id, payload: { session: sessionFromRow(asRow(this.#sessionByLeaseId.get(session.session_lease_id), 'heartbeat session')), reconciliation } };
        });
    }
    registerAttempt(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
            this.#assertVersion(run.version, request.expected_version, 'run');
            if (this.#preparedTerminalIntent(run.repo_id, run.workstream_run) !== null)
                throw new CoordinationRuntimeError('invalid-state', 'run terminal preparation fences new attempt dispatch');
            const owner = { repo_id: run.repo_id, autopilot_id: run.autopilot_id, workstream_run: run.workstream_run, unit_id: payloadString(request.payload, 'unit_id'), attempt: payloadInteger(request.payload, 'attempt') };
            if (payloadInteger(request.payload, 'checkpoint_ordinal') !== 0)
                throw new CoordinationRuntimeError('invalid-request', 'attempt registration must begin at checkpoint ordinal 0');
            const attempt = { schema_version: 'autopilot.unit_attempt.v1', owner, state: 'preflight', role: payloadUnitRole(request.payload, 'role'), spec: { ref: payloadString(request.payload, 'spec_ref'), sha256: payloadString(request.payload, 'spec_sha256') }, preemptible: payloadBoolean(request.payload, 'preemptible'), checkpoint_ordinal: 0, critical_section: null, version: 1 };
            const existing = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(unitAttemptEntityId(owner));
            if (existing !== undefined) {
                this.#insertOrVerifyUnitAttempt(attempt);
                return { sequence: this.#nextEventSequence(run.repo_id), eventType: 'unit-attempt-verified', entityType: 'unit-attempt', entityId: unitAttemptEntityId(owner), payload: { unit_attempt: unitAttemptFromRow(existing) } };
            }
            const seq = this.#nextEventSequence(run.repo_id);
            this.#insertEntity('unit_attempts', unitAttemptEntityId(owner), owner.repo_id, owner.workstream_run, attempt);
            return { sequence: seq, eventType: 'unit-attempt-registered', entityType: 'unit-attempt', entityId: unitAttemptEntityId(owner), payload: { unit_attempt: attempt } };
        });
    }
    registerChild(request) {
        return this.#mutation(request, () => {
            const session = this.#requireCurrentSession(request);
            const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
            this.#assertVersion(run.version, request.expected_version, 'run');
            if (this.#preparedTerminalIntent(run.repo_id, run.workstream_run) !== null)
                throw new CoordinationRuntimeError('invalid-state', 'run terminal preparation fences new child registration');
            const childOwner = { repo_id: run.repo_id, autopilot_id: run.autopilot_id, workstream_run: run.workstream_run, unit_id: payloadString(request.payload, 'unit_id'), attempt: payloadInteger(request.payload, 'attempt') };
            if (payloadString(request.payload, 'autopilot_id') !== run.autopilot_id)
                throw new CoordinationRuntimeError('unauthorized-client', 'child autopilot identity does not match its durable run');
            const attempt = this.#requireUnitAttempt(childOwner.repo_id, childOwner.workstream_run, childOwner.unit_id, childOwner.attempt);
            if (attempt.state !== 'preflight')
                throw new CoordinationRuntimeError('invalid-state', `child registration requires a preflight attempt, not ${attempt.state}`);
            const seq = this.#nextEventSequence(request.repo_id);
            const childId = payloadString(request.payload, 'child_lease_id');
            const childTokenSha256 = createHash('sha256').update(payloadString(request.payload, 'child_token'), 'utf8').digest('hex');
            this.#db.prepare("INSERT INTO child_leases(child_lease_id, repo_id, autopilot_id, workstream_run, unit_id, attempt, pid, boot_id, child_token_sha256, lease_expires_at, status, terminal_evidence_ref, terminal_evidence_sha256, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, 1)").run(childId, request.repo_id, payloadString(request.payload, 'autopilot_id'), this.#workstreamRun(request), payloadString(request.payload, 'unit_id'), payloadInteger(request.payload, 'attempt'), payloadInteger(request.payload, 'pid'), payloadString(request.payload, 'boot_id'), childTokenSha256, payloadString(request.payload, 'lease_expires_at'));
            const runningAttempt = { ...attempt, state: 'running', version: attempt.version + 1 };
            this.#updateEntity('unit_attempts', unitAttemptEntityId(attempt.owner), runningAttempt);
            const child = childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'registered child'));
            return { sequence: seq, eventType: 'child-registered', entityType: 'child-lease', entityId: childId, payload: { child, authorizing_session_lease_id: session.session_lease_id } };
        });
    }
    heartbeatChild(request) {
        return this.#mutation(request, () => {
            const childId = payloadString(request.payload, 'child_lease_id');
            const childRow = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'child');
            const child = childFromRow(childRow);
            this.#assertChildAuthority(request, child, childRow);
            this.#assertVersion(child.version, request.expected_version, 'child lease');
            if (child.status !== 'running')
                throw new CoordinationRuntimeError('invalid-state', `child lease is ${child.status}`);
            const seq = this.#nextEventSequence(request.repo_id);
            this.#db.prepare('UPDATE child_leases SET lease_expires_at=?, version=version+1 WHERE child_lease_id=?').run(payloadString(request.payload, 'lease_expires_at'), childId);
            const victimKey = coordinationOwnerKey(child.owner);
            const preemptionRequested = this.#db.prepare("SELECT entity_id FROM deadlock_resolutions WHERE repo_id=? AND json_extract(payload_json, '$.state')='awaiting-recovery' AND json_extract(payload_json, '$.action')='request-reset-or-quarantine' AND json_extract(payload_json, '$.victim.repo_id')=? AND json_extract(payload_json, '$.victim.autopilot_id')=? AND json_extract(payload_json, '$.victim.workstream_run')=? AND json_extract(payload_json, '$.victim.unit_id')=? AND json_extract(payload_json, '$.victim.attempt')=? LIMIT 1").get(child.owner.repo_id, child.owner.repo_id, child.owner.autopilot_id, child.owner.workstream_run, child.owner.unit_id, child.owner.attempt) !== undefined;
            return { sequence: seq, eventType: 'child-heartbeat', entityType: 'child-lease', entityId: childId, payload: { child: childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'heartbeat child')), preemption_requested: preemptionRequested, victim_key: preemptionRequested ? victimKey : null } };
        });
    }
    checkpointChild(request) {
        return this.#mutation(request, () => {
            const childId = payloadString(request.payload, 'child_lease_id');
            const childRow = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'child');
            const child = childFromRow(childRow);
            this.#assertChildAuthority(request, child, childRow);
            this.#assertVersion(child.version, request.expected_version, 'child lease');
            if (child.status !== 'running')
                throw new CoordinationRuntimeError('invalid-state', `child lease is ${child.status}`);
            const attempt = this.#requireUnitAttempt(child.owner.repo_id, child.owner.workstream_run, child.owner.unit_id, child.owner.attempt);
            if (attempt.state !== 'running')
                throw new CoordinationRuntimeError('invalid-state', `child checkpoint requires a running attempt, not ${attempt.state}`);
            const checkpointOrdinal = payloadInteger(request.payload, 'checkpoint_ordinal');
            if (checkpointOrdinal !== attempt.checkpoint_ordinal + 1)
                throw new CoordinationRuntimeError('stale-version', 'child checkpoint ordinal must advance exactly one durable boundary at a time');
            const seq = this.#nextEventSequence(request.repo_id);
            const checkpointed = { ...attempt, checkpoint_ordinal: checkpointOrdinal, critical_section: payloadNullableString(request.payload, 'critical_section'), preemptible: payloadBoolean(request.payload, 'preemptible'), version: attempt.version + 1 };
            this.#updateEntity('unit_attempts', unitAttemptEntityId(attempt.owner), checkpointed);
            return { sequence: seq, eventType: 'unit-attempt-checkpointed', entityType: 'unit-attempt', entityId: unitAttemptEntityId(attempt.owner), payload: { child, unit_attempt: checkpointed } };
        });
    }
    completeChild(request) {
        return this.#mutation(request, () => {
            const childId = payloadString(request.payload, 'child_lease_id');
            const childRow = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'child');
            const child = childFromRow(childRow);
            this.#assertChildAuthority(request, child, childRow);
            this.#assertVersion(child.version, request.expected_version, 'child lease');
            if (child.status !== 'running')
                throw new CoordinationRuntimeError('invalid-state', `child lease is ${child.status}`);
            const status = payloadString(request.payload, 'status');
            const evidenceRef = payloadNullableString(request.payload, 'evidence_ref');
            const evidenceSha = payloadNullableString(request.payload, 'evidence_sha256');
            if (status === 'terminal' && (evidenceRef === null || evidenceSha === null || !SHA256_PATTERN.test(evidenceSha)))
                throw new CoordinationRuntimeError('invalid-request', 'terminal child completion requires immutable evidence');
            if (status === 'recovery-required' && (evidenceRef !== null || evidenceSha !== null))
                throw new CoordinationRuntimeError('invalid-request', 'recovery-required child completion must not claim terminal evidence');
            const seq = this.#nextEventSequence(request.repo_id);
            this.#db.prepare('UPDATE child_leases SET status=?, terminal_evidence_ref=?, terminal_evidence_sha256=?, version=version+1 WHERE child_lease_id=?').run(status, evidenceRef, evidenceSha, childId);
            if (status === 'recovery-required') {
                const attempt = this.#requireUnitAttempt(child.owner.repo_id, child.owner.workstream_run, child.owner.unit_id, child.owner.attempt);
                if (attempt.state === 'running')
                    this.#updateEntity('unit_attempts', unitAttemptEntityId(attempt.owner), { ...attempt, state: 'failed', critical_section: null, version: attempt.version + 1 });
            }
            if (status === 'terminal' && evidenceRef !== null && evidenceSha !== null) {
                this.#acceptReconciliationEvidence({
                    repoId: child.owner.repo_id,
                    workstreamRun: child.owner.workstream_run,
                    source: 'child-process',
                    targetId: child.child_lease_id,
                    evidence: { ref: evidenceRef, sha256: evidenceSha },
                    seq,
                });
                this.#updateAttemptForSatisfiedCondition(child.owner, 'child-terminal');
            }
            const reconciliation = this.#reconcileOwnedRun(request.repo_id, child.owner.workstream_run, seq);
            return { sequence: seq, eventType: status === 'terminal' ? 'child-terminal' : 'child-recovery-required', entityType: 'child-lease', entityId: childId, payload: { child: childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'completed child')), reconciliation } };
        });
    }
    acquireGroup(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
            this.#requireCoordinatorEditAuthority(run, 'acquisition-group creation');
            this.#assertVersion(run.version, request.expected_version, 'run');
            if (this.#preparedTerminalIntent(run.repo_id, run.workstream_run) !== null)
                throw new CoordinationRuntimeError('invalid-state', 'run terminal preparation fences new acquisition groups');
            const groupId = payloadString(request.payload, 'acquisition_group_id');
            if (this.#db.prepare('SELECT entity_id FROM acquisition_groups WHERE repo_id=? AND entity_id=?').get(request.repo_id, groupId) !== undefined)
                throw new CoordinationRuntimeError('stale-version', 'acquisition group already exists; retry with its original idempotency key or query status');
            const owner = {
                repo_id: request.repo_id,
                autopilot_id: run.autopilot_id,
                workstream_run: run.workstream_run,
                unit_id: payloadString(request.payload, 'unit_id'),
                attempt: payloadInteger(request.payload, 'attempt'),
            };
            const requestedLeases = payloadRequestedLeases(request.payload);
            const requestedRole = payloadUnitRole(request.payload, 'role');
            if (requestedRole !== 'implement' && requestedRole !== 'fix' && requestedLeases.some((lease) => lease.mode !== 'READ'))
                throw new CoordinationRuntimeError('invalid-request', `${requestedRole} units may acquire READ authority only`);
            const acquisitionKind = payloadAcquisitionKind(request.payload, 'acquisition_kind');
            const releaseCondition = payloadReleaseCondition(request.payload, 'normal_release_condition');
            const seq = this.#nextEventSequence(request.repo_id);
            const requestedCheckpointOrdinal = payloadInteger(request.payload, 'checkpoint_ordinal');
            const existingAttemptRow = this.#db.prepare('SELECT entity_id FROM unit_attempts WHERE entity_id=?').get(unitAttemptEntityId(owner));
            if (existingAttemptRow === undefined && requestedCheckpointOrdinal !== 0)
                throw new CoordinationRuntimeError('invalid-request', 'initial acquisition must begin at checkpoint ordinal 0');
            const attempt = {
                schema_version: 'autopilot.unit_attempt.v1', owner, state: 'preflight', role: requestedRole,
                spec: { ref: payloadString(request.payload, 'spec_ref'), sha256: payloadString(request.payload, 'spec_sha256') },
                preemptible: payloadBoolean(request.payload, 'preemptible'), checkpoint_ordinal: requestedCheckpointOrdinal, critical_section: null, version: 1,
            };
            this.#insertOrVerifyUnitAttempt(attempt);
            const priorGroups = this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(owner.repo_id, owner.workstream_run).map(acquisitionGroupFromRow).filter((candidate) => sameOwner(candidate.owner, owner));
            if (acquisitionKind === 'initial' && priorGroups.length > 0)
                throw new CoordinationRuntimeError('invalid-state', 'a unit attempt may declare exactly one immutable initial acquisition group');
            if (acquisitionKind === 'materialization-read-expansion') {
                if (!requestedLeases.every((lease) => lease.mode === 'READ'))
                    throw new CoordinationRuntimeError('invalid-request', 'materialization expansion may request READ authority only');
                const initial = priorGroups.find((candidate) => candidate.acquisition_kind === 'initial' || candidate.acquisition_kind === 'legacy-unknown');
                if (initial === undefined || (initial.state !== 'granted' && initial.state !== 'released'))
                    throw new CoordinationRuntimeError('invalid-state', 'materialization READ expansion requires a previously granted initial acquisition group');
            }
            this.#assertReleaseConditionOwner(releaseCondition, owner);
            const group = {
                schema_version: 'autopilot.acquisition_group.v2', acquisition_group_id: groupId, owner, acquisition_kind: acquisitionKind, requested_leases: requestedLeases,
                reason: payloadString(request.payload, 'reason'), normal_release_condition: releaseCondition, state: 'waiting', created_event_seq: seq, fairness_event_seq: seq,
                grant_event_seq: null, offer_expires_at: null, offer_count: 0, bypass_count: 0, version: 1,
            };
            this.#insertEntity('acquisition_groups', groupId, owner.repo_id, owner.workstream_run, group);
            const expiredOffers = this.#expireGrantOffers(request.repo_id, seq);
            if (expiredOffers)
                this.#reevaluateWaitingGroups(request.repo_id, seq);
            const currentGroup = expiredOffers ? this.#requireGroup(request.repo_id, groupId) : group;
            if (currentGroup.state === 'grant-ready') {
                const requests = this.#claimRequestsForGroup(request.repo_id, groupId);
                return { sequence: seq, eventType: 'acquisition-group-waiting', entityType: 'acquisition-group', entityId: groupId, payload: { outcome: 'waiting-for-peer-release', acquisition_group: currentGroup, claim_requests: requests, request_refs: requests.map((entry) => entry.request_id) } };
            }
            const blockers = this.#blockingLeases(owner.repo_id, requestedLeases);
            if (blockers.some((lease) => sameOwner(lease.owner, owner)))
                throw new CoordinationRuntimeError('invalid-state', 'new acquisition group redundantly overlaps authority already held by the same unit attempt');
            const offeredBlockers = this.#blockingGrantOffers(owner.repo_id, groupId, requestedLeases);
            if (blockers.length === 0 && offeredBlockers.length === 0) {
                const granted = this.#grantGroup(currentGroup, seq);
                this.#reevaluateWaitingGroups(request.repo_id, seq);
                return { sequence: seq, eventType: 'acquisition-group-granted', entityType: 'acquisition-group', entityId: groupId, payload: { outcome: 'granted', acquisition_group: granted.group, edit_leases: granted.leases, request_refs: [] } };
            }
            const requests = this.#ensureClaimRequests(currentGroup, blockers, seq);
            return { sequence: seq, eventType: 'acquisition-group-waiting', entityType: 'acquisition-group', entityId: groupId, payload: { outcome: 'waiting-for-peer-release', acquisition_group: currentGroup, claim_requests: requests, request_refs: requests.map((entry) => entry.request_id) } };
        });
    }
    acknowledgeGrant(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const groupId = payloadString(request.payload, 'acquisition_group_id');
            const group = this.#requireGroup(request.repo_id, groupId);
            this.#requireCoordinatorEditAuthority(this.#requireRun(group.owner.repo_id, group.owner.workstream_run), 'grant acknowledgement');
            this.#assertGroupOwner(request, group);
            if (this.#preparedTerminalIntent(group.owner.repo_id, group.owner.workstream_run) !== null)
                throw new CoordinationRuntimeError('invalid-state', 'run terminal preparation fences grant acknowledgement');
            this.#assertVersion(group.version, request.expected_version, 'acquisition group');
            const seq = this.#nextEventSequence(request.repo_id);
            const offerExpired = this.#expireGrantOffers(request.repo_id, seq);
            if (offerExpired) {
                this.#reevaluateWaitingGroups(request.repo_id, seq);
                const requeued = this.#requireGroup(request.repo_id, groupId);
                return { sequence: seq, eventType: 'grant-offer-expired', entityType: 'acquisition-group', entityId: groupId, payload: { outcome: 'offer-expired', acquisition_group: requeued, edit_leases: [] } };
            }
            const current = this.#requireGroup(request.repo_id, groupId);
            if (current.state !== 'grant-ready')
                throw new CoordinationRuntimeError('invalid-state', `acquisition group is ${current.state}, not grant-ready`);
            if (current.offer_expires_at === null || Date.parse(current.offer_expires_at) <= this.#clock.now().getTime())
                throw new CoordinationRuntimeError('stale-version', 'grant offer expired before requester preflight acknowledgement');
            if (this.#blockingLeases(request.repo_id, current.requested_leases).length > 0)
                throw new CoordinationRuntimeError('coordinator-contention', 'grant offer is no longer completely free');
            const granted = this.#grantGroup(current, seq);
            this.#db.prepare("UPDATE messages SET status='acknowledged', delivered_event_seq=COALESCE(delivered_event_seq, ?), acknowledged_event_seq=COALESCE(acknowledged_event_seq, ?), version=version+1 WHERE repo_id=? AND correlation_id=? AND message_type='grant-offer' AND status!='acknowledged'").run(seq, seq, request.repo_id, groupId);
            this.#advanceMailboxCursor(request.repo_id, current.owner.workstream_run, 'acknowledged');
            const groupRequests = this.#claimRequestsForGroup(request.repo_id, groupId);
            for (const claimRequest of groupRequests) {
                const next = { ...claimRequest, status: 'resolved', grant_event_seq: seq, version: claimRequest.version + 1 };
                this.#updateClaimRequest(next);
            }
            this.#reevaluateWaitingGroups(request.repo_id, seq);
            return { sequence: seq, eventType: 'acquisition-group-granted', entityType: 'acquisition-group', entityId: groupId, payload: { outcome: 'granted', acquisition_group: granted.group, edit_leases: granted.leases, request_refs: groupRequests.map((entry) => entry.request_id), grant_evidence: { acquisition_group_id: groupId, grant_event_seq: seq, lease_ids: granted.leases.map((entry) => entry.edit_lease_id) } } };
        });
    }
    respondClaimRequest(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const requestId = payloadString(request.payload, 'request_id');
            const claimRequest = this.#requireClaimRequest(requestId);
            this.#assertRequestOwner(request, claimRequest);
            this.#assertVersion(claimRequest.version, request.expected_version, 'claim request');
            if (!['pending', 'delivered', 'acknowledged', 'deferred'].includes(claimRequest.status))
                throw new CoordinationRuntimeError('invalid-state', `claim request is ${claimRequest.status}`);
            const seq = this.#nextEventSequence(request.repo_id);
            const offersExpired = this.#expireGrantOffers(request.repo_id, seq);
            if (payloadString(request.payload, 'response') === 'deferred') {
                const condition = payloadReleaseCondition(request.payload, 'release_condition');
                this.#assertReleaseConditionOwner(condition, claimRequest.owner);
                const deferred = { ...claimRequest, status: 'deferred', owner_reason: payloadString(request.payload, 'owner_reason'), release_condition: condition, version: claimRequest.version + 1 };
                this.#updateClaimRequest(deferred);
                const reconciliation = this.#reconcileOwnedRun(request.repo_id, claimRequest.owner.workstream_run, seq);
                if (offersExpired && reconciliation.offered_group_ids.length === 0)
                    this.#reevaluateWaitingGroups(request.repo_id, seq);
                return { sequence: seq, eventType: 'claim-request-deferred', entityType: 'claim-request', entityId: requestId, payload: { claim_request: this.#requireClaimRequest(requestId), reconciliation } };
            }
            const releasedLeaseIds = [];
            for (const leaseId of claimRequest.blocking_lease_ids) {
                const row = this.#db.prepare('SELECT * FROM edit_leases WHERE entity_id=?').get(leaseId);
                if (row === undefined)
                    continue;
                const lease = editLeaseFromRow(row);
                if (!sameOwner(lease.owner, claimRequest.owner))
                    throw new CoordinationRuntimeError('invalid-state', 'claim request blocking lease changed durable owner');
                this.#db.prepare('DELETE FROM edit_leases WHERE entity_id=?').run(leaseId);
                releasedLeaseIds.push(leaseId);
                this.#markGroupReleasedWhenEmpty(lease.owner.repo_id, lease.acquisition_group_id);
            }
            const releasedLeaseSet = new Set(releasedLeaseIds);
            const affectedRequests = this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? AND owner_workstream_run=? ORDER BY entity_id').all(request.repo_id, claimRequest.owner.workstream_run).map(claimRequestFromRow).filter((entry) => ['pending', 'delivered', 'acknowledged', 'deferred'].includes(entry.status) && (entry.request_id === requestId || entry.blocking_lease_ids.some((leaseId) => releasedLeaseSet.has(leaseId))));
            const notifications = [];
            for (const affected of affectedRequests) {
                const released = {
                    ...affected, status: 'released',
                    owner_reason: affected.request_id === requestId ? payloadNullableString(request.payload, 'owner_reason') : `owner authority released atomically with ${requestId}`,
                    release_condition: affected.release_condition, release_event_seq: seq, version: affected.version + 1,
                };
                this.#updateClaimRequest(released);
                const notification = this.#releaseNotification(released, releasedLeaseIds, seq);
                this.#insertMessage(notification);
                notifications.push(notification);
            }
            const primaryNotification = notifications.find((entry) => entry.correlation_id === requestId);
            if (primaryNotification === undefined)
                throw new CoordinationRuntimeError('store-corrupt', 'owner release did not transition its initiating claim request');
            this.#reevaluateWaitingGroups(request.repo_id, seq);
            return { sequence: seq, eventType: 'claim-request-released', entityType: 'claim-request', entityId: requestId, payload: { claim_request: this.#requireClaimRequest(requestId), released_lease_ids: releasedLeaseIds, release_notification: primaryNotification, affected_request_ids: affectedRequests.map((entry) => entry.request_id) } };
        });
    }
    cancelClaimRequest(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const claimRequest = this.#requireClaimRequest(payloadString(request.payload, 'request_id'));
            this.#assertRequestRequester(request, claimRequest);
            this.#assertVersion(claimRequest.version, request.expected_version, 'claim request');
            const group = this.#requireGroup(request.repo_id, claimRequest.acquisition_group_id);
            if (group.state === 'granted')
                throw new CoordinationRuntimeError('invalid-state', 'a granted acquisition group must release through its owner lifecycle');
            const seq = this.#nextEventSequence(request.repo_id);
            this.#cancelGroup(group, 'cancelled', seq);
            this.#reevaluateWaitingGroups(request.repo_id, seq);
            return { sequence: seq, eventType: 'claim-request-cancelled', entityType: 'claim-request', entityId: claimRequest.request_id, payload: { acquisition_group: this.#requireGroup(request.repo_id, group.acquisition_group_id), request_refs: this.#claimRequestsForGroup(request.repo_id, group.acquisition_group_id).map((entry) => entry.request_id), reason: payloadString(request.payload, 'reason') } };
        });
    }
    cancelAcquisitionGroup(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const group = this.#requireGroup(request.repo_id, payloadString(request.payload, 'acquisition_group_id'));
            this.#assertGroupOwner(request, group);
            this.#assertVersion(group.version, request.expected_version, 'acquisition group');
            const seq = this.#nextEventSequence(request.repo_id);
            this.#cancelGroup(group, 'cancelled', seq);
            this.#reevaluateWaitingGroups(request.repo_id, seq);
            return { sequence: seq, eventType: 'acquisition-group-cancelled', entityType: 'acquisition-group', entityId: group.acquisition_group_id, payload: { acquisition_group: this.#requireGroup(request.repo_id, group.acquisition_group_id), request_refs: this.#claimRequestsForGroup(request.repo_id, group.acquisition_group_id).map((entry) => entry.request_id), reason: payloadString(request.payload, 'reason') } };
        });
    }
    supersedeAttempt(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
            const unitId = payloadString(request.payload, 'unit_id');
            const attemptNumber = payloadInteger(request.payload, 'attempt');
            const attempt = this.#requireUnitAttempt(request.repo_id, run.workstream_run, unitId, attemptNumber);
            this.#assertVersion(attempt.version, request.expected_version, 'unit attempt');
            const seq = this.#nextEventSequence(request.repo_id);
            const groups = this.#groupsForAttempt(attempt.owner);
            if (groups.some((group) => group.state === 'granted'))
                throw new CoordinationRuntimeError('invalid-state', 'running/granted attempt must release or quarantine before supersession');
            for (const group of groups.filter((group) => group.state === 'waiting' || group.state === 'grant-ready'))
                this.#cancelGroup(group, 'superseded', seq);
            const superseded = { ...attempt, state: 'superseded', version: attempt.version + 1 };
            this.#updateEntity('unit_attempts', unitAttemptEntityId(attempt.owner), superseded);
            this.#reevaluateWaitingGroups(request.repo_id, seq);
            return { sequence: seq, eventType: 'unit-attempt-superseded', entityType: 'unit-attempt', entityId: unitAttemptEntityId(attempt.owner), payload: { unit_attempt: superseded, superseded_by_attempt: payloadInteger(request.payload, 'superseded_by_attempt'), reason: payloadString(request.payload, 'reason'), request_refs: groups.flatMap((group) => this.#claimRequestsForGroup(group.owner.repo_id, group.acquisition_group_id).map((entry) => entry.request_id)) } };
        });
    }
    registerAuthoritativeArtifact(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
            this.#assertVersion(run.version, request.expected_version, 'run');
            const sourceType = payloadString(request.payload, 'source_type');
            if (sourceType !== 'mission' && sourceType !== 'master-plan' && sourceType !== 'task')
                throw new CoordinationRuntimeError('invalid-request', 'authoritative artifact source_type is unsupported');
            const sourceScope = payloadString(request.payload, 'source_scope');
            if (sourceScope !== 'repository' && sourceScope !== 'run-main')
                throw new CoordinationRuntimeError('invalid-request', 'authoritative artifact source_scope is unsupported');
            const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'authoritative artifact repository'));
            const sourceRoot = sourceScope === 'repository' ? repository.canonical_root : this.#requireRunMainRoot(run.repo_id, run.workstream_run);
            const ref = payloadString(request.payload, 'ref');
            this.#evidencePathUnderRoot(sourceRoot, ref);
            const gitCommit = payloadString(request.payload, 'git_commit');
            const verifiedCommit = spawnSync('git', ['rev-parse', '--verify', `${gitCommit}^{commit}`], { cwd: sourceRoot, encoding: 'utf8', timeout: 30_000 });
            if (verifiedCommit.status !== 0 || verifiedCommit.stdout.trim() !== gitCommit)
                throw new CoordinationRuntimeError('invalid-request', 'authoritative artifact git_commit is not the exact verified commit in its registered source repository', [gitCommit, verifiedCommit.stderr.trim()]);
            const sourceHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', timeout: 30_000 });
            if (sourceHead.status !== 0 || sourceHead.stdout.trim() !== gitCommit)
                throw new CoordinationRuntimeError('invalid-request', 'authoritative artifact must be registered from the exact current source authority HEAD', [gitCommit, sourceHead.stdout.trim()]);
            const shown = spawnSync('git', ['show', `${gitCommit}:${ref}`], { cwd: sourceRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: MAX_COORDINATION_EVIDENCE_BYTES + 65_536 });
            if (shown.status !== 0)
                throw new CoordinationRuntimeError('invalid-request', 'authoritative artifact ref is not a blob at the immutable Git commit', [ref, shown.stderr.trim()]);
            const bytes = Buffer.from(shown.stdout, 'utf8');
            const evidence = { ref, sha256: payloadString(request.payload, 'sha256') };
            const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
            if (actual !== evidence.sha256)
                throw new CoordinationRuntimeError('invalid-request', 'authoritative artifact hash does not match immutable Git blob bytes', [evidence.sha256, actual]);
            const documentSchemaVersion = payloadString(request.payload, 'document_schema_version');
            validateAuthoritativeCoordinationDocument(sourceType, documentSchemaVersion, bytes);
            const artifactId = payloadString(request.payload, 'artifact_id');
            if (this.#db.prepare('SELECT entity_id FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(run.repo_id, artifactId) !== undefined)
                throw new CoordinationRuntimeError('stale-version', 'authoritative artifact id already exists');
            const seq = this.#nextEventSequence(run.repo_id);
            const artifact = { schema_version: 'autopilot.authoritative_artifact.v1', artifact_id: artifactId, repo_id: run.repo_id, source_run: run.workstream_run, source_type: sourceType, source_scope: sourceScope, document_schema_version: documentSchemaVersion, git_commit: gitCommit, evidence, registered_event_seq: seq, version: 1 };
            this.#db.prepare('INSERT INTO authoritative_artifacts(entity_id, repo_id, source_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(artifact.artifact_id, artifact.repo_id, artifact.source_run, canonicalJson(artifact), artifact.version);
            this.#persistEvidenceArtifact(run.repo_id, artifact.evidence, bytes, `authoritative ${sourceType}`, seq);
            return { sequence: seq, eventType: 'authoritative-artifact-registered', entityType: 'authoritative-artifact', entityId: artifact.artifact_id, payload: { authoritative_artifact: artifact } };
        });
    }
    assignAdjudication(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
            this.#assertVersion(run.version, request.expected_version, 'run');
            const proposed = parseCoordinationAdjudicationAssignment(request.payload['assignment']);
            if (proposed.repo_id !== run.repo_id || proposed.requesting_run !== run.workstream_run || !proposed.participating_runs.includes(run.workstream_run))
                throw new CoordinationRuntimeError('unauthorized-client', 'adjudication assignment must be requested by a participating durable run');
            if (proposed.state !== 'assigned' || proposed.adjudication !== null || proposed.child_lease_id !== null || proposed.assigned_event_seq !== 0 || proposed.accepted_event_seq !== null || proposed.version !== 1)
                throw new CoordinationRuntimeError('invalid-request', 'new adjudication assignment must use the canonical uncommitted assigned state');
            for (const participatingRun of proposed.participating_runs)
                this.#requireRun(run.repo_id, participatingRun);
            if (proposed.adjudicator.repo_id !== run.repo_id)
                throw new CoordinationRuntimeError('invalid-request', 'adjudicator repository identity must match the contradiction repository');
            if (proposed.participating_runs.includes(proposed.adjudicator.workstream_run))
                throw new CoordinationRuntimeError('invalid-request', 'adjudicator run must be independent from every participating run');
            const adjudicatorRun = this.#requireRun(run.repo_id, proposed.adjudicator.workstream_run);
            if (adjudicatorRun.autopilot_id !== proposed.adjudicator.autopilot_id)
                throw new CoordinationRuntimeError('invalid-request', 'adjudicator identity does not match its durable run');
            const attempt = this.#requireUnitAttempt(proposed.adjudicator.repo_id, proposed.adjudicator.workstream_run, proposed.adjudicator.unit_id, proposed.adjudicator.attempt);
            if (attempt.role !== 'adjudicate' || (attempt.state !== 'preflight' && attempt.state !== 'running'))
                throw new CoordinationRuntimeError('invalid-request', 'assignment requires a live durable adjudication-role attempt');
            const artifacts = proposed.authoritative_artifact_ids.map((artifactId) => authoritativeArtifactFromRow(asRow(this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(run.repo_id, artifactId), `authoritative artifact ${artifactId}`)));
            const artifactKeys = new Map(artifacts.map((artifact) => [`${artifact.evidence.ref}\0${artifact.evidence.sha256}`, artifact]));
            const artifactContents = new Map(artifacts.map((artifact) => [artifact.artifact_id, this.#loadEvidenceArtifact(run.repo_id, artifact.evidence)]));
            const totalArtifactBytes = [...artifactContents.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
            if (totalArtifactBytes > MAX_ADJUDICATION_BUNDLE_BYTES)
                throw new CoordinationRuntimeError('invalid-request', 'adjudication assignment authoritative bundle exceeds its bounded transport and review ceiling', [`size=${String(totalArtifactBytes)}`, `maximum=${String(MAX_ADJUDICATION_BUNDLE_BYTES)}`]);
            const clauseArtifactKeys = new Set(proposed.conflicting_clauses.map((clause) => `${clause.authoritative_ref.ref}\0${clause.authoritative_ref.sha256}`));
            if (artifactKeys.size !== clauseArtifactKeys.size || [...artifactKeys.keys()].some((key) => !clauseArtifactKeys.has(key)))
                throw new CoordinationRuntimeError('invalid-request', 'adjudication assignment authoritative artifacts must exactly equal its conflicting clause refs');
            if (artifacts.some((artifact) => !proposed.participating_runs.includes(artifact.source_run)))
                throw new CoordinationRuntimeError('invalid-request', 'every authoritative artifact must be registered by a participating run');
            for (const clause of proposed.conflicting_clauses) {
                const artifact = artifactKeys.get(`${clause.authoritative_ref.ref}\0${clause.authoritative_ref.sha256}`);
                if (artifact === undefined || artifact.source_run !== clause.source_run || artifact.source_type !== clause.source_type || artifact.source_scope !== clause.source_scope || artifact.document_schema_version !== clause.schema_version)
                    throw new CoordinationRuntimeError('invalid-request', 'contradiction clause does not exactly match its coordinator-registered authoritative artifact', [clause.clause_id]);
                const bytes = artifactContents.get(artifact.artifact_id);
                if (bytes === undefined)
                    throw new CoordinationRuntimeError('store-corrupt', 'registered authoritative artifact bytes disappeared');
                if (!Buffer.from(bytes).toString('utf8').includes(clause.exact_requirement))
                    throw new CoordinationRuntimeError('invalid-request', 'contradiction clause exact requirement is absent from its registered immutable artifact', [clause.clause_id]);
            }
            const outcomes = new Map();
            for (const clause of proposed.conflicting_clauses) {
                const values = outcomes.get(clause.artifact_or_invariant) ?? new Set();
                values.add(clause.demanded_outcome);
                outcomes.set(clause.artifact_or_invariant, values);
            }
            if (![...outcomes.values()].some((values) => values.size >= 2))
                throw new CoordinationRuntimeError('invalid-request', 'assignment clauses do not demand incompatible final outcomes for one artifact or invariant');
            if (this.#db.prepare('SELECT entity_id FROM adjudication_assignments WHERE repo_id=? AND entity_id=?').get(run.repo_id, proposed.assignment_id) !== undefined)
                throw new CoordinationRuntimeError('stale-version', 'adjudication assignment id already exists');
            const existingAttemptAssignment = this.#db.prepare("SELECT entity_id FROM adjudication_assignments WHERE repo_id=? AND json_extract(payload_json, '$.state')='assigned' AND json_extract(payload_json, '$.adjudicator.repo_id')=? AND json_extract(payload_json, '$.adjudicator.autopilot_id')=? AND json_extract(payload_json, '$.adjudicator.workstream_run')=? AND json_extract(payload_json, '$.adjudicator.unit_id')=? AND json_extract(payload_json, '$.adjudicator.attempt')=? LIMIT 1").get(run.repo_id, proposed.adjudicator.repo_id, proposed.adjudicator.autopilot_id, proposed.adjudicator.workstream_run, proposed.adjudicator.unit_id, proposed.adjudicator.attempt);
            if (existingAttemptAssignment !== undefined)
                throw new CoordinationRuntimeError('invalid-state', 'adjudication attempt already has a live coordinator assignment');
            const seq = this.#nextEventSequence(run.repo_id);
            const assignment = { ...proposed, assigned_event_seq: seq };
            this.#db.prepare('INSERT INTO adjudication_assignments(entity_id, repo_id, requesting_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(assignment.assignment_id, assignment.repo_id, assignment.requesting_run, canonicalJson(assignment), assignment.version);
            this.#insertMessage({ schema_version: 'autopilot.coordination_message.v1', message_id: stableEntityId('message', ['adjudication-assignment', assignment.repo_id, assignment.assignment_id]), repo_id: assignment.repo_id, recipient_workstream_run: assignment.adjudicator.workstream_run, message_type: 'adjudication-assignment', correlation_id: assignment.assignment_id, payload: { assignment_id: assignment.assignment_id, authoritative_artifact_ids: assignment.authoritative_artifact_ids, participating_runs: assignment.participating_runs }, status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1 });
            return { sequence: seq, eventType: 'adjudication-assigned', entityType: 'adjudication-assignment', entityId: assignment.assignment_id, payload: { adjudication_assignment: assignment } };
        });
    }
    claimAdjudicationAssignment(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
            this.#assertVersion(run.version, request.expected_version, 'run');
            const unitId = payloadString(request.payload, 'unit_id');
            const attempt = payloadInteger(request.payload, 'attempt');
            const assignments = this.#db.prepare("SELECT * FROM adjudication_assignments WHERE repo_id=? AND json_extract(payload_json, '$.state')='assigned' AND json_extract(payload_json, '$.adjudicator.workstream_run')=? AND json_extract(payload_json, '$.adjudicator.unit_id')=? AND json_extract(payload_json, '$.adjudicator.attempt')=? ORDER BY entity_id").all(run.repo_id, run.workstream_run, unitId, attempt).map(adjudicationAssignmentFromRow);
            if (assignments.length === 0)
                throw new CoordinationRuntimeError('invalid-state', 'adjudication attempt has no assigned planning contradiction');
            if (assignments.length !== 1)
                throw new CoordinationRuntimeError('store-corrupt', 'adjudication attempt has multiple simultaneous assignments', assignments.map((assignment) => assignment.assignment_id));
            const assignment = assignments[0];
            if (assignment === undefined)
                throw new CoordinationRuntimeError('invalid-state', 'adjudication assignment disappeared');
            const documents = assignment.authoritative_artifact_ids.map((artifactId) => {
                const artifact = authoritativeArtifactFromRow(asRow(this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(run.repo_id, artifactId), `authoritative artifact ${artifactId}`));
                const bytes = this.#loadEvidenceArtifact(run.repo_id, artifact.evidence);
                return { artifact, content_utf8: Buffer.from(bytes).toString('utf8') };
            });
            if (Buffer.byteLength(canonicalJson(documents), 'utf8') > MAX_ADJUDICATION_BUNDLE_BYTES * 3)
                throw new CoordinationRuntimeError('invalid-state', 'serialized adjudication bundle exceeds the coordinator frame safety ceiling');
            const seq = this.#nextEventSequence(run.repo_id);
            return { sequence: seq, eventType: 'adjudication-assignment-claimed', entityType: 'adjudication-assignment', entityId: assignment.assignment_id, payload: { adjudication_assignment: assignment, authoritative_documents: documents } };
        });
    }
    completeAdjudication(request) {
        return this.#mutation(request, () => {
            const childId = payloadString(request.payload, 'child_lease_id');
            const childRow = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'adjudicator child');
            const child = childFromRow(childRow);
            this.#assertChildAuthority(request, child, childRow);
            this.#assertVersion(child.version, request.expected_version, 'child lease');
            if (child.status !== 'running')
                throw new CoordinationRuntimeError('invalid-state', `adjudicator child lease is ${child.status}`);
            const assignmentId = payloadString(request.payload, 'assignment_id');
            const assignmentRow = asRow(this.#db.prepare('SELECT * FROM adjudication_assignments WHERE repo_id=? AND entity_id=?').get(request.repo_id, assignmentId), 'adjudication assignment');
            const assignment = adjudicationAssignmentFromRow(assignmentRow);
            if (assignment.state !== 'assigned' || !sameOwner(assignment.adjudicator, child.owner))
                throw new CoordinationRuntimeError('unauthorized-client', 'child is not the assigned independent adjudicator');
            const attempt = this.#requireUnitAttempt(child.owner.repo_id, child.owner.workstream_run, child.owner.unit_id, child.owner.attempt);
            if (attempt.role !== 'adjudicate' || attempt.state !== 'running')
                throw new CoordinationRuntimeError('invalid-state', 'adjudication completion requires the assigned running adjudication attempt');
            const unitWorktrees = this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.kind')='unit' AND json_extract(payload_json, '$.owner.unit_id')=? AND json_extract(payload_json, '$.owner.attempt')=? AND json_extract(payload_json, '$.state')!='removed' ORDER BY entity_id").all(child.owner.repo_id, child.owner.workstream_run, child.owner.unit_id, child.owner.attempt).map(worktreeFromRow);
            if (unitWorktrees.length !== 1)
                throw new CoordinationRuntimeError('invalid-state', 'adjudication evidence requires exactly one active durable adjudicator unit worktree');
            const unitWorktree = unitWorktrees[0];
            if (unitWorktree === undefined)
                throw new CoordinationRuntimeError('invalid-state', 'adjudicator unit worktree disappeared');
            const adjudicationPath = payloadString(request.payload, 'adjudication_path');
            const expectedPath = this.#evidencePathUnderRoot(unitWorktree.canonical_path, `adjudications/${assignment.assignment_id}.json`);
            let canonicalAdjudicationPath;
            try {
                canonicalAdjudicationPath = realpathSync(adjudicationPath);
            }
            catch (error) {
                throw new CoordinationRuntimeError('invalid-request', 'assigned adjudication output is unreadable', [adjudicationPath, error instanceof Error ? error.message : String(error)]);
            }
            if (canonicalAdjudicationPath !== realpathSync(expectedPath))
                throw new CoordinationRuntimeError('unauthorized-client', 'adjudication output path is not the assignment-derived path in the assigned unit worktree');
            const bytes = this.#readRegularEvidenceFile(expectedPath, 'assigned adjudication output');
            const adjudication = { ref: `adjudications/${assignment.assignment_id}.json`, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
            const documents = assignment.authoritative_artifact_ids.map((artifactId) => {
                const artifact = authoritativeArtifactFromRow(asRow(this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(assignment.repo_id, artifactId), `authoritative artifact ${artifactId}`));
                return { ref: artifact.evidence, bytes: this.#loadEvidenceArtifact(assignment.repo_id, artifact.evidence) };
            });
            const packet = { schema_version: 'autopilot.planning_contradiction.v1', escalation_id: assignment.assignment_id, repo_id: assignment.repo_id, participating_runs: assignment.participating_runs, authoritative_refs: documents.map((document) => document.ref), conflicting_clauses: assignment.conflicting_clauses, exhausted_alternatives: ['sequencing', 'partitioning', 'ownership-transfer', 'rebase-revalidation', 'replanning'], adjudication, decision_options: assignment.decision_options, created_event_seq: 0, version: 1 };
            const validated = validatePlanningContradictionSubmission({ packet, adjudicationBytes: bytes, authoritativeDocuments: documents });
            if (!sameOwner(validated.adjudication.adjudicator, assignment.adjudicator))
                throw new CoordinationRuntimeError('invalid-request', 'adjudication evidence identity does not exactly match the coordinator-assigned adjudicator');
            const seq = this.#nextEventSequence(assignment.repo_id);
            this.#persistEvidenceArtifact(assignment.repo_id, adjudication, bytes, 'assigned independent adjudication', seq);
            const accepted = { ...assignment, state: 'accepted', adjudication, child_lease_id: child.child_lease_id, accepted_event_seq: seq, version: assignment.version + 1 };
            this.#db.prepare('UPDATE adjudication_assignments SET payload_json=?, version=? WHERE repo_id=? AND entity_id=?').run(canonicalJson(accepted), accepted.version, accepted.repo_id, accepted.assignment_id);
            this.#db.prepare("UPDATE child_leases SET status='terminal', terminal_evidence_ref=?, terminal_evidence_sha256=?, version=version+1 WHERE child_lease_id=?").run(adjudication.ref, adjudication.sha256, child.child_lease_id);
            const adjudicatorRun = this.#requireRun(child.owner.repo_id, child.owner.workstream_run);
            const releasedLeaseIds = this.#releaseAttemptLeases(adjudicatorRun, `${child.owner.unit_id}:${String(child.owner.attempt)}`);
            this.#updateAttemptForSatisfiedCondition(child.owner, 'child-terminal');
            this.#reevaluateWaitingGroups(child.owner.repo_id, seq);
            return { sequence: seq, eventType: 'adjudication-accepted', entityType: 'adjudication-assignment', entityId: accepted.assignment_id, payload: { adjudication_assignment: accepted, child: childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(child.child_lease_id), 'completed adjudicator child')), released_lease_ids: releasedLeaseIds } };
        });
    }
    submitPlanningContradiction(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
            this.#assertVersion(run.version, request.expected_version, 'run');
            const submitted = parseCoordinationEscalation(request.payload['packet']);
            if (submitted.repo_id !== run.repo_id || !submitted.participating_runs.includes(run.workstream_run))
                throw new CoordinationRuntimeError('unauthorized-client', 'planning contradiction must include the submitting durable run');
            if (submitted.created_event_seq !== 0 || submitted.version !== 1)
                throw new CoordinationRuntimeError('invalid-request', 'new planning contradiction packet must use created_event_seq 0 and version 1 before coordinator commit');
            for (const participatingRun of submitted.participating_runs)
                this.#requireRun(run.repo_id, participatingRun);
            const assignmentId = payloadString(request.payload, 'assignment_id');
            const assignment = adjudicationAssignmentFromRow(asRow(this.#db.prepare('SELECT * FROM adjudication_assignments WHERE repo_id=? AND entity_id=?').get(run.repo_id, assignmentId), 'accepted adjudication assignment'));
            if (assignment.state !== 'accepted' || assignment.adjudication === null || assignment.child_lease_id === null)
                throw new CoordinationRuntimeError('invalid-state', 'planning contradiction requires an accepted coordinator-assigned adjudication result');
            if (assignment.assignment_id !== submitted.escalation_id || canonicalJson(assignment.participating_runs) !== canonicalJson(submitted.participating_runs) || canonicalJson(assignment.conflicting_clauses) !== canonicalJson(submitted.conflicting_clauses) || canonicalJson(assignment.decision_options) !== canonicalJson(submitted.decision_options) || canonicalJson(assignment.adjudication) !== canonicalJson(submitted.adjudication))
                throw new CoordinationRuntimeError('invalid-request', 'planning contradiction packet does not exactly match its accepted adjudication assignment');
            const child = childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(assignment.child_lease_id), 'accepted adjudicator child'));
            if (!sameOwner(child.owner, assignment.adjudicator) || child.status !== 'terminal' || child.terminal_evidence === null || canonicalJson(child.terminal_evidence) !== canonicalJson(assignment.adjudication))
                throw new CoordinationRuntimeError('store-corrupt', 'accepted adjudication is not bound to exact terminal child evidence');
            const authoritativeDocuments = assignment.authoritative_artifact_ids.map((artifactId) => {
                const artifact = authoritativeArtifactFromRow(asRow(this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(run.repo_id, artifactId), `authoritative artifact ${artifactId}`));
                return { ref: artifact.evidence, bytes: this.#loadEvidenceArtifact(run.repo_id, artifact.evidence) };
            });
            if (canonicalJson(authoritativeDocuments.map((document) => document.ref)) !== canonicalJson(submitted.authoritative_refs))
                throw new CoordinationRuntimeError('invalid-request', 'planning contradiction authoritative refs do not exactly match the assigned registered artifacts');
            const adjudicationBytes = this.#loadEvidenceArtifact(run.repo_id, assignment.adjudication);
            const validated = validatePlanningContradictionSubmission({ packet: submitted, adjudicationBytes, authoritativeDocuments });
            const duplicate = this.#db.prepare("SELECT entity_id FROM escalations WHERE repo_id=? AND json_extract(payload_json, '$.adjudication.sha256')=? LIMIT 1").get(run.repo_id, submitted.adjudication.sha256);
            if (duplicate !== undefined)
                throw new CoordinationRuntimeError('invalid-state', 'independent adjudication evidence already created a planning contradiction packet');
            const seq = this.#nextEventSequence(run.repo_id);
            const packet = { ...validated.packet, created_event_seq: seq };
            this.#db.prepare('INSERT INTO escalations(entity_id, repo_id, payload_json, version) VALUES(?, ?, ?, ?)').run(stableEntityId('escalation', [packet.repo_id, packet.escalation_id]), packet.repo_id, canonicalJson(packet), packet.version);
            return { sequence: seq, eventType: 'planning-contradiction-accepted', entityType: 'escalation', entityId: packet.escalation_id, payload: { escalation: packet, failure_code: 'planning-contradiction-review' } };
        });
    }
    recordReleaseEvidence(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const workstreamRun = this.#workstreamRun(request);
            const run = this.#requireRun(request.repo_id, workstreamRun);
            this.#assertVersion(run.version, request.expected_version, 'run');
            const source = this.#reconciliationSource(payloadString(request.payload, 'source'));
            const conditionType = this.#conditionTypeForSource(source);
            const targetId = payloadString(request.payload, 'target_id');
            this.#assertReconciliationTarget(run, conditionType, targetId);
            const seq = this.#nextEventSequence(request.repo_id);
            const evidenceRef = payloadString(request.payload, 'evidence_ref');
            const evidenceSha256 = payloadString(request.payload, 'evidence_sha256');
            const evidence = this.#acceptReconciliationEvidence({
                repoId: request.repo_id,
                workstreamRun,
                source,
                targetId,
                evidence: { ref: evidenceRef, sha256: evidenceSha256 },
                seq,
            });
            let convertedReservations = [];
            let createdObligations = [];
            if (source === 'unit-merge') {
                this.#requireCoordinatorEditAuthority(run, 'unit-merge reservation conversion');
                const converted = this.#convertUnitMergeToReservations(run, targetId, { ref: evidenceRef, sha256: evidenceSha256 }, seq);
                convertedReservations = converted.reservations;
                createdObligations = converted.obligations;
            }
            if (source === 'run-close')
                this.#assertRunCloseReservationReady(run);
            if (source === 'run-close' || source === 'run-abort')
                this.#assertRunTerminalExternalReady(run);
            const terminalIntent = source === 'run-close' || source === 'run-abort' ? this.#assertPreparedTerminalIntent(run, source) : null;
            this.#updateAttemptFromEvidence(run, conditionType, targetId);
            const terminalSha = source === 'run-close' || source === 'run-abort' ? parseRunTerminalSha(this.#verifyAcceptedEvidenceFile(run, source, targetId, { ref: evidenceRef, sha256: evidenceSha256 })) : null;
            if (terminalSha !== null && (source === 'run-close' || source === 'run-abort'))
                this.#assertRunTerminalGitFacts(run, source, terminalSha);
            const directlyReleasedLeaseIds = [];
            if (source === 'attempt-reset' || source === 'quarantine-capture')
                directlyReleasedLeaseIds.push(...this.#releaseAttemptLeases(run, targetId));
            let nextRun = run;
            if (conditionType === 'run-closed' && run.status !== 'closed' && run.status !== 'aborted') {
                const terminalStatus = source === 'run-abort' ? 'aborted' : 'closed';
                this.#db.prepare('UPDATE runs SET status=?, version=version+1 WHERE repo_id=? AND workstream_run=?').run(terminalStatus, run.repo_id, run.workstream_run);
                nextRun = this.#requireRun(run.repo_id, run.workstream_run);
                if (terminalSha === null)
                    throw new CoordinationRuntimeError('invalid-state', 'run terminal transition lost its verified terminal commit');
                this.#terminalizeRunReservations(nextRun, source === 'run-abort' ? 'run-abort' : 'run-close', terminalSha, seq);
                directlyReleasedLeaseIds.push(...this.#releaseAllRunLeases(nextRun));
                if (terminalIntent !== null)
                    this.#commitTerminalIntent(terminalIntent, seq);
            }
            const reconciled = this.#reconcileOwnedRun(request.repo_id, workstreamRun, seq);
            const reconciliation = this.#freezeReconciliationSummary({ ...reconciled, released_lease_ids: [...directlyReleasedLeaseIds, ...reconciled.released_lease_ids] });
            return { sequence: seq, eventType: 'release-evidence-accepted', entityType: 'reconciliation-evidence', entityId: evidence.reconciliation_evidence_id, payload: { reconciliation_evidence: evidence, run: nextRun, reconciliation, change_reservations: convertedReservations, reservation_obligations: createdObligations } };
        });
    }
    resolveReservationObligation(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const workstreamRun = this.#workstreamRun(request);
            const run = this.#requireRun(request.repo_id, workstreamRun);
            this.#requireCoordinatorEditAuthority(run, 'reservation resolution');
            const obligationId = payloadString(request.payload, 'obligation_id');
            const obligation = reservationObligationFromRow(asRow(this.#db.prepare('SELECT * FROM reservation_obligations WHERE repo_id=? AND entity_id=?').get(request.repo_id, obligationId), 'reservation obligation'));
            this.#assertVersion(obligation.version, request.expected_version, 'reservation obligation');
            if (obligation.workstream_run !== workstreamRun)
                throw new CoordinationRuntimeError('unauthorized-client', 'session cannot resolve a foreign-run reservation obligation');
            if ((obligation.state !== 'integration-required' && obligation.state !== 'resolved') || obligation.predecessor_released_event_seq === null || obligation.predecessor_terminal_sha === null)
                throw new CoordinationRuntimeError('invalid-state', `reservation obligation is ${obligation.state} without refreshable predecessor landing authority`);
            const dependentReservation = changeReservationFromRow(asRow(this.#db.prepare('SELECT * FROM change_reservations WHERE repo_id=? AND entity_id=?').get(run.repo_id, obligation.reservation_id), 'dependent reservation'));
            const dependentTarget = parseUnitAttemptTarget(this.#targetIdForMergeEvidence(run, dependentReservation.merge_evidence));
            const identity = {
                repoId: run.repo_id,
                autopilotId: run.autopilot_id,
                workstream: run.workstream,
                workstreamRun: run.workstream_run,
                obligationId: obligation.obligation_id,
                reservationId: obligation.reservation_id,
                predecessorReservationId: obligation.predecessor_reservation_id,
                predecessorReleasedEventSeq: obligation.predecessor_released_event_seq,
                predecessorTerminalSha: obligation.predecessor_terminal_sha,
                dependentUnitId: dependentTarget.unitId,
                dependentAttempt: dependentTarget.attempt,
                dependentMergeRef: dependentReservation.merge_evidence.ref,
                overlappingPaths: obligation.overlapping_paths,
            };
            const integrationEvidence = { ref: payloadString(request.payload, 'integration_evidence_ref'), sha256: payloadString(request.payload, 'integration_evidence_sha256') };
            const validationEvidence = { ref: payloadString(request.payload, 'validation_evidence_ref'), sha256: payloadString(request.payload, 'validation_evidence_sha256') };
            const integrationBytes = this.#readRunEvidenceFile(run, integrationEvidence);
            const integrationHead = validateReservationIntegrationEvidenceDocument(integrationBytes, identity);
            this.#assertReservationIntegrationGitFacts(run, obligation.predecessor_terminal_sha, integrationHead, obligation.overlapping_paths, true);
            const validationBytes = this.#readRunEvidenceFile(run, validationEvidence);
            const validationFacts = validateReservationValidationEvidenceDocument(validationBytes, identity, integrationHead);
            this.#assertReservationValidationArtifactChain(run, validationEvidence.ref, validationFacts);
            const seq = this.#nextEventSequence(request.repo_id);
            const resolved = parseCoordinationReservationObligation({ ...obligation, state: 'resolved', integration_evidence: integrationEvidence, validation_evidence: validationEvidence, resolved_event_seq: seq, version: obligation.version + 1 });
            this.#updateReservationObligation(resolved);
            return { sequence: seq, eventType: 'reservation-obligation-resolved', entityType: 'reservation-obligation', entityId: obligationId, payload: { reservation_obligation: resolved } };
        });
    }
    prepareRunTerminal(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
            this.#requireCoordinatorEditAuthority(run, 'run terminal preparation');
            this.#assertVersion(run.version, request.expected_version, 'run');
            if (this.#preparedTerminalIntent(run.repo_id, run.workstream_run) !== null)
                throw new CoordinationRuntimeError('coordinator-contention', 'run already has a prepared terminal intent');
            const outcomeValue = payloadString(request.payload, 'outcome');
            if (outcomeValue !== 'closed' && outcomeValue !== 'aborted')
                throw new CoordinationRuntimeError('invalid-request', 'terminal outcome must be closed or aborted');
            // Readiness is deliberately checked at terminal commit, not here. This
            // transaction must always establish the durable launch fence first; close
            // validation can then classify/cancel safely without a concurrent dispatch.
            const seq = this.#nextEventSequence(run.repo_id);
            const reservationIds = this.#db.prepare("SELECT entity_id FROM change_reservations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.released_event_seq') IS NULL ORDER BY entity_id").all(run.repo_id, run.workstream_run).map((row) => sqlString(row, 'entity_id'));
            const intent = parseCoordinationRunTerminalIntent({ schema_version: 'autopilot.run_terminal_intent.v1', terminal_intent_id: payloadString(request.payload, 'terminal_intent_id'), repo_id: run.repo_id, workstream_run: run.workstream_run, outcome: outcomeValue, state: 'prepared', reservation_ids: reservationIds, prepared_event_seq: seq, terminal_event_seq: null, version: 1 });
            const nextRun = parseCoordinationRun({ ...run, status: 'merging', version: run.version + 1 });
            this.#db.prepare('INSERT INTO run_terminal_intents(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(intent.terminal_intent_id, intent.repo_id, intent.workstream_run, canonicalJson(intent), intent.version);
            this.#db.prepare("UPDATE runs SET status='merging', version=? WHERE repo_id=? AND workstream_run=?").run(nextRun.version, run.repo_id, run.workstream_run);
            return { sequence: seq, eventType: 'run-terminal-prepared', entityType: 'run-terminal-intent', entityId: intent.terminal_intent_id, payload: { run_terminal_intent: intent, run: nextRun } };
        });
    }
    cancelRunTerminal(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const intent = runTerminalIntentFromRow(asRow(this.#db.prepare('SELECT * FROM run_terminal_intents WHERE repo_id=? AND entity_id=?').get(request.repo_id, payloadString(request.payload, 'terminal_intent_id')), 'run terminal intent'));
            if (intent.workstream_run !== this.#workstreamRun(request))
                throw new CoordinationRuntimeError('unauthorized-client', 'session cannot cancel a foreign run terminal intent');
            const run = this.#requireRun(request.repo_id, intent.workstream_run);
            this.#assertVersion(intent.version, request.expected_version, 'run terminal intent');
            if (intent.state !== 'prepared')
                throw new CoordinationRuntimeError('invalid-state', `run terminal intent is ${intent.state}`);
            const seq = this.#nextEventSequence(request.repo_id);
            const cancelled = parseCoordinationRunTerminalIntent({ ...intent, state: 'cancelled', terminal_event_seq: seq, version: intent.version + 1 });
            const nextRun = parseCoordinationRun({ ...run, status: 'blocked', version: run.version + 1 });
            this.#db.prepare('UPDATE run_terminal_intents SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(cancelled), cancelled.version, cancelled.terminal_intent_id);
            this.#db.prepare("UPDATE runs SET status='blocked', version=? WHERE repo_id=? AND workstream_run=?").run(nextRun.version, run.repo_id, run.workstream_run);
            return { sequence: seq, eventType: 'run-terminal-cancelled', entityType: 'run-terminal-intent', entityId: cancelled.terminal_intent_id, payload: { run_terminal_intent: cancelled, run: nextRun, reason: payloadString(request.payload, 'reason') } };
        });
    }
    reconcileRun(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const workstreamRun = this.#workstreamRun(request);
            const run = this.#requireRun(request.repo_id, workstreamRun);
            this.#assertVersion(run.version, request.expected_version, 'run');
            const seq = this.#nextEventSequence(request.repo_id);
            const reconciliation = this.#reconcileOwnedRun(request.repo_id, workstreamRun, seq);
            return { sequence: seq, eventType: 'run-reconciled', entityType: 'run', entityId: workstreamRun, payload: { run, reconciliation, reason: payloadString(request.payload, 'reason') } };
        });
    }
    drainMailbox(request) {
        return this.#sessionMutation(request, 'mailbox-drained', (session, seq) => {
            const workstreamRun = this.#workstreamRun(request);
            this.#db.prepare("UPDATE messages SET status='delivered', delivered_event_seq=COALESCE(delivered_event_seq, ?), version=version+1 WHERE repo_id=? AND recipient_workstream_run=? AND status='pending'").run(seq, request.repo_id, workstreamRun);
            this.#advanceMailboxCursor(request.repo_id, workstreamRun, 'delivered');
            const messages = this.#db.prepare("SELECT * FROM messages WHERE repo_id=? AND recipient_workstream_run=? AND status='delivered' ORDER BY created_event_seq, message_id").all(request.repo_id, workstreamRun).map(messageFromRow);
            for (const message of messages) {
                if (message.message_type !== 'claim-request')
                    continue;
                const claimRequest = this.#requireClaimRequest(message.correlation_id);
                if (claimRequest.status === 'pending')
                    this.#updateClaimRequest({ ...claimRequest, status: 'delivered', version: claimRequest.version + 1 });
            }
            return { entityId: payloadString(request.payload, 'delivery_id'), payload: { delivery_id: payloadString(request.payload, 'delivery_id'), session_version: session.version, mailbox_cursor: this.#requireMailboxCursor(request.repo_id, workstreamRun), messages } };
        });
    }
    acknowledgeMessage(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const messageId = payloadString(request.payload, 'message_id');
            const message = messageFromRow(asRow(this.#db.prepare('SELECT * FROM messages WHERE message_id=?').get(messageId), 'message'));
            if (message.repo_id !== request.repo_id || message.recipient_workstream_run !== this.#workstreamRun(request))
                throw new CoordinationRuntimeError('unauthorized-client', 'session does not own mailbox message');
            this.#assertVersion(message.version, request.expected_version, 'message');
            if (message.status !== 'delivered')
                throw new CoordinationRuntimeError('invalid-state', `message is ${message.status}`);
            const seq = this.#nextEventSequence(request.repo_id);
            this.#db.prepare("UPDATE messages SET status='acknowledged', acknowledged_event_seq=?, version=version+1 WHERE message_id=?").run(seq, messageId);
            if (message.message_type === 'claim-request') {
                const claimRequest = this.#requireClaimRequest(message.correlation_id);
                if (claimRequest.status === 'delivered')
                    this.#updateClaimRequest({ ...claimRequest, status: 'acknowledged', version: claimRequest.version + 1 });
            }
            else if (message.message_type === 'release-notification') {
                const claimRequest = this.#requireClaimRequest(message.correlation_id);
                if (claimRequest.status === 'released')
                    this.#updateClaimRequest({ ...claimRequest, status: 'requester-notified', version: claimRequest.version + 1 });
            }
            this.#advanceMailboxCursor(request.repo_id, message.recipient_workstream_run, 'acknowledged');
            return { sequence: seq, eventType: 'message-acknowledged', entityType: 'message', entityId: messageId, payload: { message: messageFromRow(asRow(this.#db.prepare('SELECT * FROM messages WHERE message_id=?').get(messageId), 'acknowledged message')), mailbox_cursor: this.#requireMailboxCursor(request.repo_id, message.recipient_workstream_run) } };
        });
    }
    prepareOperation(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
            const worktree = parseCoordinationWorktree(request.payload['worktree']);
            const suppliedOperation = parseCoordinationWorktreeOperation(request.payload['operation']);
            const terminalIntent = this.#preparedTerminalIntent(run.repo_id, run.workstream_run);
            if (terminalIntent !== null) {
                const terminalCloseOperation = terminalIntent.outcome === 'closed' && worktree.kind === 'main' && suppliedOperation.owner.unit_id === 'main' && suppliedOperation.operation_type === 'merge' && (suppliedOperation.intent.reason === 'integrate current target before close' || suppliedOperation.intent.reason === 'atomically fast-forward captured target to validated workstream');
                if (!terminalCloseOperation)
                    throw new CoordinationRuntimeError('invalid-state', 'run terminal preparation fences non-terminal worktree operations');
            }
            if (worktree.owner.repo_id !== request.repo_id || worktree.owner.workstream_run !== run.workstream_run || worktree.owner.autopilot_id !== run.autopilot_id)
                throw new CoordinationRuntimeError('unauthorized-client', 'worktree registration owner does not match the attached durable run');
            if (!sameOwner(worktree.owner, suppliedOperation.owner) || suppliedOperation.worktree_id !== worktree.worktree_id)
                throw new CoordinationRuntimeError('unauthorized-client', 'operation owner does not exactly match its worktree owner');
            if (suppliedOperation.stage !== 'prepared' || suppliedOperation.intent_event_seq !== 0 || suppliedOperation.version !== 1 || suppliedOperation.authority_version !== worktree.version || suppliedOperation.completed_steps.length !== 0 || suppliedOperation.current_step !== null || suppliedOperation.recovery_attempts !== 0 || suppliedOperation.verification_evidence !== null || suppliedOperation.error_code !== null)
                throw new CoordinationRuntimeError('invalid-request', 'new worktree operation must use the canonical prepared state');
            this.#assertWorktreeAuthority(worktree, suppliedOperation);
            const existingWorktreeRow = this.#db.prepare('SELECT * FROM worktrees WHERE entity_id=?').get(worktree.worktree_id);
            if (existingWorktreeRow === undefined) {
                if (request.expected_version !== 0)
                    throw new CoordinationRuntimeError('stale-version', 'new worktree registration requires expected_version 0');
                this.#db.prepare('INSERT INTO worktrees(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(worktree.worktree_id, request.repo_id, run.workstream_run, canonicalJson(worktree), worktree.version);
            }
            else {
                const existingWorktree = worktreeFromRow(existingWorktreeRow);
                this.#assertVersion(existingWorktree.version, request.expected_version, 'worktree');
                if (canonicalJson(existingWorktree) !== canonicalJson(worktree))
                    throw new CoordinationRuntimeError('idempotency-conflict', 'worktree identity was reused with different immutable authority');
            }
            if (this.#db.prepare('SELECT entity_id FROM worktree_operations WHERE entity_id=?').get(suppliedOperation.operation_id) !== undefined)
                throw new CoordinationRuntimeError('stale-version', 'worktree operation already exists; retry its original idempotency key or query status');
            const nonterminal = this.#db.prepare("SELECT entity_id FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.worktree_id')=? AND json_extract(payload_json, '$.stage') NOT IN ('committed','compensated','failed') LIMIT 1").get(request.repo_id, run.workstream_run, worktree.worktree_id);
            if (nonterminal !== undefined)
                throw new CoordinationRuntimeError('coordinator-contention', 'worktree already has an incomplete owner operation');
            const seq = this.#nextEventSequence(request.repo_id);
            const operation = { ...suppliedOperation, intent_event_seq: seq };
            this.#db.prepare('INSERT INTO worktree_operations(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(operation.operation_id, request.repo_id, run.workstream_run, canonicalJson(operation), operation.version);
            return { sequence: seq, eventType: 'worktree-operation-prepared', entityType: 'worktree-operation', entityId: operation.operation_id, payload: { worktree, operation } };
        });
    }
    transitionOperation(request) {
        return this.#mutation(request, () => {
            this.#requireCurrentSession(request);
            const operationId = payloadString(request.payload, 'operation_id');
            const operationRow = asRow(this.#db.prepare('SELECT * FROM worktree_operations WHERE entity_id=?').get(operationId), 'worktree operation');
            const operation = worktreeOperationFromRow(operationRow);
            if (operation.owner.repo_id !== request.repo_id || operation.owner.workstream_run !== this.#workstreamRun(request))
                throw new CoordinationRuntimeError('unauthorized-client', 'session cannot transition a foreign-run worktree operation');
            this.#assertVersion(operation.version, request.expected_version, 'worktree operation');
            const worktreeRow = asRow(this.#db.prepare('SELECT * FROM worktrees WHERE entity_id=?').get(operation.worktree_id), 'worktree');
            const worktree = worktreeFromRow(worktreeRow);
            if (!sameOwner(worktree.owner, operation.owner))
                throw new CoordinationRuntimeError('store-corrupt', 'worktree operation ownership changed');
            if (worktree.version !== operation.authority_version)
                throw new CoordinationRuntimeError('stale-version', 'worktree authority changed while its operation was incomplete');
            const next = parseCoordinationWorktreeOperation({
                ...operation,
                stage: payloadString(request.payload, 'stage'),
                completed_steps: request.payload['completed_steps'],
                current_step: request.payload['current_step'],
                recovery_attempts: payloadInteger(request.payload, 'recovery_attempts'),
                verification_evidence: request.payload['verification_evidence'],
                error_code: request.payload['error_code'],
                version: operation.version + 1,
            });
            this.#assertOperationTransition(operation, next);
            if (next.verification_evidence !== null && operation.verification_evidence === null)
                this.#verifyOperationEvidenceFile(next);
            const requestedWorktreeState = payloadString(request.payload, 'worktree_state');
            if (!COORDINATION_WORKTREE_STATES.includes(requestedWorktreeState))
                throw new CoordinationRuntimeError('invalid-request', 'worktree_state is invalid');
            if (next.stage !== 'committed' && requestedWorktreeState !== worktree.state)
                throw new CoordinationRuntimeError('invalid-request', 'worktree state may change only when an operation commits');
            if (next.stage === 'committed')
                this.#assertCommittedWorktreeState(next, requestedWorktreeState);
            const seq = this.#nextEventSequence(request.repo_id);
            this.#db.prepare('UPDATE worktree_operations SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(next), next.version, next.operation_id);
            let nextWorktree = worktree;
            if (next.stage === 'committed' && requestedWorktreeState !== worktree.state) {
                nextWorktree = parseCoordinationWorktree({ ...worktree, state: requestedWorktreeState, version: worktree.version + 1 });
                this.#db.prepare('UPDATE worktrees SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(nextWorktree), nextWorktree.version, nextWorktree.worktree_id);
            }
            return { sequence: seq, eventType: `worktree-operation-${next.stage}`, entityType: 'worktree-operation', entityId: next.operation_id, payload: { operation: next, worktree: nextWorktree } };
        });
    }
    enqueueMessageForTest(message) {
        const parsed = parseCoordinationMessage(message);
        this.#db.prepare('INSERT INTO messages(message_id, repo_id, recipient_workstream_run, message_type, correlation_id, payload_json, status, created_event_seq, delivered_event_seq, acknowledged_event_seq, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(parsed.message_id, parsed.repo_id, parsed.recipient_workstream_run, parsed.message_type, parsed.correlation_id, canonicalJson(parsed.payload), parsed.status, parsed.created_event_seq, parsed.delivered_event_seq, parsed.acknowledged_event_seq, parsed.version);
    }
    #recoverDurableTransitionsAfterStartup() {
        const runs = this.#db.prepare('SELECT * FROM runs ORDER BY repo_id, workstream_run').all().map(runFromRow);
        const aggregate = this.#emptyReconciliationSummary();
        for (const run of runs) {
            this.#db.exec('BEGIN IMMEDIATE');
            try {
                const seq = this.#nextEventSequence(run.repo_id);
                const recoveryMessageIds = this.#enqueueOperationRecoveryMessages(run, seq);
                const summary = this.#reconcileOwnedRun(run.repo_id, run.workstream_run, seq);
                const graphBefore = canonicalJson({ edges: this.#db.prepare('SELECT payload_json FROM wait_for_edges WHERE repo_id=? ORDER BY entity_id').all(run.repo_id).map((row) => sqlString(row, 'payload_json')), resolutions: this.#db.prepare('SELECT payload_json FROM deadlock_resolutions WHERE repo_id=? ORDER BY entity_id').all(run.repo_id).map((row) => sqlString(row, 'payload_json')) });
                this.#maintainWaitForGraph(run.repo_id, seq);
                const graphAfter = canonicalJson({ edges: this.#db.prepare('SELECT payload_json FROM wait_for_edges WHERE repo_id=? ORDER BY entity_id').all(run.repo_id).map((row) => sqlString(row, 'payload_json')), resolutions: this.#db.prepare('SELECT payload_json FROM deadlock_resolutions WHERE repo_id=? ORDER BY entity_id').all(run.repo_id).map((row) => sqlString(row, 'payload_json')) });
                const graphChanged = graphBefore !== graphAfter;
                if (recoveryMessageIds.length === 0 && summary.released_lease_ids.length === 0 && summary.released_request_ids.length === 0 && summary.notification_ids.length === 0 && summary.offered_group_ids.length === 0 && !graphChanged) {
                    this.#db.exec('ROLLBACK');
                    continue;
                }
                const idempotencyKey = `startup-reconciliation:${run.workstream_run}:${String(seq)}`;
                const digest = `sha256:${createHash('sha256').update(idempotencyKey, 'utf8').digest('hex')}`;
                this.#db.prepare('INSERT INTO events(repo_id, event_seq, event_type, entity_type, entity_id, idempotency_key, request_sha256, occurred_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(run.repo_id, seq, 'startup-run-reconciled', 'run', run.workstream_run, idempotencyKey, digest, this.#clock.now().toISOString());
                this.#db.exec('COMMIT');
                aggregate.released_lease_ids.push(...summary.released_lease_ids);
                aggregate.released_request_ids.push(...summary.released_request_ids);
                aggregate.notification_ids.push(...recoveryMessageIds, ...summary.notification_ids);
                aggregate.offered_group_ids.push(...summary.offered_group_ids);
            }
            catch (error) {
                this.#db.exec('ROLLBACK');
                throw error;
            }
        }
        this.#lastStartupReconciliation = this.#freezeReconciliationSummary(aggregate);
    }
    #enqueueOperationRecoveryMessages(run, seq) {
        const operations = this.#db.prepare("SELECT * FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.stage') NOT IN ('committed','compensated','failed') ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(worktreeOperationFromRow);
        const messageIds = [];
        for (const operation of operations) {
            const messageId = stableEntityId('message', ['worktree-operation-recovery', operation.operation_id]);
            if (this.#db.prepare('SELECT message_id FROM messages WHERE message_id=?').get(messageId) !== undefined)
                continue;
            const message = {
                schema_version: 'autopilot.coordination_message.v1', message_id: messageId, repo_id: run.repo_id,
                recipient_workstream_run: run.workstream_run, message_type: 'recovery-required', correlation_id: operation.operation_id,
                payload: { operation_id: operation.operation_id, worktree_id: operation.worktree_id, operation_type: operation.operation_type, stage: operation.stage, owner_unit: operation.owner.unit_id, owner_attempt: operation.owner.attempt },
                status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
            };
            this.#insertMessage(message);
            messageIds.push(messageId);
        }
        return Object.freeze(messageIds);
    }
    #reconcileOwnedRun(repoId, workstreamRun, seq) {
        const beforeRequests = new Map(this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? ORDER BY entity_id').all(repoId).map(claimRequestFromRow).map((entry) => [entry.request_id, entry]));
        const beforeMessages = new Set(this.#db.prepare('SELECT message_id FROM messages WHERE repo_id=? ORDER BY message_id').all(repoId).map((row) => sqlString(row, 'message_id')));
        const beforeOffers = new Set(this.#db.prepare("SELECT entity_id FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state')='grant-ready'").all(repoId).map((row) => sqlString(row, 'entity_id')));
        const releasedLeaseIds = [];
        const run = this.#requireRun(repoId, workstreamRun);
        this.#releaseProvenLegacyReadLeases(run, seq, releasedLeaseIds);
        const ownerRequests = this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? AND owner_workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(claimRequestFromRow);
        for (const claimRequest of ownerRequests) {
            if (claimRequest.release_condition === null || !['deferred', 'acknowledged', 'delivered', 'pending'].includes(claimRequest.status) || !this.#conditionSatisfied(repoId, workstreamRun, claimRequest.release_condition))
                continue;
            for (const leaseId of claimRequest.blocking_lease_ids)
                this.#releaseOwnedLease(repoId, workstreamRun, leaseId, releasedLeaseIds);
        }
        const ownedLeases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(editLeaseFromRow);
        for (const lease of ownedLeases) {
            if (this.#conditionSatisfied(repoId, workstreamRun, lease.normal_release_condition))
                this.#releaseOwnedLease(repoId, workstreamRun, lease.edit_lease_id, releasedLeaseIds);
        }
        this.#reevaluateWaitingGroups(repoId, seq);
        const afterRequests = this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? ORDER BY entity_id').all(repoId).map(claimRequestFromRow);
        const releasedRequestIds = afterRequests.filter((entry) => {
            const before = beforeRequests.get(entry.request_id);
            return entry.release_event_seq === seq && before?.release_event_seq !== seq;
        }).map((entry) => entry.request_id);
        const notificationIds = this.#db.prepare('SELECT message_id FROM messages WHERE repo_id=? ORDER BY message_id').all(repoId).map((row) => sqlString(row, 'message_id')).filter((messageId) => !beforeMessages.has(messageId));
        const offeredGroupIds = this.#db.prepare("SELECT entity_id FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state')='grant-ready' ORDER BY entity_id").all(repoId).map((row) => sqlString(row, 'entity_id')).filter((groupId) => !beforeOffers.has(groupId));
        return this.#freezeReconciliationSummary({ released_lease_ids: releasedLeaseIds, released_request_ids: releasedRequestIds, notification_ids: notificationIds, offered_group_ids: offeredGroupIds });
    }
    #releaseProvenLegacyReadLeases(run, seq, releasedLeaseIds) {
        const resourceRow = this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run);
        if (resourceRow === undefined)
            return;
        const resource = runResourceFromRow(resourceRow);
        const groups = new Map(this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(acquisitionGroupFromRow).map((group) => [group.acquisition_group_id, group]));
        const leases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(editLeaseFromRow);
        const recoveryByLease = new Map();
        for (const recovery of this.#db.prepare('SELECT * FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(migrationRecoveryFromRow)) {
            const leaseId = recovery.detail['edit_lease_id'];
            if (typeof leaseId !== 'string')
                continue;
            const matching = recoveryByLease.get(leaseId) ?? [];
            matching.push(recovery);
            recoveryByLease.set(leaseId, matching);
        }
        const nonterminalChildOwners = new Set(this.#db.prepare("SELECT * FROM child_leases WHERE repo_id=? AND workstream_run=? AND status IN ('preflight','running','recovery-required') ORDER BY child_lease_id").all(run.repo_id, run.workstream_run).map(childFromRow).map((child) => `${child.owner.unit_id}\0${String(child.owner.attempt)}`));
        const proofByAttempt = new Map();
        const updatedAttempts = new Set();
        for (const lease of leases) {
            const group = groups.get(lease.acquisition_group_id);
            if (lease.mode !== 'READ' || lease.normal_release_condition.condition_type !== 'explicit-owner-release' || group?.acquisition_kind !== 'legacy-unknown')
                continue;
            const recoveries = recoveryByLease.get(lease.edit_lease_id) ?? [];
            if (recoveries.some((recovery) => recovery.status === 'pending' || recovery.resolution?.resolution_type !== 'authority-retained'))
                continue;
            const attemptKey = `${lease.owner.unit_id}\0${String(lease.owner.attempt)}`;
            if (nonterminalChildOwners.has(attemptKey))
                continue;
            let result = proofByAttempt.get(attemptKey);
            if (result === undefined) {
                result = proveLegacyReadAttemptTerminal({ runtimeRoot: resource.runtime_root, workstream: run.workstream, unitId: lease.owner.unit_id, attempt: lease.owner.attempt });
                proofByAttempt.set(attemptKey, result);
            }
            if (!result.proven)
                continue;
            this.#persistLegacyReadTerminalProof(run, resource, lease, result.proof, seq);
            this.#releaseOwnedLease(run.repo_id, run.workstream_run, lease.edit_lease_id, releasedLeaseIds);
            if (updatedAttempts.has(attemptKey))
                continue;
            updatedAttempts.add(attemptKey);
            const entityId = unitAttemptEntityId(lease.owner);
            const attemptRow = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(entityId);
            if (attemptRow === undefined)
                continue;
            const attempt = unitAttemptFromRow(attemptRow);
            const state = result.proof.kind === 'superseded-by-later-attempt' ? 'superseded' : 'transport-complete';
            if (attempt.state === state || attempt.state === 'merged' || attempt.state === 'reset' || attempt.state === 'quarantined' || attempt.state === 'superseded')
                continue;
            this.#updateEntity('unit_attempts', entityId, { ...attempt, state, critical_section: null, version: attempt.version + 1 });
        }
    }
    #persistLegacyReadTerminalProof(run, resource, lease, proof, seq) {
        const evidence = proof.artifacts.map((artifact) => {
            const ref = relative(resource.main_worktree_path, artifact.path).split(sep).join('/');
            if (ref.length === 0 || ref === '..' || ref.startsWith('../') || isAbsolute(ref))
                throw new CoordinationRuntimeError('unauthorized-client', 'legacy READ terminal evidence escapes the durable run main worktree', [artifact.path]);
            const identity = { ref, sha256: artifact.sha256 };
            this.#persistEvidenceArtifact(run.repo_id, identity, artifact.bytes, 'legacy READ terminal authority release', seq);
            return identity;
        });
        const primary = evidence[proof.artifacts.indexOf(proof.evidence)];
        if (primary === undefined)
            throw new CoordinationRuntimeError('store-corrupt', 'legacy READ terminal proof lost its primary evidence artifact');
        const auditId = stableEntityId('legacy-read-terminal-release', [run.repo_id, run.workstream_run, lease.edit_lease_id, primary.sha256]);
        if (this.#db.prepare('SELECT entity_id FROM migration_legacy_audit WHERE entity_id=?').get(auditId) !== undefined)
            return;
        const payload = {
            schema_version: 'autopilot.migration_terminal_release.v1', repo_key: run.repo_id, workstream_run: run.workstream_run, autopilot_id: run.autopilot_id,
            unit_id: lease.owner.unit_id, attempt: lease.owner.attempt, path: lease.path, claim_type: lease.mode,
            mechanical_proof: proof.kind === 'completed-current-attempt' ? 'accepted-read-terminal' : 'superseded-read-terminal', evidence_source: 'legacy-read-terminal',
            evidence_ref: primary.ref, evidence_sha256: primary.sha256, supporting_evidence: evidence, exact_git_objects: [], filesystem_postconditions: proof.mechanicalProof,
            released_from_active_import: false, released_post_cutover: coordinationCutoverCommitted(this.#stateRoot, run.repo_id),
        };
        this.#db.prepare('INSERT INTO migration_legacy_audit(entity_id, repo_id, source_kind, payload_json, created_event_seq) VALUES(?, ?, ?, ?, ?)').run(auditId, run.repo_id, 'claim-event', canonicalJson(payload), seq);
    }
    #releaseOwnedLease(repoId, workstreamRun, leaseId, releasedLeaseIds) {
        const row = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND entity_id=?').get(repoId, leaseId);
        if (row === undefined)
            return;
        const lease = editLeaseFromRow(row);
        if (lease.owner.workstream_run !== workstreamRun)
            throw new CoordinationRuntimeError('unauthorized-client', 'run reconciliation cannot release a foreign-run edit lease');
        this.#db.prepare('DELETE FROM edit_leases WHERE repo_id=? AND entity_id=?').run(repoId, leaseId);
        releasedLeaseIds.push(leaseId);
        this.#markGroupReleasedWhenEmpty(repoId, lease.acquisition_group_id);
    }
    #convertUnitMergeToReservations(run, targetId, mergeEvidence, seq) {
        const target = parseUnitAttemptTarget(targetId);
        const owner = { repo_id: run.repo_id, autopilot_id: run.autopilot_id, workstream_run: run.workstream_run, unit_id: target.unitId, attempt: target.attempt };
        const facts = parseUnitMergeReservationFacts(this.#verifyAcceptedEvidenceFile(run, 'unit-merge', targetId, mergeEvidence));
        this.#assertUnitMergeGitFacts(run, facts);
        const activeLeases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(editLeaseFromRow).filter((lease) => sameOwner(lease.owner, owner));
        const existing = this.#db.prepare("SELECT * FROM change_reservations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.merge_evidence.ref')=? AND json_extract(payload_json, '$.merge_evidence.sha256')=? ORDER BY entity_id").all(run.repo_id, run.workstream_run, mergeEvidence.ref, mergeEvidence.sha256).map(changeReservationFromRow);
        const expectedExisting = facts.changedPaths.every((path) => existing.some((reservation) => reservation.path === path));
        if (activeLeases.length === 0) {
            if (expectedExisting && existing.length === facts.changedPaths.length)
                return { reservations: existing, obligations: [] };
            throw new CoordinationRuntimeError('invalid-state', 'unit merge cannot create reservations without active edit authority or an exact prior conversion', [targetId, mergeEvidence.ref]);
        }
        for (const lease of activeLeases) {
            if (lease.normal_release_condition.condition_type !== 'unit-merged' || lease.normal_release_condition.target_id !== targetId)
                throw new CoordinationRuntimeError('invalid-state', 'source-changing edit lease must remain active through its exact unit-merge transition', [lease.edit_lease_id]);
        }
        for (const path of facts.changedPaths) {
            const covering = activeLeases.some((lease) => (lease.mode === 'WRITE' || lease.mode === 'EXCLUSIVE') && leaseCoversPath(lease.path, path));
            if (!covering)
                throw new CoordinationRuntimeError('unauthorized-client', 'unit merge changed a path outside active WRITE/EXCLUSIVE authority', [path, targetId]);
        }
        if (existing.length > 0)
            throw new CoordinationRuntimeError('invalid-state', 'partial or mismatched reservation conversion already exists', existing.map((reservation) => reservation.reservation_id));
        const reservations = [];
        const obligations = [];
        for (const path of facts.changedPaths) {
            const reservation = parseCoordinationChangeReservation({
                schema_version: 'autopilot.change_reservation.v1',
                reservation_id: stableEntityId('reservation', [run.repo_id, run.workstream_run, targetId, mergeEvidence.sha256, path]),
                repo_id: run.repo_id,
                autopilot_id: run.autopilot_id,
                workstream_run: run.workstream_run,
                path,
                merge_evidence: mergeEvidence,
                created_event_seq: seq,
                released_event_seq: null,
                terminal_outcome: null,
                terminal_sha: null,
                version: 1,
            });
            this.#db.prepare('INSERT INTO change_reservations(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(reservation.reservation_id, reservation.repo_id, reservation.workstream_run, canonicalJson(reservation), reservation.version);
            reservations.push(reservation);
            const predecessors = this.#db.prepare('SELECT * FROM change_reservations WHERE repo_id=? AND workstream_run!=? AND entity_id!=? ORDER BY json_extract(payload_json, \'$.created_event_seq\'), entity_id').all(run.repo_id, run.workstream_run, reservation.reservation_id).map(changeReservationFromRow).filter((candidate) => coordinationPathsOverlap(candidate.path, reservation.path));
            for (const predecessor of predecessors) {
                if (predecessor.terminal_outcome === 'aborted')
                    continue;
                if (predecessor.terminal_outcome === 'closed' && predecessor.terminal_sha !== null && this.#gitCommitIsAncestor(run, predecessor.terminal_sha, facts.integrationBefore))
                    continue;
                const predecessorLanded = predecessor.released_event_seq !== null && predecessor.terminal_outcome === 'closed' && predecessor.terminal_sha !== null;
                const obligation = parseCoordinationReservationObligation({
                    schema_version: 'autopilot.reservation_obligation.v1',
                    obligation_id: stableEntityId('reservation-obligation', [reservation.reservation_id, predecessor.reservation_id]),
                    repo_id: run.repo_id,
                    workstream_run: run.workstream_run,
                    reservation_id: reservation.reservation_id,
                    predecessor_reservation_id: predecessor.reservation_id,
                    overlapping_paths: [reservation.path, predecessor.path].filter((entry, index, values) => values.indexOf(entry) === index).sort(),
                    state: predecessorLanded ? 'integration-required' : 'waiting-for-predecessor',
                    created_event_seq: seq,
                    predecessor_released_event_seq: predecessorLanded ? predecessor.released_event_seq : null,
                    predecessor_terminal_sha: predecessorLanded ? predecessor.terminal_sha : null,
                    integration_evidence: null,
                    validation_evidence: null,
                    resolved_event_seq: null,
                    version: 1,
                });
                this.#insertReservationObligation(obligation);
                obligations.push(obligation);
                this.#insertMessage({
                    schema_version: 'autopilot.coordination_message.v1', message_id: stableEntityId('message', [predecessorLanded ? 'reservation-landed' : 'reservation-overlap', obligation.obligation_id, 'dependent']), repo_id: run.repo_id,
                    recipient_workstream_run: run.workstream_run, message_type: predecessorLanded ? 'reservation-landed' : 'reservation-overlap', correlation_id: obligation.obligation_id,
                    payload: { obligation_id: obligation.obligation_id, role: 'dependent', reservation_id: reservation.reservation_id, predecessor_reservation_id: predecessor.reservation_id, predecessor_released_event_seq: predecessor.released_event_seq, predecessor_terminal_sha: predecessor.terminal_sha, overlapping_paths: obligation.overlapping_paths, required_action: predecessorLanded ? 'integrate-and-revalidate' : 'wait-for-predecessor' },
                    status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
                });
                if (!predecessorLanded)
                    this.#insertMessage({
                        schema_version: 'autopilot.coordination_message.v1', message_id: stableEntityId('message', ['reservation-overlap', obligation.obligation_id, 'predecessor']), repo_id: run.repo_id,
                        recipient_workstream_run: predecessor.workstream_run, message_type: 'reservation-overlap', correlation_id: obligation.obligation_id,
                        payload: { obligation_id: obligation.obligation_id, role: 'predecessor', reservation_id: predecessor.reservation_id, dependent_reservation_id: reservation.reservation_id, overlapping_paths: obligation.overlapping_paths, required_action: 'land-or-abort-before-dependent' },
                        status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
                    });
            }
        }
        return { reservations, obligations };
    }
    #assertReservationValidationArtifactChain(run, validationEvidenceRef, facts) {
        const marker = '/validation/';
        const markerIndex = validationEvidenceRef.lastIndexOf(marker);
        if (markerIndex <= 0)
            throw new CoordinationRuntimeError('invalid-state', 'reservation validation evidence must live below the run validation directory', [validationEvidenceRef]);
        const runtimePrefix = validationEvidenceRef.slice(0, markerIndex);
        const evidenceFor = (ref, sha256) => ({ ref: ref.startsWith('.pi/') ? ref : `${runtimePrefix}/${ref}`, sha256 });
        const statusEvidence = evidenceFor(facts.statusRef, facts.statusSha256);
        const receiptEvidence = evidenceFor(facts.receiptRef, facts.receiptSha256);
        const auditEvidence = evidenceFor(facts.auditRef, facts.auditSha256);
        validateReservationValidationArtifactChain({
            facts,
            workstream: run.workstream,
            statusBytes: this.#readRunEvidenceFile(run, statusEvidence),
            receiptBytes: this.#readRunEvidenceFile(run, receiptEvidence),
            auditBytes: this.#readRunEvidenceFile(run, auditEvidence),
        });
        const validatorChildId = `child-${run.workstream_run}-${facts.validationUnitId}-${String(facts.validationAttempt)}`;
        const acceptedChild = this.#db.prepare("SELECT * FROM reconciliation_evidence WHERE repo_id=? AND workstream_run=? AND source='child-process' AND json_extract(payload_json, '$.release_condition.target_id')=? ORDER BY entity_id").all(run.repo_id, run.workstream_run, validatorChildId).map(reconciliationEvidenceFromRow);
        if (acceptedChild.length !== 1 || acceptedChild[0]?.release_condition.evidence?.ref !== receiptEvidence.ref || acceptedChild[0]?.release_condition.evidence?.sha256 !== receiptEvidence.sha256)
            throw new CoordinationRuntimeError('invalid-state', 'reservation validation is not backed by one accepted validator child receipt', [validatorChildId, receiptEvidence.ref]);
    }
    #assertReservationIntegrationGitFacts(run, predecessorTerminalSha, integrationHead, protectedPaths, requireExactHead) {
        const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'reservation integration repository'));
        const mainRoot = resolve(this.#stateRoot, 'worktrees', repository.repo_key, 'active', run.workstream_run, 'main');
        const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: mainRoot, encoding: 'utf8' });
        const currentHead = head.stdout.trim();
        if ((head.status ?? -1) !== 0)
            throw new CoordinationRuntimeError('invalid-state', 'reservation integration owned workstream HEAD is unreadable', [head.stderr.trim()]);
        if (currentHead !== integrationHead) {
            if (requireExactHead || !this.#gitCommitIsAncestor(run, integrationHead, currentHead))
                throw new CoordinationRuntimeError('invalid-state', 'reservation integration evidence is not the current owned workstream HEAD', [`actual=${currentHead}`, `evidence=${integrationHead}`]);
            const diff = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', integrationHead, currentHead], { cwd: mainRoot, encoding: 'utf8' });
            if ((diff.status ?? -1) !== 0)
                throw new CoordinationRuntimeError('invalid-state', 'failed to verify post-validation reservation path stability', [diff.stderr.trim()]);
            const changed = diff.stdout.split('\0').filter((path) => path.length > 0);
            const invalidating = changed.filter((path) => protectedPaths.some((protectedPath) => coordinationPathsOverlap(path, protectedPath)));
            if (invalidating.length > 0)
                throw new CoordinationRuntimeError('invalid-state', 'resolved reservation validation became stale on overlapping paths', invalidating);
        }
        if (!this.#gitCommitIsAncestor(run, predecessorTerminalSha, integrationHead))
            throw new CoordinationRuntimeError('invalid-state', 'reservation integration head does not contain the predecessor terminal commit', [predecessorTerminalSha, integrationHead]);
    }
    #gitCommitIsAncestor(run, ancestor, descendant) {
        const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'reservation ancestry repository'));
        const mainRoot = resolve(this.#stateRoot, 'worktrees', repository.repo_key, 'active', run.workstream_run, 'main');
        const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: mainRoot, encoding: 'utf8' });
        if ((result.status ?? -1) === 0)
            return true;
        if ((result.status ?? -1) === 1)
            return false;
        throw new CoordinationRuntimeError('invalid-state', 'failed to verify predecessor landing ancestry', [ancestor, descendant, result.stderr.trim()]);
    }
    #assertUnitMergeGitFacts(run, facts) {
        const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'merge repository'));
        const mainRoot = resolve(this.#stateRoot, 'worktrees', repository.repo_key, 'active', run.workstream_run, 'main');
        const git = (args) => {
            const result = spawnSync('git', [...args], { cwd: mainRoot, encoding: 'utf8' });
            return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
        };
        const head = git(['rev-parse', 'HEAD']);
        if (head.status !== 0 || facts.mergeCommitSha !== facts.integrationAfter)
            throw new CoordinationRuntimeError('invalid-state', 'unit-merge evidence integration head or merge commit is invalid', [head.stderr.trim(), `actual=${head.stdout.trim()}`, `evidence=${facts.integrationAfter}`]);
        const integrated = git(['merge-base', '--is-ancestor', facts.integrationAfter, head.stdout.trim()]);
        if (integrated.status !== 0)
            throw new CoordinationRuntimeError('invalid-state', 'unit-merge evidence integration head is not contained in the owned workstream HEAD', [facts.integrationAfter, head.stdout.trim(), integrated.stderr.trim()]);
        for (const sha of [facts.integrationBefore, facts.integrationAfter]) {
            const object = git(['cat-file', '-e', `${sha}^{commit}`]);
            if (object.status !== 0)
                throw new CoordinationRuntimeError('invalid-state', 'unit-merge evidence references a missing Git commit', [sha, object.stderr.trim()]);
        }
        const ancestor = git(['merge-base', '--is-ancestor', facts.integrationBefore, facts.integrationAfter]);
        if (ancestor.status !== 0)
            throw new CoordinationRuntimeError('invalid-state', 'unit-merge integration_before is not an ancestor of integration_after', [facts.integrationBefore, facts.integrationAfter]);
        const diff = git(['diff', '--name-only', '--no-renames', '-z', facts.integrationBefore, facts.integrationAfter]);
        if (diff.status !== 0)
            throw new CoordinationRuntimeError('invalid-state', 'failed to derive exact unit-merge Git diff', [diff.stderr.trim()]);
        const actualPaths = diff.stdout.split('\0').filter((path) => path.length > 0).map((path) => path.replace(/\\/gu, '/')).sort((left, right) => left.localeCompare(right));
        const declaredPaths = [...facts.changedPaths].sort((left, right) => left.localeCompare(right));
        if (canonicalJson(actualPaths) !== canonicalJson(declaredPaths))
            throw new CoordinationRuntimeError('invalid-state', 'unit-merge changed_paths do not equal the exact Git diff', [`actual=${actualPaths.join(',')}`, `declared=${declaredPaths.join(',')}`]);
    }
    #assertRunTerminalGitFacts(run, source, terminalSha) {
        const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'terminal repository'));
        const mainRoot = resolve(this.#stateRoot, 'worktrees', repository.repo_key, 'active', run.workstream_run, 'main');
        const terminalRoot = source === 'run-close' ? repository.canonical_root : mainRoot;
        const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: terminalRoot, encoding: 'utf8' });
        if ((head.status ?? -1) !== 0 || head.stdout.trim() !== terminalSha)
            throw new CoordinationRuntimeError('invalid-state', `${source} terminal commit is not the authoritative Git HEAD`, [head.stderr.trim(), `actual=${head.stdout.trim()}`, `evidence=${terminalSha}`]);
        const reservations = this.#db.prepare('SELECT * FROM change_reservations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(changeReservationFromRow);
        for (const reservation of reservations) {
            const facts = parseUnitMergeReservationFacts(this.#verifyAcceptedEvidenceFile(run, 'unit-merge', this.#targetIdForMergeEvidence(run, reservation.merge_evidence), reservation.merge_evidence));
            const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', facts.integrationAfter, terminalSha], { cwd: terminalRoot, encoding: 'utf8' });
            if ((ancestor.status ?? -1) !== 0)
                throw new CoordinationRuntimeError('invalid-state', 'terminal commit does not contain every reserved accepted merge', [reservation.reservation_id, facts.integrationAfter, terminalSha]);
        }
    }
    #targetIdForMergeEvidence(run, evidence) {
        const accepted = this.#db.prepare("SELECT * FROM reconciliation_evidence WHERE repo_id=? AND workstream_run=? AND source='unit-merge' AND json_extract(payload_json, '$.release_condition.evidence.ref')=? AND json_extract(payload_json, '$.release_condition.evidence.sha256')=? ORDER BY entity_id").all(run.repo_id, run.workstream_run, evidence.ref, evidence.sha256).map(reconciliationEvidenceFromRow);
        if (accepted.length !== 1)
            throw new CoordinationRuntimeError('store-corrupt', 'reservation must bind exactly one accepted unit merge', [evidence.ref, String(accepted.length)]);
        return accepted[0]?.release_condition.target_id ?? '';
    }
    #assertRunTerminalExternalReady(run) {
        const runningChildren = this.#db.prepare("SELECT child_lease_id FROM child_leases WHERE repo_id=? AND workstream_run=? AND status IN ('preflight','running') ORDER BY child_lease_id").all(run.repo_id, run.workstream_run).map((row) => sqlString(row, 'child_lease_id'));
        if (runningChildren.length > 0)
            throw new CoordinationRuntimeError('recovery-required', 'run terminal commit requires all child processes terminal', runningChildren);
        const incompleteOperations = this.#db.prepare("SELECT entity_id FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.stage') NOT IN ('committed','compensated','failed') ORDER BY entity_id").all(run.repo_id, run.workstream_run).map((row) => sqlString(row, 'entity_id'));
        if (incompleteOperations.length > 0)
            throw new CoordinationRuntimeError('recovery-required', 'run terminal commit requires all owned worktree sagas terminal', incompleteOperations);
        const pendingGroups = this.#db.prepare("SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.state') IN ('waiting','grant-ready') ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(acquisitionGroupFromRow);
        if (pendingGroups.length > 0)
            throw new CoordinationRuntimeError('recovery-required', 'run terminal commit requires queued acquisition groups to be cancelled or superseded', pendingGroups.map((group) => `${group.acquisition_group_id}:${group.state}`));
    }
    #assertRunCloseReservationReady(run) {
        const activeLeases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(editLeaseFromRow);
        const nonCloseLeases = activeLeases.filter((lease) => lease.normal_release_condition.condition_type !== 'run-closed' || lease.normal_release_condition.target_id !== run.workstream_run);
        if (nonCloseLeases.length > 0)
            throw new CoordinationRuntimeError('recovery-required', 'run close requires every unit edit lease to be terminally released', nonCloseLeases.map((lease) => lease.edit_lease_id));
        const obligations = this.#db.prepare('SELECT * FROM reservation_obligations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(reservationObligationFromRow);
        const unresolved = obligations.filter((entry) => entry.state !== 'resolved' && entry.state !== 'cancelled');
        if (unresolved.length > 0)
            throw new CoordinationRuntimeError('recovery-required', 'run close requires every reservation integration obligation to be resolved', unresolved.map((entry) => `${entry.obligation_id}:${entry.state}`));
        for (const obligation of obligations.filter((entry) => entry.state === 'resolved'))
            this.#assertResolvedReservationObligationCurrent(run, obligation);
        const reservations = this.#db.prepare('SELECT * FROM change_reservations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(changeReservationFromRow);
        if (reservations.some((reservation) => reservation.released_event_seq !== null))
            throw new CoordinationRuntimeError('invalid-state', 'run close found prematurely released change reservations');
        const mergeEvidence = this.#db.prepare("SELECT * FROM reconciliation_evidence WHERE repo_id=? AND workstream_run=? AND source='unit-merge' ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(reconciliationEvidenceFromRow);
        for (const accepted of mergeEvidence) {
            const evidence = accepted.release_condition.evidence;
            if (evidence === null)
                throw new CoordinationRuntimeError('store-corrupt', 'accepted unit merge lacks immutable evidence');
            const facts = parseUnitMergeReservationFacts(this.#verifyAcceptedEvidenceFile(run, 'unit-merge', accepted.release_condition.target_id, evidence));
            for (const path of facts.changedPaths) {
                if (!reservations.some((reservation) => reservation.path === path && reservation.merge_evidence.ref === evidence.ref && reservation.merge_evidence.sha256 === evidence.sha256))
                    throw new CoordinationRuntimeError('invalid-state', 'final close cannot ignore accepted unit-merge reservation evidence', [accepted.release_condition.target_id, path, evidence.ref]);
            }
        }
    }
    #assertResolvedReservationObligationCurrent(run, obligation) {
        if (obligation.predecessor_released_event_seq === null || obligation.predecessor_terminal_sha === null || obligation.integration_evidence === null || obligation.validation_evidence === null)
            throw new CoordinationRuntimeError('store-corrupt', 'resolved reservation obligation lacks complete immutable proof', [obligation.obligation_id]);
        const dependentReservation = changeReservationFromRow(asRow(this.#db.prepare('SELECT * FROM change_reservations WHERE repo_id=? AND entity_id=?').get(run.repo_id, obligation.reservation_id), 'dependent reservation'));
        const dependentTarget = parseUnitAttemptTarget(this.#targetIdForMergeEvidence(run, dependentReservation.merge_evidence));
        const identity = {
            repoId: run.repo_id, autopilotId: run.autopilot_id, workstream: run.workstream, workstreamRun: run.workstream_run,
            obligationId: obligation.obligation_id, reservationId: obligation.reservation_id, predecessorReservationId: obligation.predecessor_reservation_id,
            predecessorReleasedEventSeq: obligation.predecessor_released_event_seq, predecessorTerminalSha: obligation.predecessor_terminal_sha,
            dependentUnitId: dependentTarget.unitId, dependentAttempt: dependentTarget.attempt, dependentMergeRef: dependentReservation.merge_evidence.ref, overlappingPaths: obligation.overlapping_paths,
        };
        const integrationHead = validateReservationIntegrationEvidenceDocument(this.#readRunEvidenceFile(run, obligation.integration_evidence), identity);
        this.#assertReservationIntegrationGitFacts(run, obligation.predecessor_terminal_sha, integrationHead, obligation.overlapping_paths, false);
        const validationFacts = validateReservationValidationEvidenceDocument(this.#readRunEvidenceFile(run, obligation.validation_evidence), identity, integrationHead);
        this.#assertReservationValidationArtifactChain(run, obligation.validation_evidence.ref, validationFacts);
    }
    #terminalizeRunReservations(run, source, terminalSha, seq) {
        const reservations = this.#db.prepare("SELECT * FROM change_reservations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.released_event_seq') IS NULL ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(changeReservationFromRow);
        for (const reservation of reservations) {
            const released = parseCoordinationChangeReservation({ ...reservation, released_event_seq: seq, terminal_outcome: source === 'run-close' ? 'closed' : 'aborted', terminal_sha: terminalSha, version: reservation.version + 1 });
            this.#db.prepare('UPDATE change_reservations SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(released), released.version, released.reservation_id);
            const dependent = this.#db.prepare("SELECT * FROM reservation_obligations WHERE repo_id=? AND predecessor_reservation_id=? AND json_extract(payload_json, '$.state')='waiting-for-predecessor' ORDER BY entity_id").all(run.repo_id, reservation.reservation_id).map(reservationObligationFromRow);
            for (const obligation of dependent) {
                const state = source === 'run-close' ? 'integration-required' : 'cancelled';
                const next = parseCoordinationReservationObligation({ ...obligation, state, predecessor_released_event_seq: source === 'run-close' ? seq : null, predecessor_terminal_sha: source === 'run-close' ? terminalSha : null, resolved_event_seq: source === 'run-abort' ? seq : null, version: obligation.version + 1 });
                this.#updateReservationObligation(next);
                if (source === 'run-close')
                    this.#insertMessage({
                        schema_version: 'autopilot.coordination_message.v1', message_id: stableEntityId('message', ['reservation-landed', obligation.obligation_id, String(seq)]), repo_id: run.repo_id,
                        recipient_workstream_run: obligation.workstream_run, message_type: 'reservation-landed', correlation_id: obligation.obligation_id,
                        payload: { obligation_id: obligation.obligation_id, predecessor_reservation_id: reservation.reservation_id, predecessor_released_event_seq: seq, predecessor_terminal_sha: terminalSha, overlapping_paths: obligation.overlapping_paths, required_action: 'integrate-and-revalidate' },
                        status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
                    });
            }
        }
        if (source === 'run-abort') {
            const owned = this.#db.prepare("SELECT * FROM reservation_obligations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.state') NOT IN ('resolved','cancelled') ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(reservationObligationFromRow);
            for (const obligation of owned)
                this.#updateReservationObligation(parseCoordinationReservationObligation({ ...obligation, state: 'cancelled', resolved_event_seq: seq, version: obligation.version + 1 }));
        }
    }
    #releaseAttemptLeases(run, targetId) {
        const target = parseUnitAttemptTarget(targetId);
        const released = [];
        const leases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(editLeaseFromRow).filter((lease) => lease.owner.unit_id === target.unitId && lease.owner.attempt === target.attempt);
        for (const lease of leases)
            this.#releaseOwnedLease(run.repo_id, run.workstream_run, lease.edit_lease_id, released);
        return Object.freeze(released);
    }
    #releaseAllRunLeases(run) {
        const released = [];
        const leases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(editLeaseFromRow);
        for (const lease of leases)
            this.#releaseOwnedLease(run.repo_id, run.workstream_run, lease.edit_lease_id, released);
        return Object.freeze(released);
    }
    #preparedTerminalIntent(repoId, workstreamRun) {
        const row = this.#db.prepare("SELECT * FROM run_terminal_intents WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.state')='prepared' ORDER BY entity_id LIMIT 1").get(repoId, workstreamRun);
        return row === undefined ? null : runTerminalIntentFromRow(row);
    }
    #assertPreparedTerminalIntent(run, source) {
        const intent = this.#preparedTerminalIntent(run.repo_id, run.workstream_run);
        const reservations = this.#db.prepare("SELECT entity_id FROM change_reservations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.released_event_seq') IS NULL ORDER BY entity_id").all(run.repo_id, run.workstream_run).map((row) => sqlString(row, 'entity_id'));
        if (intent === null) {
            if (reservations.length === 0)
                return null;
            throw new CoordinationRuntimeError('invalid-state', 'reservation-owning run terminal transition requires a prepared fenced intent');
        }
        const expectedOutcome = source === 'run-abort' ? 'aborted' : 'closed';
        if (intent.outcome !== expectedOutcome)
            throw new CoordinationRuntimeError('invalid-state', `prepared terminal intent outcome ${intent.outcome} does not match ${expectedOutcome}`);
        if (canonicalJson(intent.reservation_ids) !== canonicalJson(reservations))
            throw new CoordinationRuntimeError('coordinator-contention', 'change reservation set drifted after terminal preparation', [...intent.reservation_ids, ...reservations]);
        return intent;
    }
    #commitTerminalIntent(intent, seq) {
        const committed = parseCoordinationRunTerminalIntent({ ...intent, state: 'committed', terminal_event_seq: seq, version: intent.version + 1 });
        const result = this.#db.prepare('UPDATE run_terminal_intents SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(committed), committed.version, committed.terminal_intent_id);
        if (result.changes !== 1)
            throw new CoordinationRuntimeError('invalid-state', 'prepared run terminal intent disappeared during commit');
    }
    #insertReservationObligation(obligation) {
        this.#db.prepare('INSERT INTO reservation_obligations(entity_id, repo_id, workstream_run, reservation_id, predecessor_reservation_id, payload_json, version) VALUES(?, ?, ?, ?, ?, ?, ?)').run(obligation.obligation_id, obligation.repo_id, obligation.workstream_run, obligation.reservation_id, obligation.predecessor_reservation_id, canonicalJson(obligation), obligation.version);
    }
    #updateReservationObligation(obligation) {
        const result = this.#db.prepare('UPDATE reservation_obligations SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(obligation), obligation.version, obligation.obligation_id);
        if (result.changes !== 1)
            throw new CoordinationRuntimeError('invalid-state', `reservation obligation ${obligation.obligation_id} disappeared during mutation`);
    }
    #conditionSatisfied(repoId, workstreamRun, condition) {
        if (condition.condition_type === 'explicit-owner-release')
            return false;
        if (condition.condition_type === 'child-terminal') {
            const row = this.#db.prepare("SELECT * FROM child_leases WHERE repo_id=? AND workstream_run=? AND child_lease_id=? AND status='terminal'").get(repoId, workstreamRun, condition.target_id);
            if (row !== undefined) {
                const child = childFromRow(row);
                if (child.terminal_evidence === null)
                    throw new CoordinationRuntimeError('store-corrupt', 'terminal child fact lacks immutable evidence');
                this.#verifyAcceptedEvidenceFile(this.#requireRun(repoId, workstreamRun), 'child-process', condition.target_id, child.terminal_evidence);
                return true;
            }
        }
        if (condition.condition_type === 'run-closed') {
            const run = this.#requireRun(repoId, workstreamRun);
            if (condition.target_id === workstreamRun && (run.status === 'closed' || run.status === 'aborted'))
                return true;
        }
        return this.#db.prepare("SELECT entity_id FROM reconciliation_evidence WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.release_condition.condition_type')=? AND target_id=? LIMIT 1").get(repoId, workstreamRun, condition.condition_type, condition.target_id) !== undefined;
    }
    #acceptReconciliationEvidence(input) {
        const run = this.#requireRun(input.repoId, input.workstreamRun);
        this.#verifyAcceptedEvidenceFile(run, input.source, input.targetId, input.evidence);
        const conditionType = this.#conditionTypeForSource(input.source);
        this.#assertReconciliationTarget(run, conditionType, input.targetId);
        const entityId = stableEntityId('reconciliation-evidence', [input.repoId, input.workstreamRun, input.source, input.targetId, input.evidence.ref, input.evidence.sha256]);
        const existing = this.#db.prepare('SELECT * FROM reconciliation_evidence WHERE entity_id=?').get(entityId);
        if (existing !== undefined)
            return reconciliationEvidenceFromRow(existing);
        const evidence = {
            schema_version: 'autopilot.reconciliation_evidence.v1',
            reconciliation_evidence_id: entityId,
            repo_id: input.repoId,
            autopilot_id: run.autopilot_id,
            workstream_run: input.workstreamRun,
            source: input.source,
            release_condition: { condition_type: conditionType, target_id: input.targetId, evidence: input.evidence },
            accepted_event_seq: input.seq,
            version: 1,
        };
        const parsed = parseCoordinationReconciliationEvidence(evidence);
        this.#db.prepare('INSERT INTO reconciliation_evidence(entity_id, repo_id, workstream_run, source, target_id, payload_json, version) VALUES(?, ?, ?, ?, ?, ?, ?)').run(entityId, input.repoId, input.workstreamRun, input.source, input.targetId, canonicalJson(parsed), parsed.version);
        return parsed;
    }
    #readRunEvidenceFile(run, evidence) {
        const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'evidence repository'));
        const worktreesRoot = resolve(this.#stateRoot, 'worktrees');
        const runMainRoot = resolve(worktreesRoot, repository.repo_key, 'active', run.workstream_run, 'main');
        const relativeRunRoot = relative(worktreesRoot, runMainRoot);
        if (relativeRunRoot.length === 0 || relativeRunRoot === '..' || relativeRunRoot.startsWith(`..${sep}`) || isAbsolute(relativeRunRoot))
            throw new CoordinationRuntimeError('unauthorized-client', 'durable run identity escapes the package-owned worktree root');
        const evidencePath = resolve(runMainRoot, evidence.ref);
        const relativeEvidence = relative(runMainRoot, evidencePath);
        if (relativeEvidence.length === 0 || relativeEvidence === '..' || relativeEvidence.startsWith(`..${sep}`) || isAbsolute(relativeEvidence))
            throw new CoordinationRuntimeError('unauthorized-client', 'accepted evidence escapes the run-owned main worktree');
        let bytes;
        try {
            const evidenceStat = lstatSync(evidencePath);
            if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink())
                throw new CoordinationRuntimeError('unauthorized-client', 'accepted evidence must be a regular non-symbolic file', [evidencePath]);
            const realRunRoot = realpathSync(runMainRoot);
            const realEvidencePath = realpathSync(evidencePath);
            const relativeRealEvidence = relative(realRunRoot, realEvidencePath);
            if (relativeRealEvidence.length === 0 || relativeRealEvidence === '..' || relativeRealEvidence.startsWith(`..${sep}`) || isAbsolute(relativeRealEvidence))
                throw new CoordinationRuntimeError('unauthorized-client', 'accepted evidence resolves outside the run-owned main worktree', [evidencePath, realEvidencePath]);
            bytes = readFileSync(evidencePath);
        }
        catch (error) {
            if (error instanceof CoordinationRuntimeError)
                throw error;
            throw new CoordinationRuntimeError('recovery-required', 'accepted evidence file is unreadable', [evidencePath, error instanceof Error ? error.message : String(error)]);
        }
        const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        if (actual !== evidence.sha256)
            throw new CoordinationRuntimeError('invalid-state', 'accepted evidence hash does not match the run-owned artifact', [evidencePath, `expected=${evidence.sha256}`, `actual=${actual}`]);
        return bytes;
    }
    #verifyAcceptedEvidenceFile(run, source, targetId, evidence) {
        const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'evidence repository'));
        const bytes = this.#readRunEvidenceFile(run, evidence);
        let unitId = null;
        let attempt = null;
        if (source === 'child-process') {
            const child = childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(targetId), 'terminal evidence child'));
            unitId = child.owner.unit_id;
            attempt = child.owner.attempt;
        }
        else if (source === 'unit-merge' || source === 'attempt-reset' || source === 'quarantine-capture') {
            const target = parseUnitAttemptTarget(targetId);
            unitId = target.unitId;
            attempt = target.attempt;
        }
        validateReconciliationEvidenceDocument(bytes, {
            repoKey: repository.repo_key,
            autopilotId: run.autopilot_id,
            workstream: run.workstream,
            workstreamRun: run.workstream_run,
            source,
            targetId,
            unitId,
            attempt,
        });
        return bytes;
    }
    #updateAttemptForSatisfiedCondition(owner, conditionType) {
        const entityId = unitAttemptEntityId(owner);
        const row = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(entityId);
        if (row === undefined)
            return;
        const attempt = unitAttemptFromRow(row);
        const state = conditionType === 'child-terminal' ? 'transport-complete' : conditionType === 'unit-merged' ? 'merged' : conditionType === 'attempt-reset' ? 'reset' : conditionType === 'quarantine-captured' ? 'quarantined' : null;
        if (state === null || attempt.state === state)
            return;
        this.#updateEntity('unit_attempts', entityId, { ...attempt, state, version: attempt.version + 1 });
    }
    #updateAttemptFromEvidence(run, conditionType, targetId) {
        if (conditionType === 'run-closed' || conditionType === 'explicit-owner-release' || conditionType === 'child-terminal')
            return;
        const split = targetId.lastIndexOf(':');
        if (split <= 0)
            throw new CoordinationRuntimeError('invalid-request', `${conditionType} target must be unit-id:attempt`);
        const attempt = Number(targetId.slice(split + 1));
        if (!Number.isSafeInteger(attempt) || attempt < 1)
            throw new CoordinationRuntimeError('invalid-request', `${conditionType} target attempt is invalid`);
        this.#updateAttemptForSatisfiedCondition({ repo_id: run.repo_id, autopilot_id: run.autopilot_id, workstream_run: run.workstream_run, unit_id: targetId.slice(0, split), attempt }, conditionType);
    }
    #assertReconciliationTarget(run, conditionType, targetId) {
        if (conditionType === 'run-closed') {
            if (targetId !== run.workstream_run)
                throw new CoordinationRuntimeError('invalid-request', 'run-close evidence must target the current durable run');
            return;
        }
        if (conditionType === 'child-terminal') {
            const child = this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(targetId);
            if (child !== undefined && childFromRow(child).owner.workstream_run !== run.workstream_run)
                throw new CoordinationRuntimeError('unauthorized-client', 'child-terminal evidence targets a foreign run');
            return;
        }
        const split = targetId.lastIndexOf(':');
        if (split <= 0 || !Number.isSafeInteger(Number(targetId.slice(split + 1))) || Number(targetId.slice(split + 1)) < 1)
            throw new CoordinationRuntimeError('invalid-request', `${conditionType} evidence target must be unit-id:attempt`);
    }
    #reconciliationSource(value) {
        switch (value) {
            case 'child-process':
            case 'unit-merge':
            case 'attempt-reset':
            case 'quarantine-capture':
            case 'run-close':
            case 'run-abort': return value;
            default: throw new CoordinationRuntimeError('invalid-request', `unsupported reconciliation source ${value}`);
        }
    }
    #conditionTypeForSource(source) {
        switch (source) {
            case 'child-process': return 'child-terminal';
            case 'unit-merge': return 'unit-merged';
            case 'attempt-reset': return 'attempt-reset';
            case 'quarantine-capture': return 'quarantine-captured';
            case 'run-close':
            case 'run-abort': return 'run-closed';
        }
    }
    #emptyReconciliationSummary() {
        return { released_lease_ids: [], released_request_ids: [], notification_ids: [], offered_group_ids: [] };
    }
    #freezeReconciliationSummary(summary) {
        return {
            released_lease_ids: Object.freeze([...new Set(summary.released_lease_ids)].sort()),
            released_request_ids: Object.freeze([...new Set(summary.released_request_ids)].sort()),
            notification_ids: Object.freeze([...new Set(summary.notification_ids)].sort()),
            offered_group_ids: Object.freeze([...new Set(summary.offered_group_ids)].sort()),
        };
    }
    #requireMailboxCursor(repoId, workstreamRun) {
        return mailboxCursorFromRow(asRow(this.#db.prepare('SELECT * FROM mailbox_cursors WHERE repo_id=? AND workstream_run=?').get(repoId, workstreamRun), 'mailbox cursor'));
    }
    #advanceMailboxCursor(repoId, workstreamRun, kind) {
        const cursor = this.#requireMailboxCursor(repoId, workstreamRun);
        const deliveredRow = asRow(this.#db.prepare("SELECT COALESCE(MAX(created_event_seq), 0) AS cursor FROM messages WHERE repo_id=? AND recipient_workstream_run=? AND status IN ('delivered','acknowledged')").get(repoId, workstreamRun), 'delivered mailbox cursor');
        const firstUnacknowledged = this.#db.prepare("SELECT MIN(created_event_seq) AS cursor FROM messages WHERE repo_id=? AND recipient_workstream_run=? AND status!='acknowledged'").get(repoId, workstreamRun);
        const maxAcknowledged = asRow(this.#db.prepare("SELECT COALESCE(MAX(created_event_seq), 0) AS cursor FROM messages WHERE repo_id=? AND recipient_workstream_run=? AND status='acknowledged'").get(repoId, workstreamRun), 'acknowledged mailbox cursor');
        const delivered = Math.max(cursor.delivered_through_event_seq, sqlInteger(deliveredRow, 'cursor'));
        const unacknowledgedEvent = firstUnacknowledged === undefined || firstUnacknowledged['cursor'] === null ? null : sqlInteger(firstUnacknowledged, 'cursor');
        const acknowledgedMaximum = sqlInteger(maxAcknowledged, 'cursor');
        const acknowledged = kind === 'acknowledged'
            ? Math.max(cursor.acknowledged_through_event_seq, unacknowledgedEvent === null ? acknowledgedMaximum : Math.min(acknowledgedMaximum, Math.max(0, unacknowledgedEvent - 1)))
            : cursor.acknowledged_through_event_seq;
        if (delivered === cursor.delivered_through_event_seq && acknowledged === cursor.acknowledged_through_event_seq)
            return;
        this.#db.prepare('UPDATE mailbox_cursors SET delivered_through_event_seq=?, acknowledged_through_event_seq=?, version=version+1 WHERE repo_id=? AND workstream_run=?').run(delivered, acknowledged, repoId, workstreamRun);
    }
    #insertEntity(table, entityId, repoId, workstreamRun, entity) {
        this.#db.prepare(`INSERT INTO ${table}(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)`).run(entityId, repoId, workstreamRun, canonicalJson(entity), entity.version);
    }
    #updateEntity(table, entityId, entity) {
        const result = table === 'acquisition_groups'
            ? this.#db.prepare('UPDATE acquisition_groups SET payload_json=?, version=? WHERE repo_id=? AND entity_id=?').run(canonicalJson(entity), entity.version, entity.owner.repo_id, entityId)
            : this.#db.prepare(`UPDATE ${table} SET payload_json=?, version=? WHERE entity_id=?`).run(canonicalJson(entity), entity.version, entityId);
        if (result.changes !== 1)
            throw new CoordinationRuntimeError('invalid-state', `${table} entity ${entityId} disappeared during mutation`);
    }
    #insertOrVerifyUnitAttempt(attempt) {
        const entityId = unitAttemptEntityId(attempt.owner);
        const row = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(entityId);
        if (row === undefined) {
            this.#insertEntity('unit_attempts', entityId, attempt.owner.repo_id, attempt.owner.workstream_run, attempt);
            return;
        }
        const existing = unitAttemptFromRow(row);
        if (!sameOwner(existing.owner, attempt.owner) || canonicalJson(existing.spec) !== canonicalJson(attempt.spec) || existing.role !== attempt.role)
            throw new CoordinationRuntimeError('invalid-state', 'unit attempt identity was reused with different immutable spec evidence or role');
        if (existing.state === 'superseded' || existing.state === 'reset' || existing.state === 'failed' || existing.state === 'quarantined')
            throw new CoordinationRuntimeError('invalid-state', `unit attempt is ${existing.state}`);
    }
    #requireUnitAttempt(repoId, workstreamRun, unitId, attempt) {
        const run = this.#requireRun(repoId, workstreamRun);
        const owner = { repo_id: repoId, autopilot_id: run.autopilot_id, workstream_run: workstreamRun, unit_id: unitId, attempt };
        return unitAttemptFromRow(asRow(this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(unitAttemptEntityId(owner)), 'unit attempt'));
    }
    #requireGroup(repoId, groupId) {
        return acquisitionGroupFromRow(asRow(this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND entity_id=?').get(repoId, groupId), 'acquisition group'));
    }
    #requireClaimRequest(requestId) {
        return claimRequestFromRow(asRow(this.#db.prepare('SELECT * FROM claim_requests WHERE entity_id=?').get(requestId), 'claim request'));
    }
    #claimRequestsForGroup(repoId, groupId) {
        return this.#db.prepare("SELECT * FROM claim_requests WHERE repo_id=? AND json_extract(payload_json, '$.acquisition_group_id')=? ORDER BY entity_id").all(repoId, groupId).map(claimRequestFromRow);
    }
    #groupsForAttempt(owner) {
        return this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(owner.repo_id, owner.workstream_run).map(acquisitionGroupFromRow).filter((group) => sameOwner(group.owner, owner));
    }
    #assertReleaseConditionOwner(condition, owner) {
        if (condition.condition_type === 'run-closed' && condition.target_id !== owner.workstream_run)
            throw new CoordinationRuntimeError('invalid-request', 'run-closed condition must target the blocking owner run');
        if ((condition.condition_type === 'unit-merged' || condition.condition_type === 'attempt-reset' || condition.condition_type === 'quarantine-captured') && condition.target_id !== `${owner.unit_id}:${String(owner.attempt)}`)
            throw new CoordinationRuntimeError('invalid-request', `${condition.condition_type} condition must target the blocking owner unit attempt`);
        if (condition.condition_type === 'child-terminal') {
            const expectedChildId = `child-${owner.workstream_run}-${owner.unit_id}-${String(owner.attempt)}`;
            if (condition.target_id !== expectedChildId)
                throw new CoordinationRuntimeError('invalid-request', 'child-terminal condition must target the deterministic child lease for the blocking unit attempt');
            const row = this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(condition.target_id);
            if (row !== undefined && !sameOwner(childFromRow(row).owner, owner))
                throw new CoordinationRuntimeError('invalid-request', 'child-terminal condition targets a child lease with different durable ownership');
        }
    }
    #evidencePathUnderRoot(authorityRoot, ref) {
        const normalizedRef = ref.replace(/\\/gu, '/');
        if (normalizedRef.startsWith('/') || normalizedRef.startsWith('../') || normalizedRef.includes('/../') || normalizedRef === '..' || normalizedRef.includes('\u0000'))
            throw new CoordinationRuntimeError('unauthorized-client', 'contradiction evidence ref must be normalized and authority-relative', [ref]);
        const root = realpathSync(authorityRoot);
        const target = resolve(root, normalizedRef);
        const rel = relative(root, target);
        if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
            throw new CoordinationRuntimeError('unauthorized-client', 'contradiction evidence ref escapes its registered authority root', [ref]);
        return target;
    }
    #requireRunMainRoot(repoId, workstreamRun) {
        const rows = this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.kind')='main' AND json_extract(payload_json, '$.state')!='removed' ORDER BY entity_id").all(repoId, workstreamRun).map(worktreeFromRow);
        if (rows.length !== 1)
            throw new CoordinationRuntimeError('invalid-state', 'run-main authoritative evidence requires exactly one active durable main worktree', [workstreamRun, `count=${String(rows.length)}`]);
        const worktree = rows[0];
        if (worktree === undefined)
            throw new CoordinationRuntimeError('invalid-state', 'run-main worktree disappeared');
        return worktree.canonical_path;
    }
    #readRegularEvidenceFile(path, label) {
        let descriptor = null;
        try {
            const before = lstatSync(path);
            if (!before.isFile() || before.isSymbolicLink())
                throw new CoordinationRuntimeError('unauthorized-client', `${label} must be a regular non-symbolic file`, [path]);
            const canonicalBefore = realpathSync(path);
            const openedDescriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
            descriptor = openedDescriptor;
            const opened = fstatSync(openedDescriptor);
            if (!opened.isFile() || opened.size > MAX_COORDINATION_EVIDENCE_BYTES)
                throw new CoordinationRuntimeError('invalid-request', `${label} must be a regular file no larger than ${String(MAX_COORDINATION_EVIDENCE_BYTES)} bytes`, [path, `size=${String(opened.size)}`]);
            if (opened.dev !== before.dev || opened.ino !== before.ino)
                throw new CoordinationRuntimeError('unauthorized-client', `${label} changed while coordinator authority was being established`, [path]);
            const bytes = readFileSync(openedDescriptor);
            const afterDescriptor = fstatSync(openedDescriptor);
            const afterPath = lstatSync(path);
            const canonicalAfter = realpathSync(path);
            if (bytes.byteLength !== opened.size || afterDescriptor.size !== opened.size || afterDescriptor.dev !== opened.dev || afterDescriptor.ino !== opened.ino || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino || canonicalAfter !== canonicalBefore)
                throw new CoordinationRuntimeError('unauthorized-client', `${label} changed during its atomic evidence read`, [path]);
            return bytes;
        }
        catch (error) {
            if (error instanceof CoordinationRuntimeError)
                throw error;
            throw new CoordinationRuntimeError('invalid-request', `${label} is unreadable`, [path, error instanceof Error ? error.message : String(error)]);
        }
        finally {
            if (descriptor !== null)
                closeSync(descriptor);
        }
    }
    #persistEvidenceArtifact(repoId, evidence, bytes, label, seq) {
        if (bytes.byteLength > MAX_COORDINATION_EVIDENCE_BYTES)
            throw new CoordinationRuntimeError('invalid-request', `${label} exceeds the immutable evidence size ceiling`);
        const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        if (actual !== evidence.sha256)
            throw new CoordinationRuntimeError('invalid-request', `${label} hash changed before immutable persistence`, [evidence.sha256, actual]);
        const entityId = stableEntityId('evidence', [repoId, evidence.sha256]);
        const existing = this.#db.prepare('SELECT sha256, size_bytes, content FROM evidence_artifacts WHERE entity_id=?').get(entityId);
        if (existing === undefined) {
            this.#db.prepare('INSERT INTO evidence_artifacts(entity_id, repo_id, sha256, ref, label, content, size_bytes, created_event_seq) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(entityId, repoId, evidence.sha256, evidence.ref, label, bytes, bytes.byteLength, seq);
            return;
        }
        const content = existing['content'];
        if (!(content instanceof Uint8Array) || sqlString(existing, 'sha256') !== evidence.sha256 || sqlInteger(existing, 'size_bytes') !== bytes.byteLength || !timingSafeEqual(content, bytes))
            throw new CoordinationRuntimeError('store-corrupt', 'immutable evidence artifact hash identity was reused with different bytes', [entityId]);
    }
    #loadEvidenceArtifact(repoId, evidence) {
        const row = asRow(this.#db.prepare('SELECT sha256, content, size_bytes FROM evidence_artifacts WHERE repo_id=? AND sha256=?').get(repoId, evidence.sha256), 'immutable evidence artifact');
        const content = row['content'];
        if (!(content instanceof Uint8Array) || sqlString(row, 'sha256') !== evidence.sha256 || sqlInteger(row, 'size_bytes') !== content.byteLength)
            throw new CoordinationRuntimeError('store-corrupt', 'immutable evidence artifact metadata or bytes are invalid', [evidence.ref, evidence.sha256]);
        const actual = `sha256:${createHash('sha256').update(content).digest('hex')}`;
        if (actual !== evidence.sha256)
            throw new CoordinationRuntimeError('store-corrupt', 'immutable evidence artifact bytes fail their durable hash', [evidence.ref, evidence.sha256, actual]);
        return content;
    }
    #assertWorktreeAuthority(worktree, operation) {
        const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(worktree.owner.repo_id), 'worktree repository'));
        if (operation.intent.repo_root !== repository.canonical_root || worktree.git_common_dir !== repository.git_common_dir || operation.intent.git_common_dir !== repository.git_common_dir)
            throw new CoordinationRuntimeError('unauthorized-client', 'worktree operation repository identity disagrees with the registered repository');
        if (operation.intent.worktree_path !== worktree.canonical_path || operation.intent.branch !== worktree.branch)
            throw new CoordinationRuntimeError('invalid-request', 'operation intent disagrees with immutable worktree identity');
        const repoWorktreeRoot = resolve(this.#stateRoot, 'worktrees', repository.repo_key);
        const taskRoot = resolve(repoWorktreeRoot, 'active', worktree.owner.workstream_run);
        const expectedPath = worktree.kind === 'main'
            ? resolve(taskRoot, 'main')
            : resolve(taskRoot, 'units', worktree.owner.unit_id, `attempt-${String(worktree.owner.attempt)}`, 'worktree');
        if (resolve(worktree.canonical_path) !== expectedPath)
            throw new CoordinationRuntimeError('unauthorized-client', 'worktree path is not derived from its durable run/unit ownership', [worktree.canonical_path, expectedPath]);
        const expectedBranch = worktree.kind === 'main'
            ? `autopilot/${worktree.owner.workstream_run}`
            : `autopilot/unit/${worktree.owner.workstream_run}/${worktree.owner.unit_id}/attempt-${String(worktree.owner.attempt)}`;
        if (worktree.branch !== expectedBranch)
            throw new CoordinationRuntimeError('unauthorized-client', 'worktree branch is not derived from its durable owner', [worktree.branch, expectedBranch]);
        if (operation.operation_type === 'create' && operation.intent.base_sha === null)
            throw new CoordinationRuntimeError('invalid-request', 'create operation requires immutable base_sha');
        if (operation.operation_type === 'create' && operation.intent.checkout_mode !== null && operation.intent.checkout_mode !== 'full' && operation.intent.sparse_patterns.length === 0)
            throw new CoordinationRuntimeError('invalid-request', 'sparse create operation requires non-empty patterns');
        if ((operation.operation_type === 'merge' || operation.operation_type === 'reset' || operation.operation_type === 'archive' || operation.operation_type === 'remove') && operation.intent.target_sha === null)
            throw new CoordinationRuntimeError('invalid-request', `${operation.operation_type} operation requires immutable target_sha`);
        if (operation.operation_type === 'archive' && operation.intent.archive_ref === null)
            throw new CoordinationRuntimeError('invalid-request', 'archive operation requires an archive_ref');
        if (operation.operation_type === 'archive' && operation.intent.archive_ref !== null && !operation.intent.archive_ref.startsWith(`autopilot/archive/${worktree.owner.workstream_run}/`))
            throw new CoordinationRuntimeError('unauthorized-client', 'archive operation ref is outside its run-owned namespace', [operation.intent.archive_ref]);
        if (operation.operation_type === 'materialize' && (operation.intent.sparse_patterns.length === 0 || operation.intent.paths.length === 0))
            throw new CoordinationRuntimeError('invalid-request', 'materialize operation requires non-empty sparse patterns and paths');
        if (operation.operation_type === 'commit' && (operation.intent.base_sha === null || operation.intent.paths.length === 0))
            throw new CoordinationRuntimeError('invalid-request', 'commit operation requires base_sha and exact changed paths');
        for (const path of operation.intent.paths) {
            const normalized = path.replace(/\\/gu, '/').replace(/\/\*\*$/u, '');
            if (normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../') || normalized === '..' || normalized.startsWith(':') || normalized.includes('\u0000') || normalized.length === 0)
                throw new CoordinationRuntimeError('invalid-request', 'operation path must be normalized repository-relative authority without Git pathspec magic', [path]);
        }
        for (const ref of operation.intent.metadata_refs) {
            const normalized = ref.replace(/\\/gu, '/');
            if (normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../') || normalized === '..' || normalized.includes('\u0000'))
                throw new CoordinationRuntimeError('invalid-request', 'operation metadata ref must remain relative to its owned task root', [ref]);
        }
    }
    #verifyOperationEvidenceFile(operation) {
        const evidence = operation.verification_evidence;
        if (evidence === null)
            throw new CoordinationRuntimeError('invalid-request', 'operation evidence is missing');
        const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(operation.owner.repo_id), 'operation evidence repository'));
        const expectedPrefix = `_saga-evidence/${operation.owner.workstream_run}/`;
        if (!evidence.ref.startsWith(expectedPrefix) || evidence.ref !== `${expectedPrefix}${operation.operation_id}.json`)
            throw new CoordinationRuntimeError('unauthorized-client', 'operation evidence ref is not derived from its durable owner and operation', [evidence.ref]);
        const evidenceRoot = resolve(this.#stateRoot, 'worktrees', repository.repo_key, '_saga-evidence', operation.owner.workstream_run);
        const evidencePath = resolve(this.#stateRoot, 'worktrees', repository.repo_key, evidence.ref);
        const relativeEvidence = relative(evidenceRoot, evidencePath);
        if (relativeEvidence.length === 0 || relativeEvidence === '..' || relativeEvidence.startsWith(`..${sep}`) || isAbsolute(relativeEvidence))
            throw new CoordinationRuntimeError('unauthorized-client', 'operation evidence escapes its run-owned evidence root');
        let bytes;
        try {
            const evidenceStat = lstatSync(evidencePath);
            if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink())
                throw new CoordinationRuntimeError('unauthorized-client', 'operation evidence must be a regular non-symbolic file', [evidencePath]);
            bytes = readFileSync(evidencePath);
        }
        catch (error) {
            if (error instanceof CoordinationRuntimeError)
                throw error;
            throw new CoordinationRuntimeError('recovery-required', 'operation evidence file is unreadable', [evidencePath, error instanceof Error ? error.message : String(error)]);
        }
        const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        if (actual !== evidence.sha256)
            throw new CoordinationRuntimeError('invalid-state', 'operation evidence hash does not match immutable artifact', [evidencePath, `expected=${evidence.sha256}`, `actual=${actual}`]);
        let parsed;
        try {
            parsed = parseJsonObject(Buffer.from(bytes).toString('utf8'), 'operation evidence');
        }
        catch (error) {
            throw new CoordinationRuntimeError('invalid-state', 'operation evidence is not valid JSON', [error instanceof Error ? error.message : String(error)]);
        }
        const expectedIntentSha = `sha256:${createHash('sha256').update(canonicalJson(operation.intent), 'utf8').digest('hex')}`;
        if (parsed['schema_version'] !== 'autopilot.worktree_operation_evidence.v1' || parsed['operation_id'] !== operation.operation_id || parsed['worktree_id'] !== operation.worktree_id || parsed['operation_type'] !== operation.operation_type || parsed['terminal_stage'] !== operation.stage || parsed['intent_sha256'] !== expectedIntentSha || canonicalJson(parsed['owner']) !== canonicalJson(operation.owner))
            throw new CoordinationRuntimeError('unauthorized-client', 'operation evidence identity or immutable intent does not match its durable operation');
    }
    #assertCommittedWorktreeState(operation, state) {
        const allowed = {
            create: ['active'], materialize: ['active'], commit: ['active'], merge: ['active', 'terminal'], reset: ['terminal'], quarantine: ['quarantined'], archive: ['active', 'terminal'], remove: ['removed'],
        };
        if (!allowed[operation.operation_type].includes(state))
            throw new CoordinationRuntimeError('invalid-request', `${operation.operation_type} operation cannot commit worktree state ${state}`);
    }
    #assertOperationTransition(previous, next) {
        const allowed = {
            prepared: ['in-progress', 'reconciling', 'compensated', 'failed'],
            'in-progress': ['in-progress', 'verified', 'reconciling', 'compensated', 'failed'],
            reconciling: ['in-progress', 'verified', 'reconciling', 'compensated', 'failed'],
            verified: ['committed', 'reconciling', 'failed'],
            committed: [], compensated: [], failed: [],
        };
        if (!(allowed[previous.stage] ?? []).includes(next.stage))
            throw new CoordinationRuntimeError('invalid-state', `worktree operation cannot transition ${previous.stage} -> ${next.stage}`);
        if (next.completed_steps.length < previous.completed_steps.length || previous.completed_steps.some((step, index) => next.completed_steps[index] !== step))
            throw new CoordinationRuntimeError('invalid-state', 'worktree operation completed steps cannot be removed or reordered');
        if (next.recovery_attempts < previous.recovery_attempts || next.recovery_attempts > previous.recovery_attempts + 1)
            throw new CoordinationRuntimeError('invalid-state', 'worktree operation recovery attempts must advance monotonically one at a time');
        if (previous.verification_evidence !== null && canonicalJson(previous.verification_evidence) !== canonicalJson(next.verification_evidence))
            throw new CoordinationRuntimeError('invalid-state', 'worktree operation verification evidence is immutable');
        if ((next.stage === 'verified' || next.stage === 'committed' || next.stage === 'compensated' || next.stage === 'failed') && next.verification_evidence === null)
            throw new CoordinationRuntimeError('invalid-request', `${next.stage} operation requires immutable verification evidence`);
        const requiredSteps = ['preflight-probe', 'external-action', 'postcondition-verification'];
        if ((next.stage === 'verified' || next.stage === 'committed') && (next.completed_steps.length !== requiredSteps.length || requiredSteps.some((step, index) => next.completed_steps[index] !== step)))
            throw new CoordinationRuntimeError('invalid-state', 'verified operation must complete the closed probe/action/verification step plan in order');
        if ((next.stage === 'verified' || next.stage === 'committed' || next.stage === 'compensated') && next.current_step !== null)
            throw new CoordinationRuntimeError('invalid-request', `${next.stage} operation cannot retain a current step`);
        if ((next.stage === 'reconciling' || next.stage === 'failed') && next.error_code === null)
            throw new CoordinationRuntimeError('invalid-request', `${next.stage} operation requires an error code`);
        if ((next.stage === 'in-progress' || next.stage === 'verified' || next.stage === 'committed' || next.stage === 'compensated') && next.error_code !== null)
            throw new CoordinationRuntimeError('invalid-request', `${next.stage} operation cannot retain an error code`);
    }
    #assertGroupOwner(request, group) {
        if (group.owner.repo_id !== request.repo_id || group.owner.workstream_run !== this.#workstreamRun(request))
            throw new CoordinationRuntimeError('unauthorized-client', 'session does not own acquisition group');
    }
    #assertRequestOwner(request, claimRequest) {
        if (claimRequest.owner.repo_id !== request.repo_id || claimRequest.owner.workstream_run !== this.#workstreamRun(request))
            throw new CoordinationRuntimeError('unauthorized-client', 'session is not the blocking claim owner');
    }
    #assertRequestRequester(request, claimRequest) {
        if (claimRequest.requester.repo_id !== request.repo_id || claimRequest.requester.workstream_run !== this.#workstreamRun(request))
            throw new CoordinationRuntimeError('unauthorized-client', 'session is not the claim requester');
    }
    #blockingLeases(repoId, requested) {
        const leases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? ORDER BY entity_id').all(repoId).map(editLeaseFromRow);
        return Object.freeze(leases.filter((lease) => requested.some((entry) => coordinationPathsOverlap(entry.path, lease.path) && claimModesConflict(entry.mode, lease.mode))));
    }
    #blockingGrantOffers(repoId, groupId, requested) {
        const offered = this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? ORDER BY entity_id').all(repoId).map(acquisitionGroupFromRow);
        return Object.freeze(offered.filter((group) => group.acquisition_group_id !== groupId && group.state === 'grant-ready' && requested.some((entry) => group.requested_leases.some((offeredLease) => coordinationPathsOverlap(entry.path, offeredLease.path) && claimModesConflict(entry.mode, offeredLease.mode)))));
    }
    #grantGroup(group, seq) {
        if (this.#blockingLeases(group.owner.repo_id, group.requested_leases).length > 0)
            throw new CoordinationRuntimeError('coordinator-contention', 'complete acquisition group became blocked before grant');
        const leases = group.requested_leases.map((requested, index) => ({
            schema_version: 'autopilot.edit_lease.v1',
            edit_lease_id: stableEntityId('lease', [group.owner.repo_id, group.acquisition_group_id, String(index), requested.mode, requested.path]),
            owner: group.owner, acquisition_group_id: group.acquisition_group_id, path: requested.path, mode: requested.mode, purpose: requested.purpose,
            acquired_event_seq: seq, normal_release_condition: group.normal_release_condition, version: 1,
        }));
        for (const lease of leases)
            this.#insertEntity('edit_leases', lease.edit_lease_id, lease.owner.repo_id, lease.owner.workstream_run, lease);
        const granted = { ...group, state: 'granted', grant_event_seq: seq, offer_expires_at: null, version: group.version + 1 };
        this.#updateEntity('acquisition_groups', group.acquisition_group_id, granted);
        return { group: granted, leases };
    }
    #ensureClaimRequests(group, blockers, seq) {
        const byOwner = new Map();
        for (const blocker of blockers) {
            const key = ownerIdentityKey(blocker.owner);
            const owned = byOwner.get(key) ?? [];
            owned.push(blocker);
            byOwner.set(key, owned);
        }
        const requests = [];
        for (const owned of [...byOwner.values()].sort((left, right) => ownerIdentityKey(left[0]?.owner ?? group.owner).localeCompare(ownerIdentityKey(right[0]?.owner ?? group.owner)))) {
            const owner = owned[0]?.owner;
            if (owner === undefined)
                continue;
            const leaseIds = owned.map((lease) => lease.edit_lease_id).sort();
            const requestId = stableEntityId('claim-request', [group.acquisition_group_id, ownerIdentityKey(owner), ...leaseIds]);
            const existingRow = this.#db.prepare('SELECT * FROM claim_requests WHERE entity_id=?').get(requestId);
            if (existingRow !== undefined) {
                requests.push(claimRequestFromRow(existingRow));
                continue;
            }
            const claimRequest = {
                schema_version: 'autopilot.claim_request.v1', request_id: requestId, acquisition_group_id: group.acquisition_group_id,
                requester: group.owner, owner, blocking_lease_ids: leaseIds, requested_leases: group.requested_leases, reason: group.reason,
                created_event_seq: seq, status: 'pending', owner_reason: null, release_condition: null, release_event_seq: null, grant_event_seq: null, version: 1,
            };
            this.#db.prepare('INSERT INTO claim_requests(entity_id, repo_id, requester_workstream_run, owner_workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?, ?)').run(requestId, owner.repo_id, group.owner.workstream_run, owner.workstream_run, canonicalJson(claimRequest), claimRequest.version);
            const message = {
                schema_version: 'autopilot.coordination_message.v1', message_id: stableEntityId('message', ['claim-request', requestId]), repo_id: owner.repo_id,
                recipient_workstream_run: owner.workstream_run, message_type: 'claim-request', correlation_id: requestId,
                payload: { request_id: requestId, acquisition_group_id: group.acquisition_group_id, requester_run: group.owner.workstream_run, requester_unit: group.owner.unit_id, requester_attempt: group.owner.attempt, blocking_lease_ids: leaseIds, requested_leases: group.requested_leases, reason: group.reason },
                status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
            };
            this.#insertMessage(message);
            requests.push(claimRequest);
        }
        return Object.freeze(requests);
    }
    #updateClaimRequest(claimRequest) {
        const result = this.#db.prepare('UPDATE claim_requests SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(claimRequest), claimRequest.version, claimRequest.request_id);
        if (result.changes !== 1)
            throw new CoordinationRuntimeError('invalid-state', `claim request ${claimRequest.request_id} disappeared during mutation`);
    }
    #insertMessage(message) {
        this.#db.prepare('INSERT INTO messages(message_id, repo_id, recipient_workstream_run, message_type, correlation_id, payload_json, status, created_event_seq, delivered_event_seq, acknowledged_event_seq, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(message.message_id, message.repo_id, message.recipient_workstream_run, message.message_type, message.correlation_id, canonicalJson(message.payload), message.status, message.created_event_seq, message.delivered_event_seq, message.acknowledged_event_seq, message.version);
    }
    #releaseNotification(claimRequest, releasedLeaseIds, seq) {
        return {
            schema_version: 'autopilot.coordination_message.v1', message_id: stableEntityId('message', ['release-notification', claimRequest.request_id, String(seq)]), repo_id: claimRequest.requester.repo_id,
            recipient_workstream_run: claimRequest.requester.workstream_run, message_type: 'release-notification', correlation_id: claimRequest.request_id,
            payload: { request_id: claimRequest.request_id, acquisition_group_id: claimRequest.acquisition_group_id, released_lease_ids: [...releasedLeaseIds], release_event_seq: seq },
            status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
        };
    }
    #markGroupReleasedWhenEmpty(repoId, groupId) {
        const count = sqlInteger(asRow(this.#db.prepare('SELECT COUNT(*) AS count FROM edit_leases WHERE repo_id=? AND json_extract(payload_json, \'$.acquisition_group_id\')=?').get(repoId, groupId), 'group lease count'), 'count');
        if (count !== 0)
            return;
        const group = this.#requireGroup(repoId, groupId);
        if (group.state === 'granted')
            this.#updateEntity('acquisition_groups', groupId, { ...group, state: 'released', version: group.version + 1 });
    }
    #markSatisfiedRequests(group, seq) {
        for (const claimRequest of this.#claimRequestsForGroup(group.owner.repo_id, group.acquisition_group_id)) {
            if (['resolved', 'cancelled', 'superseded', 'released', 'grant-ready', 'requester-notified'].includes(claimRequest.status))
                continue;
            const stillBlocked = claimRequest.blocking_lease_ids.some((leaseId) => this.#db.prepare('SELECT entity_id FROM edit_leases WHERE repo_id=? AND entity_id=?').get(group.owner.repo_id, leaseId) !== undefined);
            if (stillBlocked)
                continue;
            const released = { ...claimRequest, status: 'released', release_event_seq: seq, version: claimRequest.version + 1 };
            this.#updateClaimRequest(released);
            this.#insertMessage(this.#releaseNotification(released, claimRequest.blocking_lease_ids, seq));
        }
    }
    #reevaluateWaitingGroups(repoId, seq) {
        for (const group of this.#db.prepare("SELECT * FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state')='waiting' ORDER BY entity_id").all(repoId).map(acquisitionGroupFromRow)) {
            this.#markSatisfiedRequests(group, seq);
            this.#ensureClaimRequests(group, this.#blockingLeases(repoId, group.requested_leases), seq);
        }
        while (true) {
            const dependencyPriority = this.#grantDependencyPriority(repoId);
            const waiting = this.#db.prepare("SELECT * FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state')='waiting' ORDER BY entity_id").all(repoId).map(acquisitionGroupFromRow).sort((left, right) => (left.bypass_count >= MAX_GRANT_BYPASSES ? 0 : 1) - (right.bypass_count >= MAX_GRANT_BYPASSES ? 0 : 1) || (dependencyPriority.get(coordinationOwnerKey(right.owner)) ?? 0) - (dependencyPriority.get(coordinationOwnerKey(left.owner)) ?? 0) || compareCoordinationGrantPriority(left, right));
            const eligible = waiting.filter((group) => this.#blockingLeases(repoId, group.requested_leases).length === 0 && this.#blockingGrantOffers(repoId, group.acquisition_group_id, group.requested_leases).length === 0);
            const group = eligible[0];
            if (group === undefined)
                break;
            const offered = { ...group, state: 'grant-ready', offer_expires_at: new Date(this.#clock.now().getTime() + COORDINATOR_GRANT_OFFER_TTL_MS).toISOString(), version: group.version + 1 };
            this.#updateEntity('acquisition_groups', group.acquisition_group_id, offered);
            for (const claimRequest of this.#claimRequestsForGroup(repoId, group.acquisition_group_id)) {
                if (claimRequest.release_event_seq === null || ['cancelled', 'superseded', 'resolved'].includes(claimRequest.status))
                    continue;
                this.#updateClaimRequest({ ...claimRequest, status: 'grant-ready', version: claimRequest.version + 1 });
            }
            this.#insertMessage({
                schema_version: 'autopilot.coordination_message.v1', message_id: stableEntityId('message', ['grant-offer', group.owner.repo_id, group.acquisition_group_id, String(offered.version)]), repo_id: repoId,
                recipient_workstream_run: group.owner.workstream_run, message_type: 'grant-offer', correlation_id: group.acquisition_group_id,
                payload: { acquisition_group_id: group.acquisition_group_id, offer_expires_at: offered.offer_expires_at, request_refs: this.#claimRequestsForGroup(repoId, group.acquisition_group_id).map((entry) => entry.request_id) },
                status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
            });
            this.#ageBypassedGroups(offered, eligible.slice(1));
        }
    }
    #grantDependencyPriority(repoId) {
        const priorities = new Map();
        const leases = new Set(this.#db.prepare('SELECT entity_id FROM edit_leases WHERE repo_id=?').all(repoId).map((row) => sqlString(row, 'entity_id')));
        const requests = this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? ORDER BY entity_id').all(repoId).map(claimRequestFromRow);
        for (const request of requests) {
            if (['resolved', 'cancelled', 'superseded', 'released', 'grant-ready', 'granted', 'requester-notified'].includes(request.status))
                continue;
            if (!request.blocking_lease_ids.some((leaseId) => leases.has(leaseId)))
                continue;
            const key = coordinationOwnerKey(request.owner);
            priorities.set(key, (priorities.get(key) ?? 0) + 1);
        }
        return priorities;
    }
    #ageBypassedGroups(offered, otherwiseEligible) {
        for (const group of otherwiseEligible) {
            const incompatibleWithOffer = group.requested_leases.some((requested) => offered.requested_leases.some((candidate) => coordinationPathsOverlap(requested.path, candidate.path) && claimModesConflict(requested.mode, candidate.mode)));
            if (!incompatibleWithOffer)
                continue;
            this.#updateEntity('acquisition_groups', group.acquisition_group_id, { ...group, bypass_count: group.bypass_count + 1, version: group.version + 1 });
        }
    }
    #maintainWaitForGraph(repoId, seq) {
        for (;;) {
            const requests = this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? ORDER BY entity_id').all(repoId).map(claimRequestFromRow);
            const leases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? ORDER BY entity_id').all(repoId).map(editLeaseFromRow);
            const priorEdges = this.#db.prepare('SELECT * FROM wait_for_edges WHERE repo_id=? ORDER BY entity_id').all(repoId).map(waitForEdgeFromRow);
            const nextEdges = buildCoordinationWaitForEdges({ requests, editLeases: leases, priorEdges, eventSeq: seq });
            const priorById = new Map(priorEdges.map((edge) => [edge.edge_id, edge]));
            for (const edge of nextEdges) {
                const prior = priorById.get(edge.edge_id);
                if (prior === undefined)
                    this.#db.prepare('INSERT INTO wait_for_edges(entity_id, repo_id, request_id, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(edge.edge_id, edge.repo_id, edge.request_id, canonicalJson(edge), edge.version);
                else if (canonicalJson(prior) !== canonicalJson(edge))
                    this.#db.prepare('UPDATE wait_for_edges SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(edge), edge.version, edge.edge_id);
            }
            const activeEdges = nextEdges.filter((edge) => edge.state === 'active');
            const cycles = detectCoordinationWaitCycles(activeEdges);
            // A repeated pass is required only after cancel-and-supersede removed an
            // eligible victim and its live groups. Compute this finite durable measure
            // only for a cyclic graph so the common acyclic/scale path pays no query.
            const progressMeasure = cycles.length === 0 ? null : this.#deadlockFixedPointMeasure(repoId);
            const liveResolutionIds = new Set();
            for (const cycle of cycles) {
                const resolutionId = stableEntityId('deadlock', [repoId, ...cycle.edge_ids]);
                liveResolutionIds.add(resolutionId);
                const existingRow = this.#db.prepare('SELECT * FROM deadlock_resolutions WHERE entity_id=?').get(resolutionId);
                const existingResolution = existingRow === undefined ? null : deadlockResolutionFromRow(existingRow);
                if (existingResolution !== null && existingResolution.state !== 'deferred-no-safe-victim')
                    continue;
                const attempts = this.#db.prepare('SELECT * FROM unit_attempts WHERE repo_id=? ORDER BY entity_id').all(repoId).map(unitAttemptFromRow);
                const groups = this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? ORDER BY entity_id').all(repoId).map(acquisitionGroupFromRow);
                const children = this.#db.prepare('SELECT * FROM child_leases WHERE repo_id=? ORDER BY child_lease_id').all(repoId).map(childFromRow);
                const worktrees = this.#db.prepare('SELECT * FROM worktrees WHERE repo_id=? ORDER BY entity_id').all(repoId).map(worktreeFromRow);
                const operations = this.#db.prepare('SELECT * FROM worktree_operations WHERE repo_id=? ORDER BY entity_id').all(repoId).map(worktreeOperationFromRow);
                const victim = selectCoordinationDeadlockVictim(cycle, { attempts, acquisitionGroups: groups, claimRequests: requests, childLeases: children, worktrees, worktreeOperations: operations });
                if (existingResolution !== null && victim === null)
                    continue;
                const participantOwners = activeEdges.filter((edge) => cycle.edge_ids.includes(edge.edge_id)).flatMap((edge) => [edge.requester, edge.blocker]).filter((owner, index, all) => all.findIndex((candidate) => coordinationOwnerKey(candidate) === coordinationOwnerKey(owner)) === index).sort((left, right) => coordinationOwnerKey(left).localeCompare(coordinationOwnerKey(right)));
                const resolutionVersion = existingResolution === null ? 1 : existingResolution.version + 1;
                const createdEventSeq = existingResolution?.created_event_seq ?? seq;
                const resolution = victim === null ? {
                    schema_version: 'autopilot.deadlock_resolution.v1', resolution_id: resolutionId, repo_id: repoId, cycle_edge_ids: cycle.edge_ids, participant_owners: participantOwners,
                    state: 'deferred-no-safe-victim', victim: null, victim_class: null, action: 'none', reason: 'cycle has no participant outside a critical section with a mechanically safe preemption path', created_event_seq: createdEventSeq, resolved_event_seq: null, version: resolutionVersion,
                } : {
                    schema_version: 'autopilot.deadlock_resolution.v1', resolution_id: resolutionId, repo_id: repoId, cycle_edge_ids: cycle.edge_ids, participant_owners: participantOwners,
                    state: victim.action === 'cancel-and-supersede' ? 'victim-selected' : 'awaiting-recovery', victim: victim.owner, victim_class: victim.victim_class, action: victim.action,
                    reason: victim.action === 'cancel-and-supersede' ? 'queued or preflight victim can be cancelled without source mutation' : 'owner must complete reset or dirty-work quarantine before lease release', created_event_seq: createdEventSeq, resolved_event_seq: null, version: resolutionVersion,
                };
                parseCoordinationDeadlockResolution(resolution);
                if (existingResolution === null)
                    this.#db.prepare('INSERT INTO deadlock_resolutions(entity_id, repo_id, payload_json, version) VALUES(?, ?, ?, ?)').run(resolutionId, repoId, canonicalJson(resolution), resolution.version);
                else if (canonicalJson(existingResolution) !== canonicalJson(resolution))
                    this.#db.prepare('UPDATE deadlock_resolutions SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(resolution), resolution.version, resolutionId);
                if (victim === null) {
                    this.#deferCycleRequests(cycle.request_ids);
                    continue;
                }
                this.#insertDeadlockResolutionMessage(resolution, seq);
                if (victim.action !== 'cancel-and-supersede') {
                    this.#deferCycleRequests(cycle.request_ids);
                    continue;
                }
                const attempt = attempts.find((candidate) => coordinationOwnerKey(candidate.owner) === coordinationOwnerKey(victim.owner));
                if (attempt === undefined)
                    throw new CoordinationRuntimeError('invalid-state', 'selected deadlock victim attempt disappeared');
                for (const group of groups.filter((candidate) => coordinationOwnerKey(candidate.owner) === coordinationOwnerKey(victim.owner) && (candidate.state === 'waiting' || candidate.state === 'grant-ready' || candidate.state === 'granted')))
                    this.#cancelGroup(group, 'cancelled', seq);
                this.#updateEntity('unit_attempts', unitAttemptEntityId(attempt.owner), { ...attempt, state: 'superseded', version: attempt.version + 1 });
                const resolved = { ...resolution, state: 'resolved', resolved_event_seq: seq, version: resolution.version + 1 };
                parseCoordinationDeadlockResolution(resolved);
                this.#db.prepare('UPDATE deadlock_resolutions SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(resolved), resolved.version, resolutionId);
                this.#reevaluateWaitingGroups(repoId, seq);
            }
            const openRows = this.#db.prepare("SELECT * FROM deadlock_resolutions WHERE repo_id=? AND json_extract(payload_json, '$.state')!='resolved' ORDER BY entity_id").all(repoId).map(deadlockResolutionFromRow);
            for (const resolution of openRows) {
                if (liveResolutionIds.has(resolution.resolution_id))
                    continue;
                const resolved = { ...resolution, state: 'resolved', resolved_event_seq: seq, version: resolution.version + 1 };
                parseCoordinationDeadlockResolution(resolved);
                this.#db.prepare('UPDATE deadlock_resolutions SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(resolved), resolved.version, resolution.resolution_id);
            }
            // With no cycle, no resolution branch above can have changed requests,
            // leases, or edges. The already persisted nextEdges are the fixed point;
            // rebuilding and reparsing the entire graph a second time is redundant.
            if (cycles.length === 0)
                return;
            const refreshedRequests = this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? ORDER BY entity_id').all(repoId).map(claimRequestFromRow);
            const refreshedLeases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? ORDER BY entity_id').all(repoId).map(editLeaseFromRow);
            const refreshedPrior = this.#db.prepare('SELECT * FROM wait_for_edges WHERE repo_id=? ORDER BY entity_id').all(repoId).map(waitForEdgeFromRow);
            const refreshedEdges = buildCoordinationWaitForEdges({ requests: refreshedRequests, editLeases: refreshedLeases, priorEdges: refreshedPrior, eventSeq: seq });
            for (const edge of refreshedEdges) {
                const prior = refreshedPrior.find((candidate) => candidate.edge_id === edge.edge_id);
                if (prior !== undefined && canonicalJson(prior) !== canonicalJson(edge))
                    this.#db.prepare('UPDATE wait_for_edges SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(edge), edge.version, edge.edge_id);
            }
            const remainingCycles = detectCoordinationWaitCycles(refreshedEdges.filter((edge) => edge.state === 'active'));
            const missingTypedResolution = remainingCycles.some((cycle) => {
                const resolutionId = stableEntityId('deadlock', [repoId, ...cycle.edge_ids]);
                const row = this.#db.prepare("SELECT entity_id FROM deadlock_resolutions WHERE entity_id=? AND json_extract(payload_json, '$.state')!='resolved'").get(resolutionId);
                return row === undefined;
            });
            if (!missingTypedResolution)
                return;
            const nextProgressMeasure = this.#deadlockFixedPointMeasure(repoId);
            if (progressMeasure === null || nextProgressMeasure >= progressMeasure)
                throw new CoordinationRuntimeError('store-corrupt', 'deadlock fixed-point progression did not consume an eligible attempt/group', [`before=${String(progressMeasure)}`, `after=${String(nextProgressMeasure)}`]);
        }
    }
    #deadlockFixedPointMeasure(repoId) {
        const eligibleOwners = new Set(this.#db.prepare("SELECT * FROM unit_attempts WHERE repo_id=? AND json_extract(payload_json, '$.state') IN ('queued','preflight') ORDER BY entity_id").all(repoId).map(unitAttemptFromRow).map((attempt) => coordinationOwnerKey(attempt.owner)));
        if (eligibleOwners.size === 0)
            return 0;
        const eligibleGroups = this.#db.prepare("SELECT * FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state') IN ('waiting','grant-ready','granted') ORDER BY entity_id").all(repoId).map(acquisitionGroupFromRow).filter((group) => eligibleOwners.has(coordinationOwnerKey(group.owner))).length;
        return eligibleOwners.size + eligibleGroups;
    }
    #deferCycleRequests(requestIds) {
        for (const requestId of requestIds) {
            const request = this.#requireClaimRequest(requestId);
            if (request.status === 'deferred' || request.status === 'resolved' || request.status === 'cancelled' || request.status === 'superseded')
                continue;
            const blockers = request.blocking_lease_ids.map((leaseId) => this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND entity_id=?').get(request.requester.repo_id, leaseId)).filter((row) => row !== undefined).map(editLeaseFromRow).map((lease) => ({ lease, conditionEventSeq: this.#requireGroup(lease.owner.repo_id, lease.acquisition_group_id).created_event_seq })).sort((left, right) => left.conditionEventSeq - right.conditionEventSeq || left.lease.edit_lease_id.localeCompare(right.lease.edit_lease_id));
            const blocker = blockers[0];
            if (blocker === undefined)
                continue;
            this.#updateClaimRequest({ ...request, status: 'deferred', owner_reason: 'deadlock policy deferred this request to the earliest declared owner release condition', release_condition: blocker.lease.normal_release_condition, version: request.version + 1 });
        }
    }
    #insertDeadlockResolutionMessage(resolution, seq) {
        if (resolution.victim === null)
            return;
        const messageId = stableEntityId('message', ['deadlock-resolution', resolution.resolution_id]);
        if (this.#db.prepare('SELECT message_id FROM messages WHERE message_id=?').get(messageId) !== undefined)
            return;
        this.#insertMessage({
            schema_version: 'autopilot.coordination_message.v1', message_id: messageId, repo_id: resolution.repo_id, recipient_workstream_run: resolution.victim.workstream_run,
            message_type: 'deadlock-resolution', correlation_id: resolution.resolution_id,
            payload: { resolution_id: resolution.resolution_id, victim: resolution.victim, victim_class: resolution.victim_class, action: resolution.action, reason: resolution.reason, cycle_edge_ids: resolution.cycle_edge_ids },
            status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
        });
    }
    #expireGrantOffers(repoId, seq) {
        const now = this.#clock.now().toISOString();
        const offered = this.#db.prepare("SELECT * FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state')='grant-ready' ORDER BY entity_id").all(repoId).map(acquisitionGroupFromRow);
        let expired = false;
        for (const group of offered) {
            if (group.offer_expires_at === null || group.offer_expires_at > now)
                continue;
            expired = true;
            this.#updateEntity('acquisition_groups', group.acquisition_group_id, { ...group, state: 'waiting', offer_expires_at: null, offer_count: group.offer_count + 1, version: group.version + 1 });
            this.#db.prepare("UPDATE messages SET status='acknowledged', delivered_event_seq=COALESCE(delivered_event_seq, ?), acknowledged_event_seq=COALESCE(acknowledged_event_seq, ?), version=version+1 WHERE repo_id=? AND correlation_id=? AND message_type='grant-offer' AND status!='acknowledged'").run(seq, seq, repoId, group.acquisition_group_id);
            this.#advanceMailboxCursor(repoId, group.owner.workstream_run, 'acknowledged');
            for (const claimRequest of this.#claimRequestsForGroup(repoId, group.acquisition_group_id)) {
                if (claimRequest.status === 'grant-ready')
                    this.#updateClaimRequest({ ...claimRequest, status: 'released', version: claimRequest.version + 1 });
            }
        }
        return expired;
    }
    #cancelGroup(group, status, seq) {
        if (group.state === 'granted') {
            if (status !== 'cancelled')
                throw new CoordinationRuntimeError('invalid-state', 'granted acquisition group cannot be superseded before terminal recovery');
            const attempt = this.#requireUnitAttempt(group.owner.repo_id, group.owner.workstream_run, group.owner.unit_id, group.owner.attempt);
            if (attempt.state !== 'preflight')
                throw new CoordinationRuntimeError('invalid-state', `granted acquisition group can be cancelled only during clean preflight, attempt is ${attempt.state}`);
            const child = this.#db.prepare('SELECT child_lease_id FROM child_leases WHERE repo_id=? AND workstream_run=? AND unit_id=? AND attempt=? LIMIT 1').get(group.owner.repo_id, group.owner.workstream_run, group.owner.unit_id, group.owner.attempt);
            if (child !== undefined)
                throw new CoordinationRuntimeError('invalid-state', 'granted acquisition group cannot be cancelled after child authority registration');
            const leases = this.#db.prepare("SELECT * FROM edit_leases WHERE repo_id=? AND json_extract(payload_json, '$.acquisition_group_id')=? ORDER BY entity_id").all(group.owner.repo_id, group.acquisition_group_id).map(editLeaseFromRow);
            for (const lease of leases)
                this.#db.prepare('DELETE FROM edit_leases WHERE repo_id=? AND entity_id=?').run(group.owner.repo_id, lease.edit_lease_id);
        }
        else if (group.state !== 'waiting' && group.state !== 'grant-ready') {
            throw new CoordinationRuntimeError('invalid-state', `cannot ${status} acquisition group in state ${group.state}`);
        }
        this.#updateEntity('acquisition_groups', group.acquisition_group_id, { ...group, state: status, offer_expires_at: null, version: group.version + 1 });
        for (const claimRequest of this.#claimRequestsForGroup(group.owner.repo_id, group.acquisition_group_id)) {
            if (claimRequest.status === 'resolved' || claimRequest.status === 'cancelled' || claimRequest.status === 'superseded')
                continue;
            this.#updateClaimRequest({ ...claimRequest, status, version: claimRequest.version + 1 });
        }
        const affectedMailboxRuns = this.#db.prepare("SELECT DISTINCT recipient_workstream_run FROM messages WHERE repo_id=? AND (correlation_id=? OR correlation_id IN (SELECT entity_id FROM claim_requests WHERE repo_id=? AND json_extract(payload_json, '$.acquisition_group_id')=?)) AND status!='acknowledged' ORDER BY recipient_workstream_run").all(group.owner.repo_id, group.acquisition_group_id, group.owner.repo_id, group.acquisition_group_id).map((row) => sqlString(row, 'recipient_workstream_run'));
        this.#db.prepare("UPDATE messages SET status='acknowledged', delivered_event_seq=COALESCE(delivered_event_seq, ?), acknowledged_event_seq=COALESCE(acknowledged_event_seq, ?), version=version+1 WHERE repo_id=? AND (correlation_id=? OR correlation_id IN (SELECT entity_id FROM claim_requests WHERE repo_id=? AND json_extract(payload_json, '$.acquisition_group_id')=?)) AND status!='acknowledged'").run(seq, seq, group.owner.repo_id, group.acquisition_group_id, group.owner.repo_id, group.acquisition_group_id);
        for (const workstreamRun of affectedMailboxRuns)
            this.#advanceMailboxCursor(group.owner.repo_id, workstreamRun, 'acknowledged');
    }
    #repositoryHasCoordinationGraph(repoId) {
        if (this.#semanticReplayTransactionActive && this.#semanticReplayGraphlessRepositories.has(repoId))
            return false;
        const present = this.#db.prepare("SELECT 1 AS present WHERE EXISTS(SELECT 1 FROM acquisition_groups WHERE repo_id=? LIMIT 1) OR EXISTS(SELECT 1 FROM edit_leases WHERE repo_id=? LIMIT 1) OR EXISTS(SELECT 1 FROM claim_requests WHERE repo_id=? LIMIT 1) OR EXISTS(SELECT 1 FROM wait_for_edges WHERE repo_id=? LIMIT 1)").get(repoId, repoId, repoId, repoId) !== undefined;
        if (!present && this.#semanticReplayTransactionActive)
            this.#semanticReplayGraphlessRepositories.add(repoId);
        return present;
    }
    #sessionMutation(request, eventType, apply) {
        return this.#mutation(request, () => {
            const session = this.#requireCurrentSession(request);
            this.#assertVersion(session.version, request.expected_version, 'session lease');
            const seq = this.#nextEventSequence(request.repo_id);
            const applied = apply(session, seq);
            return { sequence: seq, eventType, entityType: 'session-lease', entityId: applied.entityId, payload: applied.payload };
        });
    }
    #mutation(request, apply) {
        const idempotencyKey = request.idempotency_key;
        if (idempotencyKey === null)
            throw new CoordinationRuntimeError('invalid-request', 'mutation lacks idempotency key');
        const digest = requestDigest(request);
        const ownsTransaction = !this.#semanticReplayTransactionActive;
        if (ownsTransaction)
            this.#db.exec('BEGIN IMMEDIATE');
        try {
            const prior = this.#idempotencyLookup.get(request.repo_id, idempotencyKey);
            if (prior !== undefined) {
                this.#assertReplayAuthority(request);
                if (sqlString(prior, 'request_sha256') !== digest)
                    throw new CoordinationRuntimeError('idempotency-conflict', 'idempotency key was reused with a different request');
                const replay = { committedEventSeq: sqlInteger(prior, 'committed_event_seq'), payload: parseJsonObject(sqlString(prior, 'payload_json'), 'idempotency payload'), replayed: true };
                if (ownsTransaction)
                    this.#db.exec('COMMIT');
                return replay;
            }
            const result = apply();
            if (request.action !== 'heartbeat' || this.#repositoryHasCoordinationGraph(request.repo_id))
                this.#maintainWaitForGraph(request.repo_id, result.sequence);
            const committed = this.#commitDescription(result.sequence, result.eventType, result.entityType, result.entityId, result.payload);
            this.#insertEvent.run(request.repo_id, result.sequence, result.eventType, result.entityType, result.entityId, idempotencyKey, digest, this.#clock.now().toISOString());
            this.#insertIdempotencyResult.run(request.repo_id, idempotencyKey, digest, result.sequence, canonicalJson(committed.payload));
            if (ownsTransaction)
                this.#db.exec('COMMIT');
            return { ...committed, replayed: false };
        }
        catch (error) {
            if (ownsTransaction)
                this.#db.exec('ROLLBACK');
            throw error;
        }
    }
    #commitDescription(sequence, eventType, entityType, entityId, payload) {
        return { committedEventSeq: sequence, payload: { ...payload, event_type: eventType, entity_type: entityType, entity_id: entityId } };
    }
    #nextEventSequence(repoId) {
        return sqlInteger(asRow(this.#incrementRepositorySequence.get(repoId), 'repository event sequence'), 'event_seq');
    }
    #pendingMigrationRecovery(repoId, workstreamRun) {
        return Object.freeze(this.#pendingMigrationRecoveryByRun.all(repoId, workstreamRun).map(migrationRecoveryFromRow));
    }
    #migrationRecoveryClaim(work) {
        const detail = work.detail;
        const path = detail['claim_path'];
        const mode = detail['claim_mode'];
        const unitId = detail['unit_id'];
        const attempt = detail['attempt'];
        const editLeaseId = detail['edit_lease_id'];
        if (typeof path !== 'string' || typeof unitId !== 'string' || typeof editLeaseId !== 'string' || (mode !== 'READ' && mode !== 'WRITE' && mode !== 'EXCLUSIVE') || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1)
            throw new CoordinationRuntimeError('store-corrupt', 'ambiguous migration recovery detail lacks exact imported claim identity', [work.recovery_id]);
        return { path, mode, unitId, attempt, editLeaseId };
    }
    #readMigrationRecoveryEvidenceFile(run, evidence) {
        const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'migration recovery repository'));
        const root = resolve(this.#stateRoot, 'migration-recovery-evidence', repository.repo_key, run.workstream_run);
        const path = resolve(root, evidence.ref);
        const relativePath = relative(root, path);
        if (relativePath.length === 0 || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
            throw new CoordinationRuntimeError('unauthorized-client', 'migration recovery evidence escapes its coordinator-owned recovery root', [path]);
        let bytes;
        try {
            const realRoot = realpathSync(root);
            const realPath = realpathSync(path);
            const realRelative = relative(realRoot, realPath);
            if (realRelative.length === 0 || realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative))
                throw new CoordinationRuntimeError('unauthorized-client', 'migration recovery evidence physically escapes its coordinator-owned recovery root', [path]);
            bytes = this.#readRegularEvidenceFile(path, 'migration recovery evidence');
        }
        catch (error) {
            if (error instanceof CoordinationRuntimeError)
                throw error;
            throw new CoordinationRuntimeError('recovery-required', 'migration recovery evidence is unreadable', [path, error instanceof Error ? error.message : String(error)]);
        }
        const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        if (actual !== evidence.sha256)
            throw new CoordinationRuntimeError('invalid-state', 'migration recovery evidence hash does not match the fenced artifact', [path, `expected=${evidence.sha256}`, `actual=${actual}`]);
        return bytes;
    }
    #parseMigrationRecoveryEvidence(bytes) {
        let parsed;
        try {
            parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        }
        catch (error) {
            throw new CoordinationRuntimeError('invalid-state', 'migration recovery evidence is not valid UTF-8 JSON', [error instanceof Error ? error.message : String(error)]);
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            throw new CoordinationRuntimeError('invalid-state', 'migration recovery evidence must be a JSON object');
        return parsed;
    }
    #verifyMigrationRetentionEvidence(run, work, claim, evidence) {
        const document = this.#parseMigrationRecoveryEvidence(this.#readMigrationRecoveryEvidenceFile(run, evidence));
        const fields = ['attempt', 'autopilot_id', 'claim_mode', 'claim_path', 'edit_lease_id', 'recorded_event_seq', 'recovery_id', 'repo_id', 'resolution_type', 'schema_version', 'unit_id', 'workstream', 'workstream_run'];
        const actual = Object.keys(document).sort();
        if (actual.length !== fields.length || actual.some((field, index) => field !== [...fields].sort()[index]))
            throw new CoordinationRuntimeError('schema-mismatch', 'authority retention evidence fields are not the exact closed contract', actual);
        if (document['schema_version'] !== 'autopilot.migration_authority_recovery.v1' || document['resolution_type'] !== 'authority-retained' || document['repo_id'] !== run.repo_id || document['autopilot_id'] !== run.autopilot_id || document['workstream'] !== run.workstream || document['workstream_run'] !== run.workstream_run || document['recovery_id'] !== work.recovery_id || document['claim_path'] !== claim.path || document['claim_mode'] !== claim.mode || document['unit_id'] !== claim.unitId || document['attempt'] !== claim.attempt || document['edit_lease_id'] !== claim.editLeaseId || typeof document['recorded_event_seq'] !== 'number' || !Number.isSafeInteger(document['recorded_event_seq']) || document['recorded_event_seq'] < 1)
            throw new CoordinationRuntimeError('invalid-state', 'authority retention evidence does not bind the exact imported claim and durable owner', [work.recovery_id]);
    }
    #verifyMigrationReleasePostconditions(run, work, claim, source, targetId, evidence) {
        const bytes = this.#readMigrationRecoveryEvidenceFile(run, evidence);
        const unitTarget = source === 'unit-merge' || source === 'attempt-reset' || source === 'quarantine-capture' ? parseUnitAttemptTarget(targetId) : null;
        if (unitTarget !== null && (unitTarget.unitId !== claim.unitId || unitTarget.attempt !== claim.attempt))
            throw new CoordinationRuntimeError('invalid-state', 'migration recovery release target does not match the exact imported claim owner', [work.recovery_id, targetId]);
        if ((source === 'run-close' || source === 'run-abort') && targetId !== run.workstream_run)
            throw new CoordinationRuntimeError('invalid-state', 'run-terminal migration recovery target must be the exact durable run', [targetId, run.workstream_run]);
        validateReconciliationEvidenceDocument(bytes, { repoKey: run.repo_id, autopilotId: run.autopilot_id, workstream: run.workstream, workstreamRun: run.workstream_run, source, targetId, unitId: unitTarget?.unitId ?? null, attempt: unitTarget?.attempt ?? null });
        const resource = runResourceFromRow(asRow(this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run), 'migration recovery run resource'));
        const postconditions = [`claim:${claim.mode}:${claim.path}`, `edit-lease-release:${claim.editLeaseId}`, `evidence:${evidence.sha256}`];
        if (source === 'unit-merge') {
            const facts = parseUnitMergeReservationFacts(bytes);
            const document = this.#parseMigrationRecoveryEvidence(bytes);
            const unitHeadValue = document['unit_head'];
            const unitHead = typeof unitHeadValue === 'string' ? this.#gitText(resource.source_repo, ['rev-parse', '--verify', `${unitHeadValue}^{commit}`]) : null;
            const before = this.#gitText(resource.source_repo, ['rev-parse', '--verify', `${facts.integrationBefore}^{commit}`]);
            const after = this.#gitText(resource.source_repo, ['rev-parse', '--verify', `${facts.integrationAfter}^{commit}`]);
            const mergeCommit = this.#gitText(resource.source_repo, ['rev-parse', '--verify', `${facts.mergeCommitSha}^{commit}`]);
            const head = this.#gitText(resource.main_worktree_path, ['rev-parse', 'HEAD']);
            const branch = this.#gitText(resource.main_worktree_path, ['symbolic-ref', '--short', 'HEAD']);
            const beforeAncestor = before !== null && after !== null && spawnSync('git', ['merge-base', '--is-ancestor', before, after], { cwd: resource.source_repo, encoding: 'utf8', timeout: 30_000 }).status === 0;
            const unitAncestor = unitHead !== null && after !== null && spawnSync('git', ['merge-base', '--is-ancestor', unitHead, after], { cwd: resource.source_repo, encoding: 'utf8', timeout: 30_000 }).status === 0;
            const diff = before === null || after === null ? null : spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', before, after], { cwd: resource.source_repo, encoding: 'utf8', timeout: 30_000 });
            const actualPaths = diff?.status === 0 ? diff.stdout.split('\0').filter((entry) => entry.length > 0).map((entry) => entry.replace(/\\/gu, '/')).sort() : [];
            const declaredPaths = [...facts.changedPaths].sort();
            const claimCovered = declaredPaths.some((changedPath) => coordinationPathsOverlap(claim.path, changedPath));
            if (document['main_branch'] !== resource.branch || head !== after || after === null || mergeCommit !== after || branch !== resource.branch || !beforeAncestor || !unitAncestor || diff?.status !== 0 || canonicalJson(actualPaths) !== canonicalJson(declaredPaths) || !claimCovered)
                throw new CoordinationRuntimeError('invalid-state', 'unit-merge migration recovery lacks exact claim/Git object/ref/ancestry/diff postconditions', [`claim=${claim.path}`, `head=${String(head)}`, `integration_after=${String(after)}`, `branch=${String(branch)}`, `actual_paths=${actualPaths.join(',')}`, `declared_paths=${declaredPaths.join(',')}`]);
            postconditions.push(`main-head:${head}`, `main-branch:${branch}`, `claim-covered-by-diff:${claim.path}`);
        }
        else if (source === 'attempt-reset') {
            const worktree = this.#migrationRecoveryUnitWorktree(run, claim.unitId, claim.attempt);
            const document = this.#parseMigrationRecoveryEvidence(bytes);
            if (document['unit_worktree_path'] !== worktree.canonical_path || document['capture_commit_sha'] !== null || (worktree.state !== 'terminal' && worktree.state !== 'removed') || existsSync(worktree.canonical_path) || this.#gitWorktreeRegistered(resource.source_repo, worktree.canonical_path) || this.#gitText(resource.source_repo, ['rev-parse', '--verify', `refs/heads/${worktree.branch}`]) !== null)
                throw new CoordinationRuntimeError('invalid-state', 'attempt-reset migration recovery postconditions are not exact', [worktree.canonical_path, worktree.branch, worktree.state]);
            postconditions.push(`worktree-absent:${worktree.canonical_path}`, `branch-ref-absent:${worktree.branch}`, `worktree-state:${worktree.state}`);
        }
        else if (source === 'quarantine-capture') {
            const worktree = this.#migrationRecoveryUnitWorktree(run, claim.unitId, claim.attempt);
            const document = this.#parseMigrationRecoveryEvidence(bytes);
            const capture = document['capture_commit_sha'];
            const head = existsSync(worktree.canonical_path) ? this.#gitText(worktree.canonical_path, ['rev-parse', 'HEAD']) : null;
            const branch = existsSync(worktree.canonical_path) ? this.#gitText(worktree.canonical_path, ['symbolic-ref', '--short', 'HEAD']) : null;
            const branchRef = this.#gitText(resource.source_repo, ['rev-parse', '--verify', `refs/heads/${worktree.branch}`]);
            const clean = existsSync(worktree.canonical_path) ? this.#gitText(worktree.canonical_path, ['status', '--porcelain=v1', '-z']) : null;
            if (document['unit_worktree_path'] !== worktree.canonical_path || worktree.state !== 'quarantined' || typeof capture !== 'string' || head !== capture || branch !== worktree.branch || branchRef !== capture || clean !== '')
                throw new CoordinationRuntimeError('invalid-state', 'quarantine migration recovery requires the exact clean captured worktree/ref postcondition', [worktree.canonical_path, String(capture), String(head), String(branch), String(branchRef), String(clean)]);
            postconditions.push(`quarantined-head:${capture}`, `quarantined-branch:${worktree.branch}`, `clean-worktree:${worktree.canonical_path}`);
        }
        else {
            const expectedStatus = source === 'run-close' ? 'closed' : 'aborted';
            const main = this.#migrationRecoveryMainWorktree(run);
            const terminalSha = parseRunTerminalSha(bytes);
            const archiveRef = `autopilot/archive/${run.workstream_run}/${source === 'run-close' ? 'main' : 'aborted'}`;
            if (run.status !== expectedStatus || (main.state !== 'terminal' && main.state !== 'removed') || existsSync(main.canonical_path) || this.#gitWorktreeRegistered(resource.source_repo, main.canonical_path) || this.#gitText(resource.source_repo, ['rev-parse', '--verify', `refs/heads/${main.branch}`]) !== null || this.#gitText(resource.source_repo, ['rev-parse', '--verify', `refs/heads/${archiveRef}`]) !== terminalSha || source === 'run-close' && (resource.target_branch === null || this.#gitText(resource.source_repo, ['rev-parse', '--verify', `refs/heads/${resource.target_branch}`]) !== terminalSha))
                throw new CoordinationRuntimeError('invalid-state', 'run-terminal migration recovery postconditions are not exact and terminal state was not changed', [run.status, main.state, main.canonical_path, main.branch, archiveRef, terminalSha]);
            postconditions.push(`run-status:${run.status}`, `main-worktree-absent:${main.canonical_path}`, `archive-ref:${archiveRef}:${terminalSha}`);
        }
        return Object.freeze(postconditions);
    }
    #migrationRecoveryUnitWorktree(run, unitId, attempt) {
        const rows = this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.owner.unit_id')=? AND json_extract(payload_json, '$.owner.attempt')=? ORDER BY entity_id").all(run.repo_id, run.workstream_run, unitId, attempt).map(worktreeFromRow);
        if (rows.length !== 1 || rows[0] === undefined)
            throw new CoordinationRuntimeError('invalid-state', 'migration recovery requires exactly one matching durable unit worktree', [unitId, String(attempt)]);
        return rows[0];
    }
    #migrationRecoveryMainWorktree(run) {
        const rows = this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.kind')='main' ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(worktreeFromRow);
        if (rows.length !== 1 || rows[0] === undefined)
            throw new CoordinationRuntimeError('invalid-state', 'migration recovery requires exactly one durable main worktree', [run.workstream_run]);
        return rows[0];
    }
    #gitText(cwd, args) {
        const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', timeout: 30_000 });
        return result.status === 0 ? result.stdout.trim() : null;
    }
    #gitWorktreeRegistered(repoRoot, candidate) {
        const result = spawnSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
        if (result.status !== 0)
            throw new CoordinationRuntimeError('recovery-required', 'Git worktree registration inspection failed', [repoRoot, result.stderr]);
        const expected = resolve(candidate);
        return result.stdout.split('\0').some((entry) => entry.startsWith('worktree ') && resolve(entry.slice('worktree '.length)) === expected);
    }
    #requireRun(repoId, workstreamRun) {
        return runFromRow(asRow(this.#runByIdentity.get(repoId, workstreamRun), 'run'));
    }
    #requireCoordinatorEditAuthority(run, operation) {
        if (run.coordination_authority !== 'coordinator-edit-leases-v1')
            throw new CoordinationRuntimeError('unauthorized-client', `${operation} refused because ${run.workstream_run} is legacy-path-claim authoritative`);
    }
    #requireCurrentSession(request) {
        const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
        if ((run.status === 'closed' || run.status === 'aborted') && !TERMINAL_SESSION_ACTIONS.has(request.action))
            throw new CoordinationRuntimeError('invalid-state', `terminal run ${run.workstream_run} rejects new coordination action ${request.action}`);
        const sessionId = this.#sessionId(request);
        const generation = request.fencing_generation;
        if (generation === null || generation !== run.active_session_generation)
            throw new CoordinationRuntimeError('fenced-session', 'session generation is no longer current');
        let row = this.#attachedSessionByIdentity.get(request.repo_id, run.workstream_run, sessionId, generation);
        if (row === undefined && request.action === 'detach-session')
            row = this.#db.prepare("SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? AND session_id=? AND session_generation=? AND status='handoff-pending'").get(request.repo_id, run.workstream_run, sessionId, generation);
        if (row === undefined)
            throw new CoordinationRuntimeError('fenced-session', 'session is not attached to the durable run supervisor');
        if (sqlString(row, 'session_lease_id') !== payloadString(request.payload, 'session_lease_id'))
            throw new CoordinationRuntimeError('unauthorized-client', 'session lease identity does not match current authority');
        this.#assertCapability(row, 'session_token_sha256', payloadString(request.payload, 'session_token'), 'session');
        const session = sessionFromRow(row);
        if (session.attachment_kind === 'migration-recovery' && !MIGRATION_RECOVERY_SESSION_ACTIONS.has(request.action))
            throw new CoordinationRuntimeError('unauthorized-client', `recovery-only session rejects ordinary dispatch action ${request.action}`);
        if (session.attachment_kind === 'migration-recovery')
            assertCoordinationMigrationRecoveryOperationAuthorized(this.#stateRoot, request.payload['migration_operation_token']);
        const pendingRecovery = this.#pendingMigrationRecovery(run.repo_id, run.workstream_run);
        if (session.attachment_kind !== 'migration-recovery' && pendingRecovery.length > 0 && !['detach-session', 'heartbeat'].includes(request.action))
            throw new CoordinationRuntimeError('recovery-required', 'ordinary session is fenced from dispatch while migration recovery remains pending', pendingRecovery.map((work) => work.recovery_id));
        return session;
    }
    #assertReplayAuthority(request) {
        if (request.action === 'attach-run')
            return;
        if (request.action === 'heartbeat-child' || request.action === 'complete-child') {
            const childId = payloadString(request.payload, 'child_lease_id');
            const row = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'child replay authority');
            this.#assertChildAuthority(request, childFromRow(row), row);
            return;
        }
        const sessionLeaseId = payloadString(request.payload, 'session_lease_id');
        const row = asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(sessionLeaseId), 'session replay authority');
        const session = sessionFromRow(row);
        if (session.attachment_kind === 'migration-recovery')
            assertCoordinationMigrationRecoveryOperationAuthorized(this.#stateRoot, request.payload['migration_operation_token']);
        const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
        if (session.repo_id !== request.repo_id || session.workstream_run !== run.workstream_run || session.session_id !== request.session_id || session.session_generation !== request.fencing_generation || session.session_generation !== run.active_session_generation)
            throw new CoordinationRuntimeError('fenced-session', 'idempotent replay session is no longer the current generation');
        const allowedStatus = request.action === 'prepare-handoff' ? 'handoff-pending' : request.action === 'detach-session' ? 'detached' : 'attached';
        if (session.status !== allowedStatus)
            throw new CoordinationRuntimeError('fenced-session', `idempotent replay requires session status ${allowedStatus}`);
        this.#assertCapability(row, 'session_token_sha256', payloadString(request.payload, 'session_token'), 'session');
    }
    #assertChildAuthority(request, child, row) {
        if (child.owner.repo_id !== request.repo_id || child.owner.workstream_run !== this.#workstreamRun(request))
            throw new CoordinationRuntimeError('unauthorized-client', 'client does not own child lease');
        if (child.pid !== payloadInteger(request.payload, 'pid') || child.boot_id !== payloadString(request.payload, 'boot_id'))
            throw new CoordinationRuntimeError('unauthorized-client', 'child process identity does not match its lease');
        this.#assertCapability(row, 'child_token_sha256', payloadString(request.payload, 'child_token'), 'child');
    }
    #assertCapability(row, field, token, label) {
        const expected = Buffer.from(sqlString(row, field), 'utf8');
        const actual = Buffer.from(createHash('sha256').update(token, 'utf8').digest('hex'), 'utf8');
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
            throw new CoordinationRuntimeError('unauthorized-client', `${label} capability does not match its lease`);
    }
    #assertVersion(actual, expected, label) {
        if (expected === null || actual !== expected)
            throw new CoordinationRuntimeError('stale-version', `${label} version ${String(actual)} does not match expected ${String(expected)}`);
    }
    #workstreamRun(request) {
        if (request.workstream_run === null)
            throw new CoordinationRuntimeError('invalid-request', 'request lacks workstream_run');
        return request.workstream_run;
    }
    #sessionId(request) {
        if (request.session_id === null)
            throw new CoordinationRuntimeError('invalid-request', 'request lacks session_id');
        return request.session_id;
    }
}
export function coordinationErrorCode(value) {
    switch (value) {
        case 'invalid-request':
        case 'invalid-state':
        case 'protocol-mismatch':
        case 'schema-mismatch':
        case 'frame-too-large':
        case 'unauthorized-client':
        case 'coordinator-unavailable':
        case 'coordinator-contention':
        case 'fenced-session':
        case 'stale-version':
        case 'idempotency-conflict':
        case 'request-timeout':
        case 'recovery-required':
        case 'git-partial-effect':
        case 'disk-failure':
        case 'permission-denied':
        case 'planning-contradiction-review':
        case 'store-corrupt':
        case 'system-fatal': return value;
        default: return 'system-fatal';
    }
}
