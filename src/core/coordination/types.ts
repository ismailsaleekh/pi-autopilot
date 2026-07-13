export const AUTOPILOT_COORDINATION_SNAPSHOT_SCHEMA = 'autopilot.coordination_snapshot.v1' as const;
export const AUTOPILOT_COORDINATOR_PROTOCOL_VERSION = '1.3' as const;
export const AUTOPILOT_COORDINATOR_REQUEST_SCHEMA = 'autopilot.coordinator_request.v1' as const;
export const AUTOPILOT_COORDINATOR_RESPONSE_SCHEMA = 'autopilot.coordinator_response.v1' as const;
export const AUTOPILOT_COORDINATION_PREFLIGHT_SCHEMA = 'autopilot.coordination_preflight.v1' as const;

export const COORDINATION_CLAIM_MODES = ['READ', 'WRITE', 'EXCLUSIVE'] as const;
export const COORDINATION_RUN_STATUSES = ['active', 'paused', 'merging', 'blocked', 'recovering', 'closed', 'aborted'] as const;
export const COORDINATION_SESSION_STATUSES = ['attached', 'handoff-pending', 'detached', 'fenced', 'expired'] as const;
export const COORDINATION_SESSION_ATTACHMENT_KINDS = ['dispatch', 'terminal-recovery', 'migration-recovery'] as const;
export const COORDINATION_MIGRATION_RECOVERY_TYPES = ['ambiguous-live-claim', 'orphan-worktree', 'git-metadata-mismatch', 'unreachable-live-process'] as const;
export const COORDINATION_MIGRATION_RECOVERY_STATUSES = ['pending', 'resolved'] as const;
export const COORDINATION_MIGRATION_RECOVERY_RESOLUTIONS = ['authority-retained', 'authority-released'] as const;
export const COORDINATION_CHILD_STATUSES = ['preflight', 'running', 'terminal', 'recovery-required'] as const;
export const COORDINATION_UNIT_STATES = ['queued', 'preflight', 'running', 'transport-complete', 'merged', 'failed', 'reset', 'quarantined', 'superseded'] as const;
export const COORDINATION_UNIT_ROLES = ['strategy', 'implement', 'validate', 'fix', 'adjudicate', 'bughunt', 'extract', 'unknown'] as const;
export const COORDINATION_ACQUISITION_STATES = ['waiting', 'grant-ready', 'granted', 'released', 'cancelled', 'superseded'] as const;
export const COORDINATION_ACQUISITION_KINDS = ['initial', 'materialization-read-expansion', 'legacy-unknown'] as const;
export const COORDINATION_REQUEST_STATUSES = ['pending', 'delivered', 'acknowledged', 'release-now', 'deferred', 'released', 'grant-ready', 'granted', 'requester-notified', 'resolved', 'cancelled', 'superseded', 'contradiction-review'] as const;
export const COORDINATION_MESSAGE_STATUSES = ['pending', 'delivered', 'acknowledged'] as const;
export const COORDINATION_OPERATION_STAGES = ['prepared', 'in-progress', 'verified', 'committed', 'reconciling', 'compensated', 'failed'] as const;
export const COORDINATION_WORKTREE_STATES = ['planned', 'active', 'dirty', 'quarantined', 'terminal', 'removed'] as const;
export const COORDINATION_WORKTREE_KINDS = ['main', 'unit'] as const;
export const COORDINATION_OPERATION_TYPES = ['create', 'materialize', 'commit', 'merge', 'reset', 'quarantine', 'archive', 'remove'] as const;
export const COORDINATION_RELEASE_CONDITION_TYPES = ['child-terminal', 'unit-merged', 'attempt-reset', 'quarantine-captured', 'run-closed', 'explicit-owner-release'] as const;
export const COORDINATION_RECONCILIATION_SOURCES = ['child-process', 'unit-merge', 'attempt-reset', 'quarantine-capture', 'run-close', 'run-abort'] as const;
export const COORDINATION_RESERVATION_OBLIGATION_STATES = ['waiting-for-predecessor', 'integration-required', 'resolved', 'cancelled'] as const;
export const COORDINATION_MESSAGE_TYPES = ['claim-request', 'release-notification', 'grant-offer', 'recovery-required', 'reservation-overlap', 'reservation-landed', 'deadlock-resolution', 'adjudication-assignment'] as const;
export const COORDINATION_WAIT_EDGE_STATES = ['active', 'resolved'] as const;
export const COORDINATION_DEADLOCK_STATES = ['detected', 'victim-selected', 'awaiting-recovery', 'resolved', 'deferred-no-safe-victim'] as const;
export const COORDINATION_DEADLOCK_ACTIONS = ['cancel-and-supersede', 'request-reset-or-quarantine', 'none'] as const;
export const COORDINATION_OPERATIONAL_ESCALATION_REASONS = ['claim-conflict', 'offline-peer', 'handoff', 'stale-session', 'dirty-worktree', 'merge-conflict', 'failed-test', 'stale-validation', 'deadlock', 'starvation', 'disk-pressure', 'cleanup-failure', 'reconciliation-failure'] as const;

export type CoordinationClaimMode = (typeof COORDINATION_CLAIM_MODES)[number];
export type CoordinationRunStatus = (typeof COORDINATION_RUN_STATUSES)[number];
export type CoordinationSessionStatus = (typeof COORDINATION_SESSION_STATUSES)[number];
export type CoordinationSessionAttachmentKind = (typeof COORDINATION_SESSION_ATTACHMENT_KINDS)[number];
export type CoordinationMigrationRecoveryType = (typeof COORDINATION_MIGRATION_RECOVERY_TYPES)[number];
export type CoordinationMigrationRecoveryStatus = (typeof COORDINATION_MIGRATION_RECOVERY_STATUSES)[number];
export type CoordinationMigrationRecoveryResolutionType = (typeof COORDINATION_MIGRATION_RECOVERY_RESOLUTIONS)[number];
export type CoordinationChildStatus = (typeof COORDINATION_CHILD_STATUSES)[number];
export type CoordinationUnitState = (typeof COORDINATION_UNIT_STATES)[number];
export type CoordinationUnitRole = (typeof COORDINATION_UNIT_ROLES)[number];
export type CoordinationAcquisitionState = (typeof COORDINATION_ACQUISITION_STATES)[number];
export type CoordinationAcquisitionKind = (typeof COORDINATION_ACQUISITION_KINDS)[number];
export type CoordinationRequestStatus = (typeof COORDINATION_REQUEST_STATUSES)[number];
export type CoordinationMessageStatus = (typeof COORDINATION_MESSAGE_STATUSES)[number];
export type CoordinationOperationStage = (typeof COORDINATION_OPERATION_STAGES)[number];
export type CoordinationWorktreeState = (typeof COORDINATION_WORKTREE_STATES)[number];
export type CoordinationWorktreeKind = (typeof COORDINATION_WORKTREE_KINDS)[number];
export type CoordinationWorktreeOperationType = (typeof COORDINATION_OPERATION_TYPES)[number];
export type CoordinationReleaseConditionType = (typeof COORDINATION_RELEASE_CONDITION_TYPES)[number];
export type CoordinationReconciliationSource = (typeof COORDINATION_RECONCILIATION_SOURCES)[number];
export type CoordinationReservationObligationState = (typeof COORDINATION_RESERVATION_OBLIGATION_STATES)[number];
export type CoordinationMessageType = (typeof COORDINATION_MESSAGE_TYPES)[number];
export type CoordinationWaitForEdgeState = (typeof COORDINATION_WAIT_EDGE_STATES)[number];
export type CoordinationDeadlockState = (typeof COORDINATION_DEADLOCK_STATES)[number];
export type CoordinationDeadlockAction = (typeof COORDINATION_DEADLOCK_ACTIONS)[number];
export type CoordinationDeadlockVictimClass = 1 | 2 | 3;
export type CoordinationOperationalEscalationReason = (typeof COORDINATION_OPERATIONAL_ESCALATION_REASONS)[number];

export interface CoordinationEvidenceRef {
  readonly ref: string;
  readonly sha256: `sha256:${string}`;
}

export interface CoordinationOwnerIdentity {
  readonly repo_id: string;
  readonly autopilot_id: string;
  readonly workstream_run: string;
  readonly unit_id: string;
  readonly attempt: number;
}

export interface CoordinationReleaseCondition {
  readonly condition_type: CoordinationReleaseConditionType;
  readonly target_id: string;
  readonly evidence: CoordinationEvidenceRef | null;
}

export interface CoordinationRepository {
  readonly schema_version: 'autopilot.coordination_repository.v1';
  readonly repo_id: string;
  readonly repo_key: string;
  readonly canonical_root: string;
  readonly git_common_dir: string;
  readonly created_event_seq: number;
  readonly version: number;
}

export interface CoordinationRun {
  readonly schema_version: 'autopilot.coordination_run.v1';
  readonly repo_id: string;
  readonly autopilot_id: string;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly coordination_authority: 'legacy-path-claims-v1' | 'coordinator-edit-leases-v1';
  readonly status: CoordinationRunStatus;
  readonly active_session_generation: number;
  readonly created_event_seq: number;
  readonly version: number;
}

/** Immutable physical/runtime identity required to reconstruct a run without legacy files. */
export interface CoordinationRunResource {
  readonly schema_version: 'autopilot.coordination_run_resource.v1';
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly source_repo: string;
  readonly git_common_dir: string;
  readonly worktree_root: string;
  readonly main_worktree_path: string;
  readonly runtime_root: string;
  readonly branch: string;
  readonly target_branch: string | null;
  readonly target_base_sha: string;
  readonly origin_url: string | null;
  readonly started_at: string;
  readonly version: number;
}

export interface CoordinationSessionLease {
  readonly schema_version: 'autopilot.session_lease.v2';
  readonly session_lease_id: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly session_id: string;
  readonly session_generation: number;
  readonly pid: number;
  readonly boot_id: string;
  readonly lease_expires_at: string;
  readonly attachment_kind: CoordinationSessionAttachmentKind;
  readonly status: CoordinationSessionStatus;
  readonly attached_event_seq: number;
  readonly version: number;
}

export interface CoordinationMigrationRecoveryResolution {
  readonly resolution_type: CoordinationMigrationRecoveryResolutionType;
  readonly evidence: CoordinationEvidenceRef;
  readonly release_source: Exclude<CoordinationReconciliationSource, 'child-process'> | null;
  readonly release_target_id: string | null;
  readonly exact_postconditions: readonly string[];
}

export interface CoordinationMigrationRecoveryWork {
  readonly schema_version: 'autopilot.migration_recovery_work.v2';
  readonly recovery_id: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly recovery_type: CoordinationMigrationRecoveryType;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly status: CoordinationMigrationRecoveryStatus;
  readonly resolution: CoordinationMigrationRecoveryResolution | null;
  readonly created_event_seq: number;
  readonly resolved_event_seq: number | null;
  readonly version: number;
}

export interface CoordinationChildLease {
  readonly schema_version: 'autopilot.child_lease.v1';
  readonly child_lease_id: string;
  readonly owner: CoordinationOwnerIdentity;
  readonly pid: number;
  readonly boot_id: string;
  readonly lease_expires_at: string;
  readonly status: CoordinationChildStatus;
  readonly terminal_evidence: CoordinationEvidenceRef | null;
  readonly version: number;
}

export interface CoordinationUnitAttempt {
  readonly schema_version: 'autopilot.unit_attempt.v1';
  readonly owner: CoordinationOwnerIdentity;
  readonly state: CoordinationUnitState;
  readonly role: CoordinationUnitRole;
  readonly spec: CoordinationEvidenceRef;
  readonly preemptible: boolean;
  readonly checkpoint_ordinal: number;
  readonly critical_section: string | null;
  readonly version: number;
}

export interface CoordinationRequestedLease {
  readonly path: string;
  readonly mode: CoordinationClaimMode;
  readonly purpose: string;
}

export interface CoordinationAcquisitionGroup {
  readonly schema_version: 'autopilot.acquisition_group.v2';
  readonly acquisition_group_id: string;
  readonly owner: CoordinationOwnerIdentity;
  readonly acquisition_kind: CoordinationAcquisitionKind;
  readonly requested_leases: readonly CoordinationRequestedLease[];
  readonly reason: string;
  readonly normal_release_condition: CoordinationReleaseCondition;
  readonly state: CoordinationAcquisitionState;
  readonly created_event_seq: number;
  readonly fairness_event_seq: number;
  readonly grant_event_seq: number | null;
  readonly offer_expires_at: string | null;
  readonly offer_count: number;
  readonly bypass_count: number;
  readonly version: number;
}

export interface CoordinationEditLease {
  readonly schema_version: 'autopilot.edit_lease.v1';
  readonly edit_lease_id: string;
  readonly owner: CoordinationOwnerIdentity;
  readonly acquisition_group_id: string;
  readonly path: string;
  readonly mode: CoordinationClaimMode;
  readonly purpose: string;
  readonly acquired_event_seq: number;
  readonly normal_release_condition: CoordinationReleaseCondition;
  readonly version: number;
}

export interface CoordinationChangeReservation {
  readonly schema_version: 'autopilot.change_reservation.v1';
  readonly reservation_id: string;
  readonly repo_id: string;
  readonly autopilot_id: string;
  readonly workstream_run: string;
  readonly path: string;
  readonly merge_evidence: CoordinationEvidenceRef;
  readonly created_event_seq: number;
  readonly released_event_seq: number | null;
  readonly terminal_outcome: 'closed' | 'aborted' | null;
  readonly terminal_sha: string | null;
  readonly version: number;
}

export interface CoordinationReservationObligation {
  readonly schema_version: 'autopilot.reservation_obligation.v1';
  readonly obligation_id: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly reservation_id: string;
  readonly predecessor_reservation_id: string;
  readonly overlapping_paths: readonly string[];
  readonly state: CoordinationReservationObligationState;
  readonly created_event_seq: number;
  readonly predecessor_released_event_seq: number | null;
  readonly predecessor_terminal_sha: string | null;
  readonly integration_evidence: CoordinationEvidenceRef | null;
  readonly validation_evidence: CoordinationEvidenceRef | null;
  readonly resolved_event_seq: number | null;
  readonly version: number;
}

export interface CoordinationRunTerminalIntent {
  readonly schema_version: 'autopilot.run_terminal_intent.v1';
  readonly terminal_intent_id: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly outcome: 'closed' | 'aborted';
  readonly state: 'prepared' | 'committed' | 'cancelled';
  readonly reservation_ids: readonly string[];
  readonly prepared_event_seq: number;
  readonly terminal_event_seq: number | null;
  readonly version: number;
}

export interface CoordinationClaimRequest {
  readonly schema_version: 'autopilot.claim_request.v1';
  readonly request_id: string;
  readonly acquisition_group_id: string;
  readonly requester: CoordinationOwnerIdentity;
  readonly owner: CoordinationOwnerIdentity;
  readonly blocking_lease_ids: readonly string[];
  readonly requested_leases: readonly CoordinationRequestedLease[];
  readonly reason: string;
  readonly created_event_seq: number;
  readonly status: CoordinationRequestStatus;
  readonly owner_reason: string | null;
  readonly release_condition: CoordinationReleaseCondition | null;
  readonly release_event_seq: number | null;
  readonly grant_event_seq: number | null;
  readonly version: number;
}

export interface CoordinationMailboxCursor {
  readonly schema_version: 'autopilot.mailbox_cursor.v1';
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly delivered_through_event_seq: number;
  readonly acknowledged_through_event_seq: number;
  readonly version: number;
}

export interface CoordinationReconciliationEvidence {
  readonly schema_version: 'autopilot.reconciliation_evidence.v1';
  readonly reconciliation_evidence_id: string;
  readonly repo_id: string;
  readonly autopilot_id: string;
  readonly workstream_run: string;
  readonly source: CoordinationReconciliationSource;
  readonly release_condition: CoordinationReleaseCondition;
  readonly accepted_event_seq: number;
  readonly version: number;
}

export interface CoordinationReconciliationSummary {
  readonly released_lease_ids: readonly string[];
  readonly released_request_ids: readonly string[];
  readonly notification_ids: readonly string[];
  readonly offered_group_ids: readonly string[];
}

export interface CoordinationMessage {
  readonly schema_version: 'autopilot.coordination_message.v1';
  readonly message_id: string;
  readonly repo_id: string;
  readonly recipient_workstream_run: string;
  readonly message_type: CoordinationMessageType;
  readonly correlation_id: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: CoordinationMessageStatus;
  readonly created_event_seq: number;
  readonly delivered_event_seq: number | null;
  readonly acknowledged_event_seq: number | null;
  readonly version: number;
}

export interface CoordinationWorktree {
  readonly schema_version: 'autopilot.coordination_worktree.v2';
  readonly worktree_id: string;
  readonly owner: CoordinationOwnerIdentity;
  readonly kind: CoordinationWorktreeKind;
  readonly canonical_path: string;
  readonly git_common_dir: string;
  readonly branch: string;
  readonly state: CoordinationWorktreeState;
  readonly version: number;
}

/**
 * Closed, data-only operation intent. The coordinator never accepts shell text:
 * the package runtime maps operation_type plus these bounded values to fixed Git/
 * filesystem actions. Null fields are explicit so migrations and replay cannot
 * silently infer missing authority.
 */
export interface CoordinationWorktreeOperationIntent {
  readonly repo_root: string;
  readonly worktree_path: string;
  readonly git_common_dir: string;
  readonly branch: string;
  readonly reason: string;
  readonly base_sha: string | null;
  readonly target_sha: string | null;
  readonly archive_ref: string | null;
  readonly checkout_mode: 'full' | 'claim-minimal' | 'exclude-heavy' | null;
  readonly sparse_patterns: readonly string[];
  readonly paths: readonly string[];
  readonly metadata_refs: readonly string[];
}

export interface CoordinationWorktreeOperation {
  readonly schema_version: 'autopilot.worktree_operation.v2';
  readonly operation_id: string;
  readonly worktree_id: string;
  readonly owner: CoordinationOwnerIdentity;
  readonly operation_type: CoordinationWorktreeOperationType;
  readonly stage: CoordinationOperationStage;
  readonly authority_version: number;
  readonly intent_event_seq: number;
  readonly intent: CoordinationWorktreeOperationIntent;
  readonly completed_steps: readonly string[];
  readonly current_step: string | null;
  readonly recovery_attempts: number;
  readonly verification_evidence: CoordinationEvidenceRef | null;
  readonly error_code: string | null;
  readonly version: number;
}

export interface CoordinationWaitForEdge {
  readonly schema_version: 'autopilot.wait_for_edge.v1';
  readonly edge_id: string;
  readonly repo_id: string;
  readonly request_id: string;
  readonly requester: CoordinationOwnerIdentity;
  readonly blocker: CoordinationOwnerIdentity;
  readonly state: CoordinationWaitForEdgeState;
  readonly created_event_seq: number;
  readonly resolved_event_seq: number | null;
  readonly version: number;
}

export interface CoordinationDeadlockResolution {
  readonly schema_version: 'autopilot.deadlock_resolution.v1';
  readonly resolution_id: string;
  readonly repo_id: string;
  readonly cycle_edge_ids: readonly string[];
  readonly participant_owners: readonly CoordinationOwnerIdentity[];
  readonly state: CoordinationDeadlockState;
  readonly victim: CoordinationOwnerIdentity | null;
  readonly victim_class: CoordinationDeadlockVictimClass | null;
  readonly action: CoordinationDeadlockAction;
  readonly reason: string;
  readonly created_event_seq: number;
  readonly resolved_event_seq: number | null;
  readonly version: number;
}

export interface CoordinationContradictionClause {
  readonly authoritative_ref: CoordinationEvidenceRef;
  readonly source_type: 'mission' | 'master-plan' | 'task';
  readonly source_scope: 'repository' | 'run-main';
  readonly source_run: string;
  readonly schema_version: string;
  readonly clause_id: string;
  readonly exact_requirement: string;
  readonly artifact_or_invariant: string;
  readonly demanded_outcome: string;
}

export interface CoordinationContradictionAdjudication {
  readonly schema_version: 'autopilot.planning_contradiction_adjudication.v1';
  readonly adjudication_id: string;
  readonly adjudicator: CoordinationOwnerIdentity;
  readonly adjudicator_role: 'adjudicate';
  readonly independent_from_runs: readonly string[];
  readonly verdict: 'major-contradiction';
  readonly conflicting_clauses: readonly CoordinationContradictionClause[];
  readonly sequencing_can_satisfy_both: false;
  readonly partitioning_can_satisfy_both: false;
  readonly ownership_transfer_can_satisfy_both: false;
  readonly rebase_revalidation_can_satisfy_both: false;
  readonly replanning_can_preserve_both: false;
  readonly operational_reasons: readonly CoordinationOperationalEscalationReason[];
  readonly decision_options: readonly string[];
}

export interface CoordinationAuthoritativeArtifact {
  readonly schema_version: 'autopilot.authoritative_artifact.v1';
  readonly artifact_id: string;
  readonly repo_id: string;
  readonly source_run: string;
  readonly source_type: 'mission' | 'master-plan' | 'task';
  readonly source_scope: 'repository' | 'run-main';
  readonly document_schema_version: string;
  readonly git_commit: string;
  readonly evidence: CoordinationEvidenceRef;
  readonly registered_event_seq: number;
  readonly version: number;
}

export interface CoordinationAdjudicationAssignment {
  readonly schema_version: 'autopilot.adjudication_assignment.v1';
  readonly assignment_id: string;
  readonly repo_id: string;
  readonly requesting_run: string;
  readonly participating_runs: readonly string[];
  readonly authoritative_artifact_ids: readonly string[];
  readonly conflicting_clauses: readonly CoordinationContradictionClause[];
  readonly adjudicator: CoordinationOwnerIdentity;
  readonly decision_options: readonly string[];
  readonly state: 'assigned' | 'accepted';
  readonly adjudication: CoordinationEvidenceRef | null;
  readonly child_lease_id: string | null;
  readonly assigned_event_seq: number;
  readonly accepted_event_seq: number | null;
  readonly version: number;
}

export interface CoordinationEscalation {
  readonly schema_version: 'autopilot.planning_contradiction.v1';
  readonly escalation_id: string;
  readonly repo_id: string;
  readonly participating_runs: readonly string[];
  readonly authoritative_refs: readonly CoordinationEvidenceRef[];
  readonly conflicting_clauses: readonly CoordinationContradictionClause[];
  readonly exhausted_alternatives: readonly ('sequencing' | 'partitioning' | 'ownership-transfer' | 'rebase-revalidation' | 'replanning')[];
  readonly adjudication: CoordinationEvidenceRef;
  readonly decision_options: readonly string[];
  readonly created_event_seq: number;
  readonly version: number;
}

export interface CoordinationEvent {
  readonly schema_version: 'autopilot.coordination_event.v1';
  readonly repo_id: string;
  readonly event_seq: number;
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly idempotency_key: string;
  readonly request_sha256: `sha256:${string}`;
  readonly occurred_at: string;
}

export interface CoordinationSnapshot {
  readonly schema_version: typeof AUTOPILOT_COORDINATION_SNAPSHOT_SCHEMA;
  readonly repository_event_seq: number;
  readonly repositories: readonly CoordinationRepository[];
  readonly runs: readonly CoordinationRun[];
  readonly session_leases: readonly CoordinationSessionLease[];
  readonly child_leases: readonly CoordinationChildLease[];
  readonly unit_attempts: readonly CoordinationUnitAttempt[];
  readonly acquisition_groups: readonly CoordinationAcquisitionGroup[];
  readonly edit_leases: readonly CoordinationEditLease[];
  readonly change_reservations: readonly CoordinationChangeReservation[];
  readonly reservation_obligations: readonly CoordinationReservationObligation[];
  readonly run_terminal_intents: readonly CoordinationRunTerminalIntent[];
  readonly claim_requests: readonly CoordinationClaimRequest[];
  readonly mailbox_cursors: readonly CoordinationMailboxCursor[];
  readonly reconciliation_evidence: readonly CoordinationReconciliationEvidence[];
  readonly migration_recovery_work: readonly CoordinationMigrationRecoveryWork[];
  readonly messages: readonly CoordinationMessage[];
  readonly worktrees: readonly CoordinationWorktree[];
  readonly worktree_operations: readonly CoordinationWorktreeOperation[];
  readonly wait_for_edges: readonly CoordinationWaitForEdge[];
  readonly deadlock_resolutions: readonly CoordinationDeadlockResolution[];
  readonly authoritative_artifacts: readonly CoordinationAuthoritativeArtifact[];
  readonly adjudication_assignments: readonly CoordinationAdjudicationAssignment[];
  readonly escalations: readonly CoordinationEscalation[];
  readonly events: readonly CoordinationEvent[];
}

export type CoordinatorQueryAction = 'handshake' | 'status' | 'doctor' | 'export' | 'migration-recovery' | 'run-catalog';
export type CoordinatorMutationAction = 'attach-run' | 'attach-session' | 'attach-terminal-recovery' | 'attach-migration-recovery' | 'resolve-migration-recovery' | 'detach-session' | 'prepare-handoff' | 'heartbeat' | 'register-attempt' | 'register-child' | 'heartbeat-child' | 'checkpoint-child' | 'complete-child' | 'drain-mailbox' | 'acquire-group' | 'acknowledge-grant' | 'respond-claim-request' | 'cancel-claim-request' | 'cancel-acquisition-group' | 'supersede-attempt' | 'acknowledge-message' | 'record-release-evidence' | 'resolve-reservation-obligation' | 'prepare-run-terminal' | 'cancel-run-terminal' | 'reconcile-run' | 'prepare-operation' | 'transition-operation' | 'register-authoritative-artifact' | 'assign-adjudication' | 'claim-adjudication-assignment' | 'complete-adjudication' | 'submit-planning-contradiction';

export interface CoordinatorRequestEnvelope {
  readonly schema_version: typeof AUTOPILOT_COORDINATOR_REQUEST_SCHEMA;
  readonly protocol_version: typeof AUTOPILOT_COORDINATOR_PROTOCOL_VERSION;
  readonly request_id: string;
  readonly action: CoordinatorQueryAction | CoordinatorMutationAction;
  readonly idempotency_key: string | null;
  readonly repo_id: string;
  readonly workstream_run: string | null;
  readonly session_id: string | null;
  readonly fencing_generation: number | null;
  readonly expected_version: number | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface CoordinatorResponseEnvelope {
  readonly schema_version: typeof AUTOPILOT_COORDINATOR_RESPONSE_SCHEMA;
  readonly protocol_version: typeof AUTOPILOT_COORDINATOR_PROTOCOL_VERSION;
  readonly request_id: string;
  readonly ok: boolean;
  readonly committed_event_seq: number | null;
  readonly error_code: string | null;
  readonly retryable: boolean;
  readonly payload: Readonly<Record<string, unknown>>;
}
