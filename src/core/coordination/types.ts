export const AUTOPILOT_COORDINATION_SNAPSHOT_SCHEMA = 'autopilot.coordination_snapshot.v1' as const;
export const AUTOPILOT_COORDINATOR_PROTOCOL_VERSION = '1.0' as const;
export const AUTOPILOT_COORDINATOR_REQUEST_SCHEMA = 'autopilot.coordinator_request.v1' as const;
export const AUTOPILOT_COORDINATOR_RESPONSE_SCHEMA = 'autopilot.coordinator_response.v1' as const;
export const AUTOPILOT_COORDINATION_PREFLIGHT_SCHEMA = 'autopilot.coordination_preflight.v1' as const;

export const COORDINATION_CLAIM_MODES = ['READ', 'WRITE', 'EXCLUSIVE'] as const;
export const COORDINATION_RUN_STATUSES = ['active', 'paused', 'merging', 'blocked', 'recovering', 'closed', 'aborted'] as const;
export const COORDINATION_SESSION_STATUSES = ['attached', 'handoff-pending', 'detached', 'fenced', 'expired'] as const;
export const COORDINATION_CHILD_STATUSES = ['preflight', 'running', 'terminal', 'recovery-required'] as const;
export const COORDINATION_UNIT_STATES = ['queued', 'preflight', 'running', 'transport-complete', 'merged', 'failed', 'reset', 'quarantined', 'superseded'] as const;
export const COORDINATION_ACQUISITION_STATES = ['waiting', 'grant-ready', 'granted', 'released', 'cancelled', 'superseded'] as const;
export const COORDINATION_REQUEST_STATUSES = ['pending', 'delivered', 'acknowledged', 'release-now', 'deferred', 'released', 'grant-ready', 'granted', 'requester-notified', 'resolved', 'cancelled', 'superseded', 'contradiction-review'] as const;
export const COORDINATION_MESSAGE_STATUSES = ['pending', 'delivered', 'acknowledged'] as const;
export const COORDINATION_OPERATION_STAGES = ['prepared', 'in-progress', 'verified', 'committed', 'reconciling', 'compensated', 'failed'] as const;
export const COORDINATION_RELEASE_CONDITION_TYPES = ['child-terminal', 'unit-merged', 'attempt-reset', 'quarantine-captured', 'run-closed', 'explicit-owner-release'] as const;
export const COORDINATION_RECONCILIATION_SOURCES = ['child-process', 'unit-merge', 'attempt-reset', 'quarantine-capture', 'run-close', 'run-abort'] as const;

export type CoordinationClaimMode = (typeof COORDINATION_CLAIM_MODES)[number];
export type CoordinationRunStatus = (typeof COORDINATION_RUN_STATUSES)[number];
export type CoordinationSessionStatus = (typeof COORDINATION_SESSION_STATUSES)[number];
export type CoordinationChildStatus = (typeof COORDINATION_CHILD_STATUSES)[number];
export type CoordinationUnitState = (typeof COORDINATION_UNIT_STATES)[number];
export type CoordinationAcquisitionState = (typeof COORDINATION_ACQUISITION_STATES)[number];
export type CoordinationRequestStatus = (typeof COORDINATION_REQUEST_STATUSES)[number];
export type CoordinationMessageStatus = (typeof COORDINATION_MESSAGE_STATUSES)[number];
export type CoordinationOperationStage = (typeof COORDINATION_OPERATION_STAGES)[number];
export type CoordinationReleaseConditionType = (typeof COORDINATION_RELEASE_CONDITION_TYPES)[number];
export type CoordinationReconciliationSource = (typeof COORDINATION_RECONCILIATION_SOURCES)[number];

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
  readonly status: CoordinationRunStatus;
  readonly active_session_generation: number;
  readonly created_event_seq: number;
  readonly version: number;
}

export interface CoordinationSessionLease {
  readonly schema_version: 'autopilot.session_lease.v1';
  readonly session_lease_id: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly session_id: string;
  readonly session_generation: number;
  readonly pid: number;
  readonly boot_id: string;
  readonly lease_expires_at: string;
  readonly status: CoordinationSessionStatus;
  readonly attached_event_seq: number;
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
  readonly message_type: 'claim-request' | 'release-notification' | 'grant-offer' | 'recovery-required';
  readonly correlation_id: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: CoordinationMessageStatus;
  readonly created_event_seq: number;
  readonly delivered_event_seq: number | null;
  readonly acknowledged_event_seq: number | null;
  readonly version: number;
}

export interface CoordinationWorktree {
  readonly schema_version: 'autopilot.coordination_worktree.v1';
  readonly worktree_id: string;
  readonly owner: CoordinationOwnerIdentity;
  readonly canonical_path: string;
  readonly git_common_dir: string;
  readonly branch: string;
  readonly state: 'planned' | 'active' | 'dirty' | 'quarantined' | 'terminal' | 'removed';
  readonly version: number;
}

export interface CoordinationWorktreeOperation {
  readonly schema_version: 'autopilot.worktree_operation.v1';
  readonly operation_id: string;
  readonly worktree_id: string;
  readonly owner: CoordinationOwnerIdentity;
  readonly operation_type: 'create' | 'materialize' | 'commit' | 'merge' | 'reset' | 'quarantine' | 'archive' | 'remove';
  readonly stage: CoordinationOperationStage;
  readonly authority_version: number;
  readonly intent_event_seq: number;
  readonly verification_evidence: CoordinationEvidenceRef | null;
  readonly error_code: string | null;
  readonly version: number;
}

export interface CoordinationEscalation {
  readonly schema_version: 'autopilot.planning_contradiction.v1';
  readonly escalation_id: string;
  readonly repo_id: string;
  readonly participating_runs: readonly string[];
  readonly authoritative_refs: readonly CoordinationEvidenceRef[];
  readonly conflicting_clauses: readonly string[];
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
  readonly claim_requests: readonly CoordinationClaimRequest[];
  readonly mailbox_cursors: readonly CoordinationMailboxCursor[];
  readonly reconciliation_evidence: readonly CoordinationReconciliationEvidence[];
  readonly messages: readonly CoordinationMessage[];
  readonly worktrees: readonly CoordinationWorktree[];
  readonly worktree_operations: readonly CoordinationWorktreeOperation[];
  readonly escalations: readonly CoordinationEscalation[];
  readonly events: readonly CoordinationEvent[];
}

export type CoordinatorQueryAction = 'status' | 'doctor' | 'export';
export type CoordinatorMutationAction = 'attach-run' | 'attach-session' | 'detach-session' | 'prepare-handoff' | 'heartbeat' | 'register-child' | 'heartbeat-child' | 'complete-child' | 'drain-mailbox' | 'acquire-group' | 'acknowledge-grant' | 'respond-claim-request' | 'cancel-claim-request' | 'cancel-acquisition-group' | 'supersede-attempt' | 'acknowledge-message' | 'record-release-evidence' | 'reconcile-run' | 'transition-operation';

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
