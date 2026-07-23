import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { link, mkdir, open as openFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { platform } from 'node:os';
import { backup, DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';

import { claimModesConflict, coordinationPathsOverlap, parseCoordinationAcquisitionGroup, parseCoordinationAdjudicationAssignment, parseCoordinationAuthoritativeArtifact, parseCoordinationChangeReservation, parseCoordinationChildLease, parseCoordinationClaimRequest, parseCoordinationDeadlockResolution, parseCoordinationEditLease, parseCoordinationEscalation, parseCoordinationEvent, parseCoordinationMailboxCursor, parseCoordinationMailboxDeliveryReceipt, parseCoordinationMessage, parseCoordinationMigrationRecoveryWork, parseCoordinationObservation, parseCoordinationReconciliationDetail, parseCoordinationReconciliationEvidence, parseCoordinationReconciliationReceipt, parseCoordinationResultDetail, parseCoordinationResultReceipt, parseCoordinationReleaseCondition, parseCoordinationRepository, parseCoordinationRequestedLease, parseCoordinationReservationObligation, parseCoordinationRun, parseCoordinationRunResource, parseCoordinationRunTerminalIntent, parseCoordinationSessionLease, parseCoordinationUnitAttempt, parseCoordinationWaitForEdge, parseCoordinationWorktree, parseCoordinationWorktreeOperation, parseCoordinatorMailboxPage, parseCoordinatorMigrationRecoveryPage, parseCoordinatorProjectionPage, parseCoordinatorReconciliationDetailPage, parseCoordinatorRequestEnvelope, parseCoordinatorResponseEnvelope, parseCoordinatorResultDetailPage, parseCoordinatorRunCatalogPage } from './contracts.ts';
import { buildCoordinationWaitForEdges, compareCoordinationGrantPriority, coordinationOwnerKey, detectCoordinationWaitCycles, MAX_GRANT_BYPASSES, selectCoordinationDeadlockVictim } from './deadlock.ts';
import { validateAuthoritativeCoordinationDocument, validatePlanningContradictionSubmission } from './escalation.ts';
import { CoordinationRuntimeError, type CoordinationFailureCode } from './failures.ts';
import { buildS2CoordinationRuntimeErrorDiagnostic } from './s2-diagnostics.ts';
import { isS2CoordinationFailureCode, isS2FailureResponseRetryable } from './s2-failure-taxonomy.ts';
import { assertCoordinationObservationSourceIdentity } from './observations.ts';
import { parseIdentityFaultResolutionEvidence } from './identity-fault-resolution-contract.ts';
import { checkCoordinationInvariants, type CoordinationInvariantFinding } from './invariants.ts';
import { runS1InvariantDetectors, type S1InvariantDetectorHost } from './invariant-registry.ts';
import { proveLegacyReadAttemptTerminal, type LegacyReadTerminalProof } from './legacy-read-terminal.ts';
import { AUTOPILOT_RUN_SCOPED_FAULT_SCHEMA, parseRunScopedLogicalFault, type RunScopedLogicalFault } from './logical-faults.ts';
import { assertMetadataReconcileEvidence, parseMetadataReconcileEvidence } from './metadata-reconcile.ts';
import { COORDINATOR_BUSY_TIMEOUT_MS, COORDINATOR_DATABASE_SCHEMA_VERSION, COORDINATOR_GRANT_OFFER_TTL_MS, COORDINATOR_IMPLEMENTATION_BUILD, COORDINATOR_LEGACY_FACADE_BUILD, COORDINATOR_PACKAGE_BUILD, COORDINATOR_STORE_SCHEMA_VERSION, COORDINATOR_WIRE_LINEAGE, enforcePrivateAuthorityPath, enforceWindowsPrivateAcl, ensureCoordinatorPrivateRoots, type CoordinatorRuntimePaths } from './runtime-paths.ts';
import { byteBudgetPage, COORDINATOR_MAX_PAGE_ENTITY_BYTES, COORDINATOR_PAGE_TARGET_BYTES, encodePaginationCursor, encodedJsonBytes, paginationCursorState, paginationRevision, paginationScope, parsePaginationCursor } from './pagination.ts';
import { activeCoordinationMigrationFreeze, assertCoordinationDispatchAllowed, assertCoordinationFrozenMutationAllowed, assertCoordinationMigrationRecoveryOperationAuthorized, coordinationCutoverCommitted } from './migration-paths.ts';
import { proveStructuredAttemptTerminal, type TrustedTerminalAttemptProof } from './terminal-attempt-proof.ts';
import { classifyCoordinationIntegrationConflict } from './integration-conflicts.ts';
import { deriveD65BootstrapTransaction, type D65GitBlobObserver } from './d65-bootstrap-transaction.ts';
import { assertD65AppendOnlyAttempt, assertD65TerminalEffectSetsExact, buildD65PreparedTerminalIntentV2, computeD65ObligationPartition, d65TerminalIntentId } from './d65-terminal-intent.ts';
import { parseD65CompleteGraph, parseD65RunTerminalIntentV2, parseD65SemanticGraphBootstrap, type D65CompleteGraph, type D65RunTerminalIntentV2 } from './d65-semantic-graph.ts';
import {
  applyD65GraphRegistrationBaseline,
  assertD65CoordinatorProjectionEqual,
  projectD65ChildLease,
  projectD65SessionLease,
  type D65AttemptProjection,
  type D65CoordinatorProjectionSnapshot,
} from './d65-coordinator-projection.ts';
import { computeD65SemanticVersionCounts, d65SemanticEventWorkstreamRuns, isPureD65ChildHeartbeat, isPureD65SessionHeartbeat, type D65AcceptedEventResultJoin } from './d65-semantic-version.ts';
import {
  D65_HEARTBEAT_ACCEPTANCE_RESULT_SCHEMA,
  parseD65HeartbeatAcceptanceResult,
  parseD65LaunchPolicy,
  parseD65ProgramHeartbeat,
  parseD65SubscriptionProbe,
  type D65HeartbeatAcceptanceResult,
  type D65LaunchPolicy,
  type D65ProgramHeartbeat,
} from './d65-launch-policy.ts';
import { computeD65SemanticSnapshotSha256 } from './d65-semantic-normalizer.ts';
import { ordinaryDispatchAllowed, recoveryTransitionAllowed, type D65RecoveryBindings } from './d65-dispatch-predicates.ts';
import { D65_DISPATCH_AUTHORITY_ENVELOPE_SCHEMA, parseD65DispatchAuthorityEnvelope, parseD65DispatchAuthorityRequestContext, type D65DispatchAuthorityFrame, type D65DispatchAuthorityRequestContext } from './d65-dispatch-authority.ts';
import { readD65GraphPublicationResidue } from './d65-graph-publication-residue.ts';
import { parseD65ContinuationEvent, parseD65ParentLoss } from './d65-continuation.ts';
import { parseD65TrustAnchorSpki, verifyD65Signature } from './d65-trust.ts';
import { d65GraphPathPrefix, d65SemanticGraphArtifactId, d65SemanticGraphSequenceFromArtifactId, validateD65GraphPublication } from './d65-graph-publication.ts';
import { assertD65QueueProjectionCounts, assertD65QueueProjectionMembers, assertD65UnitTransition, assertD65WorkItemTransition, D65_QUEUE_KEYS } from './d65-graph-queues.ts';
import { assertD65QueueMemberValues, d65ProjectionIdentities, loadD65CompleteGraph, type D65LoadedGraph } from './d65-graph-loader.ts';
import { assertD65DiscoveredGraphBodyEqual, discoverD65GraphBody } from './d65-graph-body.ts';
import { parseD65BootstrapCharter, reconstructD65BootstrapCharter } from './d65-bootstrap-charter.ts';
import { validateD65FirstCompleteGraph } from './d65-first-complete-graph.ts';
import type { D65GraphAuthorityReader, D65GraphTreeLeaf } from './d65-graph-authority.ts';
import { parseAutopilotReceipt, parseAutopilotState, parseAutopilotUnitSpec, type AutopilotState } from '../contracts/index.ts';
import { assertAutopilotChildTerminalAcceptanceChain, AUTOPILOT_CHILD_TERMINAL_ACCEPTANCE_SCHEMA, parseAutopilotChildTerminalAcceptance } from './terminal-acceptance.ts';
import { HISTORICAL_UNIT_FAILURE_GENERATIONS, classifyHistoricalUnitFailureEvidenceGeneration, parseRunTerminalSha, parseUnitAttemptTarget, parseUnitFailureEvidenceFacts, parseUnitFailureEvidenceIngress, parseUnitMergeReservationFacts, validateReconciliationEvidenceDocument, validateReservationIntegrationEvidenceDocument, validateReservationValidationArtifactChain, validateReservationValidationEvidenceDocument, type HistoricalUnitFailureEvidenceProvenance } from './terminal-evidence.ts';
import { BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS } from './unit-failure-producer-provenance.ts';
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, COORDINATION_WORKTREE_STATES } from './types.ts';
import { COORDINATOR_MAX_FRAME_BYTES } from './runtime-constants.ts';
import { assertPrivatePathNoAliases } from '../private-path.ts';
import { AUTOPILOT_WORKTREE_ALIAS_SCHEMA, deterministicWorktreeId, parseWorktreeAlias, sameWorktreeAuthority, worktreeOwnerKindKey, type WorktreeAlias } from './worktree-identity.ts';
import { ensureCurrentStoreGeneration, publishRestoredStoreGeneration, type CurrentStoreGeneration, type StoreGenerationMigrationAdapter, type StorePublicationBoundary } from './store-generation.ts';
import { CoordinatorWriterGuard } from './writer-guard.ts';
import { deriveWorktreeOperationKeyV2, operationIdFromWorktreeOperationKey } from './worktree-operation-identity.ts';
import { gitWorktreeRegistrationFacts, inspectWorktreePostcondition } from './worktree-postconditions.ts';
import { GitQueryError, runGitQuery, type GitQueryDescriptor, type GitQueryResult } from '../git-process.ts';
import type { CoordinationAcquisitionGroup, CoordinationAcquisitionKind, CoordinationAdjudicationAssignment, CoordinationAuthoritativeArtifact, CoordinationChangeReservation, CoordinationChildLease, CoordinationClaimRequest, CoordinationDeadlockResolution, CoordinationEditLease, CoordinationEscalation, CoordinationEvent, CoordinationMailboxCursor, CoordinationMailboxDeliveryReceipt, CoordinationMessage, CoordinationMigrationRecoveryWork, CoordinationObservation, CoordinationOwnerIdentity, CoordinationReconciliationDetail, CoordinationReconciliationDetailKind, CoordinationReconciliationEvidence, CoordinationReconciliationReceipt, CoordinationResultDetail, CoordinationResultReceipt, CoordinationReconciliationSource, CoordinationReconciliationSummary, CoordinationReleaseCondition, CoordinationReleaseConditionType, CoordinationRepository, CoordinationRequestedLease, CoordinationReservationObligation, CoordinationRun, CoordinationRunResource, CoordinationRunTerminalIntent, CoordinationSessionLease, CoordinationSnapshot, CoordinationUnitAttempt, CoordinationUnitRole, CoordinationWaitForEdge, CoordinationWorktree, CoordinationWorktreeOperation, CoordinatorMutationAction, CoordinatorRequestEnvelope, CoordinatorResponseEnvelope } from './types.ts';

const DATABASE_EXPORT_SCHEMA = 'autopilot.coordinator_export.v1';
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_COORDINATION_EVIDENCE_BYTES = 1024 * 1024;
const MAX_ADJUDICATION_BUNDLE_BYTES = 256 * 1024;
export const COORDINATOR_SEMANTIC_REPLAY_SCHEMA = 'autopilot.coordinator_semantic_replay.v1';
export const COORDINATOR_MAX_SEMANTIC_REPLAY_RECORDS = 100_000;
const COORDINATOR_MAX_SEMANTIC_REPLAY_BYTES = 128 * 1024 * 1024;
const COORDINATOR_MAX_SEMANTIC_REPLAY_LINE_BYTES = 1024 * 1024;
const COORDINATOR_SEMANTIC_REPLAY_BATCH_SIZE = 1_000;
const RUN_OWNED_IDEMPOTENCY_ACTIONS = new Set(['resolve-migration-recovery', 'accept-program-heartbeat', 'register-attempt', 'acquire-group', 'acknowledge-grant', 'respond-claim-request', 'cancel-claim-request', 'cancel-acquisition-group', 'supersede-attempt', 'acknowledge-message', 'record-release-evidence', 'resolve-reservation-obligation', 'prepare-run-terminal', 'cancel-run-terminal', 'reconcile-run', 'prepare-operation', 'transition-operation', 'resolve-run-scoped-fault', 'register-authoritative-artifact', 'assign-adjudication', 'claim-adjudication-assignment', 'submit-planning-contradiction']);
const TERMINAL_SESSION_ACTIONS = new Set(['resolve-migration-recovery', 'detach-session', 'heartbeat', 'drain-mailbox', 'acknowledge-message', 'record-release-evidence', 'reconcile-run', 'reconciliation-details', 'result-details', 'prepare-operation', 'transition-operation']);
const MIGRATION_RECOVERY_SESSION_ACTIONS = new Set(['resolve-migration-recovery', 'detach-session', 'heartbeat']);
const STATUS_SECTIONS = ['repositories', 'runs', 'run_resources', 'session_leases', 'child_leases', 'unit_attempts', 'acquisition_groups', 'observations', 'edit_leases', 'change_reservations', 'reservation_obligations', 'run_terminal_intents', 'claim_requests', 'mailbox_cursors', 'reconciliation_evidence', 'reconciliation_receipts', 'mailbox_deliveries', 'result_receipts', 'worktrees', 'worktree_operations', 'wait_for_edges', 'deadlock_resolutions', 'authoritative_artifacts', 'adjudication_assignments', 'escalations', 'coordination_migrations', 'migration_recovery_work'] as const;
const COORDINATOR_PROJECTION_SCAN_TTL_MS = 60_000;
const COORDINATOR_MAX_ACTIVE_PROJECTION_SCANS = 8;
const COORDINATOR_RUN_CATALOG_SCAN_TTL_MS = 60_000;
const COORDINATOR_MAX_ACTIVE_RUN_CATALOG_SCANS = 64;
const DOCTOR_SECTIONS = ['invariant_findings', 'migrations', 'expired_session_classifications', 'expired_child_classifications', 'incomplete_worktree_operations', 'pending_reservation_obligations', 'prepared_run_terminal_intents', 'active_wait_for_edges', 'open_deadlock_resolutions', 'pending_adjudication_assignments', 'retained_exclusive_operations', 'coordination_migrations', 'pending_migration_recovery_work'] as const;

interface StoreEffect {
  readonly committedEventSeq: number | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface ProjectionScan {
  readonly kind: 'status' | 'doctor';
  readonly scope_sha256: string;
  readonly revision_sha256: string;
  readonly snapshot: string | null;
  readonly complete: Readonly<Record<string, unknown>>;
  readonly created_at_ms: number;
  readonly completed_sections: Set<string>;
  completed_at_ms: number | null;
}

interface IdempotentEffect extends StoreEffect {
  readonly replayed: boolean;
}

interface D65TerminalFirstEffectBaseline {
  readonly run: CoordinationRun;
  readonly intent: D65RunTerminalIntentV2;
  readonly reservations: readonly CoordinationChangeReservation[];
  readonly obligations: readonly CoordinationReservationObligation[];
  readonly leases: readonly CoordinationEditLease[];
  readonly groups: readonly CoordinationAcquisitionGroup[];
  readonly forbidden_bytes: string;
}

interface SqlRow {
  readonly [key: string]: SQLOutputValue;
}

interface JsonMap {
  readonly [key: string]: unknown;
}

function isJsonMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface StoreClock {
  now(): Date;
}

const systemClock: StoreClock = { now: () => new Date() };

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

const MIGRATION_10 = `
CREATE TABLE observations (
  entity_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  acquisition_group_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  execution_state TEXT NOT NULL CHECK(execution_state IN ('active','released','abandoned','cancelled')),
  freshness TEXT NOT NULL CHECK(freshness IN ('current','stale')),
  version INTEGER NOT NULL CHECK(version >= 1),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT,
  FOREIGN KEY(repo_id, acquisition_group_id) REFERENCES acquisition_groups(repo_id, entity_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_observations_run_state ON observations(repo_id, workstream_run, execution_state, entity_id);
CREATE INDEX idx_observations_group ON observations(repo_id, acquisition_group_id, entity_id);
CREATE INDEX idx_observations_freshness ON observations(repo_id, freshness, entity_id);
`;

// Protocol 1.4 admitted free-form EXCLUSIVE rows. Preserve them explicitly as
// legacy migration authority; never reinterpret historical bytes as a newly
// package-declared critical operation. Durable entities and replay payloads are
// transformed together so exact old idempotency keys remain replayable.
const MIGRATION_11 = `
UPDATE acquisition_groups
SET payload_json=json_set(
  payload_json,
  '$.acquisition_kind','legacy-unknown',
  '$.requested_leases',json((
    SELECT json_group_array(json(CASE WHEN json_extract(value,'$.mode')='EXCLUSIVE' THEN
      json_set(value,'$.exclusive_operation',json_object(
        'schema_version','autopilot.exclusive_operation.v1','operation_id','legacy-schema11-'||substr(hex(acquisition_groups.entity_id),1,160),
        'operation_kind','legacy-migration-exclusive','critical_section','legacy-migration-exclusive','resource_scope','exact-repository-path',
        'expected_duration_ms',300000,'release_trigger','critical-section-exit'))
      ELSE value END)) FROM json_each(acquisition_groups.payload_json,'$.requested_leases')
  ))
)
WHERE EXISTS (SELECT 1 FROM json_each(acquisition_groups.payload_json,'$.requested_leases') WHERE json_extract(value,'$.mode')='EXCLUSIVE');

UPDATE edit_leases
SET payload_json=json_set(payload_json,'$.exclusive_operation',json_object(
  'schema_version','autopilot.exclusive_operation.v1','operation_id','legacy-schema11-'||substr(hex(json_extract(payload_json,'$.acquisition_group_id')),1,160),
  'operation_kind','legacy-migration-exclusive','critical_section','legacy-migration-exclusive','resource_scope','exact-repository-path',
  'expected_duration_ms',300000,'release_trigger','critical-section-exit'))
WHERE json_extract(payload_json,'$.mode')='EXCLUSIVE' AND json_type(payload_json,'$.exclusive_operation') IS NULL;

UPDATE claim_requests
SET payload_json=json_set(payload_json,'$.requested_leases',json((
  SELECT json_group_array(json(CASE WHEN json_extract(value,'$.mode')='EXCLUSIVE' THEN
    json_set(value,'$.exclusive_operation',json_object(
      'schema_version','autopilot.exclusive_operation.v1','operation_id','legacy-schema11-'||substr(hex(json_extract(claim_requests.payload_json,'$.acquisition_group_id')),1,160),
      'operation_kind','legacy-migration-exclusive','critical_section','legacy-migration-exclusive','resource_scope','exact-repository-path',
      'expected_duration_ms',300000,'release_trigger','critical-section-exit'))
    ELSE value END)) FROM json_each(claim_requests.payload_json,'$.requested_leases')
)))
WHERE EXISTS (SELECT 1 FROM json_each(claim_requests.payload_json,'$.requested_leases') WHERE json_extract(value,'$.mode')='EXCLUSIVE');

UPDATE idempotency_results
SET payload_json=json_set(payload_json,'$.acquisition_group',json_set(
  json_extract(payload_json,'$.acquisition_group'),
  '$.acquisition_kind','legacy-unknown',
  '$.requested_leases',json((SELECT json_group_array(json(CASE WHEN json_extract(value,'$.mode')='EXCLUSIVE' THEN
    json_set(value,'$.exclusive_operation',json_object(
      'schema_version','autopilot.exclusive_operation.v1','operation_id','legacy-schema11-'||substr(hex(json_extract(idempotency_results.payload_json,'$.acquisition_group.acquisition_group_id')),1,160),
      'operation_kind','legacy-migration-exclusive','critical_section','legacy-migration-exclusive','resource_scope','exact-repository-path',
      'expected_duration_ms',300000,'release_trigger','critical-section-exit'))
    ELSE value END)) FROM json_each(idempotency_results.payload_json,'$.acquisition_group.requested_leases')))
))
WHERE json_type(payload_json,'$.acquisition_group')='object'
  AND EXISTS (SELECT 1 FROM json_each(idempotency_results.payload_json,'$.acquisition_group.requested_leases') WHERE json_extract(value,'$.mode')='EXCLUSIVE');

UPDATE idempotency_results
SET payload_json=json_set(payload_json,'$.edit_leases',json((SELECT json_group_array(json(CASE WHEN json_extract(value,'$.mode')='EXCLUSIVE' THEN
  json_set(value,'$.exclusive_operation',json_object(
    'schema_version','autopilot.exclusive_operation.v1','operation_id','legacy-schema11-'||substr(hex(json_extract(value,'$.acquisition_group_id')),1,160),
    'operation_kind','legacy-migration-exclusive','critical_section','legacy-migration-exclusive','resource_scope','exact-repository-path',
    'expected_duration_ms',300000,'release_trigger','critical-section-exit'))
  ELSE value END)) FROM json_each(idempotency_results.payload_json,'$.edit_leases'))))
WHERE json_type(payload_json,'$.edit_leases')='array'
  AND EXISTS (SELECT 1 FROM json_each(idempotency_results.payload_json,'$.edit_leases') WHERE json_extract(value,'$.mode')='EXCLUSIVE');

UPDATE idempotency_results
SET payload_json=json_set(payload_json,'$.claim_request.requested_leases',json((SELECT json_group_array(json(CASE WHEN json_extract(value,'$.mode')='EXCLUSIVE' THEN
  json_set(value,'$.exclusive_operation',json_object(
    'schema_version','autopilot.exclusive_operation.v1','operation_id','legacy-schema11-'||substr(hex(json_extract(idempotency_results.payload_json,'$.claim_request.acquisition_group_id')),1,160),
    'operation_kind','legacy-migration-exclusive','critical_section','legacy-migration-exclusive','resource_scope','exact-repository-path',
    'expected_duration_ms',300000,'release_trigger','critical-section-exit'))
  ELSE value END)) FROM json_each(idempotency_results.payload_json,'$.claim_request.requested_leases'))))
WHERE json_type(payload_json,'$.claim_request')='object'
  AND EXISTS (SELECT 1 FROM json_each(idempotency_results.payload_json,'$.claim_request.requested_leases') WHERE json_extract(value,'$.mode')='EXCLUSIVE');

UPDATE idempotency_results
SET payload_json=json_set(payload_json,'$.claim_requests',json((SELECT json_group_array(json(
  CASE WHEN EXISTS (SELECT 1 FROM json_each(request.value,'$.requested_leases') AS requested WHERE json_extract(requested.value,'$.mode')='EXCLUSIVE') THEN
    json_set(request.value,'$.requested_leases',json((SELECT json_group_array(json(CASE WHEN json_extract(lease.value,'$.mode')='EXCLUSIVE' THEN
      json_set(lease.value,'$.exclusive_operation',json_object(
        'schema_version','autopilot.exclusive_operation.v1','operation_id','legacy-schema11-'||substr(hex(json_extract(request.value,'$.acquisition_group_id')),1,160),
        'operation_kind','legacy-migration-exclusive','critical_section','legacy-migration-exclusive','resource_scope','exact-repository-path',
        'expected_duration_ms',300000,'release_trigger','critical-section-exit'))
      ELSE lease.value END)) FROM json_each(request.value,'$.requested_leases') AS lease)))
    ELSE request.value END
)) FROM json_each(idempotency_results.payload_json,'$.claim_requests') AS request)))
WHERE json_type(payload_json,'$.claim_requests')='array'
  AND EXISTS (SELECT 1 FROM json_each(idempotency_results.payload_json,'$.claim_requests') AS request, json_each(request.value,'$.requested_leases') AS lease WHERE json_extract(lease.value,'$.mode')='EXCLUSIVE');
`;

const MIGRATION_12 = `
CREATE TABLE reconciliation_receipts (
  entity_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  committed_event_seq INTEGER NOT NULL CHECK(committed_event_seq >= 1),
  source_action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_reconciliation_receipts_run_event ON reconciliation_receipts(repo_id, workstream_run, committed_event_seq, entity_id);
CREATE TABLE reconciliation_details (
  reconciliation_receipt_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY(reconciliation_receipt_id, ordinal),
  FOREIGN KEY(reconciliation_receipt_id) REFERENCES reconciliation_receipts(entity_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_reconciliation_details_kind ON reconciliation_details(reconciliation_receipt_id, kind, ordinal);
CREATE TABLE mailbox_deliveries (
  delivery_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  session_lease_id TEXT NOT NULL,
  snapshot_through_event_seq INTEGER NOT NULL CHECK(snapshot_through_event_seq >= 0),
  next_ordinal INTEGER NOT NULL CHECK(next_ordinal >= 0),
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT,
  FOREIGN KEY(session_lease_id) REFERENCES session_leases(session_lease_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_mailbox_deliveries_run ON mailbox_deliveries(repo_id, workstream_run, delivery_id);
CREATE TABLE mailbox_delivery_items (
  delivery_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
  message_id TEXT NOT NULL,
  snapshot_delivered_event_seq INTEGER NOT NULL CHECK(snapshot_delivered_event_seq >= 0),
  snapshot_message_version INTEGER NOT NULL CHECK(snapshot_message_version >= 1),
  PRIMARY KEY(delivery_id, ordinal),
  UNIQUE(delivery_id, message_id),
  FOREIGN KEY(delivery_id) REFERENCES mailbox_deliveries(delivery_id) ON DELETE RESTRICT,
  FOREIGN KEY(message_id) REFERENCES messages(message_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TABLE result_receipts (
  entity_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  committed_event_seq INTEGER NOT NULL CHECK(committed_event_seq >= 1),
  source_action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_result_receipts_run_event ON result_receipts(repo_id, workstream_run, committed_event_seq, entity_id);
CREATE TABLE result_details (
  result_receipt_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
  collection_name TEXT NOT NULL,
  collection_ordinal INTEGER NOT NULL CHECK(collection_ordinal >= 1),
  payload_json TEXT NOT NULL,
  PRIMARY KEY(result_receipt_id, ordinal),
  UNIQUE(result_receipt_id, collection_name, collection_ordinal),
  FOREIGN KEY(result_receipt_id) REFERENCES result_receipts(entity_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_result_details_collection ON result_details(result_receipt_id, collection_name, collection_ordinal);
`;

const MIGRATION_13 = `
ALTER TABLE worktrees ADD COLUMN canonical_worktree_id TEXT;
ALTER TABLE worktrees ADD COLUMN autopilot_id TEXT;
ALTER TABLE worktrees ADD COLUMN unit_id TEXT;
ALTER TABLE worktrees ADD COLUMN attempt INTEGER CHECK(attempt IS NULL OR attempt >= 1);
ALTER TABLE worktrees ADD COLUMN kind TEXT CHECK(kind IS NULL OR kind IN ('main','unit'));
ALTER TABLE worktrees ADD COLUMN is_current_canonical INTEGER NOT NULL DEFAULT 0 CHECK(is_current_canonical IN (0,1));
ALTER TABLE worktree_operations ADD COLUMN canonical_worktree_id TEXT;
CREATE TABLE worktree_aliases (
  alias_worktree_id TEXT PRIMARY KEY,
  canonical_worktree_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  autopilot_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  kind TEXT NOT NULL CHECK(kind IN ('main','unit')),
  resolution_state TEXT NOT NULL CHECK(resolution_state IN ('resolved','identity-recovery-pending')),
  reason TEXT NOT NULL CHECK(reason IN ('legacy-migration-id','duplicate-semantic-projection')),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=71),
  created_event_seq INTEGER NOT NULL CHECK(created_event_seq >= 1),
  CHECK(alias_worktree_id <> canonical_worktree_id),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT,
  FOREIGN KEY(repo_id, created_event_seq) REFERENCES events(repo_id, event_seq) ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER worktree_aliases_deny_update BEFORE UPDATE ON worktree_aliases BEGIN SELECT RAISE(ABORT, 'worktree aliases are immutable'); END;
CREATE TRIGGER worktree_aliases_deny_delete BEFORE DELETE ON worktree_aliases BEGIN SELECT RAISE(ABORT, 'worktree aliases are immutable'); END;
CREATE TRIGGER worktree_aliases_deny_chain_insert BEFORE INSERT ON worktree_aliases WHEN
  EXISTS(SELECT 1 FROM worktree_aliases WHERE alias_worktree_id=NEW.canonical_worktree_id)
  OR EXISTS(SELECT 1 FROM worktree_aliases WHERE canonical_worktree_id=NEW.alias_worktree_id)
BEGIN SELECT RAISE(ABORT, 'worktree alias chains are forbidden'); END;
CREATE TABLE run_scoped_faults (
  fault_id TEXT PRIMARY KEY,
  invariant_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  workstream_run TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  fault_code TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','resolved')),
  created_event_seq INTEGER NOT NULL CHECK(created_event_seq >= 1),
  resolved_event_seq INTEGER CHECK(resolved_event_seq IS NULL OR resolved_event_seq >= created_event_seq),
  version INTEGER NOT NULL CHECK(version >= 1),
  FOREIGN KEY(repo_id, workstream_run) REFERENCES runs(repo_id, workstream_run) ON DELETE RESTRICT,
  FOREIGN KEY(repo_id, created_event_seq) REFERENCES events(repo_id, event_seq) ON DELETE RESTRICT,
  FOREIGN KEY(repo_id, resolved_event_seq) REFERENCES events(repo_id, event_seq) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX idx_run_scoped_faults_active ON run_scoped_faults(invariant_id, repo_id, workstream_run, entity_type, entity_id) WHERE status='active';
CREATE INDEX idx_run_scoped_faults_run ON run_scoped_faults(repo_id, workstream_run, status, fault_id);
CREATE INDEX idx_worktree_aliases_canonical ON worktree_aliases(canonical_worktree_id, alias_worktree_id);
CREATE INDEX idx_worktrees_canonical ON worktrees(repo_id, canonical_worktree_id, entity_id);
CREATE UNIQUE INDEX idx_worktrees_current_semantic ON worktrees(repo_id, workstream_run, autopilot_id, unit_id, attempt, kind) WHERE is_current_canonical=1;
CREATE INDEX idx_worktree_operations_canonical ON worktree_operations(repo_id, workstream_run, canonical_worktree_id, entity_id);
`;

const COORDINATOR_SCHEMA_MIGRATIONS = Object.freeze([
  { version: 1, sql: MIGRATION_1 }, { version: 2, sql: MIGRATION_2 }, { version: 3, sql: MIGRATION_3 },
  { version: 4, sql: MIGRATION_4 }, { version: 5, sql: MIGRATION_5 }, { version: 6, sql: MIGRATION_6 },
  { version: 7, sql: MIGRATION_7 }, { version: 8, sql: MIGRATION_8 }, { version: 9, sql: MIGRATION_9 },
  { version: 10, sql: MIGRATION_10 }, { version: 11, sql: MIGRATION_11 }, { version: 12, sql: MIGRATION_12 },
  { version: 13, sql: MIGRATION_13 },
] as const);
export const COORDINATOR_SCHEMA_MIGRATION_CHECKSUMS = Object.freeze(COORDINATOR_SCHEMA_MIGRATIONS.map((migration) => createHash('sha256').update(migration.sql, 'utf8').digest('hex')));

export interface HistoricalStoreConservationSnapshot {
  readonly events: { readonly count: number; readonly sha256: `sha256:${string}` };
  readonly worktree_operations: { readonly count: number; readonly sha256: `sha256:${string}` };
  readonly idempotency_results: { readonly count: number; readonly sha256: `sha256:${string}` };
  readonly evidence_artifacts: { readonly count: number; readonly sha256: `sha256:${string}` };
}

export type CoordinationMigrationRecordState = 'imported' | 'verified' | 'cutover-ready' | 'cutover-committed' | 'legacy-archived';

export interface CoordinationMigrationRecoveryInput {
  readonly recovery_id: string;
  readonly workstream_run: string;
  readonly recovery_type: 'ambiguous-live-claim' | 'orphan-worktree' | 'git-metadata-mismatch' | 'unreachable-live-process';
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface CoordinationMigrationAuditInput {
  readonly audit_id: string;
  readonly source_kind: 'claim-event' | 'merge-event' | 'foreign-merge-ack' | 'worktree-ledger';
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface CoordinationLegacyTerminalReleaseInput {
  readonly owner: CoordinationOwnerIdentity;
  readonly path: string;
  readonly mode: 'READ' | 'WRITE' | 'EXCLUSIVE';
  readonly evidence_ref: string;
  readonly evidence_sha256: `sha256:${string}`;
}

export interface CoordinationLegacyImportPlan {
  readonly migration_id: string;
  readonly snapshot_sha256: `sha256:${string}`;
  readonly journal_path: string;
  readonly repository: CoordinationRepository;
  readonly runs: readonly CoordinationRun[];
  readonly run_resources: readonly CoordinationRunResource[];
  readonly unit_attempts: readonly CoordinationUnitAttempt[];
  readonly acquisition_groups: readonly CoordinationAcquisitionGroup[];
  readonly edit_leases: readonly CoordinationEditLease[];
  readonly terminal_releases: readonly CoordinationLegacyTerminalReleaseInput[];
  readonly change_reservations: readonly CoordinationChangeReservation[];
  readonly reservation_obligations: readonly CoordinationReservationObligation[];
  readonly reconciliation_evidence: readonly CoordinationReconciliationEvidence[];
  readonly worktrees: readonly CoordinationWorktree[];
  readonly recovery_work: readonly CoordinationMigrationRecoveryInput[];
  readonly legacy_audit: readonly CoordinationMigrationAuditInput[];
  readonly report: {
    readonly schema_version: string;
    readonly legacy_claim_count: number;
    readonly classified_claim_count: number;
    readonly equivalent_lease_count: number;
    readonly imported_run_count: number;
    readonly imported_attempt_count: number;
    readonly imported_lease_count: number;
    readonly imported_reservation_count: number;
    readonly imported_worktree_count: number;
    readonly imported_audit_count: number;
    readonly terminal_leak_count: number;
    readonly recovery_work_count: number;
  };
}

function asRow(value: SqlRow | undefined, label: string): SqlRow {
  if (value === undefined) throw new CoordinationRuntimeError('invalid-state', `${label} row is missing`);
  return value;
}

function sqlString(row: SqlRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new CoordinationRuntimeError('store-corrupt', `database field ${field} is not text`);
  return value;
}

function sqlNullableString(row: SqlRow, field: string): string | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== 'string') throw new CoordinationRuntimeError('store-corrupt', `database field ${field} is not nullable text`);
  return value;
}

function sqlInteger(row: SqlRow, field: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new CoordinationRuntimeError('store-corrupt', `database field ${field} is not a safe integer`);
  return value;
}

function sqlNullableInteger(row: SqlRow, field: string): number | null {
  return row[field] === null ? null : sqlInteger(row, field);
}

function updateConservationValue(hash: ReturnType<typeof createHash>, value: SQLOutputValue): void {
  if (value === null) { hash.update('n:0:', 'utf8'); return; }
  if (value instanceof Uint8Array) { hash.update(`b:${String(value.byteLength)}:`, 'utf8'); hash.update(value); return; }
  const text = String(value);
  hash.update(`${typeof value === 'number' || typeof value === 'bigint' ? 'i' : 's'}:${String(Buffer.byteLength(text, 'utf8'))}:`, 'utf8');
  hash.update(text, 'utf8');
}

function conservationSection(db: DatabaseSync, query: string, fields: readonly string[]): { readonly count: number; readonly sha256: `sha256:${string}` } {
  const hash = createHash('sha256');
  let count = 0;
  for (const row of db.prepare(query).iterate()) {
    count += 1;
    hash.update(`row:${String(count)}\0`, 'utf8');
    for (const field of fields) {
      hash.update(`${field}\0`, 'utf8');
      const value = row[field];
      if (value === undefined) throw new CoordinationRuntimeError('store-corrupt', 'historical conservation query omitted a required field', [field]);
      updateConservationValue(hash, value);
      hash.update('\0', 'utf8');
    }
  }
  return Object.freeze({ count, sha256: `sha256:${hash.digest('hex')}` });
}

function historicalConservationSnapshot(db: DatabaseSync): HistoricalStoreConservationSnapshot {
  return Object.freeze({
    events: conservationSection(db, 'SELECT repo_id,event_seq,event_type,entity_type,entity_id,idempotency_key,request_sha256,occurred_at FROM events ORDER BY repo_id,event_seq', ['repo_id','event_seq','event_type','entity_type','entity_id','idempotency_key','request_sha256','occurred_at']),
    worktree_operations: conservationSection(db, 'SELECT entity_id,repo_id,workstream_run,payload_json,version FROM worktree_operations ORDER BY repo_id,workstream_run,entity_id', ['entity_id','repo_id','workstream_run','payload_json','version']),
    idempotency_results: conservationSection(db, 'SELECT repo_id,idempotency_key,request_sha256,committed_event_seq,payload_json FROM idempotency_results ORDER BY repo_id,idempotency_key', ['repo_id','idempotency_key','request_sha256','committed_event_seq','payload_json']),
    evidence_artifacts: conservationSection(db, 'SELECT entity_id,repo_id,sha256,ref,label,content,size_bytes,created_event_seq FROM evidence_artifacts ORDER BY repo_id,created_event_seq,entity_id', ['entity_id','repo_id','sha256','ref','label','content','size_bytes','created_event_seq']),
  });
}

export function historicalStoreConservationSnapshot(databasePath: string): HistoricalStoreConservationSnapshot {
  const db = new DatabaseSync(databasePath, { readOnly: true, timeout: COORDINATOR_BUSY_TIMEOUT_MS });
  try { return historicalConservationSnapshot(db); }
  finally { db.close(); }
}

function payloadString(payload: Readonly<Record<string, unknown>>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string') throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be text`);
  return value;
}

function payloadNullableString(payload: Readonly<Record<string, unknown>>, field: string): string | null {
  const value = payload[field];
  if (value === null) return null;
  if (typeof value !== 'string') throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be nullable text`);
  return value;
}

function payloadInteger(payload: Readonly<Record<string, unknown>>, field: string): number {
  const value = payload[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be an integer`);
  return value;
}

function payloadAcquisitionKind(payload: Readonly<Record<string, unknown>>, field: string): Exclude<CoordinationAcquisitionKind, 'legacy-unknown'> {
  const value = payloadString(payload, field);
  if (value === 'initial' || value === 'materialization-read-expansion') return value;
  throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be a supported acquisition kind`);
}

function payloadUnitRole(payload: Readonly<Record<string, unknown>>, field: string): Exclude<CoordinationUnitRole, 'unknown'> {
  const value = payloadString(payload, field);
  switch (value) {
    case 'strategy': case 'implement': case 'validate': case 'fix': case 'adjudicate': case 'bughunt': case 'extract': return value;
    default: throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be a supported unit role`);
  }
}

function payloadBoolean(payload: Readonly<Record<string, unknown>>, field: string): boolean {
  const value = payload[field];
  if (typeof value !== 'boolean') throw new CoordinationRuntimeError('invalid-request', `payload field ${field} must be boolean`);
  return value;
}

function payloadRequestedLeases(payload: Readonly<Record<string, unknown>>): readonly CoordinationRequestedLease[] {
  const value = payload['requested_leases'];
  if (!Array.isArray(value)) throw new CoordinationRuntimeError('invalid-request', 'payload field requested_leases must be an array');
  const parsed = Object.freeze(value.map((entry, index) => parseCoordinationRequestedLease(entry, `requested_leases[${String(index)}]`)));
  if (encodedJsonBytes(parsed) > COORDINATOR_MAX_PAGE_ENTITY_BYTES) throw new CoordinationRuntimeError('frame-too-large', 'requested leases make one durable acquisition group exceed the single-entity byte ceiling');
  return parsed;
}

function payloadReleaseCondition(payload: Readonly<Record<string, unknown>>, field: string): CoordinationReleaseCondition {
  return parseCoordinationReleaseCondition(payload[field], `payload.${field}`);
}

function ownerIdentityKey(owner: CoordinationOwnerIdentity): string {
  return `${owner.repo_id}\0${owner.autopilot_id}\0${owner.workstream_run}\0${owner.unit_id}\0${String(owner.attempt)}`;
}

function sameOwner(left: CoordinationOwnerIdentity, right: CoordinationOwnerIdentity): boolean {
  return ownerIdentityKey(left) === ownerIdentityKey(right);
}

function leaseCoversPath(leasePath: string, changedPath: string): boolean {
  const base = leasePath.replace(/\/\*\*$/u, '').replace(/\/$/u, '');
  return changedPath === base || changedPath.startsWith(`${base}/`);
}

function unitAttemptEntityId(owner: CoordinationOwnerIdentity): string {
  return `attempt-${createHash('sha256').update(ownerIdentityKey(owner), 'utf8').digest('hex')}`;
}

function stableEntityId(prefix: string, parts: readonly string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value !== 'object') throw new CoordinationRuntimeError('invalid-request', 'request contains a non-JSON value');
  const entries = Object.entries(value).sort((left, right) => left[0].localeCompare(right[0]));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

export type CoordinatorSemanticReplayRecord = CoordinatorRequestEnvelope;

export type CoordinatorSemanticReplayBoundary = 'stage-validated' | 'batch-applied' | 'records-applied' | 'database-completed' | 'receipt-projected' | 'inbox-cleaned';

export interface CoordinatorStoreOpenOptions {
  /** Observability hook used by crash certification and embedders. It runs at
   * durable replay boundaries; throwing fails startup without hiding state. */
  readonly onSemanticReplayBoundary?: (boundary: CoordinatorSemanticReplayBoundary) => void | Promise<void>;
  /** Exact process-lifetime authority supplied by server startup. Direct store
   * consumers acquire and own a guard automatically. */
  readonly writerGuard?: CoordinatorWriterGuard;
  /** Crash-injection/observability boundary; throwing aborts startup without
   * selecting partial authority. */
  readonly onStorePublicationBoundary?: (boundary: StorePublicationBoundary) => void | Promise<void>;
}

interface CoordinatorSemanticReplayHeader {
  readonly schema_version: typeof COORDINATOR_SEMANTIC_REPLAY_SCHEMA;
  readonly replay_id: string;
  readonly record_count: number;
  readonly records_sha256: `sha256:${string}`;
}

interface CoordinatorSemanticReplayReceipt {
  readonly schema_version: 'autopilot.coordinator_semantic_replay_receipt.v1';
  readonly replay_id: string;
  readonly record_count: number;
  readonly records_sha256: `sha256:${string}`;
  readonly applied_at: string;
}

function parseSemanticReplayRequest(value: unknown, label: string): CoordinatorRequestEnvelope {
  let request: CoordinatorRequestEnvelope;
  try {
    request = parseCoordinatorRequestEnvelope(value);
  } catch (error) {
    throw new CoordinationRuntimeError('invalid-request', `${label} is not a valid coordinator request`, [error instanceof Error ? error.message : String(error)]);
  }
  if (request.protocol_version !== AUTOPILOT_COORDINATOR_PROTOCOL_VERSION) throw new CoordinationRuntimeError('protocol-mismatch', `${label} must use the current coordinator protocol`);
  if (request.action === 'status' || request.action === 'doctor' || request.action === 'export' || request.idempotency_key === null) throw new CoordinationRuntimeError('invalid-request', `${label} must be an idempotent semantic mutation`);
  return request;
}

function parseSemanticReplayRecord(value: unknown, label: string): CoordinatorSemanticReplayRecord {
  return parseSemanticReplayRequest(value, label);
}

function parseSemanticReplayLine(line: string, label: string): CoordinatorSemanticReplayRecord {
  let value: unknown;
  try { value = JSON.parse(line) as unknown; } catch (error) {
    throw new CoordinationRuntimeError('invalid-request', `${label} is not valid JSON`, [error instanceof Error ? error.message : String(error)]);
  }
  if (canonicalJson(value) !== line) throw new CoordinationRuntimeError('invalid-request', `${label} must be canonical JSON without duplicate or reordered fields`);
  return parseSemanticReplayRecord(value, label);
}

function parseValidatedSemanticReplayLine(line: string, label: string): CoordinatorSemanticReplayRecord {
  try { return parseSemanticReplayRecord(JSON.parse(line) as unknown, label); }
  catch (error) {
    throw new CoordinationRuntimeError('store-corrupt', `${label} changed after canonical contract staging`, [error instanceof Error ? error.message : String(error)]);
  }
}

function parseSemanticReplayHeader(line: string): CoordinatorSemanticReplayHeader {
  let value: unknown;
  try { value = JSON.parse(line) as unknown; } catch (error) {
    throw new CoordinationRuntimeError('invalid-request', 'semantic replay header is not valid JSON', [error instanceof Error ? error.message : String(error)]);
  }
  if (canonicalJson(value) !== line || typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('invalid-request', 'semantic replay header must be a canonical object');
  const record = value as Readonly<Record<string, unknown>>;
  const fields = Object.keys(record).sort();
  if (fields.join(',') !== 'record_count,records_sha256,replay_id,schema_version') throw new CoordinationRuntimeError('invalid-request', 'semantic replay header fields are closed');
  const replayId = record['replay_id'];
  const count = record['record_count'];
  const sha256 = record['records_sha256'];
  if (record['schema_version'] !== COORDINATOR_SEMANTIC_REPLAY_SCHEMA || typeof replayId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(replayId) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > COORDINATOR_MAX_SEMANTIC_REPLAY_RECORDS || typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) throw new CoordinationRuntimeError('invalid-request', 'semantic replay header identity, count, or digest is invalid');
  return { schema_version: COORDINATOR_SEMANTIC_REPLAY_SCHEMA, replay_id: replayId, record_count: count, records_sha256: sha256 as `sha256:${string}` };
}

function semanticReplayReceiptPath(paths: CoordinatorRuntimePaths, replayId: string): string {
  return join(paths.semanticReplayReceiptsRoot, `${replayId}.json`);
}

function parseSemanticReplayReceipt(text: string, path: string): CoordinatorSemanticReplayReceipt {
  const line = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (line.length === 0 || line.includes('\n')) throw new CoordinationRuntimeError('invalid-state', 'semantic replay receipt must contain exactly one JSON record', [path]);
  let value: unknown;
  try { value = JSON.parse(line) as unknown; } catch (error) {
    throw new CoordinationRuntimeError('invalid-state', 'semantic replay receipt is not valid JSON', [path, error instanceof Error ? error.message : String(error)]);
  }
  if (canonicalJson(value) !== line || typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', 'semantic replay receipt must be a canonical object', [path]);
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).sort().join(',') !== 'applied_at,record_count,records_sha256,replay_id,schema_version') throw new CoordinationRuntimeError('invalid-state', 'semantic replay receipt fields are closed', [path]);
  const replayId = record['replay_id'];
  const count = record['record_count'];
  const sha256 = record['records_sha256'];
  const appliedAt = record['applied_at'];
  if (record['schema_version'] !== 'autopilot.coordinator_semantic_replay_receipt.v1' || typeof replayId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(replayId) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > COORDINATOR_MAX_SEMANTIC_REPLAY_RECORDS || typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256) || !isCanonicalIsoTimestamp(appliedAt)) throw new CoordinationRuntimeError('invalid-state', 'semantic replay receipt identity, count, digest, or timestamp is invalid', [path]);
  return { schema_version: 'autopilot.coordinator_semantic_replay_receipt.v1', replay_id: replayId, record_count: count, records_sha256: sha256 as `sha256:${string}`, applied_at: appliedAt as string };
}

function sameSemanticReplayIdentity(receipt: CoordinatorSemanticReplayReceipt, header: CoordinatorSemanticReplayHeader): boolean {
  return receipt.replay_id === header.replay_id && receipt.record_count === header.record_count && receipt.records_sha256 === header.records_sha256;
}

function syncParentDirectory(path: string): void {
  if (platform() === 'win32') return;
  const descriptor = openSync(dirname(path), fsConstants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function assertPrivateDirectory(path: string, label: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new CoordinationRuntimeError('permission-denied', `${label} must be a real directory, not a symlink or junction`, [path]);
}

async function ensureSemanticReplayRoots(paths: CoordinatorRuntimePaths): Promise<void> {
  // This producer is also called directly by the CLI, before server startup.
  // Use the shared authority primitive first: on Windows it installs the
  // protected user-only root DACL before a descendant mkdir/open can inherit
  // an operator override's permissive ACL.
  await ensureCoordinatorPrivateRoots(paths);
  assertPrivateDirectory(paths.stateRoot, 'Autopilot state root');
  for (const path of [paths.coordinatorRoot, paths.semanticReplayReceiptsRoot]) {
    const relativePath = relative(paths.stateRoot, path);
    if (relativePath.length === 0 || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new CoordinationRuntimeError('permission-denied', 'semantic replay path escapes the Autopilot state root', [path]);
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
    if (physicalRelative === '..' || physicalRelative.startsWith(`..${sep}`) || isAbsolute(physicalRelative)) throw new CoordinationRuntimeError('permission-denied', 'semantic replay path physically escapes the Autopilot state root', [path]);
  }
}

interface ReplayFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function replayFileIdentity(descriptor: number): ReplayFileIdentity {
  const metadata = fstatSync(descriptor);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > COORDINATOR_MAX_SEMANTIC_REPLAY_BYTES) throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus must be a bounded regular file');
  return { dev: metadata.dev, ino: metadata.ino, size: metadata.size, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs };
}

function sameReplayFileIdentity(left: ReplayFileIdentity, right: ReplayFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function* semanticReplayLines(path: string, descriptor?: number): AsyncGenerator<string> {
  const stream = descriptor === undefined ? createReadStream(path, { encoding: 'utf8' }) : null;
  async function* chunks(): AsyncGenerator<string> {
    if (stream !== null) {
      for await (const chunk of stream) yield chunk;
      return;
    }
    if (descriptor === undefined) return;
    const bytes = Buffer.allocUnsafe(1024 * 1024);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (;;) {
      const count = readSync(descriptor, bytes, 0, bytes.length, null);
      if (count === 0) break;
      yield decoder.decode(bytes.subarray(0, count), { stream: true });
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  }
  let buffered = '';
  try {
    for await (const chunk of chunks()) {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (Buffer.byteLength(line, 'utf8') > COORDINATOR_MAX_SEMANTIC_REPLAY_LINE_BYTES) throw new CoordinationRuntimeError('invalid-request', 'semantic replay record exceeds its per-record byte bound');
        yield line;
      }
      if (Buffer.byteLength(buffered, 'utf8') > COORDINATOR_MAX_SEMANTIC_REPLAY_LINE_BYTES) throw new CoordinationRuntimeError('invalid-request', 'semantic replay record exceeds its per-record byte bound');
    }
    if (buffered.length > 0) throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus must end with a newline');
  } finally { stream?.destroy(); }
}

export async function stageCoordinatorSemanticReplay(paths: CoordinatorRuntimePaths, replayId: string, records: Iterable<CoordinatorSemanticReplayRecord> | AsyncIterable<CoordinatorSemanticReplayRecord>): Promise<{ readonly record_count: number; readonly records_sha256: `sha256:${string}` }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(replayId)) throw new CoordinationRuntimeError('invalid-request', 'semantic replay id is invalid');
  await ensureSemanticReplayRoots(paths);
  if (existsSync(paths.semanticReplayPath)) throw new CoordinationRuntimeError('invalid-state', 'a semantic replay corpus is already pending', [paths.semanticReplayPath]);
  const suffix = `${String(process.pid)}.${Date.now().toString(16)}`;
  const bodyPath = `${paths.semanticReplayPath}.${suffix}.body`;
  const candidatePath = `${paths.semanticReplayPath}.${suffix}.candidate`;
  let body: Awaited<ReturnType<typeof openFile>> | null = null;
  let candidate: Awaited<ReturnType<typeof openFile>> | null = null;
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
      if (lineBytes > COORDINATOR_MAX_SEMANTIC_REPLAY_LINE_BYTES || count > COORDINATOR_MAX_SEMANTIC_REPLAY_RECORDS || bytes > COORDINATOR_MAX_SEMANTIC_REPLAY_BYTES) throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus exceeds its record or byte bound');
      hash.update(line, 'utf8');
      buffered += line;
      bufferedBytes += lineBytes;
      if (bufferedBytes >= 1024 * 1024) { await body.writeFile(buffered, 'utf8'); buffered = ''; bufferedBytes = 0; }
    }
    if (buffered.length > 0) await body.writeFile(buffered, 'utf8');
    if (count === 0) throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus must not be empty');
    await body.sync();
    const recordsSha256 = `sha256:${hash.digest('hex')}` as `sha256:${string}`;
    const header: CoordinatorSemanticReplayHeader = { schema_version: COORDINATOR_SEMANTIC_REPLAY_SCHEMA, replay_id: replayId, record_count: count, records_sha256: recordsSha256 };
    const headerLine = `${canonicalJson(header)}\n`;
    if (bytes + Buffer.byteLength(headerLine, 'utf8') > COORDINATOR_MAX_SEMANTIC_REPLAY_BYTES) throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus exceeds its total byte bound');
    candidate = await openFile(candidatePath, 'wx', 0o600);
    await enforcePrivateAuthorityPath(candidatePath, false);
    await candidate.writeFile(headerLine, 'utf8');
    const source = await openFile(bodyPath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const read = await source.read(buffer, 0, buffer.length, null);
        if (read.bytesRead === 0) break;
        await candidate.write(buffer.subarray(0, read.bytesRead));
      }
    } finally { await source.close(); }
    await candidate.sync();
    await candidate.close(); candidate = null;
    await body.close(); body = null;
    try {
      await link(candidatePath, paths.semanticReplayPath);
      // The hard link inherits the already-private file object, but enforce and
      // verify the final authority name explicitly before publishing durability.
      await enforcePrivateAuthorityPath(paths.semanticReplayPath, false);
      syncParentDirectory(paths.semanticReplayPath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new CoordinationRuntimeError('invalid-state', 'a semantic replay corpus became pending during staging', [paths.semanticReplayPath]);
      throw error;
    }
    await unlink(candidatePath);
    await unlink(bodyPath);
    return { record_count: count, records_sha256: recordsSha256 };
  } catch (error) {
    const cleanupFailures: string[] = [];
    for (const [label, handle] of [['candidate', candidate], ['body', body]] as const) {
      if (handle === null) continue;
      try { await handle.close(); }
      catch (cleanupError) { cleanupFailures.push(`${label}-close:${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); }
    }
    for (const path of [candidatePath, bodyPath]) {
      try { await unlink(path); }
      catch (cleanupError) {
        if (!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT')) cleanupFailures.push(`unlink:${path}:${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
    if (cleanupFailures.length > 0) throw new CoordinationRuntimeError('system-fatal', 'semantic replay staging failed and private temporary cleanup was incomplete', [error instanceof Error ? error.message : String(error), ...cleanupFailures]);
    throw error;
  }
}

/** Stages operator-supplied canonical request JSONL through the same bounded
 * production producer used by startup recovery. The source is opened once and
 * must remain the same regular file for the complete staging pass. */
export async function stageCoordinatorSemanticReplayFile(paths: CoordinatorRuntimePaths, replayId: string, inputPath: string): Promise<{ readonly record_count: number; readonly records_sha256: `sha256:${string}` }> {
  const sourcePath = resolve(inputPath);
  const metadata = lstatSync(sourcePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > COORDINATOR_MAX_SEMANTIC_REPLAY_BYTES) throw new CoordinationRuntimeError('invalid-request', 'semantic replay source must be a bounded regular non-symbolic file', [sourcePath]);
  const descriptor = openSync(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const before = replayFileIdentity(descriptor);
  async function* records(): AsyncGenerator<CoordinatorSemanticReplayRecord> {
    for await (const line of semanticReplayLines(sourcePath, descriptor)) yield parseSemanticReplayLine(line, 'operator semantic replay record');
    if (!sameReplayFileIdentity(before, replayFileIdentity(descriptor))) throw new CoordinationRuntimeError('invalid-request', 'semantic replay source changed while it was staged', [sourcePath]);
  }
  try { return await stageCoordinatorSemanticReplay(paths, replayId, records()); }
  finally { closeSync(descriptor); }
}

function requestDigest(request: CoordinatorRequestEnvelope): `sha256:${string}` {
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

function parseJsonObject(text: string, label: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CoordinationRuntimeError('store-corrupt', `${label} contains invalid JSON`, [error instanceof Error ? error.message : String(error)]);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CoordinationRuntimeError('store-corrupt', `${label} is not an object`);
  return value as Readonly<Record<string, unknown>>;
}

function repositoryFromRow(row: SqlRow): CoordinationRepository {
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

function runFromRow(row: SqlRow): CoordinationRun {
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

function runResourceFromRow(row: SqlRow): CoordinationRunResource {
  return parseCoordinationRunResource(parseJsonObject(sqlString(row, 'payload_json'), 'run resource'));
}

function sessionFromRow(row: SqlRow): CoordinationSessionLease {
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

function childFromRow(row: SqlRow): CoordinationChildLease {
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

function entityFromRow<T>(row: SqlRow, parser: (value: unknown) => T, label: string): T {
  const parsed = parser(parseJsonObject(sqlString(row, 'payload_json'), label));
  const version = sqlInteger(row, 'version');
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== version) throw new CoordinationRuntimeError('store-corrupt', `${label} payload version disagrees with its indexed row`);
  return parsed;
}

function acquisitionGroupFromRow(row: SqlRow): CoordinationAcquisitionGroup {
  return entityFromRow(row, parseCoordinationAcquisitionGroup, 'acquisition group');
}

function observationFromRow(row: SqlRow): CoordinationObservation {
  const observation = entityFromRow(row, parseCoordinationObservation, 'observation');
  if (sqlString(row, 'execution_state') !== observation.execution_state || sqlString(row, 'freshness') !== observation.freshness || sqlString(row, 'acquisition_group_id') !== observation.acquisition_group_id) throw new CoordinationRuntimeError('store-corrupt', 'observation indexed projection disagrees with its payload');
  return observation;
}

function editLeaseFromRow(row: SqlRow): CoordinationEditLease {
  return entityFromRow(row, parseCoordinationEditLease, 'edit lease');
}

function changeReservationFromRow(row: SqlRow): CoordinationChangeReservation {
  return entityFromRow(row, parseCoordinationChangeReservation, 'change reservation');
}

function reservationObligationFromRow(row: SqlRow): CoordinationReservationObligation {
  return entityFromRow(row, parseCoordinationReservationObligation, 'reservation obligation');
}

function runTerminalIntentFromRow(row: SqlRow): CoordinationRunTerminalIntent {
  // D65-A3: a v2 append-only intent row is projected to the v1-compatible
  // CoordinationRunTerminalIntent shape for status/doctor/invariant consumers.
  // The extra v2 fields (intent_attempt/prior chain/effect sets) are surfaced
  // only through the semantic-graph coordinator projection, never lost.
  const payload = parseJsonObject(sqlString(row, 'payload_json'), 'run terminal intent');
  if (payload['schema_version'] === 'autopilot.run_terminal_intent.v2') {
    const v2 = parseD65RunTerminalIntentV2(payload);
    return {
      schema_version: 'autopilot.run_terminal_intent.v1', terminal_intent_id: v2.terminal_intent_id, repo_id: v2.repo_id, workstream_run: v2.workstream_run,
      outcome: v2.outcome, state: v2.state, reservation_ids: v2.reservation_ids, prepared_event_seq: v2.prepared_event_seq, terminal_event_seq: v2.terminal_event_seq, version: v2.version,
    };
  }
  return entityFromRow(row, parseCoordinationRunTerminalIntent, 'run terminal intent');
}

function claimRequestFromRow(row: SqlRow): CoordinationClaimRequest {
  return entityFromRow(row, parseCoordinationClaimRequest, 'claim request');
}

function unitAttemptFromRow(row: SqlRow): CoordinationUnitAttempt {
  return entityFromRow(row, parseCoordinationUnitAttempt, 'unit attempt');
}

function worktreeFromRow(row: SqlRow): CoordinationWorktree {
  return entityFromRow(row, parseCoordinationWorktree, 'worktree');
}

function worktreeOperationFromRow(row: SqlRow): CoordinationWorktreeOperation {
  return entityFromRow(row, parseCoordinationWorktreeOperation, 'worktree operation');
}

function worktreeAliasFromRow(row: SqlRow): WorktreeAlias {
  return parseWorktreeAlias({ schema_version: AUTOPILOT_WORKTREE_ALIAS_SCHEMA, alias_worktree_id: sqlString(row, 'alias_worktree_id'), canonical_worktree_id: sqlString(row, 'canonical_worktree_id'), repo_id: sqlString(row, 'repo_id'), autopilot_id: sqlString(row, 'autopilot_id'), workstream_run: sqlString(row, 'workstream_run'), unit_id: sqlString(row, 'unit_id'), attempt: sqlInteger(row, 'attempt'), kind: sqlString(row, 'kind'), resolution_state: sqlString(row, 'resolution_state'), reason: sqlString(row, 'reason'), evidence_sha256: sqlString(row, 'evidence_sha256'), created_event_seq: sqlInteger(row, 'created_event_seq') });
}

function canonicalWorktreeFromRow(row: SqlRow): CoordinationWorktree {
  const worktree = worktreeFromRow(row);
  const canonicalId = sqlString(row, 'canonical_worktree_id');
  const expected = deterministicWorktreeId(worktree.owner, worktree.kind);
  if (canonicalId !== expected) throw new CoordinationRuntimeError('store-corrupt', 'indexed canonical worktree ID disagrees with semantic identity', [worktree.worktree_id, canonicalId, expected]);
  return worktree.worktree_id === canonicalId ? worktree : parseCoordinationWorktree({ ...worktree, worktree_id: canonicalId });
}

function canonicalWorktreeOperationFromRow(row: SqlRow): CoordinationWorktreeOperation {
  const operation = worktreeOperationFromRow(row);
  const canonicalId = sqlString(row, 'canonical_worktree_id');
  const expected = deterministicWorktreeId(operation.owner, operation.owner.unit_id === 'main' ? 'main' : 'unit');
  if (canonicalId !== expected) throw new CoordinationRuntimeError('store-corrupt', 'operation canonical index disagrees with its immutable payload owner', [operation.operation_id, canonicalId, expected]);
  return operation;
}

function waitForEdgeFromRow(row: SqlRow): CoordinationWaitForEdge {
  return entityFromRow(row, parseCoordinationWaitForEdge, 'wait-for edge');
}

function deadlockResolutionFromRow(row: SqlRow): CoordinationDeadlockResolution {
  return entityFromRow(row, parseCoordinationDeadlockResolution, 'deadlock resolution');
}

function authoritativeArtifactFromRow(row: SqlRow): CoordinationAuthoritativeArtifact {
  return entityFromRow(row, parseCoordinationAuthoritativeArtifact, 'authoritative artifact');
}

function adjudicationAssignmentFromRow(row: SqlRow): CoordinationAdjudicationAssignment {
  return entityFromRow(row, parseCoordinationAdjudicationAssignment, 'adjudication assignment');
}

function escalationFromRow(row: SqlRow): CoordinationEscalation {
  return entityFromRow(row, parseCoordinationEscalation, 'planning contradiction');
}

function mailboxCursorFromRow(row: SqlRow): CoordinationMailboxCursor {
  return parseCoordinationMailboxCursor({
    schema_version: 'autopilot.mailbox_cursor.v1',
    repo_id: sqlString(row, 'repo_id'),
    workstream_run: sqlString(row, 'workstream_run'),
    delivered_through_event_seq: sqlInteger(row, 'delivered_through_event_seq'),
    acknowledged_through_event_seq: sqlInteger(row, 'acknowledged_through_event_seq'),
    version: sqlInteger(row, 'version'),
  });
}

function reconciliationEvidenceFromRow(row: SqlRow): CoordinationReconciliationEvidence {
  return entityFromRow(row, parseCoordinationReconciliationEvidence, 'reconciliation evidence');
}

function reconciliationReceiptFromRow(row: SqlRow): CoordinationReconciliationReceipt {
  return entityFromRow(row, parseCoordinationReconciliationReceipt, 'reconciliation receipt');
}

function reconciliationDetailFromRow(row: SqlRow): CoordinationReconciliationDetail {
  return parseCoordinationReconciliationDetail({
    schema_version: 'autopilot.reconciliation_detail.v1',
    reconciliation_receipt_id: sqlString(row, 'reconciliation_receipt_id'),
    ordinal: sqlInteger(row, 'ordinal'),
    kind: sqlString(row, 'kind'),
    entity_id: sqlString(row, 'entity_id'),
  });
}

function mailboxDeliveryFromRow(row: SqlRow): CoordinationMailboxDeliveryReceipt {
  return parseCoordinationMailboxDeliveryReceipt(parseJsonObject(sqlString(row, 'payload_json'), 'mailbox delivery receipt'));
}

function resultReceiptFromRow(row: SqlRow): CoordinationResultReceipt {
  return parseCoordinationResultReceipt(parseJsonObject(sqlString(row, 'payload_json'), 'result receipt'));
}

function resultDetailFromRow(row: SqlRow): CoordinationResultDetail {
  return parseCoordinationResultDetail({
    schema_version: 'autopilot.result_detail.v1', result_receipt_id: sqlString(row, 'result_receipt_id'), ordinal: sqlInteger(row, 'ordinal'),
    collection: sqlString(row, 'collection_name'), collection_ordinal: sqlInteger(row, 'collection_ordinal'), value: JSON.parse(sqlString(row, 'payload_json')) as unknown,
  });
}

function messageFromRow(row: SqlRow): CoordinationMessage {
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

function eventFromRow(row: SqlRow): CoordinationEvent {
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

function migrationRecordFromRow(row: SqlRow): Readonly<Record<string, unknown>> {
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

function runScopedFaultFromRow(row: SqlRow): RunScopedLogicalFault {
  return parseRunScopedLogicalFault({
    schema_version: AUTOPILOT_RUN_SCOPED_FAULT_SCHEMA,
    fault_id: sqlString(row, 'fault_id'),
    invariant_id: sqlString(row, 'invariant_id'),
    repo_id: sqlString(row, 'repo_id'),
    workstream_run: sqlString(row, 'workstream_run'),
    entity_type: sqlString(row, 'entity_type'),
    entity_id: sqlString(row, 'entity_id'),
    fault_code: sqlString(row, 'fault_code'),
    detail: parseJsonObject(sqlString(row, 'detail_json'), 'run-scoped fault detail'),
    status: sqlString(row, 'status'),
    created_event_seq: sqlInteger(row, 'created_event_seq'),
    resolved_event_seq: sqlNullableInteger(row, 'resolved_event_seq'),
    version: sqlInteger(row, 'version'),
  });
}

function migrationRecoveryFromRow(row: SqlRow): CoordinationMigrationRecoveryWork {
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

interface PendingAliasPlan {
  readonly alias: Omit<WorktreeAlias, 'evidence_sha256' | 'created_event_seq'>;
  readonly detail: Readonly<Record<string, unknown>>;
}

interface PendingRunFaultPlan {
  readonly invariant_id: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly fault_code: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

function internalEvidenceEvent(db: DatabaseSync, clock: StoreClock, input: { readonly repoId: string; readonly eventType: string; readonly entityType: string; readonly entityId: string; readonly label: string; readonly detail: Readonly<Record<string, unknown>> }): { readonly eventSeq: number; readonly evidenceSha256: `sha256:${string}` } {
  const sequence = sqlInteger(asRow(db.prepare('UPDATE repositories SET event_seq=event_seq+1 WHERE repo_id=? RETURNING event_seq').get(input.repoId), 'internal event sequence'), 'event_seq');
  const body = new TextEncoder().encode(`${canonicalJson(input.detail)}\n`);
  const evidenceSha256 = `sha256:${createHash('sha256').update(body).digest('hex')}` as const;
  const artifactId = stableEntityId('evidence', [input.eventType, input.repoId, input.entityId, String(sequence)]);
  db.prepare('INSERT INTO evidence_artifacts(entity_id, repo_id, sha256, ref, label, content, size_bytes, created_event_seq) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(artifactId, input.repoId, evidenceSha256, `internal/s1-store/${input.eventType}/${input.entityId}.${String(sequence)}.json`, input.label, body, body.byteLength, sequence);
  db.prepare('INSERT INTO events(repo_id,event_seq,event_type,entity_type,entity_id,idempotency_key,request_sha256,occurred_at) VALUES(?,?,?,?,?,?,?,?)').run(input.repoId, sequence, input.eventType, input.entityType, input.entityId, `internal:s1:${input.eventType}:${input.entityId}:${String(sequence)}`, evidenceSha256, clock.now().toISOString());
  return { eventSeq: sequence, evidenceSha256 };
}

function repairEventCountersBeforeSchema13Evidence(db: DatabaseSync, clock: StoreClock): void {
  for (const row of db.prepare('SELECT repo_id,event_seq FROM repositories ORDER BY repo_id').all()) {
    const repoId = sqlString(row, 'repo_id');
    const counter = sqlInteger(row, 'event_seq');
    const facts = asRow(db.prepare('SELECT COUNT(*) AS event_count,COALESCE(MAX(event_seq),0) AS maximum FROM events WHERE repo_id=?').get(repoId), 'event counter facts');
    const count = sqlInteger(facts, 'event_count');
    const maximum = sqlInteger(facts, 'maximum');
    if (count !== maximum) throw new CoordinationRuntimeError('store-corrupt', 'event history has a missing sequence and cannot be repaired mechanically', [repoId, `count=${String(count)}`, `maximum=${String(maximum)}`]);
    if (counter > maximum) throw new CoordinationRuntimeError('store-corrupt', 'repository event counter is ahead of immutable event history', [repoId, `counter=${String(counter)}`, `maximum=${String(maximum)}`]);
    if (counter === maximum) continue;
    db.prepare('UPDATE repositories SET event_seq=? WHERE repo_id=?').run(maximum, repoId);
    internalEvidenceEvent(db, clock, {
      repoId,
      eventType: 'store-invariant-repaired',
      entityType: 'repository',
      entityId: repoId,
      label: 'event counter behind repair',
      detail: { schema_version: 'autopilot.store_invariant_repair.v1', invariant_id: 'F4-EVENT-COUNTER-BEHIND', repo_id: repoId, observed_counter: counter, observed_maximum_event_seq: maximum, repair: 'advance-to-maximum-then-allocate-audit-event' },
    });
  }
}

function persistRunFaultAtEvent(db: DatabaseSync, plan: PendingRunFaultPlan, createdEventSeq: number): void {
  const faultId = stableEntityId('run-fault', [plan.invariant_id, plan.repo_id, plan.workstream_run, plan.entity_type, plan.entity_id]);
  if (db.prepare("SELECT fault_id FROM run_scoped_faults WHERE invariant_id=? AND repo_id=? AND workstream_run=? AND entity_type=? AND entity_id=? AND status='active'").get(plan.invariant_id, plan.repo_id, plan.workstream_run, plan.entity_type, plan.entity_id) !== undefined) return;
  db.prepare("INSERT INTO run_scoped_faults(fault_id,invariant_id,repo_id,workstream_run,entity_type,entity_id,fault_code,detail_json,status,created_event_seq,resolved_event_seq,version) VALUES(?,?,?,?,?,?,?,?,'active',?,NULL,1)").run(faultId, plan.invariant_id, plan.repo_id, plan.workstream_run, plan.entity_type, plan.entity_id, plan.fault_code, canonicalJson(plan.detail), createdEventSeq);
}

function persistRunFault(db: DatabaseSync, clock: StoreClock, plan: PendingRunFaultPlan): void {
  const faultId = stableEntityId('run-fault', [plan.invariant_id, plan.repo_id, plan.workstream_run, plan.entity_type, plan.entity_id]);
  if (db.prepare("SELECT fault_id FROM run_scoped_faults WHERE invariant_id=? AND repo_id=? AND workstream_run=? AND entity_type=? AND entity_id=? AND status='active'").get(plan.invariant_id, plan.repo_id, plan.workstream_run, plan.entity_type, plan.entity_id) !== undefined) return;
  const event = internalEvidenceEvent(db, clock, { repoId: plan.repo_id, eventType: 'run-scoped-fault-recorded', entityType: plan.entity_type, entityId: plan.entity_id, label: 'run-scoped logical store fault', detail: { schema_version: 'autopilot.run_scoped_fault.v1', fault_id: faultId, ...plan } });
  persistRunFaultAtEvent(db, plan, event.eventSeq);
}

function canonicalizeSchema13Worktrees(db: DatabaseSync, clock: StoreClock): void {
  const before = historicalConservationSnapshot(db);
  const aliasPlans: PendingAliasPlan[] = [];
  const faultPlans: PendingRunFaultPlan[] = [];
  const canonicalByRawId = new Map<string, string>();
  const groups = new Map<string, CoordinationWorktree[]>();
  for (const row of db.prepare('SELECT * FROM worktrees ORDER BY repo_id,workstream_run,entity_id').all()) {
    try {
      const worktree = worktreeFromRow(row);
      const canonicalId = deterministicWorktreeId(worktree.owner, worktree.kind);
      canonicalByRawId.set(worktree.worktree_id, canonicalId);
      const key = worktreeOwnerKindKey(worktree);
      groups.set(key, [...(groups.get(key) ?? []), worktree]);
    } catch (error) {
      faultPlans.push({ invariant_id: 'F3-CANONICAL-IDENTITY', repo_id: sqlString(row, 'repo_id'), workstream_run: sqlString(row, 'workstream_run'), entity_type: 'worktrees', entity_id: sqlString(row, 'entity_id'), fault_code: 'identity-recovery-pending', detail: { reason: 'malformed-payload-not-used-for-ownership', indexed_owner_only: true, parser_error: error instanceof Error ? error.message : String(error) } });
    }
  }
  for (const candidates of groups.values()) {
    const first = candidates[0];
    if (first === undefined) continue;
    const canonicalId = deterministicWorktreeId(first.owner, first.kind);
    const deterministic = candidates.find((candidate) => candidate.worktree_id === canonicalId);
    const operationCounts = new Map(candidates.map((candidate) => {
      let count = 0;
      for (const operationRow of db.prepare('SELECT payload_json FROM worktree_operations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(candidate.owner.repo_id, candidate.owner.workstream_run)) {
        try {
          if (parseJsonObject(sqlString(operationRow, 'payload_json'), 'worktree operation identity count')['worktree_id'] === candidate.worktree_id) count += 1;
        } catch { /* malformed operation is persisted as a scoped fault below */ }
      }
      return [candidate.worktree_id, count] as const;
    }));
    const ordered = [...candidates].sort((left, right) => (operationCounts.get(right.worktree_id) ?? 0) - (operationCounts.get(left.worktree_id) ?? 0) || left.worktree_id.localeCompare(right.worktree_id));
    const current = deterministic ?? ordered[0];
    if (current === undefined) throw new CoordinationRuntimeError('store-corrupt', 'canonical worktree group has no current projection');
    const pending = candidates.length > 1;
    for (const candidate of candidates) {
      db.prepare('UPDATE worktrees SET canonical_worktree_id=?,autopilot_id=?,unit_id=?,attempt=?,kind=?,is_current_canonical=? WHERE entity_id=?').run(canonicalId, candidate.owner.autopilot_id, candidate.owner.unit_id, candidate.owner.attempt, candidate.kind, candidate.worktree_id === current.worktree_id ? 1 : 0, candidate.worktree_id);
      if (candidate.worktree_id === canonicalId) continue;
      aliasPlans.push({
        alias: { schema_version: AUTOPILOT_WORKTREE_ALIAS_SCHEMA, alias_worktree_id: candidate.worktree_id, canonical_worktree_id: canonicalId, repo_id: candidate.owner.repo_id, autopilot_id: candidate.owner.autopilot_id, workstream_run: candidate.owner.workstream_run, unit_id: candidate.owner.unit_id, attempt: candidate.owner.attempt, kind: candidate.kind, resolution_state: pending ? 'identity-recovery-pending' : 'resolved', reason: pending ? 'duplicate-semantic-projection' : 'legacy-migration-id' },
        detail: { schema_version: 'autopilot.worktree_alias_migration_evidence.v1', alias_worktree_id: candidate.worktree_id, canonical_worktree_id: canonicalId, semantic_identity: { ...candidate.owner, kind: candidate.kind }, candidate_ids: candidates.map((entry) => entry.worktree_id).sort(), operation_counts: Object.fromEntries([...operationCounts.entries()].sort()), external_git_registration_branch_ref_facts: pending ? 'required-before-resolution' : 'not-required-single-projection', classification: pending ? 'identity-recovery-pending' : 'resolved' },
      });
    }
    if (pending) faultPlans.push({ invariant_id: 'F3-SEMANTIC-UNIQUENESS', repo_id: first.owner.repo_id, workstream_run: first.owner.workstream_run, entity_type: 'worktree', entity_id: canonicalId, fault_code: 'identity-recovery-pending', detail: { canonical_worktree_id: canonicalId, candidate_ids: candidates.map((entry) => entry.worktree_id).sort(), current_projection_id: current.worktree_id, external_git_facts_required: true, destructive_authority: 'blocked' } });
  }
  for (const row of db.prepare('SELECT * FROM worktree_operations ORDER BY repo_id,workstream_run,entity_id').all()) {
    const operationId = sqlString(row, 'entity_id');
    let operation: CoordinationWorktreeOperation;
    try { operation = worktreeOperationFromRow(row); }
    catch (error) {
      faultPlans.push({ invariant_id: 'F4-PAYLOAD-INDEX-AMBIGUITY', repo_id: sqlString(row, 'repo_id'), workstream_run: sqlString(row, 'workstream_run'), entity_type: 'worktree_operations', entity_id: operationId, fault_code: 'logical-row-fault', detail: { reason: 'operation-payload-contract-invalid', indexed_owner_only: true, parser_error: error instanceof Error ? error.message : String(error) } });
      continue;
    }
    const canonicalId = canonicalByRawId.get(operation.worktree_id);
    if (canonicalId === undefined) {
      faultPlans.push({ invariant_id: 'F3-OPERATION-CANONICAL-INDEX', repo_id: sqlString(row, 'repo_id'), workstream_run: sqlString(row, 'workstream_run'), entity_type: 'worktree_operations', entity_id: operationId, fault_code: 'identity-recovery-pending', detail: { reason: 'operation-worktree-identity-unresolvable', raw_payload_not_used_for_owner_scope: true } });
      continue;
    }
    db.prepare('UPDATE worktree_operations SET canonical_worktree_id=? WHERE entity_id=?').run(canonicalId, operationId);
  }
  const afterProjection = historicalConservationSnapshot(db);
  if (canonicalJson(before) !== canonicalJson(afterProjection)) throw new CoordinationRuntimeError('store-corrupt', 'schema-13 canonical projection migration changed historical payload/content bytes', [canonicalJson(before), canonicalJson(afterProjection)]);
  repairEventCountersBeforeSchema13Evidence(db, clock);
  for (const plan of aliasPlans) {
    const event = internalEvidenceEvent(db, clock, { repoId: plan.alias.repo_id, eventType: 'worktree-alias-registered', entityType: 'worktree-alias', entityId: plan.alias.alias_worktree_id, label: 'schema-13 worktree alias migration', detail: plan.detail });
    db.prepare('INSERT INTO worktree_aliases(alias_worktree_id,canonical_worktree_id,repo_id,autopilot_id,workstream_run,unit_id,attempt,kind,resolution_state,reason,evidence_sha256,created_event_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(plan.alias.alias_worktree_id, plan.alias.canonical_worktree_id, plan.alias.repo_id, plan.alias.autopilot_id, plan.alias.workstream_run, plan.alias.unit_id, plan.alias.attempt, plan.alias.kind, plan.alias.resolution_state, plan.alias.reason, event.evidenceSha256, event.eventSeq);
  }
  for (const plan of faultPlans) persistRunFault(db, clock, plan);
}

function integrityResult(db: DatabaseSync): string {
  const row = asRow(db.prepare('PRAGMA integrity_check').get(), 'integrity_check');
  const value = row['integrity_check'];
  if (typeof value !== 'string') throw new CoordinationRuntimeError('store-corrupt', 'integrity check returned an invalid result');
  return value;
}

function configureWritableDatabase(db: DatabaseSync): void {
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE; PRAGMA busy_timeout=${String(COORDINATOR_BUSY_TIMEOUT_MS)}; PRAGMA trusted_schema=OFF;`);
}

function databaseUserVersion(db: DatabaseSync): number {
  return sqlInteger(asRow(db.prepare('PRAGMA user_version').get(), 'user_version'), 'user_version');
}

function applySchemaMigrations(db: DatabaseSync, clock: StoreClock, targetVersion: number): void {
  const currentVersion = databaseUserVersion(db);
  if (currentVersion > targetVersion) throw new CoordinationRuntimeError('schema-mismatch', `database schema ${String(currentVersion)} is newer than migration target ${String(targetVersion)}`);
  for (const migration of COORDINATOR_SCHEMA_MIGRATIONS) {
    if (migration.version > targetVersion || currentVersion >= migration.version) continue;
    const checksum = createHash('sha256').update(migration.sql, 'utf8').digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      if (migration.version === COORDINATOR_STORE_SCHEMA_VERSION) canonicalizeSchema13Worktrees(db, clock);
      db.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(?, ?, ?)').run(migration.version, checksum, clock.now().toISOString());
      db.exec(`PRAGMA user_version=${String(migration.version)}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  for (const migration of COORDINATOR_SCHEMA_MIGRATIONS) {
    if (migration.version > targetVersion) continue;
    let migrationRow: SqlRow | undefined;
    try { migrationRow = db.prepare('SELECT version, checksum FROM schema_migrations WHERE version=?').get(migration.version); }
    catch (error) { throw new CoordinationRuntimeError('schema-mismatch', 'coordinator migration journal is unavailable', [error instanceof Error ? error.message : String(error)]); }
    const expectedChecksum = createHash('sha256').update(migration.sql, 'utf8').digest('hex');
    if (migrationRow === undefined || sqlInteger(migrationRow, 'version') !== migration.version || sqlString(migrationRow, 'checksum') !== expectedChecksum) throw new CoordinationRuntimeError('schema-mismatch', `coordinator migration ${String(migration.version)} checksum does not match the package schema`);
  }
  if (databaseUserVersion(db) !== targetVersion) throw new CoordinationRuntimeError('schema-mismatch', 'database did not reach the exact requested schema migration boundary');
}

interface LogicalOwnedRowProjection {
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly version: number;
}

function inImmediateTransaction(db: DatabaseSync, action: () => void): void {
  if (db.isTransaction) { action(); return; }
  db.exec('BEGIN IMMEDIATE');
  try { action(); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function repairEventCounterInvariantPass(db: DatabaseSync, clock: StoreClock): void {
  inImmediateTransaction(db, () => repairEventCountersBeforeSchema13Evidence(db, clock));
}

function detectAndPersistLogicalRowFaults(db: DatabaseSync, clock: StoreClock): void {
  const owner = (value: { readonly owner: CoordinationOwnerIdentity; readonly version: number }): LogicalOwnedRowProjection => ({ repo_id: value.owner.repo_id, workstream_run: value.owner.workstream_run, version: value.version });
  const singleOwnerTables: readonly { readonly table: string; readonly identity: string; readonly parse: (row: SqlRow) => LogicalOwnedRowProjection }[] = [
    { table: 'run_resources', identity: 'entity_id', parse: (row) => { const value = runResourceFromRow(row); return { repo_id: value.repo_id, workstream_run: value.workstream_run, version: value.version }; } },
    { table: 'unit_attempts', identity: 'entity_id', parse: (row) => owner(unitAttemptFromRow(row)) },
    { table: 'acquisition_groups', identity: 'entity_id', parse: (row) => owner(acquisitionGroupFromRow(row)) },
    { table: 'observations', identity: 'entity_id', parse: (row) => owner(observationFromRow(row)) },
    { table: 'edit_leases', identity: 'entity_id', parse: (row) => owner(editLeaseFromRow(row)) },
    { table: 'change_reservations', identity: 'entity_id', parse: (row) => { const value = changeReservationFromRow(row); return { repo_id: value.repo_id, workstream_run: value.workstream_run, version: value.version }; } },
    { table: 'reservation_obligations', identity: 'entity_id', parse: (row) => { const value = reservationObligationFromRow(row); return { repo_id: value.repo_id, workstream_run: value.workstream_run, version: value.version }; } },
    { table: 'run_terminal_intents', identity: 'entity_id', parse: (row) => { const value = runTerminalIntentFromRow(row); return { repo_id: value.repo_id, workstream_run: value.workstream_run, version: value.version }; } },
    { table: 'reconciliation_evidence', identity: 'entity_id', parse: (row) => { const value = reconciliationEvidenceFromRow(row); return { repo_id: value.repo_id, workstream_run: value.workstream_run, version: value.version }; } },
    { table: 'reconciliation_receipts', identity: 'entity_id', parse: (row) => { const value = reconciliationReceiptFromRow(row); return { repo_id: value.repo_id, workstream_run: value.workstream_run, version: value.version }; } },
    { table: 'mailbox_deliveries', identity: 'delivery_id', parse: (row) => { const value = mailboxDeliveryFromRow(row); return { repo_id: value.repo_id, workstream_run: value.workstream_run, version: value.version }; } },
    { table: 'result_receipts', identity: 'entity_id', parse: (row) => { const value = resultReceiptFromRow(row); return { repo_id: value.repo_id, workstream_run: value.workstream_run, version: value.version }; } },
    { table: 'worktrees', identity: 'entity_id', parse: (row) => owner(worktreeFromRow(row)) },
    { table: 'worktree_operations', identity: 'entity_id', parse: (row) => owner(worktreeOperationFromRow(row)) },
  ];
  inImmediateTransaction(db, () => {
    for (const descriptor of singleOwnerTables) {
      for (const row of db.prepare(`SELECT * FROM ${descriptor.table} ORDER BY repo_id,workstream_run,${descriptor.identity}`).all()) {
        const entityId = sqlString(row, descriptor.identity);
        let projection: LogicalOwnedRowProjection | null = null;
        let parserError: string | null = null;
        try { projection = descriptor.parse(row); }
        catch (error) { parserError = error instanceof Error ? error.message : String(error); }
        const indexedRepo = sqlString(row, 'repo_id');
        const indexedRun = sqlString(row, 'workstream_run');
        if (projection !== null && (projection.repo_id !== indexedRepo || projection.workstream_run !== indexedRun)) throw new CoordinationRuntimeError('store-corrupt', 'logical payload/index ownership is ambiguous and cannot be scoped safely', [descriptor.table, entityId, `indexed=${indexedRepo}:${indexedRun}`, `payload=${projection.repo_id}:${projection.workstream_run}`]);
        const indexedVersion = sqlInteger(row, 'version');
        if (projection === null || projection.version !== indexedVersion) persistRunFault(db, clock, { invariant_id: 'F4-PAYLOAD-INDEX-AMBIGUITY', repo_id: indexedRepo, workstream_run: indexedRun, entity_type: descriptor.table, entity_id: entityId, fault_code: 'logical-row-fault', detail: { reason: projection === null ? 'payload-contract-or-index-projection-invalid' : 'payload-version-index-mismatch', parser_error: parserError, indexed_version: indexedVersion, payload_version: projection?.version ?? null, owner_scope_source: 'indexed-columns-only' } });
      }
    }
    for (const row of db.prepare('SELECT * FROM claim_requests ORDER BY repo_id,entity_id').all()) {
      let request: CoordinationClaimRequest | null = null;
      try { request = claimRequestFromRow(row); } catch { request = null; }
      const indexedRequester = sqlString(row, 'requester_workstream_run');
      const indexedOwner = sqlString(row, 'owner_workstream_run');
      if (request === null || request.requester.repo_id !== sqlString(row, 'repo_id') || request.owner.repo_id !== sqlString(row, 'repo_id') || request.requester.workstream_run !== indexedRequester || request.owner.workstream_run !== indexedOwner) throw new CoordinationRuntimeError('store-corrupt', 'claim request payload/index ambiguity has two indexed run owners and cannot be scoped safely', [sqlString(row, 'entity_id'), indexedRequester, indexedOwner]);
    }
  });
}

function verifySchema13Projections(db: DatabaseSync): void {
  if (integrityResult(db) !== 'ok' || databaseUserVersion(db) !== COORDINATOR_STORE_SCHEMA_VERSION) throw new CoordinationRuntimeError('store-corrupt', 'schema-13 database failed physical integrity or schema identity');
  const missingWorktreeProjection = db.prepare("SELECT worktrees.entity_id FROM worktrees WHERE (canonical_worktree_id IS NULL OR autopilot_id IS NULL OR unit_id IS NULL OR attempt IS NULL OR kind IS NULL) AND NOT EXISTS(SELECT 1 FROM run_scoped_faults faults WHERE faults.repo_id=worktrees.repo_id AND faults.workstream_run=worktrees.workstream_run AND faults.entity_type='worktrees' AND faults.entity_id=worktrees.entity_id AND faults.status='active') LIMIT 1").get();
  if (missingWorktreeProjection !== undefined) throw new CoordinationRuntimeError('store-corrupt', 'schema-13 worktree lacks canonical projection without an exact scoped fault', [sqlString(missingWorktreeProjection, 'entity_id')]);
  const missingOperationProjection = db.prepare("SELECT worktree_operations.entity_id FROM worktree_operations WHERE canonical_worktree_id IS NULL AND NOT EXISTS(SELECT 1 FROM run_scoped_faults faults WHERE faults.repo_id=worktree_operations.repo_id AND faults.workstream_run=worktree_operations.workstream_run AND faults.entity_type='worktree_operations' AND faults.entity_id=worktree_operations.entity_id AND faults.status='active') LIMIT 1").get();
  if (missingOperationProjection !== undefined) throw new CoordinationRuntimeError('store-corrupt', 'schema-13 operation lacks canonical projection without an exact scoped fault', [sqlString(missingOperationProjection, 'entity_id')]);
  const invalidCurrentGroup = db.prepare('SELECT repo_id,workstream_run,autopilot_id,unit_id,attempt,kind,COUNT(*) AS projection_count,SUM(is_current_canonical) AS current_count FROM worktrees WHERE canonical_worktree_id IS NOT NULL GROUP BY repo_id,workstream_run,autopilot_id,unit_id,attempt,kind HAVING SUM(is_current_canonical)<>1 LIMIT 1').get();
  if (invalidCurrentGroup !== undefined) throw new CoordinationRuntimeError('store-corrupt', 'schema-13 semantic identity does not have exactly one current projection', [sqlString(invalidCurrentGroup, 'repo_id'), sqlString(invalidCurrentGroup, 'workstream_run'), sqlString(invalidCurrentGroup, 'unit_id'), `projection_count=${String(sqlInteger(invalidCurrentGroup, 'projection_count'))}`, `current_count=${String(sqlInteger(invalidCurrentGroup, 'current_count'))}`]);
  for (const row of db.prepare('SELECT * FROM worktrees WHERE canonical_worktree_id IS NOT NULL ORDER BY repo_id,workstream_run,entity_id').all()) {
    let worktree: CoordinationWorktree;
    try { worktree = worktreeFromRow(row); }
    catch {
      const fault = db.prepare("SELECT fault_id FROM run_scoped_faults WHERE repo_id=? AND workstream_run=? AND entity_type='worktrees' AND entity_id=? AND status='active'").get(sqlString(row, 'repo_id'), sqlString(row, 'workstream_run'), sqlString(row, 'entity_id'));
      if (fault !== undefined) continue;
      throw new CoordinationRuntimeError('store-corrupt', 'schema-13 worktree projection cannot be parsed and has no scoped fault', [sqlString(row, 'entity_id')]);
    }
    const expected = deterministicWorktreeId(worktree.owner, worktree.kind);
    if (sqlString(row, 'canonical_worktree_id') !== expected || sqlString(row, 'autopilot_id') !== worktree.owner.autopilot_id || sqlString(row, 'unit_id') !== worktree.owner.unit_id || sqlInteger(row, 'attempt') !== worktree.owner.attempt || sqlString(row, 'kind') !== worktree.kind) throw new CoordinationRuntimeError('store-corrupt', 'schema-13 worktree indexed identity disagrees with its exact semantic payload', [worktree.worktree_id]);
  }
  const unaliasedHistorical = db.prepare('SELECT entity_id,repo_id,workstream_run,canonical_worktree_id FROM worktrees WHERE canonical_worktree_id IS NOT NULL AND entity_id<>canonical_worktree_id AND NOT EXISTS(SELECT 1 FROM worktree_aliases aliases WHERE aliases.alias_worktree_id=worktrees.entity_id AND aliases.canonical_worktree_id=worktrees.canonical_worktree_id) LIMIT 1').get();
  if (unaliasedHistorical !== undefined) throw new CoordinationRuntimeError('store-corrupt', 'schema-13 historical non-canonical worktree has no immutable direct alias', [sqlString(unaliasedHistorical, 'entity_id'), sqlString(unaliasedHistorical, 'canonical_worktree_id')]);
  const aliasChain = db.prepare('SELECT left_alias.alias_worktree_id FROM worktree_aliases left_alias JOIN worktree_aliases right_alias ON right_alias.alias_worktree_id=left_alias.canonical_worktree_id OR right_alias.canonical_worktree_id=left_alias.alias_worktree_id LIMIT 1').get();
  if (aliasChain !== undefined) throw new CoordinationRuntimeError('store-corrupt', 'schema-13 alias registry contains a chain');
  const requiredIndexes = [
    ['idx_run_scoped_faults_active', "where status='active'"], ['idx_run_scoped_faults_run', 'workstream_run'],
    ['idx_worktree_aliases_canonical', 'canonical_worktree_id'], ['idx_worktrees_canonical', 'canonical_worktree_id'],
    ['idx_worktrees_current_semantic', 'where is_current_canonical=1'], ['idx_worktree_operations_canonical', 'canonical_worktree_id'],
  ] as const;
  for (const [indexName, requiredSql] of requiredIndexes) {
    const index = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(indexName);
    if (index === undefined || !sqlString(index, 'sql').toLowerCase().includes(requiredSql)) throw new CoordinationRuntimeError('store-corrupt', 'schema-13 authority index is missing or changed', [indexName]);
  }
  for (const triggerName of ['worktree_aliases_deny_update', 'worktree_aliases_deny_delete', 'worktree_aliases_deny_chain_insert']) {
    const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=? AND tbl_name='worktree_aliases'").get(triggerName);
    if (trigger === undefined || !sqlString(trigger, 'sql').includes(triggerName === 'worktree_aliases_deny_chain_insert' ? 'worktree alias chains are forbidden' : 'worktree aliases are immutable')) throw new CoordinationRuntimeError('store-corrupt', 'schema-13 alias immutability trigger is missing or changed', [triggerName]);
  }
  for (const row of db.prepare('SELECT * FROM worktree_aliases ORDER BY alias_worktree_id').all()) {
    const alias = parseWorktreeAlias({ schema_version: AUTOPILOT_WORKTREE_ALIAS_SCHEMA, alias_worktree_id: sqlString(row, 'alias_worktree_id'), canonical_worktree_id: sqlString(row, 'canonical_worktree_id'), repo_id: sqlString(row, 'repo_id'), autopilot_id: sqlString(row, 'autopilot_id'), workstream_run: sqlString(row, 'workstream_run'), unit_id: sqlString(row, 'unit_id'), attempt: sqlInteger(row, 'attempt'), kind: sqlString(row, 'kind'), resolution_state: sqlString(row, 'resolution_state'), reason: sqlString(row, 'reason'), evidence_sha256: sqlString(row, 'evidence_sha256'), created_event_seq: sqlInteger(row, 'created_event_seq') });
    if (deterministicWorktreeId({ repo_id: alias.repo_id, autopilot_id: alias.autopilot_id, workstream_run: alias.workstream_run, unit_id: alias.unit_id, attempt: alias.attempt }, alias.kind) !== alias.canonical_worktree_id) throw new CoordinationRuntimeError('store-corrupt', 'schema-13 alias target disagrees with deterministic semantic identity', [alias.alias_worktree_id]);
    const historical = db.prepare('SELECT canonical_worktree_id,repo_id,workstream_run,autopilot_id,unit_id,attempt,kind FROM worktrees WHERE entity_id=?').get(alias.alias_worktree_id);
    if (historical === undefined || sqlString(historical, 'canonical_worktree_id') !== alias.canonical_worktree_id || sqlString(historical, 'repo_id') !== alias.repo_id || sqlString(historical, 'workstream_run') !== alias.workstream_run || sqlString(historical, 'autopilot_id') !== alias.autopilot_id || sqlString(historical, 'unit_id') !== alias.unit_id || sqlInteger(historical, 'attempt') !== alias.attempt || sqlString(historical, 'kind') !== alias.kind) throw new CoordinationRuntimeError('store-corrupt', 'schema-13 alias does not preserve an exact historical worktree projection', [alias.alias_worktree_id]);
  }
  for (const row of db.prepare('SELECT * FROM worktree_operations WHERE canonical_worktree_id IS NOT NULL ORDER BY repo_id,workstream_run,entity_id').all()) {
    let operation: CoordinationWorktreeOperation;
    try { operation = worktreeOperationFromRow(row); }
    catch {
      const fault = db.prepare("SELECT fault_id FROM run_scoped_faults WHERE repo_id=? AND workstream_run=? AND entity_type='worktree_operations' AND entity_id=? AND status='active'").get(sqlString(row, 'repo_id'), sqlString(row, 'workstream_run'), sqlString(row, 'entity_id'));
      if (fault !== undefined) continue;
      throw new CoordinationRuntimeError('store-corrupt', 'schema-13 operation projection cannot be parsed and has no scoped fault', [sqlString(row, 'entity_id')]);
    }
    const identity = db.prepare('SELECT canonical_worktree_id FROM worktrees WHERE entity_id=? UNION ALL SELECT canonical_worktree_id FROM worktree_aliases WHERE alias_worktree_id=?').all(operation.worktree_id, operation.worktree_id);
    const targets = [...new Set(identity.map((candidate) => sqlString(candidate, 'canonical_worktree_id')))];
    if (targets.length !== 1 || targets[0] !== sqlString(row, 'canonical_worktree_id')) throw new CoordinationRuntimeError('store-corrupt', 'schema-13 operation canonical index does not resolve exactly one immutable worktree identity', [operation.operation_id, operation.worktree_id]);
  }
  for (const row of db.prepare('SELECT repo_id,event_seq FROM repositories ORDER BY repo_id').all()) {
    const facts = asRow(db.prepare('SELECT COUNT(*) AS event_count,COALESCE(MAX(event_seq),0) AS maximum FROM events WHERE repo_id=?').get(sqlString(row, 'repo_id')), 'schema-13 event facts');
    if (sqlInteger(row, 'event_seq') !== sqlInteger(facts, 'maximum') || sqlInteger(facts, 'event_count') !== sqlInteger(facts, 'maximum')) throw new CoordinationRuntimeError('store-corrupt', 'schema-13 event counter/history invariant is not exact', [sqlString(row, 'repo_id')]);
  }
}

function verifyIdentityRecoveryCoverage(db: DatabaseSync): void {
  const uncovered = db.prepare("SELECT aliases.alias_worktree_id,aliases.canonical_worktree_id,aliases.repo_id,aliases.workstream_run FROM worktree_aliases aliases WHERE aliases.resolution_state='identity-recovery-pending' AND NOT EXISTS(SELECT 1 FROM run_scoped_faults faults WHERE faults.invariant_id='F3-SEMANTIC-UNIQUENESS' AND faults.repo_id=aliases.repo_id AND faults.workstream_run=aliases.workstream_run AND faults.entity_type='worktree' AND faults.entity_id=aliases.canonical_worktree_id AND (faults.status='active' OR (faults.status='resolved' AND faults.resolved_event_seq IS NOT NULL))) LIMIT 1").get();
  if (uncovered !== undefined) throw new CoordinationRuntimeError('store-corrupt', 'identity-recovery-pending alias has no exact active-or-audited-resolved run-scoped fault', [sqlString(uncovered, 'alias_worktree_id'), sqlString(uncovered, 'canonical_worktree_id')]);
  const unauditedResolution = db.prepare("SELECT faults.fault_id FROM run_scoped_faults faults WHERE faults.invariant_id='F3-SEMANTIC-UNIQUENESS' AND faults.status='resolved' AND NOT EXISTS(SELECT 1 FROM events WHERE events.repo_id=faults.repo_id AND events.event_seq=faults.resolved_event_seq AND events.event_type='run-scoped-fault-resolved' AND events.entity_type='run-scoped-fault' AND events.entity_id=faults.fault_id) LIMIT 1").get();
  if (unauditedResolution !== undefined) throw new CoordinationRuntimeError('store-corrupt', 'resolved canonical identity fault has no exact immutable resolution event', [sqlString(unauditedResolution, 'fault_id')]);
  for (const row of db.prepare("SELECT * FROM run_scoped_faults WHERE invariant_id='F3-SEMANTIC-UNIQUENESS' AND status='resolved' ORDER BY fault_id").all()) {
    const fault = runScopedFaultFromRow(row);
    const event = asRow(db.prepare("SELECT idempotency_key,request_sha256,event_type,entity_type,entity_id FROM events WHERE repo_id=? AND event_seq=?").get(fault.repo_id, fault.resolved_event_seq), 'canonical identity resolution event');
    const result = asRow(db.prepare('SELECT request_sha256,committed_event_seq,payload_json FROM idempotency_results WHERE repo_id=? AND idempotency_key=?').get(fault.repo_id, sqlString(event, 'idempotency_key')), 'canonical identity resolution idempotency result');
    if (sqlString(event, 'event_type') !== 'run-scoped-fault-resolved' || sqlString(event, 'entity_type') !== 'run-scoped-fault' || sqlString(event, 'entity_id') !== fault.fault_id
      || sqlString(result, 'request_sha256') !== sqlString(event, 'request_sha256') || sqlInteger(result, 'committed_event_seq') !== fault.resolved_event_seq) throw new CoordinationRuntimeError('store-corrupt', 'canonical identity resolution event and idempotency authority disagree', [fault.fault_id]);
    const payload = parseJsonObject(sqlString(result, 'payload_json'), 'canonical identity resolution result');
    const recordedFault = parseRunScopedLogicalFault(payload['run_scoped_fault']);
    const resolution = parseIdentityFaultResolutionEvidence(payload['identity_resolution']);
    const evidenceRef = payload['resolution_evidence'];
    if (!isJsonMap(evidenceRef) || canonicalJson(Object.keys(evidenceRef).sort()) !== canonicalJson(['ref', 'sha256']) || typeof evidenceRef['ref'] !== 'string' || !SHA256_PATTERN.test(String(evidenceRef['sha256']))) throw new CoordinationRuntimeError('store-corrupt', 'canonical identity resolution result lacks exact evidence authority', [fault.fault_id]);
    const expectedRef = `_saga-evidence/${fault.workstream_run}/identity-recovery/${fault.fault_id}.json`;
    const expectedEvidenceSha256 = `sha256:${createHash('sha256').update(`${canonicalJson(resolution)}\n`, 'utf8').digest('hex')}`;
    if (canonicalJson(recordedFault) !== canonicalJson(fault) || resolution.fault_id !== fault.fault_id || resolution.repo_id !== fault.repo_id || resolution.workstream_run !== fault.workstream_run || resolution.canonical_worktree_id !== fault.entity_id || evidenceRef['ref'] !== expectedRef || evidenceRef['sha256'] !== expectedEvidenceSha256
      || payload['event_type'] !== 'run-scoped-fault-resolved' || payload['entity_type'] !== 'run-scoped-fault' || payload['entity_id'] !== fault.fault_id) throw new CoordinationRuntimeError('store-corrupt', 'canonical identity resolution audit payload differs from durable fault authority', [fault.fault_id]);
  }
}

function storeInvariantDetectorHost(input: { readonly db: DatabaseSync; readonly clock: StoreClock; readonly writerGuard: CoordinatorWriterGuard; readonly generation: CurrentStoreGeneration; readonly migrationBoundarySchema12: boolean }): S1InvariantDetectorHost {
  let logicalSchemaVerified = false;
  const verifyLogicalSchema = (): void => {
    if (logicalSchemaVerified) return;
    verifySchema13Projections(input.db);
    logicalSchemaVerified = true;
  };
  return {
    detectPhysicalIntegrity: () => { if (integrityResult(input.db) !== 'ok') throw new CoordinationRuntimeError('store-corrupt', 'schema-13 database failed physical integrity'); },
    detectStoreGeneration: () => {
      if (input.generation.pointer.generation_id !== input.generation.publication.generation_id || input.generation.pointer.store_schema_version !== COORDINATOR_STORE_SCHEMA_VERSION || input.generation.publication.store_schema_version !== COORDINATOR_STORE_SCHEMA_VERSION) throw new CoordinationRuntimeError('store-corrupt', 'selected store generation identity is internally contradictory');
    },
    detectWriterGuard: () => input.writerGuard.assertHeld(),
    detectMigrationBoundary: () => { if (!input.migrationBoundarySchema12 || databaseUserVersion(input.db) !== COORDINATOR_DATABASE_SCHEMA_VERSION) throw new CoordinationRuntimeError('schema-mismatch', 'private generation migration requires exact cf50 schema 12'); },
    detectEventCounterBehind: () => repairEventCounterInvariantPass(input.db, input.clock),
    detectEventCounterAhead: verifyLogicalSchema,
    detectPayloadIndexAmbiguity: () => detectAndPersistLogicalRowFaults(input.db, input.clock),
    detectCanonicalIdentity: verifyLogicalSchema,
    detectAliasOneHop: verifyLogicalSchema,
    detectSemanticUniqueness: verifyLogicalSchema,
    detectOperationCanonicalIndex: verifyLogicalSchema,
    detectIdentityRecovery: () => verifyIdentityRecoveryCoverage(input.db),
  };
}

const STORE_OPEN_INVARIANT_IDS = Object.freeze([
  'F4-WRITER-GUARD', 'F4-STORE-GENERATION', 'F4-PHYSICAL-INTEGRITY', 'F4-EVENT-COUNTER-BEHIND',
  'F4-PAYLOAD-INDEX-AMBIGUITY', 'F4-EVENT-COUNTER-AHEAD', 'F3-CANONICAL-IDENTITY', 'F3-ALIAS-ONE-HOP',
  'F3-SEMANTIC-UNIQUENESS', 'F3-OPERATION-CANONICAL-INDEX', 'F3-IDENTITY-RECOVERY',
] as const);

function migrationInvariantDetectorHost(db: DatabaseSync, writerGuard: CoordinatorWriterGuard): S1InvariantDetectorHost {
  const unavailable = (): never => { throw new CoordinationRuntimeError('system-fatal', 'an unrelated invariant detector was invoked during the closed schema-12 migration phase'); };
  return {
    detectPhysicalIntegrity: unavailable,
    detectStoreGeneration: unavailable,
    detectWriterGuard: () => writerGuard.assertHeld(),
    detectMigrationBoundary: () => {
      if (databaseUserVersion(db) !== COORDINATOR_DATABASE_SCHEMA_VERSION) throw new CoordinationRuntimeError('schema-mismatch', 'private generation migration requires exact cf50 schema 12');
    },
    detectEventCounterBehind: unavailable,
    detectEventCounterAhead: unavailable,
    detectPayloadIndexAmbiguity: unavailable,
    detectCanonicalIdentity: unavailable,
    detectAliasOneHop: unavailable,
    detectSemanticUniqueness: unavailable,
    detectOperationCanonicalIndex: unavailable,
    detectIdentityRecovery: unavailable,
  };
}

function schemaMigrationAdapter(clock: StoreClock, writerGuard: CoordinatorWriterGuard): StoreGenerationMigrationAdapter {
  return {
    prepareFreshSchema12: async (databasePath) => {
      const db = new DatabaseSync(databasePath, { timeout: COORDINATOR_BUSY_TIMEOUT_MS, enableForeignKeyConstraints: true });
      try { configureWritableDatabase(db); applySchemaMigrations(db, clock, COORDINATOR_DATABASE_SCHEMA_VERSION); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
      finally { db.close(); }
    },
    migrateSchema12To13: async (databasePath) => {
      const db = new DatabaseSync(databasePath, { timeout: COORDINATOR_BUSY_TIMEOUT_MS, enableForeignKeyConstraints: true });
      try {
        configureWritableDatabase(db);
        runS1InvariantDetectors(migrationInvariantDetectorHost(db, writerGuard), ['F4-WRITER-GUARD', 'F4-MIGRATION-BOUNDARY']);
        applySchemaMigrations(db, clock, COORDINATOR_STORE_SCHEMA_VERSION);
        verifySchema13Projections(db);
        db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
        return COORDINATOR_SCHEMA_MIGRATION_CHECKSUMS;
      } finally { db.close(); }
    },
    verifySchema13: async (databasePath) => {
      const db = new DatabaseSync(databasePath, { readOnly: true, timeout: COORDINATOR_BUSY_TIMEOUT_MS });
      try {
        applySchemaMigrations(db, clock, COORDINATOR_STORE_SCHEMA_VERSION);
        verifySchema13Projections(db);
      } finally { db.close(); }
    },
  };
}

function migrationRecoveryCoversRetainedAuthority(db: DatabaseSync, repoId: string, finding: CoordinationInvariantFinding): boolean {
  const pendingLeaseIds = (workstreamRun: string): ReadonlySet<string> => new Set(db.prepare("SELECT payload_json FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND recovery_type='ambiguous-live-claim' AND status='pending' ORDER BY entity_id").all(repoId, workstreamRun).map((row) => {
    const detail = parseJsonObject(sqlString(row, 'payload_json'), 'pending migration recovery detail');
    const leaseId = detail['edit_lease_id'];
    if (typeof leaseId !== 'string') throw new CoordinationRuntimeError('store-corrupt', 'pending migration recovery lacks an exact edit lease identity');
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

function sqliteFailure(error: unknown): CoordinationRuntimeError {
  const message = error instanceof Error ? error.message : String(error);
  if (/busy|locked/u.test(message.toLowerCase())) return new CoordinationRuntimeError('coordinator-contention', message);
  if (/readonly|permission|access/u.test(message.toLowerCase())) return new CoordinationRuntimeError('permission-denied', message);
  if (/disk|full|i\/o/u.test(message.toLowerCase())) return new CoordinationRuntimeError('disk-failure', message);
  if (/malformed|not a database|corrupt/u.test(message.toLowerCase())) return new CoordinationRuntimeError('store-corrupt', message);
  return new CoordinationRuntimeError('invalid-state', message);
}

/** Existing exact-build upgrade-chain adapter. It may transform only an
 * isolated, already verified schema-6 copy into the exact schema-12 input that
 * S1 generation publication accepts. It never opens or reinterprets S1 store
 * authority in place. */
export async function upgradeVerifiedPrivateSchema6CopyToSchema12(paths: CoordinatorRuntimePaths, verifiedSourceSha256: `sha256:${string}`, clock: StoreClock = systemClock): Promise<void> {
  await ensureCoordinatorPrivateRoots(paths);
  assertPrivatePathNoAliases(paths.databasePath);
  await enforcePrivateAuthorityPath(paths.databasePath, false);
  const sourceDigest = (): `sha256:${string}` => `sha256:${createHash('sha256').update(readFileSync(paths.databasePath)).digest('hex')}`;
  if (!SHA256_PATTERN.test(verifiedSourceSha256) || sourceDigest() !== verifiedSourceSha256) throw new CoordinationRuntimeError('store-corrupt', 'verified private schema-6 copy differs from exact upgrade backup evidence', [paths.databasePath]);
  const writerGuard = await CoordinatorWriterGuard.acquire(paths);
  try {
    writerGuard.assertHeld();
    if (sourceDigest() !== verifiedSourceSha256) throw new CoordinationRuntimeError('store-corrupt', 'verified private schema-6 copy changed before guarded transformation', [paths.databasePath]);
    const database = new DatabaseSync(paths.databasePath, { timeout: COORDINATOR_BUSY_TIMEOUT_MS, enableForeignKeyConstraints: true });
    try {
      configureWritableDatabase(database);
      const integrity = integrityResult(database);
      const version = databaseUserVersion(database);
      if (integrity !== 'ok' || version !== 6) throw new CoordinationRuntimeError('schema-mismatch', 'verified private upgrade copy must retain exact schema-6 integrity before schema-12 transformation', [`integrity=${integrity}`, `schema=${String(version)}`]);
      applySchemaMigrations(database, clock, COORDINATOR_DATABASE_SCHEMA_VERSION);
      if (databaseUserVersion(database) !== COORDINATOR_DATABASE_SCHEMA_VERSION || integrityResult(database) !== 'ok') throw new CoordinationRuntimeError('store-corrupt', 'verified private upgrade copy did not reach exact schema-12 integrity');
      database.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
    } finally { database.close(); }
    for (const suffix of ['-wal', '-shm']) if (existsSync(`${paths.databasePath}${suffix}`)) throw new CoordinationRuntimeError('store-corrupt', 'verified private schema-12 upgrade retained WAL/SHM authority', [`${paths.databasePath}${suffix}`]);
    await enforcePrivateAuthorityPath(paths.databasePath, false);
  } finally { writerGuard.release(); }
}

export class CoordinatorStore {
  readonly #db: DatabaseSync;
  readonly #clock: StoreClock;
  readonly #stateRoot: string;
  readonly #exportsRoot: string;
  readonly #databasePath: string;
  readonly #writerGuard: CoordinatorWriterGuard;
  readonly #ownsWriterGuard: boolean;
  readonly #generation: CurrentStoreGeneration;
  #lastBackupPath: string | null;
  #lastStartupReconciliation: CoordinationReconciliationReceipt | null = null;
  #semanticReplayTransactionActive = false;
  readonly #semanticReplayGraphlessRepositories = new Set<string>();
  readonly #semanticReplayNonD65Runs = new Set<string>();
  readonly #semanticReplayWithoutCompleteGraph = new Set<string>();
  readonly #semanticReplayFaultFreeRuns = new Set<string>();
  readonly #projectionScans = new Map<string, ProjectionScan>();
  readonly #onSemanticReplayBoundary: CoordinatorStoreOpenOptions['onSemanticReplayBoundary'];
  readonly #idempotencyLookup: StatementSync;
  readonly #insertEvent: StatementSync;
  readonly #insertIdempotencyResult: StatementSync;
  readonly #incrementRepositorySequence: StatementSync;
  readonly #runByIdentity: StatementSync;
  readonly #attachedSessionByIdentity: StatementSync;
  readonly #sessionByLeaseId: StatementSync;
  readonly #pendingMigrationRecoveryByRun: StatementSync;
  readonly #updateSessionHeartbeat: StatementSync;

  private constructor(db: DatabaseSync, clock: StoreClock, stateRoot: string, exportsRoot: string, databasePath: string, writerGuard: CoordinatorWriterGuard, ownsWriterGuard: boolean, generation: CurrentStoreGeneration, lastBackupPath: string | null, options: CoordinatorStoreOpenOptions) {
    this.#db = db;
    this.#clock = clock;
    this.#stateRoot = stateRoot;
    this.#exportsRoot = exportsRoot;
    this.#databasePath = databasePath;
    this.#writerGuard = writerGuard;
    this.#ownsWriterGuard = ownsWriterGuard;
    this.#generation = generation;
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
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS run_catalog_scans (
        scan_token TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        scope_sha256 TEXT NOT NULL,
        revision_sha256 TEXT NOT NULL,
        pending_recovery_count INTEGER NOT NULL CHECK(pending_recovery_count >= 0),
        item_count INTEGER NOT NULL CHECK(item_count >= 0),
        created_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER
      ) STRICT;
      CREATE TEMP TABLE IF NOT EXISTS run_catalog_scan_items (
        scan_token TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
        run_json TEXT NOT NULL,
        run_resource_json TEXT NOT NULL,
        PRIMARY KEY(scan_token, ordinal),
        FOREIGN KEY(scan_token) REFERENCES run_catalog_scans(scan_token) ON DELETE CASCADE
      ) STRICT;
    `);
  }

  static async restoreGeneration(paths: CoordinatorRuntimePaths, sourceDatabasePath: string, sourceDatabaseSha256: `sha256:${string}`, clock: StoreClock = systemClock, onBoundary?: (boundary: StorePublicationBoundary) => void | Promise<void>): Promise<CurrentStoreGeneration> {
    const writerGuard = await CoordinatorWriterGuard.acquire(paths);
    try {
      const migration = schemaMigrationAdapter(clock, writerGuard);
      const current = await ensureCurrentStoreGeneration(paths, writerGuard, migration);
      return await publishRestoredStoreGeneration(paths, writerGuard, sourceDatabasePath, sourceDatabaseSha256, current.pointer.generation_id, migration, { now: () => clock.now(), ...(onBoundary === undefined ? {} : { onBoundary }) });
    } finally { writerGuard.release(); }
  }

  static async open(paths: CoordinatorRuntimePaths, clock: StoreClock = systemClock, options: CoordinatorStoreOpenOptions = {}): Promise<CoordinatorStore> {
    try {
      await ensureCoordinatorPrivateRoots(paths);
      await ensureSemanticReplayRoots(paths);
      await mkdir(paths.backupsRoot, { recursive: true, mode: 0o700 });
      assertPrivateDirectory(paths.backupsRoot, 'coordinator backups root');
    } catch (error) {
      throw sqliteFailure(error);
    }
    const ownsWriterGuard = options.writerGuard === undefined;
    const writerGuard = options.writerGuard ?? await CoordinatorWriterGuard.acquire(paths);
    writerGuard.assertHeldFor(paths);
    let lastBackupPath: string | null = null;
    let openedDatabase: DatabaseSync | null = null;
    try {
      assertPrivatePathNoAliases(paths.databasePath);
      const generation = await ensureCurrentStoreGeneration(paths, writerGuard, schemaMigrationAdapter(clock, writerGuard), { now: () => clock.now(), ...(options.onStorePublicationBoundary === undefined ? {} : { onBoundary: options.onStorePublicationBoundary }) });
      writerGuard.assertHeld();
      const db = new DatabaseSync(generation.database_path, { timeout: COORDINATOR_BUSY_TIMEOUT_MS, enableForeignKeyConstraints: true });
      openedDatabase = db;
      try {
        configureWritableDatabase(db);
        applySchemaMigrations(db, clock, COORDINATOR_STORE_SCHEMA_VERSION);
        db.exec('BEGIN IMMEDIATE');
        try {
          runS1InvariantDetectors(storeInvariantDetectorHost({ db, clock, writerGuard, generation, migrationBoundarySchema12: false }), STORE_OPEN_INVARIANT_IDS);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        await enforcePrivateAuthorityPath(generation.database_path, false);
      } catch (error) {
        db.close();
        openedDatabase = null;
        throw error;
      }
      const store = new CoordinatorStore(db, clock, paths.stateRoot, paths.exportsRoot, generation.database_path, writerGuard, ownsWriterGuard, generation, lastBackupPath, options);
      store.#migrateLegacyReconciliationResults();
      store.#migrateSchema9ReadLeasesToObservations();
      // A migration freeze protects a whole-database rollback boundary. Startup
      // replay/recovery is therefore deferred until the freeze is removed;
      // explicit target-repository recovery mutations remain separately fenced.
      if (activeCoordinationMigrationFreeze(paths.stateRoot) === null) {
        await store.#replayPendingSemanticEvents(paths);
        store.#recoverDurableTransitionsAfterStartup();
      }
      return store;
    } catch (error) {
      openedDatabase?.close();
      if (ownsWriterGuard) writerGuard.release();
      if (error instanceof CoordinationRuntimeError) throw error;
      throw sqliteFailure(error);
    }
  }

  currentGeneration(): CurrentStoreGeneration {
    return this.#generation;
  }

  negotiatedIdentityObservability(): Readonly<Record<string, unknown>> {
    this.#writerGuard.assertHeld();
    return Object.freeze({ implementation_build: COORDINATOR_IMPLEMENTATION_BUILD, wire_lineage: COORDINATOR_WIRE_LINEAGE, api_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION, store_schema_version: COORDINATOR_STORE_SCHEMA_VERSION, legacy_facade_build: COORDINATOR_LEGACY_FACADE_BUILD, store_generation_id: this.#generation.pointer.generation_id, current_store_pointer_sha256: this.#generation.pointer_sha256 });
  }

  negotiatedIdentityRecovery(repoId: string, workstreamRun: string | null): readonly Readonly<Record<string, unknown>>[] {
    this.#writerGuard.assertHeld();
    const faultRows = workstreamRun === null
      ? this.#db.prepare("SELECT * FROM run_scoped_faults WHERE repo_id=? AND invariant_id='F3-SEMANTIC-UNIQUENESS' AND status IN ('active','resolved') ORDER BY workstream_run,fault_id LIMIT 129").all(repoId)
      : this.#db.prepare("SELECT * FROM run_scoped_faults WHERE repo_id=? AND workstream_run=? AND invariant_id='F3-SEMANTIC-UNIQUENESS' AND status IN ('active','resolved') ORDER BY fault_id LIMIT 129").all(repoId, workstreamRun);
    if (faultRows.length > 128) throw new CoordinationRuntimeError('invalid-state', 'canonical identity recovery projection exceeds its negotiated bound');
    return Object.freeze(faultRows.map((row) => {
      const fault = runScopedFaultFromRow(row);
      const candidateIds = fault.detail['candidate_ids'];
      const currentProjectionId = fault.detail['current_projection_id'];
      if (!Array.isArray(candidateIds) || !candidateIds.every((candidate) => typeof candidate === 'string') || typeof currentProjectionId !== 'string') throw new CoordinationRuntimeError('store-corrupt', 'canonical identity fault detail lacks its frozen candidate classification', [fault.fault_id]);
      const sortedCandidates = [...candidateIds].sort();
      const candidateWorktrees = sortedCandidates.map((candidateId) => worktreeFromRow(asRow(this.#db.prepare('SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND entity_id=?').get(fault.repo_id, fault.workstream_run, candidateId), 'identity recovery candidate worktree')));
      const candidateOperationIds = sortedCandidates.map((candidateId) => Object.freeze({
        worktree_id: candidateId,
        operation_ids: Object.freeze(this.#db.prepare("SELECT entity_id FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.worktree_id')=? ORDER BY entity_id").all(fault.repo_id, fault.workstream_run, candidateId).map((operationRow) => sqlString(operationRow, 'entity_id'))),
      }));
      return Object.freeze({
        fault,
        fault_id: fault.fault_id,
        canonical_worktree_id: fault.entity_id,
        selected_current_worktree_id: currentProjectionId,
        candidate_worktree_ids: Object.freeze(sortedCandidates),
        candidate_worktrees: Object.freeze(candidateWorktrees),
        candidate_operation_ids: Object.freeze(candidateOperationIds),
      });
    }));
  }

  negotiatedWorktreeAliases(repoId: string, workstreamRun: string | null): readonly WorktreeAlias[] {
    this.#writerGuard.assertHeld();
    const rows = workstreamRun === null
      ? this.#db.prepare('SELECT * FROM worktree_aliases WHERE repo_id=? ORDER BY workstream_run,alias_worktree_id LIMIT 129').all(repoId)
      : this.#db.prepare('SELECT * FROM worktree_aliases WHERE repo_id=? AND workstream_run=? ORDER BY alias_worktree_id LIMIT 129').all(repoId, workstreamRun);
    if (rows.length > 128) throw new CoordinationRuntimeError('invalid-state', 'canonical worktree alias projection exceeds its negotiated bound');
    return Object.freeze(rows.map(worktreeAliasFromRow));
  }

  negotiatedRunScopedFaults(repoId: string, workstreamRun: string | null): readonly RunScopedLogicalFault[] {
    this.#writerGuard.assertHeld();
    const rows = workstreamRun === null
      ? this.#db.prepare("SELECT * FROM run_scoped_faults WHERE repo_id=? AND status='active' ORDER BY workstream_run,fault_id").all(repoId)
      : this.#db.prepare("SELECT * FROM run_scoped_faults WHERE repo_id=? AND workstream_run=? AND status='active' ORDER BY fault_id").all(repoId, workstreamRun);
    return Object.freeze(rows.map(runScopedFaultFromRow));
  }

  canonicalWorktreeIdentity(repoId: string, worktreeId: string): Readonly<{ canonical_worktree_id: string; resolution_state: 'canonical' | WorktreeAlias['resolution_state']; workstream_run: string }> | null {
    this.#writerGuard.assertHeld();
    const aliasRow = this.#db.prepare('SELECT * FROM worktree_aliases WHERE alias_worktree_id=?').get(worktreeId);
    if (aliasRow !== undefined) {
      const alias = worktreeAliasFromRow(aliasRow);
      if (alias.repo_id !== repoId) return null;
      return Object.freeze({ canonical_worktree_id: alias.canonical_worktree_id, resolution_state: alias.resolution_state, workstream_run: alias.workstream_run });
    }
    const row = this.#db.prepare('SELECT canonical_worktree_id,workstream_run FROM worktrees WHERE repo_id=? AND entity_id=?').get(repoId, worktreeId);
    if (row === undefined) return null;
    const canonical = sqlString(row, 'canonical_worktree_id');
    if (canonical !== worktreeId) throw new CoordinationRuntimeError('store-corrupt', 'non-canonical historical worktree lacks its immutable alias', [repoId, worktreeId, canonical]);
    return Object.freeze({ canonical_worktree_id: canonical, resolution_state: 'canonical', workstream_run: sqlString(row, 'workstream_run') });
  }

  checkpointAndClose(): void {
    this.#writerGuard.assertHeld();
    const checkpoint = asRow(this.#db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(), 'WAL checkpoint');
    const busy = checkpoint['busy'];
    if (typeof busy === 'number' && busy !== 0) throw new CoordinationRuntimeError('system-fatal', 'current store WAL checkpoint remained busy during ordered shutdown', [this.#databasePath, `busy=${String(busy)}`]);
    this.#db.close();
    for (const suffix of ['-wal', '-shm']) if (existsSync(`${this.#databasePath}${suffix}`)) throw new CoordinationRuntimeError('system-fatal', 'current store WAL/SHM teardown is incomplete; writer authority remains retained until process death', [`${this.#databasePath}${suffix}`]);
  }

  close(): void {
    this.checkpointAndClose();
    if (this.#ownsWriterGuard) this.#writerGuard.release();
  }

  integrity(): string {
    this.#writerGuard.assertHeld();
    return integrityResult(this.#db);
  }

  replaySemanticEventBatch(records: readonly CoordinatorSemanticReplayRecord[]): readonly { readonly committed_event_seq: number; readonly replayed: boolean }[] {
    this.#writerGuard.assertHeld();
    if (records.length < 1 || records.length > COORDINATOR_SEMANTIC_REPLAY_BATCH_SIZE) throw new CoordinationRuntimeError('invalid-request', 'semantic replay batch size is outside the production bound');
    if (this.#semanticReplayTransactionActive) throw new CoordinationRuntimeError('invalid-state', 'nested semantic replay transactions are forbidden');
    const parsed = records.map((record, index) => parseSemanticReplayRecord(record, `semantic replay batch record ${String(index + 1)}`));
    this.#db.exec('BEGIN IMMEDIATE');
    this.#semanticReplayTransactionActive = true;
    try {
      const results = this.#reduceSemanticReplayRecords(parsed, true);
      this.#db.exec('COMMIT');
      return results;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#semanticReplayTransactionActive = false;
      this.#semanticReplayGraphlessRepositories.clear();
      this.#semanticReplayNonD65Runs.clear();
      this.#semanticReplayWithoutCompleteGraph.clear();
      this.#semanticReplayFaultFreeRuns.clear();
    }
  }

  #reduceSemanticReplayRecords(records: readonly CoordinatorSemanticReplayRecord[], trackReplayState: boolean): readonly { readonly committed_event_seq: number; readonly replayed: boolean }[] {
    const results: { readonly committed_event_seq: number; readonly replayed: boolean }[] = [];
    for (const record of records) {
      const prior = trackReplayState ? this.#db.prepare('SELECT event_seq FROM events WHERE repo_id=? AND idempotency_key=?').get(record.repo_id, record.idempotency_key) : undefined;
      const response = this.handle(record);
      if (record.action !== 'heartbeat') {
        this.#semanticReplayGraphlessRepositories.delete(record.repo_id);
        if (record.workstream_run !== null) {
          const key = `${record.repo_id}\0${record.workstream_run}`;
          this.#semanticReplayNonD65Runs.delete(key);
          this.#semanticReplayWithoutCompleteGraph.delete(key);
          this.#semanticReplayFaultFreeRuns.delete(key);
        }
      }
      if (!response.ok || response.committed_event_seq === null) throw new CoordinationRuntimeError('invalid-state', 'semantic replay reducer rejected a request', [record.request_id, String(response.error_code), String(response.payload['message'] ?? '')]);
      if (trackReplayState) results.push({ committed_event_seq: response.committed_event_seq, replayed: prior !== undefined });
    }
    return Object.freeze(results);
  }

  async #semanticReplayBoundary(boundary: CoordinatorSemanticReplayBoundary): Promise<void> {
    await this.#onSemanticReplayBoundary?.(boundary);
  }

  #allInvariantFindings(): readonly CoordinationInvariantFinding[] {
    const findings: CoordinationInvariantFinding[] = [];
    for (const row of this.#db.prepare('SELECT repo_id FROM repositories ORDER BY repo_id').all()) {
      const repoId = sqlString(row, 'repo_id');
      const scoped = this.#db.prepare("SELECT fault_id,workstream_run,fault_code FROM run_scoped_faults WHERE repo_id=? AND status='active' ORDER BY workstream_run,fault_id").all(repoId);
      if (scoped.length > 0) continue;
      findings.push(...checkCoordinationInvariants(this.#snapshotForRepository(repoId)));
    }
    return Object.freeze(findings);
  }

  #semanticReplayCompletion(header: CoordinatorSemanticReplayHeader): CoordinatorSemanticReplayReceipt | null {
    const row = this.#db.prepare('SELECT replay_id, record_count, records_sha256, applied_at FROM semantic_replays WHERE replay_id=?').get(header.replay_id);
    if (row === undefined) return null;
    const receipt: CoordinatorSemanticReplayReceipt = {
      schema_version: 'autopilot.coordinator_semantic_replay_receipt.v1', replay_id: sqlString(row, 'replay_id'),
      record_count: sqlInteger(row, 'record_count'), records_sha256: sqlString(row, 'records_sha256') as `sha256:${string}`, applied_at: sqlString(row, 'applied_at'),
    };
    if (!sameSemanticReplayIdentity(receipt, header)) throw new CoordinationRuntimeError('idempotency-conflict', 'semantic replay id was reused with a different corpus identity', [header.replay_id]);
    return parseSemanticReplayReceipt(canonicalJson(receipt), 'semantic_replays database row');
  }

  async #projectSemanticReplayReceipt(paths: CoordinatorRuntimePaths, receipt: CoordinatorSemanticReplayReceipt): Promise<void> {
    await ensureSemanticReplayRoots(paths);
    const receiptPath = semanticReplayReceiptPath(paths, receipt.replay_id);
    const temporaryReceipt = join(paths.semanticReplayReceiptsRoot, `.${receipt.replay_id}.${String(process.pid)}.${Date.now().toString(16)}.tmp`);
    const descriptor = openSync(temporaryReceipt, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try {
      writeSync(descriptor, `${canonicalJson(receipt)}\n`);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    try {
      if (existsSync(receiptPath)) {
        const existing = lstatSync(receiptPath);
        if (existing.isDirectory()) throw new CoordinationRuntimeError('permission-denied', 'semantic replay receipt projection refuses to replace a directory', [receiptPath]);
        if (platform() === 'win32') await unlink(receiptPath);
      }
      await rename(temporaryReceipt, receiptPath);
      syncParentDirectory(receiptPath);
      const projected = lstatSync(receiptPath);
      if (!projected.isFile() || projected.isSymbolicLink() || projected.size < 2 || projected.size > 4_096) throw new CoordinationRuntimeError('invalid-state', 'semantic replay receipt projection is not a bounded regular file', [receiptPath]);
      const parsed = parseSemanticReplayReceipt(readFileSync(receiptPath, 'utf8'), receiptPath);
      if (canonicalJson(parsed) !== canonicalJson(receipt)) throw new CoordinationRuntimeError('invalid-state', 'semantic replay receipt projection disagrees with database completion', [receiptPath]);
    } finally {
      try { await unlink(temporaryReceipt); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new CoordinationRuntimeError('system-fatal', 'semantic replay receipt temporary cleanup failed', [temporaryReceipt, error instanceof Error ? error.message : String(error)]);
      }
    }
  }

  async #removeSemanticReplayInbox(paths: CoordinatorRuntimePaths, expected: ReplayFileIdentity): Promise<void> {
    if (!existsSync(paths.semanticReplayPath)) return;
    const descriptor = openSync(paths.semanticReplayPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      if (!sameReplayFileIdentity(expected, replayFileIdentity(descriptor))) throw new CoordinationRuntimeError('invalid-state', 'semantic replay inbox changed after validation; replacement input was preserved', [paths.semanticReplayPath]);
    } finally { closeSync(descriptor); }
    await unlink(paths.semanticReplayPath);
    syncParentDirectory(paths.semanticReplayPath);
  }

  async #replayPendingSemanticEvents(paths: CoordinatorRuntimePaths): Promise<void> {
    if (!existsSync(paths.semanticReplayPath)) return;
    await ensureSemanticReplayRoots(paths);
    const descriptor = openSync(paths.semanticReplayPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const initialIdentity = replayFileIdentity(descriptor);
    let transactionOpen = false;
    let header: CoordinatorSemanticReplayHeader | null = null;
    let receipt: CoordinatorSemanticReplayReceipt | null = null;
    try {
      this.#db.exec('CREATE TEMP TABLE IF NOT EXISTS semantic_replay_stage_work (replay_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 1 AND ordinal <= 100000), record_json TEXT NOT NULL, PRIMARY KEY(replay_id, ordinal)) STRICT, WITHOUT ROWID; DELETE FROM semantic_replay_stage_work;');
      this.#db.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      this.#semanticReplayTransactionActive = true;
      let count = 0;
      const hash = createHash('sha256');
      const insertStagedRecord = this.#db.prepare('INSERT INTO semantic_replay_stage_work(replay_id, ordinal, record_json) VALUES(?, ?, ?)');
      for await (const line of semanticReplayLines(paths.semanticReplayPath, descriptor)) {
        if (header === null) { header = parseSemanticReplayHeader(line); continue; }
        parseSemanticReplayLine(line, `semantic replay record ${String(count + 1)}`);
        count += 1;
        if (count > COORDINATOR_MAX_SEMANTIC_REPLAY_RECORDS) throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus exceeds its record bound');
        hash.update(`${line}\n`, 'utf8');
        // parseSemanticReplayLine proved this exact line canonical and contract-valid.
        // Preserve those immutable bytes in the transaction-local stage rather
        // than serializing the same request a second time.
        insertStagedRecord.run(header.replay_id, count, line);
      }
      if (header === null || count !== header.record_count || `sha256:${hash.digest('hex')}` !== header.records_sha256) throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus count or digest does not match its header');
      if (!sameReplayFileIdentity(initialIdentity, replayFileIdentity(descriptor))) throw new CoordinationRuntimeError('invalid-request', 'semantic replay corpus changed during validation', [paths.semanticReplayPath]);
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
        if (integrityResult(this.#db) !== 'ok') throw new CoordinationRuntimeError('store-corrupt', 'coordinator database failed integrity after semantic replay');
        const invariantErrors = this.#allInvariantFindings().filter((finding) => finding.severity === 'error');
        if (invariantErrors.length > 0) throw new CoordinationRuntimeError('invalid-state', 'semantic replay violates coordinator invariants; query byte-paged doctor for the exact finding set', [`finding_count=${String(invariantErrors.length)}`]);
        receipt = { schema_version: 'autopilot.coordinator_semantic_replay_receipt.v1', replay_id: header.replay_id, record_count: header.record_count, records_sha256: header.records_sha256, applied_at: this.#clock.now().toISOString() };
        this.#db.prepare('INSERT INTO semantic_replays(replay_id, record_count, records_sha256, applied_at) VALUES(?, ?, ?, ?)').run(receipt.replay_id, receipt.record_count, receipt.records_sha256, receipt.applied_at);
      }
      this.#db.prepare('DELETE FROM semantic_replay_stage_work WHERE replay_id=?').run(header.replay_id);
      this.#db.exec('COMMIT');
      transactionOpen = false;
      this.#semanticReplayTransactionActive = false;
      this.#semanticReplayGraphlessRepositories.clear();
      this.#semanticReplayNonD65Runs.clear();
      this.#semanticReplayWithoutCompleteGraph.clear();
      this.#semanticReplayFaultFreeRuns.clear();
      await this.#semanticReplayBoundary('database-completed');
    } catch (error) {
      if (transactionOpen) this.#db.exec('ROLLBACK');
      this.#semanticReplayTransactionActive = false;
      this.#semanticReplayGraphlessRepositories.clear();
      this.#semanticReplayNonD65Runs.clear();
      this.#semanticReplayWithoutCompleteGraph.clear();
      this.#semanticReplayFaultFreeRuns.clear();
      throw error;
    } finally { closeSync(descriptor); }

    if (receipt === null) throw new CoordinationRuntimeError('store-corrupt', 'semantic replay completion disappeared after commit');
    await this.#projectSemanticReplayReceipt(paths, receipt);
    await this.#semanticReplayBoundary('receipt-projected');
    await this.#removeSemanticReplayInbox(paths, initialIdentity);
    await this.#semanticReplayBoundary('inbox-cleaned');
  }

  async createVerifiedBackup(outputPath: string): Promise<{ readonly path: string; readonly sha256: `sha256:${string}` }> {
    this.#writerGuard.assertHeld();
    const target = resolve(outputPath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    await backup(this.#db, target);
    const backupDb = new DatabaseSync(target);
    try {
      const journalMode = sqlString(asRow(backupDb.prepare('PRAGMA journal_mode=DELETE').get(), 'backup journal mode'), 'journal_mode').toLowerCase();
      if (journalMode !== 'delete') throw new CoordinationRuntimeError('store-corrupt', 'migration backup could not retire WAL journal authority', [target, journalMode]);
      if (integrityResult(backupDb) !== 'ok') throw new CoordinationRuntimeError('store-corrupt', 'migration backup failed integrity verification', [target]);
    } finally {
      backupDb.close();
    }
    if (existsSync(`${target}-wal`) || existsSync(`${target}-shm`)) throw new CoordinationRuntimeError('store-corrupt', 'migration backup retained WAL/SHM authority after close', [target]);
    if (platform() !== 'win32') chmodSync(target, 0o600);
    const sha256 = `sha256:${createHash('sha256').update(readFileSync(target)).digest('hex')}` as `sha256:${string}`;
    this.#lastBackupPath = target;
    return { path: target, sha256 };
  }

  importLegacyCoordination(plan: CoordinationLegacyImportPlan): StoreEffect {
    this.#writerGuard.assertHeld();
    parseCoordinationRepository(plan.repository);
    for (const run of plan.runs) parseCoordinationRun(run);
    for (const resource of plan.run_resources) parseCoordinationRunResource(resource);
    for (const attempt of plan.unit_attempts) parseCoordinationUnitAttempt(attempt);
    for (const group of plan.acquisition_groups) parseCoordinationAcquisitionGroup(group);
    for (const lease of plan.edit_leases) {
      if (lease.mode === 'READ') parseCoordinationRequestedLease({ path: lease.path, mode: lease.mode, purpose: lease.purpose }, 'legacy imported READ observation');
      else parseCoordinationEditLease(lease);
    }
    for (const release of plan.terminal_releases) {
      parseCoordinationRequestedLease({ path: release.path, mode: release.mode, purpose: 'migration terminal release proof' }, 'migration terminal release');
      if (!SHA256_PATTERN.test(release.evidence_sha256) || release.evidence_ref.length === 0 || release.evidence_ref.length > 2048) throw new CoordinationRuntimeError('invalid-request', 'migration terminal release evidence identity is invalid');
    }
    for (const reservation of plan.change_reservations) parseCoordinationChangeReservation(reservation);
    for (const obligation of plan.reservation_obligations) parseCoordinationReservationObligation(obligation);
    for (const evidence of plan.reconciliation_evidence) parseCoordinationReconciliationEvidence(evidence);
    for (const worktree of plan.worktrees) parseCoordinationWorktree(worktree);
    if (!SHA256_PATTERN.test(plan.snapshot_sha256)) throw new CoordinationRuntimeError('invalid-request', 'migration snapshot digest is invalid');
    const existingMigration = this.#db.prepare('SELECT migration_id, snapshot_sha256, report_json FROM coordination_migrations WHERE repo_id=?').get(plan.repository.repo_id);
    if (existingMigration !== undefined) {
      if (sqlString(existingMigration, 'migration_id') !== plan.migration_id || sqlString(existingMigration, 'snapshot_sha256') !== plan.snapshot_sha256) throw new CoordinationRuntimeError('idempotency-conflict', 'repository already has a different migration import');
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
      } else {
        const existingRepository = repositoryFromRow(existingRepositoryRow);
        let samePhysicalRepository = false;
        try { samePhysicalRepository = realpathSync(existingRepository.canonical_root) === realpathSync(plan.repository.canonical_root) && realpathSync(existingRepository.git_common_dir) === realpathSync(plan.repository.git_common_dir); }
        catch { samePhysicalRepository = false; }
        if (existingRepository.repo_key !== plan.repository.repo_key || !samePhysicalRepository) throw new CoordinationRuntimeError('invalid-state', 'legacy and coordinator repository identities disagree', [plan.repository.repo_id]);
        seq = sqlInteger(existingRepositoryRow, 'event_seq') + 1;
        this.#db.prepare('UPDATE repositories SET event_seq=? WHERE repo_id=?').run(seq, plan.repository.repo_id);
      }
      const migrationIdempotencyKey = `legacy-migration:${plan.migration_id}`;
      this.#db.prepare('INSERT INTO events(repo_id, event_seq, event_type, entity_type, entity_id, idempotency_key, request_sha256, occurred_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(plan.repository.repo_id, seq, 'legacy-coordination-imported', 'migration', plan.migration_id, migrationIdempotencyKey, plan.snapshot_sha256, now);
      for (const run of plan.runs) {
        const existingRunRow = this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run);
        if (existingRunRow === undefined) {
          this.#db.prepare('INSERT INTO runs(repo_id, autopilot_id, workstream, workstream_run, coordination_authority, status, active_session_generation, created_event_seq, version) VALUES(?, ?, ?, ?, ?, ?, 0, ?, 1)').run(run.repo_id, run.autopilot_id, run.workstream, run.workstream_run, 'coordinator-edit-leases-v1', run.status, seq);
          importedRunCount += 1;
        } else {
          const existingRun = runFromRow(existingRunRow);
          if (existingRun.autopilot_id !== run.autopilot_id || existingRun.workstream !== run.workstream) throw new CoordinationRuntimeError('invalid-state', 'legacy run disagrees with existing coordinator identity', [run.workstream_run]);
          if (existingRun.coordination_authority === 'legacy-path-claims-v1') this.#db.prepare("UPDATE runs SET coordination_authority='coordinator-edit-leases-v1', version=version+1 WHERE repo_id=? AND workstream_run=?").run(run.repo_id, run.workstream_run);
          else if (existingRun.coordination_authority !== 'coordinator-edit-leases-v1') throw new CoordinationRuntimeError('invalid-state', 'existing coordinator run has an unsupported authority', [run.workstream_run]);
          if (run.status === 'recovering' && existingRun.status !== 'closed' && existingRun.status !== 'aborted') this.#db.prepare("UPDATE runs SET status='recovering', version=version+1 WHERE repo_id=? AND workstream_run=?").run(run.repo_id, run.workstream_run);
        }
        if (this.#db.prepare('SELECT repo_id FROM mailbox_cursors WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run) === undefined) this.#db.prepare('INSERT INTO mailbox_cursors(repo_id, workstream_run, delivered_through_event_seq, acknowledged_through_event_seq, version) VALUES(?, ?, 0, 0, 1)').run(run.repo_id, run.workstream_run);
      }
      for (const resource of plan.run_resources) {
        const row = this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(resource.repo_id, resource.workstream_run);
        if (row === undefined) this.#db.prepare('INSERT INTO run_resources(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(`run-resource:${resource.repo_id}:${resource.workstream_run}`, resource.repo_id, resource.workstream_run, canonicalJson(resource), resource.version);
        else if (canonicalJson(runResourceFromRow(row)) !== canonicalJson(resource)) throw new CoordinationRuntimeError('invalid-state', 'legacy run resource disagrees with existing coordinator resource', [resource.workstream_run]);
      }
      for (const attempt of plan.unit_attempts) {
        const entityId = unitAttemptEntityId(attempt.owner);
        const row = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(entityId);
        if (row === undefined) {
          this.#db.prepare('INSERT INTO unit_attempts(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(entityId, attempt.owner.repo_id, attempt.owner.workstream_run, canonicalJson(attempt), attempt.version);
          importedAttemptCount += 1;
        } else {
          const existingAttempt = unitAttemptFromRow(row);
          if (coordinationOwnerKey(existingAttempt.owner) !== coordinationOwnerKey(attempt.owner)) throw new CoordinationRuntimeError('invalid-state', 'legacy attempt disagrees with existing coordinator owner', [entityId]);
        }
      }
      const terminallyReleasedLeaseIds: string[] = [];
      for (const release of plan.terminal_releases) {
        const matches = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(release.owner.repo_id, release.owner.workstream_run).map(editLeaseFromRow).filter((lease) => coordinationOwnerKey(lease.owner) === coordinationOwnerKey(release.owner) && lease.path === release.path && lease.mode === release.mode);
        for (const lease of matches) this.#releaseOwnedLease(release.owner.repo_id, release.owner.workstream_run, lease.edit_lease_id, terminallyReleasedLeaseIds);
      }
      const existingLeases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? ORDER BY entity_id').all(plan.repository.repo_id).map(editLeaseFromRow);
      for (const group of plan.acquisition_groups) {
        const existingRunRow = this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').get(group.owner.repo_id, group.owner.workstream_run);
        const existingAttemptRow = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(unitAttemptEntityId(group.owner));
        if (existingRunRow === undefined || existingAttemptRow === undefined) throw new CoordinationRuntimeError('invalid-state', 'migration authority owner disappeared during transactional reconciliation', [group.owner.workstream_run, group.owner.unit_id]);
        const groupLeases = plan.edit_leases.filter((lease) => lease.acquisition_group_id === group.acquisition_group_id);
        const uncovered = groupLeases.filter((lease) => !existingLeases.some((candidate) => coordinationOwnerKey(candidate.owner) === coordinationOwnerKey(lease.owner) && candidate.path === lease.path && candidate.mode === lease.mode));
        equivalentLeaseCount += groupLeases.length - uncovered.length;
        if (uncovered.length === 0) continue;
        const adjusted = parseCoordinationAcquisitionGroup({ ...group, requested_leases: uncovered.map((lease) => ({ path: lease.path, mode: lease.mode, purpose: lease.purpose })), created_event_seq: seq, fairness_event_seq: seq, grant_event_seq: seq });
        if (this.#db.prepare('SELECT entity_id FROM acquisition_groups WHERE entity_id=?').get(adjusted.acquisition_group_id) !== undefined) throw new CoordinationRuntimeError('invalid-state', 'migration acquisition group id collides with existing coordinator state', [adjusted.acquisition_group_id]);
        this.#db.prepare('INSERT INTO acquisition_groups(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(adjusted.acquisition_group_id, adjusted.owner.repo_id, adjusted.owner.workstream_run, canonicalJson(adjusted), adjusted.version);
        for (const lease of uncovered) {
          if (this.#db.prepare('SELECT entity_id FROM edit_leases WHERE entity_id=?').get(lease.edit_lease_id) !== undefined) throw new CoordinationRuntimeError('invalid-state', 'migration lease id collides with existing coordinator state', [lease.edit_lease_id]);
          this.#db.prepare('INSERT INTO edit_leases(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(lease.edit_lease_id, lease.owner.repo_id, lease.owner.workstream_run, canonicalJson({ ...lease, acquired_event_seq: seq }), lease.version);
          importedLeaseCount += 1;
        }
      }
      for (const evidence of plan.reconciliation_evidence) if (this.#db.prepare('SELECT entity_id FROM reconciliation_evidence WHERE entity_id=?').get(evidence.reconciliation_evidence_id) === undefined) this.#db.prepare('INSERT INTO reconciliation_evidence(entity_id, repo_id, workstream_run, source, target_id, payload_json, version) VALUES(?, ?, ?, ?, ?, ?, ?)').run(evidence.reconciliation_evidence_id, evidence.repo_id, evidence.workstream_run, evidence.source, evidence.release_condition.target_id, canonicalJson({ ...evidence, accepted_event_seq: seq }), evidence.version);
      for (const reservation of plan.change_reservations) {
        const reservationRun = this.#requireRun(reservation.repo_id, reservation.workstream_run);
        if (reservationRun.status === 'closed' || reservationRun.status === 'aborted') continue;
        const equivalent = this.#db.prepare("SELECT entity_id FROM change_reservations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.path')=?").get(reservation.repo_id, reservation.workstream_run, reservation.path);
        if (equivalent === undefined) {
          this.#db.prepare('INSERT INTO change_reservations(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(reservation.reservation_id, reservation.repo_id, reservation.workstream_run, canonicalJson({ ...reservation, created_event_seq: seq }), reservation.version);
          importedReservationCount += 1;
        }
      }
      for (const obligation of plan.reservation_obligations) if (this.#db.prepare('SELECT entity_id FROM reservation_obligations WHERE entity_id=?').get(obligation.obligation_id) === undefined && this.#db.prepare('SELECT entity_id FROM change_reservations WHERE entity_id=?').get(obligation.reservation_id) !== undefined && this.#db.prepare('SELECT entity_id FROM change_reservations WHERE entity_id=?').get(obligation.predecessor_reservation_id) !== undefined) this.#db.prepare('INSERT INTO reservation_obligations(entity_id, repo_id, workstream_run, reservation_id, predecessor_reservation_id, payload_json, version) VALUES(?, ?, ?, ?, ?, ?, ?)').run(obligation.obligation_id, obligation.repo_id, obligation.workstream_run, obligation.reservation_id, obligation.predecessor_reservation_id, canonicalJson({ ...obligation, created_event_seq: seq }), obligation.version);
      const incomingWorktreeGroups = new Map<string, CoordinationWorktree[]>();
      for (const worktree of plan.worktrees) incomingWorktreeGroups.set(worktreeOwnerKindKey(worktree), [...(incomingWorktreeGroups.get(worktreeOwnerKindKey(worktree)) ?? []), worktree]);
      for (const incoming of incomingWorktreeGroups.values()) {
        const first = incoming[0];
        if (first === undefined) continue;
        const incomingById = new Map<string, CoordinationWorktree>();
        for (const worktree of incoming) {
          const duplicate = incomingById.get(worktree.worktree_id);
          if (duplicate !== undefined && canonicalJson(duplicate) !== canonicalJson(worktree)) throw new CoordinationRuntimeError('invalid-state', 'legacy import repeats one worktree ID with contradictory payloads', [worktree.worktree_id]);
          incomingById.set(worktree.worktree_id, worktree);
        }
        const existingRows = this.#db.prepare('SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND autopilot_id=? AND unit_id=? AND attempt=? AND kind=? ORDER BY entity_id').all(first.owner.repo_id, first.owner.workstream_run, first.owner.autopilot_id, first.owner.unit_id, first.owner.attempt, first.kind);
        const existing = existingRows.map(worktreeFromRow);
        for (const worktree of incomingById.values()) {
          const sameId = existing.find((candidate) => candidate.worktree_id === worktree.worktree_id);
          if (sameId !== undefined && canonicalJson(sameId) !== canonicalJson(worktree)) throw new CoordinationRuntimeError('invalid-state', 'legacy worktree ID disagrees with existing immutable history', [worktree.worktree_id]);
        }
        const combined = [...existing, ...[...incomingById.values()].filter((candidate) => !existing.some((prior) => prior.worktree_id === candidate.worktree_id))];
        const canonicalId = deterministicWorktreeId(first.owner, first.kind);
        const existingCurrentId = existingRows.find((row) => sqlInteger(row, 'is_current_canonical') === 1)?.['entity_id'];
        const candidateIds = combined.map((candidate) => candidate.worktree_id).sort();
        const currentId = candidateIds.includes(canonicalId) ? canonicalId : typeof existingCurrentId === 'string' ? existingCurrentId : candidateIds[0];
        if (currentId === undefined) throw new CoordinationRuntimeError('store-corrupt', 'legacy worktree semantic group has no projection');
        this.#db.prepare('UPDATE worktrees SET is_current_canonical=0 WHERE repo_id=? AND workstream_run=? AND autopilot_id=? AND unit_id=? AND attempt=? AND kind=?').run(first.owner.repo_id, first.owner.workstream_run, first.owner.autopilot_id, first.owner.unit_id, first.owner.attempt, first.kind);
        for (const worktree of combined) {
          if (existing.some((candidate) => candidate.worktree_id === worktree.worktree_id)) continue;
          this.#db.prepare('INSERT INTO worktrees(entity_id, repo_id, workstream_run, payload_json, version, canonical_worktree_id, autopilot_id, unit_id, attempt, kind, is_current_canonical) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)').run(worktree.worktree_id, worktree.owner.repo_id, worktree.owner.workstream_run, canonicalJson(worktree), worktree.version, canonicalId, worktree.owner.autopilot_id, worktree.owner.unit_id, worktree.owner.attempt, worktree.kind);
          importedWorktreeCount += 1;
        }
        this.#db.prepare('UPDATE worktrees SET is_current_canonical=1 WHERE entity_id=?').run(currentId);
        const identityPending = candidateIds.length > 1;
        for (const worktree of combined) {
          if (worktree.worktree_id === canonicalId) continue;
          const priorAlias = this.#db.prepare('SELECT * FROM worktree_aliases WHERE alias_worktree_id=?').get(worktree.worktree_id);
          if (priorAlias !== undefined) {
            const alias = parseWorktreeAlias({ schema_version: AUTOPILOT_WORKTREE_ALIAS_SCHEMA, alias_worktree_id: sqlString(priorAlias, 'alias_worktree_id'), canonical_worktree_id: sqlString(priorAlias, 'canonical_worktree_id'), repo_id: sqlString(priorAlias, 'repo_id'), autopilot_id: sqlString(priorAlias, 'autopilot_id'), workstream_run: sqlString(priorAlias, 'workstream_run'), unit_id: sqlString(priorAlias, 'unit_id'), attempt: sqlInteger(priorAlias, 'attempt'), kind: sqlString(priorAlias, 'kind'), resolution_state: sqlString(priorAlias, 'resolution_state'), reason: sqlString(priorAlias, 'reason'), evidence_sha256: sqlString(priorAlias, 'evidence_sha256'), created_event_seq: sqlInteger(priorAlias, 'created_event_seq') });
            if (alias.canonical_worktree_id !== canonicalId || worktreeOwnerKindKey(worktree) !== `${alias.repo_id}\0${alias.autopilot_id}\0${alias.workstream_run}\0${alias.unit_id}\0${String(alias.attempt)}\0${alias.kind}`) throw new CoordinationRuntimeError('store-corrupt', 'existing worktree alias disagrees with imported semantic identity', [worktree.worktree_id]);
            continue;
          }
          this.#db.prepare('INSERT INTO worktree_aliases(alias_worktree_id,canonical_worktree_id,repo_id,autopilot_id,workstream_run,unit_id,attempt,kind,resolution_state,reason,evidence_sha256,created_event_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(worktree.worktree_id, canonicalId, worktree.owner.repo_id, worktree.owner.autopilot_id, worktree.owner.workstream_run, worktree.owner.unit_id, worktree.owner.attempt, worktree.kind, identityPending ? 'identity-recovery-pending' : 'resolved', identityPending ? 'duplicate-semantic-projection' : 'legacy-migration-id', plan.snapshot_sha256, seq);
        }
        if (identityPending) persistRunFaultAtEvent(this.#db, { invariant_id: 'F3-SEMANTIC-UNIQUENESS', repo_id: first.owner.repo_id, workstream_run: first.owner.workstream_run, entity_type: 'worktree', entity_id: canonicalId, fault_code: 'identity-recovery-pending', detail: { canonical_worktree_id: canonicalId, candidate_ids: candidateIds, current_projection_id: currentId, source: 'legacy-import-snapshot', source_snapshot_sha256: plan.snapshot_sha256, external_git_facts_required: true, destructive_authority: 'blocked' } }, seq);
      }
      for (const recovery of plan.recovery_work) {
        if (this.#db.prepare('SELECT repo_id FROM runs WHERE repo_id=? AND workstream_run=?').get(plan.repository.repo_id, recovery.workstream_run) === undefined) throw new CoordinationRuntimeError('invalid-state', 'migration recovery work owner is missing', [recovery.recovery_id]);
        if (this.#db.prepare('SELECT entity_id FROM migration_recovery_work WHERE entity_id=?').get(recovery.recovery_id) === undefined) {
          this.#db.prepare("INSERT INTO migration_recovery_work(entity_id, repo_id, workstream_run, recovery_type, payload_json, status, created_event_seq, version) VALUES(?, ?, ?, ?, ?, 'pending', ?, 1)").run(recovery.recovery_id, plan.repository.repo_id, recovery.workstream_run, recovery.recovery_type, canonicalJson(recovery.detail), seq);
          recoveryWorkCount += 1;
        }
        const messageId = `migration-message-${createHash('sha256').update(recovery.recovery_id, 'utf8').digest('hex').slice(0, 24)}`;
        if (this.#db.prepare('SELECT message_id FROM messages WHERE message_id=?').get(messageId) === undefined) this.#db.prepare("INSERT INTO messages(message_id, repo_id, recipient_workstream_run, message_type, correlation_id, payload_json, status, created_event_seq, delivered_event_seq, acknowledged_event_seq, version) VALUES(?, ?, ?, 'recovery-required', ?, ?, 'pending', ?, NULL, NULL, 1)").run(messageId, plan.repository.repo_id, recovery.workstream_run, recovery.recovery_id, canonicalJson({ recovery_id: recovery.recovery_id, recovery_type: recovery.recovery_type, detail: recovery.detail }), seq);
      }
      for (const audit of plan.legacy_audit) if (this.#db.prepare('SELECT entity_id FROM migration_legacy_audit WHERE entity_id=?').get(audit.audit_id) === undefined) {
        this.#db.prepare('INSERT INTO migration_legacy_audit(entity_id, repo_id, source_kind, payload_json, created_event_seq) VALUES(?, ?, ?, ?, ?)').run(audit.audit_id, plan.repository.repo_id, audit.source_kind, canonicalJson(audit.payload), seq);
        importedAuditCount += 1;
      }
      this.#migrateSchema9ReadLeasesToObservations(false);
      const exactReport = { ...plan.report, equivalent_lease_count: equivalentLeaseCount, imported_run_count: importedRunCount, imported_attempt_count: importedAttemptCount, imported_lease_count: importedLeaseCount, imported_reservation_count: importedReservationCount, imported_worktree_count: importedWorktreeCount, imported_audit_count: importedAuditCount, recovery_work_count: recoveryWorkCount };
      if (exactReport.classified_claim_count !== exactReport.legacy_claim_count || exactReport.equivalent_lease_count + exactReport.imported_lease_count + exactReport.terminal_leak_count !== exactReport.legacy_claim_count) throw new CoordinationRuntimeError('invalid-state', 'migration claim reconciliation did not classify every legacy authority claim', [canonicalJson(exactReport)]);
      this.#db.prepare("INSERT INTO coordination_migrations(repo_id, migration_id, snapshot_sha256, journal_path, state, report_json, imported_at, updated_at, version) VALUES(?, ?, ?, ?, 'imported', ?, ?, ?, 1)").run(plan.repository.repo_id, plan.migration_id, plan.snapshot_sha256, plan.journal_path, canonicalJson(exactReport), now, now);
      const invariantFindings = checkCoordinationInvariants(this.#snapshotForRepository(plan.repository.repo_id)).filter((finding) => finding.severity === 'error' && !migrationRecoveryCoversRetainedAuthority(this.#db, plan.repository.repo_id, finding));
      if (invariantFindings.length > 0) throw new CoordinationRuntimeError('invalid-state', 'transactional legacy import violates coordinator invariants; query byte-paged doctor for the exact finding set', [`finding_count=${String(invariantFindings.length)}`]);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    if (integrityResult(this.#db) !== 'ok') throw new CoordinationRuntimeError('store-corrupt', 'coordinator database failed integrity after transactional legacy import');
    const committedMigration = this.readMigrationImport(plan.repository.repo_id);
    if (committedMigration === null) throw new CoordinationRuntimeError('store-corrupt', 'committed migration report disappeared');
    return { committedEventSeq: seq, payload: { schema_version: 'autopilot.coordination_migration_import_result.v1', replayed: false, report: committedMigration.report } };
  }

  readMigrationImport(repoId: string): { readonly migration_id: string; readonly snapshot_sha256: `sha256:${string}`; readonly state: CoordinationMigrationRecordState; readonly report: Readonly<Record<string, unknown>> } | null {
    const row = this.#db.prepare('SELECT migration_id, snapshot_sha256, state, report_json FROM coordination_migrations WHERE repo_id=?').get(repoId);
    if (row === undefined) return null;
    const snapshot = sqlString(row, 'snapshot_sha256');
    if (!SHA256_PATTERN.test(snapshot)) throw new CoordinationRuntimeError('store-corrupt', 'migration record snapshot digest is invalid');
    const state = sqlString(row, 'state');
    if (!['imported', 'verified', 'cutover-ready', 'cutover-committed', 'legacy-archived'].includes(state)) throw new CoordinationRuntimeError('store-corrupt', 'migration record state is invalid');
    return { migration_id: sqlString(row, 'migration_id'), snapshot_sha256: snapshot as `sha256:${string}`, state: state as CoordinationMigrationRecordState, report: parseJsonObject(sqlString(row, 'report_json'), 'migration report') };
  }

  verifyMigrationImport(repoId: string, migrationId: string): { readonly invariant_findings: readonly CoordinationInvariantFinding[]; readonly integrity: string } {
    const migration = this.#db.prepare('SELECT migration_id FROM coordination_migrations WHERE repo_id=?').get(repoId);
    if (migration === undefined || sqlString(migration, 'migration_id') !== migrationId) throw new CoordinationRuntimeError('invalid-state', 'migration import record is missing or mismatched');
    const integrity = integrityResult(this.#db);
    const findings = checkCoordinationInvariants(this.#snapshotForRepository(repoId));
    const runCount = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM runs WHERE repo_id=? AND status NOT IN ('closed','aborted')").get(repoId), 'migration run count'), 'count');
    const resourceCount = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM run_resources WHERE repo_id=? AND workstream_run IN (SELECT workstream_run FROM runs WHERE repo_id=? AND status NOT IN ('closed','aborted'))").get(repoId, repoId), 'migration resource count'), 'count');
    if (runCount !== resourceCount) throw new CoordinationRuntimeError('invalid-state', 'migration verification requires exactly one immutable run resource per run', [`runs=${String(runCount)}`, `resources=${String(resourceCount)}`]);
    const errors = findings.filter((finding) => finding.severity === 'error' && !migrationRecoveryCoversRetainedAuthority(this.#db, repoId, finding));
    if (integrity !== 'ok' || errors.length > 0) throw new CoordinationRuntimeError('invalid-state', 'migration verification failed coordinator integrity or invariants; query byte-paged doctor for the exact finding set', [`integrity=${integrity}`, `finding_count=${String(errors.length)}`]);
    return { integrity, invariant_findings: findings };
  }

  databaseDigest(): `sha256:${string}` {
    this.#writerGuard.assertHeld();
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    if (integrityResult(this.#db) !== 'ok') throw new CoordinationRuntimeError('store-corrupt', 'database failed integrity before cutover digest');
    return `sha256:${createHash('sha256').update(readFileSync(this.#databasePath)).digest('hex')}`;
  }

  updateMigrationState(repoId: string, migrationId: string, state: CoordinationMigrationRecordState, report: { readonly schema_version: string }): void {
    this.#writerGuard.assertHeld();
    const row = this.#db.prepare('SELECT migration_id, version FROM coordination_migrations WHERE repo_id=?').get(repoId);
    if (row === undefined || sqlString(row, 'migration_id') !== migrationId) throw new CoordinationRuntimeError('invalid-state', 'migration import record is missing or mismatched');
    this.#db.prepare('UPDATE coordination_migrations SET state=?, report_json=?, updated_at=?, version=version+1 WHERE repo_id=? AND migration_id=?').run(state, canonicalJson(report), this.#clock.now().toISOString(), repoId, migrationId);
  }

  terminalRunsForS2RetentionGc(): readonly { readonly repoId: string; readonly workstreamRun: string }[] {
    this.#writerGuard.assertHeld();
    return Object.freeze(this.#db.prepare("SELECT repo_id, workstream_run FROM runs WHERE status IN ('closed','aborted') ORDER BY repo_id, workstream_run").all().map((row) => Object.freeze({ repoId: sqlString(row, 'repo_id'), workstreamRun: sqlString(row, 'workstream_run') })) );
  }

  sweepExpiredGrantOffers(): number {
    this.#writerGuard.assertHeld();
    if (activeCoordinationMigrationFreeze(this.#stateRoot) !== null) return 0;
    const now = this.#clock.now().toISOString();
    const repoRows = this.#db.prepare("SELECT DISTINCT repo_id FROM acquisition_groups WHERE json_extract(payload_json, '$.state')='grant-ready' AND json_extract(payload_json, '$.offer_expires_at')<=? ORDER BY repo_id").all(now);
    let expiredCount = 0;
    for (const repoRow of repoRows) {
      const repoId = sqlString(repoRow, 'repo_id');
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const seq = this.#nextEventSequence(repoId);
        const before = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state')='grant-ready' AND json_extract(payload_json, '$.offer_expires_at')<=?").get(repoId, now), 'expired offer count'), 'count');
        const groupsBefore = new Map(this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? ORDER BY entity_id').all(repoId).map(acquisitionGroupFromRow).map((group) => [group.acquisition_group_id, canonicalJson(group)]));
        if (!this.#expireGrantOffers(repoId, seq)) {
          this.#db.exec('ROLLBACK');
          continue;
        }
        this.#reevaluateWaitingGroups(repoId, seq);
        const changedGroups = this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? ORDER BY entity_id').all(repoId).map(acquisitionGroupFromRow).filter((group) => groupsBefore.get(group.acquisition_group_id) !== canonicalJson(group));
        const affectedWorkstreamRuns = [...new Set(changedGroups.map((group) => group.owner.workstream_run))].sort();
        if (changedGroups.length === 0 || affectedWorkstreamRuns.length === 0) throw new CoordinationRuntimeError('store-corrupt', 'grant-offer expiry sweep changed no durably owned acquisition group');
        const idempotencyKey = `grant-offer-expiry:${repoId}:${String(seq)}`;
        const resultPayload = Object.freeze({ affected_acquisition_group_ids: Object.freeze(changedGroups.map((group) => group.acquisition_group_id).sort()), affected_workstream_runs: Object.freeze(affectedWorkstreamRuns), event_type: 'grant-offers-expired', entity_type: 'repository', entity_id: repoId });
        if (encodedJsonBytes(resultPayload) > COORDINATOR_MAX_PAGE_ENTITY_BYTES) throw new CoordinationRuntimeError('frame-too-large', 'grant-offer expiry sweep immutable owner result exceeds the bounded entity ceiling');
        const digest = `sha256:${createHash('sha256').update(`${canonicalJson(resultPayload)}\n`, 'utf8').digest('hex')}`;
        this.#insertEvent.run(repoId, seq, 'grant-offers-expired', 'repository', repoId, idempotencyKey, digest, now);
        this.#insertIdempotencyResult.run(repoId, idempotencyKey, digest, seq, canonicalJson(resultPayload));
        this.#db.exec('COMMIT');
        expiredCount += before;
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    }
    return expiredCount;
  }

  replayLegacyRequest(request: Readonly<Record<string, unknown>>): CoordinatorResponseEnvelope {
    const requestId = request['request_id'];
    const repoId = request['repo_id'];
    const idempotencyKey = request['idempotency_key'];
    const action = request['action'];
    const payload = request['payload'];
    if (typeof requestId !== 'string' || typeof repoId !== 'string' || typeof idempotencyKey !== 'string' || typeof action !== 'string' || typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new CoordinationRuntimeError('invalid-request', 'legacy replay request identity is malformed');
    const runOwned = RUN_OWNED_IDEMPOTENCY_ACTIONS.has(action);
    const semanticPayload = Object.fromEntries(Object.entries(payload).filter(([field]) => field !== 'migration_operation_token' && (!runOwned || field !== 'session_lease_id' && field !== 'session_token')));
    const semantic = { schema_version: request['schema_version'], protocol_version: request['protocol_version'], action, repo_id: repoId, workstream_run: request['workstream_run'], session_id: runOwned ? null : request['session_id'], fencing_generation: runOwned ? null : request['fencing_generation'], expected_version: runOwned ? null : request['expected_version'], payload: semanticPayload };
    const digest = `sha256:${createHash('sha256').update(canonicalJson(semantic), 'utf8').digest('hex')}`;
    const prior = this.#db.prepare('SELECT request_sha256, committed_event_seq, payload_json FROM idempotency_results WHERE repo_id=? AND idempotency_key=?').get(repoId, idempotencyKey);
    if (prior === undefined || sqlString(prior, 'request_sha256') !== digest) throw new CoordinationRuntimeError('idempotency-conflict', 'legacy request has no exact pre-migration idempotency result');
    return { schema_version: 'autopilot.coordinator_response.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: requestId, ok: true, committed_event_seq: sqlInteger(prior, 'committed_event_seq'), error_code: null, retryable: false, payload: parseJsonObject(sqlString(prior, 'payload_json'), 'legacy idempotency result') };
  }

  handle(request: CoordinatorRequestEnvelope, facade: 'negotiated-s1' | 'cf50-legacy' = 'negotiated-s1'): CoordinatorResponseEnvelope {
    try {
      this.#writerGuard.assertHeld();
      const effect = facade === 'cf50-legacy' && request.action === 'status'
        ? this.legacyStatusPage(request)
        : facade === 'cf50-legacy' && request.action === 'doctor'
          ? this.legacyDoctorPage(request)
          : facade === 'cf50-legacy' && request.action === 'export'
            ? this.exportTo(payloadString(request.payload, 'output_path'), false)
            : this.#dispatch(request);
      const response: CoordinatorResponseEnvelope = {
        schema_version: 'autopilot.coordinator_response.v1',
        protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
        request_id: request.request_id,
        ok: true,
        committed_event_seq: effect.committedEventSeq,
        error_code: null,
        retryable: false,
        payload: effect.payload,
      };
      this.#assertResponseFitsFrame(response, request.action);
      return response;
    } catch (error) {
      const runtime = error instanceof CoordinationRuntimeError ? error : sqliteFailure(error);
      return {
        schema_version: 'autopilot.coordinator_response.v1',
        protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
        request_id: request.request_id,
        ok: false,
        committed_event_seq: null,
        error_code: runtime.code,
        retryable: isS2FailureResponseRetryable(runtime.code),
        payload: { message: runtime.message, evidence: runtime.evidence, s2_diagnostic: buildS2CoordinationRuntimeErrorDiagnostic(runtime) },
      };
    }
  }

  #snapshotForRepository(repoId: string): CoordinationSnapshot {
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
      observations: this.#db.prepare('SELECT * FROM observations WHERE repo_id=? ORDER BY entity_id').all(repoId).map(observationFromRow),
      edit_leases: this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? ORDER BY entity_id').all(repoId).map(editLeaseFromRow),
      change_reservations: this.#db.prepare('SELECT * FROM change_reservations WHERE repo_id=? ORDER BY entity_id').all(repoId).map(changeReservationFromRow),
      reservation_obligations: this.#db.prepare('SELECT * FROM reservation_obligations WHERE repo_id=? ORDER BY entity_id').all(repoId).map(reservationObligationFromRow),
      run_terminal_intents: this.#db.prepare('SELECT * FROM run_terminal_intents WHERE repo_id=? ORDER BY entity_id').all(repoId).map(runTerminalIntentFromRow),
      claim_requests: this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? ORDER BY entity_id').all(repoId).map(claimRequestFromRow),
      mailbox_cursors: this.#db.prepare('SELECT * FROM mailbox_cursors WHERE repo_id=? ORDER BY workstream_run').all(repoId).map(mailboxCursorFromRow),
      reconciliation_evidence: this.#db.prepare('SELECT * FROM reconciliation_evidence WHERE repo_id=? ORDER BY entity_id').all(repoId).map(reconciliationEvidenceFromRow),
      migration_recovery_work: this.#db.prepare('SELECT * FROM migration_recovery_work WHERE repo_id=? ORDER BY entity_id').all(repoId).map(migrationRecoveryFromRow),
      messages: this.#db.prepare('SELECT * FROM messages WHERE repo_id=? ORDER BY created_event_seq, message_id').all(repoId).map(messageFromRow),
      worktrees: this.#db.prepare('SELECT * FROM worktrees WHERE repo_id=? AND is_current_canonical=1 ORDER BY canonical_worktree_id').all(repoId).map(canonicalWorktreeFromRow),
      worktree_operations: this.#db.prepare('SELECT * FROM worktree_operations WHERE repo_id=? AND canonical_worktree_id IS NOT NULL ORDER BY canonical_worktree_id,entity_id').all(repoId).map(canonicalWorktreeOperationFromRow),
      wait_for_edges: this.#db.prepare('SELECT * FROM wait_for_edges WHERE repo_id=? ORDER BY entity_id').all(repoId).map(waitForEdgeFromRow),
      deadlock_resolutions: this.#db.prepare('SELECT * FROM deadlock_resolutions WHERE repo_id=? ORDER BY entity_id').all(repoId).map(deadlockResolutionFromRow),
      authoritative_artifacts: this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? ORDER BY entity_id').all(repoId).map(authoritativeArtifactFromRow),
      adjudication_assignments: this.#db.prepare('SELECT * FROM adjudication_assignments WHERE repo_id=? ORDER BY entity_id').all(repoId).map(adjudicationAssignmentFromRow),
      escalations: this.#db.prepare('SELECT * FROM escalations WHERE repo_id=? ORDER BY entity_id').all(repoId).map(escalationFromRow),
      events: this.#db.prepare('SELECT * FROM events WHERE repo_id=? ORDER BY event_seq').all(repoId).map(eventFromRow),
    };
  }

  #dispatch(request: CoordinatorRequestEnvelope): StoreEffect {
    const queryActions = new Set(['handshake', 'status', 'doctor', 'export', 'migration-recovery', 'run-catalog', 'reconciliation-details', 'result-details']);
    if (!queryActions.has(request.action)) {
      if (request.action === 'attach-migration-recovery') assertCoordinationMigrationRecoveryOperationAuthorized(this.#stateRoot, request.payload['migration_operation_token']);
      if (activeCoordinationMigrationFreeze(this.#stateRoot) !== null) assertCoordinationFrozenMutationAllowed(this.#stateRoot, request.repo_id, request.action, request.payload['migration_operation_token']);
      else assertCoordinationDispatchAllowed(this.#stateRoot, request.repo_id, `coordinator mutation ${request.action}`);
    }
    switch (request.action) {
      case 'handshake': return this.handshake();
      case 'status': return this.statusPage(request);
      case 'doctor': return this.doctorPage(request);
      case 'export': return this.exportTo(payloadString(request.payload, 'output_path'), true);
      case 'migration-recovery': return this.migrationRecovery(request);
      case 'run-catalog': return this.runCatalog(request.repo_id, request.workstream_run, request.payload);
      case 'reconciliation-details': return this.reconciliationDetails(request);
      case 'result-details': return this.resultDetails(request);
      case 'attach-run': return this.attachRun(request);
      case 'attach-session': return this.attachSession(request);
      case 'attach-terminal-recovery': return this.attachTerminalRecovery(request);
      case 'attach-migration-recovery': return this.attachMigrationRecovery(request);
      case 'resolve-migration-recovery': return this.resolveMigrationRecovery(request);
      case 'detach-session': return this.detachSession(request);
      case 'prepare-handoff': return this.prepareHandoff(request);
      case 'heartbeat': return this.heartbeatSession(request);
      case 'accept-program-heartbeat': return this.acceptProgramHeartbeat(request);
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
      case 'resolve-run-scoped-fault': return this.resolveRunScopedFault(request);
      case 'register-authoritative-artifact': return this.registerAuthoritativeArtifact(request);
      case 'assign-adjudication': return this.assignAdjudication(request);
      case 'claim-adjudication-assignment': return this.claimAdjudicationAssignment(request);
      case 'complete-adjudication': return this.completeAdjudication(request);
      case 'submit-planning-contradiction': return this.submitPlanningContradiction(request);
    }
  }

  handshake(): StoreEffect {
    return { committedEventSeq: null, payload: { schema_version: 'autopilot.coordinator_handshake.v1', package_build: COORDINATOR_PACKAGE_BUILD, protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION } };
  }

  statusPage(request: CoordinatorRequestEnvelope): StoreEffect {
    if (request.payload['dispatch_authority_context'] !== undefined) {
      if (request.workstream_run === null || request.payload['scan_token'] !== undefined || request.payload['section'] !== undefined || request.payload['cursor'] !== undefined) throw new CoordinationRuntimeError('invalid-request', 'D65 dispatch authority status request must be one unpaginated run-scoped envelope');
      const context = parseD65DispatchAuthorityRequestContext(request.payload['dispatch_authority_context']);
      const frame = this.readD65DispatchAuthorityFrame(request.repo_id, request.workstream_run, context);
      return { committedEventSeq: null, payload: Object.freeze({ schema_version: D65_DISPATCH_AUTHORITY_ENVELOPE_SCHEMA, dispatch_authority_frame: frame }) };
    }
    const complete = request.payload['scan_token'] === undefined ? this.#d65NegotiatedQuerySnapshot('status', request.repo_id, request.workstream_run) : null;
    return this.#projectionPage('status', request, complete, STATUS_SECTIONS, null, 'negotiated-s1');
  }

  legacyStatusPage(request: CoordinatorRequestEnvelope): StoreEffect {
    const complete = request.payload['scan_token'] === undefined ? this.#legacyProjection(this.status(request.repo_id, request.workstream_run).payload, 'worktree_operations') : null;
    return this.#projectionPage('status', request, complete, STATUS_SECTIONS, null, 'cf50-legacy');
  }

  doctorPage(request: CoordinatorRequestEnvelope): StoreEffect {
    const complete = request.payload['scan_token'] === undefined ? this.#d65NegotiatedQuerySnapshot('doctor', request.repo_id, request.workstream_run) : null;
    const observedAt = complete === null ? null : complete['observed_at'];
    if (observedAt !== null && typeof observedAt !== 'string') throw new CoordinationRuntimeError('store-corrupt', 'negotiated doctor snapshot omitted its query observed_at');
    return this.#projectionPage('doctor', request, complete, DOCTOR_SECTIONS, observedAt, 'negotiated-s1');
  }

  legacyDoctorPage(request: CoordinatorRequestEnvelope): StoreEffect {
    const observedAt = request.payload['scan_token'] === undefined ? this.#clock.now().toISOString() : null;
    const complete = observedAt === null ? null : this.#legacyProjection(this.doctor(new Date(observedAt)).payload, 'incomplete_worktree_operations');
    return this.#projectionPage('doctor', request, complete, DOCTOR_SECTIONS, observedAt, 'cf50-legacy');
  }

  #d65RepositoryLivenessHistory(repoId: string, coveredEventSeq: number): readonly D65AcceptedEventResultJoin[] {
    const rows = this.#db.prepare("SELECT e.repo_id,e.event_seq,e.event_type,e.entity_type,e.entity_id,e.idempotency_key,e.request_sha256,r.repo_id AS result_repo_id,r.idempotency_key AS result_idempotency_key,r.request_sha256 AS result_request_sha256,r.committed_event_seq AS result_event_seq,r.payload_json AS result_payload_json FROM events e LEFT JOIN idempotency_results r ON r.repo_id=e.repo_id AND r.idempotency_key=e.idempotency_key WHERE e.repo_id=? AND e.event_seq<=? AND e.event_type IN ('session-heartbeat','child-heartbeat','program-heartbeat-accepted') ORDER BY e.event_seq").all(repoId, coveredEventSeq);
    return Object.freeze(rows.map((raw) => {
      const row = asRow(raw, 'D65 repository liveness history');
      const resultPayload = sqlNullableString(row, 'result_payload_json');
      const result = resultPayload === null ? null : Object.freeze({ repo_id: sqlString(row, 'result_repo_id'), idempotency_key: sqlString(row, 'result_idempotency_key'), request_sha256: sqlString(row, 'result_request_sha256'), committed_event_seq: sqlInteger(row, 'result_event_seq'), payload: parseJsonObject(resultPayload, 'D65 repository liveness result') });
      return Object.freeze({ repo_id: sqlString(row, 'repo_id'), event_seq: sqlInteger(row, 'event_seq'), event_type: sqlString(row, 'event_type'), entity_type: sqlString(row, 'entity_type'), entity_id: sqlString(row, 'entity_id'), idempotency_key: sqlString(row, 'idempotency_key'), request_sha256: sqlString(row, 'request_sha256'), result });
    }));
  }

  #d65SemanticStatusRows(complete: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const sessionsValue = complete['session_leases'];
    const childrenValue = complete['child_leases'];
    if (!Array.isArray(sessionsValue) || !Array.isArray(childrenValue)) throw new CoordinationRuntimeError('store-corrupt', 'status semantic projection lacks session/child arrays');
    const countCache = new Map<string, ReturnType<typeof computeD65SemanticVersionCounts>>();
    const countsFor = (repoId: string): ReturnType<typeof computeD65SemanticVersionCounts> => {
      const cached = countCache.get(repoId);
      if (cached !== undefined) return cached;
      const repository = this.#db.prepare('SELECT event_seq FROM repositories WHERE repo_id=?').get(repoId);
      if (repository === undefined) throw new CoordinationRuntimeError('store-corrupt', 'semantic status row names a missing repository', [repoId]);
      const covered = sqlInteger(repository, 'event_seq');
      const counts = computeD65SemanticVersionCounts(this.#d65RepositoryLivenessHistory(repoId, covered), covered);
      countCache.set(repoId, counts);
      return counts;
    };
    const sessions = sessionsValue.map((value) => {
      const session = parseCoordinationSessionLease(value);
      return projectD65SessionLease(session, countsFor(session.repo_id).sessionPureLeaseEvents.get(session.session_lease_id) ?? 0);
    });
    const children = childrenValue.map((value) => {
      const child = parseCoordinationChildLease(value);
      return projectD65ChildLease(child, countsFor(child.owner.repo_id).childPureLeaseEvents.get(child.child_lease_id) ?? 0);
    });
    return Object.freeze({ ...complete, session_leases: Object.freeze(sessions), child_leases: Object.freeze(children) });
  }

  #d65SemanticLeaseExpiry(kind: 'session' | 'child', repoId: string, entityId: string): string {
    const entityType = kind === 'session' ? 'session-lease' : 'child-lease';
    const rows = this.#db.prepare('SELECT e.*,r.payload_json AS result_payload,r.repo_id AS result_repo_id,r.idempotency_key AS result_key,r.request_sha256 AS result_request,r.committed_event_seq AS result_seq FROM events e LEFT JOIN idempotency_results r ON r.repo_id=e.repo_id AND r.idempotency_key=e.idempotency_key WHERE e.repo_id=? AND e.entity_type=? AND e.entity_id=? ORDER BY e.event_seq DESC').all(repoId, entityType, entityId);
    for (const raw of rows) {
      const row = asRow(raw, 'D65 semantic lease event');
      const payloadText = sqlNullableString(row, 'result_payload');
      if (payloadText === null) throw new CoordinationRuntimeError('store-corrupt', 'semantic lease event lacks exact result payload', [entityId]);
      const payload = parseJsonObject(payloadText, 'D65 semantic lease result');
      const joined: D65AcceptedEventResultJoin = { repo_id: repoId, event_seq: sqlInteger(row, 'event_seq'), event_type: sqlString(row, 'event_type'), entity_type: sqlString(row, 'entity_type'), entity_id: entityId, idempotency_key: sqlString(row, 'idempotency_key'), request_sha256: sqlString(row, 'request_sha256'), result: { repo_id: sqlString(row, 'result_repo_id'), idempotency_key: sqlString(row, 'result_key'), request_sha256: sqlString(row, 'result_request'), committed_event_seq: sqlInteger(row, 'result_seq'), payload } };
      if (kind === 'session' && joined.event_type === 'session-heartbeat' && isPureD65SessionHeartbeat(joined)) continue;
      if (kind === 'child' && joined.event_type === 'child-heartbeat' && isPureD65ChildHeartbeat(joined)) continue;
      const value = payload[kind];
      if (value === undefined) continue;
      return kind === 'session' ? parseCoordinationSessionLease(value).lease_expires_at : parseCoordinationChildLease(value).lease_expires_at;
    }
    throw new CoordinationRuntimeError('store-corrupt', `D65 ${kind} lease has no semantic creation/status result`, [entityId]);
  }

  #d65SemanticDoctorRows(complete: Readonly<Record<string, unknown>>, coordinatorTime: string): Readonly<Record<string, unknown>> {
    const sessions = this.#db.prepare("SELECT * FROM session_leases WHERE status IN ('attached','handoff-pending') ORDER BY repo_id,workstream_run,session_generation").all().map(sessionFromRow).flatMap((session) => {
      const expiry = this.#d65SemanticLeaseExpiry('session', session.repo_id, session.session_lease_id);
      return Date.parse(expiry) < Date.parse(coordinatorTime) ? [{ session_lease_id: session.session_lease_id, repo_id: session.repo_id, workstream_run: session.workstream_run, status: session.status, lease_expires_at: expiry, classification: 'heartbeat-expired-recovery-check', write_authority_released: false }] : [];
    });
    const children = this.#db.prepare("SELECT * FROM child_leases WHERE status='running' ORDER BY repo_id,workstream_run,child_lease_id").all().map(childFromRow).flatMap((child) => {
      const expiry = this.#d65SemanticLeaseExpiry('child', child.owner.repo_id, child.child_lease_id);
      return Date.parse(expiry) < Date.parse(coordinatorTime) ? [{ child_lease_id: child.child_lease_id, repo_id: child.owner.repo_id, workstream_run: child.owner.workstream_run, lease_expires_at: expiry, classification: 'heartbeat-expired-recovery-check', write_authority_released: false }] : [];
    });
    return Object.freeze({ ...complete, expired_session_classifications: Object.freeze(sessions), expired_child_classifications: Object.freeze(children) });
  }

  /** One read transaction; sample coordinator time after BEGIN and before rows. */
  #d65NegotiatedQuerySnapshot(kind: 'status' | 'doctor', repoId: string, workstreamRun: string | null): Readonly<Record<string, unknown>> {
    this.#db.exec('BEGIN');
    try {
      const coordinatorTime = this.#clock.now().toISOString();
      const additions = {
        negotiated_coordinator_identity: this.negotiatedIdentityObservability(),
        run_scoped_logical_faults: this.negotiatedRunScopedFaults(repoId, workstreamRun),
        negotiated_worktree_aliases: this.negotiatedWorktreeAliases(repoId, workstreamRun),
        negotiated_identity_recovery: this.negotiatedIdentityRecovery(repoId, workstreamRun),
      };
      const raw = kind === 'status' ? this.status(repoId, workstreamRun).payload : this.doctor(new Date(coordinatorTime)).payload;
      // Endpoint output retains its complete existing row bytes. Only the digest
      // input substitutes semantic session/child projections; this avoids a
      // negotiated payload shape change while making pure lease renewals stable.
      const semantic = kind === 'status' ? this.#d65SemanticStatusRows(raw) : this.#d65SemanticDoctorRows(raw, coordinatorTime);
      const accepted = workstreamRun === null ? null : this.#highestAcceptedProgramHeartbeat(repoId, workstreamRun);
      const semanticBeforeDigest = Object.freeze({ ...semantic, ...additions, coordinator_time: coordinatorTime, accepted_program_heartbeat: accepted, semantic_snapshot_sha256: null });
      const digest = computeD65SemanticSnapshotSha256(kind, semanticBeforeDigest);
      const complete = Object.freeze({ ...raw, ...additions, coordinator_time: coordinatorTime, accepted_program_heartbeat: accepted, semantic_snapshot_sha256: digest });
      this.#db.exec('COMMIT');
      return complete;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #legacyProjection(complete: Readonly<Record<string, unknown>>, operationSection: 'worktree_operations' | 'incomplete_worktree_operations'): Readonly<Record<string, unknown>> {
    const operations = complete[operationSection];
    if (!Array.isArray(operations)) throw new CoordinationRuntimeError('store-corrupt', `legacy façade projection lacks ${operationSection}`);
    const ordinary = operations.filter((entry) => parseCoordinationWorktreeOperation(entry).operation_type !== 'metadata-reconcile');
    return Object.freeze({ ...complete, [operationSection]: Object.freeze(ordinary) });
  }

  #projectionPage(kind: 'status' | 'doctor', request: CoordinatorRequestEnvelope, initialComplete: Readonly<Record<string, unknown>> | null, sections: readonly string[], initialSnapshot: string | null, facade: 'negotiated-s1' | 'cf50-legacy'): StoreEffect {
    const sectionValue = request.payload['section'];
    const section = sectionValue === undefined ? 'summary' : typeof sectionValue === 'string' ? sectionValue : (() => { throw new CoordinationRuntimeError('invalid-request', `${kind} section must be bounded text`); })();
    if (section !== 'summary' && !sections.includes(section)) throw new CoordinationRuntimeError('invalid-request', `${kind} section is unsupported`, [section]);
    const scopeSha256 = paginationScope([kind, facade, request.repo_id, request.workstream_run]);
    const suppliedScan = request.payload['scan_token'];
    const now = Date.now();
    for (const [token, scan] of this.#projectionScans) if (now - scan.created_at_ms > COORDINATOR_PROJECTION_SCAN_TTL_MS) this.#projectionScans.delete(token);
    let scanToken: string;
    let scan: ProjectionScan;
    if (suppliedScan === undefined) {
      if (section !== 'summary' || initialComplete === null) throw new CoordinationRuntimeError('invalid-request', `${kind} scan must begin with its summary page`);
      if (this.#projectionScans.size >= COORDINATOR_MAX_ACTIVE_PROJECTION_SCANS) {
        for (const [token, candidate] of this.#projectionScans) {
          if (candidate.completed_at_ms !== null) this.#projectionScans.delete(token);
          if (this.#projectionScans.size < COORDINATOR_MAX_ACTIVE_PROJECTION_SCANS) break;
        }
      }
      if (this.#projectionScans.size >= COORDINATOR_MAX_ACTIVE_PROJECTION_SCANS) throw new CoordinationRuntimeError('coordinator-contention', `${kind} snapshot capacity is temporarily exhausted; retry after an active scan completes or expires`);
      scanToken = `scan-${randomBytes(32).toString('hex')}`;
      scan = { kind, scope_sha256: scopeSha256, revision_sha256: paginationRevision(initialComplete), snapshot: initialSnapshot, complete: initialComplete, created_at_ms: now, completed_sections: new Set<string>(), completed_at_ms: null };
      this.#projectionScans.set(scanToken, scan);
    } else {
      if (section === 'summary' || typeof suppliedScan !== 'string') throw new CoordinationRuntimeError('invalid-request', `${kind} detail page requires its opaque scan token`);
      const found = this.#projectionScans.get(suppliedScan);
      if (found === undefined) throw new CoordinationRuntimeError('stale-version', `${kind} snapshot expired or belongs to a retired coordinator process`);
      if (found.kind !== kind || found.scope_sha256 !== scopeSha256) throw new CoordinationRuntimeError('unauthorized-client', `${kind} snapshot belongs to a different query scope`);
      scanToken = suppliedScan;
      scan = found;
    }
    const complete = scan.complete;
    const counts: Record<string, number> = {};
    for (const name of sections) {
      const values = complete[name];
      if (!Array.isArray(values)) throw new CoordinationRuntimeError('store-corrupt', `${kind} projection section ${name} is not an array`);
      counts[name] = values.length;
    }
    const projection: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(complete)) if (!sections.includes(field)) projection[field] = value;
    const baseFor = (value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({ schema_version: `autopilot.coordinator_${kind}_page.v1`, projection_schema_version: complete['schema_version'], section, scan_token: scanToken, observed_at: scan.snapshot, section_counts: counts, projection: value });
    if (section === 'summary') {
      for (const name of sections) {
        const values = complete[name];
        if (!Array.isArray(values) || values.length > 1_024 || values.some((value) => encodedJsonBytes(value) > COORDINATOR_MAX_PAGE_ENTITY_BYTES)) continue;
        const candidate = { ...projection, [name]: values };
        if (encodedJsonBytes({ ...baseFor(candidate), items: [], next_cursor: null }) > COORDINATOR_PAGE_TARGET_BYTES) continue;
        projection[name] = values;
        scan.completed_sections.add(name);
      }
      if (scan.completed_sections.size === sections.length) scan.completed_at_ms = now;
      return { committedEventSeq: null, payload: { ...baseFor(projection), items: [], next_cursor: null } };
    }
    const base = baseFor(projection);
    const values = complete[section];
    if (!Array.isArray(values)) throw new CoordinationRuntimeError('store-corrupt', `${kind} projection section ${section} disappeared`);
    const cursorValue = request.payload['cursor'];
    const offset = cursorValue === undefined ? 0 : typeof cursorValue === 'string'
      ? parsePaginationCursor(cursorValue, { kind: `${kind}-page`, scopeSha256, revisionSha256: scan.revision_sha256, section, snapshot: scanToken })
      : (() => { throw new CoordinationRuntimeError('invalid-request', `${kind} cursor must be bounded opaque text`); })();
    const cursorForOffset = (nextOffset: number): string => encodePaginationCursor({ kind: `${kind}-page`, scopeSha256, revisionSha256: scan.revision_sha256, section, snapshot: scanToken, offset: nextOffset });
    const payloadForPage = (items: readonly unknown[], nextCursor: string | null): Readonly<Record<string, unknown>> => ({ ...base, items, next_cursor: nextCursor });
    const page = byteBudgetPage({ items: values, offset, cursorForOffset, payloadForPage });
    if (page.nextCursor === null) {
      scan.completed_sections.add(section);
      if (scan.completed_sections.size === sections.length) scan.completed_at_ms = now;
    }
    return { committedEventSeq: null, payload: payloadForPage(page.items, page.nextCursor) };
  }

  status(repoId: string, workstreamRun: string | null): StoreEffect {
    const repositories = repoId === 'global'
      ? this.#db.prepare('SELECT * FROM repositories ORDER BY repo_id').all().map(repositoryFromRow)
      : this.#db.prepare('SELECT * FROM repositories WHERE repo_id=? ORDER BY repo_id').all(repoId).map(repositoryFromRow);
    const runs = workstreamRun === null
      ? (repoId === 'global' ? this.#db.prepare('SELECT * FROM runs ORDER BY repo_id, workstream_run').all() : this.#db.prepare('SELECT * FROM runs WHERE repo_id=? ORDER BY workstream_run').all(repoId)).map(runFromRow)
      : this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').all(repoId, workstreamRun).map(runFromRow);
    const runScopedFaults = workstreamRun === null
      ? (repoId === 'global' ? this.#db.prepare("SELECT * FROM run_scoped_faults WHERE status='active' ORDER BY repo_id,workstream_run,fault_id").all() : this.#db.prepare("SELECT * FROM run_scoped_faults WHERE repo_id=? AND status='active' ORDER BY workstream_run,fault_id").all(repoId)).map(runScopedFaultFromRow)
      : this.#db.prepare("SELECT * FROM run_scoped_faults WHERE repo_id=? AND workstream_run=? AND status='active' ORDER BY fault_id").all(repoId, workstreamRun).map(runScopedFaultFromRow);
    const statusDetailRun = workstreamRun !== null && !runScopedFaults.some((fault) => fault.invariant_id === 'F4-PAYLOAD-INDEX-AMBIGUITY');
    const runResources = workstreamRun === null
      ? (repoId === 'global'
        ? this.#db.prepare("SELECT * FROM run_resources WHERE NOT EXISTS(SELECT 1 FROM run_scoped_faults faults WHERE faults.repo_id=run_resources.repo_id AND faults.workstream_run=run_resources.workstream_run AND faults.status='active') ORDER BY repo_id,workstream_run").all()
        : this.#db.prepare("SELECT * FROM run_resources WHERE repo_id=? AND NOT EXISTS(SELECT 1 FROM run_scoped_faults faults WHERE faults.repo_id=run_resources.repo_id AND faults.workstream_run=run_resources.workstream_run AND faults.status='active') ORDER BY workstream_run").all(repoId)).map(runResourceFromRow)
      : statusDetailRun ? this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').all(repoId, workstreamRun).map(runResourceFromRow) : [];
    const sessions = workstreamRun === null
      ? (repoId === 'global' ? this.#db.prepare('SELECT * FROM session_leases ORDER BY repo_id, workstream_run, session_generation').all() : this.#db.prepare('SELECT * FROM session_leases WHERE repo_id=? ORDER BY workstream_run, session_generation').all(repoId)).map(sessionFromRow)
      : this.#db.prepare('SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? ORDER BY session_generation').all(repoId, workstreamRun).map(sessionFromRow);
    const children = workstreamRun === null
      ? (repoId === 'global' ? this.#db.prepare('SELECT * FROM child_leases ORDER BY repo_id, workstream_run, unit_id, attempt').all() : this.#db.prepare('SELECT * FROM child_leases WHERE repo_id=? ORDER BY workstream_run, unit_id, attempt').all(repoId)).map(childFromRow)
      : this.#db.prepare('SELECT * FROM child_leases WHERE repo_id=? AND workstream_run=? ORDER BY unit_id, attempt').all(repoId, workstreamRun).map(childFromRow);
    const pendingMessages = workstreamRun === null ? 0 : sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM messages WHERE repo_id=? AND recipient_workstream_run=? AND status!='acknowledged'").get(repoId, workstreamRun), 'message count'), 'count');
    const unitAttempts = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM unit_attempts WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(unitAttemptFromRow);
    const acquisitionGroups = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(acquisitionGroupFromRow);
    const observations = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM observations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(observationFromRow);
    const editLeases = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(editLeaseFromRow);
    const reservationObligations = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM reservation_obligations WHERE repo_id=? AND (workstream_run=? OR predecessor_reservation_id IN (SELECT entity_id FROM change_reservations WHERE repo_id=? AND workstream_run=?)) ORDER BY entity_id').all(repoId, workstreamRun, repoId, workstreamRun).map(reservationObligationFromRow);
    const relevantReservationIds = new Set(reservationObligations.flatMap((obligation) => [obligation.reservation_id, obligation.predecessor_reservation_id]));
    const changeReservations = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM change_reservations WHERE repo_id=? ORDER BY entity_id').all(repoId).map(changeReservationFromRow).filter((reservation) => reservation.workstream_run === workstreamRun || relevantReservationIds.has(reservation.reservation_id));
    const runTerminalIntents = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM run_terminal_intents WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(runTerminalIntentFromRow);
    const claimRequests = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? AND (requester_workstream_run=? OR owner_workstream_run=?) ORDER BY entity_id').all(repoId, workstreamRun, workstreamRun).map(claimRequestFromRow);
    const mailboxCursors = workstreamRun === null
      ? (repoId === 'global' ? this.#db.prepare('SELECT * FROM mailbox_cursors ORDER BY repo_id, workstream_run').all() : this.#db.prepare('SELECT * FROM mailbox_cursors WHERE repo_id=? ORDER BY workstream_run').all(repoId)).map(mailboxCursorFromRow)
      : this.#db.prepare('SELECT * FROM mailbox_cursors WHERE repo_id=? AND workstream_run=?').all(repoId, workstreamRun).map(mailboxCursorFromRow);
    const reconciliationEvidence = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM reconciliation_evidence WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(reconciliationEvidenceFromRow);
    const reconciliationReceipts = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM reconciliation_receipts WHERE repo_id=? AND workstream_run=? ORDER BY committed_event_seq, entity_id').all(repoId, workstreamRun).map(reconciliationReceiptFromRow);
    const mailboxDeliveries = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM mailbox_deliveries WHERE repo_id=? AND workstream_run=? ORDER BY delivery_id').all(repoId, workstreamRun).map(mailboxDeliveryFromRow);
    const resultReceipts = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM result_receipts WHERE repo_id=? AND workstream_run=? ORDER BY committed_event_seq, entity_id').all(repoId, workstreamRun).map(resultReceiptFromRow);
    const worktrees = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND is_current_canonical=1 ORDER BY canonical_worktree_id').all(repoId, workstreamRun).map(canonicalWorktreeFromRow);
    const worktreeOperations = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND canonical_worktree_id IS NOT NULL ORDER BY canonical_worktree_id,entity_id').all(repoId, workstreamRun).map(canonicalWorktreeOperationFromRow);
    const waitForEdges = !statusDetailRun ? [] : this.#db.prepare("SELECT * FROM wait_for_edges WHERE repo_id=? AND (json_extract(payload_json, '$.requester.workstream_run')=? OR json_extract(payload_json, '$.blocker.workstream_run')=?) ORDER BY entity_id").all(repoId, workstreamRun, workstreamRun).map(waitForEdgeFromRow);
    const relevantEdgeIds = new Set(waitForEdges.map((edge) => edge.edge_id));
    const deadlockResolutions = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM deadlock_resolutions WHERE repo_id=? ORDER BY entity_id').all(repoId).map(deadlockResolutionFromRow).filter((resolution) => resolution.cycle_edge_ids.some((edgeId) => relevantEdgeIds.has(edgeId)));
    const authoritativeArtifacts = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(authoritativeArtifactFromRow);
    const adjudicationAssignments = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM adjudication_assignments WHERE repo_id=? ORDER BY entity_id').all(repoId).map(adjudicationAssignmentFromRow).filter((assignment) => assignment.requesting_run === workstreamRun || assignment.participating_runs.includes(workstreamRun) || assignment.adjudicator.workstream_run === workstreamRun);
    const escalations = !statusDetailRun ? [] : this.#db.prepare('SELECT * FROM escalations WHERE repo_id=? ORDER BY entity_id').all(repoId).map(escalationFromRow).filter((escalation) => escalation.participating_runs.includes(workstreamRun));
    const migrations = (repoId === 'global'
      ? this.#db.prepare('SELECT repo_id, migration_id, snapshot_sha256, journal_path, state, report_json, imported_at, updated_at, version FROM coordination_migrations ORDER BY repo_id').all().map(migrationRecordFromRow)
      : this.#db.prepare('SELECT repo_id, migration_id, snapshot_sha256, journal_path, state, report_json, imported_at, updated_at, version FROM coordination_migrations WHERE repo_id=?').all(repoId).map(migrationRecordFromRow))
      .map((migration) => {
        const report = migration['report'];
        if (typeof report !== 'object' || report === null || Array.isArray(report)) throw new CoordinationRuntimeError('store-corrupt', 'coordination migration status report is not an object');
        return { ...migration, report: { ...report, recovery: [], recovery_omitted: true, recovery_query: 'migration-recovery' } };
      });
    const migrationRecoveryWork = workstreamRun === null
      ? (repoId === 'global' ? this.#db.prepare("SELECT * FROM migration_recovery_work WHERE status='pending' ORDER BY repo_id, workstream_run, entity_id").all() : this.#db.prepare("SELECT * FROM migration_recovery_work WHERE repo_id=? AND status='pending' ORDER BY workstream_run, entity_id").all(repoId)).map(migrationRecoveryFromRow)
      : this.#db.prepare("SELECT * FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND status='pending' ORDER BY entity_id").all(repoId, workstreamRun).map(migrationRecoveryFromRow);
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
        observations,
        edit_leases: editLeases,
        change_reservations: changeReservations,
        reservation_obligations: reservationObligations,
        run_terminal_intents: runTerminalIntents,
        claim_requests: claimRequests,
        mailbox_cursors: mailboxCursors,
        reconciliation_evidence: reconciliationEvidence,
        reconciliation_receipts: reconciliationReceipts,
        mailbox_deliveries: mailboxDeliveries,
        result_receipts: resultReceipts,
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

  runCatalog(repoId: string, workstreamRun: string | null, payload: Readonly<Record<string, unknown>> = {}): StoreEffect {
    const cursorValue = payload['cursor_run'];
    const cursor = cursorValue === undefined || cursorValue === null ? null : typeof cursorValue === 'string' ? cursorValue : (() => { throw new CoordinationRuntimeError('invalid-request', 'run catalog cursor_run must be nullable opaque text'); })();
    const limitValue = payload['limit'];
    const limit = limitValue === undefined ? 128 : typeof limitValue === 'number' && Number.isSafeInteger(limitValue) && limitValue >= 1 && limitValue <= 256 ? limitValue : (() => { throw new CoordinationRuntimeError('invalid-request', 'run catalog limit must be an integer from 1 through 256'); })();
    if (workstreamRun !== null && cursor !== null) throw new CoordinationRuntimeError('invalid-request', 'exact run catalog query cannot carry a pagination cursor');
    const scopeSha256 = paginationScope(['run-catalog', repoId, workstreamRun]);
    if (workstreamRun !== null) {
      const joined = this.#db.prepare('SELECT runs.*, run_resources.payload_json AS run_resource_payload_json FROM runs LEFT JOIN run_resources ON run_resources.repo_id=runs.repo_id AND run_resources.workstream_run=runs.workstream_run WHERE runs.repo_id=? AND runs.workstream_run=?').all(repoId, workstreamRun);
      const entries = joined.map((row) => ({ run: runFromRow(row), run_resource: parseCoordinationRunResource(parseJsonObject(sqlString(row, 'run_resource_payload_json'), 'exact run catalog resource')) }));
      const pendingCount = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND status='pending'").get(repoId, workstreamRun), 'run catalog pending recovery count'), 'count');
      const payloadForPage = (items: readonly { readonly run: CoordinationRun; readonly run_resource: CoordinationRunResource }[]): Readonly<Record<string, unknown>> => ({
        schema_version: 'autopilot.coordinator_run_catalog.v1', package_build: COORDINATOR_PACKAGE_BUILD, protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
        database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION, runs: items.map((entry) => entry.run), run_resources: items.map((entry) => entry.run_resource), next_cursor: null,
        pending_migration_recovery_count: pendingCount,
      });
      for (const entry of entries) if (encodedJsonBytes(entry) > COORDINATOR_MAX_PAGE_ENTITY_BYTES) throw new CoordinationRuntimeError('frame-too-large', 'single run catalog entry exceeds the durable entity byte ceiling', [entry.run.workstream_run]);
      return { committedEventSeq: null, payload: payloadForPage(entries) };
    }

    const now = Date.now();
    this.#db.prepare('DELETE FROM run_catalog_scans WHERE created_at_ms<?').run(now - COORDINATOR_RUN_CATALOG_SCAN_TTL_MS);
    let scanToken: string;
    let revisionSha256: string;
    let pendingCount: number;
    let itemCount: number;
    let offset: number;
    if (cursor === null) {
      const activeCount = sqlInteger(asRow(this.#db.prepare('SELECT COUNT(*) AS count FROM run_catalog_scans').get(), 'active run catalog scan count'), 'count');
      if (activeCount >= COORDINATOR_MAX_ACTIVE_RUN_CATALOG_SCANS) {
        this.#db.prepare('DELETE FROM run_catalog_scans WHERE scan_token IN (SELECT scan_token FROM run_catalog_scans WHERE completed_at_ms IS NOT NULL ORDER BY completed_at_ms LIMIT ?)').run(activeCount - COORDINATOR_MAX_ACTIVE_RUN_CATALOG_SCANS + 1);
      }
      const retainedCount = sqlInteger(asRow(this.#db.prepare('SELECT COUNT(*) AS count FROM run_catalog_scans').get(), 'retained run catalog scan count'), 'count');
      if (retainedCount >= COORDINATOR_MAX_ACTIVE_RUN_CATALOG_SCANS) throw new CoordinationRuntimeError('coordinator-contention', 'run catalog snapshot capacity is temporarily exhausted; retry after an active scan completes or expires');
      scanToken = `run-catalog-scan-${randomBytes(32).toString('hex')}`;
      pendingCount = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE repo_id=? AND status='pending'").get(repoId), 'run catalog pending recovery count'), 'count');
      const revisionHash = createHash('sha256');
      revisionHash.update('[', 'utf8');
      itemCount = 0;
      this.#db.exec('SAVEPOINT create_run_catalog_scan');
      try {
        this.#db.prepare('INSERT INTO run_catalog_scans(scan_token, repo_id, scope_sha256, revision_sha256, pending_recovery_count, item_count, created_at_ms, completed_at_ms) VALUES(?, ?, ?, ?, ?, 0, ?, NULL)').run(scanToken, repoId, scopeSha256, 'pending', pendingCount, now);
        const insert = this.#db.prepare('INSERT INTO run_catalog_scan_items(scan_token, ordinal, run_json, run_resource_json) VALUES(?, ?, ?, ?)');
        for (const row of this.#db.prepare('SELECT runs.*, run_resources.payload_json AS run_resource_payload_json FROM runs LEFT JOIN run_resources ON run_resources.repo_id=runs.repo_id AND run_resources.workstream_run=runs.workstream_run WHERE runs.repo_id=? ORDER BY runs.workstream_run').iterate(repoId)) {
          const run = runFromRow(row);
          const runResource = parseCoordinationRunResource(parseJsonObject(sqlString(row, 'run_resource_payload_json'), 'snapshotted run catalog resource'));
          if (runResource.repo_id !== run.repo_id || runResource.workstream_run !== run.workstream_run) throw new CoordinationRuntimeError('store-corrupt', 'run catalog and immutable run resource are not in exact lockstep', [run.workstream_run]);
          const entry = { run, run_resource: runResource };
          if (encodedJsonBytes(entry) > COORDINATOR_MAX_PAGE_ENTITY_BYTES) throw new CoordinationRuntimeError('frame-too-large', 'single run catalog entry exceeds the durable entity byte ceiling', [run.workstream_run]);
          itemCount += 1;
          if (itemCount > 1) revisionHash.update(',', 'utf8');
          revisionHash.update(JSON.stringify(entry), 'utf8');
          insert.run(scanToken, itemCount, canonicalJson(run), canonicalJson(runResource));
        }
        revisionHash.update(']', 'utf8');
        revisionSha256 = `sha256:${revisionHash.digest('hex')}`;
        this.#db.prepare('UPDATE run_catalog_scans SET revision_sha256=?, item_count=? WHERE scan_token=?').run(revisionSha256, itemCount, scanToken);
        this.#db.exec('RELEASE SAVEPOINT create_run_catalog_scan');
      } catch (error) {
        this.#db.exec('ROLLBACK TO SAVEPOINT create_run_catalog_scan; RELEASE SAVEPOINT create_run_catalog_scan;');
        throw error;
      }
      offset = 0;
    } else {
      const cursorState = paginationCursorState(cursor, { kind: 'run-catalog', scopeSha256, section: 'runs' });
      if (cursorState.snapshot === null) throw new CoordinationRuntimeError('invalid-request', 'run catalog continuation omitted its snapshot identity');
      scanToken = cursorState.snapshot;
      const scan = this.#db.prepare('SELECT * FROM run_catalog_scans WHERE scan_token=?').get(scanToken);
      if (scan === undefined) throw new CoordinationRuntimeError('stale-version', 'run catalog snapshot expired or belongs to a retired coordinator process');
      if (sqlString(scan, 'repo_id') !== repoId || sqlString(scan, 'scope_sha256') !== scopeSha256) throw new CoordinationRuntimeError('unauthorized-client', 'run catalog snapshot belongs to a different query scope');
      revisionSha256 = sqlString(scan, 'revision_sha256');
      pendingCount = sqlInteger(scan, 'pending_recovery_count');
      itemCount = sqlInteger(scan, 'item_count');
      offset = parsePaginationCursor(cursor, { kind: 'run-catalog', scopeSha256, revisionSha256, section: 'runs', snapshot: scanToken });
    }
    if (offset > itemCount) throw new CoordinationRuntimeError('stale-version', 'run catalog cursor is beyond its immutable snapshot');
    const entries = this.#db.prepare('SELECT run_json, run_resource_json FROM run_catalog_scan_items WHERE scan_token=? AND ordinal>? ORDER BY ordinal LIMIT ?').all(scanToken, offset, limit + 1).map((row) => ({
      run: parseCoordinationRun(parseJsonObject(sqlString(row, 'run_json'), 'snapshotted run catalog entry')),
      run_resource: parseCoordinationRunResource(parseJsonObject(sqlString(row, 'run_resource_json'), 'snapshotted run catalog resource')),
    }));
    const cursorForOffset = (localOffset: number): string => encodePaginationCursor({ kind: 'run-catalog', scopeSha256, revisionSha256, section: 'runs', snapshot: scanToken, offset: offset + localOffset });
    const payloadForPage = (items: readonly { readonly run: CoordinationRun; readonly run_resource: CoordinationRunResource }[], nextCursor: string | null): Readonly<Record<string, unknown>> => ({
      schema_version: 'autopilot.coordinator_run_catalog.v1', package_build: COORDINATOR_PACKAGE_BUILD, protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
      database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION, runs: items.map((entry) => entry.run), run_resources: items.map((entry) => entry.run_resource),
      next_cursor: nextCursor, pending_migration_recovery_count: pendingCount,
    });
    const page = byteBudgetPage({ items: entries, offset: 0, cursorForOffset, payloadForPage, maximumItems: limit });
    const finalPage = offset + page.items.length === itemCount;
    if ((page.nextCursor === null) !== finalPage) throw new CoordinationRuntimeError('store-corrupt', 'run catalog pagination disagrees with its frozen snapshot count', [scanToken]);
    if (finalPage) this.#db.prepare('UPDATE run_catalog_scans SET completed_at_ms=COALESCE(completed_at_ms, ?) WHERE scan_token=?').run(now, scanToken);
    return { committedEventSeq: null, payload: payloadForPage(page.items, page.nextCursor) };
  }

  reconciliationDetails(request: CoordinatorRequestEnvelope): StoreEffect {
    const receiptId = payloadString(request.payload, 'reconciliation_receipt_id');
    const receiptRow = asRow(this.#db.prepare('SELECT * FROM reconciliation_receipts WHERE entity_id=? AND repo_id=? AND workstream_run=?').get(receiptId, request.repo_id, this.#workstreamRun(request)), 'reconciliation receipt');
    const receipt = reconciliationReceiptFromRow(receiptRow);
    let authorityId: string;
    if (request.payload['session_lease_id'] !== undefined) {
      const session = this.#requireCurrentSession(request);
      authorityId = `session:${session.session_lease_id}`;
    } else {
      if (receipt.source_action !== 'complete-child' && receipt.source_action !== 'complete-adjudication') throw new CoordinationRuntimeError('unauthorized-client', 'child authority can read only its own completion reconciliation receipt');
      const childId = payloadString(request.payload, 'child_lease_id');
      const childRow = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'reconciliation detail child');
      const child = childFromRow(childRow);
      this.#assertChildAuthority(request, child, childRow);
      if (child.owner.workstream_run !== receipt.workstream_run || child.status === 'running') throw new CoordinationRuntimeError('unauthorized-client', 'child completion receipt does not match terminal child authority');
      const completionEvent = receipt.source_action === 'complete-child'
        ? this.#db.prepare("SELECT entity_id FROM events WHERE repo_id=? AND event_seq=? AND entity_type='child-lease' AND entity_id=? AND event_type IN ('child-terminal','child-recovery-required')").get(receipt.repo_id, receipt.committed_event_seq, child.child_lease_id)
        : this.#db.prepare("SELECT entity_id FROM events WHERE repo_id=? AND event_seq=? AND event_type='adjudication-accepted' AND entity_id IN (SELECT entity_id FROM adjudication_assignments WHERE json_extract(payload_json, '$.child_lease_id')=?)").get(receipt.repo_id, receipt.committed_event_seq, child.child_lease_id);
      if (completionEvent === undefined) throw new CoordinationRuntimeError('unauthorized-client', 'reconciliation receipt is not bound to the authenticated child completion event');
      authorityId = `child:${child.child_lease_id}`;
    }
    const countRows = this.#db.prepare('SELECT kind, COUNT(*) AS count FROM reconciliation_details WHERE reconciliation_receipt_id=? GROUP BY kind ORDER BY kind').all(receiptId);
    const actualCounts: Record<CoordinationReconciliationDetailKind, number> = { 'released-lease': 0, 'released-observation': 0, 'stale-observation': 0, 'released-request': 0, notification: 0, 'offered-group': 0 };
    let actualCount = 0;
    for (const row of countRows) {
      const kind = sqlString(row, 'kind');
      if (!(kind in actualCounts)) throw new CoordinationRuntimeError('store-corrupt', 'reconciliation details contain an unknown kind', [receiptId, kind]);
      const count = sqlInteger(row, 'count');
      actualCounts[kind as CoordinationReconciliationDetailKind] = count;
      actualCount += count;
    }
    if (actualCount !== receipt.detail_count || canonicalJson(actualCounts) !== canonicalJson(receipt.counts)) throw new CoordinationRuntimeError('store-corrupt', 'reconciliation receipt counts disagree with durable detail rows', [receiptId]);
    const scopeSha256 = paginationScope(['reconciliation-details', request.repo_id, receipt.workstream_run, receiptId, authorityId]);
    const cursorValue = request.payload['cursor'];
    const offset = cursorValue === null
      ? 0
      : typeof cursorValue === 'string'
        ? parsePaginationCursor(cursorValue, { kind: 'reconciliation-details', scopeSha256, revisionSha256: receipt.details_sha256, section: receiptId })
        : (() => { throw new CoordinationRuntimeError('invalid-request', 'reconciliation detail cursor must be null or bounded opaque text'); })();
    const details = this.#db.prepare('SELECT * FROM reconciliation_details WHERE reconciliation_receipt_id=? AND ordinal>? ORDER BY ordinal LIMIT 1025').all(receiptId, offset).map(reconciliationDetailFromRow);
    const cursorForOffset = (localOffset: number): string => encodePaginationCursor({ kind: 'reconciliation-details', scopeSha256, revisionSha256: receipt.details_sha256, section: receiptId, offset: offset + localOffset });
    const payloadForPage = (items: readonly CoordinationReconciliationDetail[], nextCursor: string | null): Readonly<Record<string, unknown>> => ({ schema_version: 'autopilot.reconciliation_detail_page.v1', reconciliation_receipt: receipt, details: items, next_cursor: nextCursor });
    const page = byteBudgetPage({ items: details, offset: 0, cursorForOffset, payloadForPage });
    const finalPage = offset + page.items.length === receipt.detail_count;
    if ((page.nextCursor === null) !== finalPage) throw new CoordinationRuntimeError('store-corrupt', 'reconciliation pagination disagrees with its receipt count', [receiptId]);
    if (finalPage) {
      const hash = createHash('sha256');
      hash.update('[', 'utf8');
      let ordinal = 0;
      for (const row of this.#db.prepare('SELECT * FROM reconciliation_details WHERE reconciliation_receipt_id=? ORDER BY ordinal').iterate(receiptId)) {
        const detail = reconciliationDetailFromRow(row);
        ordinal += 1;
        if (detail.ordinal !== ordinal) throw new CoordinationRuntimeError('store-corrupt', 'reconciliation detail ordinals are not exact and contiguous', [receiptId]);
        if (ordinal > 1) hash.update(',', 'utf8');
        hash.update(JSON.stringify(detail), 'utf8');
      }
      hash.update(']', 'utf8');
      if (ordinal !== receipt.detail_count || `sha256:${hash.digest('hex')}` !== receipt.details_sha256) throw new CoordinationRuntimeError('store-corrupt', 'reconciliation receipt digest disagrees with durable detail rows', [receiptId]);
    }
    return { committedEventSeq: null, payload: payloadForPage(page.items, page.nextCursor) };
  }

  resultDetails(request: CoordinatorRequestEnvelope): StoreEffect {
    const session = this.#requireCurrentSession(request);
    const receiptId = payloadString(request.payload, 'result_receipt_id');
    const receipt = resultReceiptFromRow(asRow(this.#db.prepare('SELECT * FROM result_receipts WHERE entity_id=? AND repo_id=? AND workstream_run=?').get(receiptId, request.repo_id, session.workstream_run), 'result receipt'));
    const countRows = this.#db.prepare('SELECT collection_name, COUNT(*) AS count, MAX(collection_ordinal) AS maximum FROM result_details WHERE result_receipt_id=? GROUP BY collection_name ORDER BY collection_name').all(receiptId);
    let actualCount = 0;
    for (const row of countRows) {
      const collection = sqlString(row, 'collection_name');
      const expected = receipt.collections[collection];
      const count = sqlInteger(row, 'count');
      if (expected === undefined || count !== expected.item_count || sqlInteger(row, 'maximum') !== count) throw new CoordinationRuntimeError('store-corrupt', 'result collection count or ordinals disagree with its receipt', [receiptId, collection]);
      actualCount += count;
    }
    const nonemptyExpected = Object.values(receipt.collections).filter((collection) => collection.item_count > 0).length;
    if (actualCount !== receipt.detail_count || countRows.length !== nonemptyExpected) throw new CoordinationRuntimeError('store-corrupt', 'result receipt count disagrees with durable details', [receiptId]);
    const scopeSha256 = paginationScope(['result-details', request.repo_id, session.workstream_run, receiptId, session.session_lease_id]);
    const cursorValue = request.payload['cursor'];
    const offset = cursorValue === null ? 0 : typeof cursorValue === 'string'
      ? parsePaginationCursor(cursorValue, { kind: 'result-details', scopeSha256, revisionSha256: receipt.details_sha256, section: receiptId })
      : (() => { throw new CoordinationRuntimeError('invalid-request', 'result detail cursor must be null or bounded opaque text'); })();
    const details = this.#db.prepare('SELECT * FROM result_details WHERE result_receipt_id=? AND ordinal>? ORDER BY ordinal LIMIT 1025').all(receiptId, offset).map(resultDetailFromRow);
    const cursorForOffset = (localOffset: number): string => encodePaginationCursor({ kind: 'result-details', scopeSha256, revisionSha256: receipt.details_sha256, section: receiptId, offset: offset + localOffset });
    const payloadForPage = (items: readonly CoordinationResultDetail[], nextCursor: string | null): Readonly<Record<string, unknown>> => ({ schema_version: 'autopilot.result_detail_page.v1', result_receipt: receipt, details: items, next_cursor: nextCursor });
    const page = byteBudgetPage({ items: details, offset: 0, cursorForOffset, payloadForPage });
    const finalPage = offset + page.items.length === receipt.detail_count;
    if ((page.nextCursor === null) !== finalPage) throw new CoordinationRuntimeError('store-corrupt', 'result pagination disagrees with its receipt count', [receiptId]);
    if (finalPage) {
      const detailsHash = createHash('sha256');
      detailsHash.update('[', 'utf8');
      const collectionHashes = new Map<string, { readonly hash: ReturnType<typeof createHash>; count: number }>();
      let ordinal = 0;
      for (const row of this.#db.prepare('SELECT * FROM result_details WHERE result_receipt_id=? ORDER BY ordinal').iterate(receiptId)) {
        const detail = resultDetailFromRow(row);
        ordinal += 1;
        if (detail.ordinal !== ordinal) throw new CoordinationRuntimeError('store-corrupt', 'result detail ordinals are not exact and contiguous', [receiptId]);
        if (ordinal > 1) detailsHash.update(',', 'utf8');
        detailsHash.update(JSON.stringify(detail), 'utf8');
        let collectionHash = collectionHashes.get(detail.collection);
        if (collectionHash === undefined) {
          collectionHash = { hash: createHash('sha256'), count: 0 };
          collectionHash.hash.update('[', 'utf8');
          collectionHashes.set(detail.collection, collectionHash);
        }
        collectionHash.count += 1;
        if (collectionHash.count > 1) collectionHash.hash.update(',', 'utf8');
        collectionHash.hash.update(JSON.stringify(detail.value), 'utf8');
      }
      detailsHash.update(']', 'utf8');
      if (ordinal !== receipt.detail_count || `sha256:${detailsHash.digest('hex')}` !== receipt.details_sha256) throw new CoordinationRuntimeError('store-corrupt', 'result receipt digest disagrees with durable details', [receiptId]);
      for (const [collection, expected] of Object.entries(receipt.collections)) {
        const state = collectionHashes.get(collection);
        const digest = state === undefined ? `sha256:${createHash('sha256').update('[]', 'utf8').digest('hex')}` : (state.hash.update(']', 'utf8'), `sha256:${state.hash.digest('hex')}`);
        if ((state?.count ?? 0) !== expected.item_count || digest !== expected.items_sha256) throw new CoordinationRuntimeError('store-corrupt', 'result collection digest disagrees with durable details', [receiptId, collection]);
      }
    }
    return { committedEventSeq: null, payload: payloadForPage(page.items, page.nextCursor) };
  }

  migrationRecovery(request: CoordinatorRequestEnvelope): StoreEffect {
    const includeResolved = payloadBoolean(request.payload, 'include_resolved');
    const recoveryId = payloadNullableString(request.payload, 'recovery_id');
    const cursorRun = payloadNullableString(request.payload, 'cursor_run');
    const cursorRecoveryId = payloadNullableString(request.payload, 'cursor_recovery_id');
    const limit = payloadInteger(request.payload, 'limit');
    if ((cursorRun === null) !== (cursorRecoveryId === null) || (cursorRun !== null && cursorRun !== cursorRecoveryId)) throw new CoordinationRuntimeError('invalid-request', 'migration recovery cursor requires one matching opaque continuation identity');
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
    if (request.workstream_run !== null) rows = rows.filter((work) => work.workstream_run === request.workstream_run);
    if (!includeResolved) rows = rows.filter((work) => work.status === 'pending');
    if (recoveryId !== null) rows = rows.filter((work) => work.recovery_id === recoveryId);
    const runs = request.workstream_run === null ? [] : this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').all(request.repo_id, request.workstream_run).map(runFromRow);
    const revisionSha256 = paginationRevision({ rows, runs, pendingCount });
    const scopeSha256 = paginationScope(['migration-recovery', request.repo_id, request.workstream_run, includeResolved ? 'resolved' : 'pending', recoveryId]);
    const offset = cursorRun === null ? 0 : parsePaginationCursor(cursorRun, { kind: 'migration-recovery', scopeSha256, revisionSha256, section: 'recovery' });
    const cursorForOffset = (nextOffset: number): string => encodePaginationCursor({ kind: 'migration-recovery', scopeSha256, revisionSha256, section: 'recovery', offset: nextOffset });
    const payloadForPage = (items: readonly CoordinationMigrationRecoveryWork[], nextCursor: string | null): Readonly<Record<string, unknown>> => ({
      schema_version: 'autopilot.migration_recovery_query.v1', package_build: COORDINATOR_PACKAGE_BUILD, protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
      database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION, recovery: items, runs, pending_migration_recovery_count: pendingCount,
      next_cursor: nextCursor === null ? null : { cursor_run: nextCursor, cursor_recovery_id: nextCursor },
    });
    const page = byteBudgetPage({ items: rows, offset, cursorForOffset, payloadForPage, maximumItems: limit });
    return { committedEventSeq: null, payload: payloadForPage(page.items, page.nextCursor) };
  }

  doctor(observedAt?: Date): StoreEffect {
    const integrity = integrityResult(this.#db);
    const invariantFindings = this.#allInvariantFindings();
    const invariantErrors = invariantFindings.filter((finding) => finding.severity === 'error');
    const nowDate = observedAt ?? this.#clock.now();
    const now = nowDate.toISOString();
    const retainedExclusiveOperations = this.#db.prepare('SELECT * FROM edit_leases ORDER BY repo_id, workstream_run, entity_id').all().map(editLeaseFromRow).filter((lease) => lease.mode === 'EXCLUSIVE').map((lease) => {
      const operation = lease.exclusive_operation;
      if (operation === undefined) throw new CoordinationRuntimeError('store-corrupt', 'EXCLUSIVE lease lacks its parsed operation contract', [lease.edit_lease_id]);
      const event = asRow(this.#db.prepare('SELECT occurred_at FROM events WHERE repo_id=? AND event_seq=?').get(lease.owner.repo_id, lease.acquired_event_seq), 'EXCLUSIVE acquisition event');
      const acquiredAt = sqlString(event, 'occurred_at');
      const acquiredAtMs = Date.parse(acquiredAt);
      if (!Number.isFinite(acquiredAtMs)) throw new CoordinationRuntimeError('store-corrupt', 'EXCLUSIVE acquisition event has an invalid timestamp', [lease.edit_lease_id, acquiredAt]);
      const elapsedMs = Math.max(0, nowDate.getTime() - acquiredAtMs);
      const attempt = this.#requireUnitAttempt(lease.owner.repo_id, lease.owner.workstream_run, lease.owner.unit_id, lease.owner.attempt);
      return {
        edit_lease_id: lease.edit_lease_id,
        repo_id: lease.owner.repo_id,
        workstream_run: lease.owner.workstream_run,
        unit_id: lease.owner.unit_id,
        attempt: lease.owner.attempt,
        path: lease.path,
        operation,
        acquired_at: acquiredAt,
        elapsed_ms: elapsedMs,
        overdue: elapsedMs > operation.expected_duration_ms,
        critical_section_active: attempt.critical_section === operation.critical_section && !attempt.preemptible,
        release_from_age_authorized: false,
      };
    });
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
    const migrations = this.#db.prepare('SELECT version, checksum, applied_at FROM schema_migrations WHERE version<=? ORDER BY version').all(COORDINATOR_DATABASE_SCHEMA_VERSION).map((row) => ({ version: sqlInteger(row, 'version'), checksum: sqlString(row, 'checksum'), applied_at: sqlString(row, 'applied_at') }));
    const incompleteOperations = this.#db.prepare("SELECT * FROM worktree_operations WHERE canonical_worktree_id IS NOT NULL AND json_extract(payload_json, '$.stage') NOT IN ('committed','compensated','failed') ORDER BY repo_id, workstream_run, canonical_worktree_id, entity_id").all().map(canonicalWorktreeOperationFromRow);
    const pendingReservationObligations = this.#db.prepare("SELECT * FROM reservation_obligations WHERE json_extract(payload_json, '$.state') IN ('waiting-for-predecessor','integration-required') ORDER BY repo_id, workstream_run, entity_id").all().map(reservationObligationFromRow);
    const preparedRunTerminalIntents = this.#db.prepare("SELECT * FROM run_terminal_intents WHERE json_extract(payload_json, '$.state')='prepared' ORDER BY repo_id, workstream_run, entity_id").all().map(runTerminalIntentFromRow);
    const activeWaitForEdges = this.#db.prepare("SELECT * FROM wait_for_edges WHERE json_extract(payload_json, '$.state')='active' ORDER BY repo_id, entity_id").all().map(waitForEdgeFromRow);
    const openDeadlockResolutions = this.#db.prepare("SELECT * FROM deadlock_resolutions WHERE json_extract(payload_json, '$.state')!='resolved' ORDER BY repo_id, entity_id").all().map(deadlockResolutionFromRow);
    const pendingAdjudicationAssignments = this.#db.prepare("SELECT * FROM adjudication_assignments WHERE json_extract(payload_json, '$.state')='assigned' ORDER BY repo_id, entity_id").all().map(adjudicationAssignmentFromRow);
    const immutableEvidenceArtifactCount = sqlInteger(asRow(this.#db.prepare('SELECT COUNT(*) AS count FROM evidence_artifacts').get(), 'evidence artifact count'), 'count');
    const coordinationMigrations = this.#db.prepare('SELECT repo_id, migration_id, snapshot_sha256, journal_path, state, report_json, imported_at, updated_at, version FROM coordination_migrations ORDER BY repo_id').all().map(migrationRecordFromRow).map((migration) => {
      const report = migration['report'];
      if (typeof report !== 'object' || report === null || Array.isArray(report)) throw new CoordinationRuntimeError('store-corrupt', 'coordination migration doctor report is not an object');
      return { ...migration, report: { ...report, recovery: [], recovery_omitted: true, recovery_query: 'migration-recovery' } };
    });
    const pendingMigrationRecoveryCount = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE status='pending'").get(), 'pending migration recovery count'), 'count');
    const pendingMigrationRecovery = this.#db.prepare("SELECT * FROM migration_recovery_work WHERE status='pending' ORDER BY repo_id, workstream_run, entity_id").all().map(migrationRecoveryFromRow);
    return {
      committedEventSeq: null,
      payload: {
        schema_version: 'autopilot.coordinator_doctor.v1',
        observed_at: now,
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
        retained_exclusive_operations: retainedExclusiveOperations,
        immutable_evidence_artifact_count: immutableEvidenceArtifactCount,
        coordination_migrations: coordinationMigrations,
        pending_migration_recovery_count: pendingMigrationRecoveryCount,
        pending_migration_recovery_work: pendingMigrationRecovery,
        max_grant_bypasses: MAX_GRANT_BYPASSES,
      },
    };
  }

  #assertPrivateExportTarget(outputPath: string): { readonly target: string; readonly parent: string } {
    if (!isAbsolute(outputPath)) throw new CoordinationRuntimeError('invalid-request', 'coordinator export output_path must be absolute');
    const root = resolve(this.#exportsRoot);
    const target = resolve(outputPath);
    const relativeTarget = relative(root, target);
    if (relativeTarget.length === 0 || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) throw new CoordinationRuntimeError('invalid-request', 'coordinator export output_path must remain below the private coordinator exports root', [target, root]);
    const parent = dirname(target);
    const relativeParent = relative(root, parent);
    const components = relativeParent.length === 0 ? [] : relativeParent.split(sep);
    let current = root;
    for (const component of ['', ...components]) {
      if (component.length > 0) current = join(current, component);
      let metadata: ReturnType<typeof lstatSync>;
      try { metadata = lstatSync(current); }
      catch (error) { throw new CoordinationRuntimeError('invalid-request', 'coordinator export parent path must already exist below the private exports root', [current, error instanceof Error ? error.message : String(error)]); }
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new CoordinationRuntimeError('invalid-request', 'coordinator export parent path must contain only real private directories', [current]);
      assertPrivatePathNoAliases(current);
      if (platform() !== 'win32') {
        if ((metadata.mode & 0o777) !== 0o700) throw new CoordinationRuntimeError('invalid-request', 'coordinator export parent directories must be exact mode 0700', [current, `mode=${(metadata.mode & 0o777).toString(8)}`]);
        const getuid = process.getuid;
        if (getuid !== undefined && metadata.uid !== getuid()) throw new CoordinationRuntimeError('invalid-request', 'coordinator export parent owner differs from the coordinator process user', [current, `uid=${String(metadata.uid)}`]);
      }
    }
    if (existsSync(target)) {
      const metadata = lstatSync(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new CoordinationRuntimeError('invalid-request', 'coordinator export target must be an absent or single-link regular file', [target]);
      assertPrivatePathNoAliases(target);
      if (platform() !== 'win32') {
        if ((metadata.mode & 0o777) !== 0o600) throw new CoordinationRuntimeError('invalid-request', 'existing coordinator export target must be exact mode 0600', [target, `mode=${(metadata.mode & 0o777).toString(8)}`]);
        const getuid = process.getuid;
        if (getuid !== undefined && metadata.uid !== getuid()) throw new CoordinationRuntimeError('invalid-request', 'coordinator export target owner differs from the coordinator process user', [target, `uid=${String(metadata.uid)}`]);
      }
    }
    return Object.freeze({ target, parent });
  }

  exportTo(outputPath: string, includeNegotiatedS1Vocabulary = false): StoreEffect {
    const { target, parent } = this.#assertPrivateExportTarget(outputPath);
    const tables = [
      ['repositories', 'repo_id'],
      ['runs', 'repo_id, workstream_run'],
      ['run_resources', 'repo_id, workstream_run'],
      ['session_leases', 'repo_id, workstream_run, session_generation, session_lease_id'],
      ['child_leases', 'repo_id, workstream_run, unit_id, attempt, child_lease_id'],
      ['unit_attempts', 'repo_id, workstream_run, entity_id'],
      ['acquisition_groups', 'repo_id, workstream_run, entity_id'],
      ['observations', 'repo_id, workstream_run, entity_id'],
      ['edit_leases', 'repo_id, workstream_run, entity_id'],
      ['change_reservations', 'repo_id, workstream_run, entity_id'],
      ['reservation_obligations', 'repo_id, workstream_run, entity_id'],
      ['run_terminal_intents', 'repo_id, workstream_run, entity_id'],
      ['claim_requests', 'repo_id, requester_workstream_run, owner_workstream_run, entity_id'],
      ['mailbox_cursors', 'repo_id, workstream_run'],
      ['reconciliation_evidence', 'repo_id, workstream_run, entity_id'],
      ['reconciliation_receipts', 'repo_id, workstream_run, committed_event_seq, entity_id'],
      ['reconciliation_details', 'reconciliation_receipt_id, ordinal'],
      ['messages', 'repo_id, recipient_workstream_run, created_event_seq, message_id'],
      ['mailbox_deliveries', 'repo_id, workstream_run, delivery_id'],
      ['mailbox_delivery_items', 'delivery_id, ordinal'],
      ['result_receipts', 'repo_id, workstream_run, committed_event_seq, entity_id'],
      ['result_details', 'result_receipt_id, ordinal'],
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
    ] as const;
    const tableQueries = new Map<string, string>(tables.map(([table, order]) => [table, `SELECT * FROM ${table} ORDER BY ${order}`]));
    tableQueries.set('worktrees', 'SELECT entity_id,repo_id,workstream_run,payload_json,version FROM worktrees ORDER BY repo_id,workstream_run,entity_id');
    tableQueries.set('worktree_operations', includeNegotiatedS1Vocabulary
      ? 'SELECT entity_id,repo_id,workstream_run,payload_json,version FROM worktree_operations ORDER BY repo_id,workstream_run,entity_id'
      : "SELECT entity_id,repo_id,workstream_run,payload_json,version FROM worktree_operations WHERE json_extract(payload_json, '$.operation_type')!='metadata-reconcile' ORDER BY repo_id,workstream_run,entity_id");
    if (!includeNegotiatedS1Vocabulary) {
      tableQueries.set('events', "SELECT * FROM events WHERE NOT(entity_type='worktree-operation' AND entity_id IN (SELECT entity_id FROM worktree_operations WHERE json_extract(payload_json, '$.operation_type')='metadata-reconcile')) AND event_type!='run-scoped-fault-resolved' ORDER BY repo_id,event_seq");
      tableQueries.set('idempotency_results', "SELECT * FROM idempotency_results WHERE COALESCE(json_extract(payload_json, '$.operation.operation_type'),'')!='metadata-reconcile' AND json_type(payload_json, '$.identity_resolution') IS NULL ORDER BY repo_id,idempotency_key");
    } else {
      tableQueries.set('worktrees', 'SELECT entity_id,repo_id,workstream_run,canonical_worktree_id,is_current_canonical,payload_json,version FROM worktrees ORDER BY repo_id,workstream_run,entity_id');
      tableQueries.set('run_scoped_faults', 'SELECT fault_id,invariant_id,repo_id,workstream_run,entity_type,entity_id,fault_code,detail_json,status,created_event_seq,resolved_event_seq,version FROM run_scoped_faults ORDER BY repo_id,workstream_run,fault_id');
    }
    tableQueries.set('schema_migrations', `SELECT version,checksum,applied_at FROM schema_migrations WHERE version<=${String(COORDINATOR_DATABASE_SCHEMA_VERSION)} ORDER BY version`);
    tableQueries.set('evidence_artifacts', 'SELECT entity_id, repo_id, sha256, ref, label, size_bytes, created_event_seq, lower(hex(content)) AS content_hex FROM evidence_artifacts ORDER BY repo_id, created_event_seq, entity_id');
    const keys = ['schema_version', 'database_schema_version', ...tableQueries.keys()].sort((left, right) => left.localeCompare(right));
    const hash = createHash('sha256');
    const temporary = `${target}.tmp-${String(process.pid)}-${randomBytes(8).toString('hex')}`;
    const descriptor = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    let buffered = '';
    let bufferedBytes = 0;
    const flush = (): void => {
      if (buffered.length === 0) return;
      const bytes = Buffer.from(buffered, 'utf8');
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
        if (written < 1) throw new CoordinationRuntimeError('system-fatal', 'coordinator export made no progress during a short write');
        offset += written;
      }
      buffered = '';
      bufferedBytes = 0;
    };
    const write = (chunk: string): void => {
      hash.update(chunk, 'utf8');
      buffered += chunk;
      bufferedBytes += Buffer.byteLength(chunk, 'utf8');
      if (bufferedBytes >= 1024 * 1024) flush();
    };
    try {
      write('{');
      for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
        const key = keys[keyIndex];
        if (key === undefined) continue;
        if (keyIndex > 0) write(',');
        write(`${JSON.stringify(key)}:`);
        if (key === 'schema_version') { write(JSON.stringify(DATABASE_EXPORT_SCHEMA)); continue; }
        if (key === 'database_schema_version') { write(String(COORDINATOR_DATABASE_SCHEMA_VERSION)); continue; }
        const query = tableQueries.get(key);
        if (query === undefined) throw new CoordinationRuntimeError('system-fatal', 'deterministic export table query is missing', [key]);
        write('[');
        let rowIndex = 0;
        for (const row of this.#db.prepare(query).iterate()) {
          if (rowIndex > 0) write(',');
          write(canonicalJson(Object.fromEntries(Object.entries(row))));
          rowIndex += 1;
        }
        write(']');
      }
      write('}');
      write('\n');
      flush();
      fsyncSync(descriptor);
    } catch (error) {
      closeSync(descriptor);
      unlinkSync(temporary);
      throw error;
    }
    closeSync(descriptor);
    try {
      if (platform() === 'win32') enforceWindowsPrivateAcl(temporary, false);
      else chmodSync(temporary, 0o600);
      const temporaryMetadata = lstatSync(temporary);
      if (!temporaryMetadata.isFile() || temporaryMetadata.isSymbolicLink() || temporaryMetadata.nlink !== 1 || (platform() !== 'win32' && (temporaryMetadata.mode & 0o777) !== 0o600)) throw new CoordinationRuntimeError('system-fatal', 'coordinator export temporary file lost its exact private identity', [temporary]);
      renameSync(temporary, target);
      this.#assertPrivateExportTarget(target);
      if (platform() !== 'win32') {
        const parentDescriptor = openSync(parent, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        try {
          if (!fstatSync(parentDescriptor).isDirectory()) throw new CoordinationRuntimeError('system-fatal', 'coordinator export parent ceased to be a directory before durability sync', [parent]);
          fsyncSync(parentDescriptor);
        } finally { closeSync(parentDescriptor); }
      }
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
    return { committedEventSeq: null, payload: { schema_version: 'autopilot.coordinator_export_result.v1', output_path: target, sha256: `sha256:${hash.digest('hex')}` } };
  }

  attachRun(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const workstreamRun = this.#workstreamRun(request);
      const resource = parseCoordinationRunResource(request.payload['run_resource']);
      if (coordinationCutoverCommitted(this.#stateRoot, request.repo_id) && payloadString(request.payload, 'coordination_authority') !== 'coordinator-edit-leases-v1') throw new CoordinationRuntimeError('unauthorized-client', 'post-cutover run attachment cannot create legacy coordination authority');
      if (resource.repo_id !== request.repo_id || resource.workstream_run !== workstreamRun) throw new CoordinationRuntimeError('invalid-request', 'run resource identity must match the attached repository/run');
      if (resource.source_repo !== payloadString(request.payload, 'canonical_root') || resource.git_common_dir !== payloadString(request.payload, 'git_common_dir')) throw new CoordinationRuntimeError('invalid-request', 'run resource repository identity disagrees with attach-run');
      const existingRepoRow = this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(request.repo_id);
      const existingRunRow = this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').get(request.repo_id, workstreamRun);
      if (existingRunRow !== undefined) throw new CoordinationRuntimeError('stale-version', 'run already exists; query status before attachment');
      if (request.expected_version !== 0) throw new CoordinationRuntimeError('stale-version', 'new run registration requires expected_version 0');
      const seq = existingRepoRow === undefined ? 1 : this.#nextEventSequence(request.repo_id);
      if (existingRepoRow === undefined) {
        this.#db.prepare('INSERT INTO repositories(repo_id, repo_key, canonical_root, git_common_dir, event_seq, created_event_seq, version) VALUES(?, ?, ?, ?, ?, ?, 1)').run(
          request.repo_id,
          payloadString(request.payload, 'repo_key'),
          payloadString(request.payload, 'canonical_root'),
          payloadString(request.payload, 'git_common_dir'),
          seq,
          seq,
        );
      } else {
        const repository = repositoryFromRow(existingRepoRow);
        if (repository.repo_key !== payloadString(request.payload, 'repo_key') || repository.canonical_root !== payloadString(request.payload, 'canonical_root') || repository.git_common_dir !== payloadString(request.payload, 'git_common_dir')) {
          throw new CoordinationRuntimeError('invalid-state', 'repository identity disagrees with its durable coordinator record');
        }
        this.#db.prepare('UPDATE repositories SET event_seq=? WHERE repo_id=?').run(seq, request.repo_id);
      }
      this.#db.prepare("INSERT INTO runs(repo_id, autopilot_id, workstream, workstream_run, coordination_authority, status, active_session_generation, created_event_seq, version) VALUES(?, ?, ?, ?, ?, 'active', 0, ?, 1)").run(
        request.repo_id,
        payloadString(request.payload, 'autopilot_id'),
        payloadString(request.payload, 'workstream'),
        workstreamRun,
        payloadString(request.payload, 'coordination_authority'),
        seq,
      );
      this.#db.prepare('INSERT INTO run_resources(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(`run-resource:${request.repo_id}:${workstreamRun}`, request.repo_id, workstreamRun, canonicalJson(resource), resource.version);
      this.#db.prepare('INSERT INTO mailbox_cursors(repo_id, workstream_run, delivered_through_event_seq, acknowledged_through_event_seq, version) VALUES(?, ?, 0, 0, 1)').run(request.repo_id, workstreamRun);
      const run = runFromRow(asRow(this.#db.prepare('SELECT * FROM runs WHERE repo_id=? AND workstream_run=?').get(request.repo_id, workstreamRun), 'created run'));
      // D65-A1: a current-build attach-run carrying `bootstrap_graph` atomically
      // creates the bootstrap-artifact/trust rows and the closed
      // `autopilot.attach_run_result.v2` effect. Legacy/cf50 attach-run omits
      // the object and keeps the exact old `{run}` result bytes below.
      if (request.payload['bootstrap_graph'] !== undefined) {
        return this.#applyD65BootstrapGraph(request, seq, run, resource, existingRepoRow !== undefined);
      }
      return { sequence: seq, eventType: 'run-attached', entityType: 'run', entityId: workstreamRun, payload: { run } };
    });
  }

  #applyD65BootstrapGraph(request: CoordinatorRequestEnvelope, seq: number, run: CoordinationRun, resource: CoordinationRunResource, repositoryPreexisted: boolean): { readonly sequence: number; readonly eventType: string; readonly entityType: string; readonly entityId: string; readonly payload: Readonly<Record<string, unknown>> } {
    // A D65 run requires a fresh empty coordinator repository identity: a
    // pre-existing `repositories` row rejects, and the attach receipt B is
    // exactly event sequence 1.
    if (repositoryPreexisted || seq !== 1) throw new CoordinationRuntimeError('invalid-request', 'D65 bootstrap attach-run requires a fresh empty coordinator repository (attach receipt B = event 1)');
    const workstreamRun = run.workstream_run;
    const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(request.repo_id), 'bootstrap repository'));
    const mailboxCursor = mailboxCursorFromRow(asRow(this.#db.prepare('SELECT * FROM mailbox_cursors WHERE repo_id=? AND workstream_run=?').get(request.repo_id, workstreamRun), 'bootstrap mailbox cursor'));
    const canonicalRoot = repository.canonical_root;
    const git: D65GitBlobObserver = {
      resolveCommit: (revision) => {
        const resolved = this.#gitQueryText(canonicalRoot, { kind: 'resolve-commit', revision }, 'invalid-request', 'bootstrap graph commit verification failed');
        if (resolved === null || !/^[a-f0-9]{40}$/u.test(resolved)) throw new CoordinationRuntimeError('invalid-request', 'bootstrap graph commit did not resolve to a 40-hex commit', [revision, String(resolved)]);
        return resolved;
      },
      readBlob: (commit, path) => this.#readD65TrackedBlob(canonicalRoot, commit, path),
    };
    const derived = deriveD65BootstrapTransaction({
      payload: request.payload['bootstrap_graph'],
      repoId: request.repo_id,
      workstreamRun,
      attachEventSeq: seq,
      repository: Object.freeze({ ...repository }),
      run: Object.freeze({ ...run }),
      runResource: Object.freeze({ ...resource }),
      mailboxCursor: Object.freeze({ ...mailboxCursor }),
      git,
    });
    // Persist the immutable bootstrap and trust evidence bytes.
    this.#persistEvidenceArtifact(request.repo_id, derived.bootstrapGraphRef, derived.bootstrapBytes, 'semantic graph bootstrap', seq);
    this.#persistEvidenceArtifact(request.repo_id, { ref: derived.trustAnchor.trust_anchor_ref, sha256: derived.trustAnchor.trust_anchor_sha256 }, derived.trustBytes, 'operator trust anchor', seq);
    // Register the deterministic bootstrap authoritative artifact row.
    const artifact = derived.bootstrapArtifact;
    this.#db.prepare('INSERT INTO authoritative_artifacts(entity_id, repo_id, source_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(String(artifact['artifact_id']), request.repo_id, workstreamRun, canonicalJson(artifact), 1);
    return { sequence: seq, eventType: 'run-attached', entityType: 'run', entityId: workstreamRun, payload: Object.freeze({ ...derived.attachResult }) };
  }

  #readD65TrackedBlob(canonicalRoot: string, commit: string, path: string): { readonly mode: string; readonly type: 'blob'; readonly oid: string; readonly bytes: Uint8Array } {
    const listing = this.#gitQueryText(canonicalRoot, { kind: 'ls-tree-path', revision: commit, path }, 'invalid-request', 'bootstrap graph tree entry inspection failed');
    const rows = (listing ?? '').split('\0').filter((entry) => entry.length > 0);
    if (rows.length !== 1) throw new CoordinationRuntimeError('invalid-request', 'bootstrap graph path did not resolve to exactly one tracked Git blob', [path, `count=${String(rows.length)}`]);
    const match = /^([0-7]{6}) (blob) ([a-f0-9]{40})\t/u.exec(rows[0] ?? '');
    if (match === null || match[1] === undefined || match[3] === undefined) throw new CoordinationRuntimeError('invalid-request', 'bootstrap graph Git tree entry is malformed or not a blob', [path, rows[0] ?? '']);
    const shown = this.#gitQueryResult(canonicalRoot, { kind: 'show-file', revision: commit, path }, 'invalid-request', 'bootstrap graph blob is not readable at the immutable commit');
    if (shown.stdout.byteLength > MAX_COORDINATION_EVIDENCE_BYTES) throw new CoordinationRuntimeError('invalid-request', 'bootstrap graph blob exceeds the immutable evidence byte bound', [path]);
    return { mode: match[1], type: 'blob', oid: match[3], bytes: shown.stdout };
  }

  attachSession(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const workstreamRun = this.#workstreamRun(request);
      const sessionId = this.#sessionId(request);
      const run = this.#requireRun(request.repo_id, workstreamRun);
      this.#assertVersion(run.version, request.expected_version, 'run');
      if (run.status === 'closed' || run.status === 'aborted') throw new CoordinationRuntimeError('invalid-state', `terminal run ${workstreamRun} cannot accept a new parent session`);
      const terminalPreparation = this.#preparedTerminalIntent(run.repo_id, run.workstream_run);
      const pendingRecovery = this.#pendingMigrationRecovery(request.repo_id, workstreamRun);
      if (pendingRecovery.length > 0) throw new CoordinationRuntimeError('recovery-required', `run ${workstreamRun} cannot attach ordinary dispatch while migration recovery is pending; query migration-recovery for exact identities`, [`pending_count=${String(pendingRecovery.length)}`]);
      const nextGeneration = run.active_session_generation + 1;
      if (request.fencing_generation !== nextGeneration) throw new CoordinationRuntimeError('stale-version', `next session generation must be ${String(nextGeneration)}`);
      const suppliedHandoffToken = payloadNullableString(request.payload, 'handoff_token');
      const pendingHandoff = suppliedHandoffToken === null
        ? this.#db.prepare("SELECT handoff_token FROM handoffs WHERE repo_id=? AND workstream_run=? AND status='pending' ORDER BY created_event_seq DESC LIMIT 1").get(request.repo_id, workstreamRun)
        : this.#db.prepare("SELECT handoff_token FROM handoffs WHERE handoff_token=? AND repo_id=? AND workstream_run=? AND status='pending'").get(suppliedHandoffToken, request.repo_id, workstreamRun);
      if (suppliedHandoffToken !== null && pendingHandoff === undefined) throw new CoordinationRuntimeError('fenced-session', 'handoff token is missing, consumed, or belongs to another run');
      const effectiveHandoffToken = pendingHandoff === undefined ? null : sqlString(pendingHandoff, 'handoff_token');
      let parentLossCandidateSha256: `sha256:${string}` | null = null;
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) {
        if (effectiveHandoffToken === null) {
          // The exact-once null-handoff parent-loss attach: transaction-time
          // no-follow/signature/digest/request equality against the fixed
          // policy-root candidate. It records the candidate digest, fences the
          // old row, creates the named next generation, and suppresses baseline
          // reconciliation; any mismatch rolls back all rows.
          parentLossCandidateSha256 = this.#verifyD65ParentLossAttach(request, run, nextGeneration, sessionId);
        } else {
          const handoff = asRow(this.#db.prepare("SELECT from_session_lease_id FROM handoffs WHERE handoff_token=? AND repo_id=? AND workstream_run=? AND status='pending'").get(effectiveHandoffToken, run.repo_id, run.workstream_run), 'D65 planned handoff');
          const predecessor = sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(sqlString(handoff, 'from_session_lease_id')), 'D65 planned handoff predecessor'));
          const context: D65DispatchAuthorityRequestContext = Object.freeze({ expected_version: run.version, session_lease_id: predecessor.session_lease_id, session_id: predecessor.session_id, session_generation: predecessor.session_generation });
          this.#assertD65RecoveryMutationAllowed(request, run, 'planned-handoff', { attached_session_current: true, policy_trust_current: true, no_pending_publication: true, terminal_prepared_cancellable: false, terminal_after_commit: false, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false }, context, true);
          // Planned turnover is preauthorized by one registered continuation
          // already included in the accepted graph. The continuation names the
          // predecessor and the proposed successor lease; every handoff evidence
          // ref is itself present in that graph. A token row alone is not
          // semantic successor authority.
          const proposedLeaseId = payloadString(request.payload, 'session_lease_id');
          const continuationRows = this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.continuation_event.v1' ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(authoritativeArtifactFromRow).map((artifact) => ({ artifact, continuation: parseD65ContinuationEvent(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(run.repo_id, artifact.evidence)), 'planned handoff continuation')) })).filter((entry) => entry.continuation.trigger === 'planned-turnover' && entry.continuation.class === 'handoff-pending' && entry.continuation.session_lease_id === predecessor.session_lease_id && entry.continuation.successor_id === proposedLeaseId);
          const planned = continuationRows[0];
          if (continuationRows.length !== 1 || planned === undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 planned handoff requires one accepted successor continuation bound to its durable handoff token row', [predecessor.session_lease_id, proposedLeaseId, `count=${String(continuationRows.length)}`]);
          const graphHead = this.#d65AcceptedGraphHead(run.repo_id, run.workstream_run);
          const graph = parseD65CompleteGraph(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(run.repo_id, graphHead.artifact.evidence)), 'planned handoff accepted graph'));
          const resource = runResourceFromRow(asRow(this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run), 'planned handoff resource'));
          const loaded = loadD65CompleteGraph(graph, (ref) => this.#readD65GraphShardBlob(resource.main_worktree_path, graphHead.artifact.git_commit, ref));
          const authorityEntries = Object.values(loaded.authorities).flatMap((collection) => collection.entries);
          const included = (ref: string, sha256: string, byteCount: number, schema: string | null): boolean => authorityEntries.filter((entry) => entry.ref === ref && entry.sha256 === sha256 && entry.byte_count === byteCount && entry.document_schema_version === schema).length === 1;
          const plannedBytes = this.#loadEvidenceArtifact(run.repo_id, planned.artifact.evidence);
          if (!included(planned.artifact.evidence.ref, planned.artifact.evidence.sha256, plannedBytes.byteLength, 'autopilot.continuation_event.v1') || planned.continuation.evidence_refs.some((evidence) => !included(evidence.ref, evidence.sha256, evidence.byte_count, null))) throw new CoordinationRuntimeError('invalid-state', 'D65 planned handoff continuation/evidence is not exactly included in the accepted graph');
          if (planned.continuation.result_graph_sequence !== graph.graph_sequence) throw new CoordinationRuntimeError('invalid-state', 'D65 planned handoff continuation does not name the accepted result graph sequence', [String(planned.continuation.result_graph_sequence), String(graph.graph_sequence)]);
          const heartbeatHead = this.#highestAcceptedProgramHeartbeat(run.repo_id, run.workstream_run);
          if (heartbeatHead === null) throw new CoordinationRuntimeError('invalid-state', 'D65 planned handoff lacks a governing heartbeat');
          const heartbeat = this.#d65VerifyAcceptedHeartbeatHead(heartbeatHead, this.#d65AcceptedLaunchPolicy(run.repo_id, run.workstream_run), run, this.#clock.now().toISOString());
          if (!heartbeat.governingCurrent || heartbeat.row.last_handoff_sha256 !== planned.artifact.evidence.sha256) throw new CoordinationRuntimeError('invalid-state', 'D65 planned handoff heartbeat does not bind the accepted continuation digest', [String(heartbeat.row.last_handoff_sha256), planned.artifact.evidence.sha256]);
        }
      }
      const seq = this.#nextEventSequence(request.repo_id);
      this.#db.prepare("UPDATE session_leases SET status='fenced', version=version+1 WHERE repo_id=? AND workstream_run=? AND status='attached'").run(request.repo_id, workstreamRun);
      if (effectiveHandoffToken !== null) {
        this.#db.prepare("UPDATE session_leases SET status='detached', version=version+1 WHERE session_lease_id=(SELECT from_session_lease_id FROM handoffs WHERE handoff_token=?)").run(effectiveHandoffToken);
        this.#db.prepare("UPDATE handoffs SET status='consumed', consumed_event_seq=? WHERE handoff_token=?").run(seq, effectiveHandoffToken);
      }
      const sessionTokenSha256 = createHash('sha256').update(payloadString(request.payload, 'session_token'), 'utf8').digest('hex');
      this.#db.prepare("INSERT INTO session_leases(session_lease_id, repo_id, workstream_run, session_id, session_generation, pid, boot_id, session_token_sha256, lease_expires_at, status, attached_event_seq, version, attachment_kind) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, 1, 'dispatch')").run(
        payloadString(request.payload, 'session_lease_id'), request.repo_id, workstreamRun, sessionId, nextGeneration,
        payloadInteger(request.payload, 'pid'), payloadString(request.payload, 'boot_id'), sessionTokenSha256, payloadString(request.payload, 'lease_expires_at'), seq,
      );
      this.#db.prepare('UPDATE runs SET active_session_generation=?, status=?, version=version+1 WHERE repo_id=? AND workstream_run=?').run(nextGeneration, terminalPreparation === null ? 'active' : 'merging', request.repo_id, workstreamRun);
      const nextRun = this.#requireRun(request.repo_id, workstreamRun);
      const session = sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(payloadString(request.payload, 'session_lease_id')), 'attached session'));
      const reconciliation = !this.#hasD65CompleteGraph(request.repo_id, workstreamRun) && this.#activeRunFaults(request.repo_id, workstreamRun).length === 0
        ? this.#reconcileOwnedRun(request.repo_id, workstreamRun, seq)
        : this.#freezeReconciliationSummary(this.#emptyReconciliationSummary());
      const reconciliationReceipt = this.#persistReconciliationReceipt(request.repo_id, workstreamRun, request.action, seq, reconciliation);
      // The parent-loss branch records the exact verified candidate digest in
      // the immutable session-attached event/result; a planned/legacy attach
      // carries no candidate field.
      const attachPayload = parentLossCandidateSha256 === null
        ? { run: nextRun, session, ...this.#reconciliationReceiptPayload(reconciliationReceipt) }
        : { run: nextRun, session, parent_loss_candidate_sha256: parentLossCandidateSha256, ...this.#reconciliationReceiptPayload(reconciliationReceipt) };
      return { sequence: seq, eventType: 'session-attached', entityType: 'session-lease', entityId: session.session_lease_id, payload: attachPayload };
    });
  }

  /**
   * The exact-once D65 parent-loss attach verifier (fresh plan §3.1 parent-loss
   * row; freeze §9.4). Inside the unchanged-request attach-session transaction
   * it resolves the policy-bound evidence-root realpath, opens ONLY the fixed
   * candidate with no-follow/one-link/mode-0600 descriptor checks, verifies
   * SPKI/signature/program/run identity, exact current graph/policy/heartbeat
   * digests, the lost attached-but-expired row, the proposed request session/
   * lease/generation/PID/boot identity, one unused budget, and zero pending
   * handoff. Returns the candidate digest recorded in `session-attached`.
   * Any mismatch throws and the surrounding transaction rolls back all rows.
   */
  #verifyD65ParentLossAttach(request: CoordinatorRequestEnvelope, run: CoordinationRun, nextGeneration: number, sessionId: string): `sha256:${string}` {
    const invalid = (issue: string, evidence: readonly string[] = []): never => { throw new CoordinationRuntimeError('recovery-required', `parent-loss-attach-invalid: ${issue}`, evidence); };
    // Zero pending handoff is a precondition (the caller reaches here only with
    // no pending handoff token, but a pending row for this run still rejects).
    if (this.#db.prepare("SELECT handoff_token FROM handoffs WHERE repo_id=? AND workstream_run=? AND status='pending' LIMIT 1").get(run.repo_id, run.workstream_run) !== undefined) invalid('parent-loss attach requires zero pending handoff');
    const acceptedPolicy = this.#d65AcceptedLaunchPolicy(run.repo_id, run.workstream_run);
    const root = realpathSync(acceptedPolicy.policy.program_evidence_root);
    if (root !== acceptedPolicy.policy.program_evidence_root) invalid('program evidence root is no longer its canonical real path', [acceptedPolicy.policy.program_evidence_root]);
    const candidatePath = resolve(root, 'parent-loss', run.workstream_run, 'candidate.json');
    const relCandidate = relative(root, candidatePath);
    if (relCandidate.length === 0 || relCandidate === '..' || relCandidate.startsWith(`..${sep}`) || isAbsolute(relCandidate)) invalid('parent-loss candidate path escapes the policy evidence root');
    const bytes = this.#readD65ExternalPrivateFile(candidatePath, 'D65 parent-loss candidate');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as `sha256:${string}`;
    let candidate: ReturnType<typeof parseD65ParentLoss>;
    try { candidate = parseD65ParentLoss(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'D65 parent-loss candidate')); }
    catch (error) { return invalid('parent-loss candidate is malformed', [error instanceof Error ? error.message : String(error)]); }
    // Purpose-domain signature over RFC 8785 bytes of every field except signature.
    const { signature: _signature, ...unsigned } = candidate;
    void _signature;
    if (candidate.trust_anchor_ref !== acceptedPolicy.policy.trust_anchor_ref || candidate.trust_anchor_sha256 !== acceptedPolicy.policy.trust_anchor_sha256 || candidate.signer_key_id !== acceptedPolicy.anchor.sha256) invalid('parent-loss candidate trust tuple does not equal accepted policy authority');
    if (!verifyD65Signature({ trustAnchor: acceptedPolicy.anchor, purpose: 'parent-loss', message: new TextEncoder().encode(canonicalJson(unsigned)), signature: candidate.signature })) invalid('parent-loss candidate signature is not valid for the accepted trust anchor');
    if (candidate.program_id !== acceptedPolicy.policy.program_id || candidate.repo_id !== run.repo_id || candidate.workstream_run !== run.workstream_run) invalid('parent-loss candidate program/run identity mismatch');
    // One unused budget FIRST: repeated/candidate-replay no-handoff loss is
    // parent-recovery-exhausted regardless of the later predecessor state.
    const consumed = this.#db.prepare("SELECT r.idempotency_key FROM idempotency_results r JOIN events e ON e.repo_id=r.repo_id AND e.idempotency_key=r.idempotency_key WHERE r.repo_id=? AND e.event_type='session-attached' AND json_extract(r.payload_json, '$.parent_loss_candidate_sha256')=? LIMIT 1").get(run.repo_id, digest) !== undefined;
    if (consumed) throw new CoordinationRuntimeError('recovery-required', 'parent-recovery-exhausted: parent-loss candidate was already consumed by a prior attach', [digest]);
    // Exact current graph/policy/heartbeat bytes and identities — digest-only
    // comparison is insufficient because a signed candidate could otherwise
    // cite an alternate ref or byte count for the same hash.
    const graphHead = this.#d65AcceptedGraphHead(run.repo_id, run.workstream_run);
    const graphBytes = this.#loadEvidenceArtifact(run.repo_id, graphHead.artifact.evidence);
    if (candidate.last_graph.ref !== graphHead.artifact.evidence.ref || candidate.last_graph.sha256 !== graphHead.sha256 || candidate.last_graph.byte_count !== graphBytes.byteLength) invalid('parent-loss candidate does not name the exact current accepted graph evidence tuple', [candidate.last_graph.ref, graphHead.artifact.evidence.ref, candidate.last_graph.sha256, graphHead.sha256]);
    const policyBytes = this.#loadEvidenceArtifact(run.repo_id, acceptedPolicy.artifact.evidence);
    if (candidate.last_policy.ref !== acceptedPolicy.artifact.evidence.ref || candidate.last_policy.sha256 !== acceptedPolicy.artifact.evidence.sha256 || candidate.last_policy.byte_count !== policyBytes.byteLength) invalid('parent-loss candidate does not name the exact accepted launch policy evidence tuple');
    const head = this.#highestAcceptedProgramHeartbeat(run.repo_id, run.workstream_run);
    if (head === null) return invalid('parent-loss candidate requires an accepted governing heartbeat');
    const heartbeatPath = this.#d65ExternalHeartbeatPath(acceptedPolicy.policy, head.heartbeat_ref);
    const heartbeatBytes = this.#readD65ExternalPrivateFile(heartbeatPath, 'D65 parent-loss governing heartbeat');
    if (candidate.last_heartbeat.ref !== head.heartbeat_ref || candidate.last_heartbeat.sha256 !== head.heartbeat_sha256 || candidate.last_heartbeat.byte_count !== heartbeatBytes.byteLength) invalid('parent-loss candidate does not name the exact highest accepted heartbeat evidence tuple');
    // Lost attached-but-expired predecessor row and its signed coordinator
    // identity. The package identity object is already closed/bounded by the
    // parent-loss parser; these non-null coordinator fields must equal the sole
    // residual predecessor rather than remaining caller-selected prose.
    const attachedRows = this.#db.prepare("SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? AND status='attached' AND session_generation=? AND attachment_kind='dispatch'").all(run.repo_id, run.workstream_run, run.active_session_generation).map(sessionFromRow);
    const lost = attachedRows[0];
    if (attachedRows.length !== 1 || lost === undefined) return invalid('parent-loss attach requires exactly one residual attached predecessor session');
    const lostIdentity = candidate.lost_coordinator_session_identity;
    if (lostIdentity['session_id'] !== lost.session_id || lostIdentity['pid'] !== lost.pid || lostIdentity['boot_id'] !== lost.boot_id) invalid('parent-loss candidate lost coordinator identity does not equal the residual predecessor session');
    const sampledAt = this.#clock.now().toISOString();
    if (Date.parse(lost.lease_expires_at) >= Date.parse(sampledAt)) invalid('parent-loss predecessor session lease has not expired at coordinator time', [lost.lease_expires_at, sampledAt]);
    const verifiedHeartbeat = this.#d65VerifyAcceptedHeartbeatHead(head, acceptedPolicy, run, sampledAt);
    const heartbeatReasons = verifiedHeartbeat.row.stop_reasons;
    if (!verifiedHeartbeat.governingCurrent || verifiedHeartbeat.heartbeat.stop_reasons.length !== 0 || !heartbeatReasons.includes('parent-recovering') || heartbeatReasons.some((reason) => reason !== 'parent-recovering' && reason !== 'provider-blocked' && reason !== 'provider-exhausted') || heartbeatReasons.filter((reason) => reason === 'provider-blocked' || reason === 'provider-exhausted').length > 1) invalid('parent-loss attach requires the exact current governing parent-recovering heartbeat cell', [...heartbeatReasons]);
    // The signed status/doctor evidence files are policy-root relative, private,
    // byte-bound records of successful authenticated query envelopes. Their
    // semantic digests must still equal this unchanged transaction boundary.
    const readObservation = (evidence: typeof candidate.status_ref, label: 'status' | 'doctor'): CoordinatorResponseEnvelope => {
      const observationPath = resolve(root, evidence.ref);
      const observationRel = relative(root, observationPath);
      if (observationRel.length === 0 || observationRel === '..' || observationRel.startsWith(`..${sep}`) || isAbsolute(observationRel)) invalid(`${label} evidence ref escapes the policy evidence root`, [evidence.ref]);
      const observationBytes = this.#readD65ExternalPrivateFile(observationPath, `D65 parent-loss ${label} evidence`);
      const actual = `sha256:${createHash('sha256').update(observationBytes).digest('hex')}`;
      if (actual !== evidence.sha256 || observationBytes.byteLength !== evidence.byte_count) invalid(`${label} evidence bytes do not equal the signed parent-loss tuple`, [evidence.ref, evidence.sha256, actual]);
      let response: CoordinatorResponseEnvelope;
      try { response = parseCoordinatorResponseEnvelope(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(observationBytes), `D65 parent-loss ${label} evidence`)); }
      catch (error) { return invalid(`${label} evidence is not a closed coordinator response`, [error instanceof Error ? error.message : String(error)]); }
      if (!response.ok || response.committed_event_seq !== null || response.error_code !== null || response.retryable) invalid(`${label} evidence is not a successful read-only coordinator response`);
      return response;
    };
    const statusObservation = readObservation(candidate.status_ref, 'status');
    const doctorObservation = readObservation(candidate.doctor_ref, 'doctor');
    const statusDigest = this.#d65CurrentSemanticEndpointDigest('status', run.repo_id, run.workstream_run, sampledAt);
    const doctorDigest = this.#d65CurrentSemanticEndpointDigest('doctor', run.repo_id, run.workstream_run, sampledAt);
    if (statusObservation.payload['semantic_snapshot_sha256'] !== statusDigest || doctorObservation.payload['semantic_snapshot_sha256'] !== doctorDigest) invalid('parent-loss status/doctor evidence no longer equals current coordinator semantic authority', [String(statusObservation.payload['semantic_snapshot_sha256']), statusDigest, String(doctorObservation.payload['semantic_snapshot_sha256']), doctorDigest]);
    const statusRuns = statusObservation.payload['runs'];
    if (!Array.isArray(statusRuns) || statusRuns.length !== 1 || parseCoordinationRun(statusRuns[0]).workstream_run !== run.workstream_run) invalid('parent-loss status evidence does not contain the exact coordinator run');
    const statusTime = statusObservation.payload['coordinator_time'];
    const doctorTime = doctorObservation.payload['coordinator_time'];
    if (typeof statusTime !== 'string' || typeof doctorTime !== 'string' || Date.parse(statusTime) > Date.parse(doctorTime) || Date.parse(doctorTime) - Date.parse(statusTime) > 5_000 || Date.parse(doctorTime) > Date.parse(candidate.observed_at) || Date.parse(candidate.observed_at) > Date.parse(candidate.issued_at) || Date.parse(candidate.issued_at) > Date.parse(sampledAt)) invalid('parent-loss observation/issue times are not an ordered current coordinator sample', [String(statusTime), String(doctorTime), candidate.observed_at, candidate.issued_at, sampledAt]);
    // Proposed request identity must equal the sealed successor tuple.
    const proposedLeaseId = payloadString(request.payload, 'session_lease_id');
    const proposedPid = payloadInteger(request.payload, 'pid');
    const proposedBootId = payloadString(request.payload, 'boot_id');
    if (candidate.successor_session_id !== sessionId || candidate.successor_session_lease_id !== proposedLeaseId || candidate.successor_generation !== nextGeneration || candidate.successor_pid !== proposedPid || candidate.successor_boot_id !== proposedBootId) invalid('parent-loss candidate successor identity does not equal the attach request', [candidate.successor_session_id, sessionId, String(candidate.successor_generation), String(nextGeneration)]);
    return digest;
  }

  attachTerminalRecovery(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const workstreamRun = this.#workstreamRun(request);
      const sessionId = this.#sessionId(request);
      const run = this.#requireRun(request.repo_id, workstreamRun);
      this.#assertVersion(run.version, request.expected_version, 'terminal recovery run');
      if (run.status !== 'closed' && run.status !== 'aborted') throw new CoordinationRuntimeError('invalid-state', `nonterminal run ${workstreamRun} cannot accept a terminal-cleanup recovery attachment`);
      const intent = runTerminalIntentFromRow(asRow(this.#db.prepare("SELECT * FROM run_terminal_intents WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.state')='committed' ORDER BY entity_id LIMIT 1").get(request.repo_id, workstreamRun), 'committed terminal recovery intent'));
      if (intent.terminal_intent_id !== payloadString(request.payload, 'terminal_intent_id')) throw new CoordinationRuntimeError('unauthorized-client', 'terminal-cleanup recovery attachment does not match the committed terminal intent');
      if ((run.status === 'closed' ? 'closed' : 'aborted') !== intent.outcome) throw new CoordinationRuntimeError('store-corrupt', 'terminal run status disagrees with its committed terminal intent');
      const rawIntent = parseJsonObject(sqlString(asRow(this.#db.prepare('SELECT payload_json FROM run_terminal_intents WHERE repo_id=? AND entity_id=?').get(request.repo_id, intent.terminal_intent_id), 'terminal recovery intent schema'), 'payload_json'), 'terminal recovery intent schema');
      if (rawIntent['schema_version'] !== 'autopilot.run_terminal_intent.v2') return this.#applyLegacyTerminalRecoveryAttachment(request, run, intent, sessionId);
      this.#assertD65TerminalTailPrefix(run);
      this.#assertD65RecoveryMutationAllowed(request, run, 'terminal-tail', { attached_session_current: false, policy_trust_current: true, no_pending_publication: true, terminal_prepared_cancellable: false, terminal_after_commit: true, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: true });
      const mainRows = this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND kind='main' AND unit_id='main' AND is_current_canonical=1").all(request.repo_id, workstreamRun).map(canonicalWorktreeFromRow);
      if (mainRows.length !== 1 || mainRows[0] === undefined || mainRows[0].state !== 'removed') throw new CoordinationRuntimeError('invalid-state', 'D65 terminal recovery is admitted only after exact main-worktree removal');
      const predecessorRows = this.#db.prepare("SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? AND status IN ('attached','handoff-pending') ORDER BY session_generation").all(request.repo_id, workstreamRun);
      if (predecessorRows.length !== 1 || predecessorRows[0] === undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal recovery requires exactly one residual attached predecessor session');
      const predecessor = sessionFromRow(predecessorRows[0]);
      const sampledAt = this.#clock.now().toISOString();
      if (predecessor.status !== 'attached' || Date.parse(predecessor.lease_expires_at) >= Date.parse(sampledAt)) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal recovery predecessor must be attached and expired at coordinator time');
      const residualCount = sqlInteger(asRow(this.#db.prepare("SELECT (SELECT COUNT(*) FROM child_leases WHERE repo_id=? AND workstream_run=? AND status IN ('preflight','running','recovery-required')) + (SELECT COUNT(*) FROM edit_leases WHERE repo_id=? AND workstream_run=?) + (SELECT COUNT(*) FROM change_reservations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.released_event_seq') IS NULL) + (SELECT COUNT(*) FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.stage') NOT IN ('committed','compensated','failed')) AS count").get(request.repo_id, workstreamRun, request.repo_id, workstreamRun, request.repo_id, workstreamRun, request.repo_id, workstreamRun), 'terminal recovery residual count'), 'count');
      if (residualCount !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal recovery found authority beyond the sole expired predecessor session', [`count=${String(residualCount)}`]);
      const nextGeneration = run.active_session_generation + 1;
      if (request.fencing_generation !== nextGeneration) throw new CoordinationRuntimeError('stale-version', `next terminal recovery generation must be ${String(nextGeneration)}`);
      const attachSeq = this.#nextEventSequence(request.repo_id);
      this.#db.prepare("UPDATE session_leases SET status='fenced', version=version+1 WHERE session_lease_id=?").run(predecessor.session_lease_id);
      const fencedPredecessor = sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(predecessor.session_lease_id), 'fenced terminal recovery predecessor'));
      if (fencedPredecessor.status !== 'fenced' || fencedPredecessor.version !== predecessor.version + 1) throw new CoordinationRuntimeError('store-corrupt', 'D65 terminal recovery did not exactly fence its expired predecessor');
      const sessionTokenSha256 = createHash('sha256').update(payloadString(request.payload, 'session_token'), 'utf8').digest('hex');
      this.#db.prepare("INSERT INTO session_leases(session_lease_id, repo_id, workstream_run, session_id, session_generation, pid, boot_id, session_token_sha256, lease_expires_at, status, attached_event_seq, version, attachment_kind) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, 1, 'terminal-recovery')").run(payloadString(request.payload, 'session_lease_id'), request.repo_id, workstreamRun, sessionId, nextGeneration, payloadInteger(request.payload, 'pid'), payloadString(request.payload, 'boot_id'), sessionTokenSha256, payloadString(request.payload, 'lease_expires_at'), attachSeq);
      this.#db.prepare('UPDATE runs SET active_session_generation=?, version=version+1 WHERE repo_id=? AND workstream_run=?').run(nextGeneration, request.repo_id, workstreamRun);
      const nextRun = this.#requireRun(request.repo_id, workstreamRun);
      const attached = sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(payloadString(request.payload, 'session_lease_id')), 'attached terminal recovery session'));
      const digest = requestDigest(request);
      const internalKey = `terminal-recovery-attach:${createHash('sha256').update(String(request.idempotency_key), 'utf8').digest('hex')}`;
      const attachedPayload = this.#commitDescription(attachSeq, 'terminal-cleanup-recovery-attached', 'session-lease', attached.session_lease_id, { run: nextRun, session: attached, predecessor_session: fencedPredecessor, terminal_intent: intent }).payload;
      this.#insertEvent.run(request.repo_id, attachSeq, 'terminal-cleanup-recovery-attached', 'session-lease', attached.session_lease_id, internalKey, digest, sampledAt);
      this.#insertIdempotencyResult.run(request.repo_id, internalKey, digest, attachSeq, canonicalJson(attachedPayload));
      const detachSeq = this.#nextEventSequence(request.repo_id);
      this.#db.prepare("UPDATE session_leases SET status='detached', version=version+1 WHERE session_lease_id=?").run(attached.session_lease_id);
      const detached = sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(attached.session_lease_id), 'detached terminal recovery session'));
      return { sequence: detachSeq, eventType: 'session-detached', entityType: 'session-lease', entityId: detached.session_lease_id, payload: { run: nextRun, session: detached, terminal_intent: intent, reason: 'terminal-recovery-immediate-detach' }, occurredAt: sampledAt, suppressWaitGraphMaintenance: true };
    });
  }

  #applyLegacyTerminalRecoveryAttachment(request: CoordinatorRequestEnvelope, run: CoordinationRun, intent: CoordinationRunTerminalIntent, sessionId: string): { readonly sequence: number; readonly eventType: string; readonly entityType: string; readonly entityId: string; readonly payload: Readonly<Record<string, unknown>> } {
    const workstreamRun = run.workstream_run;
    const mainRows = this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND kind='main' AND unit_id='main' AND is_current_canonical=1").all(request.repo_id, workstreamRun).map(canonicalWorktreeFromRow);
    if (mainRows.length !== 1 || mainRows[0] === undefined) throw new CoordinationRuntimeError('store-corrupt', 'terminal-cleanup recovery requires exactly one durable main worktree');
    if (mainRows[0].state === 'removed') throw new CoordinationRuntimeError('invalid-state', 'terminal-cleanup recovery is already complete');
    const nextGeneration = run.active_session_generation + 1;
    if (request.fencing_generation !== nextGeneration) throw new CoordinationRuntimeError('stale-version', `next terminal recovery generation must be ${String(nextGeneration)}`);
    const seq = this.#nextEventSequence(request.repo_id);
    this.#db.prepare("UPDATE session_leases SET status='fenced', version=version+1 WHERE repo_id=? AND workstream_run=? AND status IN ('attached','handoff-pending')").run(request.repo_id, workstreamRun);
    const sessionTokenSha256 = createHash('sha256').update(payloadString(request.payload, 'session_token'), 'utf8').digest('hex');
    this.#db.prepare("INSERT INTO session_leases(session_lease_id, repo_id, workstream_run, session_id, session_generation, pid, boot_id, session_token_sha256, lease_expires_at, status, attached_event_seq, version, attachment_kind) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, 1, 'terminal-recovery')").run(payloadString(request.payload, 'session_lease_id'), request.repo_id, workstreamRun, sessionId, nextGeneration, payloadInteger(request.payload, 'pid'), payloadString(request.payload, 'boot_id'), sessionTokenSha256, payloadString(request.payload, 'lease_expires_at'), seq);
    this.#db.prepare('UPDATE runs SET active_session_generation=?, version=version+1 WHERE repo_id=? AND workstream_run=?').run(nextGeneration, request.repo_id, workstreamRun);
    const nextRun = this.#requireRun(request.repo_id, workstreamRun);
    const session = sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(payloadString(request.payload, 'session_lease_id')), 'attached terminal recovery session'));
    const reconciliation = this.#activeRunFaults(request.repo_id, workstreamRun).length === 0 ? this.#reconcileOwnedRun(request.repo_id, workstreamRun, seq) : this.#freezeReconciliationSummary(this.#emptyReconciliationSummary());
    const receipt = this.#persistReconciliationReceipt(request.repo_id, workstreamRun, request.action, seq, reconciliation);
    return { sequence: seq, eventType: 'terminal-cleanup-recovery-attached', entityType: 'session-lease', entityId: session.session_lease_id, payload: { run: nextRun, session, ...this.#reconciliationReceiptPayload(receipt), terminal_intent: intent } };
  }

  attachMigrationRecovery(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const workstreamRun = this.#workstreamRun(request);
      const sessionId = this.#sessionId(request);
      const run = this.#requireRun(request.repo_id, workstreamRun);
      this.#assertVersion(run.version, request.expected_version, 'migration recovery run');
      if (this.#isD65Run(run.repo_id, run.workstream_run)) throw new CoordinationRuntimeError('invalid-state', 'D65 complete-mode has no migration-recovery attachment cell');
      this.#requireCoordinatorEditAuthority(run, 'migration recovery attachment');
      const recoveryId = payloadString(request.payload, 'recovery_id');
      const exactPending = this.#db.prepare("SELECT entity_id FROM migration_recovery_work WHERE entity_id=? AND repo_id=? AND workstream_run=? AND status='pending'").get(recoveryId, request.repo_id, workstreamRun);
      if (exactPending === undefined) throw new CoordinationRuntimeError('invalid-state', 'migration recovery attachment requires the exact pending recovery row', [recoveryId]);
      const nextGeneration = run.active_session_generation + 1;
      if (request.fencing_generation !== nextGeneration) throw new CoordinationRuntimeError('stale-version', `next migration recovery generation must be ${String(nextGeneration)}`);
      const seq = this.#nextEventSequence(request.repo_id);
      this.#db.prepare("UPDATE session_leases SET status='fenced', version=version+1 WHERE repo_id=? AND workstream_run=? AND status IN ('attached','handoff-pending')").run(request.repo_id, workstreamRun);
      const sessionTokenSha256 = createHash('sha256').update(payloadString(request.payload, 'session_token'), 'utf8').digest('hex');
      this.#db.prepare("INSERT INTO session_leases(session_lease_id, repo_id, workstream_run, session_id, session_generation, pid, boot_id, session_token_sha256, lease_expires_at, status, attached_event_seq, version, attachment_kind) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, 1, 'migration-recovery')").run(
        payloadString(request.payload, 'session_lease_id'), request.repo_id, workstreamRun, sessionId, nextGeneration,
        payloadInteger(request.payload, 'pid'), payloadString(request.payload, 'boot_id'), sessionTokenSha256, payloadString(request.payload, 'lease_expires_at'), seq,
      );
      this.#db.prepare('UPDATE runs SET active_session_generation=?, version=version+1 WHERE repo_id=? AND workstream_run=?').run(nextGeneration, request.repo_id, workstreamRun);
      const nextRun = this.#requireRun(request.repo_id, workstreamRun);
      const session = sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(payloadString(request.payload, 'session_lease_id')), 'attached migration recovery session'));
      const pendingRecoveryCount = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND status='pending'").get(request.repo_id, workstreamRun), 'migration recovery attachment pending count'), 'count');
      return { sequence: seq, eventType: 'migration-recovery-attached', entityType: 'session-lease', entityId: session.session_lease_id, payload: { run: nextRun, session, pending_recovery_count: pendingRecoveryCount } };
    });
  }

  resolveMigrationRecovery(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const session = this.#requireCurrentSession(request);
      if (session.attachment_kind !== 'migration-recovery') throw new CoordinationRuntimeError('unauthorized-client', 'migration recovery resolution requires a recovery-only supervisor session');
      const recoveryId = payloadString(request.payload, 'recovery_id');
      const row = asRow(this.#db.prepare('SELECT * FROM migration_recovery_work WHERE entity_id=? AND repo_id=? AND workstream_run=?').get(recoveryId, request.repo_id, this.#workstreamRun(request)), 'migration recovery work');
      const work = migrationRecoveryFromRow(row);
      this.#assertVersion(work.version, request.expected_version, 'migration recovery work');
      if (work.status !== 'pending') throw new CoordinationRuntimeError('invalid-state', 'migration recovery work is already terminal; use the original idempotency key to replay its result', [recoveryId]);
      if (work.recovery_type !== 'ambiguous-live-claim') throw new CoordinationRuntimeError('recovery-required', `recovery type ${work.recovery_type} has no safe authority mutation`, [recoveryId]);
      const run = this.#requireRun(request.repo_id, work.workstream_run);
      if (this.#isD65Run(run.repo_id, run.workstream_run)) throw new CoordinationRuntimeError('invalid-state', 'D65 complete-mode has no migration-recovery resolution cell');
      const claim = this.#migrationRecoveryClaim(work);
      const leases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(request.repo_id, work.workstream_run).map(editLeaseFromRow).filter((lease) => lease.edit_lease_id === claim.editLeaseId && lease.owner.unit_id === claim.unitId && lease.owner.attempt === claim.attempt && lease.path === claim.path && lease.mode === claim.mode);
      if (leases.length !== 1 || leases[0] === undefined) throw new CoordinationRuntimeError('store-corrupt', 'pending migration recovery no longer has exactly one matching imported authority lease', [recoveryId, claim.editLeaseId]);
      const evidence = { ref: payloadString(request.payload, 'evidence_ref'), sha256: payloadString(request.payload, 'evidence_sha256') as `sha256:${string}` };
      const resolutionType = payloadString(request.payload, 'resolution_type');
      if (resolutionType === 'authority-released') this.#assertAuthorityCriticalMutationAllowed(run.repo_id, run.workstream_run, 'migration recovery authority release');
      const releaseSourceValue = payloadNullableString(request.payload, 'release_source');
      const releaseTargetId = payloadNullableString(request.payload, 'release_target_id');
      const seq = this.#nextEventSequence(request.repo_id);
      let exactPostconditions: readonly string[];
      if (resolutionType === 'authority-retained') {
        if (releaseSourceValue !== null || releaseTargetId !== null) throw new CoordinationRuntimeError('invalid-request', 'authority-retained recovery cannot carry release identity');
        if (run.status === 'closed' || run.status === 'aborted') throw new CoordinationRuntimeError('invalid-state', 'terminal run authority cannot be retained or resurrected during migration recovery', [run.workstream_run]);
        const attempt = this.#requireUnitAttempt(run.repo_id, run.workstream_run, claim.unitId, claim.attempt);
        if (['transport-complete', 'merged', 'failed', 'reset', 'quarantined', 'superseded'].includes(attempt.state)) throw new CoordinationRuntimeError('invalid-state', 'terminal attempt authority cannot be retained or resurrected during migration recovery', [claim.unitId, String(claim.attempt), attempt.state]);
        this.#verifyMigrationRetentionEvidence(run, work, claim, evidence);
        exactPostconditions = Object.freeze([`run-status:${run.status}`, `attempt-state:${attempt.state}`, `edit-lease-retained:${claim.editLeaseId}`, `claim:${claim.mode}:${claim.path}`]);
      } else if (resolutionType === 'authority-released') {
        if (releaseSourceValue === null || releaseTargetId === null || releaseSourceValue === 'child-process') throw new CoordinationRuntimeError('invalid-request', 'authority-released recovery requires an exact parent-owned release source and target');
        const releaseSource = releaseSourceValue as Exclude<CoordinationReconciliationSource, 'child-process'>;
        exactPostconditions = this.#verifyMigrationReleasePostconditions(run, work, claim, releaseSource, releaseTargetId, evidence);
        const released: string[] = [];
        this.#releaseOwnedLease(run.repo_id, run.workstream_run, claim.editLeaseId, released);
        if (released.length !== 1 || released[0] !== claim.editLeaseId) throw new CoordinationRuntimeError('store-corrupt', 'exact migration authority lease was not released atomically', [claim.editLeaseId]);
      } else {
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
      if (updated.changes !== 1) throw new CoordinationRuntimeError('coordinator-contention', 'migration recovery work changed during fenced resolution', [recoveryId]);
      this.#db.prepare("UPDATE messages SET status='acknowledged', delivered_event_seq=COALESCE(delivered_event_seq, ?), acknowledged_event_seq=COALESCE(acknowledged_event_seq, ?), version=version+1 WHERE repo_id=? AND recipient_workstream_run=? AND correlation_id=? AND status!='acknowledged'").run(seq, seq, run.repo_id, run.workstream_run, recoveryId);
      this.#advanceMailboxCursor(run.repo_id, run.workstream_run, 'acknowledged');
      const remainingRecoveryCount = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND status='pending'").get(run.repo_id, run.workstream_run), 'remaining migration recovery count'), 'count');
      return { sequence: seq, eventType: 'migration-recovery-resolved', entityType: 'migration-recovery-work', entityId: recoveryId, payload: { recovery_work: parsed, remaining_recovery_count: remainingRecoveryCount, run: this.#requireRun(run.repo_id, run.workstream_run) } };
    });
  }

  detachSession(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#sessionMutation(request, 'session-detached', (session, seq) => {
      const run = this.#requireRun(request.repo_id, session.workstream_run);
      if (this.#isD65Run(run.repo_id, run.workstream_run) && (run.status === 'closed' || run.status === 'aborted')) {
        this.#assertD65TerminalTailPrefix(run, seq);
        this.#assertD65RecoveryMutationAllowed(request, run, 'terminal-tail', { attached_session_current: true, policy_trust_current: true, no_pending_publication: true, terminal_prepared_cancellable: false, terminal_after_commit: true, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false });
        this.#assertD65TerminalTailFinalBeforeDetach(run, session.session_lease_id);
      } else if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) {
        this.#assertD65OrdinaryMutationAllowed(request, run, 'detach-session');
      }
      this.#db.prepare("UPDATE session_leases SET status='detached', version=version+1 WHERE session_lease_id=?").run(session.session_lease_id);
      return { entityId: session.session_lease_id, payload: { session: sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(session.session_lease_id), 'detached session')), reason: payloadString(request.payload, 'reason') } };
    });
  }

  prepareHandoff(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#sessionMutation(request, 'session-handoff-prepared', (session, seq) => {
      const run = this.#requireRun(request.repo_id, session.workstream_run);
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#assertD65OrdinaryMutationAllowed(request, run, 'prepare-handoff');
      const token = payloadString(request.payload, 'handoff_token');
      this.#db.prepare("UPDATE session_leases SET status='handoff-pending', version=version+1 WHERE session_lease_id=?").run(session.session_lease_id);
      this.#db.prepare("INSERT INTO handoffs(handoff_token, repo_id, workstream_run, from_session_lease_id, status, created_event_seq, consumed_event_seq) VALUES(?, ?, ?, ?, 'pending', ?, NULL)").run(token, request.repo_id, this.#workstreamRun(request), session.session_lease_id, seq);
      return { entityId: session.session_lease_id, payload: { handoff_token: token, session: sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(session.session_lease_id), 'handoff session')) } };
    });
  }

  heartbeatSession(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#sessionMutation(request, 'session-heartbeat', (session, seq) => {
      const run = this.#requireRun(request.repo_id, session.workstream_run);
      if (this.#isD65Run(run.repo_id, run.workstream_run) && (run.status === 'closed' || run.status === 'aborted')) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail forbids a session heartbeat after its first terminal effect');
      this.#updateSessionHeartbeat.run(payloadString(request.payload, 'lease_expires_at'), session.session_lease_id);
      const runKey = `${request.repo_id}\0${session.workstream_run}`;
      const faultFreeCached = this.#semanticReplayTransactionActive && this.#semanticReplayFaultFreeRuns.has(runKey);
      const scopedFaultActive = !faultFreeCached && this.#db.prepare("SELECT fault_id FROM run_scoped_faults WHERE repo_id=? AND workstream_run=? AND status='active' LIMIT 1").get(request.repo_id, session.workstream_run) !== undefined;
      if (!scopedFaultActive && this.#semanticReplayTransactionActive) this.#semanticReplayFaultFreeRuns.add(runKey);
      const d65Complete = this.#hasD65CompleteGraph(request.repo_id, session.workstream_run);
      const reconciliation = !d65Complete && !scopedFaultActive && this.#repositoryHasCoordinationGraph(request.repo_id)
        ? this.#reconcileOwnedRun(request.repo_id, session.workstream_run, seq)
        : this.#freezeReconciliationSummary(this.#emptyReconciliationSummary());
      const reconciliationReceipt = this.#persistReconciliationReceipt(request.repo_id, session.workstream_run, request.action, seq, reconciliation);
      const pendingMessages = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM messages WHERE repo_id=? AND recipient_workstream_run=? AND status!='acknowledged'").get(request.repo_id, session.workstream_run), 'heartbeat pending message count'), 'count');
      return { entityId: session.session_lease_id, payload: { session: sessionFromRow(asRow(this.#sessionByLeaseId.get(session.session_lease_id), 'heartbeat session')), ...this.#reconciliationReceiptPayload(reconciliationReceipt), pending_messages: pendingMessages } };
    });
  }

  /**
   * The sole D65 API-12 mutation. It authenticates one external signed program
   * heartbeat and appends only its normalized-liveness event/result; no run,
   * lease, row, worktree, product, model, or ordinary-dispatch state mutates.
   */
  acceptProgramHeartbeat(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const session = this.#requireCurrentSession(request);
      if (session.attachment_kind !== 'dispatch') throw new CoordinationRuntimeError('unauthorized-client', 'accept-program-heartbeat requires the exact attached dispatch session');
      const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
      this.#assertVersion(run.version, request.expected_version, 'run');
      if (payloadString(request.payload, 'workstream_run') !== run.workstream_run) throw new CoordinationRuntimeError('unauthorized-client', 'heartbeat payload workstream_run does not equal its envelope run');
      const acceptedPolicy = this.#d65AcceptedLaunchPolicy(run.repo_id, run.workstream_run);
      if (payloadString(request.payload, 'program_id') !== acceptedPolicy.policy.program_id) throw new CoordinationRuntimeError('unauthorized-client', 'heartbeat payload program_id does not equal the accepted launch policy');

      // One coordinator CLOCK_REALTIME sample, after transaction/session/version
      // authority is established and before any candidate/status rows are read.
      const coordinatorTime = this.#clock.now().toISOString();
      const coordinatorMs = Date.parse(coordinatorTime);
      const heartbeatRef = payloadString(request.payload, 'heartbeat_ref');
      const candidatePath = this.#d65ExternalHeartbeatPath(acceptedPolicy.policy, heartbeatRef);
      const bytes = this.#readD65ExternalPrivateFile(candidatePath, 'D65 program heartbeat');
      const actualDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as `sha256:${string}`;
      const requestedDigest = payloadString(request.payload, 'heartbeat_sha256') as `sha256:${string}`;
      if (actualDigest !== requestedDigest) throw new CoordinationRuntimeError('invalid-request', 'program heartbeat external bytes do not match heartbeat_sha256', [requestedDigest, actualDigest]);
      let heartbeat: D65ProgramHeartbeat;
      try { heartbeat = parseD65ProgramHeartbeat(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'D65 program heartbeat')); }
      catch (error) { throw new CoordinationRuntimeError('invalid-request', 'program heartbeat bytes are malformed', [error instanceof Error ? error.message : String(error)]); }
      const expectedRef = `program-heartbeats/${String(heartbeat.sequence).padStart(20, '0')}.json`;
      if (heartbeatRef !== expectedRef) throw new CoordinationRuntimeError('invalid-request', 'program heartbeat_ref is not the canonical sequence path', [heartbeatRef, expectedRef]);
      if (heartbeat.program_id !== acceptedPolicy.policy.program_id || heartbeat.trust_anchor_ref !== acceptedPolicy.policy.trust_anchor_ref || heartbeat.trust_anchor_sha256 !== acceptedPolicy.policy.trust_anchor_sha256 || heartbeat.signer_key_id !== acceptedPolicy.anchor.sha256) throw new CoordinationRuntimeError('unauthorized-client', 'program heartbeat identity/trust tuple does not equal accepted policy authority');
      if (heartbeat.package_commit !== acceptedPolicy.policy.package_commit || heartbeat.package_tree !== acceptedPolicy.policy.package_tree || heartbeat.base_commit !== acceptedPolicy.policy.base_commit || heartbeat.base_tree !== acceptedPolicy.policy.base_tree) throw new CoordinationRuntimeError('unauthorized-client', 'program heartbeat package/base tuple does not equal accepted policy authority');
      const { signature: _signature, ...unsignedHeartbeat } = heartbeat;
      void _signature;
      if (!verifyD65Signature({ trustAnchor: acceptedPolicy.anchor, purpose: 'program-heartbeat', message: new TextEncoder().encode(canonicalJson(unsignedHeartbeat)), signature: heartbeat.signature })) throw new CoordinationRuntimeError('unauthorized-client', 'program heartbeat signature is not valid for the accepted trust anchor and purpose domain');
      if (heartbeat.provider_health.length !== 1 || heartbeat.provider_health[0]?.provider !== 'openai-codex') throw new CoordinationRuntimeError('unauthorized-client', 'D65 fixed Pi-subscription roster requires exactly one openai-codex provider-health row');
      if (Date.parse(heartbeat.issued_at) > coordinatorMs) throw new CoordinationRuntimeError('invalid-request', 'program heartbeat issued_at is in the coordinator future', [heartbeat.issued_at, coordinatorTime]);

      const kind = payloadString(request.payload, 'acceptance_kind');
      if (kind !== 'catch-up' && kind !== 'governing') throw new CoordinationRuntimeError('invalid-request', 'program heartbeat acceptance_kind must be catch-up or governing');
      if (kind === 'governing' && coordinatorMs >= Date.parse(heartbeat.valid_until)) throw new CoordinationRuntimeError('invalid-request', 'governing program heartbeat is expired at coordinator time', [heartbeat.valid_until, coordinatorTime]);
      const head = this.#highestAcceptedProgramHeartbeat(run.repo_id, run.workstream_run);
      if (head !== null && coordinatorMs < Date.parse(head.coordinator_time)) throw new CoordinationRuntimeError('invalid-state', 'coordinator-clock-rollback: coordinator time precedes the durable accepted heartbeat head', [coordinatorTime, head.coordinator_time]);
      const expectedPriorSequence = request.payload['expected_prior_sequence'];
      const expectedPriorSha = request.payload['expected_prior_sha256'];
      if ((expectedPriorSequence === null) !== (expectedPriorSha === null)) throw new CoordinationRuntimeError('invalid-request', 'expected heartbeat prior sequence/digest must both be null or both be present');
      if (head === null) {
        if (expectedPriorSequence !== null || expectedPriorSha !== null || heartbeat.sequence !== 1 || heartbeat.prior_sha256 !== null) throw new CoordinationRuntimeError('stale-version', 'initial heartbeat acceptance requires sequence 1 and exact null local/signed prior');
      } else {
        if (expectedPriorSequence !== head.sequence || expectedPriorSha !== head.heartbeat_sha256) throw new CoordinationRuntimeError('stale-version', 'expected heartbeat prior does not equal the durable local head');
        if (heartbeat.sequence !== head.sequence + 1 || heartbeat.prior_sha256 !== head.heartbeat_sha256) throw new CoordinationRuntimeError('stale-version', 'heartbeat chain has a fork, gap, rollback, or wrong signed prior');
      }
      const existingSequence = this.#acceptedProgramHeartbeatAtSequence(run.repo_id, run.workstream_run, heartbeat.sequence);
      if (existingSequence !== null) throw new CoordinationRuntimeError('idempotency-conflict', 'heartbeat sequence identity was already accepted with a different request/kind/digest', [String(heartbeat.sequence), existingSequence.heartbeat_sha256, existingSequence.acceptance_kind]);

      const heartbeatRow = heartbeat.rows.find((row) => row.workstream_run === run.workstream_run);
      if (heartbeatRow === undefined || heartbeat.rows.filter((row) => row.workstream_run === run.workstream_run).length !== 1 || heartbeatRow.workstream !== run.workstream) throw new CoordinationRuntimeError('unauthorized-client', 'program heartbeat does not contain exactly one row for the coordinator run');
      if (heartbeatRow.coordinator_session_lease_id !== session.session_lease_id) throw new CoordinationRuntimeError('fenced-session', 'program heartbeat row does not name the exact attached dispatch session lease');
      if (heartbeatRow.launch_policy_sha256 !== acceptedPolicy.artifact.evidence.sha256) throw new CoordinationRuntimeError('unauthorized-client', 'program heartbeat row does not name the accepted launch policy digest');
      const graphHead = this.#d65AcceptedGraphHead(run.repo_id, run.workstream_run);
      if (kind === 'governing' && this.#hasD65CompleteGraph(run.repo_id, run.workstream_run) && !this.#d65CompleteGraphCurrent(run.repo_id, run.workstream_run)) throw new CoordinationRuntimeError('stale-version', 'governing heartbeat cannot mask a semantic event that requires successor graph N+1');
      if (kind === 'governing' && (heartbeatRow.accepted_graph_sequence !== graphHead.sequence || heartbeatRow.accepted_graph_sha256 !== graphHead.sha256)) throw new CoordinationRuntimeError('stale-version', 'governing program heartbeat row does not name the current accepted graph tuple');
      if (kind === 'governing') {
        const statusDigest = this.#d65CurrentSemanticEndpointDigest('status', run.repo_id, run.workstream_run, coordinatorTime);
        const doctorDigest = this.#d65CurrentSemanticEndpointDigest('doctor', run.repo_id, run.workstream_run, coordinatorTime);
        if (heartbeatRow.status_sha256 !== statusDigest || heartbeatRow.doctor_sha256 !== doctorDigest) throw new CoordinationRuntimeError('stale-version', 'governing program heartbeat status/doctor digests do not equal current coordinator semantic authority', [String(heartbeatRow.status_sha256), statusDigest, String(heartbeatRow.doctor_sha256), doctorDigest]);
      }
      // Provider observations are byte-backed authority, not fields made true
      // by the program signature. Initial health is anchored in the accepted
      // launch policy. Every later state names this run's exact accepted
      // continuation/probe bytes, and post-consume health additionally binds
      // the immutable attempt-registration event/result.
      let validatedContinuation: ReturnType<typeof parseD65ContinuationEvent> | null = null;
      let validatedProbe: ReturnType<typeof parseD65SubscriptionProbe> | null = null;
      for (const provider of heartbeat.provider_health) {
        if (provider.observation_ref === null || provider.observation_sha256 === null) throw new CoordinationRuntimeError('invalid-request', 'provider observation authority is incomplete', [provider.provider]);
        if (provider.state === 'healthy' && provider.probe_ref === null) {
          // The already accepted, purpose-signed launch policy is the frozen
          // initial launch/roster authority: it binds program, run, trust,
          // package/base, and authenticated roster in one immutable artifact.
          if (provider.observation_ref !== acceptedPolicy.artifact.evidence.ref || provider.observation_sha256 !== acceptedPolicy.artifact.evidence.sha256) throw new CoordinationRuntimeError('invalid-request', 'initial healthy provider observation does not equal accepted launch policy authority', [provider.provider, provider.observation_ref, provider.observation_sha256]);
          continue;
        }
        if (provider.state === 'blocked' || provider.state === 'exhausted') {
          const continuationRows = this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.continuation_event.v1' AND json_extract(payload_json, '$.evidence.ref')=?").all(run.repo_id, run.workstream_run, provider.observation_ref).map(authoritativeArtifactFromRow);
          const continuationArtifact = continuationRows[0];
          if (continuationRows.length !== 1 || continuationArtifact === undefined || continuationArtifact.evidence.sha256 !== provider.observation_sha256) throw new CoordinationRuntimeError('invalid-request', 'provider failure observation does not name one exact accepted continuation', [provider.provider, provider.observation_ref]);
          const continuation = parseD65ContinuationEvent(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(run.repo_id, continuationArtifact.evidence)), 'heartbeat provider-failure continuation'));
          const blockedExact = provider.state === 'blocked' && continuation.class === 'provider-capacity-blocked' && continuation.retry_ordinal === 1 && continuation.cooldown_until === provider.cooldown_until;
          const exhaustedExact = provider.state === 'exhausted' && continuation.class === 'unit-retry-exhausted' && continuation.retry_ordinal === 2 && continuation.cooldown_until === null;
          if (continuation.program_id !== heartbeat.program_id || continuation.repo_id !== run.repo_id || continuation.workstream_run !== run.workstream_run || continuationArtifact.source_run !== run.workstream_run || continuation.trigger !== 'subscription-failure' || continuation.provider !== provider.provider || !(blockedExact || exhaustedExact)) throw new CoordinationRuntimeError('invalid-request', 'provider failure observation continuation does not equal the signed provider state', [provider.provider, provider.state, continuation.event_id]);
          validatedContinuation = continuation;
          continue;
        }
        if (provider.probe_workstream_run === null || provider.probe_ref === null || provider.probe_sha256 === null || provider.observation_ref !== provider.probe_ref || provider.observation_sha256 !== provider.probe_sha256) throw new CoordinationRuntimeError('invalid-request', 'retry/post-consume provider observation must equal its exact probe tuple', [provider.provider]);
        const probeRows = this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.subscription_probe.v1' AND json_extract(payload_json, '$.evidence.ref')=?").all(run.repo_id, run.workstream_run, provider.probe_ref).map(authoritativeArtifactFromRow);
        const probeArtifact = probeRows[0];
        if (probeRows.length !== 1 || probeArtifact === undefined || probeArtifact.evidence.sha256 !== provider.probe_sha256) throw new CoordinationRuntimeError('invalid-request', 'heartbeat retry authority does not name one exact registered probe', [provider.provider, provider.probe_ref]);
        const probe = parseD65SubscriptionProbe(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(run.repo_id, probeArtifact.evidence)), 'heartbeat subscription probe'));
        if (probe.provider !== provider.provider || probe.repo_id !== run.repo_id || provider.probe_workstream_run !== run.workstream_run || probe.workstream_run !== run.workstream_run || probe.workstream_run !== probeArtifact.source_run || probe.program_id !== heartbeat.program_id || provider.cooldown_until !== (provider.state === 'healthy' ? null : probe.cooldown_until) || !(Date.parse(probe.issued_at) <= coordinatorMs && coordinatorMs < Date.parse(probe.expires_at))) throw new CoordinationRuntimeError('invalid-request', 'heartbeat provider tuple diverges from the registered live probe', [provider.provider]);
        validatedProbe = probe;
        if (provider.state === 'retry-authorized') continue;
        if (provider.consumption_event_seq === null) throw new CoordinationRuntimeError('invalid-request', 'post-probe healthy heartbeat must cite consumption sequence');
        const consumptionRow = this.#db.prepare("SELECT r.payload_json FROM events e JOIN idempotency_results r ON r.repo_id=e.repo_id AND r.idempotency_key=e.idempotency_key AND r.request_sha256=e.request_sha256 AND r.committed_event_seq=e.event_seq WHERE e.repo_id=? AND e.event_seq=? AND e.event_type='unit-attempt-registered'").get(run.repo_id, provider.consumption_event_seq);
        if (consumptionRow === undefined) throw new CoordinationRuntimeError('invalid-request', 'post-probe healthy heartbeat consumption event does not exist', [provider.provider, String(provider.consumption_event_seq)]);
        const consumption = parseJsonObject(sqlString(consumptionRow, 'payload_json'), 'heartbeat probe consumption');
        const consumedAttempt = parseCoordinationUnitAttempt(consumption['unit_attempt']);
        if (consumedAttempt.owner.workstream_run !== run.workstream_run || consumption['consumed_probe_artifact_id'] !== probeArtifact.artifact_id || consumption['consumed_probe_sha256'] !== probeArtifact.evidence.sha256 || consumption['consumed_probe_sequence'] !== probe.probe_sequence || consumption['consumed_probe_provider'] !== probe.provider || consumption['consumed_probe_trigger_continuation_sha256'] !== probe.trigger_continuation_sha256) throw new CoordinationRuntimeError('invalid-request', 'post-probe healthy heartbeat consumption event/result does not bind the exact probe tuple', [provider.provider, String(provider.consumption_event_seq)]);
      }

      const currentProvider = heartbeat.provider_health[0];
      if (currentProvider === undefined) throw new CoordinationRuntimeError('invalid-request', 'program heartbeat lacks its fixed provider row');
      const rowBlocked = heartbeatRow.stop_reasons.includes('provider-blocked');
      const rowExhausted = heartbeatRow.stop_reasons.includes('provider-exhausted');
      if ((currentProvider.state === 'healthy' && (rowBlocked || rowExhausted)) || ((currentProvider.state === 'blocked' || currentProvider.state === 'retry-authorized') && (!rowBlocked || rowExhausted)) || (currentProvider.state === 'exhausted' && (!rowExhausted || rowBlocked))) throw new CoordinationRuntimeError('invalid-request', 'provider-health state and current row provider stop reasons are not the exact total mapping', [currentProvider.state, ...heartbeatRow.stop_reasons]);
      const previousProvider = head === null ? null : this.#d65VerifyAcceptedHeartbeatHead(head, acceptedPolicy, run, coordinatorTime).heartbeat.provider_health[0] ?? null;
      if (previousProvider === null) {
        if (currentProvider.state !== 'healthy' || currentProvider.probe_ref !== null) throw new CoordinationRuntimeError('invalid-request', 'initial program heartbeat must begin at launch-policy-backed healthy provider state');
      } else if (previousProvider.state === 'healthy' && previousProvider.probe_ref === null) {
        const retainedInitial = currentProvider.state === 'healthy' && currentProvider.probe_ref === null && currentProvider.observation_ref === previousProvider.observation_ref && currentProvider.observation_sha256 === previousProvider.observation_sha256;
        if (!(retainedInitial || currentProvider.state === 'blocked')) throw new CoordinationRuntimeError('invalid-request', 'initial healthy provider state may only remain byte-identical or advance to the first blocked continuation');
      } else if (previousProvider.state === 'blocked') {
        const retainedBlock = currentProvider.state === 'blocked' && currentProvider.observation_ref === previousProvider.observation_ref && currentProvider.observation_sha256 === previousProvider.observation_sha256 && currentProvider.cooldown_until === previousProvider.cooldown_until;
        const authorizedRetry = currentProvider.state === 'retry-authorized' && validatedProbe !== null && validatedProbe.trigger_continuation_ref === previousProvider.observation_ref && validatedProbe.trigger_continuation_sha256 === previousProvider.observation_sha256;
        if (!(retainedBlock || authorizedRetry)) throw new CoordinationRuntimeError('invalid-request', 'blocked provider state may only remain exact or advance through its bound accepted probe');
      } else if (previousProvider.state === 'retry-authorized') {
        const sameProbe = currentProvider.probe_workstream_run === previousProvider.probe_workstream_run && currentProvider.probe_ref === previousProvider.probe_ref && currentProvider.probe_sha256 === previousProvider.probe_sha256;
        if (!sameProbe || !((currentProvider.state === 'retry-authorized' && currentProvider.consumption_event_seq === null) || (currentProvider.state === 'healthy' && currentProvider.consumption_event_seq !== null))) throw new CoordinationRuntimeError('invalid-request', 'retry-authorized provider may only retain its probe or advance through exact consumption');
      } else if (previousProvider.state === 'healthy') {
        const retainedHealthy = currentProvider.state === 'healthy' && currentProvider.probe_workstream_run === previousProvider.probe_workstream_run && currentProvider.probe_ref === previousProvider.probe_ref && currentProvider.probe_sha256 === previousProvider.probe_sha256 && currentProvider.consumption_event_seq === previousProvider.consumption_event_seq;
        if (!retainedHealthy && currentProvider.state !== 'exhausted') throw new CoordinationRuntimeError('invalid-request', 'post-consume healthy provider may only remain exact or advance to exhausted');
        if (currentProvider.state === 'exhausted') {
          const priorProbeRows = this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.subscription_probe.v1' AND json_extract(payload_json, '$.evidence.ref')=?").all(run.repo_id, run.workstream_run, previousProvider.probe_ref).map(authoritativeArtifactFromRow);
          const priorProbeArtifact = priorProbeRows[0];
          if (priorProbeRows.length !== 1 || priorProbeArtifact === undefined || priorProbeArtifact.evidence.sha256 !== previousProvider.probe_sha256 || validatedContinuation === null) throw new CoordinationRuntimeError('invalid-request', 'exhausted provider transition lacks its exact prior consumed probe and successor continuation');
          const priorProbe = parseD65SubscriptionProbe(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(run.repo_id, priorProbeArtifact.evidence)), 'exhausted provider prior probe'));
          if (validatedContinuation.attempt !== priorProbe.successor_attempt || validatedContinuation.provider !== priorProbe.provider) throw new CoordinationRuntimeError('invalid-request', 'exhausted provider continuation is not the consumed probe successor failure');
        }
      } else {
        const retainedExhausted = currentProvider.state === 'exhausted' && currentProvider.observation_ref === previousProvider.observation_ref && currentProvider.observation_sha256 === previousProvider.observation_sha256;
        if (!retainedExhausted) throw new CoordinationRuntimeError('invalid-request', 'exhausted provider state is terminal and may only remain byte-identical');
      }

      const providerState = currentProvider.state;
      const verdict = recoveryTransitionAllowed({ action: 'accept-program-heartbeat', global_stop_reasons: heartbeat.stop_reasons, row_stop_reasons: heartbeatRow.stop_reasons, run_state: run.status, graph: { complete_graph_current: true, graph_publication_pending: false }, policy: { policy_current: true }, heartbeat: { governing_heartbeat_current: kind === 'governing', provider_state: providerState }, bindings: { attached_session_current: true, policy_trust_current: true, no_pending_publication: true, terminal_prepared_cancellable: false, terminal_after_commit: false, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false } });
      if (!verdict.allowed) throw new CoordinationRuntimeError('invalid-state', 'accept-program-heartbeat is fenced by the D65 recovery predicate', verdict.denied_by.slice());

      const idempotencyIdentity = { repo_id: run.repo_id, workstream_run: run.workstream_run, sequence: heartbeat.sequence, heartbeat_sha256: requestedDigest, acceptance_kind: kind };
      const expectedKey = `accept-program-heartbeat:sha256:${createHash('sha256').update(`${canonicalJson(idempotencyIdentity)}\n`, 'utf8').digest('hex')}`;
      if (request.idempotency_key !== expectedKey) throw new CoordinationRuntimeError('invalid-request', 'accept-program-heartbeat idempotency key is not the exact RFC-8785 identity digest', [String(request.idempotency_key), expectedKey]);
      const seq = this.#nextEventSequence(run.repo_id);
      const result: D65HeartbeatAcceptanceResult = Object.freeze({ schema_version: D65_HEARTBEAT_ACCEPTANCE_RESULT_SCHEMA, program_id: heartbeat.program_id, repo_id: run.repo_id, workstream_run: run.workstream_run, sequence: heartbeat.sequence, heartbeat_ref: heartbeatRef, heartbeat_sha256: requestedDigest, acceptance_kind: kind, prior_sha256: heartbeat.prior_sha256, issued_at: heartbeat.issued_at, valid_until: heartbeat.valid_until, coordinator_time: coordinatorTime });
      return { sequence: seq, eventType: 'program-heartbeat-accepted', entityType: 'program-heartbeat', entityId: run.workstream_run, payload: Object.freeze({ ...result }), occurredAt: coordinatorTime };
    });
  }

  registerAttempt(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
      this.#assertVersion(run.version, request.expected_version, 'run');
      let consumedProbe: Readonly<{ artifact_id: string; sha256: `sha256:${string}`; probe_sequence: number; provider: string; trigger_continuation_sha256: `sha256:${string}`; coordinator_time: string }> | null = null;
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) {
        // One coordinator CLOCK_REALTIME sample after session/version checks and
        // before eligibility. It is reused by the dispatch frame, expiry proof,
        // and immutable consumption result — never sampled independently.
        const coordinatorTime = this.#clock.now().toISOString();
        const frame = this.#d65DispatchAuthorityFrameInTransaction(run.repo_id, run.workstream_run, this.#d65MutationContext(request, run.version), coordinatorTime);
        const ordinary = ordinaryDispatchAllowed({ global_stop_reasons: frame.global_stop_reasons, row_stop_reasons: frame.row_stop_reasons, run_state: frame.run_state, graph: frame.graph, policy: frame.policy, heartbeat: frame.heartbeat, session: frame.session });
        if (!ordinary.allowed) {
          const verdict = recoveryTransitionAllowed({ action: 'register-attempt', global_stop_reasons: frame.global_stop_reasons, row_stop_reasons: frame.row_stop_reasons, run_state: frame.run_state, graph: frame.graph, policy: frame.policy, heartbeat: frame.heartbeat, bindings: { attached_session_current: frame.session.attached_session_current && frame.session.lease_current && frame.session.expected_version_current, policy_trust_current: frame.policy.policy_current, no_pending_publication: !frame.graph.graph_publication_pending, terminal_prepared_cancellable: false, terminal_after_commit: false, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false } });
          if (!verdict.allowed) throw new CoordinationRuntimeError('invalid-state', 'D65 ordinary mutation register-attempt is fenced at its coordinator transaction boundary', [...ordinary.allowed ? [] : ordinary.denied_by, ...verdict.denied_by]);
          consumedProbe = this.#d65ResolveConsumableProbe(run, payloadString(request.payload, 'unit_id'), payloadInteger(request.payload, 'attempt'), payloadString(request.payload, 'spec_ref'), payloadString(request.payload, 'spec_sha256'), coordinatorTime);
        }
      }
      if (this.#preparedTerminalIntent(run.repo_id, run.workstream_run) !== null) throw new CoordinationRuntimeError('invalid-state', 'run terminal preparation fences new attempt dispatch');
      const owner: CoordinationOwnerIdentity = { repo_id: run.repo_id, autopilot_id: run.autopilot_id, workstream_run: run.workstream_run, unit_id: payloadString(request.payload, 'unit_id'), attempt: payloadInteger(request.payload, 'attempt') };
      const role = payloadUnitRole(request.payload, 'role');
      if (role === 'implement' || role === 'fix') this.#assertSourceChangingDispatchAllowed(run.repo_id, run.workstream_run, 'register-attempt');
      if (payloadInteger(request.payload, 'checkpoint_ordinal') !== 0) throw new CoordinationRuntimeError('invalid-request', 'attempt registration must begin at checkpoint ordinal 0');
      const attempt: CoordinationUnitAttempt = { schema_version: 'autopilot.unit_attempt.v1', owner, state: 'preflight', role, spec: { ref: payloadString(request.payload, 'spec_ref'), sha256: payloadString(request.payload, 'spec_sha256') as `sha256:${string}` }, preemptible: payloadBoolean(request.payload, 'preemptible'), checkpoint_ordinal: 0, critical_section: null, version: 1 };
      const existing = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(unitAttemptEntityId(owner));
      if (existing === undefined && consumedProbe === null && this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#d65AssertOrdinaryAttemptGraphAuthority(run, owner.unit_id, owner.attempt, attempt.spec.ref, attempt.spec.sha256, role);
      if (existing !== undefined) {
        if (consumedProbe !== null) throw new CoordinationRuntimeError('invalid-state', 'probe consumption cannot target an already-existing attempt; only the exact new successor row is authorized', [unitAttemptEntityId(owner)]);
        if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) {
          const consumedRegistration = this.#db.prepare("SELECT e.event_seq FROM events e JOIN idempotency_results r ON r.repo_id=e.repo_id AND r.idempotency_key=e.idempotency_key AND r.request_sha256=e.request_sha256 AND r.committed_event_seq=e.event_seq WHERE e.repo_id=? AND e.event_type='unit-attempt-registered' AND e.entity_id=? AND json_extract(r.payload_json, '$.consumed_probe_artifact_id') IS NOT NULL LIMIT 1").get(run.repo_id, unitAttemptEntityId(owner));
          if (consumedRegistration !== undefined) throw new CoordinationRuntimeError('invalid-state', 'a probe-authorized attempt cannot be re-verified by a distinct request after its exact-once consumption', [unitAttemptEntityId(owner)]);
        }
        this.#insertOrVerifyUnitAttempt(attempt);
        return { sequence: this.#nextEventSequence(run.repo_id), eventType: 'unit-attempt-verified', entityType: 'unit-attempt', entityId: unitAttemptEntityId(owner), payload: { unit_attempt: unitAttemptFromRow(existing) } };
      }
      const seq = this.#nextEventSequence(run.repo_id);
      this.#insertEntity('unit_attempts', unitAttemptEntityId(owner), owner.repo_id, owner.workstream_run, attempt);
      // The immutable unit-attempt-registered event/result records the exact
      // consumption tuple at the consumption sequence; the request shape is
      // unchanged and non-probe registrations carry no consumption fields.
      const payload = consumedProbe === null
        ? { unit_attempt: attempt }
        : { unit_attempt: attempt, consumed_probe_artifact_id: consumedProbe.artifact_id, consumed_probe_sha256: consumedProbe.sha256, consumed_probe_sequence: consumedProbe.probe_sequence, consumed_probe_provider: consumedProbe.provider, consumed_probe_trigger_continuation_sha256: consumedProbe.trigger_continuation_sha256, consumed_probe_coordinator_time: consumedProbe.coordinator_time };
      return { sequence: seq, eventType: 'unit-attempt-registered', entityType: 'unit-attempt', entityId: unitAttemptEntityId(owner), payload };
    });
  }

  /** Require one new ordinary attempt to be preauthorized by current G. */
  #d65AssertOrdinaryAttemptGraphAuthority(run: CoordinationRun, unitId: string, attempt: number, specRef: string, specSha256: `sha256:${string}`, role: CoordinationUnitRole): void {
    const graphHead = this.#d65AcceptedGraphHead(run.repo_id, run.workstream_run);
    if (graphHead.artifact.document_schema_version !== 'autopilot.semantic_graph.v1') throw new CoordinationRuntimeError('invalid-state', 'ordinary attempt requires an accepted complete graph');
    const resource = runResourceFromRow(asRow(this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run), 'ordinary attempt graph resource'));
    const graph = parseD65CompleteGraph(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(run.repo_id, graphHead.artifact.evidence)), 'ordinary attempt accepted graph'));
    const loaded = loadD65CompleteGraph(graph, (ref) => this.#readD65GraphShardBlob(resource.main_worktree_path, graphHead.artifact.git_commit, ref));
    const specs = loaded.authorities['specs']?.entries.filter((entry) => entry.ref === specRef && entry.sha256 === specSha256 && entry.document_schema_version === 'autopilot.unit_spec.v1') ?? [];
    if (specs.length !== 1) throw new CoordinationRuntimeError('invalid-state', 'ordinary attempt spec is not one exact accepted graph authority', [specRef, specSha256]);
    const specBytes = this.#readD65GraphShardBlob(resource.main_worktree_path, graph.covered_authority_commit, specRef);
    const actual = `sha256:${createHash('sha256').update(specBytes).digest('hex')}`;
    if (actual !== specSha256) throw new CoordinationRuntimeError('invalid-state', 'ordinary attempt spec bytes differ from accepted graph authority', [specRef, specSha256, actual]);
    const spec = parseAutopilotUnitSpec(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(specBytes), 'ordinary attempt spec'));
    const stateBytes = this.#readD65GraphShardBlob(resource.main_worktree_path, graph.covered_authority_commit, graph.core.state.ref);
    const state = parseAutopilotState(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(stateBytes), 'ordinary attempt graph state'));
    const unit = state.units[unitId];
    const workItems = Object.values(state.work_items ?? {}).filter((item) => item.unit_ids.includes(unitId));
    const specAbsolute = resolve(resource.main_worktree_path, ...specRef.split('/'));
    const stateSpecRef = relative(resource.runtime_root, specAbsolute).replace(/\\/gu, '/');
    if (stateSpecRef.length === 0 || stateSpecRef === '..' || stateSpecRef.startsWith('../') || isAbsolute(stateSpecRef)) throw new CoordinationRuntimeError('invalid-state', 'ordinary attempt spec is outside the graph runtime authority root', [specRef, resource.runtime_root]);
    if (spec.unit_id !== unitId || spec.attempt !== attempt || spec.role !== role || unit === undefined || unit.attempt !== attempt || unit.role !== role || unit.spec_ref !== stateSpecRef || workItems.length !== 1) throw new CoordinationRuntimeError('invalid-state', 'ordinary attempt is not authorized by one exact graph state/spec/work-item tuple', [unitId, String(attempt), stateSpecRef, role, `work_items=${String(workItems.length)}`]);
    if (loaded.coordinatorProjection.attempts.some((entry) => entry.attempt.owner.unit_id === unitId && entry.attempt.owner.attempt === attempt)) throw new CoordinationRuntimeError('invalid-state', 'ordinary attempt graph must truthfully project the proposed row absent before registration', [unitId, String(attempt)]);
  }

  /**
   * Deterministically resolve EXACTLY ONE accepted, unexpired, unconsumed
   * subscription probe for the proposed successor tuple from registered
   * artifact bytes. Zero or multiple candidates reject; the probe binds the
   * exact accepted provider-failure continuation trigger, the exact failed
   * attempt, and `successor_attempt = attempt`. Initial and non-provider-retry
   * attempts never reach this resolver (ordinary dispatch admits them).
   */
  #d65ResolveConsumableProbe(run: CoordinationRun, unitId: string, attempt: number, successorSpecRef: string, successorSpecSha256: string, coordinatorTime: string): Readonly<{ artifact_id: string; sha256: `sha256:${string}`; probe_sequence: number; provider: string; trigger_continuation_sha256: `sha256:${string}`; coordinator_time: string }> {
    if (!/^sha256:[a-f0-9]{64}$/u.test(successorSpecSha256)) throw new CoordinationRuntimeError('invalid-request', 'probe-authorized successor spec_sha256 is not canonical');
    const coordinatorMs = Date.parse(coordinatorTime);
    const acceptedPolicy = this.#d65AcceptedLaunchPolicy(run.repo_id, run.workstream_run);
    const graphHead = this.#d65AcceptedGraphHead(run.repo_id, run.workstream_run);
    if (graphHead.artifact.document_schema_version !== 'autopilot.semantic_graph.v1') throw new CoordinationRuntimeError('invalid-state', 'probe consumption requires an accepted complete graph');
    const resource = runResourceFromRow(asRow(this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run), 'probe consumption run resource'));
    const graph = parseD65CompleteGraph(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(run.repo_id, graphHead.artifact.evidence)), 'probe consumption accepted graph'));
    const loaded = loadD65CompleteGraph(graph, (ref) => this.#readD65GraphShardBlob(resource.main_worktree_path, graphHead.artifact.git_commit, ref));
    const authorityEntries = Object.values(loaded.authorities).flatMap((collection) => collection.entries);
    const exactAuthorityEntry = (ref: string, sha256: string, schema: string) => authorityEntries.filter((entry) => entry.ref === ref && entry.sha256 === sha256 && entry.document_schema_version === schema);
    const readAuthority = (ref: string, expectedSha256: string, label: string): Uint8Array => {
      const bytes = this.#readD65GraphShardBlob(resource.main_worktree_path, graph.covered_authority_commit, ref);
      const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (actual !== expectedSha256) throw new CoordinationRuntimeError('invalid-state', `${label} bytes differ from their accepted graph authority digest`, [ref, expectedSha256, actual]);
      return bytes;
    };

    const probeRows = this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.subscription_probe.v1' ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(authoritativeArtifactFromRow);
    const parsedProbes = probeRows.map((artifact) => {
      const probeBytes = this.#loadEvidenceArtifact(run.repo_id, artifact.evidence);
      const probe = parseD65SubscriptionProbe(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(probeBytes), 'registered subscription probe'));
      const expectedRef = `authority/subscription-probes/${String(probe.probe_sequence).padStart(20, '0')}-${probe.probe_id}.json`;
      if (artifact.source_type !== 'task' || artifact.source_scope !== 'run-main' || artifact.evidence.ref !== expectedRef || probe.program_id !== acceptedPolicy.policy.program_id || probe.repo_id !== run.repo_id || probe.workstream_run !== run.workstream_run || probe.trust_anchor_ref !== acceptedPolicy.policy.trust_anchor_ref || probe.trust_anchor_sha256 !== acceptedPolicy.policy.trust_anchor_sha256 || probe.signer_key_id !== acceptedPolicy.anchor.sha256) throw new CoordinationRuntimeError('invalid-state', 'registered subscription probe identity/path/trust tuple is not exact', [artifact.artifact_id]);
      const { signature: _signature, ...unsigned } = probe;
      void _signature;
      if (!verifyD65Signature({ trustAnchor: acceptedPolicy.anchor, purpose: 'subscription-probe', message: new TextEncoder().encode(canonicalJson(unsigned)), signature: probe.signature })) throw new CoordinationRuntimeError('invalid-state', 'registered subscription probe signature is invalid', [artifact.artifact_id]);
      return Object.freeze({ artifact, probe });
    });
    // Prove each local (program,provider,run) chain has one contiguous sequence
    // and exact prior digest. A fork/gap is authority corruption, not a skipped
    // candidate. This check runs before target filtering.
    const chains = new Map<string, typeof parsedProbes>();
    for (const parsed of parsedProbes) {
      const key = `${parsed.probe.program_id}\0${parsed.probe.provider}\0${parsed.probe.workstream_run}`;
      chains.set(key, [...(chains.get(key) ?? []), parsed]);
    }
    for (const chain of chains.values()) {
      const ordered = [...chain].sort((left, right) => left.probe.probe_sequence - right.probe.probe_sequence || left.artifact.artifact_id.localeCompare(right.artifact.artifact_id));
      for (let index = 0; index < ordered.length; index += 1) {
        const current = ordered[index];
        if (current === undefined || current.probe.probe_sequence !== index + 1) throw new CoordinationRuntimeError('invalid-state', 'registered subscription probe local chain has a fork or gap');
        const prior = ordered[index - 1];
        const expectedPrior = prior?.artifact.evidence.sha256 ?? null;
        if (current.probe.prior_probe_sha256 !== expectedPrior) throw new CoordinationRuntimeError('invalid-state', 'registered subscription probe local chain names the wrong immediate prior digest', [current.artifact.artifact_id]);
      }
    }

    const candidates: typeof parsedProbes = [];
    for (const parsed of parsedProbes) {
      const { artifact, probe } = parsed;
      if (probe.unit_id !== unitId || probe.successor_attempt !== attempt) continue;
      if (!(Date.parse(probe.issued_at) <= coordinatorMs && coordinatorMs < Date.parse(probe.expires_at))) continue;
      const consumed = this.#db.prepare("SELECT r.idempotency_key FROM idempotency_results r JOIN events e ON e.repo_id=r.repo_id AND e.idempotency_key=r.idempotency_key WHERE r.repo_id=? AND e.event_type='unit-attempt-registered' AND json_extract(r.payload_json, '$.consumed_probe_artifact_id')=? LIMIT 1").get(run.repo_id, artifact.artifact_id) !== undefined;
      if (consumed) continue;
      candidates.push(parsed);
    }
    const sole = candidates[0];
    if (candidates.length !== 1 || sole === undefined) throw new CoordinationRuntimeError('invalid-state', 'probe consumption requires exactly one accepted, unexpired, unconsumed subscription probe for the successor tuple', [unitId, String(attempt), `candidates=${String(candidates.length)}`]);
    const { artifact, probe } = sole;
    if (exactAuthorityEntry(artifact.evidence.ref, artifact.evidence.sha256, 'autopilot.subscription_probe.v1').length !== 1) throw new CoordinationRuntimeError('invalid-state', 'accepted complete graph does not include the exact registered subscription probe', [artifact.artifact_id]);

    const triggerRows = this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.continuation_event.v1' AND json_extract(payload_json, '$.evidence.ref')=?").all(run.repo_id, run.workstream_run, probe.trigger_continuation_ref).map(authoritativeArtifactFromRow);
    const triggerArtifact = triggerRows[0];
    if (triggerRows.length !== 1 || triggerArtifact === undefined || triggerArtifact.evidence.sha256 !== probe.trigger_continuation_sha256 || exactAuthorityEntry(triggerArtifact.evidence.ref, triggerArtifact.evidence.sha256, 'autopilot.continuation_event.v1').length !== 1) throw new CoordinationRuntimeError('invalid-state', 'probe trigger continuation is not the exact accepted graph authority', [probe.trigger_continuation_ref]);
    const trigger = parseD65ContinuationEvent(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(run.repo_id, triggerArtifact.evidence)), 'probe trigger continuation'));
    if (trigger.trigger !== 'subscription-failure' || trigger.class !== 'provider-capacity-blocked' || trigger.repo_id !== run.repo_id || trigger.workstream_run !== run.workstream_run || trigger.unit_id !== unitId || trigger.attempt !== probe.failed_attempt || trigger.provider !== probe.provider || trigger.retry_ordinal !== probe.retry_ordinal || trigger.cooldown_until !== probe.cooldown_until || trigger.failed_spec_ref === null || trigger.failed_receipt_ref === null) throw new CoordinationRuntimeError('invalid-state', 'probe trigger continuation does not bind the exact first provider-failure tuple', [trigger.event_id]);

    const failedSpecEntries = exactAuthorityEntry(trigger.failed_spec_ref.ref, trigger.failed_spec_ref.sha256, 'autopilot.unit_spec.v1');
    const failedReceiptEntries = exactAuthorityEntry(trigger.failed_receipt_ref.ref, trigger.failed_receipt_ref.sha256, 'autopilot.receipt.v1');
    if (failedSpecEntries.length !== 1 || failedReceiptEntries.length !== 1) throw new CoordinationRuntimeError('invalid-state', 'probe failed spec/receipt are not exact accepted graph authorities');
    const failedSpecBytes = readAuthority(trigger.failed_spec_ref.ref, trigger.failed_spec_ref.sha256, 'probe failed spec');
    const failedReceiptBytes = readAuthority(trigger.failed_receipt_ref.ref, trigger.failed_receipt_ref.sha256, 'probe failed receipt');
    if (failedSpecBytes.byteLength !== trigger.failed_spec_ref.byte_count || failedReceiptBytes.byteLength !== trigger.failed_receipt_ref.byte_count) throw new CoordinationRuntimeError('invalid-state', 'probe failed spec/receipt byte counts differ from the trigger continuation');
    const failedSpec = parseAutopilotUnitSpec(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(failedSpecBytes), 'probe failed spec'));
    const failedReceipt = parseAutopilotReceipt(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(failedReceiptBytes), 'probe failed receipt'));
    if (failedSpec.unit_id !== unitId || failedSpec.attempt !== probe.failed_attempt || failedReceipt.unit_id !== unitId || failedReceipt.attempt !== probe.failed_attempt || failedReceipt.provider_identity.provider_id !== probe.provider || failedReceipt.provider_identity.requested_model_id !== failedSpec.model || failedReceipt.provider_identity.executed_model_id !== failedSpec.model) throw new CoordinationRuntimeError('invalid-state', 'probe failed spec/receipt/provider/model identities do not match', [unitId, String(probe.failed_attempt), probe.provider]);

    const successorEntries = exactAuthorityEntry(successorSpecRef, successorSpecSha256, 'autopilot.unit_spec.v1');
    if (successorEntries.length !== 1) throw new CoordinationRuntimeError('invalid-state', 'probe successor spec is not one exact accepted graph authority', [successorSpecRef]);
    const successorSpec = parseAutopilotUnitSpec(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(readAuthority(successorSpecRef, successorSpecSha256, 'probe successor spec')), 'probe successor spec'));
    if (successorSpec.unit_id !== unitId || successorSpec.attempt !== attempt || successorSpec.model !== failedSpec.model) throw new CoordinationRuntimeError('invalid-state', 'probe successor spec changes the authorized unit/attempt/model tuple', [successorSpec.unit_id, String(successorSpec.attempt), successorSpec.model]);

    const graphState = parseAutopilotState(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(readAuthority(graph.core.state.ref, graph.core.state.sha256, 'probe graph state')), 'probe graph state'));
    const unit = graphState.units[unitId];
    const workItems = Object.values(graphState.work_items ?? {}).filter((item) => item.unit_ids.includes(unitId));
    const successorAbsolute = resolve(resource.main_worktree_path, ...successorSpecRef.split('/'));
    const stateSpecRef = relative(resource.runtime_root, successorAbsolute).replace(/\\/gu, '/');
    if (stateSpecRef.length === 0 || stateSpecRef === '..' || stateSpecRef.startsWith('../') || isAbsolute(stateSpecRef)) throw new CoordinationRuntimeError('invalid-state', 'probe successor spec is outside the graph runtime authority root', [successorSpecRef, resource.runtime_root]);
    if (unit === undefined || unit.attempt !== attempt || unit.spec_ref !== stateSpecRef || workItems.length !== 1) throw new CoordinationRuntimeError('invalid-state', 'probe successor is not authorized by one exact graph state/work-item tuple', [unitId, String(attempt), stateSpecRef, `work_items=${String(workItems.length)}`]);
    const projectedSuccessor = loaded.coordinatorProjection.attempts.filter((entry) => entry.attempt.owner.unit_id === unitId && entry.attempt.owner.attempt === attempt);
    if (projectedSuccessor.length !== 0 || this.#db.prepare("SELECT entity_id FROM unit_attempts WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.owner.unit_id')=? AND json_extract(payload_json, '$.owner.attempt')=?").get(run.repo_id, run.workstream_run, unitId, attempt) !== undefined) throw new CoordinationRuntimeError('invalid-state', 'probe successor attempt must remain absent before its atomic registration', [unitId, String(attempt)]);
    const priorAttempt = loaded.coordinatorProjection.attempts.filter((entry) => entry.attempt.owner.unit_id === unitId && entry.attempt.owner.attempt === probe.failed_attempt);
    if (priorAttempt.length !== 1 || (priorAttempt[0]?.attempt.state !== 'reset' && priorAttempt[0]?.attempt.state !== 'quarantined')) throw new CoordinationRuntimeError('invalid-state', 'probe consumption requires exact prior reset/quarantine coordinator proof', [unitId, String(probe.failed_attempt)]);

    const heartbeatHead = this.#highestAcceptedProgramHeartbeat(run.repo_id, run.workstream_run);
    if (heartbeatHead === null) throw new CoordinationRuntimeError('invalid-state', 'probe consumption lacks an accepted heartbeat head');
    const heartbeat = this.#d65VerifyAcceptedHeartbeatHead(heartbeatHead, acceptedPolicy, run, coordinatorTime);
    const retryRows = heartbeat.heartbeat.provider_health.filter((entry) => entry.state === 'retry-authorized');
    const retry = retryRows[0];
    if (!heartbeat.governingCurrent || retryRows.length !== 1 || retry === undefined || retry.provider !== probe.provider || retry.probe_workstream_run !== run.workstream_run || retry.probe_ref !== artifact.evidence.ref || retry.probe_sha256 !== artifact.evidence.sha256 || retry.consumption_event_seq !== null || retry.cooldown_until !== probe.cooldown_until) throw new CoordinationRuntimeError('invalid-state', 'governing heartbeat does not expose exactly this probe as retry-authorized', [artifact.artifact_id]);
    return Object.freeze({ artifact_id: artifact.artifact_id, sha256: artifact.evidence.sha256, probe_sequence: probe.probe_sequence, provider: probe.provider, trigger_continuation_sha256: probe.trigger_continuation_sha256, coordinator_time: coordinatorTime });
  }

  registerChild(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const session = this.#requireCurrentSession(request);
      const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
      this.#assertVersion(run.version, request.expected_version, 'run');
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#assertD65OrdinaryMutationAllowed(request, run, 'register-child');
      if (this.#preparedTerminalIntent(run.repo_id, run.workstream_run) !== null) throw new CoordinationRuntimeError('invalid-state', 'run terminal preparation fences new child registration');
      const childOwner: CoordinationOwnerIdentity = { repo_id: run.repo_id, autopilot_id: run.autopilot_id, workstream_run: run.workstream_run, unit_id: payloadString(request.payload, 'unit_id'), attempt: payloadInteger(request.payload, 'attempt') };
      if (payloadString(request.payload, 'autopilot_id') !== run.autopilot_id) throw new CoordinationRuntimeError('unauthorized-client', 'child autopilot identity does not match its durable run');
      const attempt = this.#requireUnitAttempt(childOwner.repo_id, childOwner.workstream_run, childOwner.unit_id, childOwner.attempt);
      if (attempt.role === 'implement' || attempt.role === 'fix') this.#assertSourceChangingDispatchAllowed(run.repo_id, run.workstream_run, 'register-child');
      if (attempt.state !== 'preflight') throw new CoordinationRuntimeError('invalid-state', `child registration requires a preflight attempt, not ${attempt.state}`);
      const activeObservations = this.#db.prepare("SELECT * FROM observations WHERE repo_id=? AND workstream_run=? AND execution_state='active' ORDER BY entity_id").all(childOwner.repo_id, childOwner.workstream_run).map(observationFromRow).filter((observation) => sameOwner(observation.owner, childOwner));
      if (activeObservations.length > 0) {
        const observationRoot = this.#observationWorktreeRoot(childOwner);
        for (const observation of activeObservations) {
          if (observation.freshness !== 'current') throw new CoordinationRuntimeError('stale-version', 'stale observation must be refreshed in a new attempt before child registration', [observation.observation_id, observation.path]);
          assertCoordinationObservationSourceIdentity({ cwd: observationRoot, path: observation.path, expected: observation.source_identity });
        }
      }
      const childId = payloadString(request.payload, 'child_lease_id');
      const expectedChildId = `child-${childOwner.workstream_run}-${childOwner.unit_id}-${String(childOwner.attempt)}`;
      if (childId !== expectedChildId) throw new CoordinationRuntimeError('invalid-request', 'child lease id must match its deterministic durable attempt identity', [childId, expectedChildId]);
      const seq = this.#nextEventSequence(request.repo_id);
      const childTokenSha256 = createHash('sha256').update(payloadString(request.payload, 'child_token'), 'utf8').digest('hex');
      this.#db.prepare("INSERT INTO child_leases(child_lease_id, repo_id, autopilot_id, workstream_run, unit_id, attempt, pid, boot_id, child_token_sha256, lease_expires_at, status, terminal_evidence_ref, terminal_evidence_sha256, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, 1)").run(
        childId, request.repo_id, payloadString(request.payload, 'autopilot_id'), this.#workstreamRun(request), payloadString(request.payload, 'unit_id'), payloadInteger(request.payload, 'attempt'), payloadInteger(request.payload, 'pid'), payloadString(request.payload, 'boot_id'), childTokenSha256, payloadString(request.payload, 'lease_expires_at'),
      );
      const runningAttempt: CoordinationUnitAttempt = { ...attempt, state: 'running', version: attempt.version + 1 };
      this.#updateEntity('unit_attempts', unitAttemptEntityId(attempt.owner), runningAttempt);
      const child = childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'registered child'));
      return { sequence: seq, eventType: 'child-registered', entityType: 'child-lease', entityId: childId, payload: { child, authorizing_session_lease_id: session.session_lease_id } };
    });
  }

  heartbeatChild(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const childId = payloadString(request.payload, 'child_lease_id');
      const childRow = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'child');
      const child = childFromRow(childRow);
      this.#assertChildAuthority(request, child, childRow);
      this.#assertVersion(child.version, request.expected_version, 'child lease');
      if (child.status !== 'running') throw new CoordinationRuntimeError('invalid-state', `child lease is ${child.status}`);
      const seq = this.#nextEventSequence(request.repo_id);
      this.#db.prepare('UPDATE child_leases SET lease_expires_at=?, version=version+1 WHERE child_lease_id=?').run(payloadString(request.payload, 'lease_expires_at'), childId);
      const victimKey = coordinationOwnerKey(child.owner);
      const preemptionRequested = this.#db.prepare("SELECT entity_id FROM deadlock_resolutions WHERE repo_id=? AND json_extract(payload_json, '$.state')='awaiting-recovery' AND json_extract(payload_json, '$.action')='request-reset-or-quarantine' AND json_extract(payload_json, '$.victim.repo_id')=? AND json_extract(payload_json, '$.victim.autopilot_id')=? AND json_extract(payload_json, '$.victim.workstream_run')=? AND json_extract(payload_json, '$.victim.unit_id')=? AND json_extract(payload_json, '$.victim.attempt')=? LIMIT 1").get(child.owner.repo_id, child.owner.repo_id, child.owner.autopilot_id, child.owner.workstream_run, child.owner.unit_id, child.owner.attempt) !== undefined;
      return { sequence: seq, eventType: 'child-heartbeat', entityType: 'child-lease', entityId: childId, payload: { child: childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'heartbeat child')), preemption_requested: preemptionRequested, victim_key: preemptionRequested ? victimKey : null } };
    });
  }

  checkpointChild(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const childId = payloadString(request.payload, 'child_lease_id');
      const childRow = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'child');
      const child = childFromRow(childRow);
      this.#assertChildAuthority(request, child, childRow);
      this.#assertVersion(child.version, request.expected_version, 'child lease');
      if (child.status !== 'running') throw new CoordinationRuntimeError('invalid-state', `child lease is ${child.status}`);
      const attempt = this.#requireUnitAttempt(child.owner.repo_id, child.owner.workstream_run, child.owner.unit_id, child.owner.attempt);
      const run = this.#requireRun(child.owner.repo_id, child.owner.workstream_run);
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#assertD65OrdinaryMutationAllowed(request, run, 'checkpoint-child', this.#d65CurrentDispatchContext(run));
      if (attempt.state !== 'running') throw new CoordinationRuntimeError('invalid-state', `child checkpoint requires a running attempt, not ${attempt.state}`);
      const checkpointOrdinal = payloadInteger(request.payload, 'checkpoint_ordinal');
      if (checkpointOrdinal !== attempt.checkpoint_ordinal + 1) throw new CoordinationRuntimeError('stale-version', 'child checkpoint ordinal must advance exactly one durable boundary at a time');
      const seq = this.#nextEventSequence(request.repo_id);
      const criticalSection = payloadNullableString(request.payload, 'critical_section');
      const preemptible = payloadBoolean(request.payload, 'preemptible');
      const activeExclusive = this.#activeExclusiveLeases(attempt.owner);
      if (attempt.critical_section !== null && criticalSection === null) this.#assertAuthorityCriticalMutationAllowed(attempt.owner.repo_id, attempt.owner.workstream_run, 'EXCLUSIVE critical-section exit');
      if (criticalSection !== null && !activeExclusive.some((lease) => lease.exclusive_operation?.critical_section === criticalSection)) throw new CoordinationRuntimeError('invalid-request', 'child cannot enter a critical section without its exact active EXCLUSIVE operation', [criticalSection]);
      if (criticalSection !== null && (preemptible || criticalSection !== attempt.critical_section)) throw new CoordinationRuntimeError('invalid-request', 'active EXCLUSIVE checkpoint must preserve its exact non-preemptible critical section', [criticalSection, String(preemptible)]);
      if (attempt.critical_section !== null && criticalSection === null && !preemptible) throw new CoordinationRuntimeError('invalid-request', 'critical-section exit must restore attempt preemptibility before releasing EXCLUSIVE authority');
      const checkpointed: CoordinationUnitAttempt = { ...attempt, checkpoint_ordinal: checkpointOrdinal, critical_section: criticalSection, preemptible, version: attempt.version + 1 };
      this.#updateEntity('unit_attempts', unitAttemptEntityId(attempt.owner), checkpointed);
      const releasedExclusiveLeaseIds: string[] = [];
      if (attempt.critical_section !== null && criticalSection === null) {
        this.#releaseExitedExclusiveLeases(attempt.owner, releasedExclusiveLeaseIds);
        this.#reevaluateWaitingGroups(attempt.owner.repo_id, seq);
      }
      return { sequence: seq, eventType: 'unit-attempt-checkpointed', entityType: 'unit-attempt', entityId: unitAttemptEntityId(attempt.owner), payload: { child, unit_attempt: checkpointed, released_exclusive_lease_ids: releasedExclusiveLeaseIds } };
    });
  }

  completeChild(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const childId = payloadString(request.payload, 'child_lease_id');
      const childRow = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'child');
      const child = childFromRow(childRow);
      this.#assertChildAuthority(request, child, childRow);
      this.#assertVersion(child.version, request.expected_version, 'child lease');
      if (child.status !== 'running') throw new CoordinationRuntimeError('invalid-state', `child lease is ${child.status}`);
      const run = this.#requireRun(child.owner.repo_id, child.owner.workstream_run);
      const status = payloadString(request.payload, 'status');
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) {
        if (status === 'recovery-required') this.#assertD65RecoveryMutationAllowed(request, run, 'unit-recovery', { attached_session_current: true, policy_trust_current: false, no_pending_publication: false, terminal_prepared_cancellable: false, terminal_after_commit: false, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false }, this.#d65CurrentDispatchContext(run));
        else this.#assertD65OrdinaryMutationAllowed(request, run, 'complete-child', this.#d65CurrentDispatchContext(run));
      }
      this.#assertAuthorityCriticalMutationAllowed(child.owner.repo_id, child.owner.workstream_run, 'child terminal acceptance and authority release');
      const evidenceRef = payloadNullableString(request.payload, 'evidence_ref');
      const evidenceSha = payloadNullableString(request.payload, 'evidence_sha256');
      if (status === 'terminal' && (evidenceRef === null || evidenceSha === null || !SHA256_PATTERN.test(evidenceSha))) throw new CoordinationRuntimeError('invalid-request', 'terminal child completion requires immutable evidence');
      if (status === 'terminal' && evidenceRef !== null && evidenceSha !== null) {
        const terminalDocument = parseJsonObject(Buffer.from(this.#readRunEvidenceFile(this.#requireRun(child.owner.repo_id, child.owner.workstream_run), { ref: evidenceRef, sha256: evidenceSha as `sha256:${string}` })).toString('utf8'), 'child terminal acceptance');
        if (terminalDocument['schema_version'] !== AUTOPILOT_CHILD_TERMINAL_ACCEPTANCE_SCHEMA) throw new CoordinationRuntimeError('invalid-request', 'new terminal child completion requires parent-owned child_terminal_acceptance.v1 evidence');
      }
      if (status === 'recovery-required' && (evidenceRef !== null || evidenceSha !== null)) throw new CoordinationRuntimeError('invalid-request', 'recovery-required child completion must not claim terminal evidence');
      const seq = this.#nextEventSequence(request.repo_id);
      this.#db.prepare('UPDATE child_leases SET status=?, terminal_evidence_ref=?, terminal_evidence_sha256=?, version=version+1 WHERE child_lease_id=?').run(status, evidenceRef, evidenceSha, childId);
      if (status === 'recovery-required') {
        const attempt = this.#requireUnitAttempt(child.owner.repo_id, child.owner.workstream_run, child.owner.unit_id, child.owner.attempt);
        if (attempt.state === 'running') this.#updateEntity('unit_attempts', unitAttemptEntityId(attempt.owner), { ...attempt, state: 'failed', critical_section: null, preemptible: true, version: attempt.version + 1 });
      }
      if (status === 'terminal' && evidenceRef !== null && evidenceSha !== null) {
        this.#acceptReconciliationEvidence({
          repoId: child.owner.repo_id,
          workstreamRun: child.owner.workstream_run,
          source: 'child-process',
          targetId: child.child_lease_id,
          evidence: { ref: evidenceRef, sha256: evidenceSha as `sha256:${string}` },
          seq,
        });
        this.#updateAttemptForSatisfiedCondition(child.owner, 'child-terminal');
      }
      const releasedExclusiveLeaseIds: string[] = [];
      this.#releaseExitedExclusiveLeases(child.owner, releasedExclusiveLeaseIds);
      const reconciled = this.#reconcileOwnedRun(request.repo_id, child.owner.workstream_run, seq);
      const reconciliation = this.#freezeReconciliationSummary({ ...reconciled, released_lease_ids: [...releasedExclusiveLeaseIds, ...reconciled.released_lease_ids] });
      const reconciliationReceipt = this.#persistReconciliationReceipt(request.repo_id, child.owner.workstream_run, request.action, seq, reconciliation);
      return { sequence: seq, eventType: status === 'terminal' ? 'child-terminal' : 'child-recovery-required', entityType: 'child-lease', entityId: childId, payload: { child: childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'completed child')), ...this.#reconciliationReceiptPayload(reconciliationReceipt) } };
    });
  }

  acquireGroup(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
      this.#requireCoordinatorEditAuthority(run, 'acquisition-group creation');
      this.#assertVersion(run.version, request.expected_version, 'run');
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#assertD65OrdinaryMutationAllowed(request, run, 'acquire-group');
      if (this.#preparedTerminalIntent(run.repo_id, run.workstream_run) !== null) throw new CoordinationRuntimeError('invalid-state', 'run terminal preparation fences new acquisition groups');
      const groupId = payloadString(request.payload, 'acquisition_group_id');
      const owner: CoordinationOwnerIdentity = {
        repo_id: request.repo_id,
        autopilot_id: run.autopilot_id,
        workstream_run: run.workstream_run,
        unit_id: payloadString(request.payload, 'unit_id'),
        attempt: payloadInteger(request.payload, 'attempt'),
      };
      const requestedLeases = payloadRequestedLeases(request.payload);
      if (requestedLeases.some((lease) => lease.mode !== 'READ')) this.#assertSourceChangingDispatchAllowed(run.repo_id, run.workstream_run, 'acquire-group');
      const requestedRole = payloadUnitRole(request.payload, 'role');
      if (requestedRole !== 'implement' && requestedRole !== 'fix' && requestedLeases.some((lease) => lease.mode !== 'READ')) throw new CoordinationRuntimeError('invalid-request', `${requestedRole} units may acquire READ authority only`);
      const exclusiveOperation = requestedLeases.find((lease) => lease.mode === 'EXCLUSIVE')?.exclusive_operation;
      if (exclusiveOperation !== undefined && payloadBoolean(request.payload, 'preemptible')) throw new CoordinationRuntimeError('invalid-request', 'an attempt holding bounded EXCLUSIVE authority must be non-preemptible until its critical section exits');
      const acquisitionKind = payloadAcquisitionKind(request.payload, 'acquisition_kind');
      const releaseCondition = payloadReleaseCondition(request.payload, 'normal_release_condition');
      if ((requestedRole === 'implement' || requestedRole === 'fix') && requestedLeases.some((lease) => lease.mode !== 'READ') && releaseCondition.condition_type === 'child-terminal') throw new CoordinationRuntimeError('invalid-request', 'source-changing edit authority cannot release from child terminal alone; merge, reset, quarantine, abort, or close proof is required');

      // One-time post-cutover binding consumes exact retained legacy WRITE
      // authority instead of creating a second initial group. The migration
      // audit preserves the synthetic prior spec; only an unclaimed unknown-role
      // attempt with an exact active mode/path set can be rebound.
      const priorGroups = this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(owner.repo_id, owner.workstream_run).map(acquisitionGroupFromRow).filter((candidate) => sameOwner(candidate.owner, owner));
      if (acquisitionKind === 'initial' && priorGroups.length === 1 && priorGroups[0]?.acquisition_kind === 'legacy-unknown' && priorGroups[0].state === 'granted') {
        const legacyGroup = priorGroups[0];
        const existingAttempt = this.#requireUnitAttempt(owner.repo_id, owner.workstream_run, owner.unit_id, owner.attempt);
        const activeLegacyLeases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(owner.repo_id, owner.workstream_run).map(editLeaseFromRow).filter((lease) => sameOwner(lease.owner, owner));
        const requestedKeys = [...new Set(requestedLeases.map((lease) => `${lease.mode}\0${lease.path}`))].sort();
        const activeKeys = [...new Set(activeLegacyLeases.map((lease) => `${lease.mode}\0${lease.path}`))].sort();
        const exactAuthority = canonicalJson(requestedKeys) === canonicalJson(activeKeys);
        const requestedCheckpointOrdinal = payloadInteger(request.payload, 'checkpoint_ordinal');
        const safeBinding = existingAttempt.role === 'unknown' && existingAttempt.spec.ref.startsWith('migration/') && this.#childForOwner(owner) === null && requestedCheckpointOrdinal === 0 && requestedLeases.every((lease) => lease.mode === 'WRITE');
        if (!exactAuthority || !safeBinding) throw new CoordinationRuntimeError('invalid-state', 'retained legacy authority cannot bind to a different or already-dispatched attempt', [owner.unit_id, String(owner.attempt)]);
        const seq = this.#nextEventSequence(request.repo_id);
        const reboundAttempt: CoordinationUnitAttempt = { ...existingAttempt, state: 'preflight', role: requestedRole, spec: { ref: payloadString(request.payload, 'spec_ref'), sha256: payloadString(request.payload, 'spec_sha256') as `sha256:${string}` }, preemptible: true, checkpoint_ordinal: requestedCheckpointOrdinal, critical_section: null, version: existingAttempt.version + 1 };
        this.#updateEntity('unit_attempts', unitAttemptEntityId(owner), reboundAttempt);
        return { sequence: seq, eventType: 'legacy-authority-rebound', entityType: 'acquisition-group', entityId: legacyGroup.acquisition_group_id, payload: { outcome: 'granted', acquisition_group: legacyGroup, observations: [], edit_leases: activeLegacyLeases, request_refs: [], rebound_from_group_id: groupId, unit_attempt: reboundAttempt } };
      }
      if (this.#db.prepare('SELECT entity_id FROM acquisition_groups WHERE repo_id=? AND entity_id=?').get(request.repo_id, groupId) !== undefined) throw new CoordinationRuntimeError('stale-version', 'acquisition group already exists; retry with its original idempotency key or query status');
      const seq = this.#nextEventSequence(request.repo_id);
      const requestedCheckpointOrdinal = payloadInteger(request.payload, 'checkpoint_ordinal');
      const existingAttemptRow = this.#db.prepare('SELECT entity_id FROM unit_attempts WHERE entity_id=?').get(unitAttemptEntityId(owner));
      if (existingAttemptRow === undefined && requestedCheckpointOrdinal !== 0) throw new CoordinationRuntimeError('invalid-request', 'initial acquisition must begin at checkpoint ordinal 0');
      const attempt: CoordinationUnitAttempt = {
        schema_version: 'autopilot.unit_attempt.v1', owner, state: 'preflight', role: requestedRole,
        spec: { ref: payloadString(request.payload, 'spec_ref'), sha256: payloadString(request.payload, 'spec_sha256') as `sha256:${string}` },
        // A waiting group has not entered its critical section and holds no
        // authority. #grantGroup atomically makes an EXCLUSIVE attempt
        // non-preemptible and records the closed critical-section identity.
        preemptible: true, checkpoint_ordinal: requestedCheckpointOrdinal, critical_section: null, version: 1,
      };
      this.#insertOrVerifyUnitAttempt(attempt);
      if (acquisitionKind === 'initial' && priorGroups.length > 0) throw new CoordinationRuntimeError('invalid-state', 'a unit attempt may declare exactly one immutable initial acquisition group');
      if (acquisitionKind === 'materialization-read-expansion') {
        if (!requestedLeases.every((lease) => lease.mode === 'READ')) throw new CoordinationRuntimeError('invalid-request', 'materialization expansion may request READ authority only');
        const initial = priorGroups.find((candidate) => candidate.acquisition_kind === 'initial' || candidate.acquisition_kind === 'legacy-unknown');
        if (initial === undefined || (initial.state !== 'granted' && initial.state !== 'released')) throw new CoordinationRuntimeError('invalid-state', 'materialization READ expansion requires a previously granted initial acquisition group');
      }
      this.#assertReleaseConditionOwner(releaseCondition, owner);
      const group = parseCoordinationAcquisitionGroup({
        schema_version: 'autopilot.acquisition_group.v2', acquisition_group_id: groupId, owner, acquisition_kind: acquisitionKind, requested_leases: requestedLeases,
        reason: payloadString(request.payload, 'reason'), normal_release_condition: releaseCondition, state: 'waiting', created_event_seq: seq, fairness_event_seq: seq,
        grant_event_seq: null, offer_expires_at: null, offer_count: 0, bypass_count: 0, version: 1,
      });
      if (encodedJsonBytes(group) > COORDINATOR_MAX_PAGE_ENTITY_BYTES) throw new CoordinationRuntimeError('frame-too-large', 'acquisition group exceeds the single durable entity byte ceiling', [groupId]);
      this.#insertEntity('acquisition_groups', groupId, owner.repo_id, owner.workstream_run, group);
      const expiredOffers = this.#expireGrantOffers(request.repo_id, seq);
      if (expiredOffers) this.#reevaluateWaitingGroups(request.repo_id, seq);
      const currentGroup = expiredOffers ? this.#requireGroup(request.repo_id, groupId) : group;
      if (currentGroup.state === 'grant-ready') {
        const requests = this.#claimRequestsForGroup(request.repo_id, groupId);
        return { sequence: seq, eventType: 'acquisition-group-waiting', entityType: 'acquisition-group', entityId: groupId, payload: { outcome: 'waiting-for-peer-release', acquisition_group: currentGroup, claim_requests: requests, request_refs: requests.map((entry) => entry.request_id) } };
      }
      const blockers = this.#blockingLeases(owner.repo_id, requestedLeases);
      if (blockers.some((lease) => sameOwner(lease.owner, owner))) throw new CoordinationRuntimeError('invalid-state', 'new acquisition group redundantly overlaps authority already held by the same unit attempt');
      const offeredBlockers = this.#blockingGrantOffers(owner.repo_id, groupId, requestedLeases);
      if (blockers.length === 0 && offeredBlockers.length === 0) {
        const granted = this.#grantGroup(currentGroup, seq);
        this.#reevaluateWaitingGroups(request.repo_id, seq);
        return { sequence: seq, eventType: 'acquisition-group-granted', entityType: 'acquisition-group', entityId: groupId, payload: { outcome: 'granted', acquisition_group: granted.group, observations: granted.observations, edit_leases: granted.leases, request_refs: [] } };
      }
      const requests = this.#ensureClaimRequests(currentGroup, blockers, seq);
      return { sequence: seq, eventType: 'acquisition-group-waiting', entityType: 'acquisition-group', entityId: groupId, payload: { outcome: 'waiting-for-peer-release', acquisition_group: currentGroup, claim_requests: requests, request_refs: requests.map((entry) => entry.request_id) } };
    });
  }

  acknowledgeGrant(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const groupId = payloadString(request.payload, 'acquisition_group_id');
      const group = this.#requireGroup(request.repo_id, groupId);
      const run = this.#requireRun(group.owner.repo_id, group.owner.workstream_run);
      this.#requireCoordinatorEditAuthority(run, 'grant acknowledgement');
      this.#assertGroupOwner(request, group);
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#assertD65OrdinaryMutationAllowed(request, run, 'acknowledge-grant');
      if (this.#preparedTerminalIntent(group.owner.repo_id, group.owner.workstream_run) !== null) throw new CoordinationRuntimeError('invalid-state', 'run terminal preparation fences grant acknowledgement');
      this.#assertVersion(group.version, request.expected_version, 'acquisition group');
      const seq = this.#nextEventSequence(request.repo_id);
      const offerExpired = this.#expireGrantOffers(request.repo_id, seq);
      if (offerExpired) {
        this.#reevaluateWaitingGroups(request.repo_id, seq);
        const requeued = this.#requireGroup(request.repo_id, groupId);
        return { sequence: seq, eventType: 'grant-offer-expired', entityType: 'acquisition-group', entityId: groupId, payload: { outcome: 'offer-expired', acquisition_group: requeued, observations: [], edit_leases: [] } };
      }
      const current = this.#requireGroup(request.repo_id, groupId);
      if (current.requested_leases.some((lease) => lease.mode !== 'READ')) this.#assertSourceChangingDispatchAllowed(current.owner.repo_id, current.owner.workstream_run, 'acknowledge-grant');
      if (current.state !== 'grant-ready') throw new CoordinationRuntimeError('invalid-state', `acquisition group is ${current.state}, not grant-ready`);
      if (current.offer_expires_at === null || Date.parse(current.offer_expires_at) <= this.#clock.now().getTime()) throw new CoordinationRuntimeError('stale-version', 'grant offer expired before requester preflight acknowledgement');
      if (this.#blockingLeases(request.repo_id, current.requested_leases).length > 0) throw new CoordinationRuntimeError('coordinator-contention', 'grant offer is no longer completely free');
      const granted = this.#grantGroup(current, seq);
      this.#db.prepare("UPDATE messages SET status='acknowledged', delivered_event_seq=COALESCE(delivered_event_seq, ?), acknowledged_event_seq=COALESCE(acknowledged_event_seq, ?), version=version+1 WHERE repo_id=? AND correlation_id=? AND message_type='grant-offer' AND status!='acknowledged'").run(seq, seq, request.repo_id, groupId);
      this.#advanceMailboxCursor(request.repo_id, current.owner.workstream_run, 'acknowledged');
      const groupRequests = this.#claimRequestsForGroup(request.repo_id, groupId);
      for (const claimRequest of groupRequests) {
        const next: CoordinationClaimRequest = { ...claimRequest, status: 'resolved', grant_event_seq: seq, version: claimRequest.version + 1 };
        this.#updateClaimRequest(next);
      }
      this.#reevaluateWaitingGroups(request.repo_id, seq);
      return { sequence: seq, eventType: 'acquisition-group-granted', entityType: 'acquisition-group', entityId: groupId, payload: { outcome: 'granted', acquisition_group: granted.group, observations: granted.observations, edit_leases: granted.leases, request_refs: groupRequests.map((entry) => entry.request_id), grant_evidence: { acquisition_group_id: groupId, grant_event_seq: seq, lease_ids: granted.leases.map((entry) => entry.edit_lease_id), observation_ids: granted.observations.map((entry) => entry.observation_id) } } };
    });
  }

  respondClaimRequest(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const requestId = payloadString(request.payload, 'request_id');
      const claimRequest = this.#requireClaimRequest(requestId);
      this.#assertRequestOwner(request, claimRequest);
      this.#assertVersion(claimRequest.version, request.expected_version, 'claim request');
      const run = this.#requireRun(claimRequest.owner.repo_id, claimRequest.owner.workstream_run);
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#assertD65OrdinaryMutationAllowed(request, run, 'respond-claim-request');
      this.#assertAuthorityCriticalMutationAllowed(claimRequest.owner.repo_id, claimRequest.owner.workstream_run, 'claim response reconciliation or authority release');
      if (!['pending', 'delivered', 'acknowledged', 'deferred'].includes(claimRequest.status)) throw new CoordinationRuntimeError('invalid-state', `claim request is ${claimRequest.status}`);
      const seq = this.#nextEventSequence(request.repo_id);
      const offersExpired = this.#expireGrantOffers(request.repo_id, seq);
      if (payloadString(request.payload, 'response') === 'deferred') {
        const condition = payloadReleaseCondition(request.payload, 'release_condition');
        this.#assertReleaseConditionOwner(condition, claimRequest.owner);
        const deferred: CoordinationClaimRequest = { ...claimRequest, status: 'deferred', owner_reason: payloadString(request.payload, 'owner_reason'), release_condition: condition, version: claimRequest.version + 1 };
        this.#updateClaimRequest(deferred);
        const reconciliation = this.#reconcileOwnedRun(request.repo_id, claimRequest.owner.workstream_run, seq);
        if (offersExpired && reconciliation.offered_group_ids.length === 0) this.#reevaluateWaitingGroups(request.repo_id, seq);
        const reconciliationReceipt = this.#persistReconciliationReceipt(request.repo_id, claimRequest.owner.workstream_run, request.action, seq, reconciliation);
        return { sequence: seq, eventType: 'claim-request-deferred', entityType: 'claim-request', entityId: requestId, payload: { claim_request: this.#requireClaimRequest(requestId), ...this.#reconciliationReceiptPayload(reconciliationReceipt) } };
      }
      const releasedLeaseIds: string[] = [];
      for (const leaseId of claimRequest.blocking_lease_ids) {
        const row = this.#db.prepare('SELECT * FROM edit_leases WHERE entity_id=?').get(leaseId);
        if (row === undefined) continue;
        const lease = editLeaseFromRow(row);
        if (!sameOwner(lease.owner, claimRequest.owner)) throw new CoordinationRuntimeError('invalid-state', 'claim request blocking lease changed durable owner');
        if (lease.mode === 'EXCLUSIVE' && lease.exclusive_operation?.operation_kind !== 'legacy-migration-exclusive') {
          const attempt = this.#requireUnitAttempt(lease.owner.repo_id, lease.owner.workstream_run, lease.owner.unit_id, lease.owner.attempt);
          if (attempt.critical_section !== lease.exclusive_operation?.critical_section) throw new CoordinationRuntimeError('invalid-state', 'authenticated release-now cannot exit an EXCLUSIVE operation whose exact critical section is not active', [lease.edit_lease_id]);
          this.#updateEntity('unit_attempts', unitAttemptEntityId(attempt.owner), { ...attempt, critical_section: null, preemptible: true, version: attempt.version + 1 });
        }
        this.#db.prepare('DELETE FROM edit_leases WHERE entity_id=?').run(leaseId);
        releasedLeaseIds.push(leaseId);
        this.#markGroupReleasedWhenEmpty(lease.owner.repo_id, lease.acquisition_group_id);
      }
      const releasedLeaseSet = new Set(releasedLeaseIds);
      const affectedRequests = this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? AND owner_workstream_run=? ORDER BY entity_id').all(request.repo_id, claimRequest.owner.workstream_run).map(claimRequestFromRow).filter((entry) => ['pending', 'delivered', 'acknowledged', 'deferred'].includes(entry.status) && (entry.request_id === requestId || entry.blocking_lease_ids.some((leaseId) => releasedLeaseSet.has(leaseId))));
      const notifications: CoordinationMessage[] = [];
      for (const affected of affectedRequests) {
        const released: CoordinationClaimRequest = {
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
      if (primaryNotification === undefined) throw new CoordinationRuntimeError('store-corrupt', 'owner release did not transition its initiating claim request');
      this.#reevaluateWaitingGroups(request.repo_id, seq);
      return { sequence: seq, eventType: 'claim-request-released', entityType: 'claim-request', entityId: requestId, payload: { claim_request: this.#requireClaimRequest(requestId), released_lease_ids: releasedLeaseIds, release_notification: primaryNotification, affected_request_ids: affectedRequests.map((entry) => entry.request_id) } };
    });
  }

  cancelClaimRequest(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const claimRequest = this.#requireClaimRequest(payloadString(request.payload, 'request_id'));
      this.#assertRequestRequester(request, claimRequest);
      this.#assertVersion(claimRequest.version, request.expected_version, 'claim request');
      const group = this.#requireGroup(request.repo_id, claimRequest.acquisition_group_id);
      const run = this.#requireRun(request.repo_id, claimRequest.requester.workstream_run);
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#assertD65OrdinaryMutationAllowed(request, run, 'cancel-claim-request');
      if (group.state === 'granted') throw new CoordinationRuntimeError('invalid-state', 'a granted acquisition group must release through its owner lifecycle');
      const seq = this.#nextEventSequence(request.repo_id);
      this.#cancelGroup(group, 'cancelled', seq);
      this.#reevaluateWaitingGroups(request.repo_id, seq);
      return { sequence: seq, eventType: 'claim-request-cancelled', entityType: 'claim-request', entityId: claimRequest.request_id, payload: { acquisition_group: this.#requireGroup(request.repo_id, group.acquisition_group_id), request_refs: this.#claimRequestsForGroup(request.repo_id, group.acquisition_group_id).map((entry) => entry.request_id), reason: payloadString(request.payload, 'reason') } };
    });
  }

  cancelAcquisitionGroup(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const group = this.#requireGroup(request.repo_id, payloadString(request.payload, 'acquisition_group_id'));
      this.#assertGroupOwner(request, group);
      this.#assertVersion(group.version, request.expected_version, 'acquisition group');
      const run = this.#requireRun(group.owner.repo_id, group.owner.workstream_run);
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#assertD65OrdinaryMutationAllowed(request, run, 'cancel-acquisition-group');
      const seq = this.#nextEventSequence(request.repo_id);
      this.#cancelGroup(group, 'cancelled', seq);
      this.#reevaluateWaitingGroups(request.repo_id, seq);
      return { sequence: seq, eventType: 'acquisition-group-cancelled', entityType: 'acquisition-group', entityId: group.acquisition_group_id, payload: { acquisition_group: this.#requireGroup(request.repo_id, group.acquisition_group_id), request_refs: this.#claimRequestsForGroup(request.repo_id, group.acquisition_group_id).map((entry) => entry.request_id), reason: payloadString(request.payload, 'reason') } };
    });
  }

  supersedeAttempt(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
      const unitId = payloadString(request.payload, 'unit_id');
      const attemptNumber = payloadInteger(request.payload, 'attempt');
      const attempt = this.#requireUnitAttempt(request.repo_id, run.workstream_run, unitId, attemptNumber);
      this.#assertVersion(attempt.version, request.expected_version, 'unit attempt');
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#assertD65OrdinaryMutationAllowed(request, run, 'supersede-attempt');
      const seq = this.#nextEventSequence(request.repo_id);
      const groups = this.#groupsForAttempt(attempt.owner);
      if (groups.some((group) => group.state === 'granted')) throw new CoordinationRuntimeError('invalid-state', 'running/granted attempt must release or quarantine before supersession');
      for (const group of groups.filter((group) => group.state === 'waiting' || group.state === 'grant-ready')) this.#cancelGroup(group, 'superseded', seq);
      const superseded: CoordinationUnitAttempt = { ...attempt, state: 'superseded', version: attempt.version + 1 };
      this.#updateEntity('unit_attempts', unitAttemptEntityId(attempt.owner), superseded);
      this.#reevaluateWaitingGroups(request.repo_id, seq);
      return { sequence: seq, eventType: 'unit-attempt-superseded', entityType: 'unit-attempt', entityId: unitAttemptEntityId(attempt.owner), payload: { unit_attempt: superseded, superseded_by_attempt: payloadInteger(request.payload, 'superseded_by_attempt'), reason: payloadString(request.payload, 'reason'), request_refs: groups.flatMap((group) => this.#claimRequestsForGroup(group.owner.repo_id, group.acquisition_group_id).map((entry) => entry.request_id)) } };
    });
  }

  registerAuthoritativeArtifact(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
      this.#assertVersion(run.version, request.expected_version, 'run');
      const sourceType = payloadString(request.payload, 'source_type');
      if (sourceType !== 'mission' && sourceType !== 'master-plan' && sourceType !== 'task') throw new CoordinationRuntimeError('invalid-request', 'authoritative artifact source_type is unsupported');
      const sourceScope = payloadString(request.payload, 'source_scope');
      if (sourceScope !== 'repository' && sourceScope !== 'run-main') throw new CoordinationRuntimeError('invalid-request', 'authoritative artifact source_scope is unsupported');
      const documentSchemaVersion = payloadString(request.payload, 'document_schema_version');
      const ref = payloadString(request.payload, 'ref');
      // D65 package-run documents use the frozen existing task/run-main
      // registration surface. Reject a launch policy before resolving or reading
      // any repository-scoped path; repository scope belongs only to bootstrap.
      if (documentSchemaVersion === 'autopilot.launch_policy.v1' && (sourceType !== 'task' || sourceScope !== 'run-main')) throw new CoordinationRuntimeError('invalid-request', 'launch-policy-invalid: launch policy registration requires source_type=task and source_scope=run-main', [sourceType, sourceScope]);
      if (documentSchemaVersion === 'autopilot.semantic_graph.v1' && (sourceType !== 'task' || sourceScope !== 'run-main')) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: semantic graph registration requires source_type=task and source_scope=run-main', [sourceType, sourceScope]);
      if (documentSchemaVersion === 'autopilot.launch_policy.v1' && run.status !== 'active') throw new CoordinationRuntimeError('invalid-request', 'launch-policy-invalid: launch policy registration requires an active run', [run.status]);
      // Bootstrap mode permits only its explicit charter operations: the sole
      // artifact registrations before the first complete graph are the signed
      // launch policy (register-launch-policy) and the complete graph itself
      // (publish-complete-graph). Any other schema — including a mission/task
      // document squatting a semantic-graph:<seq> id — rejects loudly.
      if (this.#isD65Run(run.repo_id, run.workstream_run) && !this.#hasD65CompleteGraph(run.repo_id, run.workstream_run) && documentSchemaVersion !== 'autopilot.launch_policy.v1' && documentSchemaVersion !== 'autopilot.semantic_graph.v1') throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-bootstrap-operation-denied: bootstrap mode permits only launch-policy and complete-graph artifact registration', [documentSchemaVersion, payloadString(request.payload, 'artifact_id')]);
      // Every D65 semantic-graph registration is gated: the first publication
      // (sequence 2) has its own exact bootstrap-prior admission and every
      // successor requires the accepted prior complete graph. There is no
      // residue-optional or policy-optional bypass.
      if (documentSchemaVersion === 'autopilot.semantic_graph.v1' && this.#isD65Run(run.repo_id, run.workstream_run)) this.#assertD65GraphPublicationMutationAllowed(request, run);
      // Continuation/parent-loss/probe registrations in complete mode are
      // recovery actions: global [], the artifact's accepted continuation
      // reason plus only its affecting provider reason and/or unit-recovering,
      // current graph/policy/session, no pending publication. Ordinary
      // dispatch admits every other complete-mode task registration.
      const d65RecoveryArtifact = documentSchemaVersion === 'autopilot.continuation_event.v1' || documentSchemaVersion === 'autopilot.parent_loss.v1' || documentSchemaVersion === 'autopilot.subscription_probe.v1';
      if (d65RecoveryArtifact && this.#isD65Run(run.repo_id, run.workstream_run)) {
        // Path grammar is frozen: continuation events and the byte-identical
        // parent-loss artifact live under the runtime authority/continuation/
        // root; probes under authority/subscription-probes/ (fresh plan §2.3/§3.1).
        const requestedRef = payloadString(request.payload, 'ref');
        const resourceRow = runResourceFromRow(asRow(this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run), 'D65 recovery artifact run resource'));
        const runtimePrefix = relative(resourceRow.main_worktree_path, resourceRow.runtime_root).replace(/\\/gu, '/');
        if (documentSchemaVersion === 'autopilot.continuation_event.v1' && !new RegExp(`^${runtimePrefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/authority/continuation/[0-9]{20}-[A-Za-z0-9._:@-]+\\.json$`, 'u').test(requestedRef)) throw new CoordinationRuntimeError('invalid-request', 'continuation event ref is not the frozen runtime authority/continuation path', [requestedRef]);
        if (documentSchemaVersion === 'autopilot.parent_loss.v1' && !new RegExp(`^${runtimePrefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/authority/continuation/[0-9]{20}-parent-loss\\.json$`, 'u').test(requestedRef)) throw new CoordinationRuntimeError('invalid-request', 'parent-loss artifact ref is not the frozen runtime authority/continuation parent-loss path', [requestedRef]);
        if (documentSchemaVersion === 'autopilot.subscription_probe.v1' && !/^authority\/subscription-probes\/[0-9]{20}-[A-Za-z0-9._:@-]+\.json$/u.test(requestedRef)) throw new CoordinationRuntimeError('invalid-request', 'subscription probe ref is not the frozen authority/subscription-probes path', [requestedRef]);
      }
      if (this.#isD65Run(run.repo_id, run.workstream_run) && this.#hasD65CompleteGraph(run.repo_id, run.workstream_run) && documentSchemaVersion !== 'autopilot.semantic_graph.v1') {
        if (sourceType !== 'task' || sourceScope !== 'run-main') throw new CoordinationRuntimeError('invalid-request', 'D65 complete-mode artifact registration requires source_type=task and source_scope=run-main');
        // Registration runs after its one-parent immutable artifact commit, so
        // physical HEAD is intentionally one exact commit beyond accepted H.
        // Prove that commit NOW (sole parent H, diff exactly this ref) before
        // evaluating dispatch against the logical prior graph. Any extra path,
        // parent, merge, or stale base rejects before coordinator row effect.
        const resource = runResourceFromRow(asRow(this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run), 'D65 artifact registration resource'));
        const requestedCommit = payloadString(request.payload, 'git_commit');
        const currentHead = this.#gitQueryText(resource.main_worktree_path, { kind: 'head' }, 'invalid-request', 'D65 artifact registration HEAD inspection failed');
        const priorGraph = this.#d65AcceptedGraphHead(run.repo_id, run.workstream_run);
        const parentListing = (this.#gitQueryText(resource.main_worktree_path, { kind: 'rev-list-parents', revision: requestedCommit }, 'invalid-request', 'D65 artifact commit parent inspection failed') ?? '').trim().split(/\s+/u).filter((entry) => entry.length > 0);
        const diff = this.#gitQueryResult(resource.main_worktree_path, { kind: 'diff-paths', from: priorGraph.artifact.git_commit, to: requestedCommit, noRenames: true }, 'invalid-request', 'D65 artifact commit diff inspection failed');
        const changedPaths = new TextDecoder('utf-8', { fatal: true }).decode(diff.stdout).split('\0').filter((entry) => entry.length > 0);
        const allowedPaths = new Map<string, { readonly sha256: `sha256:${string}`; readonly byte_count: number } | null>([[ref, null]]);
        if (documentSchemaVersion === 'autopilot.continuation_event.v1') {
          const continuationBytes = this.#gitQueryResult(resource.main_worktree_path, { kind: 'show-file', revision: requestedCommit, path: ref }, 'invalid-request', 'D65 continuation artifact blob inspection failed').stdout;
          const continuation = parseD65ContinuationEvent(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(continuationBytes), 'D65 continuation artifact commit'));
          for (const evidence of [...continuation.evidence_refs, ...(continuation.failed_spec_ref === null ? [] : [continuation.failed_spec_ref]), ...(continuation.failed_receipt_ref === null ? [] : [continuation.failed_receipt_ref])]) allowedPaths.set(evidence.ref, evidence);
        }
        const commitShapeExact = currentHead === requestedCommit && parentListing.length === 2 && parentListing[1] === priorGraph.artifact.git_commit && changedPaths.includes(ref) && changedPaths.length > 0 && changedPaths.every((path) => allowedPaths.has(path));
        if (!commitShapeExact) throw new CoordinationRuntimeError('invalid-request', 'D65 artifact registration commit is not the exact one-parent prescribed-path successor of accepted H', [String(currentHead), requestedCommit, ...parentListing.slice(1), ...changedPaths.slice(0, 8)]);
        for (const path of changedPaths) {
          const expected = allowedPaths.get(path);
          if (expected === undefined) throw new CoordinationRuntimeError('store-corrupt', 'D65 prescribed artifact path disappeared during commit validation', [path]);
          if (expected === null) continue;
          const memberBytes = this.#gitQueryResult(resource.main_worktree_path, { kind: 'show-file', revision: requestedCommit, path }, 'invalid-request', 'D65 continuation embedded evidence inspection failed').stdout;
          const memberDigest = `sha256:${createHash('sha256').update(memberBytes).digest('hex')}`;
          if (memberDigest !== expected.sha256 || memberBytes.byteLength !== expected.byte_count) throw new CoordinationRuntimeError('invalid-request', 'D65 continuation embedded evidence commit bytes differ from their immutable binding', [path, expected.sha256, memberDigest]);
        }
        const logicalGraphCurrent = this.#d65CompleteGraphCurrent(run.repo_id, run.workstream_run);
        if (!logicalGraphCurrent) throw new CoordinationRuntimeError('invalid-state', 'D65 artifact registration prior graph is not semantically current');
        const frame = this.#d65DispatchAuthorityFrameInTransaction(run.repo_id, run.workstream_run, this.#d65MutationContext(request, run.version), this.#clock.now().toISOString(), true);
        const rowReasons = frame.row_stop_reasons.length === 1 && frame.row_stop_reasons[0] === 'graph-drift' ? Object.freeze([]) : frame.row_stop_reasons;
        const evaluationGraph = Object.freeze({ ...frame.graph, complete_graph_current: true });
        const ordinary = ordinaryDispatchAllowed({ global_stop_reasons: frame.global_stop_reasons, row_stop_reasons: rowReasons, run_state: frame.run_state, graph: evaluationGraph, policy: frame.policy, heartbeat: frame.heartbeat, session: frame.session });
        if (d65RecoveryArtifact) {
          // Recovery documents NEVER ride ordinary dispatch. They require one
          // exact continuation reason even when the row would otherwise be
          // ordinary-clear, so a probe/continuation cannot become an untyped
          // task artifact.
          const legalContinuationReasons = ['graph-drift', 'graph-incomplete', 'handoff-pending', 'parent-recovering', 'progress-stale', 'terminal-tail', 'unit-recovering'] as const;
          const present = rowReasons.filter((reason) => (legalContinuationReasons as readonly string[]).includes(reason));
          if (present.length !== 1 || present[0] === undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 recovery artifact registration requires exactly one accepted continuation row reason', [...rowReasons]);
          const verdict = recoveryTransitionAllowed({ action: 'register-authoritative-artifact', global_stop_reasons: frame.global_stop_reasons, row_stop_reasons: rowReasons, run_state: frame.run_state, graph: evaluationGraph, policy: frame.policy, heartbeat: frame.heartbeat, bindings: { attached_session_current: frame.session.attached_session_current && frame.session.lease_current && frame.session.expected_version_current, policy_trust_current: frame.policy.policy_current, no_pending_publication: !frame.graph.graph_publication_pending, terminal_prepared_cancellable: false, terminal_after_commit: false, accepted_continuation_reason: present[0], covered_semantic_reason: null, attach_terminal_recovery: false } });
          if (!verdict.allowed) throw new CoordinationRuntimeError('invalid-state', 'D65 recovery artifact registration is fenced at its coordinator transaction boundary', verdict.denied_by.slice());
        } else if (!ordinary.allowed) {
          throw new CoordinationRuntimeError('invalid-state', 'D65 ordinary mutation register-authoritative-artifact is fenced at its coordinator transaction boundary', ordinary.denied_by.slice());
        }
      }
      const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'authoritative artifact repository'));
      const sourceRoot = sourceScope === 'repository' ? repository.canonical_root : this.#requireRunMainRoot(run.repo_id, run.workstream_run);
      this.#evidencePathUnderRoot(sourceRoot, ref);
      const gitCommit = payloadString(request.payload, 'git_commit');
      const verifiedCommit = this.#gitQueryText(sourceRoot, { kind: 'resolve-commit', revision: gitCommit }, 'invalid-request', 'authoritative artifact Git commit verification failed');
      if (verifiedCommit !== gitCommit) throw new CoordinationRuntimeError('invalid-request', 'authoritative artifact git_commit is not the exact verified commit in its registered source repository', [gitCommit, String(verifiedCommit)]);
      const sourceHead = this.#gitQueryText(sourceRoot, { kind: 'head' }, 'invalid-request', 'authoritative artifact source HEAD inspection failed');
      // A semantic graph registers graph-only H while the run-main remains at
      // its covered authority G. Every other artifact still registers from exact
      // current HEAD. #validateD65GraphRegistration proves H^=G=sourceHead.
      if (documentSchemaVersion !== 'autopilot.semantic_graph.v1' && sourceHead !== gitCommit) throw new CoordinationRuntimeError('invalid-request', 'authoritative artifact must be registered from the exact current source authority HEAD', [gitCommit, String(sourceHead)]);
      const shown = this.#gitQueryResult(sourceRoot, { kind: 'show-file', revision: gitCommit, path: ref }, 'invalid-request', 'authoritative artifact ref is not a blob at the immutable Git commit');
      if (shown.stdout.byteLength > MAX_COORDINATION_EVIDENCE_BYTES) throw new CoordinationRuntimeError('invalid-request', 'authoritative artifact Git blob exceeds the immutable evidence byte bound', [ref, `bytes=${String(shown.stdout.byteLength)}`]);
      const bytes = shown.stdout;
      const evidence = { ref, sha256: payloadString(request.payload, 'sha256') as `sha256:${string}` };
      const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (actual !== evidence.sha256) throw new CoordinationRuntimeError('invalid-request', 'authoritative artifact hash does not match immutable Git blob bytes', [evidence.sha256, actual]);
      if (documentSchemaVersion === 'autopilot.launch_policy.v1') {
        try {
          const rawPolicy = parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'launch policy');
          for (const field of ['parallel_cap', 'maximum_parallel_cap', 'expected_checkout_units'] as const) {
            const value = rawPolicy[field];
            if (typeof value === 'number' && value !== 1) throw new CoordinationRuntimeError('invalid-request', `launch-policy-cap-unauthorized: ${field} must remain exactly 1 under D65`, [`${field}=${String(value)}`]);
          }
          validateAuthoritativeCoordinationDocument(sourceType, documentSchemaVersion, bytes);
        } catch (error) {
          if (error instanceof CoordinationRuntimeError && error.message.includes('launch-policy-cap-unauthorized:')) throw error;
          throw new CoordinationRuntimeError('invalid-request', 'launch-policy-invalid: policy document is malformed', [error instanceof Error ? error.message : String(error)]);
        }
      } else validateAuthoritativeCoordinationDocument(sourceType, documentSchemaVersion, bytes);
      if (documentSchemaVersion === 'autopilot.subscription_probe.v1' && this.#isD65Run(run.repo_id, run.workstream_run)) {
        const probe = parseD65SubscriptionProbe(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'registered subscription probe'));
        const acceptedPolicy = this.#d65AcceptedLaunchPolicy(run.repo_id, run.workstream_run);
        const expectedRef = `authority/subscription-probes/${String(probe.probe_sequence).padStart(20, '0')}-${probe.probe_id}.json`;
        if (ref !== expectedRef || probe.program_id !== acceptedPolicy.policy.program_id || probe.repo_id !== run.repo_id || probe.workstream_run !== run.workstream_run || probe.trust_anchor_ref !== acceptedPolicy.policy.trust_anchor_ref || probe.trust_anchor_sha256 !== acceptedPolicy.policy.trust_anchor_sha256 || probe.signer_key_id !== acceptedPolicy.anchor.sha256) throw new CoordinationRuntimeError('invalid-request', 'subscription probe identity/path/trust tuple does not equal accepted D65 authority', [ref, expectedRef]);
        const { signature: _signature, ...unsignedProbe } = probe;
        void _signature;
        if (!verifyD65Signature({ trustAnchor: acceptedPolicy.anchor, purpose: 'subscription-probe', message: new TextEncoder().encode(canonicalJson(unsignedProbe)), signature: probe.signature })) throw new CoordinationRuntimeError('unauthorized-client', 'subscription probe signature is invalid for the accepted trust anchor');
        const coordinatorMs = Date.parse(this.#clock.now().toISOString());
        if (!(Date.parse(probe.issued_at) <= coordinatorMs && coordinatorMs < Date.parse(probe.expires_at))) throw new CoordinationRuntimeError('invalid-request', 'subscription probe is early or expired at registration coordinator time', [probe.issued_at, probe.expires_at]);
        const triggerRows = this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.continuation_event.v1' AND json_extract(payload_json, '$.evidence.ref')=?").all(run.repo_id, run.workstream_run, probe.trigger_continuation_ref).map(authoritativeArtifactFromRow);
        const triggerArtifact = triggerRows[0];
        if (triggerRows.length !== 1 || triggerArtifact === undefined || triggerArtifact.evidence.sha256 !== probe.trigger_continuation_sha256) throw new CoordinationRuntimeError('invalid-request', 'subscription probe trigger is not one exact accepted continuation artifact', [probe.trigger_continuation_ref]);
        const trigger = parseD65ContinuationEvent(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(run.repo_id, triggerArtifact.evidence)), 'subscription probe trigger'));
        if (trigger.trigger !== 'subscription-failure' || trigger.class !== 'provider-capacity-blocked' || trigger.provider !== probe.provider || trigger.repo_id !== run.repo_id || trigger.workstream_run !== run.workstream_run || trigger.unit_id !== probe.unit_id || trigger.attempt !== probe.failed_attempt || trigger.retry_ordinal !== probe.retry_ordinal || trigger.cooldown_until !== probe.cooldown_until) throw new CoordinationRuntimeError('invalid-request', 'subscription probe does not bind the exact accepted first-failure continuation tuple');
        const priors = this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.subscription_probe.v1' ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(authoritativeArtifactFromRow).map((artifact) => ({ artifact, probe: parseD65SubscriptionProbe(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(run.repo_id, artifact.evidence)), 'prior registered subscription probe')) })).filter((entry) => entry.probe.program_id === probe.program_id && entry.probe.provider === probe.provider && entry.probe.workstream_run === probe.workstream_run).sort((left, right) => left.probe.probe_sequence - right.probe.probe_sequence);
        const prior = priors[priors.length - 1];
        if (probe.probe_sequence !== priors.length + 1 || probe.prior_probe_sha256 !== (prior?.artifact.evidence.sha256 ?? null)) throw new CoordinationRuntimeError('stale-version', 'subscription probe local chain has a gap, fork, or wrong immediate prior', [String(probe.probe_sequence), String(priors.length + 1)]);
      }
      if (documentSchemaVersion === 'autopilot.continuation_event.v1' && this.#isD65Run(run.repo_id, run.workstream_run)) {
        const continuation = parseD65ContinuationEvent(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'registered continuation event'));
        const expectedSuffix = `${String(continuation.event_sequence).padStart(20, '0')}-${continuation.event_id}.json`;
        if (!ref.endsWith(`/authority/continuation/${expectedSuffix}`) || continuation.repo_id !== run.repo_id || continuation.workstream_run !== run.workstream_run) throw new CoordinationRuntimeError('invalid-request', 'continuation event path/sequence/id/run tuple is not exact', [ref, expectedSuffix]);
        if (continuation.trigger === 'parent-loss') {
          const currentSession = this.#requireCurrentSession(request);
          const graphHead = this.#d65AcceptedGraphHead(run.repo_id, run.workstream_run);
          const evidence = continuation.evidence_refs[0];
          const parentRows = evidence === undefined ? [] : this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.parent_loss.v1' AND json_extract(payload_json, '$.evidence.ref')=?").all(run.repo_id, run.workstream_run, evidence.ref).map(authoritativeArtifactFromRow);
          const parent = parentRows[0];
          if (continuation.class !== 'parent-recovering' || continuation.session_lease_id !== currentSession.session_lease_id || continuation.successor_id !== currentSession.session_lease_id || continuation.evidence_refs.length !== 1 || parentRows.length !== 1 || parent === undefined || evidence === undefined || evidence.sha256 !== parent.evidence.sha256 || continuation.prior_graph_sha256 !== graphHead.sha256 || continuation.result_graph_sequence !== d65SemanticGraphSequenceFromArtifactId(graphHead.artifact.artifact_id) + 1) throw new CoordinationRuntimeError('invalid-request', 'parent-loss continuation does not bind the current session/parent artifact/prior-result graph tuple');
        }
      }
      if (documentSchemaVersion === 'autopilot.parent_loss.v1' && this.#isD65Run(run.repo_id, run.workstream_run)) {
        // The committed parent-loss artifact must be byte-identical to the one
        // fixed candidate authenticated/consumed by THIS successor attach. A
        // second validly signed candidate, alternate candidate path, or digest
        // from another generation has no registration authority.
        const currentSession = this.#requireCurrentSession(request);
        const attachedEvent = asRow(this.#db.prepare("SELECT event_seq,idempotency_key,request_sha256 FROM events WHERE repo_id=? AND event_seq=? AND event_type='session-attached' AND entity_type='session-lease' AND entity_id=?").get(run.repo_id, currentSession.attached_event_seq, currentSession.session_lease_id), 'parent-loss registration attach event');
        const attachedResult = asRow(this.#db.prepare('SELECT request_sha256,committed_event_seq,payload_json FROM idempotency_results WHERE repo_id=? AND idempotency_key=?').get(run.repo_id, sqlString(attachedEvent, 'idempotency_key')), 'parent-loss registration attach result');
        if (sqlString(attachedResult, 'request_sha256') !== sqlString(attachedEvent, 'request_sha256') || sqlInteger(attachedResult, 'committed_event_seq') !== currentSession.attached_event_seq) throw new CoordinationRuntimeError('store-corrupt', 'parent-loss successor attach event/result identity is inconsistent');
        const attachedPayload = parseJsonObject(sqlString(attachedResult, 'payload_json'), 'parent-loss successor attach result');
        const attachedDigest = attachedPayload['parent_loss_candidate_sha256'];
        if (attachedDigest !== actual) throw new CoordinationRuntimeError('invalid-request', 'parent-loss artifact bytes are not byte-identical to the candidate consumed by the current successor attach', [String(attachedDigest), actual]);
        const parentLoss = parseD65ParentLoss(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'registered parent-loss artifact'));
        if (parentLoss.successor_session_id !== currentSession.session_id || parentLoss.successor_session_lease_id !== currentSession.session_lease_id || parentLoss.successor_generation !== currentSession.session_generation || parentLoss.successor_pid !== currentSession.pid || parentLoss.successor_boot_id !== currentSession.boot_id) throw new CoordinationRuntimeError('invalid-request', 'parent-loss artifact successor identity differs from the current candidate-authorized session');
      }
      const artifactId = payloadString(request.payload, 'artifact_id');
      // D65-A2: a complete-graph root registers at its publication commit H with
      // non-self-referential publication rules (sole-parent-G, graph-only diff,
      // self-exclusion). The artifact id is the deterministic
      // semantic-graph:<20-digit-sequence>; graph_commit is H = current HEAD.
      if (documentSchemaVersion === 'autopilot.semantic_graph.v1') {
        this.#validateD65GraphRegistration(run.repo_id, run.workstream_run, sourceRoot, gitCommit, ref, evidence.sha256, bytes, artifactId);
      }
      // D65-A1 immutable cap-one launch policy (fresh plan §2.3 line 84/86/110,
      // freeze §9.4). The signed policy registers through this existing action;
      // beyond the structural parse it must be coordinator-AUTHENTICATED against
      // the accepted bootstrap artifact: SPKI/signature, package/B0/run/roster/
      // graph-digest identity, one-parent one-policy-path commit descending from
      // content_result_commit, mode-0700 evidence root, cap/max/expected==1, and
      // policy-before-parent-planning ordering. This runs pre-commit; a failure
      // rolls the whole register transaction back.
      if (documentSchemaVersion === 'autopilot.launch_policy.v1') {
        this.#validateD65LaunchPolicyRegistration(run.repo_id, run.workstream_run, sourceRoot, gitCommit, ref, bytes);
      }
      if (this.#db.prepare('SELECT entity_id FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(run.repo_id, artifactId) !== undefined) throw new CoordinationRuntimeError('stale-version', 'authoritative artifact id already exists');
      const seq = this.#nextEventSequence(run.repo_id);
      const artifact: CoordinationAuthoritativeArtifact = { schema_version: 'autopilot.authoritative_artifact.v1', artifact_id: artifactId, repo_id: run.repo_id, source_run: run.workstream_run, source_type: sourceType, source_scope: sourceScope, document_schema_version: documentSchemaVersion, git_commit: gitCommit, evidence, registered_event_seq: seq, version: 1 };
      this.#db.prepare('INSERT INTO authoritative_artifacts(entity_id, repo_id, source_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(artifact.artifact_id, artifact.repo_id, artifact.source_run, canonicalJson(artifact), artifact.version);
      this.#persistEvidenceArtifact(run.repo_id, artifact.evidence, bytes, `authoritative ${sourceType}`, seq);
      // D65-A5 point 1 (freeze §9.4): the graph-registration SQLite transaction
      // inserts ONLY the exact artifact row, the `authoritative-artifact-
      // registered` R event, the evidence blob, and the idempotency result, then
      // COMMITs with NO residue filesystem mutation. The graph-publication saga
      // residue advance `publication-committed -> registered` is the RUNTIME
      // graph consumer's responsibility, performed ONLY after a committed
      // response, or after response-loss recovery independently proves this exact
      // immutable artifact/event/result (see lookupCommittedGraphRegistration).
      // A rollback can never coexist with a registered residue.
      return { sequence: seq, eventType: 'authoritative-artifact-registered', entityType: 'authoritative-artifact', entityId: artifact.artifact_id, payload: { authoritative_artifact: artifact } };
    });
  }

  assignAdjudication(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
      this.#assertVersion(run.version, request.expected_version, 'run');
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#assertD65OrdinaryMutationAllowed(request, run, 'assign-adjudication');
      const proposed = parseCoordinationAdjudicationAssignment(request.payload['assignment']);
      if (proposed.repo_id !== run.repo_id || proposed.requesting_run !== run.workstream_run || !proposed.participating_runs.includes(run.workstream_run)) throw new CoordinationRuntimeError('unauthorized-client', 'adjudication assignment must be requested by a participating durable run');
      if (proposed.state !== 'assigned' || proposed.adjudication !== null || proposed.child_lease_id !== null || proposed.assigned_event_seq !== 0 || proposed.accepted_event_seq !== null || proposed.version !== 1) throw new CoordinationRuntimeError('invalid-request', 'new adjudication assignment must use the canonical uncommitted assigned state');
      for (const participatingRun of proposed.participating_runs) this.#requireRun(run.repo_id, participatingRun);
      if (proposed.adjudicator.repo_id !== run.repo_id) throw new CoordinationRuntimeError('invalid-request', 'adjudicator repository identity must match the contradiction repository');
      if (proposed.participating_runs.includes(proposed.adjudicator.workstream_run)) throw new CoordinationRuntimeError('invalid-request', 'adjudicator run must be independent from every participating run');
      const adjudicatorRun = this.#requireRun(run.repo_id, proposed.adjudicator.workstream_run);
      if (adjudicatorRun.autopilot_id !== proposed.adjudicator.autopilot_id) throw new CoordinationRuntimeError('invalid-request', 'adjudicator identity does not match its durable run');
      const attempt = this.#requireUnitAttempt(proposed.adjudicator.repo_id, proposed.adjudicator.workstream_run, proposed.adjudicator.unit_id, proposed.adjudicator.attempt);
      if (attempt.role !== 'adjudicate' || (attempt.state !== 'preflight' && attempt.state !== 'running')) throw new CoordinationRuntimeError('invalid-request', 'assignment requires a live durable adjudication-role attempt');
      const artifacts = proposed.authoritative_artifact_ids.map((artifactId) => authoritativeArtifactFromRow(asRow(this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(run.repo_id, artifactId), `authoritative artifact ${artifactId}`)));
      const artifactKeys = new Map(artifacts.map((artifact) => [`${artifact.evidence.ref}\0${artifact.evidence.sha256}`, artifact]));
      const artifactContents = new Map(artifacts.map((artifact) => [artifact.artifact_id, this.#loadEvidenceArtifact(run.repo_id, artifact.evidence)]));
      const totalArtifactBytes = [...artifactContents.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
      if (totalArtifactBytes > MAX_ADJUDICATION_BUNDLE_BYTES) throw new CoordinationRuntimeError('invalid-request', 'adjudication assignment authoritative bundle exceeds its bounded transport and review ceiling', [`size=${String(totalArtifactBytes)}`, `maximum=${String(MAX_ADJUDICATION_BUNDLE_BYTES)}`]);
      const clauseArtifactKeys = new Set(proposed.conflicting_clauses.map((clause) => `${clause.authoritative_ref.ref}\0${clause.authoritative_ref.sha256}`));
      if (artifactKeys.size !== clauseArtifactKeys.size || [...artifactKeys.keys()].some((key) => !clauseArtifactKeys.has(key))) throw new CoordinationRuntimeError('invalid-request', 'adjudication assignment authoritative artifacts must exactly equal its conflicting clause refs');
      if (artifacts.some((artifact) => !proposed.participating_runs.includes(artifact.source_run))) throw new CoordinationRuntimeError('invalid-request', 'every authoritative artifact must be registered by a participating run');
      for (const clause of proposed.conflicting_clauses) {
        const artifact = artifactKeys.get(`${clause.authoritative_ref.ref}\0${clause.authoritative_ref.sha256}`);
        if (artifact === undefined || artifact.source_run !== clause.source_run || artifact.source_type !== clause.source_type || artifact.source_scope !== clause.source_scope || artifact.document_schema_version !== clause.schema_version) throw new CoordinationRuntimeError('invalid-request', 'contradiction clause does not exactly match its coordinator-registered authoritative artifact', [clause.clause_id]);
        const bytes = artifactContents.get(artifact.artifact_id);
        if (bytes === undefined) throw new CoordinationRuntimeError('store-corrupt', 'registered authoritative artifact bytes disappeared');
        if (!Buffer.from(bytes).toString('utf8').includes(clause.exact_requirement)) throw new CoordinationRuntimeError('invalid-request', 'contradiction clause exact requirement is absent from its registered immutable artifact', [clause.clause_id]);
      }
      const outcomes = new Map<string, Set<string>>();
      for (const clause of proposed.conflicting_clauses) {
        const values = outcomes.get(clause.artifact_or_invariant) ?? new Set<string>();
        values.add(clause.demanded_outcome);
        outcomes.set(clause.artifact_or_invariant, values);
      }
      if (![...outcomes.values()].some((values) => values.size >= 2)) throw new CoordinationRuntimeError('invalid-request', 'assignment clauses do not demand incompatible final outcomes for one artifact or invariant');
      if (this.#db.prepare('SELECT entity_id FROM adjudication_assignments WHERE repo_id=? AND entity_id=?').get(run.repo_id, proposed.assignment_id) !== undefined) throw new CoordinationRuntimeError('stale-version', 'adjudication assignment id already exists');
      const existingAttemptAssignment = this.#db.prepare("SELECT entity_id FROM adjudication_assignments WHERE repo_id=? AND json_extract(payload_json, '$.state')='assigned' AND json_extract(payload_json, '$.adjudicator.repo_id')=? AND json_extract(payload_json, '$.adjudicator.autopilot_id')=? AND json_extract(payload_json, '$.adjudicator.workstream_run')=? AND json_extract(payload_json, '$.adjudicator.unit_id')=? AND json_extract(payload_json, '$.adjudicator.attempt')=? LIMIT 1").get(run.repo_id, proposed.adjudicator.repo_id, proposed.adjudicator.autopilot_id, proposed.adjudicator.workstream_run, proposed.adjudicator.unit_id, proposed.adjudicator.attempt);
      if (existingAttemptAssignment !== undefined) throw new CoordinationRuntimeError('invalid-state', 'adjudication attempt already has a live coordinator assignment');
      const seq = this.#nextEventSequence(run.repo_id);
      const assignment: CoordinationAdjudicationAssignment = { ...proposed, assigned_event_seq: seq };
      this.#db.prepare('INSERT INTO adjudication_assignments(entity_id, repo_id, requesting_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(assignment.assignment_id, assignment.repo_id, assignment.requesting_run, canonicalJson(assignment), assignment.version);
      this.#insertMessage({ schema_version: 'autopilot.coordination_message.v1', message_id: stableEntityId('message', ['adjudication-assignment', assignment.repo_id, assignment.assignment_id]), repo_id: assignment.repo_id, recipient_workstream_run: assignment.adjudicator.workstream_run, message_type: 'adjudication-assignment', correlation_id: assignment.assignment_id, payload: { assignment_id: assignment.assignment_id, authoritative_artifact_ids: assignment.authoritative_artifact_ids, participating_runs: assignment.participating_runs }, status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1 });
      return { sequence: seq, eventType: 'adjudication-assigned', entityType: 'adjudication-assignment', entityId: assignment.assignment_id, payload: { adjudication_assignment: assignment } };
    });
  }

  claimAdjudicationAssignment(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
      this.#assertVersion(run.version, request.expected_version, 'run');
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#assertD65OrdinaryMutationAllowed(request, run, 'claim-adjudication-assignment');
      const unitId = payloadString(request.payload, 'unit_id');
      const attempt = payloadInteger(request.payload, 'attempt');
      const assignments = this.#db.prepare("SELECT * FROM adjudication_assignments WHERE repo_id=? AND json_extract(payload_json, '$.state')='assigned' AND json_extract(payload_json, '$.adjudicator.workstream_run')=? AND json_extract(payload_json, '$.adjudicator.unit_id')=? AND json_extract(payload_json, '$.adjudicator.attempt')=? ORDER BY entity_id").all(run.repo_id, run.workstream_run, unitId, attempt).map(adjudicationAssignmentFromRow);
      if (assignments.length === 0) throw new CoordinationRuntimeError('invalid-state', 'adjudication attempt has no assigned planning contradiction');
      if (assignments.length !== 1) throw new CoordinationRuntimeError('store-corrupt', 'adjudication attempt has multiple simultaneous assignments; query status for exact identities', [`assignment_count=${String(assignments.length)}`]);
      const assignment = assignments[0];
      if (assignment === undefined) throw new CoordinationRuntimeError('invalid-state', 'adjudication assignment disappeared');
      const documents = assignment.authoritative_artifact_ids.map((artifactId) => {
        const artifact = authoritativeArtifactFromRow(asRow(this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(run.repo_id, artifactId), `authoritative artifact ${artifactId}`));
        const bytes = this.#loadEvidenceArtifact(run.repo_id, artifact.evidence);
        return { artifact, content_utf8: Buffer.from(bytes).toString('utf8') };
      });
      if (Buffer.byteLength(canonicalJson(documents), 'utf8') > MAX_ADJUDICATION_BUNDLE_BYTES * 3) throw new CoordinationRuntimeError('invalid-state', 'serialized adjudication bundle exceeds the coordinator frame safety ceiling');
      const seq = this.#nextEventSequence(run.repo_id);
      return { sequence: seq, eventType: 'adjudication-assignment-claimed', entityType: 'adjudication-assignment', entityId: assignment.assignment_id, payload: { adjudication_assignment: assignment, authoritative_documents: documents } };
    });
  }

  completeAdjudication(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      const childId = payloadString(request.payload, 'child_lease_id');
      const childRow = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'adjudicator child');
      const child = childFromRow(childRow);
      this.#assertChildAuthority(request, child, childRow);
      this.#assertVersion(child.version, request.expected_version, 'child lease');
      if (child.status !== 'running') throw new CoordinationRuntimeError('invalid-state', `adjudicator child lease is ${child.status}`);
      const run = this.#requireRun(child.owner.repo_id, child.owner.workstream_run);
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#assertD65OrdinaryMutationAllowed(request, run, 'complete-adjudication', this.#d65CurrentDispatchContext(run));
      this.#assertAuthorityCriticalMutationAllowed(child.owner.repo_id, child.owner.workstream_run, 'adjudication terminal acceptance and authority release');
      const assignmentId = payloadString(request.payload, 'assignment_id');
      const assignmentRow = asRow(this.#db.prepare('SELECT * FROM adjudication_assignments WHERE repo_id=? AND entity_id=?').get(request.repo_id, assignmentId), 'adjudication assignment');
      const assignment = adjudicationAssignmentFromRow(assignmentRow);
      if (assignment.state !== 'assigned' || !sameOwner(assignment.adjudicator, child.owner)) throw new CoordinationRuntimeError('unauthorized-client', 'child is not the assigned independent adjudicator');
      const attempt = this.#requireUnitAttempt(child.owner.repo_id, child.owner.workstream_run, child.owner.unit_id, child.owner.attempt);
      if (attempt.role !== 'adjudicate' || attempt.state !== 'running') throw new CoordinationRuntimeError('invalid-state', 'adjudication completion requires the assigned running adjudication attempt');
      const unitWorktrees = this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND kind='unit' AND unit_id=? AND attempt=? AND is_current_canonical=1 AND json_extract(payload_json, '$.state')!='removed' ORDER BY canonical_worktree_id").all(child.owner.repo_id, child.owner.workstream_run, child.owner.unit_id, child.owner.attempt).map(canonicalWorktreeFromRow);
      if (unitWorktrees.length !== 1) throw new CoordinationRuntimeError('invalid-state', 'adjudication evidence requires exactly one active durable adjudicator unit worktree');
      const unitWorktree = unitWorktrees[0];
      if (unitWorktree === undefined) throw new CoordinationRuntimeError('invalid-state', 'adjudicator unit worktree disappeared');
      const adjudicationPath = payloadString(request.payload, 'adjudication_path');
      const expectedPath = this.#evidencePathUnderRoot(unitWorktree.canonical_path, `adjudications/${assignment.assignment_id}.json`);
      let canonicalAdjudicationPath: string;
      try { canonicalAdjudicationPath = realpathSync(adjudicationPath); }
      catch (error) { throw new CoordinationRuntimeError('invalid-request', 'assigned adjudication output is unreadable', [adjudicationPath, error instanceof Error ? error.message : String(error)]); }
      if (canonicalAdjudicationPath !== realpathSync(expectedPath)) throw new CoordinationRuntimeError('unauthorized-client', 'adjudication output path is not the assignment-derived path in the assigned unit worktree');
      const bytes = this.#readRegularEvidenceFile(expectedPath, 'assigned adjudication output');
      const adjudication = { ref: `adjudications/${assignment.assignment_id}.json`, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as `sha256:${string}` };
      const documents = assignment.authoritative_artifact_ids.map((artifactId) => {
        const artifact = authoritativeArtifactFromRow(asRow(this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(assignment.repo_id, artifactId), `authoritative artifact ${artifactId}`));
        return { ref: artifact.evidence, bytes: this.#loadEvidenceArtifact(assignment.repo_id, artifact.evidence) };
      });
      const packet: CoordinationEscalation = { schema_version: 'autopilot.planning_contradiction.v1', escalation_id: assignment.assignment_id, repo_id: assignment.repo_id, participating_runs: assignment.participating_runs, authoritative_refs: documents.map((document) => document.ref), conflicting_clauses: assignment.conflicting_clauses, exhausted_alternatives: ['sequencing', 'partitioning', 'ownership-transfer', 'rebase-revalidation', 'replanning'], adjudication, decision_options: assignment.decision_options, created_event_seq: 0, version: 1 };
      const validated = validatePlanningContradictionSubmission({ packet, adjudicationBytes: bytes, authoritativeDocuments: documents });
      if (!sameOwner(validated.adjudication.adjudicator, assignment.adjudicator)) throw new CoordinationRuntimeError('invalid-request', 'adjudication evidence identity does not exactly match the coordinator-assigned adjudicator');
      const terminalEvidence = { ref: payloadString(request.payload, 'terminal_evidence_ref'), sha256: payloadString(request.payload, 'terminal_evidence_sha256') as `sha256:${string}` };
      if (!SHA256_PATTERN.test(terminalEvidence.sha256)) throw new CoordinationRuntimeError('invalid-request', 'adjudication completion terminal evidence hash is invalid');
      this.#verifyAcceptedEvidenceFile(this.#requireRun(child.owner.repo_id, child.owner.workstream_run), 'child-process', child.child_lease_id, terminalEvidence);
      const seq = this.#nextEventSequence(assignment.repo_id);
      this.#persistEvidenceArtifact(assignment.repo_id, adjudication, bytes, 'assigned independent adjudication', seq);
      this.#acceptReconciliationEvidence({ repoId: child.owner.repo_id, workstreamRun: child.owner.workstream_run, source: 'child-process', targetId: child.child_lease_id, evidence: terminalEvidence, seq });
      const accepted: CoordinationAdjudicationAssignment = { ...assignment, state: 'accepted', adjudication, child_lease_id: child.child_lease_id, accepted_event_seq: seq, version: assignment.version + 1 };
      this.#db.prepare('UPDATE adjudication_assignments SET payload_json=?, version=? WHERE repo_id=? AND entity_id=?').run(canonicalJson(accepted), accepted.version, accepted.repo_id, accepted.assignment_id);
      this.#db.prepare("UPDATE child_leases SET status='terminal', terminal_evidence_ref=?, terminal_evidence_sha256=?, version=version+1 WHERE child_lease_id=?").run(terminalEvidence.ref, terminalEvidence.sha256, child.child_lease_id);
      const adjudicatorRun = this.#requireRun(child.owner.repo_id, child.owner.workstream_run);
      const releasedLeaseIds = this.#releaseAttemptLeases(adjudicatorRun, `${child.owner.unit_id}:${String(child.owner.attempt)}`);
      this.#updateAttemptForSatisfiedCondition(child.owner, 'child-terminal');
      this.#reevaluateWaitingGroups(child.owner.repo_id, seq);
      const reconciliation = this.#freezeReconciliationSummary({ ...this.#emptyReconciliationSummary(), released_lease_ids: releasedLeaseIds });
      const reconciliationReceipt = this.#persistReconciliationReceipt(request.repo_id, child.owner.workstream_run, request.action, seq, reconciliation);
      return { sequence: seq, eventType: 'adjudication-accepted', entityType: 'adjudication-assignment', entityId: accepted.assignment_id, payload: { adjudication_assignment: accepted, child: childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(child.child_lease_id), 'completed adjudicator child')), ...this.#reconciliationReceiptPayload(reconciliationReceipt) } };
    });
  }

  submitPlanningContradiction(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
      this.#assertVersion(run.version, request.expected_version, 'run');
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#assertD65OrdinaryMutationAllowed(request, run, 'submit-planning-contradiction');
      const submitted = parseCoordinationEscalation(request.payload['packet']);
      if (submitted.repo_id !== run.repo_id || !submitted.participating_runs.includes(run.workstream_run)) throw new CoordinationRuntimeError('unauthorized-client', 'planning contradiction must include the submitting durable run');
      if (submitted.created_event_seq !== 0 || submitted.version !== 1) throw new CoordinationRuntimeError('invalid-request', 'new planning contradiction packet must use created_event_seq 0 and version 1 before coordinator commit');
      for (const participatingRun of submitted.participating_runs) this.#requireRun(run.repo_id, participatingRun);
      const assignmentId = payloadString(request.payload, 'assignment_id');
      const assignment = adjudicationAssignmentFromRow(asRow(this.#db.prepare('SELECT * FROM adjudication_assignments WHERE repo_id=? AND entity_id=?').get(run.repo_id, assignmentId), 'accepted adjudication assignment'));
      if (assignment.state !== 'accepted' || assignment.adjudication === null || assignment.child_lease_id === null) throw new CoordinationRuntimeError('invalid-state', 'planning contradiction requires an accepted coordinator-assigned adjudication result');
      if (assignment.assignment_id !== submitted.escalation_id || canonicalJson(assignment.participating_runs) !== canonicalJson(submitted.participating_runs) || canonicalJson(assignment.conflicting_clauses) !== canonicalJson(submitted.conflicting_clauses) || canonicalJson(assignment.decision_options) !== canonicalJson(submitted.decision_options) || canonicalJson(assignment.adjudication) !== canonicalJson(submitted.adjudication)) throw new CoordinationRuntimeError('invalid-request', 'planning contradiction packet does not exactly match its accepted adjudication assignment');
      const child = childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(assignment.child_lease_id), 'accepted adjudicator child'));
      if (!sameOwner(child.owner, assignment.adjudicator) || child.status !== 'terminal' || child.terminal_evidence === null) throw new CoordinationRuntimeError('store-corrupt', 'accepted adjudication is not bound to terminal child acceptance evidence');
      const childAcceptance = parseAutopilotChildTerminalAcceptance(parseJsonObject(Buffer.from(this.#verifyAcceptedEvidenceFile(this.#requireRun(child.owner.repo_id, child.owner.workstream_run), 'child-process', child.child_lease_id, child.terminal_evidence)).toString('utf8'), 'accepted adjudicator terminal evidence'));
      if (childAcceptance.child_lease_id !== child.child_lease_id || childAcceptance.role !== 'adjudicate' || childAcceptance.unit_id !== assignment.adjudicator.unit_id || childAcceptance.attempt !== assignment.adjudicator.attempt) throw new CoordinationRuntimeError('store-corrupt', 'accepted adjudication terminal acceptance identity differs from its assignment');
      const authoritativeDocuments = assignment.authoritative_artifact_ids.map((artifactId) => {
        const artifact = authoritativeArtifactFromRow(asRow(this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(run.repo_id, artifactId), `authoritative artifact ${artifactId}`));
        return { ref: artifact.evidence, bytes: this.#loadEvidenceArtifact(run.repo_id, artifact.evidence) };
      });
      if (canonicalJson(authoritativeDocuments.map((document) => document.ref)) !== canonicalJson(submitted.authoritative_refs)) throw new CoordinationRuntimeError('invalid-request', 'planning contradiction authoritative refs do not exactly match the assigned registered artifacts');
      const adjudicationBytes = this.#loadEvidenceArtifact(run.repo_id, assignment.adjudication);
      const validated = validatePlanningContradictionSubmission({ packet: submitted, adjudicationBytes, authoritativeDocuments });
      const duplicate = this.#db.prepare("SELECT entity_id FROM escalations WHERE repo_id=? AND json_extract(payload_json, '$.adjudication.sha256')=? LIMIT 1").get(run.repo_id, submitted.adjudication.sha256);
      if (duplicate !== undefined) throw new CoordinationRuntimeError('invalid-state', 'independent adjudication evidence already created a planning contradiction packet');
      const seq = this.#nextEventSequence(run.repo_id);
      const packet: CoordinationEscalation = { ...validated.packet, created_event_seq: seq };
      this.#db.prepare('INSERT INTO escalations(entity_id, repo_id, payload_json, version) VALUES(?, ?, ?, ?)').run(stableEntityId('escalation', [packet.repo_id, packet.escalation_id]), packet.repo_id, canonicalJson(packet), packet.version);
      return { sequence: seq, eventType: 'planning-contradiction-accepted', entityType: 'escalation', entityId: packet.escalation_id, payload: { escalation: packet, failure_code: 'planning-contradiction-review' } };
    });
  }

  recordReleaseEvidence(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const workstreamRun = this.#workstreamRun(request);
      const run = this.#requireRun(request.repo_id, workstreamRun);
      this.#assertVersion(run.version, request.expected_version, 'run');
      this.#assertAuthorityCriticalMutationAllowed(run.repo_id, run.workstream_run, 'terminal/reconciliation evidence acceptance and authority release');
      const source = this.#reconciliationSource(payloadString(request.payload, 'source'));
      if (source === 'child-process') throw new CoordinationRuntimeError('invalid-request', 'child-process terminal evidence is accepted only through authenticated complete-child or the closed startup repair path');
      const conditionType = this.#conditionTypeForSource(source);
      const targetId = payloadString(request.payload, 'target_id');
      const evidenceRef = payloadString(request.payload, 'evidence_ref');
      const evidenceSha256 = payloadString(request.payload, 'evidence_sha256') as `sha256:${string}`;
      this.#assertReconciliationTarget(run, conditionType, targetId);
      let d65FirstEffectBaseline: D65TerminalFirstEffectBaseline | null = null;
      if ((source === 'run-close' || source === 'run-abort') && this.#isD65Run(run.repo_id, run.workstream_run)) {
        this.#assertD65TerminalTailEntry(run, source);
        this.#assertD65RecoveryMutationAllowed(request, run, 'terminal-tail', { attached_session_current: true, policy_trust_current: true, no_pending_publication: true, terminal_prepared_cancellable: false, terminal_after_commit: false, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false });
        d65FirstEffectBaseline = this.#captureD65TerminalFirstEffectBaseline(run);
      } else if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) {
        if (source === 'attempt-reset' || source === 'quarantine-capture') this.#assertD65UnitRecoveryEvidenceMutationAllowed(request, run, evidenceRef, evidenceSha256);
        else this.#assertD65OrdinaryMutationAllowed(request, run, 'record-release-evidence');
      }
      const seq = this.#nextEventSequence(request.repo_id);
      const evidence = this.#acceptReconciliationEvidence({
        repoId: request.repo_id,
        workstreamRun,
        source,
        targetId,
        evidence: { ref: evidenceRef, sha256: evidenceSha256 },
        seq,
      });
      let convertedReservations: readonly CoordinationChangeReservation[] = [];
      let createdObligations: readonly CoordinationReservationObligation[] = [];
      let staleObservationIds: readonly string[] = [];
      if (source === 'unit-merge') {
        this.#requireCoordinatorEditAuthority(run, 'unit-merge reservation conversion');
        const converted = this.#convertUnitMergeToReservations(run, targetId, { ref: evidenceRef, sha256: evidenceSha256 }, seq);
        convertedReservations = converted.reservations;
        createdObligations = converted.obligations;
        const mergeFacts = parseUnitMergeReservationFacts(this.#verifyAcceptedEvidenceFile(run, source, targetId, { ref: evidenceRef, sha256: evidenceSha256 }));
        staleObservationIds = Object.freeze(converted.reservations.flatMap((reservation) => this.#markOverlappingObservationsStale(run, reservation, mergeFacts.integrationAfter, seq)));
      }
      if (source === 'run-close') this.#assertRunCloseReservationReady(run);
      if (source === 'run-close' || source === 'run-abort') this.#assertRunTerminalExternalReady(run);
      const terminalIntent = source === 'run-close' || source === 'run-abort' ? this.#assertPreparedTerminalIntent(run, source) : null;
      this.#updateAttemptFromEvidence(run, conditionType, targetId);
      const terminalSha = source === 'run-close' || source === 'run-abort' ? parseRunTerminalSha(this.#verifyAcceptedEvidenceFile(run, source, targetId, { ref: evidenceRef, sha256: evidenceSha256 })) : null;
      if (terminalSha !== null && (source === 'run-close' || source === 'run-abort')) this.#assertRunTerminalGitFacts(run, source, terminalSha);
      const directlyReleasedLeaseIds: string[] = [];
      if (source === 'attempt-reset' || source === 'quarantine-capture') directlyReleasedLeaseIds.push(...this.#releaseAttemptLeases(run, targetId));
      let nextRun = run;
      if (conditionType === 'run-closed' && run.status !== 'closed' && run.status !== 'aborted') {
        const terminalStatus = source === 'run-abort' ? 'aborted' : 'closed';
        this.#db.prepare('UPDATE runs SET status=?, version=version+1 WHERE repo_id=? AND workstream_run=?').run(terminalStatus, run.repo_id, run.workstream_run);
        nextRun = this.#requireRun(run.repo_id, run.workstream_run);
        if (terminalSha === null) throw new CoordinationRuntimeError('invalid-state', 'run terminal transition lost its verified terminal commit');
        staleObservationIds = this.#terminalizeRunReservations(nextRun, source === 'run-abort' ? 'run-abort' : 'run-close', terminalSha, seq);
        directlyReleasedLeaseIds.push(...this.#releaseAllRunLeases(nextRun));
        if (terminalIntent !== null) this.#commitTerminalIntent(terminalIntent, seq);
      }
      const reconciled = this.#reconcileOwnedRun(request.repo_id, workstreamRun, seq);
      const reconciliation = this.#freezeReconciliationSummary({ ...reconciled, released_lease_ids: [...directlyReleasedLeaseIds, ...reconciled.released_lease_ids], stale_observation_ids: [...staleObservationIds, ...reconciled.stale_observation_ids] });
      const reconciliationReceipt = this.#persistReconciliationReceipt(request.repo_id, run.workstream_run, request.action, seq, reconciliation);
      if (d65FirstEffectBaseline !== null) {
        if (terminalSha === null || (source !== 'run-close' && source !== 'run-abort')) throw new CoordinationRuntimeError('store-corrupt', 'D65 terminal first-effect verification lost terminal identity');
        this.#assertD65TerminalFirstEffectExact(d65FirstEffectBaseline, source, terminalSha, seq);
      }
      return { sequence: seq, eventType: 'release-evidence-accepted', entityType: 'reconciliation-evidence', entityId: evidence.reconciliation_evidence_id, payload: { reconciliation_evidence: evidence, run: nextRun, ...this.#reconciliationReceiptPayload(reconciliationReceipt), change_reservations: convertedReservations, reservation_obligations: createdObligations } };
    });
  }

  resolveReservationObligation(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const workstreamRun = this.#workstreamRun(request);
      const run = this.#requireRun(request.repo_id, workstreamRun);
      this.#requireCoordinatorEditAuthority(run, 'reservation resolution');
      this.#assertAuthorityCriticalMutationAllowed(run.repo_id, run.workstream_run, 'reservation integration acceptance');
      const obligationId = payloadString(request.payload, 'obligation_id');
      const obligation = reservationObligationFromRow(asRow(this.#db.prepare('SELECT * FROM reservation_obligations WHERE repo_id=? AND entity_id=?').get(request.repo_id, obligationId), 'reservation obligation'));
      this.#assertVersion(obligation.version, request.expected_version, 'reservation obligation');
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#assertD65OrdinaryMutationAllowed(request, run, 'resolve-reservation-obligation');
      if (obligation.workstream_run !== workstreamRun) throw new CoordinationRuntimeError('unauthorized-client', 'session cannot resolve a foreign-run reservation obligation');
      if ((obligation.state !== 'integration-required' && obligation.state !== 'resolved') || obligation.predecessor_released_event_seq === null || obligation.predecessor_terminal_sha === null) throw new CoordinationRuntimeError('invalid-state', `reservation obligation is ${obligation.state} without refreshable predecessor landing authority`);
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
      const integrationEvidence = { ref: payloadString(request.payload, 'integration_evidence_ref'), sha256: payloadString(request.payload, 'integration_evidence_sha256') as `sha256:${string}` };
      const validationEvidence = { ref: payloadString(request.payload, 'validation_evidence_ref'), sha256: payloadString(request.payload, 'validation_evidence_sha256') as `sha256:${string}` };
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

  prepareRunTerminal(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
      this.#requireCoordinatorEditAuthority(run, 'run terminal preparation');
      this.#assertVersion(run.version, request.expected_version, 'run');
      this.#assertAuthorityCriticalMutationAllowed(run.repo_id, run.workstream_run, 'run terminal preparation');
      if (this.#preparedTerminalIntent(run.repo_id, run.workstream_run) !== null) throw new CoordinationRuntimeError('coordinator-contention', 'run already has a prepared terminal intent');
      const outcomeValue = payloadString(request.payload, 'outcome');
      if (outcomeValue !== 'closed' && outcomeValue !== 'aborted') throw new CoordinationRuntimeError('invalid-request', 'terminal outcome must be closed or aborted');
      // Readiness is deliberately checked at terminal commit, not here. This
      // transaction must always establish the durable launch fence first; close
      // validation can then classify/cancel safely without a concurrent dispatch.
      const d65Bootstrap = this.#isD65Run(run.repo_id, run.workstream_run);
      if (d65Bootstrap) this.#assertD65OrdinaryMutationAllowed(request, run, 'prepare-run-terminal');
      const seq = this.#nextEventSequence(run.repo_id);
      const reservationIds = this.#db.prepare("SELECT entity_id FROM change_reservations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.released_event_seq') IS NULL ORDER BY entity_id").all(run.repo_id, run.workstream_run).map((row) => sqlString(row, 'entity_id'));
      // D65-A3: a D65 bootstrap-backed run MUST create append-only v2. Legacy
      // omission remains byte-compatible only when no D65 bootstrap authority
      // exists for the run.
      if (request.payload['intent_attempt'] !== undefined) return this.#applyD65TerminalIntentV2(request, run, seq, outcomeValue, reservationIds);
      if (d65Bootstrap) throw new CoordinationRuntimeError('invalid-request', 'D65 prepare-run-terminal requires append-only intent v2 attempt/prior/effect-set fields');
      const intent = parseCoordinationRunTerminalIntent({ schema_version: 'autopilot.run_terminal_intent.v1', terminal_intent_id: payloadString(request.payload, 'terminal_intent_id'), repo_id: run.repo_id, workstream_run: run.workstream_run, outcome: outcomeValue, state: 'prepared', reservation_ids: reservationIds, prepared_event_seq: seq, terminal_event_seq: null, version: 1 });
      const nextRun = parseCoordinationRun({ ...run, status: 'merging', version: run.version + 1 });
      this.#db.prepare('INSERT INTO run_terminal_intents(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(intent.terminal_intent_id, intent.repo_id, intent.workstream_run, canonicalJson(intent), intent.version);
      this.#db.prepare("UPDATE runs SET status='merging', version=? WHERE repo_id=? AND workstream_run=?").run(nextRun.version, run.repo_id, run.workstream_run);
      return { sequence: seq, eventType: 'run-terminal-prepared', entityType: 'run-terminal-intent', entityId: intent.terminal_intent_id, payload: { run_terminal_intent: intent, run: nextRun } };
    });
  }

  // D65-A3 append-only terminal-intent v2 preparation. Validates the exact
  // append-only attempt chain (3-cancel bound + mandatory 4th abort), recomputes
  // the repository-wide nonterminal obligation partition, byte-matches the
  // request's sealed terminal_effect_sets, creates the v2 row version 1, and
  // moves the run active->merging with run version+1.
  #applyD65TerminalIntentV2(request: CoordinatorRequestEnvelope, run: CoordinationRun, seq: number, outcome: 'closed' | 'aborted', reservationIds: readonly string[]): { readonly sequence: number; readonly eventType: string; readonly entityType: string; readonly entityId: string; readonly payload: Readonly<Record<string, unknown>> } {
    const intentAttempt = request.payload['intent_attempt'];
    if (typeof intentAttempt !== 'number' || !Number.isSafeInteger(intentAttempt) || intentAttempt < 1) throw new CoordinationRuntimeError('invalid-request', 'intent_attempt must be a positive integer');
    const priorId = request.payload['prior_terminal_intent_id'] === null ? null : payloadString(request.payload, 'prior_terminal_intent_id');
    const priorShaValue = request.payload['prior_terminal_intent_sha256'];
    const priorSha = priorShaValue === null ? null : (priorShaValue as `sha256:${string}`);
    const requestedId = payloadString(request.payload, 'terminal_intent_id');
    if (requestedId !== d65TerminalIntentId(run.workstream_run, intentAttempt)) throw new CoordinationRuntimeError('invalid-request', 'terminal_intent_id must be the deterministic v2 id for this attempt');
    const priorChain = this.#d65PriorIntentChain(run.repo_id, run.workstream_run);
    assertD65AppendOnlyAttempt({ workstreamRun: run.workstream_run, intentAttempt, priorTerminalIntentId: priorId, priorTerminalIntentSha256: priorSha, outcome, priorChain });
    const nonterminalObligations = this.#db.prepare("SELECT * FROM reservation_obligations WHERE repo_id=? AND json_extract(payload_json, '$.state') IN ('waiting-for-predecessor','integration-required') ORDER BY entity_id").all(run.repo_id).map(reservationObligationFromRow);
    const computed = computeD65ObligationPartition({ workstreamRun: run.workstream_run, outcome, intentReservationIds: reservationIds, nonterminalObligations });
    const sealed = assertD65TerminalEffectSetsExact({ outcome, requested: request.payload['terminal_effect_sets'], computed });
    const intent: D65RunTerminalIntentV2 = buildD65PreparedTerminalIntentV2({ workstreamRun: run.workstream_run, repoId: run.repo_id, intentAttempt, priorTerminalIntentId: priorId, priorTerminalIntentSha256: priorSha, outcome, reservationIds, terminalEffectSets: sealed, preparedEventSeq: seq });
    const nextRun = parseCoordinationRun({ ...run, status: 'merging', version: run.version + 1 });
    this.#db.prepare('INSERT INTO run_terminal_intents(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(intent.terminal_intent_id, intent.repo_id, intent.workstream_run, canonicalJson(intent), intent.version);
    this.#db.prepare("UPDATE runs SET status='merging', version=? WHERE repo_id=? AND workstream_run=?").run(nextRun.version, run.repo_id, run.workstream_run);
    return { sequence: seq, eventType: 'run-terminal-prepared', entityType: 'run-terminal-intent', entityId: intent.terminal_intent_id, payload: { run_terminal_intent: Object.freeze({ ...intent }), run: nextRun } };
  }

  /**
   * SR-5 committed dispatch-authority read. Exactly one read transaction is
   * opened, then one coordinator realtime sample is taken before any authority
   * row. No mutation or residue write occurs. Partial/corrupt authority throws;
   * legitimate missing bootstrap policy/heartbeat returns an explicitly fenced
   * frame rather than synthetic health.
   */
  readD65DispatchAuthorityFrame(repoId: string, workstreamRun: string, context: D65DispatchAuthorityRequestContext): D65DispatchAuthorityFrame {
    this.#writerGuard.assertHeld();
    if (!Number.isSafeInteger(context.expected_version) || context.expected_version < 1 || !Number.isSafeInteger(context.session_generation) || context.session_generation < 1) throw new CoordinationRuntimeError('invalid-request', 'D65 dispatch authority caller context has invalid version/generation');
    this.#db.exec('BEGIN');
    try {
      const frame = this.#d65DispatchAuthorityFrameInTransaction(repoId, workstreamRun, context, this.#clock.now().toISOString());
      this.#db.exec('COMMIT');
      return frame;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Same SR-5 proof while an existing mutation transaction is already open. */
  #d65DispatchAuthorityFrameInTransaction(repoId: string, workstreamRun: string, context: D65DispatchAuthorityRequestContext, coordinatorTime: string, allowHandoffPendingSession = false): D65DispatchAuthorityFrame {
    const run = this.#requireRun(repoId, workstreamRun);
    const resource = runResourceFromRow(asRow(this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(repoId, workstreamRun), 'D65 dispatch run resource'));
    const sessionRow = this.#db.prepare('SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? AND session_lease_id=?').get(repoId, workstreamRun, context.session_lease_id);
    const session = sessionRow === undefined ? null : sessionFromRow(sessionRow);
    const attachedSessionCurrent = session !== null && session.session_id === context.session_id && session.session_generation === context.session_generation && session.session_generation === run.active_session_generation && session.attachment_kind === 'dispatch' && (session.status === 'attached' || (allowHandoffPendingSession && session.status === 'handoff-pending'));
    const leaseCurrent = attachedSessionCurrent && Date.parse(session.lease_expires_at) > Date.parse(coordinatorTime);
    const policyCount = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.launch_policy.v1'").get(repoId, workstreamRun), 'D65 policy count'), 'count');
    if (policyCount > 1) throw new CoordinationRuntimeError('store-corrupt', 'D65 dispatch authority has multiple accepted launch policies');
    const acceptedPolicy = policyCount === 0 ? null : this.#d65AcceptedLaunchPolicy(repoId, workstreamRun);
    const residue = readD65GraphPublicationResidue(resource.main_worktree_path);
    const publicationPending = residue !== null && residue.stage !== 'registered';
    let completeGraphCurrent = this.#d65CompleteGraphCurrent(repoId, workstreamRun);
    if (this.#hasD65CompleteGraph(repoId, workstreamRun) && run.status !== 'closed' && run.status !== 'aborted') {
      const acceptedGraph = this.#d65AcceptedGraphHead(repoId, workstreamRun);
      const mainHead = this.#gitQueryText(resource.main_worktree_path, { kind: 'head' }, 'invalid-state', 'D65 dispatch run-main HEAD inspection failed');
      if (mainHead !== acceptedGraph.artifact.git_commit) completeGraphCurrent = false;
    }
    const head = this.#highestAcceptedProgramHeartbeat(repoId, workstreamRun);
    let globalReasons: readonly import('./d65-launch-policy.ts').D65StopReason[] = Object.freeze(['heartbeat-stale']);
    let rowReasons: readonly import('./d65-launch-policy.ts').D65StopReason[] = Object.freeze([]);
    let governingCurrent = false;
    let providerState: import('./d65-dispatch-predicates.ts').D65ProviderDispatchState = 'blocked';
    if (head !== null) {
      if (acceptedPolicy === null) throw new CoordinationRuntimeError('store-corrupt', 'accepted program heartbeat exists without accepted launch policy authority');
      const authority = this.#d65VerifyAcceptedHeartbeatHead(head, acceptedPolicy, run, coordinatorTime);
      globalReasons = authority.heartbeat.stop_reasons;
      rowReasons = authority.row.stop_reasons;
      governingCurrent = authority.governingCurrent;
      providerState = authority.providerState;
    }
    if ((run.status === 'closed' || run.status === 'aborted') && rowReasons.includes('terminal-tail')) {
      rowReasons = Object.freeze([...new Set([...rowReasons, 'row-closed' as const])].sort());
    }
    // The signed heartbeat describes the last accepted graph boundary. Once a
    // semantic event makes that graph stale, expose one concrete graph-drift
    // reason unless the heartbeat already carries the incident reason that the
    // successor graph covers. Once the crash-safe publisher residue exists,
    // graph-publication-pending is additionally mandatory. This keeps reason
    // arrays total and gives the graph-publication recovery cell its exact row.
    const semanticReasons: readonly import('./d65-launch-policy.ts').D65StopReason[] = ['graph-incomplete', 'graph-drift', 'progress-stale', 'handoff-pending', 'parent-recovering', 'unit-recovering', 'terminal-tail'];
    if (this.#hasD65CompleteGraph(repoId, workstreamRun) && !completeGraphCurrent && !rowReasons.some((reason) => semanticReasons.includes(reason))) rowReasons = Object.freeze([...new Set([...rowReasons, 'graph-drift' as const])].sort());
    if (publicationPending && !rowReasons.includes('graph-publication-pending')) rowReasons = Object.freeze([...new Set([...rowReasons, 'graph-publication-pending' as const])].sort());
    const activeChildren = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM child_leases WHERE repo_id=? AND workstream_run=? AND status='running'").get(repoId, workstreamRun), 'D65 active child count'), 'count');
    const capCurrent = acceptedPolicy !== null && acceptedPolicy.policy.parallel_cap === 1 && acceptedPolicy.policy.maximum_parallel_cap === 1 && acceptedPolicy.policy.expected_checkout_units === 1 && activeChildren <= 1;
    return Object.freeze({
      global_stop_reasons: globalReasons, row_stop_reasons: rowReasons, run_state: run.status,
      graph: Object.freeze({ complete_graph_current: completeGraphCurrent, graph_publication_pending: publicationPending }),
      policy: Object.freeze({ policy_current: acceptedPolicy !== null }),
      heartbeat: Object.freeze({ governing_heartbeat_current: governingCurrent, provider_state: providerState }),
      session: Object.freeze({ attached_session_current: attachedSessionCurrent, expected_version_current: context.expected_version === run.version, lease_current: leaseCurrent, cap_current: capCurrent }),
    });
  }

  #isD65Run(repoId: string, workstreamRun: string): boolean {
    const key = `${repoId}\0${workstreamRun}`;
    if (this.#semanticReplayTransactionActive && this.#semanticReplayNonD65Runs.has(key)) return false;
    const present = this.#db.prepare("SELECT entity_id FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.semantic_graph_bootstrap.v1' LIMIT 1").get(repoId, workstreamRun) !== undefined;
    if (!present && this.#semanticReplayTransactionActive) this.#semanticReplayNonD65Runs.add(key);
    return present;
  }

  #hasD65CompleteGraph(repoId: string, workstreamRun: string): boolean {
    const key = `${repoId}\0${workstreamRun}`;
    if (this.#semanticReplayTransactionActive && this.#semanticReplayWithoutCompleteGraph.has(key)) return false;
    const present = this.#db.prepare("SELECT entity_id FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.semantic_graph.v1' LIMIT 1").get(repoId, workstreamRun) !== undefined;
    if (!present && this.#semanticReplayTransactionActive) this.#semanticReplayWithoutCompleteGraph.add(key);
    return present;
  }

  #d65MutationContext(request: CoordinatorRequestEnvelope, expectedRunVersion: number): D65DispatchAuthorityRequestContext {
    const generation = request.fencing_generation;
    if (generation === null) throw new CoordinationRuntimeError('invalid-request', 'D65 mutation dispatch context requires a fencing generation');
    return Object.freeze({ expected_version: expectedRunVersion, session_lease_id: payloadString(request.payload, 'session_lease_id'), session_id: this.#sessionId(request), session_generation: generation });
  }

  #d65CurrentDispatchContext(run: CoordinationRun): D65DispatchAuthorityRequestContext {
    const rows = this.#db.prepare("SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? AND session_generation=? AND attachment_kind='dispatch' AND status='attached'").all(run.repo_id, run.workstream_run, run.active_session_generation).map(sessionFromRow);
    if (rows.length !== 1 || rows[0] === undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 child mutation lacks one current parent dispatch session');
    const session = rows[0];
    return Object.freeze({ expected_version: run.version, session_lease_id: session.session_lease_id, session_id: session.session_id, session_generation: session.session_generation });
  }

  #assertD65OrdinaryMutationAllowed(request: CoordinatorRequestEnvelope, run: CoordinationRun, boundary: string, context: D65DispatchAuthorityRequestContext = this.#d65MutationContext(request, run.version)): void {
    if (!this.#isD65Run(run.repo_id, run.workstream_run)) return;
    const frame = this.#d65DispatchAuthorityFrameInTransaction(run.repo_id, run.workstream_run, context, this.#clock.now().toISOString());
    const verdict = ordinaryDispatchAllowed({ global_stop_reasons: frame.global_stop_reasons, row_stop_reasons: frame.row_stop_reasons, run_state: frame.run_state, graph: frame.graph, policy: frame.policy, heartbeat: frame.heartbeat, session: frame.session });
    if (!verdict.allowed) throw new CoordinationRuntimeError('invalid-state', `D65 ordinary mutation ${boundary} is fenced at its coordinator transaction boundary`, verdict.denied_by.slice());
  }

  #assertD65RecoveryMutationAllowed(request: CoordinatorRequestEnvelope, run: CoordinationRun, action: Parameters<typeof recoveryTransitionAllowed>[0]['action'], bindings: D65RecoveryBindings, context: D65DispatchAuthorityRequestContext = this.#d65MutationContext(request, run.version), allowHandoffPendingSession = false): void {
    if (!this.#isD65Run(run.repo_id, run.workstream_run)) return;
    const frame = this.#d65DispatchAuthorityFrameInTransaction(run.repo_id, run.workstream_run, context, this.#clock.now().toISOString(), allowHandoffPendingSession);
    const verdict = recoveryTransitionAllowed({ action, global_stop_reasons: frame.global_stop_reasons, row_stop_reasons: frame.row_stop_reasons, run_state: frame.run_state, graph: frame.graph, policy: frame.policy, heartbeat: frame.heartbeat, bindings: { ...bindings, attached_session_current: frame.session.attached_session_current && frame.session.lease_current, policy_trust_current: frame.policy.policy_current, no_pending_publication: !frame.graph.graph_publication_pending } });
    if (!verdict.allowed) throw new CoordinationRuntimeError('invalid-state', `D65 recovery mutation ${action} is fenced at its coordinator transaction boundary`, verdict.denied_by.slice());
  }

  /**
   * Unit reset/quarantine evidence is written and committed before its release
   * transaction. Prove that physical HEAD is exactly one one-path child of the
   * accepted H, then evaluate the frozen unit-recovery cell against logical H.
   * This is not an ordinary-dispatch bypass: only the exact requested evidence
   * blob may occupy the intentional pre-event Git edge.
   */
  #assertD65UnitRecoveryEvidenceMutationAllowed(request: CoordinatorRequestEnvelope, run: CoordinationRun, evidenceRef: string, evidenceSha256: `sha256:${string}`): void {
    const resource = runResourceFromRow(asRow(this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run), 'D65 unit recovery evidence resource'));
    this.#evidencePathUnderRoot(resource.main_worktree_path, evidenceRef);
    const prior = this.#d65AcceptedGraphHead(run.repo_id, run.workstream_run);
    const headValue = this.#gitQueryText(resource.main_worktree_path, { kind: 'head' }, 'invalid-request', 'D65 unit recovery evidence HEAD inspection failed');
    if (headValue === null) throw new CoordinationRuntimeError('invalid-request', 'D65 unit recovery evidence HEAD is absent');
    const head = headValue;
    const parents = (this.#gitQueryText(resource.main_worktree_path, { kind: 'rev-list-parents', revision: head }, 'invalid-request', 'D65 unit recovery evidence parent inspection failed') ?? '').trim().split(/\s+/u).filter((entry) => entry.length > 0);
    const diff = this.#gitQueryResult(resource.main_worktree_path, { kind: 'diff-paths', from: prior.artifact.git_commit, to: head, noRenames: true }, 'invalid-request', 'D65 unit recovery evidence diff inspection failed');
    const paths = new TextDecoder('utf-8', { fatal: true }).decode(diff.stdout).split('\0').filter((entry) => entry.length > 0);
    const bytes = this.#gitQueryResult(resource.main_worktree_path, { kind: 'show-file', revision: head, path: evidenceRef }, 'invalid-request', 'D65 unit recovery evidence blob inspection failed').stdout;
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (parents.length !== 2 || parents[1] !== prior.artifact.git_commit || paths.length !== 1 || paths[0] !== evidenceRef || digest !== evidenceSha256) throw new CoordinationRuntimeError('invalid-request', 'D65 unit recovery evidence commit is not the exact one-parent one-ref successor of accepted H', [head, prior.artifact.git_commit, ...parents.slice(1), ...paths, evidenceSha256, digest]);
    if (!this.#d65CompleteGraphCurrent(run.repo_id, run.workstream_run)) throw new CoordinationRuntimeError('invalid-state', 'D65 unit recovery evidence prior graph is not semantically current');
    const frame = this.#d65DispatchAuthorityFrameInTransaction(run.repo_id, run.workstream_run, this.#d65MutationContext(request, run.version), this.#clock.now().toISOString());
    const rowReasons = Object.freeze(frame.row_stop_reasons.filter((reason) => reason !== 'graph-drift'));
    const verdict = recoveryTransitionAllowed({ action: 'unit-recovery', global_stop_reasons: frame.global_stop_reasons, row_stop_reasons: rowReasons, run_state: frame.run_state, graph: { complete_graph_current: true, graph_publication_pending: frame.graph.graph_publication_pending }, policy: frame.policy, heartbeat: frame.heartbeat, bindings: { attached_session_current: frame.session.attached_session_current && frame.session.lease_current && frame.session.expected_version_current, policy_trust_current: frame.policy.policy_current, no_pending_publication: !frame.graph.graph_publication_pending, terminal_prepared_cancellable: false, terminal_after_commit: false, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false } });
    if (!verdict.allowed) throw new CoordinationRuntimeError('invalid-state', 'D65 unit recovery evidence mutation is fenced at its coordinator transaction boundary', verdict.denied_by.slice());
  }

  /** Classify coordinator-only maintenance without fallback authority. */
  #assertD65MaintenanceMutationAllowed(request: CoordinatorRequestEnvelope, run: CoordinationRun, boundary: string): void {
    if (!this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) return;
    const frame = this.#d65DispatchAuthorityFrameInTransaction(run.repo_id, run.workstream_run, this.#d65MutationContext(request, run.version), this.#clock.now().toISOString());
    const recoveryAction = frame.row_stop_reasons.includes('handoff-pending') ? 'planned-handoff' : frame.row_stop_reasons.includes('parent-recovering') ? 'parent-loss' : null;
    if (recoveryAction === null) {
      const ordinary = ordinaryDispatchAllowed({ global_stop_reasons: frame.global_stop_reasons, row_stop_reasons: frame.row_stop_reasons, run_state: frame.run_state, graph: frame.graph, policy: frame.policy, heartbeat: frame.heartbeat, session: frame.session });
      if (!ordinary.allowed) throw new CoordinationRuntimeError('invalid-state', `D65 maintenance mutation ${boundary} is fenced at its coordinator transaction boundary`, ordinary.denied_by.slice());
      return;
    }
    const recovery = recoveryTransitionAllowed({ action: recoveryAction, global_stop_reasons: frame.global_stop_reasons, row_stop_reasons: frame.row_stop_reasons, run_state: frame.run_state, graph: frame.graph, policy: frame.policy, heartbeat: frame.heartbeat, bindings: { attached_session_current: frame.session.attached_session_current && frame.session.lease_current && frame.session.expected_version_current, policy_trust_current: frame.policy.policy_current, no_pending_publication: !frame.graph.graph_publication_pending, terminal_prepared_cancellable: false, terminal_after_commit: false, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false } });
    if (!recovery.allowed) throw new CoordinationRuntimeError('invalid-state', `D65 maintenance recovery ${boundary} is fenced at its coordinator transaction boundary`, recovery.denied_by.slice());
  }

  /**
   * Gate EVERY D65 semantic-graph registration. The first publication (sequence
   * 2) uses its separate exact admission: prior authority is the accepted
   * bootstrap graph, a current signed policy and the initial governing heartbeat
   * exist, the governing row reason is exactly graph-publication-pending, the
   * durable publication-committed residue binds this exact registration, and the
   * session is current; the exact sequence-2 B→E charter replay follows in
   * #validateD65GraphRegistration. Successor publication requires the accepted
   * prior complete graph tuple. Graph registration uses the accepted prior tuple
   * even though one covered semantic event makes ordinary dispatch stale.
   */
  #assertD65GraphPublicationMutationAllowed(request: CoordinatorRequestEnvelope, run: CoordinationRun): void {
    const artifactId = payloadString(request.payload, 'artifact_id');
    const requestedRef = payloadString(request.payload, 'ref');
    const requestedSha = payloadString(request.payload, 'sha256');
    const requestedCommit = payloadString(request.payload, 'git_commit');
    const frame = this.#d65DispatchAuthorityFrameInTransaction(run.repo_id, run.workstream_run, this.#d65MutationContext(request, run.version), this.#clock.now().toISOString(), true);
    const resource = runResourceFromRow(asRow(this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run), 'D65 graph registration run resource'));
    const residue = readD65GraphPublicationResidue(resource.main_worktree_path);
    if (residue === null) throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-publication-pending: D65 graph registration requires its durable pending publication residue', [artifactId]);
    if (residue.stage !== 'publication-committed') throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-publication-pending: D65 graph registration requires the exact publication-committed residue stage', [artifactId, residue.stage]);
    if (residue.repo_id !== run.repo_id || residue.workstream_run !== run.workstream_run || residue.artifact_id !== artifactId || d65SemanticGraphArtifactId(residue.graph_sequence) !== artifactId) throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-cas-conflict: pending publication residue does not bind this exact graph registration identity', [artifactId, residue.artifact_id, String(residue.graph_sequence)]);
    if (residue.publication_commit !== requestedCommit || residue.graph_ref !== requestedRef || residue.graph_sha256 !== requestedSha) throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-cas-conflict: pending publication residue does not bind the exact registered H/ref/digest tuple', [artifactId, String(residue.publication_commit), requestedCommit]);
    const graphHead = this.#d65AcceptedGraphHead(run.repo_id, run.workstream_run);
    const priorComplete = this.#db.prepare("SELECT entity_id FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.semantic_graph.v1' LIMIT 1").get(run.repo_id, run.workstream_run) !== undefined;
    let coveredReason: import('./d65-launch-policy.ts').D65StopReason | null = null;
    if (!priorComplete) {
      // First-publication admission: prior authority is the accepted bootstrap
      // graph and no complete graph may already be accepted.
      if (graphHead.sequence !== 1 || graphHead.artifact.document_schema_version !== 'autopilot.semantic_graph_bootstrap.v1') throw new CoordinationRuntimeError('store-corrupt', 'D65 first graph registration prior head is not the accepted bootstrap graph', [graphHead.artifact.artifact_id]);
      if (residue.prior_authority_kind !== 'bootstrap' || residue.prior_graph_sha256 !== graphHead.sha256 || residue.prior_publication_commit !== null || residue.prior_registration_event_seq !== graphHead.artifact.registered_event_seq) throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-cas-conflict: first publication residue does not bind the accepted bootstrap prior tuple', [residue.prior_authority_kind, residue.prior_graph_sha256, graphHead.sha256]);
      if (!frame.policy.policy_current) throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-bootstrap-operation-denied: first complete graph registration requires the accepted signed launch policy');
      const head = this.#highestAcceptedProgramHeartbeat(run.repo_id, run.workstream_run);
      if (head === null || head.sequence !== 1 || head.acceptance_kind !== 'governing') throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-bootstrap-operation-denied: first complete graph registration requires the initial governing program heartbeat', [head === null ? '<absent>' : `${String(head.sequence)}/${head.acceptance_kind}`]);
      if (frame.row_stop_reasons.length !== 1 || frame.row_stop_reasons[0] !== 'graph-publication-pending') throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-bootstrap-operation-denied: first complete graph registration requires row reason exactly graph-publication-pending', [...frame.row_stop_reasons]);
    } else {
      // Successor publication: the accepted prior complete graph is mandatory
      // and the residue must bind its exact (digest,H,R) tuple.
      if (graphHead.artifact.document_schema_version !== 'autopilot.semantic_graph.v1') throw new CoordinationRuntimeError('store-corrupt', 'D65 successor graph registration prior head is not an accepted complete graph', [graphHead.artifact.artifact_id]);
      if (residue.prior_authority_kind !== 'complete' || residue.prior_graph_sha256 !== graphHead.sha256 || residue.prior_publication_commit !== graphHead.artifact.git_commit || residue.prior_registration_event_seq !== graphHead.artifact.registered_event_seq) throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-cas-conflict: successor publication residue does not bind the accepted prior complete graph tuple', [residue.prior_authority_kind, residue.prior_graph_sha256, graphHead.sha256]);
      const coveredReasons = frame.row_stop_reasons.filter((reason) => reason === 'graph-incomplete' || reason === 'graph-drift' || reason === 'progress-stale' || reason === 'handoff-pending' || reason === 'parent-recovering' || reason === 'unit-recovering' || reason === 'terminal-tail');
      if (coveredReasons.length > 1) throw new CoordinationRuntimeError('invalid-state', 'D65 graph publication heartbeat carries multiple covered semantic reasons', coveredReasons);
      coveredReason = coveredReasons[0] ?? null;
    }
    const graph = Object.freeze({ complete_graph_current: true, graph_publication_pending: frame.graph.graph_publication_pending });
    const verdict = recoveryTransitionAllowed({ action: 'graph-publication', global_stop_reasons: frame.global_stop_reasons, row_stop_reasons: frame.row_stop_reasons, run_state: frame.run_state, graph, policy: frame.policy, heartbeat: frame.heartbeat, bindings: { attached_session_current: frame.session.attached_session_current && frame.session.lease_current && frame.session.expected_version_current, policy_trust_current: frame.policy.policy_current, no_pending_publication: !frame.graph.graph_publication_pending, terminal_prepared_cancellable: false, terminal_after_commit: false, accepted_continuation_reason: null, covered_semantic_reason: coveredReason, attach_terminal_recovery: false } });
    if (!verdict.allowed) throw new CoordinationRuntimeError('invalid-state', 'D65 graph registration is fenced at its coordinator transaction boundary', verdict.denied_by.slice());
  }

  #d65AcceptedGraphState(repoId: string, workstreamRun: string): AutopilotState {
    const row = asRow(this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.semantic_graph.v1' ORDER BY entity_id DESC LIMIT 1").get(repoId, workstreamRun), 'D65 accepted graph state artifact');
    const artifact = authoritativeArtifactFromRow(row);
    const graph = parseD65CompleteGraph(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(repoId, artifact.evidence)), 'D65 accepted graph state root'));
    const resource = runResourceFromRow(asRow(this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(repoId, workstreamRun), 'D65 accepted graph state resource'));
    const bytes = this.#readD65GraphShardBlob(resource.main_worktree_path, artifact.git_commit, graph.core.state.ref);
    const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (actual !== graph.core.state.sha256 || bytes.byteLength !== graph.core.state.byte_count) throw new CoordinationRuntimeError('store-corrupt', 'D65 accepted graph state blob differs from its root descriptor');
    return parseAutopilotState(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'D65 accepted graph state'));
  }

  #d65CompleteGraphCurrent(repoId: string, workstreamRun: string): boolean {
    const row = this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.semantic_graph.v1' ORDER BY entity_id DESC LIMIT 1").get(repoId, workstreamRun);
    if (row === undefined) return false;
    const artifact = authoritativeArtifactFromRow(row);
    const graph = parseD65CompleteGraph(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(repoId, artifact.evidence)), 'accepted complete graph root'));
    if (graph.repo_id !== repoId || graph.workstream_run !== workstreamRun || artifact.artifact_id !== d65SemanticGraphArtifactId(graph.graph_sequence) || artifact.registered_event_seq !== graph.covered_event_seq + 1) throw new CoordinationRuntimeError('store-corrupt', 'accepted complete graph artifact tuple is internally inconsistent');
    const registrationEvent = asRow(this.#db.prepare("SELECT idempotency_key FROM events WHERE repo_id=? AND event_type='authoritative-artifact-registered' AND entity_id=?").get(repoId, artifact.artifact_id), 'accepted graph registration event');
    const proven = this.lookupCommittedGraphRegistration(repoId, workstreamRun, { artifactId: artifact.artifact_id, publicationCommit: artifact.git_commit, graphRef: artifact.evidence.ref, graphSha256: artifact.evidence.sha256, coveredEventSeq: graph.covered_event_seq, idempotencyKey: sqlString(registrationEvent, 'idempotency_key') });
    if (proven === null || proven.registrationEventSeq !== artifact.registered_event_seq) throw new CoordinationRuntimeError('store-corrupt', 'accepted complete graph lacks its exact registration event/result tuple');
    const currentE = sqlInteger(asRow(this.#db.prepare('SELECT event_seq FROM repositories WHERE repo_id=?').get(repoId), 'D65 graph liveness repository'), 'event_seq');
    const totalSuffix = sqlInteger(asRow(this.#db.prepare('SELECT COUNT(*) AS count FROM events WHERE repo_id=? AND event_seq>?').get(repoId, artifact.registered_event_seq), 'D65 graph suffix count'), 'count');
    const suffix = this.#d65AcceptedHistory(repoId, currentE, artifact.registered_event_seq);
    if (suffix.length !== totalSuffix) throw new CoordinationRuntimeError('store-corrupt', 'D65 graph suffix history is not a complete repository event range');
    for (const event of suffix) {
      // A repository event owned solely by another run advances the shared E
      // counter but cannot make this run's accepted graph stale. Ownership is
      // proved from the exact immutable event/result pair, never inferred from
      // event_type or a recursively discovered related run field.
      if (!d65SemanticEventWorkstreamRuns(event).includes(workstreamRun)) continue;
      if (event.event_type === 'session-heartbeat') { if (!isPureD65SessionHeartbeat(event)) return false; continue; }
      if (event.event_type === 'child-heartbeat') { if (!isPureD65ChildHeartbeat(event)) return false; continue; }
      if (event.event_type === 'program-heartbeat-accepted') {
        const payload = event.result?.payload;
        if (payload === undefined) throw new CoordinationRuntimeError('store-corrupt', 'program heartbeat liveness event lacks exact result');
        const result = parseD65HeartbeatAcceptanceResult(payload);
        if (result.repo_id !== repoId || result.workstream_run !== workstreamRun || event.entity_type !== 'program-heartbeat' || event.entity_id !== workstreamRun) throw new CoordinationRuntimeError('store-corrupt', 'program heartbeat liveness event/result identity mismatch');
        continue;
      }
      return false;
    }
    return true;
  }

  #d65VerifyAcceptedHeartbeatHead(head: D65HeartbeatAcceptanceResult, acceptedPolicy: Readonly<{ policy: D65LaunchPolicy; artifact: CoordinationAuthoritativeArtifact; anchor: ReturnType<typeof parseD65TrustAnchorSpki> }>, run: CoordinationRun, coordinatorTime: string): Readonly<{ heartbeat: D65ProgramHeartbeat; row: D65ProgramHeartbeat['rows'][number]; governingCurrent: boolean; providerState: import('./d65-dispatch-predicates.ts').D65ProviderDispatchState }> {
    const path = this.#d65ExternalHeartbeatPath(acceptedPolicy.policy, head.heartbeat_ref);
    const bytes = this.#readD65ExternalPrivateFile(path, 'accepted D65 program heartbeat');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== head.heartbeat_sha256) throw new CoordinationRuntimeError('invalid-state', 'accepted external heartbeat bytes are missing or mismatch their durable coordinator head', [head.heartbeat_ref, head.heartbeat_sha256, digest]);
    const heartbeat = parseD65ProgramHeartbeat(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'accepted D65 program heartbeat'));
    const { signature: _signature, ...unsigned } = heartbeat;
    void _signature;
    if (!verifyD65Signature({ trustAnchor: acceptedPolicy.anchor, purpose: 'program-heartbeat', message: new TextEncoder().encode(canonicalJson(unsigned)), signature: heartbeat.signature })) throw new CoordinationRuntimeError('invalid-state', 'accepted external heartbeat signature no longer verifies');
    if (heartbeat.program_id !== head.program_id || heartbeat.sequence !== head.sequence || heartbeat.prior_sha256 !== head.prior_sha256 || heartbeat.issued_at !== head.issued_at || heartbeat.valid_until !== head.valid_until || heartbeat.trust_anchor_ref !== acceptedPolicy.policy.trust_anchor_ref || heartbeat.trust_anchor_sha256 !== acceptedPolicy.policy.trust_anchor_sha256 || heartbeat.signer_key_id !== acceptedPolicy.anchor.sha256) throw new CoordinationRuntimeError('store-corrupt', 'accepted heartbeat result does not byte-bind its signed external record');
    const matches = heartbeat.rows.filter((row) => row.workstream_run === run.workstream_run);
    const row = matches[0];
    if (matches.length !== 1 || row === undefined || row.workstream !== run.workstream) throw new CoordinationRuntimeError('store-corrupt', 'accepted heartbeat record does not contain exactly one row identity for its coordinator run');
    const now = Date.parse(coordinatorTime);
    const graphHead = this.#d65AcceptedGraphHead(run.repo_id, run.workstream_run);
    const attached = this.#db.prepare("SELECT session_lease_id FROM session_leases WHERE repo_id=? AND workstream_run=? AND session_generation=? AND attachment_kind='dispatch' AND status IN ('attached','handoff-pending')").get(run.repo_id, run.workstream_run, run.active_session_generation);
    const statusDigest = this.#d65CurrentSemanticEndpointDigest('status', run.repo_id, run.workstream_run, coordinatorTime);
    const doctorDigest = this.#d65CurrentSemanticEndpointDigest('doctor', run.repo_id, run.workstream_run, coordinatorTime);
    const governingCurrent = head.acceptance_kind === 'governing'
      && Date.parse(head.issued_at) <= now && now < Date.parse(head.valid_until)
      && row.launch_policy_sha256 === acceptedPolicy.artifact.evidence.sha256
      && row.accepted_graph_sequence === graphHead.sequence && row.accepted_graph_sha256 === graphHead.sha256
      && attached !== undefined && row.coordinator_session_lease_id === sqlString(attached, 'session_lease_id')
      && row.status_sha256 === statusDigest && row.doctor_sha256 === doctorDigest;
    let providerState: import('./d65-dispatch-predicates.ts').D65ProviderDispatchState = 'healthy';
    if (row.stop_reasons.includes('provider-exhausted')) providerState = 'exhausted';
    else if (row.stop_reasons.includes('provider-blocked')) {
      const retry = heartbeat.provider_health.filter((provider) => provider.state === 'retry-authorized' && provider.probe_workstream_run === run.workstream_run);
      if (retry.length > 1) throw new CoordinationRuntimeError('invalid-state', 'accepted heartbeat provider authority is ambiguous for a provider-blocked row');
      providerState = retry.length === 1 ? 'retry-authorized' : 'blocked';
    }
    return Object.freeze({ heartbeat, row, governingCurrent, providerState });
  }

  // D65-A5 point 1 (freeze §9.4) response-loss recovery. The runtime graph-
  // publication saga, after submitting `register-authoritative-artifact` for the
  // graph at publication commit H, may lose the response. Before advancing its
  // residue `publication-committed -> registered` it must PROVE the immutable
  // artifact/event/idempotency-result committed byte-identically, or that they
  // are (consistently) absent so it retries the byte-identical register. This
  // read-only, no-mutation lookup surfaces exactly that proof over the existing
  // schema-13 rows (authoritative_artifacts + events + idempotency_results); it
  // NEVER infers success and never soft-assumes a partial commit.
  //
  //  - present-and-consistent: returns `{ registrationEventSeq: R }` only when
  //    the artifact row, its `authoritative-artifact-registered` event at R, and
  //    the idempotency result all exist and HARD-equal git_commit===H,
  //    evidence.sha256===sealed digest, and registered_event_seq===E+1.
  //  - clean absence: returns `null` (caller retries the byte-identical request)
  //    only when the artifact row AND its registration event AND idempotency
  //    result are ALL absent for the graph identity.
  //  - any partial or mismatch: throws `invalid-state` (terminal). A rollback can
  //    never leave a half-committed registration, so a partial is always a
  //    corrupt/forbidden state, never "assume committed".
  lookupCommittedGraphRegistration(
    repoId: string,
    workstreamRun: string,
    input: { readonly artifactId: string; readonly publicationCommit: string; readonly graphRef: string; readonly graphSha256: `sha256:${string}`; readonly coveredEventSeq: number; readonly idempotencyKey: string },
  ): { readonly registrationEventSeq: number } | null {
    const expectedR = input.coveredEventSeq + 1;
    const expectedKey = input.idempotencyKey;
    const artifactRow = this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(repoId, input.artifactId);
    const eventRows = this.#db.prepare("SELECT event_seq, idempotency_key, request_sha256 FROM events WHERE repo_id=? AND event_type='authoritative-artifact-registered' AND entity_type='authoritative-artifact' AND entity_id=?").all(repoId, input.artifactId);
    const resultRow = this.#db.prepare('SELECT committed_event_seq, request_sha256, payload_json FROM idempotency_results WHERE repo_id=? AND idempotency_key=?').get(repoId, expectedKey);
    if (artifactRow === undefined && eventRows.length === 0 && resultRow === undefined) return null;
    if (artifactRow === undefined || eventRows.length !== 1 || resultRow === undefined) throw new CoordinationRuntimeError('invalid-state', 'graph registration response-loss authority is partial or duplicated', [input.artifactId, `events=${String(eventRows.length)}`]);
    const eventRow = eventRows[0];
    if (eventRow === undefined) throw new CoordinationRuntimeError('invalid-state', 'graph registration event disappeared after exact cardinality check');
    const artifact = authoritativeArtifactFromRow(asRow(artifactRow, `committed graph registration artifact ${input.artifactId}`));
    if (artifact.artifact_id !== input.artifactId || artifact.repo_id !== repoId || artifact.source_run !== workstreamRun || artifact.source_type !== 'task' || artifact.source_scope !== 'run-main' || artifact.document_schema_version !== 'autopilot.semantic_graph.v1' || artifact.version !== 1) throw new CoordinationRuntimeError('invalid-state', 'committed graph registration artifact identity/scope/version is not exact', [input.artifactId]);
    if (artifact.git_commit !== input.publicationCommit) throw new CoordinationRuntimeError('invalid-state', 'committed graph registration git_commit does not match the sealed publication commit H', [artifact.git_commit, input.publicationCommit]);
    if (artifact.evidence.ref !== input.graphRef) throw new CoordinationRuntimeError('invalid-state', 'committed graph registration evidence ref does not match the sealed graph ref', [artifact.evidence.ref, input.graphRef]);
    if (artifact.evidence.sha256 !== input.graphSha256) throw new CoordinationRuntimeError('invalid-state', 'committed graph registration evidence digest does not match the sealed graph_sha256', [artifact.evidence.sha256, input.graphSha256]);
    if (artifact.registered_event_seq !== expectedR) throw new CoordinationRuntimeError('invalid-state', 'committed graph registration event sequence is not exactly R=E+1', [`registered_event_seq=${String(artifact.registered_event_seq)}`, `expected_R=${String(expectedR)}`]);
    const eventSeq = sqlInteger(eventRow, 'event_seq');
    if (eventSeq !== expectedR || sqlString(eventRow, 'idempotency_key') !== expectedKey) throw new CoordinationRuntimeError('invalid-state', 'committed graph registration event does not bind exact R/idempotency identity', [input.artifactId]);
    if (sqlInteger(resultRow, 'committed_event_seq') !== expectedR || sqlString(resultRow, 'request_sha256') !== sqlString(eventRow, 'request_sha256')) throw new CoordinationRuntimeError('invalid-state', 'committed graph registration idempotency result does not bind exact R/request digest', [input.artifactId]);
    const resultPayload = parseJsonObject(sqlString(resultRow, 'payload_json'), 'committed graph registration result');
    if (Object.keys(resultPayload).sort().join(',') !== 'authoritative_artifact,entity_id,entity_type,event_type' || resultPayload['event_type'] !== 'authoritative-artifact-registered' || resultPayload['entity_type'] !== 'authoritative-artifact' || resultPayload['entity_id'] !== input.artifactId) throw new CoordinationRuntimeError('invalid-state', 'committed graph registration idempotency payload is not the exact closed registration effect');
    const resultArtifact = parseCoordinationAuthoritativeArtifact(resultPayload['authoritative_artifact']);
    if (canonicalJson(resultArtifact) !== canonicalJson(artifact)) throw new CoordinationRuntimeError('invalid-state', 'committed graph registration result artifact differs from the authoritative artifact row');
    return { registrationEventSeq: expectedR };
  }

  // D65-A1 immutable cap-one launch-policy authority. Structural parsing alone
  // is insufficient: registration authenticates the operator-signed policy
  // against the accepted bootstrap/SPKI, the exact package/run identities, the
  // common B0 derived from content_result_commit's sole parent, and the
  // one-parent/one-path policy commit. The signed roster digest becomes policy
  // authority here; later runtime gates compare the actual roster to it because
  // D65 freezes no second coordinator roster artifact. v1 is the sole D65 edge.
  #validateD65LaunchPolicyRegistration(repoId: string, workstreamRun: string, sourceRoot: string, policyCommit: string, ref: string, policyBytes: Uint8Array): void {
    const invalid = (issue: string, evidence: readonly string[] = []): never => { throw new CoordinationRuntimeError('invalid-request', `launch-policy-invalid: ${issue}`, evidence); };
    const casConflict = (issue: string, evidence: readonly string[] = []): never => { throw new CoordinationRuntimeError('invalid-request', `launch-policy-cas-conflict: ${issue}`, evidence); };
    const policy = parseD65LaunchPolicy(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(policyBytes), 'launch policy'));
    if (ref !== `authority/launch-policies/${policy.policy_id}.json`) invalid('policy path must be authority/launch-policies/<policy_id>.json', [ref, policy.policy_id]);
    if (policy.repo_id !== repoId || policy.workstream_run !== workstreamRun) invalid('policy repo/run identity does not match the registering run', [policy.repo_id, policy.workstream_run]);
    // Artifact IDs remain caller-chosen under API 12, so policy-chain CAS is
    // keyed by run + document schema. D65 authorizes only absent->v1: any
    // existing policy is rollback/same-version divergence, and absent->vN>1 is
    // an initial gap. Both fail with the frozen CAS literal before deeper work.
    const existingPolicy = this.#db.prepare("SELECT entity_id FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.launch_policy.v1' LIMIT 1").get(repoId, workstreamRun);
    if (existingPolicy !== undefined) casConflict('an accepted launch policy already exists for this run (D65 permits only absent-to-v1)', [sqlString(existingPolicy, 'entity_id')]);
    if (policy.policy_version !== 1) casConflict('the initial policy chain must begin at version 1 (gap)', [`policy_version=${String(policy.policy_version)}`]);

    // The deterministic bootstrap artifact is the only accepted source for the
    // row-specific content result, package tuple, attach receipt, and SPKI.
    const bootstrapArtifact = authoritativeArtifactFromRow(asRow(this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(repoId, `semantic-graph-bootstrap:${workstreamRun}`), 'launch policy bootstrap artifact'));
    if (bootstrapArtifact.source_run !== workstreamRun || bootstrapArtifact.source_type !== 'task' || bootstrapArtifact.source_scope !== 'repository' || bootstrapArtifact.document_schema_version !== 'autopilot.semantic_graph_bootstrap.v1') invalid('accepted bootstrap artifact identity is not the frozen D65 bootstrap row', [bootstrapArtifact.artifact_id]);
    const bootstrap = parseD65SemanticGraphBootstrap(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(repoId, bootstrapArtifact.evidence)), 'launch policy bootstrap envelope'));
    if (bootstrap.repo_id !== repoId || bootstrap.workstream_run !== workstreamRun) invalid('accepted bootstrap envelope does not name the registering run', [bootstrap.repo_id, bootstrap.workstream_run]);
    const anchorBytes = this.#loadEvidenceArtifact(repoId, { ref: bootstrap.trust_anchor_ref, sha256: bootstrap.trust_anchor_sha256 });
    const anchor = parseD65TrustAnchorSpki(anchorBytes);

    // Byte-for-contract, bootstrap.content_commit is content_result_commit and
    // MUST have exactly one parent: the distinct common B0. Resolve both trees
    // from Git rather than trusting or conflating the signed fields.
    const contentParentListing = this.#gitQueryText(sourceRoot, { kind: 'rev-list-parents', revision: bootstrap.content_commit }, 'invalid-request', 'bootstrap content-result parent inspection failed');
    const contentParents = (contentParentListing ?? '').trim().split(/\s+/u).filter((entry) => entry.length > 0);
    const b0Commit = contentParents.length === 2 ? contentParents[1] : undefined;
    if (b0Commit === undefined) throw new CoordinationRuntimeError('invalid-request', 'launch-policy-invalid: accepted content_result_commit must have exactly one parent B0', [`parents=${contentParents.slice(1).join(',') || 'none'}`]);
    const contentResultTree = this.#gitQueryText(sourceRoot, { kind: 'resolve-tree', revision: bootstrap.content_commit }, 'invalid-request', 'bootstrap content-result tree inspection failed');
    if (contentResultTree !== bootstrap.content_tree) invalid('accepted bootstrap content_tree does not match content_result_commit', [String(contentResultTree), bootstrap.content_tree]);
    const b0Tree = this.#gitQueryText(sourceRoot, { kind: 'resolve-tree', revision: b0Commit }, 'invalid-request', 'B0 tree inspection failed');
    if (b0Tree === null) throw new CoordinationRuntimeError('invalid-request', 'launch-policy-invalid: B0 tree is not resolvable from content_result_commit', [b0Commit]);

    if (policy.program_id !== bootstrap.program_id) invalid('policy program_id does not match the accepted bootstrap', [policy.program_id, bootstrap.program_id]);
    if (policy.base_commit !== b0Commit) invalid('policy base_commit is not B0 (content_result_commit substitution)', [policy.base_commit, b0Commit]);
    if (policy.base_tree !== b0Tree) invalid('policy base_tree is not the resolved B0 tree', [policy.base_tree, b0Tree]);
    if (policy.package_commit !== bootstrap.package_commit) invalid('policy package_commit is not the accepted bootstrap package commit', [policy.package_commit, bootstrap.package_commit]);
    if (policy.package_tree !== bootstrap.package_tree) invalid('policy package_tree is not the accepted bootstrap package tree', [policy.package_tree, bootstrap.package_tree]);
    if (policy.bootstrap_graph_sha256 !== bootstrapArtifact.evidence.sha256) invalid('policy bootstrap_graph_sha256 is not the accepted bootstrap digest', [policy.bootstrap_graph_sha256, bootstrapArtifact.evidence.sha256]);
    if (policy.bootstrap_receipt_event_seq !== bootstrapArtifact.registered_event_seq) invalid('policy bootstrap_receipt_event_seq is not the bootstrap attach receipt', [`receipt=${String(policy.bootstrap_receipt_event_seq)}`, `B=${String(bootstrapArtifact.registered_event_seq)}`]);
    if (policy.trust_anchor_ref !== bootstrap.trust_anchor_ref) invalid('policy trust_anchor_ref is not the accepted bootstrap trust anchor ref (path substitution)', [policy.trust_anchor_ref, bootstrap.trust_anchor_ref]);
    if (policy.trust_anchor_sha256 !== anchor.sha256 || policy.trust_anchor_sha256 !== bootstrap.trust_anchor_sha256) invalid('policy trust_anchor_sha256 is not the accepted 44-byte SPKI digest (key substitution)', [policy.trust_anchor_sha256, anchor.sha256]);
    if (policy.signer_key_id !== anchor.sha256) invalid('policy signer_key_id is not the accepted trust anchor SPKI digest', [policy.signer_key_id, anchor.sha256]);

    // Signatures cover domain || RFC-8785(policy without signature), with NO LF.
    const { signature: _signature, ...policyWithoutSignature } = policy;
    void _signature;
    const signedMessage = new TextEncoder().encode(canonicalJson(policyWithoutSignature));
    if (!verifyD65Signature({ trustAnchor: anchor, purpose: 'launch-policy', message: signedMessage, signature: policy.signature })) invalid('policy signature is not a valid domain-separated Ed25519 signature by the accepted operator key');

    // The policy binds the canonical realpath of one exact mode-0700 directory.
    // It must be authority-distinct from every clone/worktree/runtime/state root
    // visible to this coordinator. The external launch audit proves the same
    // relation across the six separately rooted coordinators.
    let evidenceRootReal: string;
    let evidenceRootStat: ReturnType<typeof lstatSync>;
    try {
      const before = lstatSync(policy.program_evidence_root);
      evidenceRootReal = realpathSync(policy.program_evidence_root);
      const after = lstatSync(policy.program_evidence_root);
      const realAfter = realpathSync(policy.program_evidence_root);
      if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || evidenceRootReal !== realAfter) invalid('policy program_evidence_root changed during authentication', [policy.program_evidence_root]);
      evidenceRootStat = after;
    } catch (error) {
      if (error instanceof CoordinationRuntimeError) throw error;
      throw new CoordinationRuntimeError('invalid-request', 'launch-policy-invalid: policy program_evidence_root is not an accessible real directory', [policy.program_evidence_root, error instanceof Error ? error.message : String(error)]);
    }
    if (evidenceRootReal !== policy.program_evidence_root || !evidenceRootStat.isDirectory() || evidenceRootStat.isSymbolicLink()) invalid('policy program_evidence_root must be its canonical real directory path', [policy.program_evidence_root, evidenceRootReal]);
    if ((evidenceRootStat.mode & 0o777) !== 0o700) invalid('policy program_evidence_root must have exact mode 0700', [policy.program_evidence_root, `mode=${(evidenceRootStat.mode & 0o777).toString(8)}`]);
    const pathContains = (root: string, candidate: string): boolean => {
      const rel = relative(root, candidate);
      return rel.length === 0 || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    };
    const protectedPaths = new Set<string>([resolve(this.#stateRoot), realpathSync(this.#stateRoot)]);
    for (const row of this.#db.prepare('SELECT * FROM repositories ORDER BY repo_id').all()) {
      const repository = repositoryFromRow(row);
      for (const path of [repository.canonical_root, repository.git_common_dir]) {
        protectedPaths.add(resolve(path));
        if (existsSync(path)) protectedPaths.add(realpathSync(path));
      }
    }
    for (const row of this.#db.prepare('SELECT payload_json FROM run_resources ORDER BY repo_id,workstream_run').all()) {
      const resource = parseCoordinationRunResource(parseJsonObject(sqlString(row, 'payload_json'), 'launch policy protected run resource'));
      for (const path of [resource.source_repo, resource.git_common_dir, resource.worktree_root, resource.main_worktree_path, resource.runtime_root]) {
        protectedPaths.add(resolve(path));
        if (existsSync(path)) protectedPaths.add(realpathSync(path));
      }
    }
    for (const protectedPath of protectedPaths) {
      if (pathContains(protectedPath, evidenceRootReal) || pathContains(evidenceRootReal, protectedPath)) invalid('policy program_evidence_root overlaps a coordinator clone/state/session/worktree/runtime root', [evidenceRootReal, protectedPath]);
    }

    // Registration requires the exact completed bootstrap main-worktree edge:
    // one active canonical main and its sole committed create operation. A
    // planned/terminal main or an unresolved/additional operation is not the
    // clean active main authority from which policy registration is allowed.
    const mainRows = this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND kind='main' AND is_current_canonical=1 ORDER BY canonical_worktree_id").all(repoId, workstreamRun);
    if (mainRows.length !== 1) invalid('launch policy registration requires exactly one canonical main worktree', [`count=${String(mainRows.length)}`]);
    const mainRow = mainRows[0];
    if (mainRow === undefined) throw new CoordinationRuntimeError('invalid-request', 'launch-policy-invalid: canonical main worktree disappeared during validation');
    const main = canonicalWorktreeFromRow(mainRow);
    if (main.state !== 'active' || main.canonical_path !== sourceRoot) invalid('launch policy registration requires the exact active run-main worktree', [main.state, main.canonical_path, sourceRoot]);
    const mainOperations = this.#db.prepare('SELECT * FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND canonical_worktree_id=? ORDER BY entity_id').all(repoId, workstreamRun, sqlString(mainRow, 'canonical_worktree_id')).map(worktreeOperationFromRow);
    if (mainOperations.length !== 1 || mainOperations[0]?.operation_type !== 'create' || mainOperations[0]?.stage !== 'committed') invalid('launch policy registration requires the sole main-worktree create operation to be committed', mainOperations.map((operation) => `${operation.operation_id}:${operation.operation_type}:${operation.stage}`));

    // A clean run-main HEAD detects product/source planning writes before policy
    // registration; the no-event parent model boundary itself is additionally
    // fenced by the runtime policy gate and cannot be inferred retrospectively
    // from SQLite.
    const statusResult = this.#gitQueryResult(sourceRoot, { kind: 'status-porcelain', includeIgnored: false }, 'invalid-request', 'launch policy run-main cleanliness inspection failed');
    if (statusResult.stdout.byteLength !== 0) invalid('launch policy must register from a clean run-main worktree before parent planning', [`status_bytes=${String(statusResult.stdout.byteLength)}`]);

    // policy_authority_commit H has one parent equal to content_result_commit;
    // the complete diff is exactly the previously absent policy path. Thus the
    // launch overlay is a sibling and can never enter policy/G/H ancestry.
    const parentListing = this.#gitQueryText(sourceRoot, { kind: 'rev-list-parents', revision: policyCommit }, 'invalid-request', 'launch policy commit parent inspection failed');
    const parents = (parentListing ?? '').trim().split(/\s+/u).filter((entry) => entry.length > 0);
    const soleParent = parents.length === 2 ? parents[1] : undefined;
    if (soleParent === undefined) throw new CoordinationRuntimeError('invalid-request', 'launch-policy-invalid: policy_authority_commit must have exactly one parent', [`parents=${parents.slice(1).join(',') || 'none'}`]);
    if (soleParent !== bootstrap.content_commit) invalid('policy_authority_commit sole parent is not content_result_commit', [soleParent, bootstrap.content_commit]);
    const diffResult = this.#gitQueryResult(sourceRoot, { kind: 'diff-paths', from: soleParent, to: policyCommit, noRenames: true }, 'invalid-request', 'launch policy commit diff inspection failed');
    const diffPaths = new TextDecoder('utf-8', { fatal: true }).decode(diffResult.stdout).split('\0').filter((entry) => entry.length > 0);
    if (diffPaths.length !== 1 || diffPaths[0] !== ref) invalid('policy_authority_commit must change exactly the single previously-absent policy path', [`paths=${diffPaths.join(',')}`, ref]);
    const parentListingAtPath = this.#gitQueryText(sourceRoot, { kind: 'ls-tree-path', revision: soleParent, path: ref }, 'invalid-request', 'launch policy parent path inspection failed');
    if ((parentListingAtPath ?? '').trim().length !== 0) invalid('policy path must be previously absent at content_result_commit (no replacement)', [ref]);

    const acceptedGraph = this.#db.prepare("SELECT entity_id FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.semantic_graph.v1' LIMIT 1").get(repoId, workstreamRun);
    if (acceptedGraph !== undefined) casConflict('a complete graph is already accepted; launch policy registration is late', [sqlString(acceptedGraph, 'entity_id')]);
  }

  #reconstructD65BootstrapCharter(repoId: string, workstreamRun: string) {
    const eventRow = asRow(this.#db.prepare("SELECT * FROM events WHERE repo_id=? AND event_seq=1 AND event_type='run-attached' AND entity_type='run' AND entity_id=?").get(repoId, workstreamRun), 'D65 bootstrap B event');
    const event = eventFromRow(eventRow);
    const resultRow = asRow(this.#db.prepare('SELECT * FROM idempotency_results WHERE repo_id=? AND idempotency_key=?').get(repoId, event.idempotency_key), 'D65 bootstrap B idempotency result');
    return reconstructD65BootstrapCharter({
      event,
      result: {
        repo_id: repoId,
        idempotency_key: event.idempotency_key,
        request_sha256: sqlString(resultRow, 'request_sha256'),
        committed_event_seq: sqlInteger(resultRow, 'committed_event_seq'),
        payload: parseJsonObject(sqlString(resultRow, 'payload_json'), 'D65 bootstrap B result payload'),
      },
    });
  }

  // D65-A5 loader/replayer sub-part 2a. The current repositories.event_seq is E
  // (the sequence BEFORE `#nextEventSequence` allocates the registration event
  // R); the plan requires R=E+1, so the graph's declared covered_event_seq must
  // equal that current event_seq. The graph_sequence chains strictly: the first
  // complete graph is sequence 2 whose prior_graph_sha256 is the accepted
  // bootstrap digest and prior_event_seq is the bootstrap attach receipt B;
  // every later graph is prior+1, names the prior accepted complete digest, and
  // prior_event_seq equals that prior graph's registration R. Fork/gap/rollback
  // and any prior-tuple mismatch are `semantic-graph-cas-conflict`.
  #assertD65GraphSequenceCas(repoId: string, workstreamRun: string, graph: D65CompleteGraph): void {
    // R = E + 1: E is the store's current event sequence at validation time.
    const currentEventSeq = sqlInteger(asRow(this.#db.prepare('SELECT event_seq FROM repositories WHERE repo_id=?').get(repoId), 'graph registration repository sequence'), 'event_seq');
    if (graph.covered_event_seq !== currentEventSeq) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-cas-conflict: graph covered_event_seq must equal the current coordinator event sequence so the registration event is exactly R=E+1', [`covered_event_seq=${String(graph.covered_event_seq)}`, `event_seq=${String(currentEventSeq)}`]);
    // Resolve the highest accepted complete graph for this run (if any) and the
    // bootstrap artifact (the prior authority of the first complete graph). The
    // prior-graph predicate MUST bind the authoritative complete-graph document
    // schema, not merely the id prefix: `register-authoritative-artifact`
    // accepts a caller-chosen artifact_id, so a non-graph task artifact (e.g. a
    // launch policy) could otherwise squat the `semantic-graph:<20-digit>`
    // namespace and be mistaken for the prior graph. Requiring
    // document_schema_version='autopilot.semantic_graph.v1' closes that fork.
    const priorGraphRow = this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND entity_id LIKE 'semantic-graph:%' AND json_extract(payload_json, '$.document_schema_version')='autopilot.semantic_graph.v1' ORDER BY entity_id DESC LIMIT 1").get(repoId, workstreamRun);
    if (priorGraphRow === undefined) {
      // First complete graph: sequence must be exactly 2 and prior authority is
      // the bootstrap artifact accepted by attach-run.
      if (graph.graph_sequence !== 2) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-cas-conflict: the first complete graph must be sequence 2', [`graph_sequence=${String(graph.graph_sequence)}`]);
      const bootstrap = authoritativeArtifactFromRow(asRow(this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(repoId, `semantic-graph-bootstrap:${workstreamRun}`), 'graph registration bootstrap artifact'));
      if (graph.prior_graph_sha256 !== bootstrap.evidence.sha256) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-cas-conflict: first complete graph prior_graph_sha256 is not the accepted bootstrap digest', [graph.prior_graph_sha256, bootstrap.evidence.sha256]);
      if (graph.prior_event_seq !== bootstrap.registered_event_seq) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-cas-conflict: first complete graph prior_event_seq is not the bootstrap attach receipt', [`prior_event_seq=${String(graph.prior_event_seq)}`, `attach_receipt=${String(bootstrap.registered_event_seq)}`]);
      return;
    }
    // Later complete graph: chain to the prior accepted complete graph tuple.
    const prior = authoritativeArtifactFromRow(asRow(priorGraphRow, 'graph registration prior complete graph artifact'));
    const priorSequence = d65SemanticGraphSequenceFromArtifactId(prior.artifact_id);
    if (graph.graph_sequence !== priorSequence + 1) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-cas-conflict: graph_sequence must be exactly the prior accepted graph sequence plus one', [`graph_sequence=${String(graph.graph_sequence)}`, `prior_sequence=${String(priorSequence)}`]);
    if (graph.prior_graph_sha256 !== prior.evidence.sha256) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-cas-conflict: prior_graph_sha256 is not the prior accepted complete graph digest', [graph.prior_graph_sha256, prior.evidence.sha256]);
    if (graph.prior_event_seq !== prior.registered_event_seq) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-cas-conflict: prior_event_seq is not the prior accepted graph registration event R', [`prior_event_seq=${String(graph.prior_event_seq)}`, `prior_R=${String(prior.registered_event_seq)}`]);
  }

  #validateD65GraphRegistration(repoId: string, workstreamRun: string, sourceRoot: string, publicationCommit: string, graphRef: string, sealedGraphSha256: `sha256:${string}`, graphRootBytes: Uint8Array, artifactId: string): void {
    const parentListing = this.#gitQueryText(sourceRoot, { kind: 'rev-list-parents', revision: publicationCommit }, 'invalid-request', 'semantic graph publication parent inspection failed');
    const publicationParents = (parentListing ?? '').trim().split(/\s+/u).filter((entry) => entry.length > 0);
    const soleParent = publicationParents[1];
    if (soleParent === undefined) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: publication commit H has no parent');
    const runMainHead = this.#gitQueryText(sourceRoot, { kind: 'head' }, 'invalid-request', 'semantic graph covered authority HEAD inspection failed');
    if (runMainHead !== soleParent) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: publication H sole parent G is not the exact current run authority HEAD', [soleParent, String(runMainHead)]);
    this.#assertD65RegularGitBlob(sourceRoot, publicationCommit, graphRef, null, 'semantic graph root');
    const diffResult = this.#gitQueryResult(sourceRoot, { kind: 'diff-paths', from: soleParent, to: publicationCommit, noRenames: true }, 'invalid-request', 'semantic graph publication diff inspection failed');
    const diffPaths = new TextDecoder('utf-8', { fatal: true }).decode(diffResult.stdout).split('\0').filter((entry) => entry.length > 0);
    // The graph itself names G (covered_authority_commit) and its covered E; the
    // validator proves H's sole parent equals that G and the diff is graph-only.
    const declared = parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(graphRootBytes), 'semantic graph root');
    if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) throw new CoordinationRuntimeError('invalid-request', 'semantic graph root must be an object');
    const declaredAuthority = (declared as Record<string, unknown>)['covered_authority_commit'];
    const declaredCovered = (declared as Record<string, unknown>)['covered_event_seq'];
    if (typeof declaredAuthority !== 'string') throw new CoordinationRuntimeError('invalid-request', 'semantic graph covered_authority_commit is invalid');
    if (typeof declaredCovered !== 'number') throw new CoordinationRuntimeError('invalid-request', 'semantic graph covered_event_seq is invalid');
    const facts = validateD65GraphPublication({
      observation: { publicationCommit, publicationParents, diffPaths, graphRootBytes, sealedGraphSha256, graphRef },
      expectedAuthorityCommit: declaredAuthority,
      expectedCoveredEventSeq: declaredCovered,
    });
    if (facts.artifactId !== artifactId) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: artifact id is not the deterministic graph sequence id', [artifactId, facts.artifactId]);
    if (facts.artifactId !== d65SemanticGraphArtifactId(facts.graph.graph_sequence)) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: graph sequence id mismatch');
    const graphPrefix = d65GraphPathPrefix(facts.graph.graph_sequence);
    const priorPrefixEntry = this.#gitQueryText(sourceRoot, { kind: 'ls-tree-path', revision: soleParent, path: graphPrefix.slice(0, -1) }, 'invalid-request', 'semantic graph authority-prefix inspection failed');
    if ((priorPrefixEntry ?? '').trim().length !== 0) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-discovery-mismatch: authority G already contains the publication sequence prefix', [graphPrefix]);
    // D65-A5 loader/replayer sub-part 2a: bind the graph identity to the store's
    // authoritative sequence. The plan requires R=E+1 (the registration event R
    // is exactly the graph's covered E plus one), a strict graph_sequence chain,
    // and prior-tuple CAS against the highest accepted graph/bootstrap artifact
    // (fork/gap/rollback are `semantic-graph-cas-conflict`). Root/G/H shape or
    // queue counts alone are never acceptance.
    this.#assertD65GraphSequenceCas(repoId, workstreamRun, facts.graph);
    // Load and verify the authority tree + all five core blobs from G, then
    // prove the graph's queue-projection index counts equal the derived queue
    // equations from the authority state blob.
    const state = this.#validateD65GraphAuthority(sourceRoot, facts.authorityCommit, facts.graph);
    // D65-A5 loader/replayer: load every authority + projection shard from the
    // publication commit H (root + shards live under semantic-graphs/<seq>/ in
    // H), prove blob<->descriptor<->shard<->aggregate agreement, contiguous
    // ranges, the 512 MiB / 200,000-entry aggregate ceilings, and the closed
    // queue value shape; then prove the loaded queue MEMBER identities equal the
    // derived equation from the authority state (counts alone are never
    // acceptance).
    const loaded = loadD65CompleteGraph(facts.graph, (ref) => this.#readD65GraphShardBlob(sourceRoot, publicationCommit, ref));
    const expectedPublicationPaths = new Set<string>([graphRef]);
    const indexes = [...Object.values(facts.graph.collections), facts.graph.work_items, facts.graph.bughunt, facts.graph.exceptions, facts.graph.coordinator_projection, ...Object.values(facts.graph.queue_projection)];
    for (const index of indexes) for (const descriptor of index.shards) {
      if (expectedPublicationPaths.has(descriptor.ref)) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-discovery-mismatch: graph publication path is referenced more than once', [descriptor.ref]);
      expectedPublicationPaths.add(descriptor.ref);
    }
    const actualPublicationPaths = new Set(diffPaths);
    if (actualPublicationPaths.size !== expectedPublicationPaths.size || [...expectedPublicationPaths].some((path) => !actualPublicationPaths.has(path))) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-discovery-mismatch: publication H diff is not exactly graph root plus referenced shards', [`actual=${[...actualPublicationPaths].sort().join(',')}`, `expected=${[...expectedPublicationPaths].sort().join(',')}`]);
    // The additive coordinator_projection freeze is consumed here, at the real
    // registration authority boundary. R=E+1 proves the store is still exactly
    // at E, so compare every reconstructed member/version against committed
    // coordinator state before inserting the graph's own future artifact row.
    const committedProjection = this.#d65CoordinatorProjectionAt(repoId, workstreamRun, facts.graph.covered_event_seq, artifactId);
    assertD65CoordinatorProjectionEqual(loaded.coordinatorProjection, committedProjection, canonicalJson);
    const loadedCharter = parseD65BootstrapCharter(facts.graph.bootstrap_charter);
    const reconstructedCharter = this.#reconstructD65BootstrapCharter(repoId, workstreamRun);
    if (canonicalJson(loadedCharter) !== canonicalJson(reconstructedCharter)) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-bootstrap-charter-invalid: graph charter does not equal immutable B event/result authority');
    const runtimePrefix = relative(committedProjection.resource.main_worktree_path, committedProjection.resource.runtime_root).replace(/\\/gu, '/');
    if (runtimePrefix.length === 0 || runtimePrefix === '..' || runtimePrefix.startsWith('../') || isAbsolute(runtimePrefix)) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-discovery-mismatch: run runtime root is not an exact descendant of its main worktree', [committedProjection.resource.main_worktree_path, committedProjection.resource.runtime_root]);
    const independentlyDiscovered = discoverD65GraphBody({
      readGitAtG: this.#d65GraphAuthorityReader(sourceRoot, facts.authorityCommit),
      acceptedArtifacts: committedProjection.authoritative_artifacts,
      coordinatorProjection: committedProjection,
      repoId,
      workstreamRun,
      workstream: committedProjection.run.workstream,
      runtimePrefix,
    });
    assertD65DiscoveredGraphBodyEqual(loaded, independentlyDiscovered.body);
    if (facts.graph.graph_sequence === 2) {
      const acceptedPolicy = this.#d65AcceptedLaunchPolicy(repoId, workstreamRun);
      const parentLine = this.#gitQueryText(sourceRoot, { kind: 'rev-list-parents', revision: facts.authorityCommit }, 'invalid-request', 'first complete graph G parent inspection failed');
      const parents = (parentLine ?? '').trim().split(/\s+/u).filter((entry) => entry.length > 0);
      const diff = this.#gitQueryResult(sourceRoot, { kind: 'diff-paths', from: acceptedPolicy.artifact.git_commit, to: facts.authorityCommit, noRenames: true }, 'invalid-request', 'first complete graph parent-planning diff inspection failed');
      const authorityDiffPaths = new TextDecoder('utf-8', { fatal: true }).decode(diff.stdout).split('\0').filter((entry) => entry.length > 0);
      validateD65FirstCompleteGraph({ graph: facts.graph, charter: reconstructedCharter, historyBThroughE: this.#d65AcceptedHistory(repoId, facts.graph.covered_event_seq), policyArtifact: acceptedPolicy.artifact, policy: acceptedPolicy.policy, authorityCommitParents: parents, authorityDiffPaths });
    } else {
      this.#assertD65SuccessorGraphReplay(repoId, workstreamRun, sourceRoot, loaded, state);
      this.#assertD65SuccessorAuthorityMovement(repoId, workstreamRun, sourceRoot, facts.authorityCommit, independentlyDiscovered);
    }
    for (const queueKind of D65_QUEUE_KEYS) assertD65QueueMemberValues(loaded, queueKind);
    assertD65QueueProjectionMembers({
      state,
      members: {
        unit_ready: d65ProjectionIdentities(loaded, 'unit_ready'),
        unit_running: d65ProjectionIdentities(loaded, 'unit_running'),
        unit_blocked: d65ProjectionIdentities(loaded, 'unit_blocked'),
        unit_completed: d65ProjectionIdentities(loaded, 'unit_completed'),
        unit_held: d65ProjectionIdentities(loaded, 'unit_held'),
        work_audit_review: d65ProjectionIdentities(loaded, 'work_audit_review'),
        work_validation_ready: d65ProjectionIdentities(loaded, 'work_validation_ready'),
      },
    });
  }

  /**
   * Successor G must explain exact Git authority movement: G is the prior
   * accepted H when no intervening Git mutation occurred, or the exact current
   * main-authority tip reached from that H solely through package-accepted
   * Git/store saga effects covered through E. Each first-parent step pairs to
   * its event/evidence: a one-parent authority-artifact commit changing only
   * `authority/` paths with a covered accepted artifact registration at that
   * exact commit, or a runtime unit merge whose exact `merge_commit_sha` is a
   * discovered `unit-merges/` evidence member at G. Any unpaired parent,
   * hidden commit, manual merge, or unexplained product/source change rejects.
   */
  #assertD65SuccessorAuthorityMovement(repoId: string, workstreamRun: string, sourceRoot: string, authorityCommit: string, discovered: ReturnType<typeof discoverD65GraphBody>): void {
    const priorArtifact = authoritativeArtifactFromRow(asRow(this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.semantic_graph.v1' ORDER BY entity_id DESC LIMIT 1").get(repoId, workstreamRun), 'D65 successor prior graph artifact'));
    const priorH = priorArtifact.git_commit;
    const gParents = (this.#gitQueryText(sourceRoot, { kind: 'rev-list-parents', revision: authorityCommit }, 'invalid-request', 'successor authority G parent inspection failed') ?? '').trim().split(/\s+/u).filter((entry) => entry.length > 0);
    const gParent = gParents[1];
    if (gParents.length !== 2 || gParent === undefined) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: successor authority G must have exactly one parent', gParents);
    // Collect the exact accepted merge_commit_sha set from the independently
    // discovered unit-merges evidence at G and every covered accepted artifact
    // commit; every intermediate first-parent step must be one of them.
    const mergeCommits = new Set<string>();
    for (const entry of discovered.authority.collections.unit_merges) {
      const parsed = discovered.authority.parsed_by_ref.get(entry.ref);
      if (parsed === undefined || typeof parsed !== 'object' || parsed === null) throw new CoordinationRuntimeError('store-corrupt', 'discovered unit-merge evidence lacks its parsed value', [entry.ref]);
      const sha = (parsed as Record<string, unknown>)['merge_commit_sha'];
      if (typeof sha === 'string' && /^[a-f0-9]{40}$/u.test(sha)) mergeCommits.add(sha);
    }
    // Every accepted artifact commit pairs the exact evidence refs it created.
    const recoveryEvidence = this.#db.prepare("SELECT * FROM reconciliation_evidence WHERE repo_id=? AND workstream_run=? AND source IN ('attempt-reset','quarantine-capture') ORDER BY entity_id").all(repoId, workstreamRun).map(reconciliationEvidenceFromRow).flatMap((entry) => entry.release_condition.evidence === null ? [] : [entry.release_condition.evidence]);
    const artifactRefsByCommit = new Map<string, Set<string>>();
    for (const artifactRow of this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=?').all(repoId, workstreamRun).map(authoritativeArtifactFromRow)) {
      const refs = artifactRefsByCommit.get(artifactRow.git_commit) ?? new Set<string>();
      refs.add(artifactRow.evidence.ref);
      if (artifactRow.document_schema_version === 'autopilot.continuation_event.v1') {
        const continuation = parseD65ContinuationEvent(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(repoId, artifactRow.evidence)), 'accepted continuation artifact movement'));
        const embedded = [...continuation.evidence_refs, ...(continuation.failed_spec_ref === null ? [] : [continuation.failed_spec_ref]), ...(continuation.failed_receipt_ref === null ? [] : [continuation.failed_receipt_ref])];
        for (const evidence of embedded) {
          const bytes = this.#gitQueryResult(sourceRoot, { kind: 'show-file', revision: artifactRow.git_commit, path: evidence.ref }, 'invalid-request', 'accepted continuation embedded evidence is absent at its artifact commit').stdout;
          const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
          if (digest !== evidence.sha256 || bytes.byteLength !== evidence.byte_count) throw new CoordinationRuntimeError('invalid-request', 'accepted continuation embedded evidence differs at its artifact commit', [evidence.ref, evidence.sha256, digest]);
          refs.add(evidence.ref);
        }
      }
      artifactRefsByCommit.set(artifactRow.git_commit, refs);
    }
    let cursor = gParent;
    for (let step = 0; step < 10_000; step += 1) {
      if (cursor === priorH) return;
      const parents = (this.#gitQueryText(sourceRoot, { kind: 'rev-list-parents', revision: cursor }, 'invalid-request', 'successor authority-movement parent inspection failed') ?? '').trim().split(/\s+/u).filter((entry) => entry.length > 0);
      const stepParents = parents.slice(1);
      const firstParent = stepParents[0];
      if (firstParent === undefined) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-transition-invalid: successor authority movement reached a rootless commit before the prior accepted H', [cursor, priorH]);
      if (mergeCommits.has(cursor)) { cursor = firstParent; continue; }
      const artifactRefs = artifactRefsByCommit.get(cursor);
      if (stepParents.length === 1 && artifactRefs !== undefined) {
        // A one-parent authority-artifact commit changes exactly its accepted
        // immutable artifact paths and nothing else.
        const diff = this.#gitQueryResult(sourceRoot, { kind: 'diff-paths', from: firstParent, to: cursor, noRenames: true }, 'invalid-request', 'successor authority-artifact diff inspection failed');
        const paths = new TextDecoder('utf-8', { fatal: true }).decode(diff.stdout).split('\0').filter((entry) => entry.length > 0);
        if (paths.length === 0 || paths.some((path) => !artifactRefs.has(path))) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-transition-invalid: authority-artifact commit changes a path outside its accepted immutable artifact set', [cursor, ...paths.slice(0, 8)]);
        cursor = firstParent;
        continue;
      }
      if (stepParents.length === 1) {
        const diff = this.#gitQueryResult(sourceRoot, { kind: 'diff-paths', from: firstParent, to: cursor, noRenames: true }, 'invalid-request', 'successor unit-recovery evidence diff inspection failed');
        const paths = new TextDecoder('utf-8', { fatal: true }).decode(diff.stdout).split('\0').filter((entry) => entry.length > 0);
        const evidence = paths.length === 1 ? recoveryEvidence.filter((entry) => entry.ref === paths[0]) : [];
        const accepted = evidence[0];
        if (evidence.length === 1 && accepted !== undefined && paths[0] !== undefined) {
          const bytes = this.#gitQueryResult(sourceRoot, { kind: 'show-file', revision: cursor, path: paths[0] }, 'invalid-request', 'successor unit-recovery evidence blob inspection failed').stdout;
          const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
          if (digest !== accepted.sha256) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-transition-invalid: unit-recovery evidence commit bytes differ from accepted reconciliation authority', [paths[0], accepted.sha256, digest]);
          cursor = firstParent;
          continue;
        }
      }
      throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-transition-invalid: successor authority movement contains an unpaired Git commit between the prior accepted H and G', [cursor, priorH, `parents=${String(stepParents.length)}`]);
    }
    throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-transition-invalid: successor authority movement did not reach the prior accepted H within its bounded walk', [priorH, authorityCommit]);
  }

  /** Exact B(N) + liveness* + one-semantic-event successor proof. */
  #assertD65SuccessorGraphReplay(repoId: string, workstreamRun: string, sourceRoot: string, current: D65LoadedGraph, currentState: AutopilotState): void {
    const priorArtifact = authoritativeArtifactFromRow(asRow(this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.semantic_graph.v1' ORDER BY entity_id DESC LIMIT 1").get(repoId, workstreamRun), 'D65 successor prior graph'));
    const priorRoot = parseD65CompleteGraph(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(repoId, priorArtifact.evidence)), 'D65 successor prior graph root'));
    if (priorRoot.graph_sequence + 1 !== current.graph.graph_sequence || priorArtifact.registered_event_seq !== priorRoot.covered_event_seq + 1) throw new CoordinationRuntimeError('store-corrupt', 'D65 successor prior graph tuple is internally inconsistent');
    const priorRegistrationEvent = asRow(this.#db.prepare("SELECT idempotency_key FROM events WHERE repo_id=? AND event_type='authoritative-artifact-registered' AND entity_id=?").get(repoId, priorArtifact.artifact_id), 'D65 successor prior graph registration event');
    const proven = this.lookupCommittedGraphRegistration(repoId, workstreamRun, { artifactId: priorArtifact.artifact_id, publicationCommit: priorArtifact.git_commit, graphRef: priorArtifact.evidence.ref, graphSha256: priorArtifact.evidence.sha256, coveredEventSeq: priorRoot.covered_event_seq, idempotencyKey: sqlString(priorRegistrationEvent, 'idempotency_key') });
    if (proven?.registrationEventSeq !== priorArtifact.registered_event_seq) throw new CoordinationRuntimeError('store-corrupt', 'D65 successor prior graph lacks exact R event/result authority');
    const priorLoaded = loadD65CompleteGraph(priorRoot, (ref) => this.#readD65GraphShardBlob(sourceRoot, priorArtifact.git_commit, ref));
    const baseline = applyD65GraphRegistrationBaseline({ prior: priorLoaded.coordinatorProjection, artifact: priorArtifact });
    const suffixRows = this.#db.prepare("SELECT e.*,r.repo_id AS result_repo_id,r.idempotency_key AS result_key,r.request_sha256 AS result_request,r.committed_event_seq AS result_seq,r.payload_json AS result_payload FROM events e LEFT JOIN idempotency_results r ON r.repo_id=e.repo_id AND r.idempotency_key=e.idempotency_key WHERE e.repo_id=? AND e.event_seq>? AND e.event_seq<=? ORDER BY e.event_seq").all(repoId, priorArtifact.registered_event_seq, current.graph.covered_event_seq);
    if (suffixRows.length !== current.graph.covered_event_seq - priorArtifact.registered_event_seq) throw new CoordinationRuntimeError('store-corrupt', 'D65 successor suffix is not a contiguous event range');
    let semanticType: string | null = null;
    let subscriptionRecovery: ReturnType<typeof parseD65ContinuationEvent> | null = null;
    for (let index = 0; index < suffixRows.length; index += 1) {
      const row = asRow(suffixRows[index], 'D65 successor event');
      const eventSeq = sqlInteger(row, 'event_seq');
      if (eventSeq !== priorArtifact.registered_event_seq + index + 1) throw new CoordinationRuntimeError('store-corrupt', 'D65 successor event range has a gap', [String(eventSeq)]);
      const idempotencyKey = sqlString(row, 'idempotency_key');
      const requestSha = sqlString(row, 'request_sha256');
      const payloadText = sqlNullableString(row, 'result_payload');
      if (sqlNullableString(row, 'result_repo_id') !== repoId || sqlNullableString(row, 'result_key') !== idempotencyKey || sqlNullableString(row, 'result_request') !== requestSha || sqlNullableInteger(row, 'result_seq') !== eventSeq || payloadText === null) throw new CoordinationRuntimeError('store-corrupt', 'D65 successor event lacks its exact immutable result join', [String(eventSeq)]);
      const payload = parseJsonObject(payloadText, 'D65 successor result');
      const eventType = sqlString(row, 'event_type');
      const joined: D65AcceptedEventResultJoin = { repo_id: repoId, event_seq: eventSeq, event_type: eventType, entity_type: sqlString(row, 'entity_type'), entity_id: sqlString(row, 'entity_id'), idempotency_key: idempotencyKey, request_sha256: requestSha, result: { repo_id: repoId, idempotency_key: idempotencyKey, request_sha256: requestSha, committed_event_seq: eventSeq, payload } };
      // Repository event sequences are shared across runs. Only an event whose
      // exact immutable result names this run as a semantic owner can authorize
      // this run's N+1; unrelated runs are transparent wherever interleaved.
      if (!d65SemanticEventWorkstreamRuns(joined).includes(workstreamRun)) continue;
      let pure = false;
      if (eventType === 'session-heartbeat') {
        const identity = joined.entity_id;
        const owned = [...baseline.sessions, ...current.coordinatorProjection.sessions].some((session) => session.session_lease_id === identity);
        pure = owned && isPureD65SessionHeartbeat(joined);
      } else if (eventType === 'child-heartbeat') {
        const identity = joined.entity_id;
        const owned = [...baseline.children, ...current.coordinatorProjection.children].some((child) => child.child_lease_id === identity);
        pure = owned && isPureD65ChildHeartbeat(joined);
      } else if (eventType === 'program-heartbeat-accepted') {
        const acceptance = parseD65HeartbeatAcceptanceResult(payload);
        pure = acceptance.repo_id === repoId && acceptance.workstream_run === workstreamRun && joined.entity_id === workstreamRun;
      }
      if (pure) {
        if (semanticType !== null) throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-transition-invalid: normalized liveness appears after the successor semantic event');
        continue;
      }
      if (semanticType !== null) throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-transition-invalid: successor collapses more than one semantic event', [semanticType, eventType]);
      semanticType = eventType;
      if (eventType === 'authoritative-artifact-registered') {
        const artifact = parseCoordinationAuthoritativeArtifact(payload['authoritative_artifact']);
        if (artifact.repo_id !== repoId || artifact.source_run !== workstreamRun || artifact.document_schema_version !== 'autopilot.continuation_event.v1') continue;
        const continuation = parseD65ContinuationEvent(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(repoId, artifact.evidence)), 'successor subscription-recovery continuation'));
        if (continuation.trigger === 'subscription-failure' && continuation.class === 'provider-capacity-blocked') subscriptionRecovery = continuation;
      }
    }
    if (semanticType === null) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-cas-conflict: no-event N+1 is forbidden; coordinator-transient recovery retains the same accepted graph tuple');
    const allowed = this.#d65ProjectionSectionsForSemanticEvent(semanticType);
    const keys: readonly (keyof D65CoordinatorProjectionSnapshot)[] = ['run','resource','sessions','children','attempts','faults','reservations','edit_leases','acquisition_groups','worktrees','operations','terminal_intents','current_terminal_intent_id','authoritative_artifacts','run_version'];
    for (const key of keys) if (!allowed.has(key) && canonicalJson(baseline[key]) !== canonicalJson(current.coordinatorProjection[key])) throw new CoordinationRuntimeError('invalid-state', `semantic-graph-transition-invalid: ${semanticType} changed forbidden coordinator projection section ${key}`);
    const priorStateBytes = this.#readD65GraphShardBlob(sourceRoot, priorArtifact.git_commit, priorRoot.core.state.ref);
    if (`sha256:${createHash('sha256').update(priorStateBytes).digest('hex')}` !== priorRoot.core.state.sha256) throw new CoordinationRuntimeError('store-corrupt', 'D65 successor prior state bytes disagree with the prior graph root');
    const priorState = parseAutopilotState(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(priorStateBytes), 'D65 successor prior state'));
    const priorUnitIds = Object.keys(priorState.units).sort();
    const currentUnitIds = Object.keys(currentState.units).sort();
    if (canonicalJson(priorUnitIds) !== canonicalJson(currentUnitIds)) throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-transition-invalid: complete-mode unit identities were created or deleted');
    for (const unitId of priorUnitIds) {
      const before = priorState.units[unitId];
      const after = currentState.units[unitId];
      if (before === undefined || after === undefined) throw new CoordinationRuntimeError('store-corrupt', 'D65 successor unit identity disappeared after exact key-set comparison', [unitId]);
      if (canonicalJson(before) === canonicalJson(after)) continue;
      const successorSpecRef = after.spec_ref;
      const successorSpecEntries = successorSpecRef === undefined ? [] : (current.authorities['specs']?.entries ?? []).filter((entry) => {
        const runtimeRelative = relative(dirname(current.graph.core.state.ref), entry.ref).replace(/\\/gu, '/');
        return entry.ref === successorSpecRef || runtimeRelative === successorSpecRef;
      });
      const successorSpecEntry = successorSpecEntries.length === 1 ? successorSpecEntries[0] : undefined;
      const exactSubscriptionRecovery = subscriptionRecovery !== null
        && subscriptionRecovery.repo_id === repoId
        && subscriptionRecovery.workstream_run === workstreamRun
        && subscriptionRecovery.unit_id === unitId
        && subscriptionRecovery.attempt === before.attempt
        && subscriptionRecovery.retry_ordinal !== null
        && after.attempt === before.attempt + 1
        && successorSpecEntry !== undefined
        && successorSpecEntry.document_schema_version === 'autopilot.unit_spec.v1'
        && subscriptionRecovery.evidence_refs.some((evidence) => evidence.ref === current.graph.core.state.ref && evidence.sha256 === current.graph.core.state.sha256 && evidence.byte_count === current.graph.core.state.byte_count)
        && subscriptionRecovery.evidence_refs.some((evidence) => evidence.ref === successorSpecEntry.ref && evidence.sha256 === successorSpecEntry.sha256 && evidence.byte_count === successorSpecEntry.byte_count);
      assertD65UnitTransition({ unitId, from: before.state, to: after.state, fromAttempt: before.attempt, toAttempt: after.attempt, hasRecoveryEvidence: semanticType === 'unit-attempt-registered' || semanticType === 'adjudication-accepted' || semanticType === 'run-scoped-fault-resolved' || exactSubscriptionRecovery });
    }
    const priorItems = priorState.work_items ?? {};
    const currentItems = currentState.work_items ?? {};
    const priorItemIds = Object.keys(priorItems).sort();
    if (canonicalJson(priorItemIds) !== canonicalJson(Object.keys(currentItems).sort())) throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-transition-invalid: complete-mode work-item identities were created or deleted');
    for (const workItemId of priorItemIds) {
      const before = priorItems[workItemId];
      const after = currentItems[workItemId];
      if (before === undefined || after === undefined) throw new CoordinationRuntimeError('store-corrupt', 'D65 successor work-item identity disappeared after exact key-set comparison', [workItemId]);
      if (canonicalJson(before) === canonicalJson(after)) continue;
      assertD65WorkItemTransition({ workItemId, from: before.state, to: after.state });
    }
  }

  #d65ProjectionSectionsForSemanticEvent(eventType: string): ReadonlySet<keyof D65CoordinatorProjectionSnapshot> {
    const map: Readonly<Record<string, readonly (keyof D65CoordinatorProjectionSnapshot)[]>> = Object.freeze({
      'session-attached': ['run','sessions','run_version'], 'session-handoff-prepared': ['sessions'], 'session-detached': ['sessions'],
      'unit-attempt-registered': ['attempts'], 'unit-attempt-verified': ['attempts'], 'unit-attempt-checkpointed': ['attempts'], 'unit-attempt-superseded': ['attempts','acquisition_groups','edit_leases'],
      'child-registered': ['children','attempts'], 'child-terminal': ['children','attempts','acquisition_groups','edit_leases'], 'child-recovery-required': ['children','attempts'],
      'acquisition-group-waiting': ['attempts','acquisition_groups'], 'acquisition-group-granted': ['attempts','acquisition_groups','edit_leases'], 'acquisition-group-cancelled': ['acquisition_groups','edit_leases'], 'grant-offer-expired': ['acquisition_groups'], 'grant-offers-expired': ['acquisition_groups'],
      'claim-request-cancelled': ['acquisition_groups','edit_leases'], 'claim-request-deferred': [], 'claim-request-released': ['acquisition_groups','edit_leases'],
      'release-evidence-accepted': ['run','attempts','reservations','edit_leases','acquisition_groups','terminal_intents','current_terminal_intent_id','run_version'],
      'reservation-obligation-resolved': [], 'run-reconciled': ['attempts','reservations','edit_leases','acquisition_groups'], 'startup-run-reconciled': ['children','attempts','reservations','edit_leases','acquisition_groups'],
      'run-terminal-prepared': ['run','terminal_intents','current_terminal_intent_id','run_version'], 'run-terminal-cancelled': ['run','terminal_intents','current_terminal_intent_id','run_version'],
      'run-scoped-fault-recorded': ['faults'], 'run-scoped-fault-resolved': ['faults'], 'authoritative-artifact-registered': ['authoritative_artifacts'],
      'mailbox-drained': [], 'worktree-operation-prepared': ['worktrees','operations'], 'worktree-operation-in-progress': ['worktrees','operations'], 'worktree-operation-verified': ['worktrees','operations'], 'worktree-operation-reconciling': ['worktrees','operations'], 'worktree-operation-committed': ['worktrees','operations'], 'worktree-operation-compensated': ['worktrees','operations'], 'worktree-operation-failed': ['worktrees','operations'],
      'message-acknowledged': [], 'adjudication-assigned': [], 'adjudication-assignment-claimed': [], 'adjudication-accepted': [], 'planning-contradiction-accepted': [], 'migration-recovery-attached': ['run','sessions','run_version'], 'migration-recovery-resolved': ['edit_leases','acquisition_groups'],
    });
    const sections = map[eventType];
    if (sections === undefined) throw new CoordinationRuntimeError('invalid-state', `semantic-graph-transition-invalid: event ${eventType} has no closed D65 successor handler`);
    return new Set(sections);
  }

  #d65AcceptedHistory(repoId: string, coveredEventSeq: number, afterEventSeq = 0): readonly D65AcceptedEventResultJoin[] {
    if (!Number.isSafeInteger(afterEventSeq) || afterEventSeq < 0 || afterEventSeq > coveredEventSeq) throw new CoordinationRuntimeError('store-corrupt', 'D65 accepted history range is invalid', [String(afterEventSeq), String(coveredEventSeq)]);
    const rows = this.#db.prepare(
      'SELECT e.repo_id,e.event_seq,e.event_type,e.entity_type,e.entity_id,e.idempotency_key,e.request_sha256,r.repo_id AS result_repo_id,r.idempotency_key AS result_idempotency_key,r.request_sha256 AS result_request_sha256,r.committed_event_seq AS result_event_seq,r.payload_json AS result_payload_json FROM events e LEFT JOIN idempotency_results r ON r.repo_id=e.repo_id AND r.idempotency_key=e.idempotency_key WHERE e.repo_id=? AND e.event_seq>? AND e.event_seq<=? ORDER BY e.event_seq',
    ).all(repoId, afterEventSeq, coveredEventSeq);
    return Object.freeze(rows.map((raw) => {
      const row = asRow(raw, 'D65 accepted event history');
      const resultRepo = sqlNullableString(row, 'result_repo_id');
      const resultKey = sqlNullableString(row, 'result_idempotency_key');
      const resultRequest = sqlNullableString(row, 'result_request_sha256');
      const resultSequence = sqlNullableInteger(row, 'result_event_seq');
      const resultPayload = sqlNullableString(row, 'result_payload_json');
      const result = resultRepo === null || resultKey === null || resultRequest === null || resultSequence === null || resultPayload === null ? null : Object.freeze({ repo_id: resultRepo, idempotency_key: resultKey, request_sha256: resultRequest, committed_event_seq: resultSequence, payload: parseJsonObject(resultPayload, 'D65 accepted event result') });
      return Object.freeze({ repo_id: sqlString(row, 'repo_id'), event_seq: sqlInteger(row, 'event_seq'), event_type: sqlString(row, 'event_type'), entity_type: sqlString(row, 'entity_type'), entity_id: sqlString(row, 'entity_id'), idempotency_key: sqlString(row, 'idempotency_key'), request_sha256: sqlString(row, 'request_sha256'), result });
    }));
  }

  /** Exact event/result history used to compute semantic session/child versions. */
  #d65SemanticHistory(repoId: string, workstreamRun: string, coveredEventSeq: number): readonly D65AcceptedEventResultJoin[] {
    const rows = this.#db.prepare(
      "SELECT e.repo_id,e.event_seq,e.event_type,e.entity_type,e.entity_id,e.idempotency_key,e.request_sha256,r.repo_id AS result_repo_id,r.idempotency_key AS result_idempotency_key,r.request_sha256 AS result_request_sha256,r.committed_event_seq AS result_event_seq,r.payload_json AS result_payload_json FROM events e LEFT JOIN idempotency_results r ON r.repo_id=e.repo_id AND r.idempotency_key=e.idempotency_key WHERE e.repo_id=? AND e.event_seq<=? AND ((e.event_type='session-heartbeat' AND e.entity_id IN (SELECT session_lease_id FROM session_leases WHERE repo_id=? AND workstream_run=?)) OR (e.event_type='child-heartbeat' AND e.entity_id IN (SELECT child_lease_id FROM child_leases WHERE repo_id=? AND workstream_run=?)) OR (e.event_type='program-heartbeat-accepted' AND e.entity_id=?)) ORDER BY e.event_seq",
    ).all(repoId, coveredEventSeq, repoId, workstreamRun, repoId, workstreamRun, workstreamRun);
    return Object.freeze(rows.map((raw) => {
      const row = asRow(raw, 'D65 semantic event history');
      const resultRepo = sqlNullableString(row, 'result_repo_id');
      const resultKey = sqlNullableString(row, 'result_idempotency_key');
      const resultRequest = sqlNullableString(row, 'result_request_sha256');
      const resultSequence = sqlNullableInteger(row, 'result_event_seq');
      const resultPayload = sqlNullableString(row, 'result_payload_json');
      const result = resultRepo === null || resultKey === null || resultRequest === null || resultSequence === null || resultPayload === null
        ? null
        : Object.freeze({ repo_id: resultRepo, idempotency_key: resultKey, request_sha256: resultRequest, committed_event_seq: resultSequence, payload: parseJsonObject(resultPayload, 'D65 semantic idempotency result') });
      return Object.freeze({ repo_id: sqlString(row, 'repo_id'), event_seq: sqlInteger(row, 'event_seq'), event_type: sqlString(row, 'event_type'), entity_type: sqlString(row, 'entity_type'), entity_id: sqlString(row, 'entity_id'), idempotency_key: sqlString(row, 'idempotency_key'), request_sha256: sqlString(row, 'request_sha256'), result });
    }));
  }

  /**
   * Derive an attempt's immutable `consumed_probe` projection from its unique
   * `unit-attempt-registered` event/result, revalidated against the registered
   * probe bytes. Null for every non-probe registration (fresh plan §2.3).
   */
  #d65ConsumedProbeProjection(repoId: string, attempt: CoordinationUnitAttempt): D65AttemptProjection['consumed_probe'] {
    const entityId = unitAttemptEntityId(attempt.owner);
    const rows = this.#db.prepare("SELECT e.event_seq, r.payload_json FROM events e JOIN idempotency_results r ON r.repo_id=e.repo_id AND r.idempotency_key=e.idempotency_key WHERE e.repo_id=? AND e.event_type='unit-attempt-registered' AND e.entity_id=? ORDER BY e.event_seq").all(repoId, entityId);
    if (rows.length === 0) return null;
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) throw new CoordinationRuntimeError('store-corrupt', 'unit attempt has more than one immutable registration event', [entityId]);
    const payload = parseJsonObject(sqlString(asRow(row, 'attempt registration result'), 'payload_json'), 'attempt registration result');
    const artifactId = payload['consumed_probe_artifact_id'];
    if (artifactId === undefined) return null;
    if (typeof artifactId !== 'string') throw new CoordinationRuntimeError('store-corrupt', 'attempt registration consumption artifact id is malformed', [entityId]);
    const artifact = authoritativeArtifactFromRow(asRow(this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(repoId, artifactId), 'consumed probe artifact'));
    const probe = parseD65SubscriptionProbe(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(repoId, artifact.evidence)), 'consumed probe bytes'));
    if (payload['consumed_probe_sha256'] !== artifact.evidence.sha256 || payload['consumed_probe_sequence'] !== probe.probe_sequence || payload['consumed_probe_provider'] !== probe.provider || payload['consumed_probe_trigger_continuation_sha256'] !== probe.trigger_continuation_sha256) throw new CoordinationRuntimeError('store-corrupt', 'attempt registration consumption tuple diverges from the registered probe bytes', [entityId, artifactId]);
    const coordinatorTime = payload['consumed_probe_coordinator_time'];
    if (typeof coordinatorTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(coordinatorTime) || !(Date.parse(probe.issued_at) <= Date.parse(coordinatorTime) && Date.parse(coordinatorTime) < Date.parse(probe.expires_at))) throw new CoordinationRuntimeError('store-corrupt', 'attempt registration consumption coordinator time is missing or outside the signed probe window', [entityId, String(coordinatorTime)]);
    return Object.freeze({ artifact_id: artifactId, sha256: artifact.evidence.sha256, probe_sequence: probe.probe_sequence, provider: probe.provider, trigger_continuation_sha256: probe.trigger_continuation_sha256, consumption_event_seq: sqlInteger(asRow(row, 'attempt registration event'), 'event_seq') });
  }

  /** Reconstruct committed coordinator state at E through the exact frozen row parsers. */
  #d65CoordinatorProjectionAt(repoId: string, workstreamRun: string, coveredEventSeq: number, futureGraphArtifactId: string | null = null): D65CoordinatorProjectionSnapshot {
    const repositorySequence = sqlInteger(asRow(this.#db.prepare('SELECT event_seq FROM repositories WHERE repo_id=?').get(repoId), 'D65 coordinator projection repository'), 'event_seq');
    if (repositorySequence !== coveredEventSeq) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-projection-mismatch: committed repository sequence is not the requested E boundary', [String(repositorySequence), String(coveredEventSeq)]);
    const run = this.#requireRun(repoId, workstreamRun);
    const resourceRows = this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').all(repoId, workstreamRun);
    if (resourceRows.length !== 1 || resourceRows[0] === undefined) throw new CoordinationRuntimeError('store-corrupt', 'D65 coordinator projection requires exactly one run resource', [`count=${String(resourceRows.length)}`]);
    const resource = runResourceFromRow(resourceRows[0]);
    const semanticCounts = computeD65SemanticVersionCounts(this.#d65SemanticHistory(repoId, workstreamRun, coveredEventSeq), coveredEventSeq);
    const sessions = this.#db.prepare('SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? ORDER BY session_lease_id').all(repoId, workstreamRun).map((row) => {
      const session = sessionFromRow(row);
      return projectD65SessionLease(session, semanticCounts.sessionPureLeaseEvents.get(session.session_lease_id) ?? 0);
    });
    const children = this.#db.prepare('SELECT * FROM child_leases WHERE repo_id=? AND workstream_run=? ORDER BY child_lease_id').all(repoId, workstreamRun).map((row) => {
      const child = childFromRow(row);
      return projectD65ChildLease(child, semanticCounts.childPureLeaseEvents.get(child.child_lease_id) ?? 0);
    });
    const attempts: readonly D65AttemptProjection[] = Object.freeze(this.#db.prepare('SELECT * FROM unit_attempts WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map((row) => {
      const attempt = unitAttemptFromRow(row);
      return Object.freeze({ attempt, consumed_probe: this.#d65ConsumedProbeProjection(repoId, attempt) });
    }));
    const faults = this.#db.prepare('SELECT * FROM run_scoped_faults WHERE repo_id=? AND workstream_run=? ORDER BY fault_id').all(repoId, workstreamRun).map(runScopedFaultFromRow);
    const reservations = this.#db.prepare('SELECT * FROM change_reservations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(changeReservationFromRow);
    const editLeases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(editLeaseFromRow);
    const acquisitionGroups = this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(acquisitionGroupFromRow);
    const worktrees = this.#db.prepare('SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND is_current_canonical=1 ORDER BY canonical_worktree_id').all(repoId, workstreamRun).map(canonicalWorktreeFromRow);
    const operations = this.#db.prepare('SELECT * FROM worktree_operations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(worktreeOperationFromRow);
    const terminalIntents = this.#db.prepare('SELECT payload_json FROM run_terminal_intents WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map((row) => {
      const value = parseJsonObject(sqlString(row, 'payload_json'), 'D65 terminal intent projection');
      return value['schema_version'] === 'autopilot.run_terminal_intent.v2' ? parseD65RunTerminalIntentV2(value) : parseCoordinationRunTerminalIntent(value);
    });
    const currentIntents = terminalIntents.filter((intent) => intent.state === 'prepared' || intent.state === 'committed');
    if (currentIntents.length > 1) throw new CoordinationRuntimeError('store-corrupt', 'D65 coordinator projection has more than one current terminal intent');
    const artifacts = this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(authoritativeArtifactFromRow).filter((artifact) => artifact.artifact_id !== futureGraphArtifactId);
    return Object.freeze({ run, resource, sessions: Object.freeze(sessions), children: Object.freeze(children), attempts, faults: Object.freeze(faults), reservations: Object.freeze(reservations), edit_leases: Object.freeze(editLeases), acquisition_groups: Object.freeze(acquisitionGroups), worktrees: Object.freeze(worktrees), operations: Object.freeze(operations), terminal_intents: Object.freeze(terminalIntents), current_terminal_intent_id: currentIntents[0]?.terminal_intent_id ?? null, authoritative_artifacts: Object.freeze(artifacts), covered_event_seq: coveredEventSeq, run_version: run.version });
  }

  #d65GraphAuthorityReader(sourceRoot: string, authorityCommit: string): D65GraphAuthorityReader {
    const listing = this.#gitQueryResult(sourceRoot, { kind: 'ls-tree-recursive', revision: authorityCommit, includeSize: false }, 'invalid-request', 'semantic graph authority recursive tree inspection failed');
    let decoded: string;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(listing.stdout); }
    catch (error) { throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-discovery-mismatch: authority tree contains a non-UTF-8 path', [error instanceof Error ? error.message : String(error)]); }
    const entries: D65GraphTreeLeaf[] = decoded.split('\0').filter((record) => record.length > 0).map((record) => {
      const tab = record.indexOf('\t');
      const metadata = tab < 0 ? [] : record.slice(0, tab).split(/\s+/u);
      const ref = tab < 0 ? '' : record.slice(tab + 1);
      const mode = metadata[0];
      const type = metadata[1];
      const oid = metadata[2];
      if ((mode !== '100644' && mode !== '100755' && mode !== '120000' && mode !== '160000') || (type !== 'blob' && type !== 'commit') || oid === undefined || !/^[a-f0-9]{40}$/u.test(oid) || ref.length === 0) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-discovery-mismatch: recursive authority tree row is malformed', [record]);
      return Object.freeze({ ref, mode, type, oid });
    });
    const byRef = new Map(entries.map((entry) => [entry.ref, entry] as const));
    return Object.freeze({
      entries: Object.freeze(entries),
      readBlob: (ref: string): Uint8Array => {
        const entry = byRef.get(ref);
        if (entry === undefined || entry.type !== 'blob') throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-discovery-mismatch: requested authority ref is not one listed blob', [ref]);
        return this.#gitQueryResult(sourceRoot, { kind: 'show-file', revision: authorityCommit, path: ref }, 'invalid-request', 'semantic graph authority blob is not readable at G').stdout;
      },
    });
  }

  #assertD65RegularGitBlob(sourceRoot: string, revision: string, ref: string, expectedOid: string | null, label: string): string {
    const listing = this.#gitQueryResult(sourceRoot, { kind: 'ls-tree-path', revision, path: ref }, 'invalid-request', `${label} Git tree inspection failed`);
    const records = new TextDecoder('utf-8', { fatal: true }).decode(listing.stdout).split('\0').filter((record) => record.length > 0);
    const record = records[0];
    if (records.length !== 1 || record === undefined) throw new CoordinationRuntimeError('invalid-request', `${label} must resolve to exactly one Git tree entry`, [ref]);
    const tab = record.indexOf('\t');
    const metadata = tab < 0 ? [] : record.slice(0, tab).split(/\s+/u);
    const listedPath = tab < 0 ? '' : record.slice(tab + 1);
    const mode = metadata[0];
    const type = metadata[1];
    const oid = metadata[2];
    if (mode !== '100644' || type !== 'blob' || oid === undefined || !/^[0-9a-f]{40}$/u.test(oid) || listedPath !== ref || expectedOid !== null && oid !== expectedOid) throw new CoordinationRuntimeError('invalid-request', `${label} must be the exact mode-100644 regular Git blob`, [ref, record]);
    return oid;
  }

  // Read one repository-relative graph shard blob at the exact publication commit
  // H for the loader/replayer. The blob must be a regular blob at H and within
  // the immutable evidence byte bound; absence or a non-blob path fails loudly.
  #readD65GraphShardBlob(sourceRoot: string, publicationCommit: string, ref: string): Uint8Array {
    this.#assertD65RegularGitBlob(sourceRoot, publicationCommit, ref, null, 'semantic graph shard');
    const shown = this.#gitQueryResult(sourceRoot, { kind: 'show-file', revision: publicationCommit, path: ref }, 'invalid-request', 'semantic graph shard blob is not readable at the publication commit');
    if (shown.stdout.byteLength > MAX_COORDINATION_EVIDENCE_BYTES) throw new CoordinationRuntimeError('invalid-request', 'semantic graph shard blob exceeds the immutable evidence byte bound', [ref]);
    return shown.stdout;
  }

  #validateD65GraphAuthority(sourceRoot: string, authorityCommit: string, graph: { readonly covered_authority_tree: string; readonly core: { readonly mission: { readonly ref: string; readonly git_blob_oid: string; readonly sha256: `sha256:${string}`; readonly byte_count: number }; readonly master_plan: { readonly ref: string; readonly git_blob_oid: string; readonly sha256: `sha256:${string}`; readonly byte_count: number }; readonly state: { readonly ref: string; readonly git_blob_oid: string; readonly sha256: `sha256:${string}`; readonly byte_count: number }; readonly decision_log: { readonly ref: string; readonly git_blob_oid: string; readonly sha256: `sha256:${string}`; readonly byte_count: number }; readonly events: { readonly ref: string; readonly git_blob_oid: string; readonly sha256: `sha256:${string}`; readonly byte_count: number } }; readonly queue_projection: Parameters<typeof assertD65QueueProjectionCounts>[0]['indexes'] }): AutopilotState {
    // covered_authority_tree must equal the actual tree of G.
    const actualTree = this.#gitQueryText(sourceRoot, { kind: 'resolve-tree', revision: authorityCommit }, 'invalid-request', 'semantic graph authority tree inspection failed');
    if (actualTree !== graph.covered_authority_tree) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: covered_authority_tree does not match the authority commit tree', [String(actualTree), graph.covered_authority_tree]);
    // Verify each of the five fixed core authority blobs at G.
    const coreBlobs = [graph.core.mission, graph.core.master_plan, graph.core.state, graph.core.decision_log, graph.core.events] as const;
    for (const entry of coreBlobs) {
      this.#assertD65RegularGitBlob(sourceRoot, authorityCommit, entry.ref, entry.git_blob_oid, 'semantic graph authority core');
      const shown = this.#gitQueryResult(sourceRoot, { kind: 'show-file', revision: authorityCommit, path: entry.ref }, 'invalid-request', 'semantic graph authority core blob is not readable at the covered authority commit');
      if (shown.stdout.byteLength > MAX_COORDINATION_EVIDENCE_BYTES) throw new CoordinationRuntimeError('invalid-request', 'semantic graph authority core blob exceeds the immutable evidence byte bound', [entry.ref]);
      if (shown.stdout.byteLength !== entry.byte_count) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: core descriptor byte_count does not match the authority blob', [entry.ref, `bytes=${String(shown.stdout.byteLength)}`]);
      const actual = `sha256:${createHash('sha256').update(shown.stdout).digest('hex')}`;
      if (actual !== entry.sha256) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: core descriptor sha256 does not match the authority blob', [entry.ref]);
    }
    // Prove the queue projection index COUNTS against the authority state blob.
    // Full MEMBER identity equality is proven by the loader/replayer once the
    // projection shards are loaded from the publication commit.
    const stateShown = this.#gitQueryResult(sourceRoot, { kind: 'show-file', revision: authorityCommit, path: graph.core.state.ref }, 'invalid-request', 'semantic graph authority state blob is not readable at the covered authority commit');
    const state = parseAutopilotState(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(stateShown.stdout), 'semantic graph authority state'));
    assertD65QueueProjectionCounts({ state, indexes: graph.queue_projection });
    return state;
  }

  #d65PriorIntentChain(repoId: string, workstreamRun: string): { readonly attempts: readonly D65RunTerminalIntentV2[] } {
    const rows = this.#db.prepare("SELECT payload_json FROM run_terminal_intents WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.schema_version')='autopilot.run_terminal_intent.v2' ORDER BY json_extract(payload_json, '$.intent_attempt')").all(repoId, workstreamRun);
    const attempts = rows.map((row) => parseD65RunTerminalIntentV2(parseJsonObject(sqlString(row, 'payload_json'), 'run terminal intent v2')));
    return { attempts };
  }

  cancelRunTerminal(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const rawRow = asRow(this.#db.prepare('SELECT * FROM run_terminal_intents WHERE repo_id=? AND entity_id=?').get(request.repo_id, payloadString(request.payload, 'terminal_intent_id')), 'run terminal intent');
      const rawPayload = parseJsonObject(sqlString(rawRow, 'payload_json'), 'run terminal intent');
      if (rawPayload['schema_version'] === 'autopilot.run_terminal_intent.v2') {
        return this.#applyD65CancelTerminalIntentV2(request, parseD65RunTerminalIntentV2(rawPayload));
      }
      const intent = runTerminalIntentFromRow(rawRow);
      if (intent.workstream_run !== this.#workstreamRun(request)) throw new CoordinationRuntimeError('unauthorized-client', 'session cannot cancel a foreign run terminal intent');
      const run = this.#requireRun(request.repo_id, intent.workstream_run);
      this.#assertVersion(intent.version, request.expected_version, 'run terminal intent');
      if (intent.state !== 'prepared') throw new CoordinationRuntimeError('invalid-state', `run terminal intent is ${intent.state}`);
      const seq = this.#nextEventSequence(request.repo_id);
      const cancelled = parseCoordinationRunTerminalIntent({ ...intent, state: 'cancelled', terminal_event_seq: seq, version: intent.version + 1 });
      const nextRun = parseCoordinationRun({ ...run, status: 'blocked', version: run.version + 1 });
      this.#db.prepare('UPDATE run_terminal_intents SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(cancelled), cancelled.version, cancelled.terminal_intent_id);
      this.#db.prepare("UPDATE runs SET status='blocked', version=? WHERE repo_id=? AND workstream_run=?").run(nextRun.version, run.repo_id, run.workstream_run);
      return { sequence: seq, eventType: 'run-terminal-cancelled', entityType: 'run-terminal-intent', entityId: cancelled.terminal_intent_id, payload: { run_terminal_intent: cancelled, run: nextRun, reason: payloadString(request.payload, 'reason') } };
    });
  }

  // D65-A3: cancelling a prepared v2 intent increments intent+run versions by
  // one, moves the run merging->active, and preserves the append-only row.
  // Attempt 4 (mandatory abort) cannot cancel.
  #applyD65CancelTerminalIntentV2(request: CoordinatorRequestEnvelope, intent: D65RunTerminalIntentV2): { readonly sequence: number; readonly eventType: string; readonly entityType: string; readonly entityId: string; readonly payload: Readonly<Record<string, unknown>> } {
    if (intent.workstream_run !== this.#workstreamRun(request)) throw new CoordinationRuntimeError('unauthorized-client', 'session cannot cancel a foreign run terminal intent');
    const run = this.#requireRun(request.repo_id, intent.workstream_run);
    this.#assertVersion(intent.version, request.expected_version, 'run terminal intent');
    if (intent.state !== 'prepared') throw new CoordinationRuntimeError('invalid-state', `run terminal intent is ${intent.state}`);
    // D65-I4: `cancel-run-terminal` is frozen recovery cell #8. The pure
    // `recoveryTransitionAllowed` predicate is the authoritative cancellability
    // gate at this coordinator transaction boundary (fresh plan §2.3 line
    // 183: "Recovery actions call only the table predicate at their coordinator
    // transaction boundary"). A D65 run with a prepared terminal intent is
    // definitionally in the terminal tail (its prepare moved it active->merging),
    // so the run's D65 dispatch reason is exactly `terminal-tail`; no provider
    // reason is tracked yet, so the store faithfully asserts the no-provider
    // subset the cell tolerates. `terminal_prepared_cancellable` is false for the
    // mandatory fourth abort, which is exactly the frozen non-cancellable case.
    const cancellable = !(intent.outcome === 'aborted' && intent.intent_attempt === 4);
    const verdict = recoveryTransitionAllowed({
      action: 'cancel-run-terminal',
      global_stop_reasons: [],
      row_stop_reasons: ['terminal-tail'],
      run_state: run.status,
      graph: { complete_graph_current: false, graph_publication_pending: false },
      policy: { policy_current: false },
      heartbeat: { governing_heartbeat_current: false, provider_state: 'blocked' },
      bindings: { attached_session_current: true, policy_trust_current: true, no_pending_publication: true, terminal_prepared_cancellable: cancellable, terminal_after_commit: false, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false },
    });
    if (!verdict.allowed) throw new CoordinationRuntimeError('invalid-state', 'the mandatory fourth abort intent is noncancellable: cancel-run-terminal is fenced by the D65 recovery predicate', verdict.denied_by.slice());
    this.#assertD65RecoveryMutationAllowed(request, run, 'cancel-run-terminal', { attached_session_current: true, policy_trust_current: true, no_pending_publication: true, terminal_prepared_cancellable: cancellable, terminal_after_commit: false, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false });
    const seq = this.#nextEventSequence(request.repo_id);
    const cancelled = parseD65RunTerminalIntentV2({ ...intent, state: 'cancelled', terminal_event_seq: seq, version: intent.version + 1 });
    const nextRun = parseCoordinationRun({ ...run, status: 'active', version: run.version + 1 });
    this.#db.prepare('UPDATE run_terminal_intents SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(cancelled), cancelled.version, cancelled.terminal_intent_id);
    this.#db.prepare("UPDATE runs SET status='active', version=? WHERE repo_id=? AND workstream_run=?").run(nextRun.version, run.repo_id, run.workstream_run);
    return { sequence: seq, eventType: 'run-terminal-cancelled', entityType: 'run-terminal-intent', entityId: cancelled.terminal_intent_id, payload: { run_terminal_intent: Object.freeze({ ...cancelled }), run: nextRun, reason: payloadString(request.payload, 'reason') } };
  }

  reconcileRun(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const workstreamRun = this.#workstreamRun(request);
      const run = this.#requireRun(request.repo_id, workstreamRun);
      this.#assertVersion(run.version, request.expected_version, 'run');
      this.#assertD65MaintenanceMutationAllowed(request, run, 'reconcile-run');
      this.#assertAuthorityCriticalMutationAllowed(run.repo_id, run.workstream_run, 'run authority reconciliation');
      const seq = this.#nextEventSequence(request.repo_id);
      const reconciliation = this.#reconcileOwnedRun(request.repo_id, workstreamRun, seq);
      const reconciliationReceipt = this.#persistReconciliationReceipt(request.repo_id, workstreamRun, request.action, seq, reconciliation);
      return { sequence: seq, eventType: 'run-reconciled', entityType: 'run', entityId: workstreamRun, payload: { run, ...this.#reconciliationReceiptPayload(reconciliationReceipt), reason: payloadString(request.payload, 'reason') } };
    });
  }

  drainMailbox(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#sessionMutation(request, 'mailbox-drained', (session, seq) => {
      const workstreamRun = this.#workstreamRun(request);
      const run = this.#requireRun(request.repo_id, workstreamRun);
      this.#assertD65MaintenanceMutationAllowed(request, run, 'drain-mailbox');
      const deliveryId = payloadString(request.payload, 'delivery_id');
      const cursorValue = request.payload['cursor'];
      const existingRow = this.#db.prepare('SELECT * FROM mailbox_deliveries WHERE delivery_id=?').get(deliveryId);
      let delivery: CoordinationMailboxDeliveryReceipt;
      if (existingRow === undefined) {
        if (cursorValue !== undefined && cursorValue !== null) throw new CoordinationRuntimeError('invalid-request', 'new mailbox delivery cannot begin from a continuation cursor');
        const emptyDigest = `sha256:${createHash('sha256').update('[]', 'utf8').digest('hex')}`;
        delivery = parseCoordinationMailboxDeliveryReceipt({
          schema_version: 'autopilot.mailbox_delivery_receipt.v1', delivery_id: deliveryId, repo_id: request.repo_id, workstream_run: workstreamRun,
          session_lease_id: session.session_lease_id, snapshot_through_event_seq: 0, message_count: 0, message_ids_sha256: emptyDigest, completed: false, version: 1,
        });
        this.#db.prepare('INSERT INTO mailbox_deliveries(delivery_id, repo_id, workstream_run, session_lease_id, snapshot_through_event_seq, next_ordinal, payload_json, version) VALUES(?, ?, ?, ?, 0, 0, ?, ?)').run(delivery.delivery_id, delivery.repo_id, delivery.workstream_run, delivery.session_lease_id, canonicalJson(delivery), delivery.version);
        const insertItem = this.#db.prepare('INSERT INTO mailbox_delivery_items(delivery_id, ordinal, message_id, snapshot_delivered_event_seq, snapshot_message_version) VALUES(?, ?, ?, ?, ?)');
        const membershipHash = createHash('sha256');
        membershipHash.update('[', 'utf8');
        let messageCount = 0;
        let snapshotThrough = 0;
        for (const row of this.#db.prepare("SELECT * FROM messages WHERE repo_id=? AND recipient_workstream_run=? AND status!='acknowledged' ORDER BY created_event_seq, message_id").iterate(request.repo_id, workstreamRun)) {
          const message = messageFromRow(row);
          messageCount += 1;
          snapshotThrough = Math.max(snapshotThrough, message.created_event_seq);
          if (messageCount > 1) membershipHash.update(',', 'utf8');
          membershipHash.update(JSON.stringify(message.message_id), 'utf8');
          const projected = message.status === 'pending' ? parseCoordinationMessage({ ...message, status: 'delivered', delivered_event_seq: seq, version: message.version + 1 }) : message;
          if (projected.delivered_event_seq === null) throw new CoordinationRuntimeError('store-corrupt', 'mailbox delivery projection lacks its exact delivery event sequence', [projected.message_id]);
          insertItem.run(delivery.delivery_id, messageCount, message.message_id, projected.delivered_event_seq, projected.version);
        }
        membershipHash.update(']', 'utf8');
        delivery = parseCoordinationMailboxDeliveryReceipt({ ...delivery, snapshot_through_event_seq: snapshotThrough, message_count: messageCount, message_ids_sha256: `sha256:${membershipHash.digest('hex')}`, completed: messageCount === 0 });
        this.#db.prepare('UPDATE mailbox_deliveries SET snapshot_through_event_seq=?, payload_json=? WHERE delivery_id=?').run(snapshotThrough, canonicalJson(delivery), delivery.delivery_id);
      } else {
        delivery = mailboxDeliveryFromRow(existingRow);
        if (delivery.repo_id !== request.repo_id || delivery.workstream_run !== workstreamRun || delivery.session_lease_id !== session.session_lease_id) throw new CoordinationRuntimeError('unauthorized-client', 'mailbox delivery continuation belongs to a different attached session');
        if (cursorValue === undefined || cursorValue === null) throw new CoordinationRuntimeError('idempotency-conflict', 'mailbox delivery id was reused without its original idempotency key or continuation cursor', [deliveryId]);
        if (delivery.completed) throw new CoordinationRuntimeError('invalid-state', 'completed mailbox delivery cannot accept another continuation page', [deliveryId]);
      }
      const scopeSha256 = paginationScope(['mailbox-delivery', request.repo_id, workstreamRun, session.session_lease_id, deliveryId]);
      const offset = cursorValue === undefined || cursorValue === null
        ? 0
        : typeof cursorValue === 'string'
          ? parsePaginationCursor(cursorValue, { kind: 'mailbox-delivery', scopeSha256, revisionSha256: delivery.message_ids_sha256, section: deliveryId })
          : (() => { throw new CoordinationRuntimeError('invalid-request', 'mailbox delivery cursor must be bounded opaque text'); })();
      const durableNextOrdinal = sqlInteger(asRow(this.#db.prepare('SELECT next_ordinal FROM mailbox_deliveries WHERE delivery_id=?').get(deliveryId), 'mailbox delivery progress'), 'next_ordinal');
      if (offset !== durableNextOrdinal) throw new CoordinationRuntimeError('stale-version', 'mailbox delivery continuation does not match its exact durable next ordinal', [deliveryId, `expected=${String(durableNextOrdinal)}`, `actual=${String(offset)}`]);
      const projected = this.#db.prepare('SELECT messages.*, mailbox_delivery_items.snapshot_delivered_event_seq, mailbox_delivery_items.snapshot_message_version FROM mailbox_delivery_items JOIN messages ON messages.message_id=mailbox_delivery_items.message_id WHERE mailbox_delivery_items.delivery_id=? AND mailbox_delivery_items.ordinal>? ORDER BY mailbox_delivery_items.ordinal LIMIT 1025').all(deliveryId, offset).map((row) => {
        const current = messageFromRow(row);
        return parseCoordinationMessage({ ...current, status: 'delivered', delivered_event_seq: sqlInteger(row, 'snapshot_delivered_event_seq'), acknowledged_event_seq: null, version: sqlInteger(row, 'snapshot_message_version') });
      });
      const cursorForOffset = (localOffset: number): string => encodePaginationCursor({ kind: 'mailbox-delivery', scopeSha256, revisionSha256: delivery.message_ids_sha256, section: deliveryId, offset: offset + localOffset });
      const payloadForPage = (items: readonly CoordinationMessage[], nextCursor: string | null): Readonly<Record<string, unknown>> => ({ delivery_receipt: delivery, session_version: session.version, mailbox_cursor: this.#requireMailboxCursor(request.repo_id, workstreamRun), messages: items, next_cursor: nextCursor });
      const page = byteBudgetPage({ items: projected, offset: 0, cursorForOffset, payloadForPage });
      for (const message of page.items) {
        if (message.status === 'delivered') this.#db.prepare("UPDATE messages SET status='delivered', delivered_event_seq=COALESCE(delivered_event_seq, ?), version=? WHERE message_id=? AND status='pending'").run(seq, message.version, message.message_id);
        if (message.message_type !== 'claim-request') continue;
        const claimRequest = this.#requireClaimRequest(message.correlation_id);
        if (claimRequest.status === 'pending') this.#updateClaimRequest({ ...claimRequest, status: 'delivered', version: claimRequest.version + 1 });
      }
      this.#advanceMailboxCursor(request.repo_id, workstreamRun, 'delivered');
      const nextOrdinal = offset + page.items.length;
      const finalPage = nextOrdinal === delivery.message_count;
      if (page.nextCursor === null !== finalPage) throw new CoordinationRuntimeError('store-corrupt', 'mailbox delivery pagination disagrees with its exact receipt count', [deliveryId]);
      if (finalPage) {
        const membershipHash = createHash('sha256');
        membershipHash.update('[', 'utf8');
        let count = 0;
        for (const row of this.#db.prepare('SELECT message_id FROM mailbox_delivery_items WHERE delivery_id=? ORDER BY ordinal').iterate(deliveryId)) {
          count += 1;
          if (count > 1) membershipHash.update(',', 'utf8');
          membershipHash.update(JSON.stringify(sqlString(row, 'message_id')), 'utf8');
        }
        membershipHash.update(']', 'utf8');
        if (count !== delivery.message_count || `sha256:${membershipHash.digest('hex')}` !== delivery.message_ids_sha256) throw new CoordinationRuntimeError('store-corrupt', 'mailbox delivery membership disagrees with its durable receipt', [deliveryId]);
      }
      if (finalPage && !delivery.completed) {
        delivery = parseCoordinationMailboxDeliveryReceipt({ ...delivery, completed: true, version: delivery.version + 1 });
        this.#db.prepare('UPDATE mailbox_deliveries SET next_ordinal=?, payload_json=?, version=? WHERE delivery_id=?').run(nextOrdinal, canonicalJson(delivery), delivery.version, delivery.delivery_id);
      } else this.#db.prepare('UPDATE mailbox_deliveries SET next_ordinal=? WHERE delivery_id=?').run(nextOrdinal, delivery.delivery_id);
      return { entityId: deliveryId, payload: { delivery_receipt: delivery, session_version: session.version, mailbox_cursor: this.#requireMailboxCursor(request.repo_id, workstreamRun), messages: page.items, next_cursor: page.nextCursor } };
    });
  }

  acknowledgeMessage(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const messageId = payloadString(request.payload, 'message_id');
      const message = messageFromRow(asRow(this.#db.prepare('SELECT * FROM messages WHERE message_id=?').get(messageId), 'message'));
      if (message.repo_id !== request.repo_id || message.recipient_workstream_run !== this.#workstreamRun(request)) throw new CoordinationRuntimeError('unauthorized-client', 'session does not own mailbox message');
      this.#assertVersion(message.version, request.expected_version, 'message');
      const run = this.#requireRun(request.repo_id, message.recipient_workstream_run);
      this.#assertD65MaintenanceMutationAllowed(request, run, 'acknowledge-message');
      if (message.status !== 'delivered') throw new CoordinationRuntimeError('invalid-state', `message is ${message.status}`);
      const seq = this.#nextEventSequence(request.repo_id);
      this.#db.prepare("UPDATE messages SET status='acknowledged', acknowledged_event_seq=?, version=version+1 WHERE message_id=?").run(seq, messageId);
      if (message.message_type === 'claim-request') {
        const claimRequest = this.#requireClaimRequest(message.correlation_id);
        if (claimRequest.status === 'delivered') this.#updateClaimRequest({ ...claimRequest, status: 'acknowledged', version: claimRequest.version + 1 });
      } else if (message.message_type === 'release-notification') {
        const claimRequest = this.#requireClaimRequest(message.correlation_id);
        if (claimRequest.status === 'released') this.#updateClaimRequest({ ...claimRequest, status: 'requester-notified', version: claimRequest.version + 1 });
      }
      this.#advanceMailboxCursor(request.repo_id, message.recipient_workstream_run, 'acknowledged');
      return { sequence: seq, eventType: 'message-acknowledged', entityType: 'message', entityId: messageId, payload: { message: messageFromRow(asRow(this.#db.prepare('SELECT * FROM messages WHERE message_id=?').get(messageId), 'acknowledged message')), mailbox_cursor: this.#requireMailboxCursor(request.repo_id, message.recipient_workstream_run) } };
    });
  }

  prepareOperation(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
      const worktree = parseCoordinationWorktree(request.payload['worktree']);
      const suppliedOperation = parseCoordinationWorktreeOperation(request.payload['operation']);
      const terminalIntent = this.#preparedTerminalIntent(run.repo_id, run.workstream_run);
      const d65 = this.#isD65Run(run.repo_id, run.workstream_run);
      if (d65 && run.status === 'merging' && terminalIntent !== null) throw new CoordinationRuntimeError('invalid-state', 'D65 prepared-terminal graph forbids product/worktree mutation before the terminal first effect');
      if (d65 && (run.status === 'closed' || run.status === 'aborted')) {
        this.#assertD65TerminalTailPrefix(run);
        this.#assertD65RecoveryMutationAllowed(request, run, 'terminal-tail', { attached_session_current: true, policy_trust_current: true, no_pending_publication: true, terminal_prepared_cancellable: false, terminal_after_commit: true, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false });
        if (worktree.kind !== 'main' || suppliedOperation.owner.unit_id !== 'main' || (suppliedOperation.operation_type !== 'archive' && suppliedOperation.operation_type !== 'remove')) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail permits only main archive/remove cleanup operations');
      } else {
        if (d65 && this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) {
          if (suppliedOperation.operation_type === 'reset' || suppliedOperation.operation_type === 'quarantine' || (suppliedOperation.operation_type === 'remove' && worktree.kind === 'unit')) this.#assertD65RecoveryMutationAllowed(request, run, 'unit-recovery', { attached_session_current: true, policy_trust_current: false, no_pending_publication: false, terminal_prepared_cancellable: false, terminal_after_commit: false, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false });
          else this.#assertD65OrdinaryMutationAllowed(request, run, 'prepare-operation');
        }
        this.#assertSourceChangingDispatchAllowed(run.repo_id, run.workstream_run, 'prepare-operation');
        if (terminalIntent !== null) {
          const terminalCloseOperation = terminalIntent.outcome === 'closed' && worktree.kind === 'main' && suppliedOperation.owner.unit_id === 'main' && suppliedOperation.operation_type === 'merge' && (suppliedOperation.intent.reason === 'integrate current target before close' || suppliedOperation.intent.reason === 'atomically fast-forward captured target to validated workstream');
          if (!terminalCloseOperation) throw new CoordinationRuntimeError('invalid-state', 'run terminal preparation fences non-terminal worktree operations');
        }
      }
      if (worktree.owner.repo_id !== request.repo_id || worktree.owner.workstream_run !== run.workstream_run || worktree.owner.autopilot_id !== run.autopilot_id) throw new CoordinationRuntimeError('unauthorized-client', 'worktree registration owner does not match the attached durable run');
      if (!sameOwner(worktree.owner, suppliedOperation.owner) || suppliedOperation.worktree_id !== worktree.worktree_id) throw new CoordinationRuntimeError('unauthorized-client', 'operation owner does not exactly match its worktree owner');
      if (suppliedOperation.stage !== 'prepared' || suppliedOperation.intent_event_seq !== 0 || suppliedOperation.version !== 1 || suppliedOperation.authority_version !== worktree.version || suppliedOperation.completed_steps.length !== 0 || suppliedOperation.current_step !== null || suppliedOperation.recovery_attempts !== 0 || suppliedOperation.verification_evidence !== null || suppliedOperation.error_code !== null) throw new CoordinationRuntimeError('invalid-request', 'new worktree operation must use the canonical prepared state');
      this.#assertWorktreeAuthority(worktree, suppliedOperation);
      const canonicalWorktreeId = deterministicWorktreeId(worktree.owner, worktree.kind);
      const operationKey = deriveWorktreeOperationKeyV2({ canonicalWorktreeId, operationType: suppliedOperation.operation_type, completeImmutableIntent: suppliedOperation.intent });
      const expectedOperationId = operationIdFromWorktreeOperationKey(operationKey);
      if (suppliedOperation.operation_id !== expectedOperationId || request.idempotency_key !== operationKey.operation_key_sha256) throw new CoordinationRuntimeError('invalid-request', 'new worktree operation identity must equal operation-key v2 for its canonical identity and complete immutable intent', [expectedOperationId, operationKey.operation_key_sha256]);
      const existingWorktreeRow = this.#db.prepare('SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND autopilot_id=? AND unit_id=? AND attempt=? AND kind=? AND is_current_canonical=1').get(worktree.owner.repo_id, worktree.owner.workstream_run, worktree.owner.autopilot_id, worktree.owner.unit_id, worktree.owner.attempt, worktree.kind);
      if (existingWorktreeRow === undefined) {
        if (worktree.worktree_id !== canonicalWorktreeId) throw new CoordinationRuntimeError('invalid-request', 'new worktree projection must use its deterministic canonical ID');
        if (request.expected_version !== 0) throw new CoordinationRuntimeError('stale-version', 'new worktree registration requires expected_version 0');
        this.#db.prepare('INSERT INTO worktrees(entity_id, repo_id, workstream_run, payload_json, version, canonical_worktree_id, autopilot_id, unit_id, attempt, kind, is_current_canonical) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(worktree.worktree_id, request.repo_id, run.workstream_run, canonicalJson(worktree), worktree.version, canonicalWorktreeId, worktree.owner.autopilot_id, worktree.owner.unit_id, worktree.owner.attempt, worktree.kind);
      } else {
        const existingWorktree = canonicalWorktreeFromRow(existingWorktreeRow);
        this.#assertVersion(existingWorktree.version, request.expected_version, 'worktree');
        if (canonicalJson(existingWorktree) !== canonicalJson(worktree)) throw new CoordinationRuntimeError('idempotency-conflict', 'canonical worktree identity was reused with different immutable authority');
      }
      if (this.#db.prepare('SELECT entity_id FROM worktree_operations WHERE entity_id=?').get(suppliedOperation.operation_id) !== undefined) throw new CoordinationRuntimeError('stale-version', 'worktree operation already exists; retry its original idempotency key or query status');
      const nonterminal = this.#db.prepare("SELECT * FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND canonical_worktree_id=? AND json_extract(payload_json, '$.stage') NOT IN ('committed','compensated','failed') LIMIT 1").get(request.repo_id, run.workstream_run, canonicalWorktreeId);
      if (nonterminal !== undefined) {
        const current = worktreeOperationFromRow(asRow(nonterminal, 'nonterminal worktree operation'));
        throw new CoordinationRuntimeError('coordinator-contention', 'worktree already has an incomplete owner operation', [current.operation_id, suppliedOperation.operation_id, canonicalJson(current.intent), canonicalJson(suppliedOperation.intent)]);
      }
      const seq = this.#nextEventSequence(request.repo_id);
      const operation: CoordinationWorktreeOperation = { ...suppliedOperation, intent_event_seq: seq };
      this.#db.prepare('INSERT INTO worktree_operations(entity_id, repo_id, workstream_run, payload_json, version, canonical_worktree_id) VALUES(?, ?, ?, ?, ?, ?)').run(operation.operation_id, request.repo_id, run.workstream_run, canonicalJson(operation), operation.version, canonicalWorktreeId);
      return { sequence: seq, eventType: 'worktree-operation-prepared', entityType: 'worktree-operation', entityId: operation.operation_id, payload: { worktree, operation } };
    });
  }

  transitionOperation(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const operationId = payloadString(request.payload, 'operation_id');
      const operationRow = asRow(this.#db.prepare('SELECT * FROM worktree_operations WHERE entity_id=?').get(operationId), 'worktree operation');
      const operation = worktreeOperationFromRow(operationRow);
      const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
      if (this.#isD65Run(run.repo_id, run.workstream_run) && (run.status === 'closed' || run.status === 'aborted')) {
        this.#assertD65TerminalTailPrefix(run);
        this.#assertD65RecoveryMutationAllowed(request, run, 'terminal-tail', { attached_session_current: true, policy_trust_current: true, no_pending_publication: true, terminal_prepared_cancellable: false, terminal_after_commit: true, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false });
        if (operation.owner.unit_id !== 'main' || (operation.operation_type !== 'archive' && operation.operation_type !== 'remove')) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail transition is not a main archive/remove cleanup operation');
      } else {
        if (this.#isD65Run(run.repo_id, run.workstream_run) && this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) {
          if (operation.operation_type === 'reset' || operation.operation_type === 'quarantine' || (operation.operation_type === 'remove' && operation.owner.unit_id !== 'main')) this.#assertD65RecoveryMutationAllowed(request, run, 'unit-recovery', { attached_session_current: true, policy_trust_current: false, no_pending_publication: false, terminal_prepared_cancellable: false, terminal_after_commit: false, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false });
          else this.#assertD65OrdinaryMutationAllowed(request, run, 'transition-operation');
        }
        this.#assertSourceChangingDispatchAllowed(request.repo_id, this.#workstreamRun(request), 'transition-operation');
      }
      if (operation.owner.repo_id !== request.repo_id || operation.owner.workstream_run !== this.#workstreamRun(request)) throw new CoordinationRuntimeError('unauthorized-client', 'session cannot transition a foreign-run worktree operation');
      this.#assertVersion(operation.version, request.expected_version, 'worktree operation');
      const canonicalWorktreeId = sqlString(operationRow, 'canonical_worktree_id');
      const worktreeRow = asRow(this.#db.prepare('SELECT * FROM worktrees WHERE repo_id=? AND canonical_worktree_id=? AND is_current_canonical=1').get(operation.owner.repo_id, canonicalWorktreeId), 'canonical worktree');
      const worktree = worktreeFromRow(worktreeRow);
      if (!sameOwner(worktree.owner, operation.owner)) throw new CoordinationRuntimeError('store-corrupt', 'worktree operation ownership changed');
      if (worktree.version !== operation.authority_version) throw new CoordinationRuntimeError('stale-version', 'worktree authority changed while its operation was incomplete');
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
      if (next.verification_evidence !== null && operation.verification_evidence === null) this.#verifyOperationEvidenceFile(next);
      const requestedWorktreeState = payloadString(request.payload, 'worktree_state');
      if (!(COORDINATION_WORKTREE_STATES as readonly string[]).includes(requestedWorktreeState)) throw new CoordinationRuntimeError('invalid-request', 'worktree_state is invalid');
      if (next.stage !== 'committed' && requestedWorktreeState !== worktree.state) throw new CoordinationRuntimeError('invalid-request', 'worktree state may change only when an operation commits');
      if (next.operation_type === 'metadata-reconcile' && requestedWorktreeState !== worktree.state) throw new CoordinationRuntimeError('invalid-request', 'metadata reconciliation cannot change worktree lifecycle state');
      if (next.stage === 'committed') this.#assertCommittedWorktreeState(next, requestedWorktreeState);
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

  resolveRunScopedFault(request: CoordinatorRequestEnvelope): IdempotentEffect {
    return this.#mutation(request, () => {
      this.#requireCurrentSession(request);
      const faultId = payloadString(request.payload, 'fault_id');
      const evidenceRef = payloadString(request.payload, 'resolution_evidence_ref');
      const evidenceSha256 = payloadString(request.payload, 'resolution_evidence_sha256');
      if (!SHA256_PATTERN.test(evidenceSha256)) throw new CoordinationRuntimeError('invalid-request', 'identity fault resolution evidence digest is invalid');
      const faultRow = asRow(this.#db.prepare('SELECT * FROM run_scoped_faults WHERE fault_id=?').get(faultId), 'run-scoped fault');
      const fault = runScopedFaultFromRow(faultRow);
      if (fault.repo_id !== request.repo_id || fault.workstream_run !== this.#workstreamRun(request)) throw new CoordinationRuntimeError('unauthorized-client', 'session cannot resolve a foreign run-scoped fault');
      this.#assertVersion(fault.version, request.expected_version, 'run-scoped fault');
      const run = this.#requireRun(fault.repo_id, fault.workstream_run);
      if (this.#hasD65CompleteGraph(run.repo_id, run.workstream_run)) this.#assertD65RecoveryMutationAllowed(request, run, 'unit-recovery', { attached_session_current: true, policy_trust_current: false, no_pending_publication: false, terminal_prepared_cancellable: false, terminal_after_commit: false, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false });
      if (fault.status !== 'active' || fault.invariant_id !== 'F3-SEMANTIC-UNIQUENESS' || fault.fault_code !== 'identity-recovery-pending' || fault.entity_type !== 'worktree') throw new CoordinationRuntimeError('invalid-state', 'only an active canonical semantic-uniqueness fault has a mechanical resolution path', [fault.fault_id, fault.status, fault.invariant_id]);
      const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(fault.repo_id), 'identity fault repository'));
      const expectedRef = `_saga-evidence/${fault.workstream_run}/identity-recovery/${fault.fault_id}.json`;
      if (evidenceRef !== expectedRef) throw new CoordinationRuntimeError('unauthorized-client', 'identity fault resolution evidence ref is not derived from its exact fault owner', [evidenceRef, expectedRef]);
      const evidenceRoot = resolve(this.#stateRoot, 'worktrees', repository.repo_key, '_saga-evidence', fault.workstream_run, 'identity-recovery');
      const evidencePath = resolve(this.#stateRoot, 'worktrees', repository.repo_key, evidenceRef);
      const relativeEvidence = relative(evidenceRoot, evidencePath);
      if (relativeEvidence.length === 0 || relativeEvidence === '..' || relativeEvidence.startsWith(`..${sep}`) || isAbsolute(relativeEvidence)) throw new CoordinationRuntimeError('unauthorized-client', 'identity fault resolution evidence escapes its run-owned root');
      let bytes: Uint8Array;
      try {
        const before = lstatSync(evidencePath);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 || before.size > MAX_COORDINATION_EVIDENCE_BYTES) throw new CoordinationRuntimeError('unauthorized-client', 'identity fault resolution evidence must be a bounded regular unaliased file', [evidencePath]);
        bytes = readFileSync(evidencePath);
        const after = lstatSync(evidencePath);
        if (before.dev !== after.dev || before.ino !== after.ino || after.nlink !== 1 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.byteLength !== before.size) throw new CoordinationRuntimeError('recovery-required', 'identity fault resolution evidence changed during verification', [evidencePath]);
      } catch (error) {
        if (error instanceof CoordinationRuntimeError) throw error;
        throw new CoordinationRuntimeError('recovery-required', 'identity fault resolution evidence is unreadable', [evidencePath, error instanceof Error ? error.message : String(error)]);
      }
      const actualSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (actualSha256 !== evidenceSha256) throw new CoordinationRuntimeError('invalid-state', 'identity fault resolution evidence digest differs from immutable request authority', [evidencePath, actualSha256, evidenceSha256]);
      let evidenceValue: unknown;
      try { evidenceValue = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown; }
      catch (error) { throw new CoordinationRuntimeError('invalid-state', 'identity fault resolution evidence is invalid JSON', [error instanceof Error ? error.message : String(error)]); }
      const evidence = parseIdentityFaultResolutionEvidence(evidenceValue);
      if (evidence.fault_id !== fault.fault_id || evidence.repo_id !== fault.repo_id || evidence.workstream_run !== fault.workstream_run || evidence.canonical_worktree_id !== fault.entity_id) throw new CoordinationRuntimeError('invalid-state', 'identity fault resolution evidence owner differs from the exact active fault');
      const detailCandidates = fault.detail['candidate_ids'];
      const detailCurrent = fault.detail['current_projection_id'];
      if (!Array.isArray(detailCandidates) || !detailCandidates.every((candidate) => typeof candidate === 'string') || typeof detailCurrent !== 'string'
        || canonicalJson([...detailCandidates].sort()) !== canonicalJson(evidence.candidate_worktree_ids)
        || detailCurrent !== evidence.selected_current_worktree_id) throw new CoordinationRuntimeError('invalid-state', 'identity fault resolution evidence differs from the frozen migration classification');
      const candidateRows = evidence.candidate_worktree_ids.map((worktreeId) => asRow(this.#db.prepare('SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND entity_id=?').get(fault.repo_id, fault.workstream_run, worktreeId), 'identity fault candidate worktree'));
      if (candidateRows.some((row) => sqlString(row, 'canonical_worktree_id') !== evidence.canonical_worktree_id)) throw new CoordinationRuntimeError('store-corrupt', 'identity fault candidate canonical indexes differ from their frozen resolution identity');
      const worktrees = candidateRows.map(worktreeFromRow);
      const selected = worktrees.find((worktree) => worktree.worktree_id === evidence.selected_current_worktree_id);
      if (selected === undefined || deterministicWorktreeId(selected.owner, selected.kind) !== evidence.canonical_worktree_id) throw new CoordinationRuntimeError('invalid-state', 'identity fault selected projection does not derive the exact canonical identity');
      const selectedRow = asRow(this.#db.prepare('SELECT is_current_canonical FROM worktrees WHERE entity_id=?').get(selected.worktree_id), 'identity fault selected projection');
      if (sqlInteger(selectedRow, 'is_current_canonical') !== 1 || worktrees.some((worktree) => !sameWorktreeAuthority(worktree, selected))) throw new CoordinationRuntimeError('invalid-state', 'identity fault candidates do not share the exact selected authority');
      const actualOperationRows = evidence.candidate_worktree_ids.map((worktreeId) => Object.freeze({
        worktree_id: worktreeId,
        operation_ids: Object.freeze(this.#db.prepare('SELECT entity_id FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, \'$.worktree_id\')=? ORDER BY entity_id').all(fault.repo_id, fault.workstream_run, worktreeId).map((row) => sqlString(row, 'entity_id'))),
      }));
      if (canonicalJson(actualOperationRows) !== canonicalJson(evidence.candidate_operation_ids)) throw new CoordinationRuntimeError('invalid-state', 'identity fault resolution evidence does not cover the exact immutable operation histories');
      let currentRegistrations: ReturnType<typeof gitWorktreeRegistrationFacts>;
      try { currentRegistrations = gitWorktreeRegistrationFacts(selected.git_common_dir); }
      catch (error) { throw new CoordinationRuntimeError('recovery-required', 'identity fault resolution could not inspect exact current Git registrations', [selected.git_common_dir, error instanceof Error ? error.message : String(error)]); }
      if (canonicalJson(currentRegistrations) !== canonicalJson(evidence.observed_registrations)) throw new CoordinationRuntimeError('recovery-required', 'identity fault resolution registration evidence drifted before commit', [selected.git_common_dir]);
      const registration = currentRegistrations.find((entry) => entry.worktree_path === selected.canonical_path && entry.branch_ref === `refs/heads/${selected.branch}`);
      const preservedBranch = evidence.preserved_refs.find((entry) => entry.ref === `refs/heads/${selected.branch}`);
      const currentBranchSha = this.#gitQueryText(selected.git_common_dir, { kind: 'resolve-commit', revision: `refs/heads/${selected.branch}` }, 'recovery-required', 'identity fault resolution branch-ref inspection failed');
      const expectedPreservedRefs = currentBranchSha === null ? [] : [{ ref: `refs/heads/${selected.branch}`, sha: currentBranchSha }];
      if (canonicalJson(evidence.preserved_refs) !== canonicalJson(expectedPreservedRefs) || registration === undefined || preservedBranch === undefined || registration.head_sha !== preservedBranch.sha || currentBranchSha !== preservedBranch.sha) throw new CoordinationRuntimeError('recovery-required', 'identity fault resolution lacks exact current Git registration and branch-ref agreement', [selected.canonical_path, selected.branch]);
      const seq = this.#nextEventSequence(fault.repo_id);
      const resolved = parseRunScopedLogicalFault({ ...fault, status: 'resolved', resolved_event_seq: seq, version: fault.version + 1 });
      return {
        sequence: seq,
        eventType: 'run-scoped-fault-resolved',
        entityType: 'run-scoped-fault',
        entityId: fault.fault_id,
        payload: { run_scoped_fault: resolved, identity_resolution: evidence, resolution_evidence: { ref: evidenceRef, sha256: evidenceSha256 } },
        afterEventInserted: () => {
          const updated = this.#db.prepare("UPDATE run_scoped_faults SET status='resolved',resolved_event_seq=?,version=version+1 WHERE fault_id=? AND status='active' AND version=?").run(seq, fault.fault_id, fault.version);
          if (updated.changes !== 1) throw new CoordinationRuntimeError('coordinator-contention', 'identity fault changed before its exact audited resolution commit', [fault.fault_id]);
        },
      };
    });
  }

  enqueueMessageForTest(message: CoordinationMessage): void {
    this.#writerGuard.assertHeld();
    const parsed = parseCoordinationMessage(message);
    this.#db.prepare('INSERT INTO messages(message_id, repo_id, recipient_workstream_run, message_type, correlation_id, payload_json, status, created_event_seq, delivered_event_seq, acknowledged_event_seq, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      parsed.message_id, parsed.repo_id, parsed.recipient_workstream_run, parsed.message_type, parsed.correlation_id, canonicalJson(parsed.payload), parsed.status, parsed.created_event_seq, parsed.delivered_event_seq, parsed.acknowledged_event_seq, parsed.version,
    );
  }

  #migrateLegacyReconciliationResults(): void {
    while (true) {
      const rows = this.#db.prepare("SELECT repo_id, idempotency_key, committed_event_seq, payload_json FROM idempotency_results WHERE json_type(payload_json, '$.reconciliation')='object' ORDER BY repo_id, committed_event_seq, idempotency_key LIMIT 128").all();
      if (rows.length === 0) return;
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          const repoId = sqlString(row, 'repo_id');
          const idempotencyKey = sqlString(row, 'idempotency_key');
          const eventSeq = sqlInteger(row, 'committed_event_seq');
          const payload = parseJsonObject(sqlString(row, 'payload_json'), 'legacy reconciliation idempotency payload');
          const summary = this.#parseStoredReconciliationSummary(payload['reconciliation']);
          const event = asRow(this.#db.prepare('SELECT event_type, entity_type, entity_id FROM events WHERE repo_id=? AND idempotency_key=?').get(repoId, idempotencyKey), 'legacy reconciliation event');
          const workstreamRun = this.#legacyReconciliationRun(repoId, payload, event);
          const receipt = this.#persistReconciliationReceipt(repoId, workstreamRun, this.#legacyReconciliationSourceAction(sqlString(event, 'event_type')), eventSeq, summary);
          const compact: Record<string, unknown> = {};
          for (const [field, value] of Object.entries(payload)) if (field !== 'reconciliation') compact[field] = value;
          Object.assign(compact, this.#reconciliationReceiptPayload(receipt));
          this.#db.prepare('UPDATE idempotency_results SET payload_json=? WHERE repo_id=? AND idempotency_key=?').run(canonicalJson(compact), repoId, idempotencyKey);
        }
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  #parseStoredReconciliationSummary(value: unknown): CoordinationReconciliationSummary {
    if (!isJsonMap(value)) throw new CoordinationRuntimeError('schema-mismatch', 'stored reconciliation summary is not an object');
    const fields = Object.keys(value).sort();
    const predecessorFields = ['notification_ids', 'offered_group_ids', 'released_lease_ids', 'released_request_ids'];
    const observationFields = ['notification_ids', 'offered_group_ids', 'released_lease_ids', 'released_observation_ids', 'released_request_ids', 'stale_observation_ids'];
    const predecessorShape = canonicalJson(fields) === canonicalJson(predecessorFields);
    if (!predecessorShape && canonicalJson(fields) !== canonicalJson(observationFields)) throw new CoordinationRuntimeError('schema-mismatch', 'stored reconciliation summary fields are not an exact historical contract', fields);
    const values = (field: keyof CoordinationReconciliationSummary, absentBeforeObservations = false): readonly string[] => {
      const entries = value[field];
      if (entries === undefined && predecessorShape && absentBeforeObservations) return Object.freeze([]);
      if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string')) throw new CoordinationRuntimeError('schema-mismatch', `stored reconciliation ${field} is not a string array`);
      if (new Set(entries).size !== entries.length) throw new CoordinationRuntimeError('schema-mismatch', `stored reconciliation ${field} contains duplicate durable identities`);
      return Object.freeze([...entries]);
    };
    return Object.freeze({ released_lease_ids: values('released_lease_ids'), released_observation_ids: values('released_observation_ids', true), stale_observation_ids: values('stale_observation_ids', true), released_request_ids: values('released_request_ids'), notification_ids: values('notification_ids'), offered_group_ids: values('offered_group_ids') });
  }

  #legacyReconciliationSourceAction(eventType: string): string {
    const actions: Readonly<Record<string, string>> = {
      'session-attached': 'attach-session', 'terminal-cleanup-recovery-attached': 'attach-terminal-recovery', 'session-heartbeat': 'heartbeat',
      'child-terminal': 'complete-child', 'child-recovery-required': 'complete-child', 'claim-request-deferred': 'respond-claim-request',
      'release-evidence-accepted': 'record-release-evidence', 'run-reconciled': 'reconcile-run',
    };
    const action = actions[eventType];
    if (action === undefined) throw new CoordinationRuntimeError('schema-mismatch', 'legacy reconciliation event type has no exact protocol-1.6 source-action mapping', [eventType]);
    return action;
  }

  #legacyReconciliationRun(repoId: string, payload: Readonly<Record<string, unknown>>, event: SqlRow): string {
    const candidateRecords = ['run', 'session', 'child', 'claim_request', 'reconciliation_evidence'].map((field) => payload[field]);
    for (const candidate of candidateRecords) {
      if (!isJsonMap(candidate)) continue;
      const record = candidate;
      const direct = record['workstream_run'];
      if (typeof direct === 'string') return direct;
      const owner = record['owner'];
      if (isJsonMap(owner)) {
        const ownedRun = owner['workstream_run'];
        if (typeof ownedRun === 'string') return ownedRun;
      }
    }
    const entityType = sqlString(event, 'entity_type');
    const entityId = sqlString(event, 'entity_id');
    if (entityType === 'run') return entityId;
    if (entityType === 'session-lease') return sqlString(asRow(this.#db.prepare('SELECT workstream_run FROM session_leases WHERE repo_id=? AND session_lease_id=?').get(repoId, entityId), 'legacy reconciliation session'), 'workstream_run');
    if (entityType === 'child-lease') return sqlString(asRow(this.#db.prepare('SELECT workstream_run FROM child_leases WHERE repo_id=? AND child_lease_id=?').get(repoId, entityId), 'legacy reconciliation child'), 'workstream_run');
    if (entityType === 'claim-request') return sqlString(asRow(this.#db.prepare('SELECT owner_workstream_run FROM claim_requests WHERE repo_id=? AND entity_id=?').get(repoId, entityId), 'legacy reconciliation claim request'), 'owner_workstream_run');
    throw new CoordinationRuntimeError('schema-mismatch', 'legacy reconciliation result lacks durable run identity', [repoId, entityType, entityId]);
  }

  #migrateSchema9ReadLeasesToObservations(ownsTransactions = true): void {
    const rowsByRun = new Map<string, SqlRow[]>();
    for (const row of this.#db.prepare("SELECT * FROM edit_leases WHERE json_extract(payload_json, '$.mode')='READ' ORDER BY repo_id, workstream_run, entity_id").all()) {
      const key = `${sqlString(row, 'repo_id')}\0${sqlString(row, 'workstream_run')}`;
      const rows = rowsByRun.get(key) ?? [];
      rows.push(row);
      rowsByRun.set(key, rows);
    }
    for (const rows of rowsByRun.values()) {
      const first = rows[0];
      if (first === undefined) continue;
      const repoId = sqlString(first, 'repo_id');
      const workstreamRun = sqlString(first, 'workstream_run');
      if (ownsTransactions) this.#db.exec('BEGIN IMMEDIATE');
      try {
        const seq = this.#nextEventSequence(repoId);
        const touchedGroups = new Set<string>();
        const revalidationGroups = new Set<string>();
        for (const row of rows) {
          const payload = parseJsonObject(sqlString(row, 'payload_json'), 'schema-9 READ lease');
          const groupId = typeof payload['acquisition_group_id'] === 'string' ? payload['acquisition_group_id'] : '';
          const path = typeof payload['path'] === 'string' ? payload['path'] : '';
          const purpose = typeof payload['purpose'] === 'string' ? payload['purpose'] : '';
          const group = this.#requireGroup(repoId, groupId);
          if (group.owner.workstream_run !== workstreamRun || canonicalJson(payload['owner']) !== canonicalJson(group.owner)) throw new CoordinationRuntimeError('store-corrupt', 'schema-9 READ lease owner/group identity is invalid', [sqlString(row, 'entity_id')]);
          const requested = parseCoordinationRequestedLease({ path, mode: 'READ', purpose });
          const groupRequested = group.requested_leases.find((candidate) => candidate.mode === 'READ' && candidate.path === requested.path);
          if (groupRequested === undefined) throw new CoordinationRuntimeError('store-corrupt', 'schema-9 READ lease is absent from its acquisition group', [sqlString(row, 'entity_id'), groupId]);
          const childId = `child-${group.owner.workstream_run}-${group.owner.unit_id}-${String(group.owner.attempt)}`;
          const childStatus = this.#childForOwner(group.owner)?.status ?? null;
          const attemptRow = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(unitAttemptEntityId(group.owner));
          const durableAttempt = attemptRow === undefined ? null : unitAttemptFromRow(attemptRow);
          const attemptState = durableAttempt?.state ?? null;
          if (groupRequested.source_identity === undefined && (childStatus === 'running' || attemptState === 'running')) throw new CoordinationRuntimeError('recovery-required', 'schema-9 READ authority belongs to a running child and lacks acquisition-time source identity; migration requires a fully drained child boundary', [childId, requested.path]);
          const leaseId = sqlString(row, 'entity_id');
          const retiredRecovery = this.#db.prepare("SELECT * FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND recovery_type='ambiguous-live-claim' AND status='pending' AND json_extract(payload_json, '$.edit_lease_id')=? ORDER BY entity_id").all(repoId, workstreamRun, leaseId).map(migrationRecoveryFromRow);
          if (groupRequested.source_identity !== undefined) {
            const executionState = childStatus === 'terminal' || attemptState === 'transport-complete' || attemptState === 'merged'
              ? 'released'
              : childStatus === 'recovery-required' || (attemptState !== null && ['failed', 'reset', 'quarantined', 'superseded'].includes(attemptState))
                ? 'abandoned'
                : 'active';
            const observation = parseCoordinationObservation({
              schema_version: 'autopilot.observation.v1', observation_id: stableEntityId('observation', [repoId, groupId, requested.path, groupRequested.source_identity.base_commit, groupRequested.source_identity.object_id]),
              owner: group.owner, acquisition_group_id: groupId, path: requested.path, purpose: requested.purpose, source_identity: groupRequested.source_identity,
              execution_state: executionState, freshness: 'current', recorded_event_seq: typeof payload['acquired_event_seq'] === 'number' ? payload['acquired_event_seq'] : group.grant_event_seq ?? group.created_event_seq,
              released_event_seq: executionState === 'active' ? null : seq, stale_event_seq: null, stale_by_reservation_id: null, stale_by_commit: null, version: 1,
            });
            this.#insertObservation(observation);
            if (retiredRecovery.length > 0) {
              const auditId = stableEntityId('schema-9-read-recovery-retirement', [repoId, workstreamRun, leaseId]);
              const audit = { schema_version: 'autopilot.schema9_read_recovery_retirement.v1', repo_id: repoId, workstream_run: workstreamRun, edit_lease_id: leaseId, observation_id: observation.observation_id, source_identity: observation.source_identity, retired_recovery_work: retiredRecovery, disposition: 'read-authority-converted-to-nonblocking-observation', retired_event_seq: seq };
              if (this.#db.prepare('SELECT entity_id FROM migration_legacy_audit WHERE entity_id=?').get(auditId) === undefined) this.#db.prepare('INSERT INTO migration_legacy_audit(entity_id, repo_id, source_kind, payload_json, created_event_seq) VALUES(?, ?, ?, ?, ?)').run(auditId, repoId, 'claim-event', canonicalJson(audit), seq);
            }
          } else {
            revalidationGroups.add(groupId);
            const retirementId = stableEntityId('schema-9-read-retirement', [repoId, workstreamRun, leaseId]);
            const retirement = {
              schema_version: 'autopilot.schema9_read_retirement.v1', repo_id: repoId, workstream_run: workstreamRun,
              edit_lease_id: leaseId, acquisition_group_id: groupId, owner: group.owner, requested_read: requested,
              original_lease_payload: payload, original_payload_sha256: `sha256:${createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')}`,
              retired_recovery_work: retiredRecovery,
              disposition: 'retired-unbound-read-authority', revalidation_required: durableAttempt?.role === 'validate' || durableAttempt?.role === 'bughunt', retired_event_seq: seq,
            };
            if (this.#db.prepare('SELECT entity_id FROM migration_legacy_audit WHERE entity_id=?').get(retirementId) === undefined) this.#db.prepare('INSERT INTO migration_legacy_audit(entity_id, repo_id, source_kind, payload_json, created_event_seq) VALUES(?, ?, ?, ?, ?)').run(retirementId, repoId, 'claim-event', canonicalJson(retirement), seq);
          }
          for (const recovery of retiredRecovery) this.#db.prepare("DELETE FROM migration_recovery_work WHERE entity_id=? AND status='pending'").run(recovery.recovery_id);
          this.#db.prepare('DELETE FROM edit_leases WHERE entity_id=?').run(leaseId);
          touchedGroups.add(groupId);
        }
        for (const groupId of touchedGroups) {
          this.#markGroupReleasedWhenEmpty(repoId, groupId);
          if (revalidationGroups.has(groupId)) {
            const current = this.#requireGroup(repoId, groupId);
            if (current.state === 'granted') this.#updateEntity('acquisition_groups', groupId, { ...current, acquisition_kind: 'legacy-unknown', version: current.version + 1 });
          }
        }
        const idempotencyKey = `schema-10-read-authority-migration:${workstreamRun}:${String(seq)}`;
        const digest = `sha256:${createHash('sha256').update(idempotencyKey, 'utf8').digest('hex')}`;
        this.#db.prepare('INSERT INTO events(repo_id, event_seq, event_type, entity_type, entity_id, idempotency_key, request_sha256, occurred_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(repoId, seq, 'read-authority-migrated-or-retired', 'run', workstreamRun, idempotencyKey, digest, this.#clock.now().toISOString());
        if (ownsTransactions) this.#db.exec('COMMIT');
      } catch (error) {
        if (ownsTransactions) this.#db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  #recoverDurableTransitionsAfterStartup(): void {
    const runs = this.#db.prepare('SELECT * FROM runs ORDER BY repo_id, workstream_run').all().map(runFromRow);
    for (const run of runs) {
      if (this.#db.prepare("SELECT fault_id FROM run_scoped_faults WHERE repo_id=? AND workstream_run=? AND status='active' LIMIT 1").get(run.repo_id, run.workstream_run) !== undefined) continue;
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const seq = this.#nextEventSequence(run.repo_id);
        const recoveryMessageIds = this.#enqueueOperationRecoveryMessages(run, seq);
        const childStateBefore = canonicalJson(this.#db.prepare('SELECT child_lease_id, status, terminal_evidence_ref, terminal_evidence_sha256, version FROM child_leases WHERE repo_id=? AND workstream_run=? ORDER BY child_lease_id').all(run.repo_id, run.workstream_run));
        const summary = this.#reconcileOwnedRun(run.repo_id, run.workstream_run, seq);
        const childStateChanged = childStateBefore !== canonicalJson(this.#db.prepare('SELECT child_lease_id, status, terminal_evidence_ref, terminal_evidence_sha256, version FROM child_leases WHERE repo_id=? AND workstream_run=? ORDER BY child_lease_id').all(run.repo_id, run.workstream_run));
        const graphBefore = canonicalJson({ edges: this.#db.prepare('SELECT payload_json FROM wait_for_edges WHERE repo_id=? ORDER BY entity_id').all(run.repo_id).map((row) => sqlString(row, 'payload_json')), resolutions: this.#db.prepare('SELECT payload_json FROM deadlock_resolutions WHERE repo_id=? ORDER BY entity_id').all(run.repo_id).map((row) => sqlString(row, 'payload_json')) });
        this.#maintainWaitForGraph(run.repo_id, seq);
        const graphAfter = canonicalJson({ edges: this.#db.prepare('SELECT payload_json FROM wait_for_edges WHERE repo_id=? ORDER BY entity_id').all(run.repo_id).map((row) => sqlString(row, 'payload_json')), resolutions: this.#db.prepare('SELECT payload_json FROM deadlock_resolutions WHERE repo_id=? ORDER BY entity_id').all(run.repo_id).map((row) => sqlString(row, 'payload_json')) });
        const graphChanged = graphBefore !== graphAfter;
        if (recoveryMessageIds.length === 0 && summary.released_lease_ids.length === 0 && summary.released_observation_ids.length === 0 && summary.stale_observation_ids.length === 0 && summary.released_request_ids.length === 0 && summary.notification_ids.length === 0 && summary.offered_group_ids.length === 0 && !graphChanged && !childStateChanged) {
          this.#db.exec('ROLLBACK');
          continue;
        }
        const idempotencyKey = `startup-reconciliation:${run.workstream_run}:${String(seq)}`;
        const persistedSummary = this.#freezeReconciliationSummary({ ...summary, notification_ids: [...recoveryMessageIds, ...summary.notification_ids] });
        const receipt = this.#persistReconciliationReceipt(run.repo_id, run.workstream_run, 'startup-reconciliation', seq, persistedSummary, true);
        const resultPayload = Object.freeze({ run: this.#requireRun(run.repo_id, run.workstream_run), reconciliation_receipt: receipt, event_type: 'startup-run-reconciled', entity_type: 'run', entity_id: run.workstream_run });
        const digest = `sha256:${createHash('sha256').update(`${canonicalJson(resultPayload)}\n`, 'utf8').digest('hex')}`;
        this.#insertEvent.run(run.repo_id, seq, 'startup-run-reconciled', 'run', run.workstream_run, idempotencyKey, digest, this.#clock.now().toISOString());
        this.#insertIdempotencyResult.run(run.repo_id, idempotencyKey, digest, seq, canonicalJson(resultPayload));
        this.#lastStartupReconciliation = receipt;
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  #enqueueOperationRecoveryMessages(run: CoordinationRun, seq: number): readonly string[] {
    const operations = this.#db.prepare("SELECT * FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.stage') NOT IN ('committed','compensated','failed') ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(worktreeOperationFromRow);
    const messageIds: string[] = [];
    for (const operation of operations) {
      const messageId = stableEntityId('message', ['worktree-operation-recovery', operation.operation_id]);
      if (this.#db.prepare('SELECT message_id FROM messages WHERE message_id=?').get(messageId) !== undefined) continue;
      const message: CoordinationMessage = {
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

  #reconcileOwnedRun(repoId: string, workstreamRun: string, seq: number): CoordinationReconciliationSummary {
    const beforeRequests = new Map(this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? ORDER BY entity_id').all(repoId).map(claimRequestFromRow).map((entry) => [entry.request_id, entry] as const));
    const beforeMessages = new Set(this.#db.prepare('SELECT message_id FROM messages WHERE repo_id=? ORDER BY message_id').all(repoId).map((row) => sqlString(row, 'message_id')));
    const beforeOffers = new Set(this.#db.prepare("SELECT entity_id FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state')='grant-ready'").all(repoId).map((row) => sqlString(row, 'entity_id')));
    const releasedLeaseIds: string[] = [];
    const releasedObservationIds: string[] = [];
    const staleObservationIds: string[] = [];
    const run = this.#requireRun(repoId, workstreamRun);
    this.#repairPostCutoverTerminalChildren(run, seq);
    this.#releaseProvenLegacyReadLeases(run, seq, releasedLeaseIds);
    this.#reconcileObservations(run, seq, releasedObservationIds);
    const ownerRequests = this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? AND owner_workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(claimRequestFromRow);
    for (const claimRequest of ownerRequests) {
      if (claimRequest.release_condition === null || !['deferred', 'acknowledged', 'delivered', 'pending'].includes(claimRequest.status) || !this.#conditionSatisfied(repoId, workstreamRun, claimRequest.release_condition)) continue;
      for (const leaseId of claimRequest.blocking_lease_ids) this.#releaseOwnedLease(repoId, workstreamRun, leaseId, releasedLeaseIds);
    }
    const ownedLeases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(repoId, workstreamRun).map(editLeaseFromRow);
    for (const lease of ownedLeases) {
      if (this.#conditionSatisfied(repoId, workstreamRun, lease.normal_release_condition)) this.#releaseOwnedLease(repoId, workstreamRun, lease.edit_lease_id, releasedLeaseIds);
    }
    this.#reevaluateWaitingGroups(repoId, seq);
    const afterRequests = this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? ORDER BY entity_id').all(repoId).map(claimRequestFromRow);
    const releasedRequestIds = afterRequests.filter((entry) => {
      const before = beforeRequests.get(entry.request_id);
      return entry.release_event_seq === seq && before?.release_event_seq !== seq;
    }).map((entry) => entry.request_id);
    const notificationIds = this.#db.prepare('SELECT message_id FROM messages WHERE repo_id=? ORDER BY message_id').all(repoId).map((row) => sqlString(row, 'message_id')).filter((messageId) => !beforeMessages.has(messageId));
    const offeredGroupIds = this.#db.prepare("SELECT entity_id FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state')='grant-ready' ORDER BY entity_id").all(repoId).map((row) => sqlString(row, 'entity_id')).filter((groupId) => !beforeOffers.has(groupId));
    return this.#freezeReconciliationSummary({ released_lease_ids: releasedLeaseIds, released_observation_ids: releasedObservationIds, stale_observation_ids: staleObservationIds, released_request_ids: releasedRequestIds, notification_ids: notificationIds, offered_group_ids: offeredGroupIds });
  }

  #repairPostCutoverTerminalChildren(run: CoordinationRun, seq: number): void {
    const resourceRow = this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run);
    if (resourceRow === undefined) return;
    const resource = runResourceFromRow(resourceRow);
    const children = this.#db.prepare("SELECT * FROM child_leases WHERE repo_id=? AND workstream_run=? AND status IN ('running','recovery-required') ORDER BY unit_id, attempt, child_lease_id").all(run.repo_id, run.workstream_run).map(childFromRow);
    for (const child of children) {
      const attemptRow = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(unitAttemptEntityId(child.owner));
      if (attemptRow === undefined) continue;
      const attempt = unitAttemptFromRow(attemptRow);
      const result = proveStructuredAttemptTerminal({ mainWorktreePath: resource.main_worktree_path, runtimeRoot: resource.runtime_root, repoId: run.repo_id, autopilotId: run.autopilot_id, workstream: run.workstream, workstreamRun: run.workstream_run, unitId: child.owner.unit_id, attempt: child.owner.attempt, childLeaseId: child.child_lease_id, spec: attempt.spec });
      if (!result.proven) continue;
      const proof = result.proof;
      for (const artifact of proof.artifacts) this.#persistEvidenceArtifact(run.repo_id, { ref: artifact.ref, sha256: artifact.sha256 }, artifact.bytes, 'post-cutover trusted terminal repair', seq);
      this.#acceptReconciliationEvidence({ repoId: run.repo_id, workstreamRun: run.workstream_run, source: 'child-process', targetId: child.child_lease_id, evidence: { ref: proof.terminalEvidence.ref, sha256: proof.terminalEvidence.sha256 }, seq });
      const updated = this.#db.prepare("UPDATE child_leases SET status='terminal', terminal_evidence_ref=?, terminal_evidence_sha256=?, version=version+1 WHERE child_lease_id=? AND status IN ('running','recovery-required')").run(proof.terminalEvidence.ref, proof.terminalEvidence.sha256, child.child_lease_id);
      if (updated.changes !== 1) throw new CoordinationRuntimeError('invalid-state', 'trusted terminal repair lost its exact child transition', [child.child_lease_id]);
      this.#updateAttemptForSatisfiedCondition(child.owner, 'child-terminal');
      const releasedExclusiveLeaseIds: string[] = [];
      this.#releaseExitedExclusiveLeases(child.owner, releasedExclusiveLeaseIds);
      // Terminal process fact releases observations. Ordinary WRITE authority
      // remains until merge/reset/quarantine; bounded EXCLUSIVE authority ends.
      const cleanEditRelease = false;
      this.#persistPostCutoverTerminalRepairAudit(run, child, proof, cleanEditRelease, seq);
    }
  }

  #persistPostCutoverTerminalRepairAudit(run: CoordinationRun, child: CoordinationChildLease, proof: TrustedTerminalAttemptProof, cleanEditRelease: boolean, seq: number): void {
    const auditId = stableEntityId('post-cutover-terminal-repair', [run.repo_id, run.workstream_run, child.child_lease_id, proof.terminalEvidence.sha256]);
    if (this.#db.prepare('SELECT entity_id FROM migration_legacy_audit WHERE entity_id=?').get(auditId) !== undefined) return;
    const payload = {
      schema_version: 'autopilot.post_cutover_terminal_repair.v1', repo_id: run.repo_id, autopilot_id: run.autopilot_id, workstream_run: run.workstream_run,
      unit_id: child.owner.unit_id, attempt: child.owner.attempt, child_lease_id: child.child_lease_id, verdict: proof.status.verdict,
      status_ref: proof.artifacts[1]?.ref ?? null, status_sha256: proof.artifacts[1]?.sha256 ?? null,
      receipt_ref: proof.receipt.ref, receipt_sha256: proof.receipt.sha256,
      audit_ref: proof.artifacts[3]?.ref ?? null, audit_sha256: proof.artifacts[3]?.sha256 ?? null,
      transport_terminalized: true, clean_zero_change_edit_release: cleanEditRelease, mechanical_proof: proof.mechanicalProof, accepted_event_seq: seq,
    };
    this.#db.prepare('INSERT INTO migration_legacy_audit(entity_id, repo_id, source_kind, payload_json, created_event_seq) VALUES(?, ?, ?, ?, ?)').run(auditId, run.repo_id, 'claim-event', canonicalJson(payload), seq);
  }

  #reconcileObservations(run: CoordinationRun, seq: number, releasedObservationIds: string[]): void {
    const observations = this.#db.prepare("SELECT * FROM observations WHERE repo_id=? AND workstream_run=? AND execution_state='active' ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(observationFromRow);
    for (const observation of observations) {
      const childStatus = this.#childForOwner(observation.owner)?.status ?? null;
      const attemptRow = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(unitAttemptEntityId(observation.owner));
      const attemptState = attemptRow === undefined ? null : unitAttemptFromRow(attemptRow).state;
      const executionState = childStatus === 'terminal' || attemptState === 'transport-complete' || attemptState === 'merged'
        ? 'released'
        : childStatus === 'recovery-required' || (attemptState !== null && ['failed', 'reset', 'quarantined', 'superseded'].includes(attemptState))
          ? 'abandoned'
          : null;
      if (executionState === null) continue;
      this.#updateObservation(parseCoordinationObservation({ ...observation, execution_state: executionState, released_event_seq: seq, version: observation.version + 1 }));
      releasedObservationIds.push(observation.observation_id);
      this.#markGroupReleasedWhenEmpty(run.repo_id, observation.acquisition_group_id);
    }
  }

  #releaseProvenLegacyReadLeases(run: CoordinationRun, seq: number, releasedLeaseIds: string[]): void {
    const resourceRow = this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run);
    if (resourceRow === undefined) return;
    const resource = runResourceFromRow(resourceRow);
    const groups = new Map(this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(acquisitionGroupFromRow).map((group) => [group.acquisition_group_id, group] as const));
    const leases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(editLeaseFromRow);
    const recoveryByLease = new Map<string, CoordinationMigrationRecoveryWork[]>();
    for (const recovery of this.#db.prepare('SELECT * FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(migrationRecoveryFromRow)) {
      const leaseId = recovery.detail['edit_lease_id'];
      if (typeof leaseId !== 'string') continue;
      const matching = recoveryByLease.get(leaseId) ?? [];
      matching.push(recovery);
      recoveryByLease.set(leaseId, matching);
    }
    const nonterminalChildOwners = new Set(this.#db.prepare("SELECT * FROM child_leases WHERE repo_id=? AND workstream_run=? AND status IN ('preflight','running','recovery-required') ORDER BY child_lease_id").all(run.repo_id, run.workstream_run).map(childFromRow).map((child) => `${child.owner.unit_id}\0${String(child.owner.attempt)}`));
    const proofByAttempt = new Map<string, ReturnType<typeof proveLegacyReadAttemptTerminal>>();
    const updatedAttempts = new Set<string>();
    for (const lease of leases) {
      const group = groups.get(lease.acquisition_group_id);
      if (lease.mode !== 'READ' || lease.normal_release_condition.condition_type !== 'explicit-owner-release' || group?.acquisition_kind !== 'legacy-unknown') continue;
      const recoveries = recoveryByLease.get(lease.edit_lease_id) ?? [];
      if (recoveries.some((recovery) => recovery.status === 'pending' || recovery.resolution?.resolution_type !== 'authority-retained')) continue;
      const attemptKey = `${lease.owner.unit_id}\0${String(lease.owner.attempt)}`;
      if (nonterminalChildOwners.has(attemptKey)) continue;
      let result = proofByAttempt.get(attemptKey);
      if (result === undefined) {
        result = proveLegacyReadAttemptTerminal({ runtimeRoot: resource.runtime_root, workstream: run.workstream, unitId: lease.owner.unit_id, attempt: lease.owner.attempt });
        proofByAttempt.set(attemptKey, result);
      }
      if (!result.proven) continue;
      this.#persistLegacyReadTerminalProof(run, resource, lease, result.proof, seq);
      this.#releaseOwnedLease(run.repo_id, run.workstream_run, lease.edit_lease_id, releasedLeaseIds);
      if (updatedAttempts.has(attemptKey)) continue;
      updatedAttempts.add(attemptKey);
      const entityId = unitAttemptEntityId(lease.owner);
      const attemptRow = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(entityId);
      if (attemptRow === undefined) continue;
      const attempt = unitAttemptFromRow(attemptRow);
      const state = result.proof.kind === 'superseded-by-later-attempt' ? 'superseded' : 'transport-complete';
      if (attempt.state === state || attempt.state === 'merged' || attempt.state === 'reset' || attempt.state === 'quarantined' || attempt.state === 'superseded') continue;
      this.#updateEntity('unit_attempts', entityId, { ...attempt, state, critical_section: null, version: attempt.version + 1 });
    }
  }

  #persistLegacyReadTerminalProof(run: CoordinationRun, resource: CoordinationRunResource, lease: CoordinationEditLease, proof: LegacyReadTerminalProof, seq: number): void {
    const evidence = proof.artifacts.map((artifact) => {
      const ref = relative(resource.main_worktree_path, artifact.path).split(sep).join('/');
      if (ref.length === 0 || ref === '..' || ref.startsWith('../') || isAbsolute(ref)) throw new CoordinationRuntimeError('unauthorized-client', 'legacy READ terminal evidence escapes the durable run main worktree', [artifact.path]);
      const identity = { ref, sha256: artifact.sha256 };
      this.#persistEvidenceArtifact(run.repo_id, identity, artifact.bytes, 'legacy READ terminal authority release', seq);
      return identity;
    });
    const primary = evidence[proof.artifacts.indexOf(proof.evidence)];
    if (primary === undefined) throw new CoordinationRuntimeError('store-corrupt', 'legacy READ terminal proof lost its primary evidence artifact');
    const auditId = stableEntityId('legacy-read-terminal-release', [run.repo_id, run.workstream_run, lease.edit_lease_id, primary.sha256]);
    if (this.#db.prepare('SELECT entity_id FROM migration_legacy_audit WHERE entity_id=?').get(auditId) !== undefined) return;
    const payload = {
      schema_version: 'autopilot.migration_terminal_release.v1', repo_key: run.repo_id, workstream_run: run.workstream_run, autopilot_id: run.autopilot_id,
      unit_id: lease.owner.unit_id, attempt: lease.owner.attempt, path: lease.path, claim_type: lease.mode,
      mechanical_proof: proof.kind === 'completed-current-attempt' ? 'accepted-read-terminal' : 'superseded-read-terminal', evidence_source: 'legacy-read-terminal',
      evidence_ref: primary.ref, evidence_sha256: primary.sha256, supporting_evidence: evidence, exact_git_objects: [], filesystem_postconditions: proof.mechanicalProof,
      released_from_active_import: false, released_post_cutover: coordinationCutoverCommitted(this.#stateRoot, run.repo_id),
    };
    this.#db.prepare('INSERT INTO migration_legacy_audit(entity_id, repo_id, source_kind, payload_json, created_event_seq) VALUES(?, ?, ?, ?, ?)').run(auditId, run.repo_id, 'claim-event', canonicalJson(payload), seq);
  }

  #activeExclusiveLeases(owner: CoordinationOwnerIdentity): readonly CoordinationEditLease[] {
    return Object.freeze(this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(owner.repo_id, owner.workstream_run).map(editLeaseFromRow).filter((lease) => sameOwner(lease.owner, owner) && lease.mode === 'EXCLUSIVE'));
  }

  #releaseExitedExclusiveLeases(owner: CoordinationOwnerIdentity, releasedLeaseIds: string[]): void {
    for (const lease of this.#activeExclusiveLeases(owner)) {
      const operation = lease.exclusive_operation;
      if (operation === undefined || operation.operation_kind === 'legacy-migration-exclusive' || operation.release_trigger !== 'critical-section-exit') continue;
      const group = this.#requireGroup(owner.repo_id, lease.acquisition_group_id);
      const pairedWrite = group.requested_leases.some((requested) => requested.mode === 'WRITE' && requested.path === lease.path)
        && this.#db.prepare("SELECT entity_id FROM edit_leases WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.acquisition_group_id')=? AND json_extract(payload_json, '$.mode')='WRITE' AND json_extract(payload_json, '$.path')=? LIMIT 1").get(owner.repo_id, owner.workstream_run, lease.acquisition_group_id, lease.path) !== undefined;
      if (!pairedWrite) throw new CoordinationRuntimeError('store-corrupt', 'new EXCLUSIVE authority lost its paired WRITE intention before critical-section exit', [lease.edit_lease_id, lease.path]);
      this.#releaseOwnedLease(owner.repo_id, owner.workstream_run, lease.edit_lease_id, releasedLeaseIds);
    }
  }

  #releaseOwnedLease(repoId: string, workstreamRun: string, leaseId: string, releasedLeaseIds: string[]): void {
    const row = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND entity_id=?').get(repoId, leaseId);
    if (row === undefined) return;
    const lease = editLeaseFromRow(row);
    if (lease.owner.workstream_run !== workstreamRun) throw new CoordinationRuntimeError('unauthorized-client', 'run reconciliation cannot release a foreign-run edit lease');
    this.#db.prepare('DELETE FROM edit_leases WHERE repo_id=? AND entity_id=?').run(repoId, leaseId);
    releasedLeaseIds.push(leaseId);
    this.#markGroupReleasedWhenEmpty(repoId, lease.acquisition_group_id);
  }

  #convertUnitMergeToReservations(run: CoordinationRun, targetId: string, mergeEvidence: { readonly ref: string; readonly sha256: `sha256:${string}` }, seq: number): { readonly reservations: readonly CoordinationChangeReservation[]; readonly obligations: readonly CoordinationReservationObligation[] } {
    const target = parseUnitAttemptTarget(targetId);
    const owner: CoordinationOwnerIdentity = { repo_id: run.repo_id, autopilot_id: run.autopilot_id, workstream_run: run.workstream_run, unit_id: target.unitId, attempt: target.attempt };
    const facts = parseUnitMergeReservationFacts(this.#verifyAcceptedEvidenceFile(run, 'unit-merge', targetId, mergeEvidence));
    this.#assertUnitMergeGitFacts(run, facts);
    const activeLeases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(editLeaseFromRow).filter((lease) => sameOwner(lease.owner, owner));
    const existing = this.#db.prepare("SELECT * FROM change_reservations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.merge_evidence.ref')=? AND json_extract(payload_json, '$.merge_evidence.sha256')=? ORDER BY entity_id").all(run.repo_id, run.workstream_run, mergeEvidence.ref, mergeEvidence.sha256).map(changeReservationFromRow);
    const expectedExisting = facts.changedPaths.every((path) => existing.some((reservation) => reservation.path === path));
    if (activeLeases.length === 0) {
      if (expectedExisting && existing.length === facts.changedPaths.length) return { reservations: existing, obligations: [] };
      throw new CoordinationRuntimeError('invalid-state', 'unit merge cannot create reservations without active edit authority or an exact prior conversion', [targetId, mergeEvidence.ref]);
    }
    for (const lease of activeLeases) {
      if (lease.normal_release_condition.condition_type !== 'unit-merged' || lease.normal_release_condition.target_id !== targetId) throw new CoordinationRuntimeError('invalid-state', 'source-changing edit lease must remain active through its exact unit-merge transition', [lease.edit_lease_id]);
    }
    for (const path of facts.changedPaths) {
      const covering = activeLeases.some((lease) => (lease.mode === 'WRITE' || lease.mode === 'EXCLUSIVE') && leaseCoversPath(lease.path, path));
      if (!covering) throw new CoordinationRuntimeError('unauthorized-client', 'unit merge changed a path outside active WRITE/EXCLUSIVE authority', [path, targetId]);
    }
    if (existing.length > 0) throw new CoordinationRuntimeError('invalid-state', 'partial or mismatched reservation conversion already exists; query status for exact identities', [`reservation_count=${String(existing.length)}`]);
    const reservations: CoordinationChangeReservation[] = [];
    const obligations: CoordinationReservationObligation[] = [];
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
        if (predecessor.terminal_outcome === 'aborted') continue;
        if (predecessor.terminal_outcome === 'closed' && predecessor.terminal_sha !== null && this.#gitCommitIsAncestor(run, predecessor.terminal_sha, facts.integrationBefore)) continue;
        const predecessorLanded = predecessor.released_event_seq !== null && predecessor.terminal_outcome === 'closed' && predecessor.terminal_sha !== null;
        const overlapPaths = [reservation.path, predecessor.path].filter((entry, index, values) => values.indexOf(entry) === index).sort();
        const integrationConflict = this.#classifyReservationOverlap(run, facts.integrationAfter, predecessor, overlapPaths);
        const obligation = parseCoordinationReservationObligation({
          schema_version: 'autopilot.reservation_obligation.v1',
          obligation_id: stableEntityId('reservation-obligation', [reservation.reservation_id, predecessor.reservation_id]),
          repo_id: run.repo_id,
          workstream_run: run.workstream_run,
          reservation_id: reservation.reservation_id,
          predecessor_reservation_id: predecessor.reservation_id,
          overlapping_paths: overlapPaths,
          integration_conflict: integrationConflict,
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
          payload: { obligation_id: obligation.obligation_id, role: 'dependent', reservation_id: reservation.reservation_id, predecessor_reservation_id: predecessor.reservation_id, predecessor_released_event_seq: predecessor.released_event_seq, predecessor_terminal_sha: predecessor.terminal_sha, overlapping_paths: obligation.overlapping_paths, integration_conflict: obligation.integration_conflict, required_action: integrationConflict.disposition === 'repair-required' ? 'create-integration-repair-and-revalidate' : predecessorLanded ? 'integrate-and-revalidate' : 'continue-speculatively-until-predecessor-lands' },
          status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
        });
        if (!predecessorLanded) this.#insertMessage({
          schema_version: 'autopilot.coordination_message.v1', message_id: stableEntityId('message', ['reservation-overlap', obligation.obligation_id, 'predecessor']), repo_id: run.repo_id,
          recipient_workstream_run: predecessor.workstream_run, message_type: 'reservation-overlap', correlation_id: obligation.obligation_id,
          payload: { obligation_id: obligation.obligation_id, role: 'predecessor', reservation_id: predecessor.reservation_id, dependent_reservation_id: reservation.reservation_id, overlapping_paths: obligation.overlapping_paths, integration_conflict: obligation.integration_conflict, required_action: 'land-or-abort-before-dependent-integration' },
          status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
        });
      }
    }
    return { reservations, obligations };
  }

  #classifyReservationOverlap(run: CoordinationRun, dependentCommit: string, predecessor: CoordinationChangeReservation, overlappingPaths: readonly string[]): ReturnType<typeof classifyCoordinationIntegrationConflict> {
    const predecessorRun = this.#requireRun(run.repo_id, predecessor.workstream_run);
    const predecessorTarget = this.#targetIdForMergeEvidence(predecessorRun, predecessor.merge_evidence);
    const predecessorFacts = parseUnitMergeReservationFacts(this.#verifyAcceptedEvidenceFile(predecessorRun, 'unit-merge', predecessorTarget, predecessor.merge_evidence));
    const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'integration classification repository'));
    return classifyCoordinationIntegrationConflict({ repoRoot: repository.canonical_root, predecessorCommit: predecessorFacts.integrationAfter, dependentCommit, overlappingPaths });
  }

  #assertReservationValidationArtifactChain(run: CoordinationRun, validationEvidenceRef: string, facts: ReturnType<typeof validateReservationValidationEvidenceDocument>): void {
    const marker = '/validation/';
    const markerIndex = validationEvidenceRef.lastIndexOf(marker);
    if (markerIndex <= 0) throw new CoordinationRuntimeError('invalid-state', 'reservation validation evidence must live below the run validation directory', [validationEvidenceRef]);
    const runtimePrefix = validationEvidenceRef.slice(0, markerIndex);
    const evidenceFor = (ref: string, sha256: `sha256:${string}`): { readonly ref: string; readonly sha256: `sha256:${string}` } => ({ ref: ref.startsWith('.pi/') ? ref : `${runtimePrefix}/${ref}`, sha256 });
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
    const terminalEvidence = acceptedChild[0]?.release_condition.evidence;
    if (acceptedChild.length !== 1 || terminalEvidence === null || terminalEvidence === undefined) throw new CoordinationRuntimeError('invalid-state', 'reservation validation is not backed by exactly one accepted validator child', [validatorChildId]);
    if (terminalEvidence.ref === receiptEvidence.ref && terminalEvidence.sha256 === receiptEvidence.sha256) return;
    const acceptance = parseAutopilotChildTerminalAcceptance(parseJsonObject(Buffer.from(this.#readRunEvidenceFile(run, terminalEvidence)).toString('utf8'), 'reservation validator terminal acceptance'));
    if (acceptance.child_lease_id !== validatorChildId || acceptance.workstream !== run.workstream || acceptance.workstream_run !== run.workstream_run || acceptance.unit_id !== facts.validationUnitId || acceptance.attempt !== facts.validationAttempt || acceptance.verdict !== 'PASS' || (acceptance.role !== 'validate' && acceptance.role !== 'bughunt') || acceptance.status.ref !== statusEvidence.ref || acceptance.status.sha256 !== statusEvidence.sha256 || acceptance.receipt.ref !== receiptEvidence.ref || acceptance.receipt.sha256 !== receiptEvidence.sha256 || acceptance.audit.ref !== auditEvidence.ref || acceptance.audit.sha256 !== auditEvidence.sha256) throw new CoordinationRuntimeError('invalid-state', 'reservation validation terminal acceptance does not bind the exact validator artifact chain', [validatorChildId, terminalEvidence.ref]);
  }

  #assertReservationIntegrationGitFacts(run: CoordinationRun, predecessorTerminalSha: string, integrationHead: string, protectedPaths: readonly string[], requireExactHead: boolean): void {
    const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'reservation integration repository'));
    const mainRoot = resolve(this.#stateRoot, 'worktrees', repository.repo_key, 'active', run.workstream_run, 'main');
    const currentHead = this.#gitQueryText(mainRoot, { kind: 'head' }, 'invalid-state', 'reservation integration owned workstream HEAD is unreadable');
    if (currentHead === null) throw new CoordinationRuntimeError('invalid-state', 'reservation integration owned workstream HEAD is absent');
    if (currentHead !== integrationHead) {
      if (requireExactHead || !this.#gitCommitIsAncestor(run, integrationHead, currentHead)) throw new CoordinationRuntimeError('invalid-state', 'reservation integration evidence is not the current owned workstream HEAD', [`actual=${currentHead}`, `evidence=${integrationHead}`]);
      const diff = this.#gitQueryResult(mainRoot, { kind: 'diff-paths', from: integrationHead, to: currentHead, noRenames: true }, 'invalid-state', 'failed to verify post-validation reservation path stability');
      const changed = this.#gitOutputText(diff, 'invalid-state', 'post-validation reservation path output is not valid UTF-8', mainRoot).split('\0').filter((path) => path.length > 0);
      const invalidating = changed.filter((path) => protectedPaths.some((protectedPath) => coordinationPathsOverlap(path, protectedPath)));
      if (invalidating.length > 0) throw new CoordinationRuntimeError('invalid-state', 'resolved reservation validation became stale on overlapping paths', invalidating);
    }
    if (!this.#gitCommitIsAncestor(run, predecessorTerminalSha, integrationHead)) throw new CoordinationRuntimeError('invalid-state', 'reservation integration head does not contain the predecessor terminal commit', [predecessorTerminalSha, integrationHead]);
  }

  #gitCommitIsAncestor(run: CoordinationRun, ancestor: string, descendant: string): boolean {
    const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'reservation ancestry repository'));
    const mainRoot = resolve(this.#stateRoot, 'worktrees', repository.repo_key, 'active', run.workstream_run, 'main');
    const result = this.#gitQueryResult(mainRoot, { kind: 'is-ancestor', ancestor, descendant }, 'invalid-state', 'failed to verify predecessor landing ancestry');
    return !result.negative;
  }

  #assertUnitMergeGitFacts(run: CoordinationRun, facts: ReturnType<typeof parseUnitMergeReservationFacts>): void {
    const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'merge repository'));
    const mainRoot = resolve(this.#stateRoot, 'worktrees', repository.repo_key, 'active', run.workstream_run, 'main');
    const head = this.#gitQueryText(mainRoot, { kind: 'head' }, 'invalid-state', 'unit-merge owned workstream HEAD is unreadable');
    if (head === null || facts.mergeCommitSha !== facts.integrationAfter) throw new CoordinationRuntimeError('invalid-state', 'unit-merge evidence integration head or merge commit is invalid', [`actual=${String(head)}`, `evidence=${facts.integrationAfter}`]);
    if (this.#gitQueryResult(mainRoot, { kind: 'is-ancestor', ancestor: facts.integrationAfter, descendant: head }, 'invalid-state', 'unit-merge integration containment inspection failed').negative) throw new CoordinationRuntimeError('invalid-state', 'unit-merge evidence integration head is not contained in the owned workstream HEAD', [facts.integrationAfter, head]);
    for (const sha of [facts.integrationBefore, facts.integrationAfter]) if (this.#gitQueryResult(mainRoot, { kind: 'commit-exists', revision: sha }, 'invalid-state', 'unit-merge Git object inspection failed').negative) throw new CoordinationRuntimeError('invalid-state', 'unit-merge evidence references a missing Git commit', [sha]);
    if (this.#gitQueryResult(mainRoot, { kind: 'is-ancestor', ancestor: facts.integrationBefore, descendant: facts.integrationAfter }, 'invalid-state', 'unit-merge ancestry inspection failed').negative) throw new CoordinationRuntimeError('invalid-state', 'unit-merge integration_before is not an ancestor of integration_after', [facts.integrationBefore, facts.integrationAfter]);
    const diff = this.#gitQueryResult(mainRoot, { kind: 'diff-paths', from: facts.integrationBefore, to: facts.integrationAfter, noRenames: true }, 'invalid-state', 'failed to derive exact unit-merge Git diff');
    const actualPaths = this.#gitOutputText(diff, 'invalid-state', 'unit-merge diff output is not valid UTF-8', mainRoot).split('\0').filter((path) => path.length > 0).map((path) => path.replace(/\\/gu, '/')).sort((left, right) => left.localeCompare(right));
    const declaredPaths = [...facts.changedPaths].sort((left, right) => left.localeCompare(right));
    if (canonicalJson(actualPaths) !== canonicalJson(declaredPaths)) throw new CoordinationRuntimeError('invalid-state', 'unit-merge changed_paths do not equal the exact Git diff', [`actual=${actualPaths.join(',')}`, `declared=${declaredPaths.join(',')}`]);
  }

  #assertRunTerminalGitFacts(run: CoordinationRun, source: 'run-close' | 'run-abort', terminalSha: string): void {
    const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'terminal repository'));
    const mainRoot = resolve(this.#stateRoot, 'worktrees', repository.repo_key, 'active', run.workstream_run, 'main');
    const terminalRoot = source === 'run-close' ? repository.canonical_root : mainRoot;
    const head = this.#gitQueryText(terminalRoot, { kind: 'head' }, 'invalid-state', `${source} authoritative Git HEAD is unreadable`);
    if (head !== terminalSha) throw new CoordinationRuntimeError('invalid-state', `${source} terminal commit is not the authoritative Git HEAD`, [`actual=${String(head)}`, `evidence=${terminalSha}`]);
    const reservations = this.#db.prepare('SELECT * FROM change_reservations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(changeReservationFromRow);
    for (const reservation of reservations) {
      const facts = parseUnitMergeReservationFacts(this.#verifyAcceptedEvidenceFile(run, 'unit-merge', this.#targetIdForMergeEvidence(run, reservation.merge_evidence), reservation.merge_evidence));
      const ancestor = this.#gitQueryResult(terminalRoot, { kind: 'is-ancestor', ancestor: facts.integrationAfter, descendant: terminalSha }, 'invalid-state', 'terminal reservation ancestry inspection failed');
      if (ancestor.negative) throw new CoordinationRuntimeError('invalid-state', 'terminal commit does not contain every reserved accepted merge', [reservation.reservation_id, facts.integrationAfter, terminalSha]);
    }
  }

  #targetIdForMergeEvidence(run: CoordinationRun, evidence: { readonly ref: string; readonly sha256: `sha256:${string}` }): string {
    const accepted = this.#db.prepare("SELECT * FROM reconciliation_evidence WHERE repo_id=? AND workstream_run=? AND source='unit-merge' AND json_extract(payload_json, '$.release_condition.evidence.ref')=? AND json_extract(payload_json, '$.release_condition.evidence.sha256')=? ORDER BY entity_id").all(run.repo_id, run.workstream_run, evidence.ref, evidence.sha256).map(reconciliationEvidenceFromRow);
    if (accepted.length !== 1) throw new CoordinationRuntimeError('store-corrupt', 'reservation must bind exactly one accepted unit merge', [evidence.ref, String(accepted.length)]);
    return accepted[0]?.release_condition.target_id ?? '';
  }

  #assertRunTerminalExternalReady(run: CoordinationRun): void {
    const runningChildren = this.#db.prepare("SELECT child_lease_id FROM child_leases WHERE repo_id=? AND workstream_run=? AND status IN ('preflight','running') ORDER BY child_lease_id").all(run.repo_id, run.workstream_run).map((row) => sqlString(row, 'child_lease_id'));
    if (runningChildren.length > 0) throw new CoordinationRuntimeError('recovery-required', 'run terminal commit requires all child processes terminal', runningChildren);
    const incompleteOperations = this.#db.prepare("SELECT entity_id FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.stage') NOT IN ('committed','compensated','failed') ORDER BY entity_id").all(run.repo_id, run.workstream_run).map((row) => sqlString(row, 'entity_id'));
    if (incompleteOperations.length > 0) throw new CoordinationRuntimeError('recovery-required', 'run terminal commit requires all owned worktree sagas terminal', incompleteOperations);
    const pendingGroups = this.#db.prepare("SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.state') IN ('waiting','grant-ready') ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(acquisitionGroupFromRow);
    if (pendingGroups.length > 0) throw new CoordinationRuntimeError('recovery-required', 'run terminal commit requires queued acquisition groups to be cancelled or superseded; query status for exact identities', [`group_count=${String(pendingGroups.length)}`]);
  }

  #assertRunCloseReservationReady(run: CoordinationRun): void {
    const allObservations = this.#db.prepare('SELECT * FROM observations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(observationFromRow);
    const unresolvedStaleObservations = allObservations.filter((stale) => stale.freshness === 'stale' && !allObservations.some((candidate) => {
      if (candidate.freshness !== 'current' || candidate.execution_state !== 'released' || candidate.recorded_event_seq <= stale.recorded_event_seq || candidate.path !== stale.path || stale.stale_by_commit === null) return false;
      const staleAttempt = this.#requireUnitAttempt(stale.owner.repo_id, stale.owner.workstream_run, stale.owner.unit_id, stale.owner.attempt);
      const candidateAttempt = this.#requireUnitAttempt(candidate.owner.repo_id, candidate.owner.workstream_run, candidate.owner.unit_id, candidate.owner.attempt);
      return staleAttempt.role === candidateAttempt.role && this.#gitCommitIsAncestor(run, stale.stale_by_commit, candidate.source_identity.base_commit);
    }));
    if (unresolvedStaleObservations.length > 0) throw new CoordinationRuntimeError('recovery-required', 'run close requires every stale observation to be refreshed or revalidated by a same-role terminal attempt; query status for exact identities', [`observation_count=${String(unresolvedStaleObservations.length)}`]);
    const activeLeases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(editLeaseFromRow);
    const nonCloseLeases = activeLeases.filter((lease) => lease.normal_release_condition.condition_type !== 'run-closed' || lease.normal_release_condition.target_id !== run.workstream_run);
    if (nonCloseLeases.length > 0) throw new CoordinationRuntimeError('recovery-required', 'run close requires every unit edit lease to be terminally released; query status for exact identities', [`lease_count=${String(nonCloseLeases.length)}`]);
    const obligations = this.#db.prepare('SELECT * FROM reservation_obligations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(reservationObligationFromRow);
    const unresolved = obligations.filter((entry) => entry.state !== 'resolved' && entry.state !== 'cancelled');
    if (unresolved.length > 0) throw new CoordinationRuntimeError('recovery-required', 'run close requires every reservation integration obligation to be resolved; query status for exact identities', [`obligation_count=${String(unresolved.length)}`]);
    for (const obligation of obligations.filter((entry) => entry.state === 'resolved')) this.#assertResolvedReservationObligationCurrent(run, obligation);
    const reservations = this.#db.prepare('SELECT * FROM change_reservations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(changeReservationFromRow);
    if (reservations.some((reservation) => reservation.released_event_seq !== null)) throw new CoordinationRuntimeError('invalid-state', 'run close found prematurely released change reservations');
    const mergeEvidence = this.#db.prepare("SELECT * FROM reconciliation_evidence WHERE repo_id=? AND workstream_run=? AND source='unit-merge' ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(reconciliationEvidenceFromRow);
    for (const accepted of mergeEvidence) {
      const evidence = accepted.release_condition.evidence;
      if (evidence === null) throw new CoordinationRuntimeError('store-corrupt', 'accepted unit merge lacks immutable evidence');
      const facts = parseUnitMergeReservationFacts(this.#verifyAcceptedEvidenceFile(run, 'unit-merge', accepted.release_condition.target_id, evidence));
      for (const path of facts.changedPaths) {
        if (!reservations.some((reservation) => reservation.path === path && reservation.merge_evidence.ref === evidence.ref && reservation.merge_evidence.sha256 === evidence.sha256)) throw new CoordinationRuntimeError('invalid-state', 'final close cannot ignore accepted unit-merge reservation evidence', [accepted.release_condition.target_id, path, evidence.ref]);
      }
    }
  }

  #assertResolvedReservationObligationCurrent(run: CoordinationRun, obligation: CoordinationReservationObligation): void {
    if (obligation.predecessor_released_event_seq === null || obligation.predecessor_terminal_sha === null || obligation.integration_evidence === null || obligation.validation_evidence === null) throw new CoordinationRuntimeError('store-corrupt', 'resolved reservation obligation lacks complete immutable proof', [obligation.obligation_id]);
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

  #terminalizeRunReservations(run: CoordinationRun, source: 'run-close' | 'run-abort', terminalSha: string, seq: number): readonly string[] {
    const staleObservationIds: string[] = [];
    const reservations = this.#db.prepare("SELECT * FROM change_reservations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.released_event_seq') IS NULL ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(changeReservationFromRow);
    for (const reservation of reservations) {
      const released = parseCoordinationChangeReservation({ ...reservation, released_event_seq: seq, terminal_outcome: source === 'run-close' ? 'closed' : 'aborted', terminal_sha: terminalSha, version: reservation.version + 1 });
      this.#db.prepare('UPDATE change_reservations SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(released), released.version, released.reservation_id);
      if (source === 'run-close') staleObservationIds.push(...this.#markOverlappingObservationsStale(run, released, terminalSha, seq));
      const dependent = this.#db.prepare("SELECT * FROM reservation_obligations WHERE repo_id=? AND predecessor_reservation_id=? AND json_extract(payload_json, '$.state')='waiting-for-predecessor' ORDER BY entity_id").all(run.repo_id, reservation.reservation_id).map(reservationObligationFromRow);
      for (const obligation of dependent) {
        const state = source === 'run-close' ? 'integration-required' : 'cancelled';
        const next = parseCoordinationReservationObligation({ ...obligation, state, predecessor_released_event_seq: source === 'run-close' ? seq : null, predecessor_terminal_sha: source === 'run-close' ? terminalSha : null, resolved_event_seq: source === 'run-abort' ? seq : null, version: obligation.version + 1 });
        this.#updateReservationObligation(next);
        if (source === 'run-close') this.#insertMessage({
          schema_version: 'autopilot.coordination_message.v1', message_id: stableEntityId('message', ['reservation-landed', obligation.obligation_id, String(seq)]), repo_id: run.repo_id,
          recipient_workstream_run: obligation.workstream_run, message_type: 'reservation-landed', correlation_id: obligation.obligation_id,
          payload: { obligation_id: obligation.obligation_id, predecessor_reservation_id: reservation.reservation_id, predecessor_released_event_seq: seq, predecessor_terminal_sha: terminalSha, overlapping_paths: obligation.overlapping_paths, integration_conflict: obligation.integration_conflict, required_action: obligation.integration_conflict.disposition === 'repair-required' ? 'create-integration-repair-and-revalidate' : 'integrate-and-revalidate' },
          status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
        });
      }
    }
    if (source === 'run-abort') {
      const owned = this.#db.prepare("SELECT * FROM reservation_obligations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.state') NOT IN ('resolved','cancelled') ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(reservationObligationFromRow);
      for (const obligation of owned) this.#updateReservationObligation(parseCoordinationReservationObligation({ ...obligation, state: 'cancelled', resolved_event_seq: seq, version: obligation.version + 1 }));
    }
    return Object.freeze(staleObservationIds);
  }

  #markOverlappingObservationsStale(run: CoordinationRun, reservation: CoordinationChangeReservation, terminalSha: string, seq: number): readonly string[] {
    const invalidatingAttempt = parseUnitAttemptTarget(this.#targetIdForMergeEvidence(run, reservation.merge_evidence));
    const observations = this.#db.prepare("SELECT * FROM observations WHERE repo_id=? AND freshness='current' ORDER BY entity_id").all(run.repo_id).map(observationFromRow).filter((observation) => observation.recorded_event_seq <= seq && coordinationPathsOverlap(observation.path, reservation.path) && !(observation.owner.workstream_run === reservation.workstream_run && observation.owner.unit_id === invalidatingAttempt.unitId && observation.owner.attempt === invalidatingAttempt.attempt) && !this.#gitCommitIsAncestor(run, terminalSha, observation.source_identity.base_commit));
    const staleIds: string[] = [];
    for (const observation of observations) {
      const stale = parseCoordinationObservation({ ...observation, freshness: 'stale', stale_event_seq: seq, stale_by_reservation_id: reservation.reservation_id, stale_by_commit: terminalSha, version: observation.version + 1 });
      this.#updateObservation(stale);
      staleIds.push(stale.observation_id);
      const messageId = stableEntityId('message', ['observation-stale', stale.observation_id, reservation.reservation_id, String(seq)]);
      if (this.#db.prepare('SELECT message_id FROM messages WHERE message_id=?').get(messageId) === undefined) this.#insertMessage({
        schema_version: 'autopilot.coordination_message.v1', message_id: messageId, repo_id: run.repo_id, recipient_workstream_run: stale.owner.workstream_run,
        message_type: 'observation-stale', correlation_id: stale.observation_id,
        payload: { observation_id: stale.observation_id, path: stale.path, observed_base_commit: stale.source_identity.base_commit, landed_reservation_id: reservation.reservation_id, landed_commit: terminalSha, required_action: 'refresh-or-revalidate-before-closure' },
        status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
      });
    }
    return Object.freeze(staleIds);
  }

  #releaseAttemptLeases(run: CoordinationRun, targetId: string): readonly string[] {
    const target = parseUnitAttemptTarget(targetId);
    const released: string[] = [];
    const leases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(editLeaseFromRow).filter((lease) => lease.owner.unit_id === target.unitId && lease.owner.attempt === target.attempt);
    for (const lease of leases) this.#releaseOwnedLease(run.repo_id, run.workstream_run, lease.edit_lease_id, released);
    return Object.freeze(released);
  }

  #releaseAllRunLeases(run: CoordinationRun): readonly string[] {
    const released: string[] = [];
    const leases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(editLeaseFromRow);
    for (const lease of leases) this.#releaseOwnedLease(run.repo_id, run.workstream_run, lease.edit_lease_id, released);
    return Object.freeze(released);
  }

  #preparedTerminalIntent(repoId: string, workstreamRun: string): CoordinationRunTerminalIntent | null {
    const row = this.#db.prepare("SELECT * FROM run_terminal_intents WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.state')='prepared' ORDER BY entity_id LIMIT 1").get(repoId, workstreamRun);
    return row === undefined ? null : runTerminalIntentFromRow(row);
  }

  #assertPreparedTerminalIntent(run: CoordinationRun, source: 'run-close' | 'run-abort'): CoordinationRunTerminalIntent | null {
    const intent = this.#preparedTerminalIntent(run.repo_id, run.workstream_run);
    const reservations = this.#db.prepare("SELECT entity_id FROM change_reservations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.released_event_seq') IS NULL ORDER BY entity_id").all(run.repo_id, run.workstream_run).map((row) => sqlString(row, 'entity_id'));
    if (intent === null) {
      if (reservations.length === 0) return null;
      throw new CoordinationRuntimeError('invalid-state', 'reservation-owning run terminal transition requires a prepared fenced intent');
    }
    const expectedOutcome = source === 'run-abort' ? 'aborted' : 'closed';
    if (intent.outcome !== expectedOutcome) throw new CoordinationRuntimeError('invalid-state', `prepared terminal intent outcome ${intent.outcome} does not match ${expectedOutcome}`);
    if (canonicalJson(intent.reservation_ids) !== canonicalJson(reservations)) throw new CoordinationRuntimeError('coordinator-contention', 'change reservation set drifted after terminal preparation', [...intent.reservation_ids, ...reservations]);
    const raw = parseJsonObject(sqlString(asRow(this.#db.prepare('SELECT payload_json FROM run_terminal_intents WHERE repo_id=? AND entity_id=?').get(run.repo_id, intent.terminal_intent_id), 'prepared terminal intent bytes'), 'payload_json'), 'prepared terminal intent bytes');
    if (raw['schema_version'] === 'autopilot.run_terminal_intent.v2') {
      const v2 = parseD65RunTerminalIntentV2(raw);
      const nonterminal = this.#db.prepare("SELECT * FROM reservation_obligations WHERE repo_id=? AND json_extract(payload_json, '$.state') IN ('waiting-for-predecessor','integration-required') ORDER BY entity_id").all(run.repo_id).map(reservationObligationFromRow);
      const recomputed = computeD65ObligationPartition({ workstreamRun: run.workstream_run, outcome: v2.outcome, intentReservationIds: reservations, nonterminalObligations: nonterminal });
      assertD65TerminalEffectSetsExact({ outcome: v2.outcome, requested: v2.terminal_effect_sets, computed: recomputed });
    }
    return intent;
  }

  /** Exhaustive D65 no-successor tail entry over the committed transaction state. */
  #assertD65TerminalTailEntry(run: CoordinationRun, source: 'run-close' | 'run-abort'): void {
    if (run.status !== 'merging') throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail requires a merging run');
    const compatible = this.#assertPreparedTerminalIntent(run, source);
    if (compatible === null) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail requires exactly one prepared v2 intent');
    const raw = parseJsonObject(sqlString(asRow(this.#db.prepare('SELECT payload_json FROM run_terminal_intents WHERE repo_id=? AND entity_id=?').get(run.repo_id, compatible.terminal_intent_id), 'D65 terminal tail intent'), 'payload_json'), 'D65 terminal tail intent');
    if (raw['schema_version'] !== 'autopilot.run_terminal_intent.v2') throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail cannot enter from a legacy intent');
    const intent = parseD65RunTerminalIntentV2(raw);
    if (intent.state !== 'prepared') throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail intent is not prepared');
    if (!this.#d65CompleteGraphCurrent(run.repo_id, run.workstream_run)) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail requires the accepted prepared-terminal graph B(N) plus only normalized liveness');
    const graphState = this.#d65AcceptedGraphState(run.repo_id, run.workstream_run);
    if (graphState.status !== 'completed' || graphState.closure_gate?.status !== 'passed' || graphState.closure_gate.blocking_reasons.length !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail requires a completed authority state with a passed unblocked closure gate');
    const nonterminalUnits = Object.entries(graphState.units).filter(([, unit]) => unit.state !== 'completed').map(([unitId]) => unitId);
    const nonterminalWorkItems = Object.entries(graphState.work_items ?? {}).filter(([, item]) => item.state !== 'closed').map(([workItemId]) => workItemId);
    if (nonterminalUnits.length !== 0 || nonterminalWorkItems.length !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail requires every file/work queue terminal with no held, ready, running, blocked, audit, or validation work', [...nonterminalUnits, ...nonterminalWorkItems]);
    const currentIntentCount = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM run_terminal_intents WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.state') IN ('prepared','committed')").get(run.repo_id, run.workstream_run), 'D65 terminal current intent count'), 'count');
    if (currentIntentCount !== 1) throw new CoordinationRuntimeError('store-corrupt', 'D65 terminal tail requires one derived current intent pointer', [`count=${String(currentIntentCount)}`]);
    const liveSessions = this.#db.prepare("SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? AND status IN ('attached','handoff-pending') ORDER BY session_generation").all(run.repo_id, run.workstream_run).map(sessionFromRow);
    if (liveSessions.length !== 1 || liveSessions[0]?.status !== 'attached' || liveSessions[0].attachment_kind !== 'dispatch' || liveSessions[0].session_generation !== run.active_session_generation) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail requires exactly one current attached dispatch session');
    const activeChildren = this.#db.prepare("SELECT * FROM child_leases WHERE repo_id=? AND workstream_run=? AND status!='terminal' ORDER BY child_lease_id").all(run.repo_id, run.workstream_run).map(childFromRow);
    if (activeChildren.length !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail has a nonterminal child', activeChildren.map((child) => child.child_lease_id));
    const nonterminalAttempts = this.#db.prepare("SELECT * FROM unit_attempts WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.state') IN ('queued','preflight','running') ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(unitAttemptFromRow);
    if (nonterminalAttempts.length !== 0 || this.#db.prepare("SELECT entity_id FROM unit_attempts WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.critical_section') IS NOT NULL LIMIT 1").get(run.repo_id, run.workstream_run) !== undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail has a nonterminal attempt or active critical section', nonterminalAttempts.map((attempt) => `${attempt.owner.unit_id}:${String(attempt.owner.attempt)}`));
    if (this.#activeRunFaults(run.repo_id, run.workstream_run).length !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail has an active run-scoped fault');
    if (this.#db.prepare("SELECT entity_id FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? AND status='pending' LIMIT 1").get(run.repo_id, run.workstream_run) !== undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail has pending migration recovery');
    const assignments = this.#db.prepare("SELECT entity_id FROM adjudication_assignments WHERE repo_id=? AND json_extract(payload_json, '$.state')='assigned' AND (json_extract(payload_json, '$.requesting_run')=? OR EXISTS(SELECT 1 FROM json_each(json_extract(payload_json, '$.participating_runs')) WHERE value=?)) LIMIT 1").get(run.repo_id, run.workstream_run, run.workstream_run);
    if (assignments !== undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail has a pending adjudication assignment');
    if (this.#db.prepare("SELECT entity_id FROM escalations WHERE repo_id=? AND EXISTS(SELECT 1 FROM json_each(json_extract(payload_json, '$.participating_runs')) WHERE value=?) LIMIT 1").get(run.repo_id, run.workstream_run) !== undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail has an unresolved escalation');
    if (this.#db.prepare("SELECT message_id FROM messages WHERE repo_id=? AND recipient_workstream_run=? AND status!='acknowledged' LIMIT 1").get(run.repo_id, run.workstream_run) !== undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail has an unacknowledged mailbox item');
    const activeEdges = this.#db.prepare("SELECT * FROM wait_for_edges WHERE repo_id=? AND json_extract(payload_json, '$.state')='active' AND (json_extract(payload_json, '$.requester.workstream_run')=? OR json_extract(payload_json, '$.blocker.workstream_run')=?) ORDER BY entity_id").all(run.repo_id, run.workstream_run, run.workstream_run).map(waitForEdgeFromRow);
    if (activeEdges.length !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail has an active wait edge', activeEdges.map((edge) => edge.edge_id));
    const openDeadlocks = this.#db.prepare("SELECT * FROM deadlock_resolutions WHERE repo_id=? AND json_extract(payload_json, '$.state')!='resolved' ORDER BY entity_id").all(run.repo_id).map(deadlockResolutionFromRow).filter((resolution) => resolution.victim?.workstream_run === run.workstream_run || resolution.cycle_edge_ids.some((id) => activeEdges.some((edge) => edge.edge_id === id)));
    if (openDeadlocks.length !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail has an open deadlock', openDeadlocks.map((resolution) => resolution.resolution_id));
    const badObservations = this.#db.prepare("SELECT * FROM observations WHERE repo_id=? AND workstream_run=? AND (execution_state NOT IN ('released','cancelled') OR freshness='stale') ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(observationFromRow);
    if (badObservations.length !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail has active/abandoned/stale observations', badObservations.map((observation) => observation.observation_id));
    const operations = this.#db.prepare("SELECT * FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.stage') NOT IN ('committed','compensated','failed') ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(worktreeOperationFromRow);
    if (operations.length !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail has a nonterminal worktree operation', operations.map((operation) => operation.operation_id));
    const worktrees = this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND is_current_canonical=1 AND json_extract(payload_json, '$.state') NOT IN ('active','terminal','removed') ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(canonicalWorktreeFromRow);
    if (worktrees.length !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail has a dirty, quarantined, or unresolved worktree', worktrees.map((worktree) => worktree.worktree_id));
    const groups = this.#db.prepare("SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? ORDER BY entity_id").all(run.repo_id, run.workstream_run).map(acquisitionGroupFromRow);
    const activeLeases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(editLeaseFromRow);
    for (const lease of activeLeases) if (lease.normal_release_condition.condition_type !== 'run-closed' || lease.normal_release_condition.target_id !== run.workstream_run) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail active lease is not exact close-owned authority', [lease.edit_lease_id]);
    const activeLeaseGroups = new Set(activeLeases.map((lease) => lease.acquisition_group_id));
    for (const group of groups) {
      if (group.state === 'waiting' || group.state === 'grant-ready') throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail has a waiting or grant-ready acquisition group', [group.acquisition_group_id]);
      if (group.state === 'granted' && !activeLeaseGroups.has(group.acquisition_group_id)) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail granted group has no exact close-owned lease', [group.acquisition_group_id]);
    }
    const resource = runResourceFromRow(asRow(this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run), 'D65 terminal tail resource'));
    if (readD65GraphPublicationResidue(resource.main_worktree_path) !== null) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail cannot enter with graph publication residue');
  }

  /** Replay the exact no-reentry suffix from the last accepted graph R. */
  #assertD65TerminalTailPrefix(run: CoordinationRun, reservedEventSeq?: number): void {
    const graphArtifact = authoritativeArtifactFromRow(asRow(this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.semantic_graph.v1' ORDER BY entity_id DESC LIMIT 1").get(run.repo_id, run.workstream_run), 'D65 terminal tail graph'));
    const repositorySeq = sqlInteger(asRow(this.#db.prepare('SELECT event_seq FROM repositories WHERE repo_id=?').get(run.repo_id), 'D65 terminal tail repository sequence'), 'event_seq');
    if (reservedEventSeq !== undefined && reservedEventSeq !== repositorySeq) throw new CoordinationRuntimeError('store-corrupt', 'D65 terminal tail reserved event is not the current transaction sequence', [String(reservedEventSeq), String(repositorySeq)]);
    const acceptedRepositorySeq = reservedEventSeq === undefined ? repositorySeq : repositorySeq - 1;
    const rows = this.#db.prepare("SELECT e.*,r.repo_id AS result_repo_id,r.idempotency_key AS result_key,r.request_sha256 AS result_request,r.committed_event_seq AS result_seq,r.payload_json AS result_payload FROM events e LEFT JOIN idempotency_results r ON r.repo_id=e.repo_id AND r.idempotency_key=e.idempotency_key WHERE e.repo_id=? AND e.event_seq>? ORDER BY e.event_seq").all(run.repo_id, graphArtifact.registered_event_seq);
    if (rows.length !== acceptedRepositorySeq - graphArtifact.registered_event_seq) throw new CoordinationRuntimeError('store-corrupt', 'D65 terminal tail event range is not contiguous from accepted R', [`rows=${String(rows.length)}`, `repository_seq=${String(acceptedRepositorySeq)}`, `graph_registration_seq=${String(graphArtifact.registered_event_seq)}`]);
    let released = false;
    let detached = false;
    for (let index = 0; index < rows.length; index += 1) {
      const row = asRow(rows[index], 'D65 terminal tail event');
      const eventSeq = sqlInteger(row, 'event_seq');
      if (eventSeq !== graphArtifact.registered_event_seq + index + 1) throw new CoordinationRuntimeError('store-corrupt', 'D65 terminal tail event sequence has a gap', [String(eventSeq)]);
      const eventKey = sqlString(row, 'idempotency_key');
      const eventRequest = sqlString(row, 'request_sha256');
      if (sqlNullableString(row, 'result_repo_id') !== run.repo_id || sqlNullableString(row, 'result_key') !== eventKey || sqlNullableString(row, 'result_request') !== eventRequest || sqlNullableInteger(row, 'result_seq') !== eventSeq) throw new CoordinationRuntimeError('store-corrupt', 'D65 terminal tail event lacks its exact immutable idempotency result', [String(eventSeq), eventKey]);
      const payloadText = sqlNullableString(row, 'result_payload');
      if (payloadText === null) throw new CoordinationRuntimeError('store-corrupt', 'D65 terminal tail event result payload is missing', [String(eventSeq)]);
      const payload = parseJsonObject(payloadText, 'D65 terminal tail result payload');
      const eventType = sqlString(row, 'event_type');
      if (detached) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail contains an event after final session detach', [String(eventSeq), eventType]);
      if (eventType === 'session-heartbeat') {
        if (released) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail contains an unnecessary session heartbeat after its first terminal effect', [String(eventSeq)]);
        const joined: D65AcceptedEventResultJoin = { repo_id: run.repo_id, event_seq: eventSeq, event_type: eventType, entity_type: sqlString(row, 'entity_type'), entity_id: sqlString(row, 'entity_id'), idempotency_key: eventKey, request_sha256: eventRequest, result: { repo_id: run.repo_id, idempotency_key: eventKey, request_sha256: eventRequest, committed_event_seq: eventSeq, payload } };
        if (!isPureD65SessionHeartbeat(joined)) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail contains a semantic session heartbeat');
        continue;
      }
      if (eventType === 'program-heartbeat-accepted') {
        if (released) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail contains an unnecessary program heartbeat after its first terminal effect', [String(eventSeq)]);
        parseD65HeartbeatAcceptanceResult(payload);
        continue;
      }
      if (!released) {
        if (eventType !== 'release-evidence-accepted' || sqlString(row, 'entity_type') !== 'reconciliation-evidence') throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail first semantic event is not exact release-evidence-accepted', [String(eventSeq), eventType]);
        const terminalRun = parseCoordinationRun(payload['run']);
        if (terminalRun.repo_id !== run.repo_id || terminalRun.workstream_run !== run.workstream_run || (terminalRun.status !== 'closed' && terminalRun.status !== 'aborted')) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal first event result does not bind the terminal run');
        released = true;
        continue;
      }
      if (eventType === 'worktree-operation-prepared' || eventType.startsWith('worktree-operation-')) {
        const operation = parseCoordinationWorktreeOperation(payload['operation']);
        if (operation.owner.repo_id !== run.repo_id || operation.owner.workstream_run !== run.workstream_run || operation.owner.unit_id !== 'main' || (operation.operation_type !== 'archive' && operation.operation_type !== 'remove')) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail contains a non-cleanup worktree operation', [operation.operation_id, operation.operation_type]);
        continue;
      }
      if (eventType === 'terminal-cleanup-recovery-attached') {
        const session = parseCoordinationSessionLease(payload['session']);
        const predecessor = parseCoordinationSessionLease(payload['predecessor_session']);
        if (session.repo_id !== run.repo_id || session.workstream_run !== run.workstream_run || session.attachment_kind !== 'terminal-recovery' || predecessor.repo_id !== run.repo_id || predecessor.workstream_run !== run.workstream_run || predecessor.status !== 'fenced' || predecessor.session_generation >= session.session_generation) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal recovery event identity/postimage is invalid');
        continue;
      }
      if (eventType === 'session-detached') {
        const session = parseCoordinationSessionLease(payload['session']);
        if (session.repo_id !== run.repo_id || session.workstream_run !== run.workstream_run) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal detach event names a foreign session');
        detached = true;
        continue;
      }
      throw new CoordinationRuntimeError('invalid-state', 'D65 terminal tail contains a forbidden semantic event', [String(eventSeq), eventType]);
    }
    if ((run.status === 'closed' || run.status === 'aborted') && !released) throw new CoordinationRuntimeError('store-corrupt', 'terminal D65 run has no release-evidence-accepted first effect after accepted R');
    if (run.status === 'merging' && released) throw new CoordinationRuntimeError('store-corrupt', 'merging D65 run already contains a terminal commit in its tail');
  }

  #assertD65TerminalTailFinalBeforeDetach(run: CoordinationRun, sessionLeaseId: string): void {
    const intentRow = asRow(this.#db.prepare("SELECT payload_json FROM run_terminal_intents WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.state')='committed' ORDER BY entity_id DESC LIMIT 1").get(run.repo_id, run.workstream_run), 'D65 final terminal intent');
    const intent = parseD65RunTerminalIntentV2(parseJsonObject(sqlString(intentRow, 'payload_json'), 'D65 final terminal intent'));
    if ((run.status === 'closed' ? 'closed' : 'aborted') !== intent.outcome || intent.terminal_event_seq === null) throw new CoordinationRuntimeError('store-corrupt', 'D65 final run and committed intent do not match');
    const liveSessions = this.#db.prepare("SELECT session_lease_id FROM session_leases WHERE repo_id=? AND workstream_run=? AND status IN ('attached','handoff-pending') ORDER BY session_generation").all(run.repo_id, run.workstream_run).map((row) => sqlString(row, 'session_lease_id'));
    if (liveSessions.length !== 1 || liveSessions[0] !== sessionLeaseId) throw new CoordinationRuntimeError('invalid-state', 'D65 final detach requires the sole current attached session', liveSessions);
    const activeChild = this.#db.prepare("SELECT child_lease_id FROM child_leases WHERE repo_id=? AND workstream_run=? AND status!='terminal' LIMIT 1").get(run.repo_id, run.workstream_run);
    const activeFault = this.#db.prepare("SELECT fault_id FROM run_scoped_faults WHERE repo_id=? AND workstream_run=? AND status='active' LIMIT 1").get(run.repo_id, run.workstream_run);
    const activeLease = this.#db.prepare('SELECT entity_id FROM edit_leases WHERE repo_id=? AND workstream_run=? LIMIT 1').get(run.repo_id, run.workstream_run);
    const activeReservation = this.#db.prepare("SELECT entity_id FROM change_reservations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.released_event_seq') IS NULL LIMIT 1").get(run.repo_id, run.workstream_run);
    const ownedObligation = this.#db.prepare("SELECT entity_id FROM reservation_obligations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.state') IN ('waiting-for-predecessor','integration-required') LIMIT 1").get(run.repo_id, run.workstream_run);
    const activeOperation = this.#db.prepare("SELECT entity_id FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.stage') NOT IN ('committed','compensated','failed') LIMIT 1").get(run.repo_id, run.workstream_run);
    if (activeChild !== undefined || activeFault !== undefined || activeLease !== undefined || activeReservation !== undefined || ownedObligation !== undefined || activeOperation !== undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 final tail retains source-run child/fault/lease/reservation/obligation/operation authority');
    const remainingWorktrees = this.#db.prepare("SELECT entity_id FROM worktrees WHERE repo_id=? AND workstream_run=? AND is_current_canonical=1 AND json_extract(payload_json, '$.state')!='removed' ORDER BY entity_id").all(run.repo_id, run.workstream_run).map((row) => sqlString(row, 'entity_id'));
    if (remainingWorktrees.length !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 final tail requires every owned worktree removed', remainingWorktrees);
    for (const sealed of intent.terminal_effect_sets.foreign_dependent_obligations) {
      const prior = parseCoordinationReservationObligation(sealed);
      const current = reservationObligationFromRow(asRow(this.#db.prepare('SELECT * FROM reservation_obligations WHERE repo_id=? AND entity_id=?').get(run.repo_id, prior.obligation_id), 'D65 final foreign obligation'));
      const state = intent.outcome === 'closed' ? 'integration-required' : 'cancelled';
      if (current.version !== prior.version + 1 || current.state !== state || (intent.outcome === 'closed' ? current.predecessor_released_event_seq !== intent.terminal_event_seq || current.predecessor_terminal_sha === null : current.resolved_event_seq !== intent.terminal_event_seq)) throw new CoordinationRuntimeError('invalid-state', 'D65 final foreign obligation differs from its sealed version+1 postimage', [prior.obligation_id]);
    }
    for (const sealed of intent.terminal_effect_sets.abort_owned_obligations) {
      const prior = parseCoordinationReservationObligation(sealed);
      const current = reservationObligationFromRow(asRow(this.#db.prepare('SELECT * FROM reservation_obligations WHERE repo_id=? AND entity_id=?').get(run.repo_id, prior.obligation_id), 'D65 final abort-owned obligation'));
      if (current.version !== prior.version + 1 || current.state !== 'cancelled' || current.resolved_event_seq !== intent.terminal_event_seq) throw new CoordinationRuntimeError('invalid-state', 'D65 final abort-owned obligation differs from its sealed version+1 postimage', [prior.obligation_id]);
    }
    if (this.#db.prepare("SELECT entity_id FROM reservation_obligations WHERE repo_id=? AND json_extract(payload_json, '$.state')='waiting-for-predecessor' AND predecessor_reservation_id IN (SELECT entity_id FROM change_reservations WHERE repo_id=? AND workstream_run=?) LIMIT 1").get(run.repo_id, run.repo_id, run.workstream_run) !== undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 final tail retains a predecessor-linked waiting obligation');
    const session = sessionFromRow(asRow(this.#db.prepare('SELECT * FROM session_leases WHERE repo_id=? AND session_lease_id=?').get(run.repo_id, sessionLeaseId), 'D65 final session'));
    // The terminal tail deliberately consumes NO heartbeat after its first
    // semantic effect. Therefore the prepared-graph heartbeat's status/doctor
    // digest is expected to be stale after commit; requiring a newly governing
    // heartbeat here would contradict the closed no-reentry suffix. Revalidate
    // instead its signed bytes, time, graph/policy/session tuple and exact
    // precommit terminal-tail reason while #assertD65TerminalTailPrefix proves
    // no postcommit acceptance exists.
    const coordinatorTime = this.#clock.now().toISOString();
    const acceptedPolicy = this.#d65AcceptedLaunchPolicy(run.repo_id, run.workstream_run);
    const heartbeatHead = this.#highestAcceptedProgramHeartbeat(run.repo_id, run.workstream_run);
    if (heartbeatHead === null) throw new CoordinationRuntimeError('invalid-state', 'D65 final tail lacks its prepared-graph heartbeat authority');
    const verified = this.#d65VerifyAcceptedHeartbeatHead(heartbeatHead, acceptedPolicy, run, coordinatorTime);
    const graphHead = this.#d65AcceptedGraphHead(run.repo_id, run.workstream_run);
    if (heartbeatHead.acceptance_kind !== 'governing' || Date.parse(heartbeatHead.issued_at) > Date.parse(coordinatorTime) || Date.parse(coordinatorTime) >= Date.parse(heartbeatHead.valid_until) || verified.row.accepted_graph_sequence !== graphHead.sequence || verified.row.accepted_graph_sha256 !== graphHead.sha256 || verified.row.launch_policy_sha256 !== acceptedPolicy.artifact.evidence.sha256 || verified.row.coordinator_session_lease_id !== session.session_lease_id || verified.heartbeat.stop_reasons.length !== 0 || !verified.row.stop_reasons.includes('terminal-tail')) throw new CoordinationRuntimeError('invalid-state', 'D65 final tail lacks the exact valid prepared-graph terminal heartbeat tuple');
  }

  #captureD65TerminalFirstEffectBaseline(run: CoordinationRun): D65TerminalFirstEffectBaseline {
    const rawIntent = parseJsonObject(sqlString(asRow(this.#db.prepare("SELECT payload_json FROM run_terminal_intents WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.state')='prepared'").get(run.repo_id, run.workstream_run), 'D65 terminal baseline intent'), 'payload_json'), 'D65 terminal baseline intent');
    const forbidden = {
      resource: this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').all(run.repo_id, run.workstream_run).map(runResourceFromRow),
      sessions: this.#db.prepare('SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? ORDER BY session_generation').all(run.repo_id, run.workstream_run).map(sessionFromRow),
      children: this.#db.prepare('SELECT * FROM child_leases WHERE repo_id=? AND workstream_run=? ORDER BY child_lease_id').all(run.repo_id, run.workstream_run).map(childFromRow),
      attempts: this.#db.prepare('SELECT * FROM unit_attempts WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(unitAttemptFromRow),
      faults: this.#db.prepare('SELECT * FROM run_scoped_faults WHERE repo_id=? AND workstream_run=? ORDER BY fault_id').all(run.repo_id, run.workstream_run).map(runScopedFaultFromRow),
      worktrees: this.#db.prepare('SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND is_current_canonical=1 ORDER BY canonical_worktree_id').all(run.repo_id, run.workstream_run).map(canonicalWorktreeFromRow),
      operations: this.#db.prepare('SELECT * FROM worktree_operations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(worktreeOperationFromRow),
      artifacts: this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(authoritativeArtifactFromRow),
      adjudications: this.#db.prepare('SELECT * FROM adjudication_assignments WHERE repo_id=? ORDER BY entity_id').all(run.repo_id).map(adjudicationAssignmentFromRow),
      escalations: this.#db.prepare('SELECT * FROM escalations WHERE repo_id=? ORDER BY entity_id').all(run.repo_id).map(escalationFromRow),
      migration: this.#db.prepare('SELECT * FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(migrationRecoveryFromRow),
    };
    return Object.freeze({
      run,
      intent: parseD65RunTerminalIntentV2(rawIntent),
      reservations: Object.freeze(this.#db.prepare('SELECT * FROM change_reservations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(changeReservationFromRow)),
      obligations: Object.freeze(this.#db.prepare('SELECT * FROM reservation_obligations WHERE repo_id=? ORDER BY entity_id').all(run.repo_id).map(reservationObligationFromRow)),
      leases: Object.freeze(this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(editLeaseFromRow)),
      groups: Object.freeze(this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(acquisitionGroupFromRow)),
      forbidden_bytes: canonicalJson(forbidden),
    });
  }

  #assertD65TerminalFirstEffectExact(baseline: D65TerminalFirstEffectBaseline, source: 'run-close' | 'run-abort', terminalSha: string, seq: number): void {
    const run = this.#requireRun(baseline.run.repo_id, baseline.run.workstream_run);
    const expectedRun = parseCoordinationRun({ ...baseline.run, status: source === 'run-close' ? 'closed' : 'aborted', version: baseline.run.version + 1 });
    if (canonicalJson(run) !== canonicalJson(expectedRun)) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal first effect changed the run outside its exact status/version postimage');
    const currentReservations = this.#db.prepare('SELECT * FROM change_reservations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(changeReservationFromRow);
    const terminalReservationIds = new Set(baseline.intent.reservation_ids);
    const expectedReservations = baseline.reservations.map((reservation) => terminalReservationIds.has(reservation.reservation_id) ? parseCoordinationChangeReservation({ ...reservation, released_event_seq: seq, terminal_outcome: source === 'run-close' ? 'closed' : 'aborted', terminal_sha: terminalSha, version: reservation.version + 1 }) : reservation);
    if (canonicalJson(currentReservations) !== canonicalJson(expectedReservations)) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal first effect does not equal the sealed reservation postimages');
    const remainingLeases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(editLeaseFromRow);
    if (remainingLeases.length !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal first effect did not release exactly all close-owned leases', remainingLeases.map((lease) => lease.edit_lease_id));
    const releasedGroupIds = new Set(baseline.leases.map((lease) => lease.acquisition_group_id));
    const expectedGroups = baseline.groups.map((group) => group.state === 'granted' && releasedGroupIds.has(group.acquisition_group_id) ? parseCoordinationAcquisitionGroup({ ...group, state: 'released', version: group.version + 1 }) : group);
    const currentGroups = this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(acquisitionGroupFromRow);
    if (canonicalJson(currentGroups) !== canonicalJson(expectedGroups)) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal first effect changed acquisition groups outside exact close-owned release');
    const sealedRows = [...baseline.intent.terminal_effect_sets.foreign_dependent_obligations, ...baseline.intent.terminal_effect_sets.abort_owned_obligations].map(parseCoordinationReservationObligation);
    const sealedIds = new Set(sealedRows.map((obligation) => obligation.obligation_id));
    const expectedObligations = baseline.obligations.map((obligation) => {
      if (!sealedIds.has(obligation.obligation_id)) return obligation;
      if (source === 'run-close') return parseCoordinationReservationObligation({ ...obligation, state: 'integration-required', predecessor_released_event_seq: seq, predecessor_terminal_sha: terminalSha, version: obligation.version + 1 });
      return parseCoordinationReservationObligation({ ...obligation, state: 'cancelled', predecessor_released_event_seq: null, predecessor_terminal_sha: null, resolved_event_seq: seq, version: obligation.version + 1 });
    });
    const currentObligations = this.#db.prepare('SELECT * FROM reservation_obligations WHERE repo_id=? ORDER BY entity_id').all(run.repo_id).map(reservationObligationFromRow);
    if (canonicalJson(currentObligations) !== canonicalJson(expectedObligations)) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal first effect changed an obligation outside the sealed exact version+1 postimages');
    const currentIntentRaw = parseJsonObject(sqlString(asRow(this.#db.prepare('SELECT payload_json FROM run_terminal_intents WHERE repo_id=? AND entity_id=?').get(run.repo_id, baseline.intent.terminal_intent_id), 'D65 terminal first-effect intent'), 'payload_json'), 'D65 terminal first-effect intent');
    const expectedIntent = parseD65RunTerminalIntentV2({ ...baseline.intent, state: 'committed', terminal_event_seq: seq, version: baseline.intent.version + 1 });
    if (canonicalJson(parseD65RunTerminalIntentV2(currentIntentRaw)) !== canonicalJson(expectedIntent)) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal first effect does not equal the sealed intent commit postimage');
    const forbidden = {
      resource: this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').all(run.repo_id, run.workstream_run).map(runResourceFromRow),
      sessions: this.#db.prepare('SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? ORDER BY session_generation').all(run.repo_id, run.workstream_run).map(sessionFromRow),
      children: this.#db.prepare('SELECT * FROM child_leases WHERE repo_id=? AND workstream_run=? ORDER BY child_lease_id').all(run.repo_id, run.workstream_run).map(childFromRow),
      attempts: this.#db.prepare('SELECT * FROM unit_attempts WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(unitAttemptFromRow),
      faults: this.#db.prepare('SELECT * FROM run_scoped_faults WHERE repo_id=? AND workstream_run=? ORDER BY fault_id').all(run.repo_id, run.workstream_run).map(runScopedFaultFromRow),
      worktrees: this.#db.prepare('SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND is_current_canonical=1 ORDER BY canonical_worktree_id').all(run.repo_id, run.workstream_run).map(canonicalWorktreeFromRow),
      operations: this.#db.prepare('SELECT * FROM worktree_operations WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(worktreeOperationFromRow),
      artifacts: this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(authoritativeArtifactFromRow),
      adjudications: this.#db.prepare('SELECT * FROM adjudication_assignments WHERE repo_id=? ORDER BY entity_id').all(run.repo_id).map(adjudicationAssignmentFromRow),
      escalations: this.#db.prepare('SELECT * FROM escalations WHERE repo_id=? ORDER BY entity_id').all(run.repo_id).map(escalationFromRow),
      migration: this.#db.prepare('SELECT * FROM migration_recovery_work WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(run.repo_id, run.workstream_run).map(migrationRecoveryFromRow),
    };
    if (canonicalJson(forbidden) !== baseline.forbidden_bytes) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal first effect changed forbidden child/attempt/fault/worktree/artifact/adjudication/migration authority');
  }

  #commitTerminalIntent(intent: CoordinationRunTerminalIntent, seq: number): void {
    const row = asRow(this.#db.prepare('SELECT payload_json FROM run_terminal_intents WHERE entity_id=?').get(intent.terminal_intent_id), 'prepared terminal intent commit bytes');
    const raw = parseJsonObject(sqlString(row, 'payload_json'), 'prepared terminal intent commit bytes');
    if (raw['schema_version'] === 'autopilot.run_terminal_intent.v2') {
      const v2 = parseD65RunTerminalIntentV2(raw);
      // First-effect equality: every sealed foreign/abort-owned obligation must
      // now be exactly its version+1 prescribed postimage; no inferred row.
      for (const sealed of v2.terminal_effect_sets.foreign_dependent_obligations) {
        const prior = parseCoordinationReservationObligation(sealed);
        const current = reservationObligationFromRow(asRow(this.#db.prepare('SELECT * FROM reservation_obligations WHERE repo_id=? AND entity_id=?').get(v2.repo_id, prior.obligation_id), 'terminal foreign dependent postimage'));
        const expectedState = v2.outcome === 'closed' ? 'integration-required' : 'cancelled';
        if (current.version !== prior.version + 1 || current.state !== expectedState || (v2.outcome === 'closed' ? current.predecessor_released_event_seq !== seq || current.predecessor_terminal_sha === null : current.resolved_event_seq !== seq || current.predecessor_released_event_seq !== null || current.predecessor_terminal_sha !== null)) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal first effect does not equal sealed foreign-dependent obligation postimages', [prior.obligation_id]);
      }
      for (const sealed of v2.terminal_effect_sets.abort_owned_obligations) {
        const prior = parseCoordinationReservationObligation(sealed);
        const current = reservationObligationFromRow(asRow(this.#db.prepare('SELECT * FROM reservation_obligations WHERE repo_id=? AND entity_id=?').get(v2.repo_id, prior.obligation_id), 'terminal abort-owned postimage'));
        if (v2.outcome !== 'aborted' || current.version !== prior.version + 1 || current.state !== 'cancelled' || current.resolved_event_seq !== seq) throw new CoordinationRuntimeError('invalid-state', 'D65 terminal first effect does not equal sealed abort-owned obligation postimages', [prior.obligation_id]);
      }
      const committed = parseD65RunTerminalIntentV2({ ...v2, state: 'committed', terminal_event_seq: seq, version: v2.version + 1 });
      const result = this.#db.prepare('UPDATE run_terminal_intents SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(committed), committed.version, committed.terminal_intent_id);
      if (result.changes !== 1) throw new CoordinationRuntimeError('invalid-state', 'prepared D65 terminal intent disappeared during commit');
      return;
    }
    const committed = parseCoordinationRunTerminalIntent({ ...intent, state: 'committed', terminal_event_seq: seq, version: intent.version + 1 });
    const result = this.#db.prepare('UPDATE run_terminal_intents SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(committed), committed.version, committed.terminal_intent_id);
    if (result.changes !== 1) throw new CoordinationRuntimeError('invalid-state', 'prepared run terminal intent disappeared during commit');
  }

  #insertReservationObligation(obligation: CoordinationReservationObligation): void {
    this.#db.prepare('INSERT INTO reservation_obligations(entity_id, repo_id, workstream_run, reservation_id, predecessor_reservation_id, payload_json, version) VALUES(?, ?, ?, ?, ?, ?, ?)').run(obligation.obligation_id, obligation.repo_id, obligation.workstream_run, obligation.reservation_id, obligation.predecessor_reservation_id, canonicalJson(obligation), obligation.version);
  }

  #updateReservationObligation(obligation: CoordinationReservationObligation): void {
    const result = this.#db.prepare('UPDATE reservation_obligations SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(obligation), obligation.version, obligation.obligation_id);
    if (result.changes !== 1) throw new CoordinationRuntimeError('invalid-state', `reservation obligation ${obligation.obligation_id} disappeared during mutation`);
  }

  #conditionSatisfied(repoId: string, workstreamRun: string, condition: CoordinationReleaseCondition): boolean {
    if (condition.condition_type === 'explicit-owner-release') return false;
    if (condition.condition_type === 'child-terminal') {
      const row = this.#db.prepare("SELECT * FROM child_leases WHERE repo_id=? AND workstream_run=? AND child_lease_id=? AND status='terminal'").get(repoId, workstreamRun, condition.target_id);
      if (row !== undefined) {
        const child = childFromRow(row);
        if (child.terminal_evidence === null) throw new CoordinationRuntimeError('store-corrupt', 'terminal child fact lacks immutable evidence');
        this.#verifyAcceptedEvidenceFile(this.#requireRun(repoId, workstreamRun), 'child-process', condition.target_id, child.terminal_evidence);
        return true;
      }
    }
    if (condition.condition_type === 'run-closed') {
      const run = this.#requireRun(repoId, workstreamRun);
      if (condition.target_id === workstreamRun && (run.status === 'closed' || run.status === 'aborted')) return true;
    }
    return this.#db.prepare("SELECT entity_id FROM reconciliation_evidence WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.release_condition.condition_type')=? AND target_id=? LIMIT 1").get(repoId, workstreamRun, condition.condition_type, condition.target_id) !== undefined;
  }

  #acceptReconciliationEvidence(input: { readonly repoId: string; readonly workstreamRun: string; readonly source: CoordinationReconciliationSource; readonly targetId: string; readonly evidence: { readonly ref: string; readonly sha256: `sha256:${string}` }; readonly seq: number }): CoordinationReconciliationEvidence {
    const run = this.#requireRun(input.repoId, input.workstreamRun);
    this.#verifyAcceptedEvidenceFile(run, input.source, input.targetId, input.evidence, input.seq);
    const conditionType = this.#conditionTypeForSource(input.source);
    this.#assertReconciliationTarget(run, conditionType, input.targetId);
    const entityId = stableEntityId('reconciliation-evidence', [input.repoId, input.workstreamRun, input.source, input.targetId, input.evidence.ref, input.evidence.sha256]);
    const existing = this.#db.prepare('SELECT * FROM reconciliation_evidence WHERE entity_id=?').get(entityId);
    if (existing !== undefined) return reconciliationEvidenceFromRow(existing);
    const evidence: CoordinationReconciliationEvidence = {
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

  #readRunEvidenceFile(run: CoordinationRun, evidence: { readonly ref: string; readonly sha256: `sha256:${string}` }): Uint8Array {
    const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'evidence repository'));
    const worktreesRoot = resolve(this.#stateRoot, 'worktrees');
    const runMainRoot = resolve(worktreesRoot, repository.repo_key, 'active', run.workstream_run, 'main');
    const relativeRunRoot = relative(worktreesRoot, runMainRoot);
    if (relativeRunRoot.length === 0 || relativeRunRoot === '..' || relativeRunRoot.startsWith(`..${sep}`) || isAbsolute(relativeRunRoot)) throw new CoordinationRuntimeError('unauthorized-client', 'durable run identity escapes the package-owned worktree root');
    const evidencePath = resolve(runMainRoot, evidence.ref);
    const relativeEvidence = relative(runMainRoot, evidencePath);
    if (relativeEvidence.length === 0 || relativeEvidence === '..' || relativeEvidence.startsWith(`..${sep}`) || isAbsolute(relativeEvidence)) throw new CoordinationRuntimeError('unauthorized-client', 'accepted evidence escapes the run-owned main worktree');
    let bytes: Uint8Array;
    let descriptor: number | null = null;
    try {
      const evidenceStat = lstatSync(evidencePath);
      if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink() || evidenceStat.size > MAX_COORDINATION_EVIDENCE_BYTES) throw new CoordinationRuntimeError('unauthorized-client', 'accepted evidence must be a bounded regular non-symbolic file', [evidencePath]);
      const realRunRoot = realpathSync(runMainRoot);
      const realEvidencePath = realpathSync(evidencePath);
      const relativeRealEvidence = relative(realRunRoot, realEvidencePath);
      if (relativeRealEvidence.length === 0 || relativeRealEvidence === '..' || relativeRealEvidence.startsWith(`..${sep}`) || isAbsolute(relativeRealEvidence)) throw new CoordinationRuntimeError('unauthorized-client', 'accepted evidence resolves outside the run-owned main worktree', [evidencePath, realEvidencePath]);
      descriptor = openSync(evidencePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== evidenceStat.dev || opened.ino !== evidenceStat.ino || opened.size !== evidenceStat.size || opened.mtimeMs !== evidenceStat.mtimeMs || opened.ctimeMs !== evidenceStat.ctimeMs) throw new CoordinationRuntimeError('recovery-required', 'accepted evidence identity changed while opening', [evidencePath]);
      bytes = readFileSync(descriptor);
      const afterDescriptor = fstatSync(descriptor);
      const afterPath = lstatSync(evidencePath);
      if (bytes.byteLength !== opened.size || afterDescriptor.dev !== opened.dev || afterDescriptor.ino !== opened.ino || afterDescriptor.size !== opened.size || afterDescriptor.mtimeMs !== opened.mtimeMs || afterDescriptor.ctimeMs !== opened.ctimeMs || afterPath.isSymbolicLink() || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino || afterPath.size !== opened.size || afterPath.mtimeMs !== opened.mtimeMs || afterPath.ctimeMs !== opened.ctimeMs) throw new CoordinationRuntimeError('recovery-required', 'accepted evidence identity changed during descriptor read', [evidencePath]);
    } catch (error) {
      if (error instanceof CoordinationRuntimeError) throw error;
      throw new CoordinationRuntimeError('recovery-required', 'accepted evidence file is unreadable', [evidencePath, error instanceof Error ? error.message : String(error)]);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
    const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (actual !== evidence.sha256) throw new CoordinationRuntimeError('invalid-state', 'accepted evidence hash does not match the run-owned artifact', [evidencePath, `expected=${evidence.sha256}`, `actual=${actual}`]);
    return bytes;
  }

  #verifyAcceptedEvidenceFile(run: CoordinationRun, source: CoordinationReconciliationSource, targetId: string, evidence: { readonly ref: string; readonly sha256: `sha256:${string}` }, persistAtEventSeq?: number): Uint8Array {
    const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'evidence repository'));
    const bytes = this.#readRunEvidenceFile(run, evidence);
    let unitId: string | null = null;
    let attempt: number | null = null;
    if (source === 'child-process') {
      const child = childFromRow(asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(targetId), 'terminal evidence child'));
      unitId = child.owner.unit_id;
      attempt = child.owner.attempt;
      const document = parseJsonObject(Buffer.from(bytes).toString('utf8'), 'child terminal evidence');
      if (document['schema_version'] === AUTOPILOT_CHILD_TERMINAL_ACCEPTANCE_SCHEMA) {
        const acceptance = parseAutopilotChildTerminalAcceptance(document);
        const specBytes = this.#readRunEvidenceFile(run, acceptance.spec);
        const statusBytes = this.#readRunEvidenceFile(run, acceptance.status);
        const receiptBytes = this.#readRunEvidenceFile(run, acceptance.receipt);
        const auditBytes = this.#readRunEvidenceFile(run, acceptance.audit);
        const chain = assertAutopilotChildTerminalAcceptanceChain({ acceptance, child, specBytes, statusBytes, receiptBytes, auditBytes });
        const durableAttempt = this.#requireUnitAttempt(child.owner.repo_id, child.owner.workstream_run, child.owner.unit_id, child.owner.attempt);
        if (canonicalJson(durableAttempt.spec) !== canonicalJson(acceptance.spec) || durableAttempt.role !== chain.spec.role) throw new CoordinationRuntimeError('invalid-state', 'terminal acceptance spec identity differs from the durable unit attempt');
        if (persistAtEventSeq !== undefined) {
          for (const [ref, content, label] of [[acceptance.spec, specBytes, 'terminal acceptance spec'], [acceptance.status, statusBytes, 'terminal acceptance status'], [acceptance.receipt, receiptBytes, 'terminal acceptance receipt'], [acceptance.audit, auditBytes, 'terminal acceptance audit']] as const) this.#persistEvidenceArtifact(run.repo_id, ref, content, label, persistAtEventSeq);
        }
      }
    } else if (source === 'unit-merge' || source === 'attempt-reset' || source === 'quarantine-capture') {
      const target = parseUnitAttemptTarget(targetId);
      unitId = target.unitId;
      attempt = target.attempt;
    }
    const expectedIdentity = {
      repoKey: repository.repo_key, autopilotId: run.autopilot_id, workstream: run.workstream, workstreamRun: run.workstream_run,
      source, targetId, unitId, attempt,
    };
    const historicalProvenance = this.#historicalUnitFailureProvenanceFor(run, source, evidence, bytes);
    validateReconciliationEvidenceDocument(bytes, expectedIdentity, historicalProvenance);
    if (persistAtEventSeq !== undefined && (source === 'attempt-reset' || source === 'quarantine-capture')) {
      const ingress = parseUnitFailureEvidenceIngress(bytes, expectedIdentity, historicalProvenance);
      if (ingress.kind === 'historical') throw new CoordinationRuntimeError('recovery-required', 'historical unit failure evidence cannot newly release authority; reset/quarantine worktree postconditions are not verifiable after schema-10', [evidence.ref, ingress.provenance.reconciliationEvidenceId]);
      this.#assertUnitFailureEvidenceFacts(run, source, targetId, ingress.facts, bytes);
    }
    if (persistAtEventSeq !== undefined) this.#persistEvidenceArtifact(run.repo_id, evidence, bytes, `${source} reconciliation evidence`, persistAtEventSeq);
    return bytes;
  }

  #historicalUnitFailureProvenanceFor(run: CoordinationRun, source: CoordinationReconciliationSource, evidence: { readonly ref: string; readonly sha256: `sha256:${string}` }, bytes: Uint8Array): HistoricalUnitFailureEvidenceProvenance | null {
    if (source !== 'attempt-reset' && source !== 'quarantine-capture') return null;
    const conditionType = source === 'attempt-reset' ? 'attempt-reset' : 'quarantine-captured';
    const row = this.#db.prepare("SELECT entity_id, json_extract(payload_json, '$.accepted_event_seq') AS accepted_event_seq FROM reconciliation_evidence WHERE repo_id=? AND workstream_run=? AND source=? AND json_extract(payload_json, '$.release_condition.condition_type')=? AND json_extract(payload_json, '$.release_condition.evidence.ref')=? AND json_extract(payload_json, '$.release_condition.evidence.sha256')=? ORDER BY entity_id LIMIT 1").get(run.repo_id, run.workstream_run, source, conditionType, evidence.ref, evidence.sha256);
    if (row === undefined) return null;
    const reconciliationEvidenceId = sqlString(row, 'entity_id');
    const acceptedEventSeq = sqlInteger(row, 'accepted_event_seq');
    const acceptedEvent = asRow(this.#db.prepare('SELECT occurred_at FROM events WHERE repo_id=? AND event_seq=?').get(run.repo_id, acceptedEventSeq), 'accepted reconciliation evidence event');
    const acceptedAt = sqlString(acceptedEvent, 'occurred_at');
    const schema10Migration = this.#db.prepare("SELECT applied_at FROM schema_migrations WHERE version=10").get();
    if (schema10Migration === undefined) return null;
    const schema10AppliedAt = sqlString(schema10Migration, 'applied_at');
    const generation = classifyHistoricalUnitFailureEvidenceGeneration(bytes);
    if (generation === null) return null;
    const producerBuild = generation === HISTORICAL_UNIT_FAILURE_GENERATIONS.phase2Initial ? BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS.phase2Initial : BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS.captureCommitOnly;
    const producerGeneration = generation === HISTORICAL_UNIT_FAILURE_GENERATIONS.phase2Initial ? 1 : 2;
    return { kind: 'coordinator-accepted-before-schema10', evidenceRef: evidence.ref, evidenceSha256: evidence.sha256, reconciliationEvidenceId, acceptedEventSeq, acceptedAt, schema10AppliedAt, producerBuild, producerGeneration };
  }

  #assertUnitFailureEvidenceFacts(run: CoordinationRun, source: 'attempt-reset' | 'quarantine-capture', targetId: string, facts: ReturnType<typeof parseUnitFailureEvidenceFacts>, evidenceBytes: Uint8Array): void {
    const target = parseUnitAttemptTarget(targetId);
    const worktrees = this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND kind='unit' AND unit_id=? AND attempt=? AND is_current_canonical=1 ORDER BY canonical_worktree_id").all(run.repo_id, run.workstream_run, target.unitId, target.attempt).map(canonicalWorktreeFromRow);
    const worktree = worktrees[0];
    if (worktrees.length !== 1 || worktree === undefined || resolve(worktree.canonical_path) !== resolve(facts.unitWorktreePath)) throw new CoordinationRuntimeError('invalid-state', 'unit failure evidence does not identify exactly one registered owner worktree', [facts.unitWorktreePath]);
    if (source === 'attempt-reset') {
      if (facts.action !== 'reset' && facts.action !== 'abort') throw new CoordinationRuntimeError('invalid-state', 'attempt-reset source requires reset/abort failure evidence');
      this.#assertResetEvidenceFacts(run, worktree, facts, evidenceBytes);
      return;
    }
    if (source === 'quarantine-capture') {
      if (facts.action !== 'quarantine' && facts.action !== 'preserve') throw new CoordinationRuntimeError('invalid-state', 'quarantine-capture source requires quarantine/preserve failure evidence');
      this.#assertQuarantineEvidenceFacts(run, worktree, facts, evidenceBytes);
      return;
    }
  }

  #assertResetEvidenceFacts(run: CoordinationRun, worktree: CoordinationWorktree, facts: ReturnType<typeof parseUnitFailureEvidenceFacts>, evidenceBytes: Uint8Array): void {
    if (worktree.state !== 'terminal' || facts.captureCommitSha !== null || facts.captureRef !== null || !existsSync(worktree.canonical_path) || facts.branch !== worktree.branch || realpathSync(facts.gitCommonDir) !== realpathSync(worktree.git_common_dir)) throw new CoordinationRuntimeError('invalid-state', 'reset evidence disagrees with its durable terminal worktree owner', [worktree.worktree_id, `state=${worktree.state}`, `path_exists=${String(existsSync(worktree.canonical_path))}`, `branch=${facts.branch}`, `expected_branch=${worktree.branch}`, `git_common_dir=${realpathSync(facts.gitCommonDir)}`, `expected_git_common_dir=${realpathSync(worktree.git_common_dir)}`, `capture_commit=${String(facts.captureCommitSha)}`, `capture_ref=${String(facts.captureRef)}`]);
    const document = parseJsonObject(Buffer.from(evidenceBytes).toString('utf8'), 'reset evidence');
    const dirtyValue = document['dirty_paths'];
    if (!Array.isArray(dirtyValue) || dirtyValue.some((path) => typeof path !== 'string')) throw new CoordinationRuntimeError('invalid-state', 'reset evidence dirty_paths are invalid');
    const dirtyPaths = dirtyValue.map((path) => String(path));
    const canonicalWorktreeId = deterministicWorktreeId(worktree.owner, 'unit');
    const candidates = this.#db.prepare("SELECT * FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND canonical_worktree_id=? AND json_extract(payload_json, '$.operation_type')='reset' AND json_extract(payload_json, '$.stage')='committed' ORDER BY json_extract(payload_json, '$.intent_event_seq') DESC, entity_id").all(run.repo_id, run.workstream_run, canonicalWorktreeId).map(worktreeOperationFromRow).filter((operation): operation is Extract<CoordinationWorktreeOperation, { readonly operation_type: 'reset' }> =>
      operation.operation_type === 'reset'
      && operation.intent.worktree_path === worktree.canonical_path
      && operation.intent.git_common_dir === worktree.git_common_dir
      && operation.intent.branch === worktree.branch
      && operation.intent.base_sha === facts.gitHeadBefore
      && operation.intent.target_sha === facts.gitHeadAfter
      && canonicalJson(operation.intent.paths) === canonicalJson(dirtyPaths)
      && operation.intent.reason.startsWith(`${facts.action} `));
    if (candidates.length !== 1 || candidates[0] === undefined) throw new CoordinationRuntimeError('recovery-required', 'reset release requires exactly one matching committed canonical operation', candidates.map((operation) => operation.operation_id));
    const operation = candidates[0];
    const operationEvidence = this.#verifyOperationEvidenceFile(operation);
    if (operationEvidence === null) throw new CoordinationRuntimeError('system-fatal', 'reset operation resolved to metadata reconciliation evidence', [operation.operation_id]);
    const inspection = inspectWorktreePostcondition({ operationType: 'reset', owner: operation.owner, kind: 'unit', canonicalWorktreeId, intent: operation.intent, durableStage: operation.stage });
    if (inspection.outcome !== 'satisfied' || inspection.effect_applied !== true || operationEvidence['capture_sha'] !== null || operationEvidence['proof_source'] !== inspection.proof_source) throw new CoordinationRuntimeError('recovery-required', 'reset canonical proof is incomplete or disagrees with immutable operation evidence', [operation.operation_id, ...inspection.proof]);
  }

  #assertQuarantineEvidenceFacts(run: CoordinationRun, worktree: CoordinationWorktree, facts: ReturnType<typeof parseUnitFailureEvidenceFacts>, evidenceBytes: Uint8Array): void {
    if (worktree.state !== 'quarantined' || facts.captureCommitSha === null || facts.captureCommitSha !== facts.gitHeadAfter || facts.captureRef === null) throw new CoordinationRuntimeError('invalid-state', 'quarantine evidence lacks a durable quarantined capture identity', [worktree.worktree_id]);
    const expectedCaptureRef = `autopilot/archive/${run.workstream_run}/unit/${worktree.owner.unit_id}/attempt-${String(worktree.owner.attempt)}/${facts.action}-capture`;
    if (facts.captureRef !== expectedCaptureRef || facts.branch !== worktree.branch || realpathSync(facts.gitCommonDir) !== realpathSync(worktree.git_common_dir)) throw new CoordinationRuntimeError('invalid-state', 'quarantine evidence disagrees with its durable owner identity', [facts.captureRef, expectedCaptureRef, facts.branch, worktree.branch]);
    const document = parseJsonObject(Buffer.from(evidenceBytes).toString('utf8'), 'quarantine evidence');
    const dirtyValue = document['dirty_paths'];
    if (!Array.isArray(dirtyValue) || dirtyValue.some((path) => typeof path !== 'string')) throw new CoordinationRuntimeError('invalid-state', 'quarantine evidence dirty_paths are invalid');
    const dirtyPaths = dirtyValue.map((path) => String(path));
    const canonicalWorktreeId = deterministicWorktreeId(worktree.owner, 'unit');
    const candidates = this.#db.prepare("SELECT * FROM worktree_operations WHERE repo_id=? AND workstream_run=? AND canonical_worktree_id=? AND json_extract(payload_json, '$.operation_type')='quarantine' AND json_extract(payload_json, '$.stage')='committed' ORDER BY json_extract(payload_json, '$.intent_event_seq') DESC, entity_id").all(run.repo_id, run.workstream_run, canonicalWorktreeId).map(worktreeOperationFromRow).filter((operation): operation is Extract<CoordinationWorktreeOperation, { readonly operation_type: 'quarantine' }> =>
      operation.operation_type === 'quarantine'
      && operation.intent.worktree_path === worktree.canonical_path
      && operation.intent.git_common_dir === worktree.git_common_dir
      && operation.intent.branch === worktree.branch
      && operation.intent.base_sha === facts.gitHeadBefore
      && operation.intent.target_sha === facts.gitHeadBefore
      && canonicalJson(operation.intent.paths) === canonicalJson(dirtyPaths)
      && (facts.action === 'preserve') === operation.intent.reason.startsWith('preserve '));
    if (candidates.length !== 1 || candidates[0] === undefined) throw new CoordinationRuntimeError('recovery-required', 'quarantine release requires exactly one matching committed canonical operation', candidates.map((operation) => operation.operation_id));
    const operation = candidates[0];
    const operationEvidence = this.#verifyOperationEvidenceFile(operation);
    if (operationEvidence === null) throw new CoordinationRuntimeError('system-fatal', 'quarantine operation resolved to metadata reconciliation evidence', [operation.operation_id]);
    const inspection = (() => {
      try { return inspectWorktreePostcondition({ operationType: 'quarantine', owner: operation.owner, kind: 'unit', canonicalWorktreeId, intent: operation.intent, durableStage: operation.stage }); }
      catch (error) { throw new CoordinationRuntimeError('recovery-required', 'canonical quarantine inspection failed', [operation.operation_id, error instanceof Error ? error.message : String(error)]); }
    })();
    const expectedProofSource = existsSync(worktree.canonical_path) ? 'physical-worktree' : 'owned-git-ref';
    if (inspection.outcome !== 'satisfied' || inspection.proof_source !== expectedProofSource || inspection.capture_sha !== facts.captureCommitSha || operationEvidence['capture_sha'] !== facts.captureCommitSha || operationEvidence['proof_source'] !== expectedProofSource) throw new CoordinationRuntimeError('recovery-required', 'quarantine canonical proof is incomplete or disagrees with immutable operation evidence', [operation.operation_id, `outcome=${inspection.outcome}`, `proof_source=${inspection.proof_source}`, `capture=${String(inspection.capture_sha)}`]);
    const resource = runResourceFromRow(asRow(this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run), 'quarantine run resource'));
    const archiveCapture = this.#gitQueryText(resource.source_repo, { kind: 'resolve-commit', revision: `refs/heads/${facts.captureRef}` }, 'recovery-required', 'quarantine archive ref inspection failed');
    if (archiveCapture !== facts.captureCommitSha) throw new CoordinationRuntimeError('recovery-required', 'quarantine archive ref does not preserve the exact canonical capture', [facts.captureRef, String(archiveCapture), facts.captureCommitSha]);
  }

  #updateAttemptForSatisfiedCondition(owner: CoordinationOwnerIdentity, conditionType: CoordinationReleaseConditionType): void {
    const entityId = unitAttemptEntityId(owner);
    const row = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(entityId);
    if (row === undefined) return;
    const attempt = unitAttemptFromRow(row);
    const state = conditionType === 'child-terminal' ? 'transport-complete' : conditionType === 'unit-merged' ? 'merged' : conditionType === 'attempt-reset' ? 'reset' : conditionType === 'quarantine-captured' ? 'quarantined' : null;
    if (state === null || attempt.state === state) return;
    this.#updateEntity('unit_attempts', entityId, { ...attempt, state, critical_section: null, preemptible: true, version: attempt.version + 1 });
  }

  #updateAttemptFromEvidence(run: CoordinationRun, conditionType: CoordinationReleaseConditionType, targetId: string): void {
    if (conditionType === 'run-closed' || conditionType === 'explicit-owner-release' || conditionType === 'child-terminal') return;
    const split = targetId.lastIndexOf(':');
    if (split <= 0) throw new CoordinationRuntimeError('invalid-request', `${conditionType} target must be unit-id:attempt`);
    const attempt = Number(targetId.slice(split + 1));
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new CoordinationRuntimeError('invalid-request', `${conditionType} target attempt is invalid`);
    this.#updateAttemptForSatisfiedCondition({ repo_id: run.repo_id, autopilot_id: run.autopilot_id, workstream_run: run.workstream_run, unit_id: targetId.slice(0, split), attempt }, conditionType);
  }

  #assertReconciliationTarget(run: CoordinationRun, conditionType: CoordinationReleaseConditionType, targetId: string): void {
    if (conditionType === 'run-closed') {
      if (targetId !== run.workstream_run) throw new CoordinationRuntimeError('invalid-request', 'run-close evidence must target the current durable run');
      return;
    }
    if (conditionType === 'child-terminal') {
      const child = this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(targetId);
      if (child !== undefined && childFromRow(child).owner.workstream_run !== run.workstream_run) throw new CoordinationRuntimeError('unauthorized-client', 'child-terminal evidence targets a foreign run');
      return;
    }
    const split = targetId.lastIndexOf(':');
    if (split <= 0 || !Number.isSafeInteger(Number(targetId.slice(split + 1))) || Number(targetId.slice(split + 1)) < 1) throw new CoordinationRuntimeError('invalid-request', `${conditionType} evidence target must be unit-id:attempt`);
  }

  #reconciliationSource(value: string): CoordinationReconciliationSource {
    switch (value) {
      case 'child-process': case 'unit-merge': case 'attempt-reset': case 'quarantine-capture': case 'run-close': case 'run-abort': return value;
      default: throw new CoordinationRuntimeError('invalid-request', `unsupported reconciliation source ${value}`);
    }
  }

  #conditionTypeForSource(source: CoordinationReconciliationSource): CoordinationReleaseConditionType {
    switch (source) {
      case 'child-process': return 'child-terminal';
      case 'unit-merge': return 'unit-merged';
      case 'attempt-reset': return 'attempt-reset';
      case 'quarantine-capture': return 'quarantine-captured';
      case 'run-close': case 'run-abort': return 'run-closed';
    }
  }

  #emptyReconciliationSummary(): { released_lease_ids: string[]; released_observation_ids: string[]; stale_observation_ids: string[]; released_request_ids: string[]; notification_ids: string[]; offered_group_ids: string[] } {
    return { released_lease_ids: [], released_observation_ids: [], stale_observation_ids: [], released_request_ids: [], notification_ids: [], offered_group_ids: [] };
  }

  #freezeReconciliationSummary(summary: { readonly released_lease_ids: readonly string[]; readonly released_observation_ids: readonly string[]; readonly stale_observation_ids: readonly string[]; readonly released_request_ids: readonly string[]; readonly notification_ids: readonly string[]; readonly offered_group_ids: readonly string[] }): CoordinationReconciliationSummary {
    return {
      released_lease_ids:
        Object.freeze([...new Set(summary.released_lease_ids)].sort()),
      released_observation_ids:
        Object.freeze([...new Set(summary.released_observation_ids)].sort()),
      stale_observation_ids:
        Object.freeze([...new Set(summary.stale_observation_ids)].sort()),
      released_request_ids:
        Object.freeze([...new Set(summary.released_request_ids)].sort()),
      notification_ids:
        Object.freeze([...new Set(summary.notification_ids)].sort()),
      offered_group_ids:
        Object.freeze([...new Set(summary.offered_group_ids)].sort()),
    };
  }

  #reconciliationDetails(receiptId: string, summary: CoordinationReconciliationSummary): readonly CoordinationReconciliationDetail[] {
    const groups: readonly { readonly kind: CoordinationReconciliationDetailKind; readonly ids: readonly string[] }[] = [
      { kind: 'released-lease', ids: summary.released_lease_ids },
      { kind: 'released-observation', ids: summary.released_observation_ids },
      { kind: 'stale-observation', ids: summary.stale_observation_ids },
      { kind: 'released-request', ids: summary.released_request_ids },
      { kind: 'notification', ids: summary.notification_ids },
      { kind: 'offered-group', ids: summary.offered_group_ids },
    ];
    const details: CoordinationReconciliationDetail[] = [];
    for (const group of groups) {
      for (const entityId of group.ids) details.push(parseCoordinationReconciliationDetail({ schema_version: 'autopilot.reconciliation_detail.v1', reconciliation_receipt_id: receiptId, ordinal: details.length + 1, kind: group.kind, entity_id: entityId }));
    }
    return Object.freeze(details);
  }

  #persistResultReceipt(repoId: string, workstreamRun: string, sourceAction: string, eventSeq: number, collectionsInput: Readonly<Record<string, readonly unknown[]>>): CoordinationResultReceipt {
    const receiptId = stableEntityId('result-receipt', [repoId, workstreamRun, sourceAction, String(eventSeq)]);
    const details: CoordinationResultDetail[] = [];
    const collections: Record<string, { readonly item_count: number; readonly items_sha256: `sha256:${string}` }> = {};
    for (const name of Object.keys(collectionsInput).sort((left, right) => left.localeCompare(right))) {
      const values = collectionsInput[name];
      if (values === undefined) throw new CoordinationRuntimeError('store-corrupt', 'result collection disappeared during receipt construction', [name]);
      collections[name] = { item_count: values.length, items_sha256: `sha256:${createHash('sha256').update(JSON.stringify(values), 'utf8').digest('hex')}` };
      for (const [index, value] of values.entries()) {
        if (encodedJsonBytes(value) > COORDINATOR_MAX_PAGE_ENTITY_BYTES) throw new CoordinationRuntimeError('frame-too-large', 'single mutation result entity exceeds the byte-paged detail ceiling', [sourceAction, name, `ordinal=${String(index + 1)}`]);
        details.push(parseCoordinationResultDetail({ schema_version: 'autopilot.result_detail.v1', result_receipt_id: receiptId, ordinal: details.length + 1, collection: name, collection_ordinal: index + 1, value }));
      }
    }
    const receipt = parseCoordinationResultReceipt({
      schema_version: 'autopilot.result_receipt.v1', result_receipt_id: receiptId, repo_id: repoId, workstream_run: workstreamRun, source_action: sourceAction,
      committed_event_seq: eventSeq, detail_count: details.length, details_sha256: `sha256:${createHash('sha256').update(JSON.stringify(details), 'utf8').digest('hex')}`,
      collections, version: 1,
    });
    this.#db.prepare('INSERT INTO result_receipts(entity_id, repo_id, workstream_run, committed_event_seq, source_action, payload_json, version) VALUES(?, ?, ?, ?, ?, ?, ?)').run(receipt.result_receipt_id, receipt.repo_id, receipt.workstream_run, receipt.committed_event_seq, receipt.source_action, canonicalJson(receipt), receipt.version);
    const insertDetail = this.#db.prepare('INSERT INTO result_details(result_receipt_id, ordinal, collection_name, collection_ordinal, payload_json) VALUES(?, ?, ?, ?, ?)');
    for (const detail of details) insertDetail.run(detail.result_receipt_id, detail.ordinal, detail.collection, detail.collection_ordinal, JSON.stringify(detail.value));
    return receipt;
  }

  #reconciliationReceiptPayload(receipt: CoordinationReconciliationReceipt): Readonly<Record<string, unknown>> {
    return receipt.detail_count === 0 ? Object.freeze({}) : Object.freeze({ reconciliation_receipt: receipt });
  }

  #persistReconciliationReceipt(repoId: string, workstreamRun: string, sourceAction: string, eventSeq: number, summary: CoordinationReconciliationSummary, persistEmpty = false): CoordinationReconciliationReceipt {
    const receiptId = stableEntityId('reconciliation-receipt', [repoId, workstreamRun, sourceAction, String(eventSeq)]);
    const finalDetails = this.#reconciliationDetails(receiptId, summary);
    const receipt = parseCoordinationReconciliationReceipt({
      schema_version: 'autopilot.reconciliation_receipt.v1', reconciliation_receipt_id: receiptId, repo_id: repoId, workstream_run: workstreamRun,
      source_action: sourceAction, committed_event_seq: eventSeq, detail_count: finalDetails.length,
      details_sha256: `sha256:${createHash('sha256').update(JSON.stringify(finalDetails), 'utf8').digest('hex')}`,
      counts: {
        'released-lease': summary.released_lease_ids.length,
        'released-observation': summary.released_observation_ids.length,
        'stale-observation': summary.stale_observation_ids.length,
        'released-request': summary.released_request_ids.length,
        notification: summary.notification_ids.length,
        'offered-group': summary.offered_group_ids.length,
      },
      version: 1,
    });
    if (finalDetails.length === 0 && !persistEmpty) return receipt;
    const existing = this.#db.prepare('SELECT * FROM reconciliation_receipts WHERE entity_id=?').get(receiptId);
    if (existing !== undefined) {
      const parsed = reconciliationReceiptFromRow(existing);
      if (canonicalJson(parsed) !== canonicalJson(receipt)) throw new CoordinationRuntimeError('idempotency-conflict', 'reconciliation receipt identity was reused with different exact details', [receiptId]);
      return parsed;
    }
    this.#db.prepare('INSERT INTO reconciliation_receipts(entity_id, repo_id, workstream_run, committed_event_seq, source_action, payload_json, version) VALUES(?, ?, ?, ?, ?, ?, ?)').run(receipt.reconciliation_receipt_id, receipt.repo_id, receipt.workstream_run, receipt.committed_event_seq, receipt.source_action, canonicalJson(receipt), receipt.version);
    const insertDetail = this.#db.prepare('INSERT INTO reconciliation_details(reconciliation_receipt_id, ordinal, kind, entity_id) VALUES(?, ?, ?, ?)');
    for (const detail of finalDetails) insertDetail.run(detail.reconciliation_receipt_id, detail.ordinal, detail.kind, detail.entity_id);
    return receipt;
  }

  #requireMailboxCursor(repoId: string, workstreamRun: string): CoordinationMailboxCursor {
    return mailboxCursorFromRow(asRow(this.#db.prepare('SELECT * FROM mailbox_cursors WHERE repo_id=? AND workstream_run=?').get(repoId, workstreamRun), 'mailbox cursor'));
  }

  #advanceMailboxCursor(repoId: string, workstreamRun: string, kind: 'delivered' | 'acknowledged'): void {
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
    if (delivered === cursor.delivered_through_event_seq && acknowledged === cursor.acknowledged_through_event_seq) return;
    this.#db.prepare('UPDATE mailbox_cursors SET delivered_through_event_seq=?, acknowledged_through_event_seq=?, version=version+1 WHERE repo_id=? AND workstream_run=?').run(delivered, acknowledged, repoId, workstreamRun);
  }

  #insertEntity(table: 'unit_attempts' | 'acquisition_groups' | 'edit_leases', entityId: string, repoId: string, workstreamRun: string, entity: CoordinationUnitAttempt | CoordinationAcquisitionGroup | CoordinationEditLease): void {
    this.#db.prepare(`INSERT INTO ${table}(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)`).run(entityId, repoId, workstreamRun, canonicalJson(entity), entity.version);
  }

  #updateEntity(table: 'unit_attempts' | 'acquisition_groups' | 'edit_leases', entityId: string, entity: CoordinationUnitAttempt | CoordinationAcquisitionGroup | CoordinationEditLease): void {
    const result = table === 'acquisition_groups'
      ? this.#db.prepare('UPDATE acquisition_groups SET payload_json=?, version=? WHERE repo_id=? AND entity_id=?').run(canonicalJson(entity), entity.version, entity.owner.repo_id, entityId)
      : this.#db.prepare(`UPDATE ${table} SET payload_json=?, version=? WHERE entity_id=?`).run(canonicalJson(entity), entity.version, entityId);
    if (result.changes !== 1) throw new CoordinationRuntimeError('invalid-state', `${table} entity ${entityId} disappeared during mutation`);
  }

  #insertOrVerifyUnitAttempt(attempt: CoordinationUnitAttempt): void {
    const entityId = unitAttemptEntityId(attempt.owner);
    const row = this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(entityId);
    if (row === undefined) {
      this.#insertEntity('unit_attempts', entityId, attempt.owner.repo_id, attempt.owner.workstream_run, attempt);
      return;
    }
    const existing = unitAttemptFromRow(row);
    if (!sameOwner(existing.owner, attempt.owner) || canonicalJson(existing.spec) !== canonicalJson(attempt.spec) || existing.role !== attempt.role) throw new CoordinationRuntimeError('invalid-state', 'unit attempt identity was reused with different immutable spec evidence or role');
    if (existing.state === 'superseded' || existing.state === 'reset' || existing.state === 'failed' || existing.state === 'quarantined') throw new CoordinationRuntimeError('invalid-state', `unit attempt is ${existing.state}`);
  }

  #childForOwner(owner: CoordinationOwnerIdentity): CoordinationChildLease | null {
    const rows = this.#db.prepare('SELECT * FROM child_leases WHERE repo_id=? AND autopilot_id=? AND workstream_run=? AND unit_id=? AND attempt=? ORDER BY child_lease_id').all(owner.repo_id, owner.autopilot_id, owner.workstream_run, owner.unit_id, owner.attempt).map(childFromRow);
    if (rows.length > 1) throw new CoordinationRuntimeError('store-corrupt', 'durable attempt owns multiple child leases', [owner.workstream_run, owner.unit_id, String(owner.attempt)]);
    return rows[0] ?? null;
  }

  #requireUnitAttempt(repoId: string, workstreamRun: string, unitId: string, attempt: number): CoordinationUnitAttempt {
    const run = this.#requireRun(repoId, workstreamRun);
    const owner: CoordinationOwnerIdentity = { repo_id: repoId, autopilot_id: run.autopilot_id, workstream_run: workstreamRun, unit_id: unitId, attempt };
    return unitAttemptFromRow(asRow(this.#db.prepare('SELECT * FROM unit_attempts WHERE entity_id=?').get(unitAttemptEntityId(owner)), 'unit attempt'));
  }

  #requireGroup(repoId: string, groupId: string): CoordinationAcquisitionGroup {
    return acquisitionGroupFromRow(asRow(this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND entity_id=?').get(repoId, groupId), 'acquisition group'));
  }

  #requireClaimRequest(requestId: string): CoordinationClaimRequest {
    return claimRequestFromRow(asRow(this.#db.prepare('SELECT * FROM claim_requests WHERE entity_id=?').get(requestId), 'claim request'));
  }

  #claimRequestsForGroup(repoId: string, groupId: string): readonly CoordinationClaimRequest[] {
    return this.#db.prepare("SELECT * FROM claim_requests WHERE repo_id=? AND json_extract(payload_json, '$.acquisition_group_id')=? ORDER BY entity_id").all(repoId, groupId).map(claimRequestFromRow);
  }

  #groupsForAttempt(owner: CoordinationOwnerIdentity): readonly CoordinationAcquisitionGroup[] {
    return this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? AND workstream_run=? ORDER BY entity_id').all(owner.repo_id, owner.workstream_run).map(acquisitionGroupFromRow).filter((group) => sameOwner(group.owner, owner));
  }

  #assertReleaseConditionOwner(condition: CoordinationReleaseCondition, owner: CoordinationOwnerIdentity): void {
    if (condition.condition_type === 'run-closed' && condition.target_id !== owner.workstream_run) throw new CoordinationRuntimeError('invalid-request', 'run-closed condition must target the blocking owner run');
    if ((condition.condition_type === 'unit-merged' || condition.condition_type === 'attempt-reset' || condition.condition_type === 'quarantine-captured') && condition.target_id !== `${owner.unit_id}:${String(owner.attempt)}`) throw new CoordinationRuntimeError('invalid-request', `${condition.condition_type} condition must target the blocking owner unit attempt`);
    if (condition.condition_type === 'child-terminal') {
      const expectedChildId = `child-${owner.workstream_run}-${owner.unit_id}-${String(owner.attempt)}`;
      if (condition.target_id !== expectedChildId) throw new CoordinationRuntimeError('invalid-request', 'child-terminal condition must target the deterministic child lease for the blocking unit attempt');
      const row = this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(condition.target_id);
      if (row !== undefined && !sameOwner(childFromRow(row).owner, owner)) throw new CoordinationRuntimeError('invalid-request', 'child-terminal condition targets a child lease with different durable ownership');
    }
  }

  #evidencePathUnderRoot(authorityRoot: string, ref: string): string {
    const normalizedRef = ref.replace(/\\/gu, '/');
    if (normalizedRef.startsWith('/') || normalizedRef.startsWith('../') || normalizedRef.includes('/../') || normalizedRef === '..' || normalizedRef.includes('\u0000')) throw new CoordinationRuntimeError('unauthorized-client', 'contradiction evidence ref must be normalized and authority-relative', [ref]);
    const root = realpathSync(authorityRoot);
    const target = resolve(root, normalizedRef);
    const rel = relative(root, target);
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new CoordinationRuntimeError('unauthorized-client', 'contradiction evidence ref escapes its registered authority root', [ref]);
    return target;
  }

  #requireRunMainRoot(repoId: string, workstreamRun: string): string {
    const rows = this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND kind='main' AND is_current_canonical=1 AND json_extract(payload_json, '$.state')!='removed' ORDER BY canonical_worktree_id").all(repoId, workstreamRun).map(canonicalWorktreeFromRow);
    if (rows.length !== 1) throw new CoordinationRuntimeError('invalid-state', 'run-main authoritative evidence requires exactly one active durable main worktree', [workstreamRun, `count=${String(rows.length)}`]);
    const worktree = rows[0];
    if (worktree === undefined) throw new CoordinationRuntimeError('invalid-state', 'run-main worktree disappeared');
    return worktree.canonical_path;
  }

  #d65AcceptedLaunchPolicy(repoId: string, workstreamRun: string): Readonly<{ policy: D65LaunchPolicy; artifact: CoordinationAuthoritativeArtifact; anchor: ReturnType<typeof parseD65TrustAnchorSpki> }> {
    const rows = this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.launch_policy.v1' ORDER BY entity_id").all(repoId, workstreamRun);
    if (rows.length !== 1 || rows[0] === undefined) throw new CoordinationRuntimeError('invalid-state', 'launch-policy-invalid: D65 authority requires exactly one accepted launch policy', [`count=${String(rows.length)}`]);
    const artifact = authoritativeArtifactFromRow(rows[0]);
    const policyBytes = this.#loadEvidenceArtifact(repoId, artifact.evidence);
    const policy = parseD65LaunchPolicy(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(policyBytes), 'accepted D65 launch policy'));
    if (policy.repo_id !== repoId || policy.workstream_run !== workstreamRun || artifact.evidence.ref !== `authority/launch-policies/${policy.policy_id}.json`) throw new CoordinationRuntimeError('invalid-state', 'launch-policy-invalid: accepted policy row/path identity is inconsistent');
    const bootstrapArtifact = authoritativeArtifactFromRow(asRow(this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(repoId, `semantic-graph-bootstrap:${workstreamRun}`), 'accepted heartbeat bootstrap artifact'));
    const bootstrap = parseD65SemanticGraphBootstrap(parseJsonObject(new TextDecoder('utf-8', { fatal: true }).decode(this.#loadEvidenceArtifact(repoId, bootstrapArtifact.evidence)), 'accepted heartbeat bootstrap'));
    const anchorBytes = this.#loadEvidenceArtifact(repoId, { ref: bootstrap.trust_anchor_ref, sha256: bootstrap.trust_anchor_sha256 });
    const anchor = parseD65TrustAnchorSpki(anchorBytes);
    if (policy.program_id !== bootstrap.program_id || policy.trust_anchor_ref !== bootstrap.trust_anchor_ref || policy.trust_anchor_sha256 !== anchor.sha256 || policy.signer_key_id !== anchor.sha256) throw new CoordinationRuntimeError('invalid-state', 'launch-policy-invalid: accepted policy trust/bootstrap tuple no longer verifies');
    const { signature: _signature, ...unsignedPolicy } = policy;
    void _signature;
    if (!verifyD65Signature({ trustAnchor: anchor, purpose: 'launch-policy', message: new TextEncoder().encode(canonicalJson(unsignedPolicy)), signature: policy.signature })) throw new CoordinationRuntimeError('invalid-state', 'launch-policy-invalid: accepted policy signature no longer verifies');
    return Object.freeze({ policy, artifact, anchor });
  }

  #d65ExternalHeartbeatPath(policy: D65LaunchPolicy, ref: string): string {
    if (!/^program-heartbeats\/[0-9]{20}\.json$/u.test(ref)) throw new CoordinationRuntimeError('invalid-request', 'program heartbeat_ref is not in the frozen evidence path grammar', [ref]);
    return this.#d65ExternalAuthorityPath(policy, ref, 'program heartbeat');
  }

  #d65ExternalAuthorityPath(policy: D65LaunchPolicy, ref: string, label: string): string {
    if (ref.length === 0 || ref.includes('\\') || ref.startsWith('/') || ref === '..' || ref.startsWith('../') || ref.includes('/../') || ref.includes('\u0000')) throw new CoordinationRuntimeError('invalid-request', `${label} ref is not a normalized evidence-root-relative path`, [ref]);
    const root = realpathSync(policy.program_evidence_root);
    if (root !== policy.program_evidence_root) throw new CoordinationRuntimeError('invalid-state', 'launch-policy-invalid: program evidence root is no longer its canonical real path');
    const candidate = resolve(root, ...ref.split('/'));
    const rel = relative(root, candidate);
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new CoordinationRuntimeError('unauthorized-client', `${label} path escapes the accepted evidence root`, [ref]);
    let canonical: string;
    try { canonical = realpathSync(candidate); }
    catch (error) { throw new CoordinationRuntimeError('invalid-request', `${label} is unavailable at its signed evidence-root path`, [ref, error instanceof Error ? error.message : String(error)]); }
    if (canonical !== candidate) throw new CoordinationRuntimeError('unauthorized-client', `${label} path contains a symbolic-link alias`, [ref, candidate, canonical]);
    return candidate;
  }

  #readD65ExternalPrivateFile(path: string, label: string): Uint8Array {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600) throw new CoordinationRuntimeError('unauthorized-client', `${label} must be one-link, no-follow, regular mode 0600`, [path, `mode=${(before.mode & 0o777).toString(8)}`, `nlink=${String(before.nlink)}`]);
    const bytes = this.#readRegularEvidenceFile(path, label);
    const after = lstatSync(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1 || after.mode !== before.mode || after.size !== before.size) throw new CoordinationRuntimeError('unauthorized-client', `${label} descriptor identity changed during stable read`, [path]);
    return bytes;
  }

  #highestAcceptedProgramHeartbeat(repoId: string, workstreamRun: string): D65HeartbeatAcceptanceResult | null {
    const event = this.#db.prepare("SELECT event_seq,event_type,entity_type,entity_id,idempotency_key,request_sha256 FROM events WHERE repo_id=? AND event_type='program-heartbeat-accepted' AND entity_type='program-heartbeat' AND entity_id=? ORDER BY event_seq DESC LIMIT 1").get(repoId, workstreamRun);
    if (event === undefined) return null;
    const eventRow = asRow(event, 'accepted heartbeat head event');
    const key = sqlString(eventRow, 'idempotency_key');
    const result = this.#db.prepare('SELECT repo_id,idempotency_key,request_sha256,committed_event_seq,payload_json FROM idempotency_results WHERE repo_id=? AND idempotency_key=?').get(repoId, key);
    if (result === undefined) throw new CoordinationRuntimeError('store-corrupt', 'accepted heartbeat head event lacks its immutable exact idempotency result', [repoId, workstreamRun, key]);
    const resultRow = asRow(result, 'accepted heartbeat head result');
    if (sqlString(resultRow, 'repo_id') !== repoId || sqlString(resultRow, 'idempotency_key') !== key || sqlString(resultRow, 'request_sha256') !== sqlString(eventRow, 'request_sha256') || sqlInteger(resultRow, 'committed_event_seq') !== sqlInteger(eventRow, 'event_seq')) throw new CoordinationRuntimeError('store-corrupt', 'accepted heartbeat head event/result join is mismatched', [repoId, workstreamRun, key]);
    const parsed = parseD65HeartbeatAcceptanceResult(parseJsonObject(sqlString(resultRow, 'payload_json'), 'accepted heartbeat head result'));
    if (parsed.repo_id !== repoId || parsed.workstream_run !== workstreamRun) throw new CoordinationRuntimeError('store-corrupt', 'accepted heartbeat head result identity disagrees with event scope');
    return parsed;
  }

  #acceptedProgramHeartbeatAtSequence(repoId: string, workstreamRun: string, sequence: number): D65HeartbeatAcceptanceResult | null {
    const rows = this.#db.prepare("SELECT r.payload_json FROM events e JOIN idempotency_results r ON r.repo_id=e.repo_id AND r.idempotency_key=e.idempotency_key AND r.request_sha256=e.request_sha256 AND r.committed_event_seq=e.event_seq WHERE e.repo_id=? AND e.event_type='program-heartbeat-accepted' AND e.entity_type='program-heartbeat' AND e.entity_id=? ORDER BY e.event_seq").all(repoId, workstreamRun);
    for (const row of rows) {
      const parsed = parseD65HeartbeatAcceptanceResult(parseJsonObject(sqlString(row, 'payload_json'), 'accepted heartbeat sequence result'));
      if (parsed.sequence === sequence) return parsed;
    }
    return null;
  }

  #d65AcceptedGraphHead(repoId: string, workstreamRun: string): Readonly<{ sequence: number; sha256: `sha256:${string}`; artifact: CoordinationAuthoritativeArtifact }> {
    const complete = this.#db.prepare("SELECT * FROM authoritative_artifacts WHERE repo_id=? AND source_run=? AND json_extract(payload_json, '$.document_schema_version')='autopilot.semantic_graph.v1' ORDER BY entity_id DESC LIMIT 1").get(repoId, workstreamRun);
    if (complete !== undefined) {
      const artifact = authoritativeArtifactFromRow(complete);
      return Object.freeze({ sequence: d65SemanticGraphSequenceFromArtifactId(artifact.artifact_id), sha256: artifact.evidence.sha256, artifact });
    }
    const artifact = authoritativeArtifactFromRow(asRow(this.#db.prepare('SELECT * FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(repoId, `semantic-graph-bootstrap:${workstreamRun}`), 'accepted bootstrap graph head'));
    return Object.freeze({ sequence: 1, sha256: artifact.evidence.sha256, artifact });
  }

  #d65CurrentSemanticEndpointDigest(kind: 'status' | 'doctor', repoId: string, workstreamRun: string, coordinatorTime: string): `sha256:${string}` {
    const additions = {
      negotiated_coordinator_identity: this.negotiatedIdentityObservability(),
      run_scoped_logical_faults: this.negotiatedRunScopedFaults(repoId, workstreamRun),
      negotiated_worktree_aliases: this.negotiatedWorktreeAliases(repoId, workstreamRun),
      negotiated_identity_recovery: this.negotiatedIdentityRecovery(repoId, workstreamRun),
    };
    if (kind === 'doctor') {
      const rawDoctor = this.doctor(new Date(coordinatorTime)).payload;
      return computeD65SemanticSnapshotSha256('doctor', Object.freeze({ ...this.#d65SemanticDoctorRows(rawDoctor, coordinatorTime), ...additions }));
    }
    const raw = this.status(repoId, workstreamRun).payload;
    return computeD65SemanticSnapshotSha256('status', Object.freeze({ ...this.#d65SemanticStatusRows(raw), ...additions }));
  }

  #readRegularEvidenceFile(path: string, label: string): Uint8Array {
    let descriptor: number | null = null;
    try {
      const before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink()) throw new CoordinationRuntimeError('unauthorized-client', `${label} must be a regular non-symbolic file`, [path]);
      const canonicalBefore = realpathSync(path);
      const openedDescriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      descriptor = openedDescriptor;
      const opened = fstatSync(openedDescriptor);
      if (!opened.isFile() || opened.size > MAX_COORDINATION_EVIDENCE_BYTES) throw new CoordinationRuntimeError('invalid-request', `${label} must be a regular file no larger than ${String(MAX_COORDINATION_EVIDENCE_BYTES)} bytes`, [path, `size=${String(opened.size)}`]);
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new CoordinationRuntimeError('unauthorized-client', `${label} changed while coordinator authority was being established`, [path]);
      const bytes = readFileSync(openedDescriptor);
      const afterDescriptor = fstatSync(openedDescriptor);
      const afterPath = lstatSync(path);
      const canonicalAfter = realpathSync(path);
      if (bytes.byteLength !== opened.size || afterDescriptor.size !== opened.size || afterDescriptor.dev !== opened.dev || afterDescriptor.ino !== opened.ino || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino || canonicalAfter !== canonicalBefore) throw new CoordinationRuntimeError('unauthorized-client', `${label} changed during its atomic evidence read`, [path]);
      return bytes;
    } catch (error) {
      if (error instanceof CoordinationRuntimeError) throw error;
      throw new CoordinationRuntimeError('invalid-request', `${label} is unreadable`, [path, error instanceof Error ? error.message : String(error)]);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }

  #persistEvidenceArtifact(repoId: string, evidence: { readonly ref: string; readonly sha256: `sha256:${string}` }, bytes: Uint8Array, label: string, seq: number): void {
    if (bytes.byteLength > MAX_COORDINATION_EVIDENCE_BYTES) throw new CoordinationRuntimeError('invalid-request', `${label} exceeds the immutable evidence size ceiling`);
    const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
    if (actual !== evidence.sha256) throw new CoordinationRuntimeError('invalid-request', `${label} hash changed before immutable persistence`, [evidence.sha256, actual]);
    const entityId = stableEntityId('evidence', [repoId, evidence.sha256]);
    const existing = this.#db.prepare('SELECT sha256, size_bytes, content FROM evidence_artifacts WHERE entity_id=?').get(entityId);
    if (existing === undefined) {
      this.#db.prepare('INSERT INTO evidence_artifacts(entity_id, repo_id, sha256, ref, label, content, size_bytes, created_event_seq) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(entityId, repoId, evidence.sha256, evidence.ref, label, bytes, bytes.byteLength, seq);
      return;
    }
    const content = existing['content'];
    if (!(content instanceof Uint8Array) || sqlString(existing, 'sha256') !== evidence.sha256 || sqlInteger(existing, 'size_bytes') !== bytes.byteLength || !timingSafeEqual(content, bytes)) throw new CoordinationRuntimeError('store-corrupt', 'immutable evidence artifact hash identity was reused with different bytes', [entityId]);
  }

  #loadEvidenceArtifact(repoId: string, evidence: { readonly ref: string; readonly sha256: `sha256:${string}` }): Uint8Array {
    const row = asRow(this.#db.prepare('SELECT sha256, content, size_bytes FROM evidence_artifacts WHERE repo_id=? AND sha256=?').get(repoId, evidence.sha256), 'immutable evidence artifact');
    const content = row['content'];
    if (!(content instanceof Uint8Array) || sqlString(row, 'sha256') !== evidence.sha256 || sqlInteger(row, 'size_bytes') !== content.byteLength) throw new CoordinationRuntimeError('store-corrupt', 'immutable evidence artifact metadata or bytes are invalid', [evidence.ref, evidence.sha256]);
    const actual = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    if (actual !== evidence.sha256) throw new CoordinationRuntimeError('store-corrupt', 'immutable evidence artifact bytes fail their durable hash', [evidence.ref, evidence.sha256, actual]);
    return content;
  }

  /**
   * Retires only mechanically exact duplicate active projections. Canonical
   * selection is deterministic: a sole operation-history owner wins; otherwise
   * the shared current deterministic ID wins. State drift, unexplained version
   * drift, multiple incomplete histories, or non-equivalent dual histories are
   * recovery blockers. The caller already owns the mutation transaction, so the
   * projection update and audit event commit or roll back together.
   */
  #assertWorktreeAuthority(worktree: CoordinationWorktree, operation: CoordinationWorktreeOperation): void {
    const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(worktree.owner.repo_id), 'worktree repository'));
    const repoWorktreeRoot = resolve(this.#stateRoot, 'worktrees', repository.repo_key);
    const taskRoot = resolve(repoWorktreeRoot, 'active', worktree.owner.workstream_run);
    const expectedPath = worktree.kind === 'main'
      ? resolve(taskRoot, 'main')
      : resolve(taskRoot, 'units', worktree.owner.unit_id, `attempt-${String(worktree.owner.attempt)}`, 'worktree');
    if (resolve(worktree.canonical_path) !== expectedPath) throw new CoordinationRuntimeError('unauthorized-client', 'worktree path is not derived from its durable run/unit ownership', [worktree.canonical_path, expectedPath]);
    const expectedBranch = worktree.kind === 'main'
      ? `autopilot/${worktree.owner.workstream_run}`
      : `autopilot/unit/${worktree.owner.workstream_run}/${worktree.owner.unit_id}/attempt-${String(worktree.owner.attempt)}`;
    if (worktree.branch !== expectedBranch) throw new CoordinationRuntimeError('unauthorized-client', 'worktree branch is not derived from its durable owner', [worktree.branch, expectedBranch]);
    if (operation.operation_type === 'metadata-reconcile') {
      const canonicalWorktreeId = deterministicWorktreeId(worktree.owner, worktree.kind);
      const target = operation.intent.approved_before_registrations.find((registration) => registration.worktree_path === operation.intent.target_registration_path);
      if (operation.intent.repo_id !== repository.repo_id
        || operation.intent.git_common_dir !== repository.git_common_dir
        || worktree.git_common_dir !== repository.git_common_dir
        || operation.intent.canonical_worktree_id !== canonicalWorktreeId) throw new CoordinationRuntimeError('unauthorized-client', 'metadata reconciliation repository/canonical identity disagrees with durable worktree authority');
      if (operation.intent.target_registration_path !== worktree.canonical_path
        || target === undefined
        || target.prunable !== true
        || target.branch_ref !== `refs/heads/${worktree.branch}`) throw new CoordinationRuntimeError('invalid-request', 'metadata reconciliation target registration disagrees with immutable worktree identity');
      return;
    }
    if (operation.intent.repo_root !== repository.canonical_root || worktree.git_common_dir !== repository.git_common_dir || operation.intent.git_common_dir !== repository.git_common_dir) throw new CoordinationRuntimeError('unauthorized-client', 'worktree operation repository identity disagrees with the registered repository');
    if (operation.intent.worktree_path !== worktree.canonical_path || operation.intent.branch !== worktree.branch) throw new CoordinationRuntimeError('invalid-request', 'operation intent disagrees with immutable worktree identity');
    if (operation.operation_type === 'create' && operation.intent.base_sha === null) throw new CoordinationRuntimeError('invalid-request', 'create operation requires immutable base_sha');
    if (operation.operation_type === 'create' && operation.intent.checkout_mode !== null && operation.intent.checkout_mode !== 'full' && operation.intent.sparse_patterns.length === 0) throw new CoordinationRuntimeError('invalid-request', 'sparse create operation requires non-empty patterns');
    if ((operation.operation_type === 'merge' || operation.operation_type === 'reset' || operation.operation_type === 'archive' || operation.operation_type === 'remove') && operation.intent.target_sha === null) throw new CoordinationRuntimeError('invalid-request', `${operation.operation_type} operation requires immutable target_sha`);
    if (operation.operation_type === 'archive' && operation.intent.archive_ref === null) throw new CoordinationRuntimeError('invalid-request', 'archive operation requires an archive_ref');
    if (operation.operation_type === 'archive' && operation.intent.archive_ref !== null && !operation.intent.archive_ref.startsWith(`autopilot/archive/${worktree.owner.workstream_run}/`)) throw new CoordinationRuntimeError('unauthorized-client', 'archive operation ref is outside its run-owned namespace', [operation.intent.archive_ref]);
    if (operation.operation_type === 'materialize' && (operation.intent.sparse_patterns.length === 0 || operation.intent.paths.length === 0)) throw new CoordinationRuntimeError('invalid-request', 'materialize operation requires non-empty sparse patterns and paths');
    if (operation.operation_type === 'commit' && (operation.intent.base_sha === null || operation.intent.paths.length === 0)) throw new CoordinationRuntimeError('invalid-request', 'commit operation requires base_sha and exact changed paths');
    for (const path of operation.intent.paths) {
      const normalized = path.replace(/\\/gu, '/').replace(/\/\*\*$/u, '');
      if (normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../') || normalized === '..' || normalized.startsWith(':') || normalized.includes('\u0000') || normalized.length === 0) throw new CoordinationRuntimeError('invalid-request', 'operation path must be normalized repository-relative authority without Git pathspec magic', [path]);
    }
    for (const ref of operation.intent.metadata_refs) {
      const normalized = ref.replace(/\\/gu, '/');
      if (normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../') || normalized === '..' || normalized.includes('\u0000')) throw new CoordinationRuntimeError('invalid-request', 'operation metadata ref must remain relative to its owned task root', [ref]);
    }
  }

  #verifyOperationEvidenceFile(operation: CoordinationWorktreeOperation): Readonly<Record<string, unknown>> | null {
    const evidence = operation.verification_evidence;
    if (evidence === null) throw new CoordinationRuntimeError('invalid-request', 'operation evidence is missing');
    const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(operation.owner.repo_id), 'operation evidence repository'));
    const runEvidenceRoot = resolve(this.#stateRoot, 'worktrees', repository.repo_key, '_saga-evidence', operation.owner.workstream_run);
    const expectedRef = operation.operation_type === 'metadata-reconcile'
      ? `_saga-evidence/${operation.owner.workstream_run}/metadata-reconcile/${operation.intent.canonical_worktree_id}.json`
      : `_saga-evidence/${operation.owner.workstream_run}/${operation.operation_id}.json`;
    if (evidence.ref !== expectedRef) throw new CoordinationRuntimeError('unauthorized-client', 'operation evidence ref is not derived from its durable owner and operation', [evidence.ref, expectedRef]);
    const evidencePath = resolve(this.#stateRoot, 'worktrees', repository.repo_key, evidence.ref);
    const relativeEvidence = relative(runEvidenceRoot, evidencePath);
    if (relativeEvidence.length === 0 || relativeEvidence === '..' || relativeEvidence.startsWith(`..${sep}`) || isAbsolute(relativeEvidence)) throw new CoordinationRuntimeError('unauthorized-client', 'operation evidence escapes its run-owned evidence root');
    const bytes = this.#readRegularEvidenceFile(evidencePath, 'operation evidence');
    const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (actual !== evidence.sha256) throw new CoordinationRuntimeError('invalid-state', 'operation evidence hash does not match immutable artifact', [evidencePath, `expected=${evidence.sha256}`, `actual=${actual}`]);
    let parsedValue: unknown;
    try { parsedValue = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown; } catch (error) { throw new CoordinationRuntimeError('invalid-state', 'operation evidence is not valid JSON', [error instanceof Error ? error.message : String(error)]); }
    if (operation.operation_type === 'metadata-reconcile') {
      const metadataEvidence = parseMetadataReconcileEvidence(parsedValue);
      assertMetadataReconcileEvidence(operation.intent, metadataEvidence);
      const operationKey = deriveWorktreeOperationKeyV2({ canonicalWorktreeId: operation.intent.canonical_worktree_id, operationType: operation.operation_type, completeImmutableIntent: operation.intent });
      if (metadataEvidence.operation_key_sha256 !== operationKey.operation_key_sha256 || operation.operation_id !== operationIdFromWorktreeOperationKey(operationKey)) throw new CoordinationRuntimeError('unauthorized-client', 'metadata reconciliation evidence does not bind its canonical operation-key v2 identity');
      return null;
    }
    const parsed = parseJsonObject(canonicalJson(parsedValue), 'operation evidence');
    const expectedIntentSha = `sha256:${createHash('sha256').update(canonicalJson(operation.intent), 'utf8').digest('hex')}`;
    const evidenceTerminalStage = operation.stage === 'committed' ? 'verified' : operation.stage;
    if (parsed['schema_version'] !== 'autopilot.worktree_operation_evidence.v1' || parsed['operation_id'] !== operation.operation_id || parsed['worktree_id'] !== operation.worktree_id || parsed['operation_type'] !== operation.operation_type || parsed['terminal_stage'] !== evidenceTerminalStage || parsed['intent_sha256'] !== expectedIntentSha || canonicalJson(parsed['owner']) !== canonicalJson(operation.owner)) throw new CoordinationRuntimeError('unauthorized-client', 'operation evidence identity or immutable intent does not match its durable operation');
    return parsed;
  }

  #assertCommittedWorktreeState(operation: CoordinationWorktreeOperation, state: string): void {
    const allowed: Readonly<Record<CoordinationWorktreeOperation['operation_type'], readonly string[]>> = {
      create: ['active'], materialize: ['active'], commit: ['active'], merge: ['active', 'terminal'], reset: ['terminal'], quarantine: ['quarantined'], archive: ['active', 'terminal', 'quarantined'], remove: ['removed'],
      'metadata-reconcile': [...COORDINATION_WORKTREE_STATES],
    };
    if (!allowed[operation.operation_type].includes(state)) throw new CoordinationRuntimeError('invalid-request', `${operation.operation_type} operation cannot commit worktree state ${state}`);
  }

  #assertOperationTransition(previous: CoordinationWorktreeOperation, next: CoordinationWorktreeOperation): void {
    const allowed: Readonly<Record<string, readonly string[]>> = {
      prepared: ['in-progress', 'reconciling', 'compensated', 'failed'],
      'in-progress': ['in-progress', 'verified', 'reconciling', 'compensated', 'failed'],
      reconciling: ['in-progress', 'verified', 'reconciling', 'compensated', 'failed'],
      verified: ['committed', 'reconciling', 'failed'],
      committed: [], compensated: [], failed: [],
    };
    if (!(allowed[previous.stage] ?? []).includes(next.stage)) throw new CoordinationRuntimeError('invalid-state', `worktree operation cannot transition ${previous.stage} -> ${next.stage}`);
    if (next.completed_steps.length < previous.completed_steps.length || previous.completed_steps.some((step, index) => next.completed_steps[index] !== step)) throw new CoordinationRuntimeError('invalid-state', 'worktree operation completed steps cannot be removed or reordered');
    if (next.recovery_attempts < previous.recovery_attempts || next.recovery_attempts > previous.recovery_attempts + 1) throw new CoordinationRuntimeError('invalid-state', 'worktree operation recovery attempts must advance monotonically one at a time');
    if (previous.verification_evidence !== null && canonicalJson(previous.verification_evidence) !== canonicalJson(next.verification_evidence)) throw new CoordinationRuntimeError('invalid-state', 'worktree operation verification evidence is immutable');
    if ((next.stage === 'verified' || next.stage === 'committed' || next.stage === 'compensated' || next.stage === 'failed') && next.verification_evidence === null) throw new CoordinationRuntimeError('invalid-request', `${next.stage} operation requires immutable verification evidence`);
    const requiredSteps = ['preflight-probe', 'external-action', 'postcondition-verification'] as const;
    if ((next.stage === 'verified' || next.stage === 'committed') && (next.completed_steps.length !== requiredSteps.length || requiredSteps.some((step, index) => next.completed_steps[index] !== step))) throw new CoordinationRuntimeError('invalid-state', 'verified operation must complete the closed probe/action/verification step plan in order');
    if ((next.stage === 'verified' || next.stage === 'committed' || next.stage === 'compensated') && next.current_step !== null) throw new CoordinationRuntimeError('invalid-request', `${next.stage} operation cannot retain a current step`);
    if ((next.stage === 'reconciling' || next.stage === 'failed') && next.error_code === null) throw new CoordinationRuntimeError('invalid-request', `${next.stage} operation requires an error code`);
    if ((next.stage === 'in-progress' || next.stage === 'verified' || next.stage === 'committed' || next.stage === 'compensated') && next.error_code !== null) throw new CoordinationRuntimeError('invalid-request', `${next.stage} operation cannot retain an error code`);
  }

  #assertGroupOwner(request: CoordinatorRequestEnvelope, group: CoordinationAcquisitionGroup): void {
    if (group.owner.repo_id !== request.repo_id || group.owner.workstream_run !== this.#workstreamRun(request)) throw new CoordinationRuntimeError('unauthorized-client', 'session does not own acquisition group');
  }

  #assertRequestOwner(request: CoordinatorRequestEnvelope, claimRequest: CoordinationClaimRequest): void {
    if (claimRequest.owner.repo_id !== request.repo_id || claimRequest.owner.workstream_run !== this.#workstreamRun(request)) throw new CoordinationRuntimeError('unauthorized-client', 'session is not the blocking claim owner');
  }

  #assertRequestRequester(request: CoordinatorRequestEnvelope, claimRequest: CoordinationClaimRequest): void {
    if (claimRequest.requester.repo_id !== request.repo_id || claimRequest.requester.workstream_run !== this.#workstreamRun(request)) throw new CoordinationRuntimeError('unauthorized-client', 'session is not the claim requester');
  }

  #blockingLeases(repoId: string, requested: readonly CoordinationRequestedLease[]): readonly CoordinationEditLease[] {
    const leases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? ORDER BY entity_id').all(repoId).map(editLeaseFromRow);
    return Object.freeze(leases.filter((lease) => requested.some((entry) => coordinationPathsOverlap(entry.path, lease.path) && claimModesConflict(entry.mode, lease.mode))));
  }

  #blockingGrantOffers(repoId: string, groupId: string, requested: readonly CoordinationRequestedLease[]): readonly CoordinationAcquisitionGroup[] {
    const offered = this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? ORDER BY entity_id').all(repoId).map(acquisitionGroupFromRow);
    return Object.freeze(offered.filter((group) => group.acquisition_group_id !== groupId && group.state === 'grant-ready' && requested.some((entry) => group.requested_leases.some((offeredLease) => coordinationPathsOverlap(entry.path, offeredLease.path) && claimModesConflict(entry.mode, offeredLease.mode)))));
  }

  #observationWorktreeRoot(owner: CoordinationOwnerIdentity): string {
    const attempt = this.#requireUnitAttempt(owner.repo_id, owner.workstream_run, owner.unit_id, owner.attempt);
    const rows = attempt.role === 'implement' || attempt.role === 'fix'
      ? this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND kind='unit' AND unit_id=? AND attempt=? AND is_current_canonical=1 AND json_extract(payload_json, '$.state')!='removed' ORDER BY canonical_worktree_id").all(owner.repo_id, owner.workstream_run, owner.unit_id, owner.attempt).map(canonicalWorktreeFromRow)
      : this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND kind='main' AND is_current_canonical=1 AND json_extract(payload_json, '$.state')!='removed' ORDER BY canonical_worktree_id").all(owner.repo_id, owner.workstream_run).map(canonicalWorktreeFromRow);
    if (rows.length !== 1 || rows[0] === undefined) throw new CoordinationRuntimeError('invalid-state', 'observation acquisition requires exactly one registered owner worktree', [owner.workstream_run, owner.unit_id, String(owner.attempt), `count=${String(rows.length)}`]);
    return rows[0].canonical_path;
  }

  #insertObservation(observation: CoordinationObservation): void {
    this.#db.prepare('INSERT INTO observations(entity_id, repo_id, workstream_run, acquisition_group_id, payload_json, execution_state, freshness, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(
      observation.observation_id, observation.owner.repo_id, observation.owner.workstream_run, observation.acquisition_group_id, canonicalJson(observation), observation.execution_state, observation.freshness, observation.version,
    );
  }

  #updateObservation(observation: CoordinationObservation): void {
    const result = this.#db.prepare('UPDATE observations SET payload_json=?, execution_state=?, freshness=?, version=? WHERE repo_id=? AND entity_id=?').run(canonicalJson(observation), observation.execution_state, observation.freshness, observation.version, observation.owner.repo_id, observation.observation_id);
    if (result.changes !== 1) throw new CoordinationRuntimeError('invalid-state', `observation ${observation.observation_id} disappeared during mutation`);
  }

  #grantGroup(group: CoordinationAcquisitionGroup, seq: number): { readonly group: CoordinationAcquisitionGroup; readonly observations: readonly CoordinationObservation[]; readonly leases: readonly CoordinationEditLease[] } {
    if (this.#blockingLeases(group.owner.repo_id, group.requested_leases).length > 0) throw new CoordinationRuntimeError('coordinator-contention', 'complete edit-intent set became blocked before grant');
    const observations: CoordinationObservation[] = [];
    const leases: CoordinationEditLease[] = [];
    for (const [index, requested] of group.requested_leases.entries()) {
      if (requested.mode === 'READ') {
        if (requested.source_identity === undefined || requested.source_identity.object_kind === 'missing') throw new CoordinationRuntimeError('invalid-request', 'new READ observation requires an exact tracked blob/tree identity', [requested.path]);
        assertCoordinationObservationSourceIdentity({ cwd: this.#observationWorktreeRoot(group.owner), path: requested.path, expected: requested.source_identity });
        const observation = parseCoordinationObservation({
          schema_version: 'autopilot.observation.v1',
          observation_id: stableEntityId('observation', [group.owner.repo_id, group.acquisition_group_id, String(index), requested.path, requested.source_identity.base_commit, requested.source_identity.object_id]),
          owner: group.owner, acquisition_group_id: group.acquisition_group_id, path: requested.path, purpose: requested.purpose, source_identity: requested.source_identity,
          execution_state: 'active', freshness: 'current', recorded_event_seq: seq, released_event_seq: null, stale_event_seq: null, stale_by_reservation_id: null, stale_by_commit: null, version: 1,
        });
        observations.push(observation);
        continue;
      }
      const lease: CoordinationEditLease = {
        schema_version: 'autopilot.edit_lease.v1',
        edit_lease_id: stableEntityId('lease', [group.owner.repo_id, group.acquisition_group_id, String(index), requested.mode, requested.path]),
        owner: group.owner, acquisition_group_id: group.acquisition_group_id, path: requested.path, mode: requested.mode, purpose: requested.purpose,
        ...(requested.exclusive_operation === undefined ? {} : { exclusive_operation: requested.exclusive_operation }),
        acquired_event_seq: seq, normal_release_condition: group.normal_release_condition, version: 1,
      };
      leases.push(lease);
    }
    const exclusiveOperation = group.requested_leases.find((requested) => requested.mode === 'EXCLUSIVE')?.exclusive_operation;
    if (exclusiveOperation !== undefined && exclusiveOperation.operation_kind !== 'legacy-migration-exclusive') {
      const attempt = this.#requireUnitAttempt(group.owner.repo_id, group.owner.workstream_run, group.owner.unit_id, group.owner.attempt);
      if (attempt.critical_section !== null) throw new CoordinationRuntimeError('invalid-state', 'EXCLUSIVE grant requires an attempt outside every critical section', [group.acquisition_group_id, attempt.critical_section]);
      this.#updateEntity('unit_attempts', unitAttemptEntityId(attempt.owner), { ...attempt, critical_section: exclusiveOperation.critical_section, preemptible: false, version: attempt.version + 1 });
    }
    for (const observation of observations) this.#insertObservation(observation);
    for (const lease of leases) this.#insertEntity('edit_leases', lease.edit_lease_id, lease.owner.repo_id, lease.owner.workstream_run, lease);
    const granted: CoordinationAcquisitionGroup = { ...group, state: 'granted', grant_event_seq: seq, offer_expires_at: null, version: group.version + 1 };
    this.#updateEntity('acquisition_groups', group.acquisition_group_id, granted);
    return { group: granted, observations: Object.freeze(observations), leases: Object.freeze(leases) };
  }

  #ensureClaimRequests(group: CoordinationAcquisitionGroup, blockers: readonly CoordinationEditLease[], seq: number): readonly CoordinationClaimRequest[] {
    const byOwner = new Map<string, CoordinationEditLease[]>();
    for (const blocker of blockers) {
      const key = ownerIdentityKey(blocker.owner);
      const owned = byOwner.get(key) ?? [];
      owned.push(blocker);
      byOwner.set(key, owned);
    }
    const requests: CoordinationClaimRequest[] = [];
    for (const owned of [...byOwner.values()].sort((left, right) => ownerIdentityKey(left[0]?.owner ?? group.owner).localeCompare(ownerIdentityKey(right[0]?.owner ?? group.owner)))) {
      const owner = owned[0]?.owner;
      if (owner === undefined) continue;
      const leaseIds = owned.map((lease) => lease.edit_lease_id).sort();
      const requestId = stableEntityId('claim-request', [group.acquisition_group_id, ownerIdentityKey(owner), ...leaseIds]);
      const existingRow = this.#db.prepare('SELECT * FROM claim_requests WHERE entity_id=?').get(requestId);
      if (existingRow !== undefined) {
        requests.push(claimRequestFromRow(existingRow));
        continue;
      }
      const contested = group.requested_leases.filter((requested) => owned.some((blocker) => coordinationPathsOverlap(requested.path, blocker.path) && claimModesConflict(requested.mode, blocker.mode)));
      if (contested.length === 0) throw new CoordinationRuntimeError('store-corrupt', 'claim request blocker set has no contested edit intention');
      const claimRequest: CoordinationClaimRequest = {
        schema_version: 'autopilot.claim_request.v1', request_id: requestId, acquisition_group_id: group.acquisition_group_id,
        requester: group.owner, owner, blocking_lease_ids: leaseIds, requested_leases: contested, reason: group.reason,
        created_event_seq: seq, status: 'pending', owner_reason: null, release_condition: null, release_event_seq: null, grant_event_seq: null, version: 1,
      };
      this.#db.prepare('INSERT INTO claim_requests(entity_id, repo_id, requester_workstream_run, owner_workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?, ?)').run(requestId, owner.repo_id, group.owner.workstream_run, owner.workstream_run, canonicalJson(claimRequest), claimRequest.version);
      const message: CoordinationMessage = {
        schema_version: 'autopilot.coordination_message.v1', message_id: stableEntityId('message', ['claim-request', requestId]), repo_id: owner.repo_id,
        recipient_workstream_run: owner.workstream_run, message_type: 'claim-request', correlation_id: requestId,
        payload: { request_id: requestId, acquisition_group_id: group.acquisition_group_id, requester_run: group.owner.workstream_run, requester_unit: group.owner.unit_id, requester_attempt: group.owner.attempt, blocking_lease_ids: leaseIds, requested_leases: contested, reason: group.reason },
        status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
      };
      this.#insertMessage(message);
      requests.push(claimRequest);
    }
    return Object.freeze(requests);
  }

  #updateClaimRequest(claimRequest: CoordinationClaimRequest): void {
    const result = this.#db.prepare('UPDATE claim_requests SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(claimRequest), claimRequest.version, claimRequest.request_id);
    if (result.changes !== 1) throw new CoordinationRuntimeError('invalid-state', `claim request ${claimRequest.request_id} disappeared during mutation`);
  }

  #insertMessage(message: CoordinationMessage): void {
    this.#db.prepare('INSERT INTO messages(message_id, repo_id, recipient_workstream_run, message_type, correlation_id, payload_json, status, created_event_seq, delivered_event_seq, acknowledged_event_seq, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      message.message_id, message.repo_id, message.recipient_workstream_run, message.message_type, message.correlation_id, canonicalJson(message.payload), message.status, message.created_event_seq, message.delivered_event_seq, message.acknowledged_event_seq, message.version,
    );
  }

  #releaseNotification(claimRequest: CoordinationClaimRequest, releasedLeaseIds: readonly string[], seq: number): CoordinationMessage {
    return {
      schema_version: 'autopilot.coordination_message.v1', message_id: stableEntityId('message', ['release-notification', claimRequest.request_id, String(seq)]), repo_id: claimRequest.requester.repo_id,
      recipient_workstream_run: claimRequest.requester.workstream_run, message_type: 'release-notification', correlation_id: claimRequest.request_id,
      payload: { request_id: claimRequest.request_id, acquisition_group_id: claimRequest.acquisition_group_id, released_lease_ids: [...releasedLeaseIds], release_event_seq: seq },
      status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
    };
  }

  #markGroupReleasedWhenEmpty(repoId: string, groupId: string): void {
    const leaseCount = sqlInteger(asRow(this.#db.prepare('SELECT COUNT(*) AS count FROM edit_leases WHERE repo_id=? AND json_extract(payload_json, \'$.acquisition_group_id\')=?').get(repoId, groupId), 'group lease count'), 'count');
    const observationCount = sqlInteger(asRow(this.#db.prepare("SELECT COUNT(*) AS count FROM observations WHERE repo_id=? AND acquisition_group_id=? AND execution_state='active'").get(repoId, groupId), 'active group observation count'), 'count');
    if (leaseCount !== 0 || observationCount !== 0) return;
    const group = this.#requireGroup(repoId, groupId);
    if (group.state === 'granted') this.#updateEntity('acquisition_groups', groupId, { ...group, state: 'released', version: group.version + 1 });
  }

  #markSatisfiedRequests(group: CoordinationAcquisitionGroup, seq: number): void {
    for (const claimRequest of this.#claimRequestsForGroup(group.owner.repo_id, group.acquisition_group_id)) {
      if (['resolved', 'cancelled', 'superseded', 'released', 'grant-ready', 'requester-notified'].includes(claimRequest.status)) continue;
      const stillBlocked = claimRequest.blocking_lease_ids.some((leaseId) => this.#db.prepare('SELECT entity_id FROM edit_leases WHERE repo_id=? AND entity_id=?').get(group.owner.repo_id, leaseId) !== undefined);
      if (stillBlocked) continue;
      const released: CoordinationClaimRequest = { ...claimRequest, status: 'released', release_event_seq: seq, version: claimRequest.version + 1 };
      this.#updateClaimRequest(released);
      this.#insertMessage(this.#releaseNotification(released, claimRequest.blocking_lease_ids, seq));
    }
  }

  #reevaluateWaitingGroups(repoId: string, seq: number): void {
    for (const group of this.#db.prepare("SELECT * FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state')='waiting' ORDER BY entity_id").all(repoId).map(acquisitionGroupFromRow)) {
      this.#markSatisfiedRequests(group, seq);
      this.#ensureClaimRequests(group, this.#blockingLeases(repoId, group.requested_leases), seq);
    }
    while (true) {
      const dependencyPriority = this.#grantDependencyPriority(repoId);
      const waiting = this.#db.prepare("SELECT * FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state')='waiting' ORDER BY entity_id").all(repoId).map(acquisitionGroupFromRow).sort((left, right) => (left.bypass_count >= MAX_GRANT_BYPASSES ? 0 : 1) - (right.bypass_count >= MAX_GRANT_BYPASSES ? 0 : 1) || (dependencyPriority.get(coordinationOwnerKey(right.owner)) ?? 0) - (dependencyPriority.get(coordinationOwnerKey(left.owner)) ?? 0) || compareCoordinationGrantPriority(left, right));
      const eligible = waiting.filter((group) => this.#blockingLeases(repoId, group.requested_leases).length === 0 && this.#blockingGrantOffers(repoId, group.acquisition_group_id, group.requested_leases).length === 0);
      const group = eligible[0];
      if (group === undefined) break;
      const offered: CoordinationAcquisitionGroup = { ...group, state: 'grant-ready', offer_expires_at: new Date(this.#clock.now().getTime() + COORDINATOR_GRANT_OFFER_TTL_MS).toISOString(), version: group.version + 1 };
      this.#updateEntity('acquisition_groups', group.acquisition_group_id, offered);
      for (const claimRequest of this.#claimRequestsForGroup(repoId, group.acquisition_group_id)) {
        if (claimRequest.release_event_seq === null || ['cancelled', 'superseded', 'resolved'].includes(claimRequest.status)) continue;
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

  #grantDependencyPriority(repoId: string): ReadonlyMap<string, number> {
    const priorities = new Map<string, number>();
    const leases = new Set(this.#db.prepare('SELECT entity_id FROM edit_leases WHERE repo_id=?').all(repoId).map((row) => sqlString(row, 'entity_id')));
    const requests = this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? ORDER BY entity_id').all(repoId).map(claimRequestFromRow);
    for (const request of requests) {
      if (['resolved', 'cancelled', 'superseded', 'released', 'grant-ready', 'granted', 'requester-notified'].includes(request.status)) continue;
      if (!request.blocking_lease_ids.some((leaseId) => leases.has(leaseId))) continue;
      const key = coordinationOwnerKey(request.owner);
      priorities.set(key, (priorities.get(key) ?? 0) + 1);
    }
    return priorities;
  }

  #ageBypassedGroups(offered: CoordinationAcquisitionGroup, otherwiseEligible: readonly CoordinationAcquisitionGroup[]): void {
    for (const group of otherwiseEligible) {
      const incompatibleWithOffer = group.requested_leases.some((requested) => offered.requested_leases.some((candidate) => coordinationPathsOverlap(requested.path, candidate.path) && claimModesConflict(requested.mode, candidate.mode)));
      if (!incompatibleWithOffer) continue;
      this.#updateEntity('acquisition_groups', group.acquisition_group_id, { ...group, bypass_count: group.bypass_count + 1, version: group.version + 1 });
    }
  }

  #maintainWaitForGraph(repoId: string, seq: number): void {
    for (;;) {
      const requests = this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? ORDER BY entity_id').all(repoId).map(claimRequestFromRow);
    const leases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? ORDER BY entity_id').all(repoId).map(editLeaseFromRow);
    const priorEdges = this.#db.prepare('SELECT * FROM wait_for_edges WHERE repo_id=? ORDER BY entity_id').all(repoId).map(waitForEdgeFromRow);
    const nextEdges = buildCoordinationWaitForEdges({ requests, editLeases: leases, priorEdges, eventSeq: seq });
    const priorById = new Map(priorEdges.map((edge) => [edge.edge_id, edge]));
    for (const edge of nextEdges) {
      const prior = priorById.get(edge.edge_id);
      if (prior === undefined) this.#db.prepare('INSERT INTO wait_for_edges(entity_id, repo_id, request_id, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(edge.edge_id, edge.repo_id, edge.request_id, canonicalJson(edge), edge.version);
      else if (canonicalJson(prior) !== canonicalJson(edge)) this.#db.prepare('UPDATE wait_for_edges SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(edge), edge.version, edge.edge_id);
    }

    const activeEdges = nextEdges.filter((edge) => edge.state === 'active');
    const cycles = detectCoordinationWaitCycles(activeEdges);
    // A repeated pass is required only after cancel-and-supersede removed an
    // eligible victim and its live groups. Compute this finite durable measure
    // only for a cyclic graph so the common acyclic/scale path pays no query.
    const progressMeasure = cycles.length === 0 ? null : this.#deadlockFixedPointMeasure(repoId);
    const liveResolutionIds = new Set<string>();
    for (const cycle of cycles) {
      const resolutionId = stableEntityId('deadlock', [repoId, ...cycle.edge_ids]);
      liveResolutionIds.add(resolutionId);
      const existingRow = this.#db.prepare('SELECT * FROM deadlock_resolutions WHERE entity_id=?').get(resolutionId);
      const existingResolution = existingRow === undefined ? null : deadlockResolutionFromRow(existingRow);
      if (existingResolution !== null && existingResolution.state !== 'deferred-no-safe-victim') continue;
      const attempts = this.#db.prepare('SELECT * FROM unit_attempts WHERE repo_id=? ORDER BY entity_id').all(repoId).map(unitAttemptFromRow);
      const groups = this.#db.prepare('SELECT * FROM acquisition_groups WHERE repo_id=? ORDER BY entity_id').all(repoId).map(acquisitionGroupFromRow);
      const children = this.#db.prepare('SELECT * FROM child_leases WHERE repo_id=? ORDER BY child_lease_id').all(repoId).map(childFromRow);
      const worktrees = this.#db.prepare('SELECT * FROM worktrees WHERE repo_id=? AND is_current_canonical=1 ORDER BY canonical_worktree_id').all(repoId).map(canonicalWorktreeFromRow);
      const operations = this.#db.prepare('SELECT * FROM worktree_operations WHERE repo_id=? ORDER BY entity_id').all(repoId).map(worktreeOperationFromRow);
      const victim = selectCoordinationDeadlockVictim(cycle, { attempts, acquisitionGroups: groups, claimRequests: requests, childLeases: children, worktrees, worktreeOperations: operations });
      if (existingResolution !== null && victim === null) continue;
      const participantOwners = activeEdges.filter((edge) => cycle.edge_ids.includes(edge.edge_id)).flatMap((edge) => [edge.requester, edge.blocker]).filter((owner, index, all) => all.findIndex((candidate) => coordinationOwnerKey(candidate) === coordinationOwnerKey(owner)) === index).sort((left, right) => coordinationOwnerKey(left).localeCompare(coordinationOwnerKey(right)));
      const resolutionVersion = existingResolution === null ? 1 : existingResolution.version + 1;
      const createdEventSeq = existingResolution?.created_event_seq ?? seq;
      const resolution: CoordinationDeadlockResolution = victim === null ? {
        schema_version: 'autopilot.deadlock_resolution.v1', resolution_id: resolutionId, repo_id: repoId, cycle_edge_ids: cycle.edge_ids, participant_owners: participantOwners,
        state: 'deferred-no-safe-victim', victim: null, victim_class: null, action: 'none', reason: 'cycle has no participant outside a critical section with a mechanically safe preemption path', created_event_seq: createdEventSeq, resolved_event_seq: null, version: resolutionVersion,
      } : {
        schema_version: 'autopilot.deadlock_resolution.v1', resolution_id: resolutionId, repo_id: repoId, cycle_edge_ids: cycle.edge_ids, participant_owners: participantOwners,
        state: victim.action === 'cancel-and-supersede' ? 'victim-selected' : 'awaiting-recovery', victim: victim.owner, victim_class: victim.victim_class, action: victim.action,
        reason: victim.action === 'cancel-and-supersede' ? 'queued or preflight victim can be cancelled without source mutation' : 'owner must complete reset or dirty-work quarantine before lease release', created_event_seq: createdEventSeq, resolved_event_seq: null, version: resolutionVersion,
      };
      parseCoordinationDeadlockResolution(resolution);
      if (existingResolution === null) this.#db.prepare('INSERT INTO deadlock_resolutions(entity_id, repo_id, payload_json, version) VALUES(?, ?, ?, ?)').run(resolutionId, repoId, canonicalJson(resolution), resolution.version);
      else if (canonicalJson(existingResolution) !== canonicalJson(resolution)) this.#db.prepare('UPDATE deadlock_resolutions SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(resolution), resolution.version, resolutionId);
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
      if (attempt === undefined) throw new CoordinationRuntimeError('invalid-state', 'selected deadlock victim attempt disappeared');
      for (const group of groups.filter((candidate) => coordinationOwnerKey(candidate.owner) === coordinationOwnerKey(victim.owner) && (candidate.state === 'waiting' || candidate.state === 'grant-ready' || candidate.state === 'granted'))) this.#cancelGroup(group, 'cancelled', seq);
      this.#updateEntity('unit_attempts', unitAttemptEntityId(attempt.owner), { ...attempt, state: 'superseded', version: attempt.version + 1 });
      const resolved: CoordinationDeadlockResolution = { ...resolution, state: 'resolved', resolved_event_seq: seq, version: resolution.version + 1 };
      parseCoordinationDeadlockResolution(resolved);
      this.#db.prepare('UPDATE deadlock_resolutions SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(resolved), resolved.version, resolutionId);
      this.#reevaluateWaitingGroups(repoId, seq);
    }

    const openRows = this.#db.prepare("SELECT * FROM deadlock_resolutions WHERE repo_id=? AND json_extract(payload_json, '$.state')!='resolved' ORDER BY entity_id").all(repoId).map(deadlockResolutionFromRow);
    for (const resolution of openRows) {
      if (liveResolutionIds.has(resolution.resolution_id)) continue;
      const resolved: CoordinationDeadlockResolution = { ...resolution, state: 'resolved', resolved_event_seq: seq, version: resolution.version + 1 };
      parseCoordinationDeadlockResolution(resolved);
      this.#db.prepare('UPDATE deadlock_resolutions SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(resolved), resolved.version, resolution.resolution_id);
    }
    // With no cycle, no resolution branch above can have changed requests,
    // leases, or edges. The already persisted nextEdges are the fixed point;
    // rebuilding and reparsing the entire graph a second time is redundant.
    if (cycles.length === 0) return;
    const refreshedRequests = this.#db.prepare('SELECT * FROM claim_requests WHERE repo_id=? ORDER BY entity_id').all(repoId).map(claimRequestFromRow);
    const refreshedLeases = this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? ORDER BY entity_id').all(repoId).map(editLeaseFromRow);
    const refreshedPrior = this.#db.prepare('SELECT * FROM wait_for_edges WHERE repo_id=? ORDER BY entity_id').all(repoId).map(waitForEdgeFromRow);
    const refreshedEdges = buildCoordinationWaitForEdges({ requests: refreshedRequests, editLeases: refreshedLeases, priorEdges: refreshedPrior, eventSeq: seq });
    for (const edge of refreshedEdges) {
      const prior = refreshedPrior.find((candidate) => candidate.edge_id === edge.edge_id);
      if (prior !== undefined && canonicalJson(prior) !== canonicalJson(edge)) this.#db.prepare('UPDATE wait_for_edges SET payload_json=?, version=? WHERE entity_id=?').run(canonicalJson(edge), edge.version, edge.edge_id);
    }
    const remainingCycles = detectCoordinationWaitCycles(refreshedEdges.filter((edge) => edge.state === 'active'));
    const missingTypedResolution = remainingCycles.some((cycle) => {
      const resolutionId = stableEntityId('deadlock', [repoId, ...cycle.edge_ids]);
      const row = this.#db.prepare("SELECT entity_id FROM deadlock_resolutions WHERE entity_id=? AND json_extract(payload_json, '$.state')!='resolved'").get(resolutionId);
      return row === undefined;
    });
      if (!missingTypedResolution) return;
      const nextProgressMeasure = this.#deadlockFixedPointMeasure(repoId);
      if (progressMeasure === null || nextProgressMeasure >= progressMeasure) throw new CoordinationRuntimeError('store-corrupt', 'deadlock fixed-point progression did not consume an eligible attempt/group', [`before=${String(progressMeasure)}`, `after=${String(nextProgressMeasure)}`]);
    }
  }

  #deadlockFixedPointMeasure(repoId: string): number {
    const eligibleOwners = new Set(this.#db.prepare("SELECT * FROM unit_attempts WHERE repo_id=? AND json_extract(payload_json, '$.state') IN ('queued','preflight') ORDER BY entity_id").all(repoId).map(unitAttemptFromRow).map((attempt) => coordinationOwnerKey(attempt.owner)));
    if (eligibleOwners.size === 0) return 0;
    const eligibleGroups = this.#db.prepare("SELECT * FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state') IN ('waiting','grant-ready','granted') ORDER BY entity_id").all(repoId).map(acquisitionGroupFromRow).filter((group) => eligibleOwners.has(coordinationOwnerKey(group.owner))).length;
    return eligibleOwners.size + eligibleGroups;
  }

  #deferCycleRequests(requestIds: readonly string[]): void {
    for (const requestId of requestIds) {
      const request = this.#requireClaimRequest(requestId);
      if (request.status === 'deferred' || request.status === 'resolved' || request.status === 'cancelled' || request.status === 'superseded') continue;
      const blockers = request.blocking_lease_ids.map((leaseId) => this.#db.prepare('SELECT * FROM edit_leases WHERE repo_id=? AND entity_id=?').get(request.requester.repo_id, leaseId)).filter((row): row is SqlRow => row !== undefined).map(editLeaseFromRow).map((lease) => ({ lease, conditionEventSeq: this.#requireGroup(lease.owner.repo_id, lease.acquisition_group_id).created_event_seq })).sort((left, right) => left.conditionEventSeq - right.conditionEventSeq || left.lease.edit_lease_id.localeCompare(right.lease.edit_lease_id));
      const blocker = blockers[0];
      if (blocker === undefined) continue;
      this.#updateClaimRequest({ ...request, status: 'deferred', owner_reason: 'deadlock policy deferred this request to the earliest declared owner release condition', release_condition: blocker.lease.normal_release_condition, version: request.version + 1 });
    }
  }

  #insertDeadlockResolutionMessage(resolution: CoordinationDeadlockResolution, seq: number): void {
    if (resolution.victim === null) return;
    const messageId = stableEntityId('message', ['deadlock-resolution', resolution.resolution_id]);
    if (this.#db.prepare('SELECT message_id FROM messages WHERE message_id=?').get(messageId) !== undefined) return;
    this.#insertMessage({
      schema_version: 'autopilot.coordination_message.v1', message_id: messageId, repo_id: resolution.repo_id, recipient_workstream_run: resolution.victim.workstream_run,
      message_type: 'deadlock-resolution', correlation_id: resolution.resolution_id,
      payload: { resolution_id: resolution.resolution_id, victim: resolution.victim, victim_class: resolution.victim_class, action: resolution.action, reason: resolution.reason, cycle_edge_ids: resolution.cycle_edge_ids },
      status: 'pending', created_event_seq: seq, delivered_event_seq: null, acknowledged_event_seq: null, version: 1,
    });
  }

  #expireGrantOffers(repoId: string, seq: number): boolean {
    const now = this.#clock.now().toISOString();
    const offered = this.#db.prepare("SELECT * FROM acquisition_groups WHERE repo_id=? AND json_extract(payload_json, '$.state')='grant-ready' ORDER BY entity_id").all(repoId).map(acquisitionGroupFromRow);
    let expired = false;
    for (const group of offered) {
      if (group.offer_expires_at === null || group.offer_expires_at > now) continue;
      expired = true;
      this.#updateEntity('acquisition_groups', group.acquisition_group_id, { ...group, state: 'waiting', offer_expires_at: null, offer_count: group.offer_count + 1, version: group.version + 1 });
      this.#db.prepare("UPDATE messages SET status='acknowledged', delivered_event_seq=COALESCE(delivered_event_seq, ?), acknowledged_event_seq=COALESCE(acknowledged_event_seq, ?), version=version+1 WHERE repo_id=? AND correlation_id=? AND message_type='grant-offer' AND status!='acknowledged'").run(seq, seq, repoId, group.acquisition_group_id);
      this.#advanceMailboxCursor(repoId, group.owner.workstream_run, 'acknowledged');
      for (const claimRequest of this.#claimRequestsForGroup(repoId, group.acquisition_group_id)) {
        if (claimRequest.status === 'grant-ready') this.#updateClaimRequest({ ...claimRequest, status: 'released', version: claimRequest.version + 1 });
      }
    }
    return expired;
  }

  #cancelGroup(group: CoordinationAcquisitionGroup, status: 'cancelled' | 'superseded', seq: number): void {
    if (group.state === 'granted') {
      if (status !== 'cancelled') throw new CoordinationRuntimeError('invalid-state', 'granted acquisition group cannot be superseded before terminal recovery');
      const attempt = this.#requireUnitAttempt(group.owner.repo_id, group.owner.workstream_run, group.owner.unit_id, group.owner.attempt);
      if (attempt.state !== 'preflight') throw new CoordinationRuntimeError('invalid-state', `granted acquisition group can be cancelled only during clean preflight, attempt is ${attempt.state}`);
      const child = this.#db.prepare('SELECT child_lease_id FROM child_leases WHERE repo_id=? AND workstream_run=? AND unit_id=? AND attempt=? LIMIT 1').get(group.owner.repo_id, group.owner.workstream_run, group.owner.unit_id, group.owner.attempt);
      if (child !== undefined) throw new CoordinationRuntimeError('invalid-state', 'granted acquisition group cannot be cancelled after child authority registration');
      const leases = this.#db.prepare("SELECT * FROM edit_leases WHERE repo_id=? AND json_extract(payload_json, '$.acquisition_group_id')=? ORDER BY entity_id").all(group.owner.repo_id, group.acquisition_group_id).map(editLeaseFromRow);
      for (const lease of leases) this.#db.prepare('DELETE FROM edit_leases WHERE repo_id=? AND entity_id=?').run(group.owner.repo_id, lease.edit_lease_id);
      const observations = this.#db.prepare("SELECT * FROM observations WHERE repo_id=? AND acquisition_group_id=? AND execution_state='active' ORDER BY entity_id").all(group.owner.repo_id, group.acquisition_group_id).map(observationFromRow);
      for (const observation of observations) this.#updateObservation(parseCoordinationObservation({ ...observation, execution_state: 'cancelled', released_event_seq: seq, version: observation.version + 1 }));
    } else if (group.state !== 'waiting' && group.state !== 'grant-ready') {
      throw new CoordinationRuntimeError('invalid-state', `cannot ${status} acquisition group in state ${group.state}`);
    }
    this.#updateEntity('acquisition_groups', group.acquisition_group_id, { ...group, state: status, offer_expires_at: null, version: group.version + 1 });
    for (const claimRequest of this.#claimRequestsForGroup(group.owner.repo_id, group.acquisition_group_id)) {
      if (claimRequest.status === 'resolved' || claimRequest.status === 'cancelled' || claimRequest.status === 'superseded') continue;
      this.#updateClaimRequest({ ...claimRequest, status, version: claimRequest.version + 1 });
    }
    const affectedMailboxRuns = this.#db.prepare("SELECT DISTINCT recipient_workstream_run FROM messages WHERE repo_id=? AND (correlation_id=? OR correlation_id IN (SELECT entity_id FROM claim_requests WHERE repo_id=? AND json_extract(payload_json, '$.acquisition_group_id')=?)) AND status!='acknowledged' ORDER BY recipient_workstream_run").all(group.owner.repo_id, group.acquisition_group_id, group.owner.repo_id, group.acquisition_group_id).map((row) => sqlString(row, 'recipient_workstream_run'));
    this.#db.prepare("UPDATE messages SET status='acknowledged', delivered_event_seq=COALESCE(delivered_event_seq, ?), acknowledged_event_seq=COALESCE(acknowledged_event_seq, ?), version=version+1 WHERE repo_id=? AND (correlation_id=? OR correlation_id IN (SELECT entity_id FROM claim_requests WHERE repo_id=? AND json_extract(payload_json, '$.acquisition_group_id')=?)) AND status!='acknowledged'").run(seq, seq, group.owner.repo_id, group.acquisition_group_id, group.owner.repo_id, group.acquisition_group_id);
    for (const workstreamRun of affectedMailboxRuns) this.#advanceMailboxCursor(group.owner.repo_id, workstreamRun, 'acknowledged');
  }

  #repositoryHasCoordinationGraph(repoId: string): boolean {
    if (this.#semanticReplayTransactionActive && this.#semanticReplayGraphlessRepositories.has(repoId)) return false;
    const present = this.#db.prepare("SELECT 1 AS present WHERE EXISTS(SELECT 1 FROM acquisition_groups WHERE repo_id=? LIMIT 1) OR EXISTS(SELECT 1 FROM edit_leases WHERE repo_id=? LIMIT 1) OR EXISTS(SELECT 1 FROM claim_requests WHERE repo_id=? LIMIT 1) OR EXISTS(SELECT 1 FROM wait_for_edges WHERE repo_id=? LIMIT 1)").get(repoId, repoId, repoId, repoId) !== undefined;
    if (!present && this.#semanticReplayTransactionActive) this.#semanticReplayGraphlessRepositories.add(repoId);
    return present;
  }

  #sessionMutation(request: CoordinatorRequestEnvelope, eventType: string, apply: (session: CoordinationSessionLease, sequence: number) => { readonly entityId: string; readonly payload: Readonly<Record<string, unknown>> }): IdempotentEffect {
    return this.#mutation(request, () => {
      const session = this.#requireCurrentSession(request);
      this.#assertVersion(session.version, request.expected_version, 'session lease');
      const seq = this.#nextEventSequence(request.repo_id);
      const applied = apply(session, seq);
      return { sequence: seq, eventType, entityType: 'session-lease', entityId: applied.entityId, payload: applied.payload };
    });
  }

  #mutation(request: CoordinatorRequestEnvelope, apply: () => { readonly sequence: number; readonly eventType: string; readonly entityType: string; readonly entityId: string; readonly payload: Readonly<Record<string, unknown>>; readonly occurredAt?: string; readonly suppressWaitGraphMaintenance?: boolean; readonly afterEventInserted?: () => void }): IdempotentEffect {
    this.#writerGuard.assertHeld();
    const idempotencyKey = request.idempotency_key;
    if (idempotencyKey === null) throw new CoordinationRuntimeError('invalid-request', 'mutation lacks idempotency key');
    const digest = requestDigest(request);
    const ownsTransaction = !this.#semanticReplayTransactionActive;
    if (ownsTransaction) this.#db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.#idempotencyLookup.get(request.repo_id, idempotencyKey);
      if (prior !== undefined) {
        this.#assertReplayAuthority(request);
        if (sqlString(prior, 'request_sha256') !== digest) throw new CoordinationRuntimeError('idempotency-conflict', 'idempotency key was reused with a different request');
        const replay: IdempotentEffect = { committedEventSeq: sqlInteger(prior, 'committed_event_seq'), payload: parseJsonObject(sqlString(prior, 'payload_json'), 'idempotency payload'), replayed: true };
        if (ownsTransaction) this.#db.exec('COMMIT');
        return replay;
      }
      const result = apply();
      for (const [field, value] of Object.entries(result.payload)) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value) && encodedJsonBytes(value) > COORDINATOR_MAX_PAGE_ENTITY_BYTES) throw new CoordinationRuntimeError('frame-too-large', `coordinator action ${request.action} produced an oversized single result entity`, [field]);
        if (Array.isArray(value)) {
          const oversizedIndex = value.findIndex((entry) => encodedJsonBytes(entry) > COORDINATOR_MAX_PAGE_ENTITY_BYTES);
          if (oversizedIndex >= 0) throw new CoordinationRuntimeError('frame-too-large', `coordinator action ${request.action} produced an oversized single collection entity`, [field, `ordinal=${String(oversizedIndex + 1)}`]);
        }
      }
      if (result.suppressWaitGraphMaintenance !== true && (request.action !== 'heartbeat' || this.#repositoryHasCoordinationGraph(request.repo_id))) this.#maintainWaitForGraph(request.repo_id, result.sequence);
      let committed = this.#commitDescription(result.sequence, result.eventType, result.entityType, result.entityId, result.payload);
      const responseFor = (effect: StoreEffect): CoordinatorResponseEnvelope => ({ schema_version: 'autopilot.coordinator_response.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: request.request_id, ok: true, committed_event_seq: effect.committedEventSeq, error_code: null, retryable: false, payload: effect.payload });
      try { this.#assertResponseFitsFrame(responseFor(committed), request.action); }
      catch (error) {
        const externalized = this.#externalizeResultCollections(request, result.sequence, committed.payload);
        if (externalized === null) throw error;
        committed = { committedEventSeq: result.sequence, payload: externalized };
        this.#assertResponseFitsFrame(responseFor(committed), request.action);
      }
      this.#insertEvent.run(request.repo_id, result.sequence, result.eventType, result.entityType, result.entityId, idempotencyKey, digest, result.occurredAt ?? this.#clock.now().toISOString());
      result.afterEventInserted?.();
      this.#insertIdempotencyResult.run(request.repo_id, idempotencyKey, digest, result.sequence, canonicalJson(committed.payload));
      if (ownsTransaction) this.#db.exec('COMMIT');
      return { ...committed, replayed: false };
    } catch (error) {
      if (ownsTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #externalizeResultCollections(request: CoordinatorRequestEnvelope, eventSeq: number, payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null {
    if (request.action === 'drain-mailbox' || request.action === 'complete-child' || request.action === 'complete-adjudication') return null;
    const collections = Object.fromEntries(Object.entries(payload).filter((entry): entry is [string, readonly unknown[]] => Array.isArray(entry[1])));
    if (Object.keys(collections).length === 0) return null;
    const receipt = this.#persistResultReceipt(request.repo_id, this.#workstreamRun(request), request.action, eventSeq, collections);
    const compact: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(payload)) if (!Array.isArray(value)) compact[field] = value;
    compact['result_receipt'] = receipt;
    return Object.freeze(compact);
  }

  #assertResponseFitsFrame(response: CoordinatorResponseEnvelope, action: string): void {
    try {
      const parsed = parseCoordinatorResponseEnvelope(response);
      if (parsed.ok) {
        if (action === 'status' && parsed.payload['schema_version'] === D65_DISPATCH_AUTHORITY_ENVELOPE_SCHEMA) parseD65DispatchAuthorityEnvelope(parsed.payload);
        else if (action === 'status') parseCoordinatorProjectionPage(parsed.payload, 'status');
        else if (action === 'doctor') parseCoordinatorProjectionPage(parsed.payload, 'doctor');
        else if (action === 'run-catalog') parseCoordinatorRunCatalogPage(parsed.payload);
        else if (action === 'migration-recovery') parseCoordinatorMigrationRecoveryPage(parsed.payload);
        else if (action === 'reconciliation-details') parseCoordinatorReconciliationDetailPage(parsed.payload);
        else if (action === 'result-details') parseCoordinatorResultDetailPage(parsed.payload);
        else if (action === 'drain-mailbox') parseCoordinatorMailboxPage(parsed.payload);
        if (parsed.payload['reconciliation_receipt'] !== undefined) parseCoordinationReconciliationReceipt(parsed.payload['reconciliation_receipt']);
        if (parsed.payload['result_receipt'] !== undefined) parseCoordinationResultReceipt(parsed.payload['result_receipt']);
      }
    } catch (error) { throw new CoordinationRuntimeError('frame-too-large', `coordinator action ${action} produced a response outside the bounded outbound contract before commit`, [error instanceof Error ? error.message : String(error)]); }
    const bytes = encodedJsonBytes(response);
    if (bytes >= COORDINATOR_MAX_FRAME_BYTES) throw new CoordinationRuntimeError('frame-too-large', `coordinator action ${action} produced an oversized response before commit`, [`encoded_bytes=${String(bytes)}`, `ceiling=${String(COORDINATOR_MAX_FRAME_BYTES)}`]);
  }

  #commitDescription(sequence: number, eventType: string, entityType: string, entityId: string, payload: Readonly<Record<string, unknown>>): StoreEffect {
    // D65's acceptance result is a frozen closed object persisted byte-for-byte;
    // generic diagnostic event metadata lives in `events`, never inside it.
    if (eventType === 'program-heartbeat-accepted') return { committedEventSeq: sequence, payload };
    return { committedEventSeq: sequence, payload: { ...payload, event_type: eventType, entity_type: entityType, entity_id: entityId } };
  }

  #nextEventSequence(repoId: string): number {
    return sqlInteger(asRow(this.#incrementRepositorySequence.get(repoId), 'repository event sequence'), 'event_seq');
  }

  #pendingMigrationRecovery(repoId: string, workstreamRun: string): readonly CoordinationMigrationRecoveryWork[] {
    return Object.freeze(this.#pendingMigrationRecoveryByRun.all(repoId, workstreamRun).map(migrationRecoveryFromRow));
  }

  #migrationRecoveryClaim(work: CoordinationMigrationRecoveryWork): { readonly path: string; readonly mode: 'READ' | 'WRITE' | 'EXCLUSIVE'; readonly unitId: string; readonly attempt: number; readonly editLeaseId: string } {
    const detail = work.detail;
    const path = detail['claim_path'];
    const mode = detail['claim_mode'];
    const unitId = detail['unit_id'];
    const attempt = detail['attempt'];
    const editLeaseId = detail['edit_lease_id'];
    if (typeof path !== 'string' || typeof unitId !== 'string' || typeof editLeaseId !== 'string' || (mode !== 'READ' && mode !== 'WRITE' && mode !== 'EXCLUSIVE') || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) throw new CoordinationRuntimeError('store-corrupt', 'ambiguous migration recovery detail lacks exact imported claim identity', [work.recovery_id]);
    return { path, mode, unitId, attempt, editLeaseId };
  }

  #readMigrationRecoveryEvidenceFile(run: CoordinationRun, evidence: { readonly ref: string; readonly sha256: `sha256:${string}` }): Uint8Array {
    const repository = repositoryFromRow(asRow(this.#db.prepare('SELECT * FROM repositories WHERE repo_id=?').get(run.repo_id), 'migration recovery repository'));
    const root = resolve(this.#stateRoot, 'migration-recovery-evidence', repository.repo_key, run.workstream_run);
    const path = resolve(root, evidence.ref);
    const relativePath = relative(root, path);
    if (relativePath.length === 0 || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new CoordinationRuntimeError('unauthorized-client', 'migration recovery evidence escapes its coordinator-owned recovery root', [path]);
    let bytes: Uint8Array;
    try {
      const realRoot = realpathSync(root);
      const realPath = realpathSync(path);
      const realRelative = relative(realRoot, realPath);
      if (realRelative.length === 0 || realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) throw new CoordinationRuntimeError('unauthorized-client', 'migration recovery evidence physically escapes its coordinator-owned recovery root', [path]);
      bytes = this.#readRegularEvidenceFile(path, 'migration recovery evidence');
    } catch (error) {
      if (error instanceof CoordinationRuntimeError) throw error;
      throw new CoordinationRuntimeError('recovery-required', 'migration recovery evidence is unreadable', [path, error instanceof Error ? error.message : String(error)]);
    }
    const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (actual !== evidence.sha256) throw new CoordinationRuntimeError('invalid-state', 'migration recovery evidence hash does not match the fenced artifact', [path, `expected=${evidence.sha256}`, `actual=${actual}`]);
    return bytes;
  }

  #parseMigrationRecoveryEvidence(bytes: Uint8Array): Readonly<Record<string, unknown>> {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch (error) { throw new CoordinationRuntimeError('invalid-state', 'migration recovery evidence is not valid UTF-8 JSON', [error instanceof Error ? error.message : String(error)]); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CoordinationRuntimeError('invalid-state', 'migration recovery evidence must be a JSON object');
    return parsed as Readonly<Record<string, unknown>>;
  }

  #verifyMigrationRetentionEvidence(run: CoordinationRun, work: CoordinationMigrationRecoveryWork, claim: { readonly path: string; readonly mode: string; readonly unitId: string; readonly attempt: number; readonly editLeaseId: string }, evidence: { readonly ref: string; readonly sha256: `sha256:${string}` }): void {
    const document = this.#parseMigrationRecoveryEvidence(this.#readMigrationRecoveryEvidenceFile(run, evidence));
    const fields = ['attempt', 'autopilot_id', 'claim_mode', 'claim_path', 'edit_lease_id', 'recorded_event_seq', 'recovery_id', 'repo_id', 'resolution_type', 'schema_version', 'unit_id', 'workstream', 'workstream_run'];
    const actual = Object.keys(document).sort();
    if (actual.length !== fields.length || actual.some((field, index) => field !== [...fields].sort()[index])) throw new CoordinationRuntimeError('schema-mismatch', 'authority retention evidence fields are not the exact closed contract', actual);
    if (document['schema_version'] !== 'autopilot.migration_authority_recovery.v1' || document['resolution_type'] !== 'authority-retained' || document['repo_id'] !== run.repo_id || document['autopilot_id'] !== run.autopilot_id || document['workstream'] !== run.workstream || document['workstream_run'] !== run.workstream_run || document['recovery_id'] !== work.recovery_id || document['claim_path'] !== claim.path || document['claim_mode'] !== claim.mode || document['unit_id'] !== claim.unitId || document['attempt'] !== claim.attempt || document['edit_lease_id'] !== claim.editLeaseId || typeof document['recorded_event_seq'] !== 'number' || !Number.isSafeInteger(document['recorded_event_seq']) || document['recorded_event_seq'] < 1) throw new CoordinationRuntimeError('invalid-state', 'authority retention evidence does not bind the exact imported claim and durable owner', [work.recovery_id]);
  }

  #verifyMigrationReleasePostconditions(run: CoordinationRun, work: CoordinationMigrationRecoveryWork, claim: { readonly path: string; readonly mode: string; readonly unitId: string; readonly attempt: number; readonly editLeaseId: string }, source: Exclude<CoordinationReconciliationSource, 'child-process'>, targetId: string, evidence: { readonly ref: string; readonly sha256: `sha256:${string}` }): readonly string[] {
    const bytes = this.#readMigrationRecoveryEvidenceFile(run, evidence);
    const unitTarget = source === 'unit-merge' || source === 'attempt-reset' || source === 'quarantine-capture' ? parseUnitAttemptTarget(targetId) : null;
    if (unitTarget !== null && (unitTarget.unitId !== claim.unitId || unitTarget.attempt !== claim.attempt)) throw new CoordinationRuntimeError('invalid-state', 'migration recovery release target does not match the exact imported claim owner', [work.recovery_id, targetId]);
    if ((source === 'run-close' || source === 'run-abort') && targetId !== run.workstream_run) throw new CoordinationRuntimeError('invalid-state', 'run-terminal migration recovery target must be the exact durable run', [targetId, run.workstream_run]);
    validateReconciliationEvidenceDocument(bytes, { repoKey: run.repo_id, autopilotId: run.autopilot_id, workstream: run.workstream, workstreamRun: run.workstream_run, source, targetId, unitId: unitTarget?.unitId ?? null, attempt: unitTarget?.attempt ?? null });
    const resource = runResourceFromRow(asRow(this.#db.prepare('SELECT * FROM run_resources WHERE repo_id=? AND workstream_run=?').get(run.repo_id, run.workstream_run), 'migration recovery run resource'));
    const postconditions: string[] = [`claim:${claim.mode}:${claim.path}`, `edit-lease-release:${claim.editLeaseId}`, `evidence:${evidence.sha256}`];
    if (source === 'unit-merge') {
      const facts = parseUnitMergeReservationFacts(bytes);
      const document = this.#parseMigrationRecoveryEvidence(bytes);
      const unitHeadValue = document['unit_head'];
      const unitHead = typeof unitHeadValue === 'string' ? this.#gitQueryText(resource.source_repo, { kind: 'resolve-commit', revision: unitHeadValue }, 'invalid-state', 'migration recovery unit HEAD inspection failed') : null;
      const before = this.#gitQueryText(resource.source_repo, { kind: 'resolve-commit', revision: facts.integrationBefore }, 'invalid-state', 'migration recovery integration-before inspection failed');
      const after = this.#gitQueryText(resource.source_repo, { kind: 'resolve-commit', revision: facts.integrationAfter }, 'invalid-state', 'migration recovery integration-after inspection failed');
      const mergeCommit = this.#gitQueryText(resource.source_repo, { kind: 'resolve-commit', revision: facts.mergeCommitSha }, 'invalid-state', 'migration recovery merge-commit inspection failed');
      const head = this.#gitQueryText(resource.main_worktree_path, { kind: 'head' }, 'invalid-state', 'migration recovery main HEAD inspection failed');
      const branch = this.#gitQueryText(resource.main_worktree_path, { kind: 'current-branch' }, 'invalid-state', 'migration recovery main branch inspection failed');
      const beforeAncestor = before !== null && after !== null && !this.#gitQueryResult(resource.source_repo, { kind: 'is-ancestor', ancestor: before, descendant: after }, 'invalid-state', 'migration recovery integration ancestry inspection failed').negative;
      const unitAncestor = unitHead !== null && after !== null && !this.#gitQueryResult(resource.source_repo, { kind: 'is-ancestor', ancestor: unitHead, descendant: after }, 'invalid-state', 'migration recovery unit ancestry inspection failed').negative;
      const diff = before === null || after === null ? null : this.#gitQueryResult(resource.source_repo, { kind: 'diff-paths', from: before, to: after, noRenames: true }, 'invalid-state', 'migration recovery exact diff inspection failed');
      const actualPaths = diff === null ? [] : this.#gitOutputText(diff, 'invalid-state', 'migration recovery exact diff output is invalid', resource.source_repo).split('\0').filter((entry) => entry.length > 0).map((entry) => entry.replace(/\\/gu, '/')).sort();
      const declaredPaths = [...facts.changedPaths].sort();
      const claimCovered = declaredPaths.some((changedPath) => coordinationPathsOverlap(claim.path, changedPath));
      if (document['main_branch'] !== resource.branch || head !== after || after === null || mergeCommit !== after || branch !== resource.branch || !beforeAncestor || !unitAncestor || diff === null || canonicalJson(actualPaths) !== canonicalJson(declaredPaths) || !claimCovered) throw new CoordinationRuntimeError('invalid-state', 'unit-merge migration recovery lacks exact claim/Git object/ref/ancestry/diff postconditions', [`claim=${claim.path}`, `head=${String(head)}`, `integration_after=${String(after)}`, `branch=${String(branch)}`, `actual_paths=${actualPaths.join(',')}`, `declared_paths=${declaredPaths.join(',')}`]);
      postconditions.push(`main-head:${head}`, `main-branch:${branch}`, `claim-covered-by-diff:${claim.path}`);
    } else if (source === 'attempt-reset') {
      const worktree = this.#migrationRecoveryUnitWorktree(run, claim.unitId, claim.attempt);
      const document = this.#parseMigrationRecoveryEvidence(bytes);
      if (document['unit_worktree_path'] !== worktree.canonical_path || document['capture_commit_sha'] !== null || (worktree.state !== 'terminal' && worktree.state !== 'removed') || existsSync(worktree.canonical_path) || this.#gitWorktreeRegistered(resource.source_repo, worktree.canonical_path) || this.#gitQueryText(resource.source_repo, { kind: 'resolve-commit', revision: `refs/heads/${worktree.branch}` }, 'invalid-state', 'attempt-reset branch inspection failed') !== null) throw new CoordinationRuntimeError('invalid-state', 'attempt-reset migration recovery postconditions are not exact', [worktree.canonical_path, worktree.branch, worktree.state]);
      postconditions.push(`worktree-absent:${worktree.canonical_path}`, `branch-ref-absent:${worktree.branch}`, `worktree-state:${worktree.state}`);
    } else if (source === 'quarantine-capture') {
      const worktree = this.#migrationRecoveryUnitWorktree(run, claim.unitId, claim.attempt);
      const document = this.#parseMigrationRecoveryEvidence(bytes);
      const capture = document['capture_commit_sha'];
      const head = existsSync(worktree.canonical_path) ? this.#gitQueryText(worktree.canonical_path, { kind: 'head' }, 'invalid-state', 'quarantine recovery HEAD inspection failed') : null;
      const branch = existsSync(worktree.canonical_path) ? this.#gitQueryText(worktree.canonical_path, { kind: 'current-branch' }, 'invalid-state', 'quarantine recovery branch inspection failed') : null;
      const branchRef = this.#gitQueryText(resource.source_repo, { kind: 'resolve-commit', revision: `refs/heads/${worktree.branch}` }, 'invalid-state', 'quarantine recovery branch ref inspection failed');
      const cleanResult = existsSync(worktree.canonical_path) ? this.#gitQueryResult(worktree.canonical_path, { kind: 'status-porcelain' }, 'invalid-state', 'quarantine recovery status inspection failed') : null;
      const clean = cleanResult === null ? null : this.#gitOutputText(cleanResult, 'invalid-state', 'quarantine recovery status output is invalid', worktree.canonical_path);
      if (document['unit_worktree_path'] !== worktree.canonical_path || worktree.state !== 'quarantined' || typeof capture !== 'string' || head !== capture || branch !== worktree.branch || branchRef !== capture || clean !== '') throw new CoordinationRuntimeError('invalid-state', 'quarantine migration recovery requires the exact clean captured worktree/ref postcondition', [worktree.canonical_path, String(capture), String(head), String(branch), String(branchRef), String(clean)]);
      postconditions.push(`quarantined-head:${capture}`, `quarantined-branch:${worktree.branch}`, `clean-worktree:${worktree.canonical_path}`);
    } else {
      const expectedStatus = source === 'run-close' ? 'closed' : 'aborted';
      const main = this.#migrationRecoveryMainWorktree(run);
      const terminalSha = parseRunTerminalSha(bytes);
      const archiveRef = `autopilot/archive/${run.workstream_run}/${source === 'run-close' ? 'main' : 'aborted'}`;
      if (run.status !== expectedStatus || (main.state !== 'terminal' && main.state !== 'removed') || existsSync(main.canonical_path) || this.#gitWorktreeRegistered(resource.source_repo, main.canonical_path) || this.#gitQueryText(resource.source_repo, { kind: 'resolve-commit', revision: `refs/heads/${main.branch}` }, 'invalid-state', 'run-terminal main branch inspection failed') !== null || this.#gitQueryText(resource.source_repo, { kind: 'resolve-commit', revision: `refs/heads/${archiveRef}` }, 'invalid-state', 'run-terminal archive ref inspection failed') !== terminalSha || source === 'run-close' && (resource.target_branch === null || this.#gitQueryText(resource.source_repo, { kind: 'resolve-commit', revision: `refs/heads/${resource.target_branch}` }, 'invalid-state', 'run-close target branch inspection failed') !== terminalSha)) throw new CoordinationRuntimeError('invalid-state', 'run-terminal migration recovery postconditions are not exact and terminal state was not changed', [run.status, main.state, main.canonical_path, main.branch, archiveRef, terminalSha]);
      postconditions.push(`run-status:${run.status}`, `main-worktree-absent:${main.canonical_path}`, `archive-ref:${archiveRef}:${terminalSha}`);
    }
    return Object.freeze(postconditions);
  }

  #migrationRecoveryUnitWorktree(run: CoordinationRun, unitId: string, attempt: number): CoordinationWorktree {
    const rows = this.#db.prepare('SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND unit_id=? AND attempt=? AND kind=\'unit\' AND is_current_canonical=1 ORDER BY canonical_worktree_id').all(run.repo_id, run.workstream_run, unitId, attempt).map(canonicalWorktreeFromRow);
    if (rows.length !== 1 || rows[0] === undefined) throw new CoordinationRuntimeError('invalid-state', 'migration recovery requires exactly one matching durable unit worktree', [unitId, String(attempt)]);
    return rows[0];
  }

  #migrationRecoveryMainWorktree(run: CoordinationRun): CoordinationWorktree {
    const rows = this.#db.prepare("SELECT * FROM worktrees WHERE repo_id=? AND workstream_run=? AND kind='main' AND is_current_canonical=1 ORDER BY canonical_worktree_id").all(run.repo_id, run.workstream_run).map(canonicalWorktreeFromRow);
    if (rows.length !== 1 || rows[0] === undefined) throw new CoordinationRuntimeError('invalid-state', 'migration recovery requires exactly one durable main worktree', [run.workstream_run]);
    return rows[0];
  }

  #gitQueryResult(cwd: string, descriptor: GitQueryDescriptor, failureCode: CoordinationFailureCode, message: string): GitQueryResult {
    try { return runGitQuery({ cwd, descriptor }); }
    catch (error) {
      if (error instanceof GitQueryError) throw new CoordinationRuntimeError(failureCode, message, [cwd, error.message, error.diagnostic]);
      throw error;
    }
  }

  #gitOutputText(result: GitQueryResult, failureCode: CoordinationFailureCode, message: string, cwd: string): string {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout); }
    catch { throw new CoordinationRuntimeError(failureCode, message, [cwd, result.descriptor, 'Git output is not valid UTF-8']); }
  }

  #gitQueryText(cwd: string, descriptor: GitQueryDescriptor, failureCode: CoordinationFailureCode, message: string): string | null {
    const result = this.#gitQueryResult(cwd, descriptor, failureCode, message);
    return result.negative ? null : this.#gitOutputText(result, failureCode, `${message}; Git output is not valid UTF-8`, cwd).trim();
  }

  #gitWorktreeRegistered(repoRoot: string, candidate: string): boolean {
    const result = this.#gitQueryResult(repoRoot, { kind: 'worktree-list', nul: true }, 'recovery-required', 'Git worktree registration inspection failed');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout); }
    catch { throw new CoordinationRuntimeError('recovery-required', 'Git worktree registration output is not valid UTF-8', [repoRoot]); }
    const expected = resolve(candidate);
    return text.split('\0').some((entry) => entry.startsWith('worktree ') && resolve(entry.slice('worktree '.length)) === expected);
  }

  #requireRun(repoId: string, workstreamRun: string): CoordinationRun {
    return runFromRow(asRow(this.#runByIdentity.get(repoId, workstreamRun), 'run'));
  }

  #activeRunFaults(repoId: string, workstreamRun: string): readonly SqlRow[] {
    return this.#db.prepare("SELECT fault_id,invariant_id,fault_code FROM run_scoped_faults WHERE repo_id=? AND workstream_run=? AND status='active' ORDER BY fault_id LIMIT 33").all(repoId, workstreamRun);
  }

  #assertAuthorityCriticalMutationAllowed(repoId: string, workstreamRun: string, action: string): void {
    const faults = this.#activeRunFaults(repoId, workstreamRun);
    if (faults.length === 0) return;
    throw new CoordinationRuntimeError('recovery-required', `authority-critical mutation ${action} is fenced by run-scoped logical store faults`, faults.slice(0, 32).map((row) => `${sqlString(row, 'fault_id')}:${sqlString(row, 'invariant_id')}:${sqlString(row, 'fault_code')}`));
  }

  #assertSourceChangingDispatchAllowed(repoId: string, workstreamRun: string, action: string): void {
    this.#assertAuthorityCriticalMutationAllowed(repoId, workstreamRun, `source-changing dispatch:${action}`);
  }

  #requireCoordinatorEditAuthority(run: CoordinationRun, operation: string): void {
    if (run.coordination_authority !== 'coordinator-edit-leases-v1') throw new CoordinationRuntimeError('unauthorized-client', `${operation} refused because ${run.workstream_run} is legacy-path-claim authoritative`);
  }

  #requireCurrentSession(request: CoordinatorRequestEnvelope): CoordinationSessionLease {
    const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
    if ((run.status === 'closed' || run.status === 'aborted') && !TERMINAL_SESSION_ACTIONS.has(request.action)) throw new CoordinationRuntimeError('invalid-state', `terminal run ${run.workstream_run} rejects new coordination action ${request.action}`);
    const sessionId = this.#sessionId(request);
    const generation = request.fencing_generation;
    if (generation === null || generation !== run.active_session_generation) throw new CoordinationRuntimeError('fenced-session', 'session generation is no longer current');
    let row = this.#attachedSessionByIdentity.get(request.repo_id, run.workstream_run, sessionId, generation);
    const handoffCadenceAction = request.action === 'detach-session' || (this.#isD65Run(run.repo_id, run.workstream_run) && (request.action === 'register-authoritative-artifact' || request.action === 'accept-program-heartbeat'));
    if (row === undefined && handoffCadenceAction) row = this.#db.prepare("SELECT * FROM session_leases WHERE repo_id=? AND workstream_run=? AND session_id=? AND session_generation=? AND status='handoff-pending'").get(request.repo_id, run.workstream_run, sessionId, generation);
    if (row === undefined) throw new CoordinationRuntimeError('fenced-session', 'session is not attached to the durable run supervisor');
    if (sqlString(row, 'session_lease_id') !== payloadString(request.payload, 'session_lease_id')) throw new CoordinationRuntimeError('unauthorized-client', 'session lease identity does not match current authority');
    this.#assertCapability(row, 'session_token_sha256', payloadString(request.payload, 'session_token'), 'session');
    const session = sessionFromRow(row);
    if (session.attachment_kind === 'migration-recovery' && !MIGRATION_RECOVERY_SESSION_ACTIONS.has(request.action)) throw new CoordinationRuntimeError('unauthorized-client', `recovery-only session rejects ordinary dispatch action ${request.action}`);
    if (session.attachment_kind === 'migration-recovery') assertCoordinationMigrationRecoveryOperationAuthorized(this.#stateRoot, request.payload['migration_operation_token']);
    const pendingRecovery = this.#pendingMigrationRecovery(run.repo_id, run.workstream_run);
    if (session.attachment_kind !== 'migration-recovery' && pendingRecovery.length > 0 && !['detach-session', 'heartbeat'].includes(request.action)) throw new CoordinationRuntimeError('recovery-required', 'ordinary session is fenced from dispatch while migration recovery remains pending; query migration-recovery for exact identities', [`pending_count=${String(pendingRecovery.length)}`]);
    return session;
  }

  #assertReplayAuthority(request: CoordinatorRequestEnvelope): void {
    if (request.action === 'attach-run') return;
    if (request.action === 'heartbeat-child' || request.action === 'complete-child') {
      const childId = payloadString(request.payload, 'child_lease_id');
      const row = asRow(this.#db.prepare('SELECT * FROM child_leases WHERE child_lease_id=?').get(childId), 'child replay authority');
      this.#assertChildAuthority(request, childFromRow(row), row);
      return;
    }
    const sessionLeaseId = payloadString(request.payload, 'session_lease_id');
    const row = asRow(this.#db.prepare('SELECT * FROM session_leases WHERE session_lease_id=?').get(sessionLeaseId), 'session replay authority');
    const session = sessionFromRow(row);
    if (session.attachment_kind === 'migration-recovery') assertCoordinationMigrationRecoveryOperationAuthorized(this.#stateRoot, request.payload['migration_operation_token']);
    const run = this.#requireRun(request.repo_id, this.#workstreamRun(request));
    if (session.repo_id !== request.repo_id || session.workstream_run !== run.workstream_run || session.session_id !== request.session_id || session.session_generation !== request.fencing_generation || session.session_generation !== run.active_session_generation) throw new CoordinationRuntimeError('fenced-session', 'idempotent replay session is no longer the current generation');
    const d65HandoffCadenceReplay = this.#isD65Run(run.repo_id, run.workstream_run) && (request.action === 'register-authoritative-artifact' || request.action === 'accept-program-heartbeat');
    const allowedStatuses: readonly CoordinationSessionLease['status'][] = request.action === 'prepare-handoff'
      ? ['handoff-pending']
      : request.action === 'detach-session' || request.action === 'attach-terminal-recovery'
        ? ['detached']
        : d65HandoffCadenceReplay
          ? ['attached', 'handoff-pending']
          : ['attached'];
    if (!allowedStatuses.includes(session.status)) throw new CoordinationRuntimeError('fenced-session', `idempotent replay requires session status in ${allowedStatuses.join('|')}`);
    this.#assertCapability(row, 'session_token_sha256', payloadString(request.payload, 'session_token'), 'session');
  }

  #assertChildAuthority(request: CoordinatorRequestEnvelope, child: CoordinationChildLease, row: SqlRow): void {
    if (child.owner.repo_id !== request.repo_id || child.owner.workstream_run !== this.#workstreamRun(request)) throw new CoordinationRuntimeError('unauthorized-client', 'client does not own child lease');
    if (child.pid !== payloadInteger(request.payload, 'pid') || child.boot_id !== payloadString(request.payload, 'boot_id')) throw new CoordinationRuntimeError('unauthorized-client', 'child process identity does not match its lease');
    this.#assertCapability(row, 'child_token_sha256', payloadString(request.payload, 'child_token'), 'child');
  }

  #assertCapability(row: SqlRow, field: string, token: string, label: string): void {
    const expected = Buffer.from(sqlString(row, field), 'utf8');
    const actual = Buffer.from(createHash('sha256').update(token, 'utf8').digest('hex'), 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new CoordinationRuntimeError('unauthorized-client', `${label} capability does not match its lease`);
  }

  #assertVersion(actual: number, expected: number | null, label: string): void {
    if (expected === null || actual !== expected) throw new CoordinationRuntimeError('stale-version', `${label} version ${String(actual)} does not match expected ${String(expected)}`);
  }

  #workstreamRun(request: CoordinatorRequestEnvelope): string {
    if (request.workstream_run === null) throw new CoordinationRuntimeError('invalid-request', 'request lacks workstream_run');
    return request.workstream_run;
  }

  #sessionId(request: CoordinatorRequestEnvelope): string {
    if (request.session_id === null) throw new CoordinationRuntimeError('invalid-request', 'request lacks session_id');
    return request.session_id;
  }
}

export function coordinationErrorCode(value: string | null): CoordinationFailureCode {
  return isS2CoordinationFailureCode(value) ? value : 'system-fatal';
}
