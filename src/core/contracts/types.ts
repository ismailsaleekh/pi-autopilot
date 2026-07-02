export type AutopilotSchemaVersion =
  | 'autopilot.unit_spec.v1'
  | 'autopilot.status.v1'
  | 'autopilot.event.v1'
  | 'autopilot.state.v1'
  | 'autopilot.receipt.v1'
  | 'autopilot.handoff.v1'
  | 'autopilot.master_plan.v1'
  | 'autopilot.decision.v1'
  | 'autopilot.execution_audit.v1';

export const AUTOPILOT_ROLE_VALUES = [
  'strategy',
  'implement',
  'validate',
  'fix',
  'adjudicate',
  'bughunt',
  'extract',
] as const;
export type AutopilotRole = (typeof AUTOPILOT_ROLE_VALUES)[number];

export const AUTOPILOT_TEMPLATE_VALUES = AUTOPILOT_ROLE_VALUES;
export type AutopilotTemplate = AutopilotRole;

export const AUTOPILOT_THINKING_VALUES = ['high', 'xhigh'] as const;
export type AutopilotThinking = (typeof AUTOPILOT_THINKING_VALUES)[number];

export const AUTOPILOT_VERDICT_VALUES = ['DONE', 'PASS', 'NEEDS_FIX', 'BLOCKED'] as const;
export type AutopilotVerdict = (typeof AUTOPILOT_VERDICT_VALUES)[number];

export const AUTOPILOT_SEVERITY_VALUES = [
  'clean',
  'minor-local',
  'major-local',
  'critical',
] as const;
export type AutopilotSeverity = (typeof AUTOPILOT_SEVERITY_VALUES)[number];

export const AUTOPILOT_COMMAND_STATUS_VALUES = ['passed', 'failed', 'not-run', 'blocked'] as const;
export type AutopilotCommandStatus = (typeof AUTOPILOT_COMMAND_STATUS_VALUES)[number];

export const AUTOPILOT_CONTEXT_GATE_VALUES = ['ok', 'halt', 'unknown'] as const;
export type AutopilotContextGate = (typeof AUTOPILOT_CONTEXT_GATE_VALUES)[number];

export const AUTOPILOT_WORKSTREAM_STATUS_VALUES = ['running', 'paused', 'blocked', 'completed'] as const;
export type AutopilotWorkstreamStatus = (typeof AUTOPILOT_WORKSTREAM_STATUS_VALUES)[number];

export const AUTOPILOT_QUALITY_PROFILE_VALUES = [
  'source-change',
  'test-change',
  'docs-change',
  'config-change',
  'package-change',
  'validation-only',
  'strategy',
  'adjudication',
  'extract',
] as const;
export type AutopilotQualityProfile = (typeof AUTOPILOT_QUALITY_PROFILE_VALUES)[number];

export const AUTOPILOT_RISK_LEVEL_VALUES = ['low', 'medium', 'high', 'critical'] as const;
export type AutopilotRiskLevel = (typeof AUTOPILOT_RISK_LEVEL_VALUES)[number];

export const AUTOPILOT_AUDIT_CLASSIFICATION_VALUES = [
  'clean',
  'scope-review-required',
  'protected-path-review-required',
  'critical-protected-path-violation',
  'audit-unavailable',
] as const;
export type AutopilotAuditClassification = (typeof AUTOPILOT_AUDIT_CLASSIFICATION_VALUES)[number];

export const AUTOPILOT_WORK_ITEM_STATE_VALUES = [
  'planned',
  'running',
  'transport-complete',
  'audit-review',
  'validation-ready',
  'validated',
  'needs-fix',
  'fixed',
  'revalidation-ready',
  'closed',
] as const;
export type AutopilotWorkItemState = (typeof AUTOPILOT_WORK_ITEM_STATE_VALUES)[number];

export const AUTOPILOT_EXCEPTION_STATE_VALUES = [
  'open',
  'ratified',
  'split',
  'remediated',
  'operator-decision',
] as const;
export type AutopilotExceptionState = (typeof AUTOPILOT_EXCEPTION_STATE_VALUES)[number];

export const AUTOPILOT_ADJUDICATION_OUTCOME_VALUES = [
  'ratify',
  'split',
  'remediate',
  'operator-decision',
] as const;
export type AutopilotAdjudicationOutcome = (typeof AUTOPILOT_ADJUDICATION_OUTCOME_VALUES)[number];

export const AUTOPILOT_CLOSURE_GATE_STATUS_VALUES = ['not-run', 'passed', 'failed'] as const;
export type AutopilotClosureGateStatus = (typeof AUTOPILOT_CLOSURE_GATE_STATUS_VALUES)[number];

export const AUTOPILOT_DECISION_EVENT_VALUES = [
  'mission_created',
  'master_plan_created',
  'master_plan_amended',
  'scope_exception_detected',
  'scope_exception_ratified',
  'scope_exception_rejected',
  'ownership_amended',
  'protected_path_violation_detected',
  'operator_approval_recorded',
  'blocker_ruling',
  'closure_gate_passed',
  'closure_gate_failed',
] as const;
export type AutopilotDecisionEvent = (typeof AUTOPILOT_DECISION_EVENT_VALUES)[number];

export const AUTOPILOT_UNIT_STATE_VALUES = [
  'queued',
  'ready',
  'running',
  'blocked',
  'completed',
  'failed',
] as const;
export type AutopilotUnitState = (typeof AUTOPILOT_UNIT_STATE_VALUES)[number];

export const AUTOPILOT_EVENT_TYPE_VALUES = [
  'state_created',
  'state_updated',
  'unit_spec_created',
  'agent_started',
  'agent_completed',
  'agent_failed',
  'unit_blocked',
  'handoff_written',
  'resume_loaded',
] as const;
export type AutopilotEventType = (typeof AUTOPILOT_EVENT_TYPE_VALUES)[number];

export const AUTOPILOT_HANDOFF_REASON_VALUES = [
  'context-halt',
  'operator-pause',
  'terminal-transfer',
] as const;
export type AutopilotHandoffReason = (typeof AUTOPILOT_HANDOFF_REASON_VALUES)[number];

export type AutopilotSha256Digest = `sha256:${string}`;

export interface AutopilotContextRef {
  readonly path: string;
  readonly purpose: string;
  readonly sha256?: AutopilotSha256Digest;
  readonly byte_count?: number;
}

export interface AutopilotEvidenceRef {
  readonly path: string;
  readonly sha256?: AutopilotSha256Digest;
  readonly byte_count?: number;
  readonly description?: string;
}

export interface AutopilotCommandSummary {
  readonly command: string;
  readonly status: AutopilotCommandStatus;
  readonly exit_code: number | null;
  readonly summary: string;
  readonly evidence_ref?: string;
}

export interface AutopilotWitnessSpec {
  readonly id: string;
  readonly expected_signal: string;
  readonly required: boolean;
  readonly command?: string;
  readonly inspection_target?: string;
  readonly blocker_reason?: string;
}

export interface AutopilotVerificationPlan {
  readonly positive_witnesses: readonly AutopilotWitnessSpec[];
  readonly negative_witnesses: readonly AutopilotWitnessSpec[];
  readonly regression_witnesses: readonly AutopilotWitnessSpec[];
  readonly real_boundary_witnesses: readonly AutopilotWitnessSpec[];
  readonly blast_radius_checks: readonly AutopilotWitnessSpec[];
  readonly docs_schema_prompt_checks: readonly AutopilotWitnessSpec[];
  readonly dirty_tree_checks: readonly AutopilotWitnessSpec[];
}

export interface AutopilotUpstreamRef {
  readonly unit_id: string;
  readonly purpose: string;
  readonly status_ref?: string;
  readonly audit_ref?: string;
}

export interface AutopilotFinding {
  readonly id: string;
  readonly severity: Exclude<AutopilotSeverity, 'clean'>;
  readonly path?: string;
  readonly summary: string;
  readonly evidence_refs?: readonly AutopilotEvidenceRef[];
}

export interface AutopilotUnitSpec {
  readonly schema_version: 'autopilot.unit_spec.v1';
  readonly workstream: string;
  readonly unit_id: string;
  readonly role: AutopilotRole;
  readonly template: AutopilotTemplate;
  readonly attempt: number;
  readonly objective: string;
  readonly cwd: string;
  readonly model: string;
  readonly thinking: AutopilotThinking;
  readonly owned_paths: readonly string[];
  readonly read_only_paths: readonly string[];
  readonly untouchable_paths: readonly string[];
  readonly context_refs: readonly AutopilotContextRef[];
  readonly validation_commands: readonly string[];
  readonly status_output: string;
  readonly receipt_output: string;
  readonly evidence_dir: string;
  readonly stop_boundary: string;
  readonly quality_profile?: AutopilotQualityProfile;
  readonly risk_level?: AutopilotRiskLevel;
  readonly acceptance_criteria?: readonly string[];
  readonly verification_plan?: AutopilotVerificationPlan;
  readonly closure_criteria?: readonly string[];
  readonly upstream_refs?: readonly AutopilotUpstreamRef[];
  readonly timeout_seconds?: number;
  readonly render_prompt_snapshot?: boolean;
}

export interface AutopilotStatusEntry {
  readonly schema_version: 'autopilot.status.v1';
  readonly workstream: string;
  readonly unit_id: string;
  readonly role: AutopilotRole;
  readonly attempt: number;
  readonly verdict: AutopilotVerdict;
  readonly severity: AutopilotSeverity;
  readonly summary: string;
  readonly changed_paths: readonly string[];
  readonly findings: readonly AutopilotFinding[];
  readonly commands: readonly AutopilotCommandSummary[];
  readonly evidence_refs: readonly AutopilotEvidenceRef[];
  readonly report_ref: AutopilotEvidenceRef | null;
  readonly covered_witness_ids?: readonly string[];
  readonly next_action: string;
}

export interface AutopilotEventRow {
  readonly schema_version: 'autopilot.event.v1';
  readonly id: number;
  readonly ts: string;
  readonly event: AutopilotEventType;
  readonly workstream: string;
  readonly unit_id?: string;
  readonly role?: AutopilotRole;
  readonly verdict?: AutopilotVerdict;
  readonly severity?: AutopilotSeverity;
  readonly spec_ref?: string;
  readonly status_ref?: string;
  readonly receipt_ref?: string;
  readonly evidence_ref?: string;
  readonly summary: string;
}

export interface AutopilotStateUnit {
  readonly unit_id: string;
  readonly role: AutopilotRole;
  readonly state: AutopilotUnitState;
  readonly attempt: number;
  readonly spec_ref?: string;
  readonly status_ref?: string;
  readonly receipt_ref?: string;
  readonly summary: string;
}

export interface AutopilotWorkItem {
  readonly work_item_id: string;
  readonly state: AutopilotWorkItemState;
  readonly source_changing: boolean;
  readonly unit_ids: readonly string[];
  readonly implementation_unit_id?: string;
  readonly validation_unit_id?: string;
  readonly audit_ref?: string;
  readonly status_ref?: string;
  readonly validation_status_ref?: string;
  readonly summary: string;
}

export interface AutopilotScopeException {
  readonly exception_id: string;
  readonly unit_id: string;
  readonly audit_ref: string;
  readonly paths: readonly string[];
  readonly state: AutopilotExceptionState;
  readonly decision_ref?: string;
  readonly summary: string;
}

export interface AutopilotProtectedPathException {
  readonly exception_id: string;
  readonly unit_id: string;
  readonly audit_ref: string;
  readonly read_only_paths: readonly string[];
  readonly untouchable_paths: readonly string[];
  readonly state: AutopilotExceptionState;
  readonly decision_ref?: string;
  readonly summary: string;
}

export interface AutopilotClosureGateState {
  readonly status: AutopilotClosureGateStatus;
  readonly checked_at?: string;
  readonly blocking_reasons: readonly string[];
  readonly bughunt_status_ref?: string;
  readonly decision_ref?: string;
  readonly summary: string;
}

export interface AutopilotState {
  readonly schema_version: 'autopilot.state.v1';
  readonly workstream: string;
  readonly updated_at: string;
  readonly status: AutopilotWorkstreamStatus;
  readonly context_gate: {
    readonly gate: AutopilotContextGate;
    readonly percent: number | null;
  };
  readonly last_event_id: number;
  readonly ready_queue: readonly string[];
  readonly running: readonly string[];
  readonly blocked: readonly string[];
  readonly completed: readonly string[];
  readonly units: Readonly<Record<string, AutopilotStateUnit>>;
  readonly operator_questions: readonly string[];
  readonly next_actions: readonly string[];
  readonly work_items?: Readonly<Record<string, AutopilotWorkItem>>;
  readonly audit_review_queue?: readonly string[];
  readonly validation_ready_queue?: readonly string[];
  readonly scope_exceptions?: readonly AutopilotScopeException[];
  readonly protected_path_exceptions?: readonly AutopilotProtectedPathException[];
  readonly closure_gate?: AutopilotClosureGateState;
}

export interface AutopilotReceipt {
  readonly schema_version: 'autopilot.receipt.v1';
  readonly tool_name: 'autopilot_emit_status';
  readonly workstream: string;
  readonly unit_id: string;
  readonly role: AutopilotRole;
  readonly attempt: number;
  readonly emitted_at: string;
  readonly status_output: string;
  readonly status_sha256: AutopilotSha256Digest;
  readonly schema_sha256: AutopilotSha256Digest;
  readonly tool_call_id: string;
  readonly provider_identity: {
    readonly provider_id: string;
    readonly requested_model_id: string;
    readonly executed_model_id: string;
    readonly api: string;
    readonly thinking_level: string;
  };
  readonly expected_identity_hash: AutopilotSha256Digest;
}

export interface AutopilotHandoff {
  readonly schema_version: 'autopilot.handoff.v1';
  readonly workstream: string;
  readonly written_at: string;
  readonly reason: AutopilotHandoffReason;
  readonly mission_ref: string;
  readonly master_plan_ref: string;
  readonly decision_tail_ref: string | null;
  readonly latest_decision_id: number;
  readonly state_ref: string;
  readonly event_tail_ref: string | null;
  readonly status_refs: readonly string[];
  readonly audit_refs: readonly string[];
  readonly summary: string;
  readonly open_blockers: readonly string[];
  readonly next_actions: readonly string[];
}

export interface AutopilotMasterPlanUnit {
  readonly unit_id: string;
  readonly role: AutopilotRole;
  readonly state: AutopilotUnitState;
  readonly dependencies: readonly string[];
  readonly summary: string;
}

export interface AutopilotMasterPlanLane {
  readonly lane_id: string;
  readonly summary: string;
  readonly unit_ids: readonly string[];
}

export interface AutopilotOwnershipMatrix {
  readonly owned_paths: readonly string[];
  readonly read_only_paths: readonly string[];
  readonly untouchable_paths: readonly string[];
  readonly held_paths: readonly string[];
}

export interface AutopilotMasterPlan {
  readonly schema_version: 'autopilot.master_plan.v1';
  readonly workstream: string;
  readonly mission_ref: string;
  readonly goal_summary: string;
  readonly non_goals: readonly string[];
  readonly definition_of_done: readonly string[];
  readonly risk_level: AutopilotRiskLevel;
  readonly lanes: readonly AutopilotMasterPlanLane[];
  readonly units: Readonly<Record<string, AutopilotMasterPlanUnit>>;
  readonly ownership_matrix: AutopilotOwnershipMatrix;
  readonly verification_matrix: AutopilotVerificationPlan;
  readonly closure_criteria: readonly string[];
  readonly current_focus: string;
  readonly last_decision_id: number;
  readonly last_event_id: number;
  readonly updated_at: string;
}

export interface AutopilotDecisionRow {
  readonly schema_version: 'autopilot.decision.v1';
  readonly id: number;
  readonly ts: string;
  readonly event: AutopilotDecisionEvent;
  readonly workstream: string;
  readonly summary: string;
  readonly decision: string;
  readonly unit_id?: string;
  readonly master_plan_ref?: string;
  readonly evidence_refs?: readonly AutopilotEvidenceRef[];
}

export interface AutopilotExecutionAudit {
  readonly schema_version: 'autopilot.execution_audit.v1';
  readonly workstream: string;
  readonly unit_id: string;
  readonly role: AutopilotRole;
  readonly attempt: number;
  readonly audited_at: string;
  readonly cwd: string;
  readonly git_head: string | null;
  readonly dirty_baseline: boolean | null;
  readonly dirty_baseline_paths: readonly string[];
  readonly dirty_relevant_paths: readonly string[];
  readonly actual_changed_paths: readonly string[];
  readonly status_reported_changed_paths: readonly string[];
  readonly omitted_status_changes: readonly string[];
  readonly reported_but_not_actual_changes: readonly string[];
  readonly outside_owned_paths: readonly string[];
  readonly read_only_touched_paths: readonly string[];
  readonly untouchable_touched_paths: readonly string[];
  readonly declared_validation_commands: readonly string[];
  readonly status_reported_commands: readonly string[];
  readonly command_coverage_gaps: readonly string[];
  readonly classification: AutopilotAuditClassification;
  readonly evidence_refs: readonly AutopilotEvidenceRef[];
  readonly summary: string;
}
