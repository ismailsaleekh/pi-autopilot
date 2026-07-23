export type AutopilotSchemaVersion =
  | 'autopilot.unit_spec.v1'
  | 'autopilot.status.v1'
  | 'autopilot.event.v1'
  | 'autopilot.state.v1'
  | 'autopilot.receipt.v1'
  | 'autopilot.handoff.v1'
  | 'autopilot.master_plan.v1'
  | 'autopilot.decision.v1'
  | 'autopilot.execution_audit.v1'
  | 'autopilot.execution_commit.v1'
  | AutopilotRosterContractSchemaVersion;

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

export const AUTOPILOT_STATUS_CHANGED_PATHS_LIMIT = 500 as const;

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

export const AUTOPILOT_HEAD_CHANGE_KIND_VALUES = [
  'none',
  'fast-forward',
  'rewrite',
  'unavailable',
] as const;
export type AutopilotHeadChangeKind = (typeof AUTOPILOT_HEAD_CHANGE_KIND_VALUES)[number];

export const AUTOPILOT_EXECUTION_COMMIT_ORIGIN_VALUES = ['runtime', 'child', 'mixed'] as const;
export type AutopilotExecutionCommitOrigin = (typeof AUTOPILOT_EXECUTION_COMMIT_ORIGIN_VALUES)[number];

export const AUTOPILOT_EXECUTION_AUDIT_PATH_SET_VALUES = [
  'dirty_baseline_paths',
  'dirty_relevant_paths',
  'actual_changed_paths',
  'status_reported_changed_paths',
  'omitted_status_changes',
  'reported_but_not_actual_changes',
  'outside_owned_paths',
  'read_only_touched_paths',
  'untouchable_touched_paths',
] as const;
export type AutopilotExecutionAuditPathSet = (typeof AUTOPILOT_EXECUTION_AUDIT_PATH_SET_VALUES)[number];
export type AutopilotExecutionAuditPathCounts = Readonly<Record<AutopilotExecutionAuditPathSet, number>>;

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
  readonly baseline_head?: string | null;
  readonly post_run_head?: string | null;
  readonly head_change_kind?: AutopilotHeadChangeKind;
  readonly committed_changed_paths?: readonly string[];
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
  readonly path_counts: AutopilotExecutionAuditPathCounts;
  readonly truncated_path_sets: readonly AutopilotExecutionAuditPathSet[];
  readonly declared_validation_commands: readonly string[];
  readonly status_reported_commands: readonly string[];
  readonly command_coverage_gaps: readonly string[];
  readonly classification: AutopilotAuditClassification;
  readonly evidence_refs: readonly AutopilotEvidenceRef[];
  readonly summary: string;
}

export interface AutopilotExecutionCommit {
  readonly schema_version: 'autopilot.execution_commit.v1';
  readonly workstream: string;
  readonly workstream_run: string;
  readonly autopilot_id: string;
  readonly active_run_epoch: number;
  readonly unit_id: string;
  readonly role: 'implement' | 'fix';
  readonly attempt: number;
  readonly cwd: string;
  readonly branch: string;
  readonly claimed_paths: readonly string[];
  readonly edited_claimed_paths: readonly string[];
  readonly before_head: string;
  readonly after_head: string;
  readonly commit_sha: string;
  readonly commit_subject: string;
  readonly commit_origin?: AutopilotExecutionCommitOrigin;
  readonly commit_shas?: readonly string[];
  readonly status_ref: string;
  readonly receipt_ref: string;
  readonly audit_ref: string;
  readonly created_at: string;
}

// Phase 37 W1 roster contracts. Generated from design/phase37/roster-contract-definitions.v1.json.
export const AUTOPILOT_ROSTER_FREEZE_ID = 'phase37-roster-w0-2026-07-22' as const;

export const AUTOPILOT_ROSTER_PROFILE_VALUES = ['precision', 'cruise', 'afterburner'] as const;
export type AutopilotRosterProfileId = (typeof AUTOPILOT_ROSTER_PROFILE_VALUES)[number];

export const AUTOPILOT_ROSTER_ROLE_ORDER = [
  'parent',
  'strategy',
  'implement',
  'validate',
  'fix',
  'adjudicate',
  'bughunt',
  'extract',
] as const;
export type AutopilotRosterRole = (typeof AUTOPILOT_ROSTER_ROLE_ORDER)[number];

export const AUTOPILOT_ROSTER_CHILD_ROLE_ORDER = [
  'strategy',
  'implement',
  'validate',
  'fix',
  'adjudicate',
  'bughunt',
  'extract',
] as const;
export type AutopilotRosterChildRole = (typeof AUTOPILOT_ROSTER_CHILD_ROLE_ORDER)[number];

export const AUTOPILOT_ROSTER_SCHEMA_VERSION_VALUES = [
  "autopilot.assignment.v1",
  "autopilot.auth_summary.v1",
  "autopilot.billing_summary.v1",
  "autopilot.capability_summary.v1",
  "autopilot.certification_manifest.v1",
  "autopilot.certification_role_result.v1",
  "autopilot.context_ref.v2",
  "autopilot.evidence_ref.v1",
  "autopilot.existing_run_resolution_request.v1",
  "autopilot.existing_run_resolution_result.v1",
  "autopilot.historical_fixed_roster_adapter_admission.v1",
  "autopilot.historical_fixed_roster_adapter_request.v1",
  "autopilot.historical_fixed_roster_adapter_result.v1",
  "autopilot.historical_fixed_roster_artifact.v1",
  "autopilot.historical_fixed_roster_role.v1",
  "autopilot.inventory_model.v1",
  "autopilot.inventory_provider.v1",
  "autopilot.observed_profile.v1",
  "autopilot.pre_run_selection.v1",
  "autopilot.pre_run_selection_publish_request.v1",
  "autopilot.pre_run_selection_publish_result.v1",
  "autopilot.profile_template.v1",
  "autopilot.provider_recipe.v1",
  "autopilot.receipt.v2",
  "autopilot.receipt_validation_request.v1",
  "autopilot.receipt_validation_result.v1",
  "autopilot.recipe_resolution_request.v1",
  "autopilot.recipe_resolution_result.v1",
  "autopilot.request_profile.v1",
  "autopilot.role_template.v1",
  "autopilot.roster.v1",
  "autopilot.roster_candidate.v1",
  "autopilot.roster_candidate_set.v1",
  "autopilot.roster_config.v1",
  "autopilot.roster_diagnostic.v1",
  "autopilot.roster_doctor_result.v1",
  "autopilot.roster_inventory.v1",
  "autopilot.roster_setup_receipt.v1",
  "autopilot.roster_tool_request.v1",
  "autopilot.roster_tool_result.v1",
  "autopilot.roster_transition.v1",
  "autopilot.route_policy.v1",
  "autopilot.route_resolution_request.v1",
  "autopilot.route_resolution_result.v1",
  "autopilot.saved_roster_ref.v1",
  "autopilot.unit_spec.v2",
] as const;
export type AutopilotRosterContractSchemaVersion = (typeof AUTOPILOT_ROSTER_SCHEMA_VERSION_VALUES)[number];

export type AutopilotRosterJsonPrimitive = string | number | boolean | null;
export type AutopilotRosterJsonValue =
  | AutopilotRosterJsonPrimitive
  | readonly AutopilotRosterJsonValue[]
  | AutopilotRosterJsonObject;
export interface AutopilotRosterJsonObject {
  readonly [key: string]: AutopilotRosterJsonValue | undefined;
}

export type AutopilotRosterSha256Digest = `sha256:${string}`;

export interface AutopilotRosterReceiptProviderIdentityV1 {
  readonly provider_id: string;
  readonly requested_model_id: string;
  readonly executed_model_id: string;
  readonly api: string;
  readonly thinking_level: string;
}

export interface AutopilotRosterWitnessSpecV1 {
  readonly id: string;
  readonly expected_signal: string;
  readonly required: boolean;
  readonly command?: string;
  readonly inspection_target?: string;
  readonly blocker_reason?: string;
}

export interface AutopilotRosterVerificationPlanV1 {
  readonly positive_witnesses: readonly AutopilotRosterWitnessSpecV1[];
  readonly negative_witnesses: readonly AutopilotRosterWitnessSpecV1[];
  readonly regression_witnesses: readonly AutopilotRosterWitnessSpecV1[];
  readonly real_boundary_witnesses: readonly AutopilotRosterWitnessSpecV1[];
  readonly blast_radius_checks: readonly AutopilotRosterWitnessSpecV1[];
  readonly docs_schema_prompt_checks: readonly AutopilotRosterWitnessSpecV1[];
  readonly dirty_tree_checks: readonly AutopilotRosterWitnessSpecV1[];
}

export interface AutopilotRosterUpstreamRefV1 {
  readonly unit_id: string;
  readonly purpose: string;
  readonly status_ref?: string;
  readonly audit_ref?: string;
}

export interface AutopilotRosterAssignmentV1 {
  readonly role: "parent" | "strategy" | "implement" | "validate" | "fix" | "adjudicate" | "bughunt" | "extract";
  readonly provider_id: string;
  readonly model_id: string;
  readonly model: string;
  readonly api: "openai-codex-responses" | "anthropic-messages" | "openai-completions";
  readonly thinking: "high" | "xhigh";
  readonly service_tier: null | "priority" | null;
  readonly cache_policy: "provider-default" | "none" | "short" | "long";
  readonly system_prompt_profile: "pi-default.v1" | "anthropic-autopilot-sanitized.v1";
  readonly context_window: number;
  readonly max_output_tokens: number;
  readonly input_modalities: readonly ("text" | "image" | "audio" | "file" | "patch")[];
  readonly output_modalities: readonly ("text" | "image" | "audio" | "file" | "patch")[];
  readonly reasoning_capability: "reasoning-supported" | "reasoning-unsupported";
  readonly tool_capability: "tool-use-supported" | "tool-use-unsupported";
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly billing_class: "plan-backed-subscription" | "plan-token" | "metered-third-party-blocked" | "forbidden-metered-gateway" | "unknown";
  readonly billing_route_class: "subscription-oauth" | "plan-api-token" | "third-party-metered-blocked" | "gateway-forbidden";
  readonly auth_class: "oauth" | "api-key-plan-token" | "api-key" | "none" | "unknown";
  readonly auth_source: "stored" | "runtime" | "environment" | "not-configured" | "unknown";
  readonly qualification_state: "unqualified-non-certifying-seed" | "qualification-required" | "synthetic-test-ready" | "w4-certified-ready" | "blocked-live-certification";
  readonly assignment_sha256: string;
}

export interface AutopilotRosterAuthSummaryV1 {
  readonly auth_classes: readonly ("oauth" | "api-key-plan-token" | "api-key" | "none" | "unknown")[];
  readonly auth_sources: readonly ("stored" | "runtime" | "environment" | "not-configured" | "unknown")[];
  readonly secret_fields_present: boolean;
}

export interface AutopilotRosterBillingSummaryV1 {
  readonly billing_class: "plan-backed-subscription" | "plan-token" | "metered-third-party-blocked" | "forbidden-metered-gateway" | "unknown";
  readonly billing_route_class: "subscription-oauth" | "plan-api-token" | "third-party-metered-blocked" | "gateway-forbidden";
  readonly route_policy_ids: readonly (string)[];
  readonly service_tiers: readonly (null | "priority" | null)[];
}

export interface AutopilotRosterCapabilitySummaryV1 {
  readonly min_context_window: number;
  readonly min_max_output_tokens: number;
  readonly input_modalities: readonly ("text" | "image" | "audio" | "file" | "patch")[];
  readonly output_modalities: readonly ("text" | "image" | "audio" | "file" | "patch")[];
  readonly reasoning_capability: "reasoning-supported" | "reasoning-unsupported";
  readonly tool_capability: "tool-use-supported" | "tool-use-unsupported";
}

export interface AutopilotRosterCertificationManifestV1 {
  readonly schema_version: "autopilot.certification_manifest.v1";
  readonly manifest_id: string;
  readonly manifest_revision: number;
  readonly subject_kind: "provider_recipe" | "custom_roster" | "route_policy";
  readonly subject_id: string;
  readonly subject_sha256: string;
  readonly package_version: string;
  readonly pi_version: string;
  readonly qualification_state: "unqualified-non-certifying-seed" | "qualification-required" | "synthetic-test-ready" | "w4-certified-ready" | "blocked-live-certification";
  readonly role_results: readonly (AutopilotRosterCertificationRoleResultV1)[];
  readonly required_evidence: readonly (AutopilotRosterEvidenceRefV1)[];
  readonly live_evidence: readonly (AutopilotRosterEvidenceRefV1)[];
  readonly issued_at: string;
  readonly expires_at: string;
  readonly manifest_sha256: string;
}

export interface AutopilotRosterCertificationRoleResultV1 {
  readonly role: "parent" | "strategy" | "implement" | "validate" | "fix" | "adjudicate" | "bughunt" | "extract";
  readonly state: "pass" | "fail" | "synthetic-pass";
  readonly evidence_refs: readonly (AutopilotRosterEvidenceRefV1)[];
}

export interface AutopilotRosterContextRefV2 {
  readonly path: string;
  readonly purpose: string;
  readonly sha256: string | null;
  readonly byte_count: number | null;
}

export interface AutopilotRosterEvidenceRefV1 {
  readonly evidence_id: string;
  readonly kind: "route-proof" | "billing-proof" | "prompt-proof" | "cache-proof" | "execution-proof" | "synthetic-fixture";
  readonly uri: string;
  readonly sha256: string | null;
  readonly byte_count: number | null;
  readonly secret_free: boolean;
}

export interface AutopilotRosterExistingRunResolutionRequestV1 {
  readonly schema_version: "autopilot.existing_run_resolution_request.v1";
  readonly action: "resolve-existing-run";
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly scope: "user" | "trusted-project";
  readonly selection_sha256: string;
  readonly runtime_mirror_sha256: string | null;
  readonly current_default_roster_id: string | null;
  readonly current_default_roster_revision: number | null;
  readonly current_default_roster_sha256: string | null;
  readonly roster_file_state: "present" | "missing" | "hash-mismatch";
  readonly request_sha256: string;
}

export interface AutopilotRosterExistingRunResolutionResultV1 {
  readonly schema_version: "autopilot.existing_run_resolution_result.v1";
  readonly action: "resolve-existing-run";
  readonly ok: boolean;
  readonly status: "inspected" | "blocked" | "failed";
  readonly selected_scope: "user" | "trusted-project" | null;
  readonly selected_roster_id: string | null;
  readonly selected_roster_revision: number | null;
  readonly selected_roster_sha256: string | null;
  readonly assignment_set_sha256: string | null;
  readonly selection_sha256: string;
  readonly diagnostics: readonly (AutopilotRosterRosterDiagnosticV1)[];
  readonly write_count: number;
  readonly lock_count: number;
  readonly files_touched: readonly (string)[];
  readonly result_sha256: string;
}

export interface AutopilotRosterHistoricalFixedRosterAdapterAdmissionV1 {
  readonly schema_version: "autopilot.historical_fixed_roster_adapter_admission.v1";
  readonly admitted: boolean;
  readonly reason: "admitted" | "historical-version-unsupported" | "pre-run-selection-present" | "fixed-roster-mismatch" | "conflicting-evidence" | "proof-required";
  readonly unit_schema_version: "autopilot.unit_spec.v1";
  readonly receipt_schema_version: "autopilot.receipt.v1";
  readonly package_version_upper_bound_exclusive: "1.3.0";
  readonly historical_unit_spec_sha256: string;
  readonly historical_receipt_sha256: string;
  readonly pre_run_selection_absent: boolean;
  readonly fixed_roster_chain_id: "openai-codex-sol-terra-luna-v1";
  readonly roles: readonly (AutopilotRosterHistoricalFixedRosterRoleV1)[];
  readonly no_conflicting_evidence: boolean;
  readonly historical_bytes_mutated: boolean;
  readonly admission_sha256: string;
}

export interface AutopilotRosterHistoricalFixedRosterAdapterRequestV1 {
  readonly schema_version: "autopilot.historical_fixed_roster_adapter_request.v1";
  readonly action: "historical-adapter";
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly scope: "user" | "trusted-project";
  readonly historical_unit_spec_bytes_utf8: string;
  readonly historical_unit_spec_sha256: string;
  readonly historical_receipt_bytes_utf8: string;
  readonly historical_receipt_sha256: string;
  readonly pre_run_selection_state: "absent" | "present-byte-equal" | "present-conflicting";
  readonly pre_run_selection_sha256: string | null;
  readonly conflicting_evidence_sha256s: readonly (string)[];
  readonly requested_at: string;
  readonly request_sha256: string;
}

export interface AutopilotRosterHistoricalFixedRosterAdapterResultV1 {
  readonly schema_version: "autopilot.historical_fixed_roster_adapter_result.v1";
  readonly action: "historical-adapter";
  readonly ok: boolean;
  readonly status: "inspected" | "blocked" | "failed";
  readonly admission: AutopilotRosterHistoricalFixedRosterAdapterAdmissionV1;
  readonly selected_scope: "user" | "trusted-project" | null;
  readonly selected_roster_id: string | null;
  readonly selected_roster_revision: number | null;
  readonly selected_roster_sha256: string | null;
  readonly assignment_set_sha256: string | null;
  readonly selection_identity_sha256: string | null;
  readonly historical_unit_spec_sha256: string;
  readonly historical_receipt_sha256: string;
  readonly historical_bytes_mutated: boolean;
  readonly diagnostics: readonly (AutopilotRosterRosterDiagnosticV1)[];
  readonly write_count: number;
  readonly lock_count: number;
  readonly files_touched: readonly (string)[];
  readonly result_sha256: string;
}

export interface AutopilotRosterHistoricalFixedRosterArtifactV1 {
  readonly schema_version: "autopilot.historical_fixed_roster_artifact.v1";
  readonly artifact_id: string;
  readonly artifact_kind: "unit-spec" | "receipt";
  readonly bytes_utf8: string;
  readonly bytes_sha256: string;
  readonly parsed_schema_version: "autopilot.unit_spec.v1" | "autopilot.receipt.v1";
  readonly package_version: string;
  readonly artifact_sha256: string;
}

export interface AutopilotRosterHistoricalFixedRosterRoleV1 {
  readonly schema_version: "autopilot.historical_fixed_roster_role.v1";
  readonly role: "parent" | "strategy" | "implement" | "validate" | "fix" | "adjudicate" | "bughunt" | "extract";
  readonly provider_id: string;
  readonly model_id: string;
  readonly model: string;
  readonly api: "openai-codex-responses" | "anthropic-messages" | "openai-completions";
  readonly thinking: "high" | "xhigh";
}

export interface AutopilotRosterInventoryModelV1 {
  readonly model_id: string;
  readonly api: "openai-codex-responses" | "anthropic-messages" | "openai-completions";
  readonly context_window: number;
  readonly max_output_tokens: number;
  readonly input_modalities: readonly ("text" | "image" | "audio" | "file" | "patch")[];
  readonly output_modalities: readonly ("text" | "image" | "audio" | "file" | "patch")[];
  readonly reasoning_capability: "reasoning-supported" | "reasoning-unsupported";
  readonly tool_capability: "tool-use-supported" | "tool-use-unsupported";
  readonly thinking_values: readonly ("high" | "xhigh")[];
  readonly service_tiers: readonly (null | "priority" | null)[];
  readonly cache_policies: readonly ("provider-default" | "none" | "short" | "long")[];
  readonly system_prompt_profiles: readonly ("pi-default.v1" | "anthropic-autopilot-sanitized.v1")[];
}

export interface AutopilotRosterInventoryProviderV1 {
  readonly provider_id: string;
  readonly auth_configured: boolean;
  readonly auth_class: "oauth" | "api-key-plan-token" | "api-key" | null | null;
  readonly auth_source: "stored" | "runtime" | "environment" | "not-configured" | null | null;
  readonly auth_status: "configured" | "missing" | "forbidden" | "unknown";
  readonly is_using_oauth: boolean;
  readonly billing_route_class: "subscription-oauth" | "plan-api-token" | "third-party-metered-blocked" | "gateway-forbidden" | "unknown";
  readonly models: readonly (AutopilotRosterInventoryModelV1)[];
}

export interface AutopilotRosterObservedProfileV1 {
  readonly provider_id: string;
  readonly requested_model_id: string;
  readonly executed_model_id: string;
  readonly api: "openai-codex-responses" | "anthropic-messages" | "openai-completions";
  readonly thinking: "high" | "xhigh";
  readonly service_tier: null | "priority" | null;
  readonly cache_policy: "provider-default" | "none" | "short" | "long";
  readonly system_prompt_profile: "pi-default.v1" | "anthropic-autopilot-sanitized.v1";
  readonly system_prompt_sha256: string;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly request_profile_sha256: string;
  readonly observed_profile_sha256: string;
}

export interface AutopilotRosterPreRunSelectionV1 {
  readonly schema_version: "autopilot.pre_run_selection.v1";
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly scope: "user" | "trusted-project";
  readonly roster_id: string;
  readonly roster_revision: number;
  readonly roster_sha256: string;
  readonly assignment_set_sha256: string;
  readonly config_sha256: string;
  readonly selected_at: string;
  readonly selection_sha256: string;
}

export interface AutopilotRosterPreRunSelectionPublishRequestV1 {
  readonly schema_version: "autopilot.pre_run_selection_publish_request.v1";
  readonly action: "publish-pre-run-selection";
  readonly selection: AutopilotRosterPreRunSelectionV1;
  readonly selection_path: string;
  readonly existing_selection_sha256: string | null;
  readonly request_sha256: string;
}

export interface AutopilotRosterPreRunSelectionPublishResultV1 {
  readonly schema_version: "autopilot.pre_run_selection_publish_result.v1";
  readonly action: "publish-pre-run-selection";
  readonly ok: boolean;
  readonly status: "published" | "inspected" | "blocked" | "failed";
  readonly selection_sha256: string;
  readonly idempotent_replay: boolean;
  readonly diagnostics: readonly (AutopilotRosterRosterDiagnosticV1)[];
  readonly write_count: number;
  readonly lock_count: number;
  readonly files_touched: readonly (string)[];
  readonly result_sha256: string;
}

export interface AutopilotRosterProfileTemplateV1 {
  readonly profile_id: string;
  readonly selected_by_default: boolean;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly role_templates: readonly (AutopilotRosterRoleTemplateV1)[];
}

export interface AutopilotRosterProviderRecipeV1 {
  readonly schema_version: "autopilot.provider_recipe.v1";
  readonly recipe_id: string;
  readonly recipe_revision: number;
  readonly provider_family: string;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly profile_templates: readonly (AutopilotRosterProfileTemplateV1)[];
  readonly minimum_pi_version: string;
  readonly certification_manifest_id: string | null;
  readonly certification_manifest_sha256: string | null;
  readonly qualification_state: "unqualified-non-certifying-seed" | "qualification-required" | "synthetic-test-ready" | "w4-certified-ready" | "blocked-live-certification";
  readonly recipe_state: "unqualified-seed" | "blocked-live-certification" | "synthetic-fixture-ready" | "w4-certified-ready";
  readonly non_certifying_seed: boolean;
  readonly recipe_sha256: string;
}

export interface AutopilotRosterReceiptV2 {
  readonly schema_version: "autopilot.receipt.v2";
  readonly tool_name: "autopilot_emit_status";
  readonly workstream: string;
  readonly unit_id: string;
  readonly role: "strategy" | "implement" | "validate" | "fix" | "adjudicate" | "bughunt" | "extract";
  readonly attempt: number;
  readonly emitted_at: string;
  readonly status_output: string;
  readonly status_sha256: string;
  readonly schema_sha256: string;
  readonly tool_call_id: string;
  readonly provider_identity: AutopilotRosterReceiptProviderIdentityV1;
  readonly expected_identity_hash: string;
  readonly roster_id: string;
  readonly roster_revision: number;
  readonly roster_sha256: string;
  readonly assignment_sha256: string;
  readonly pre_run_selection_sha256: string;
  readonly request_profile: AutopilotRosterRequestProfileV1;
  readonly observed_profile: AutopilotRosterObservedProfileV1;
}

export interface AutopilotRosterReceiptValidationRequestV1 {
  readonly schema_version: "autopilot.receipt_validation_request.v1";
  readonly action: "validate-receipt";
  readonly requested_profile_sha256: string | null;
  readonly observed_request_profile_sha256: string | null;
  readonly requested_model_id: string | null;
  readonly executed_model_id: string | null;
  readonly requested_thinking: "high" | "xhigh" | null;
  readonly observed_thinking: "high" | "xhigh" | null;
  readonly request_sha256: string;
}

export interface AutopilotRosterReceiptValidationResultV1 {
  readonly schema_version: "autopilot.receipt_validation_result.v1";
  readonly action: "validate-receipt";
  readonly ok: boolean;
  readonly status: "inspected" | "blocked" | "failed";
  readonly diagnostics: readonly (AutopilotRosterRosterDiagnosticV1)[];
  readonly write_count: number;
  readonly lock_count: number;
  readonly files_touched: readonly (string)[];
  readonly result_sha256: string;
}

export interface AutopilotRosterRecipeResolutionRequestV1 {
  readonly schema_version: "autopilot.recipe_resolution_request.v1";
  readonly profile_id: string;
  readonly recipe_id: string;
  readonly recipe_revision: number;
  readonly inventory_sha256: string;
}

export interface AutopilotRosterRecipeResolutionResultV1 {
  readonly schema_version: "autopilot.recipe_resolution_result.v1";
  readonly resolved: boolean;
  readonly candidate: AutopilotRosterRosterCandidateV1 | null;
  readonly diagnostics: readonly (AutopilotRosterRosterDiagnosticV1)[];
  readonly result_sha256: string;
}

export interface AutopilotRosterRequestProfileV1 {
  readonly provider_id: string;
  readonly model_id: string;
  readonly model: string;
  readonly api: "openai-codex-responses" | "anthropic-messages" | "openai-completions";
  readonly thinking: "high" | "xhigh";
  readonly service_tier: null | "priority" | null;
  readonly cache_policy: "provider-default" | "none" | "short" | "long";
  readonly system_prompt_profile: "pi-default.v1" | "anthropic-autopilot-sanitized.v1";
  readonly context_window: number;
  readonly max_output_tokens: number;
  readonly input_modalities: readonly ("text" | "image" | "audio" | "file" | "patch")[];
  readonly output_modalities: readonly ("text" | "image" | "audio" | "file" | "patch")[];
  readonly reasoning_capability: "reasoning-supported" | "reasoning-unsupported";
  readonly tool_capability: "tool-use-supported" | "tool-use-unsupported";
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly request_profile_sha256: string;
}

export interface AutopilotRosterRoleTemplateV1 {
  readonly role: "parent" | "strategy" | "implement" | "validate" | "fix" | "adjudicate" | "bughunt" | "extract";
  readonly model_id: string;
  readonly api: "openai-codex-responses" | "anthropic-messages" | "openai-completions";
  readonly thinking: "high" | "xhigh";
  readonly service_tier: null | "priority" | null;
  readonly cache_policy: "provider-default" | "none" | "short" | "long";
  readonly system_prompt_profile: "pi-default.v1" | "anthropic-autopilot-sanitized.v1";
  readonly context_window: number;
  readonly max_output_tokens: number;
  readonly input_modalities: readonly ("text" | "image" | "audio" | "file" | "patch")[];
  readonly output_modalities: readonly ("text" | "image" | "audio" | "file" | "patch")[];
  readonly reasoning_capability: "reasoning-supported" | "reasoning-unsupported";
  readonly tool_capability: "tool-use-supported" | "tool-use-unsupported";
}

export interface AutopilotRosterRosterV1 {
  readonly schema_version: "autopilot.roster.v1";
  readonly roster_id: string;
  readonly roster_revision: number;
  readonly display_name: string;
  readonly scope: "user" | "trusted-project";
  readonly selected_scope: "user" | "trusted-project";
  readonly profile_id: string;
  readonly recipe_id: string;
  readonly recipe_revision: number;
  readonly generation_source: "w0-non-certifying-seed" | "user-custom" | "w4-certified-recipe" | "historical-adapter";
  readonly package_version: string;
  readonly pi_version: string;
  readonly route_policy_ids: readonly (string)[];
  readonly assignment_set_sha256: string;
  readonly assignments: readonly (AutopilotRosterAssignmentV1)[];
  readonly capability_summary: AutopilotRosterCapabilitySummaryV1;
  readonly billing_summary: AutopilotRosterBillingSummaryV1;
  readonly auth_summary: AutopilotRosterAuthSummaryV1;
  readonly certification_manifest_id: string | null;
  readonly certification_manifest_sha256: string | null;
  readonly created_at: string;
  readonly roster_sha256: string;
}

export interface AutopilotRosterRosterCandidateV1 {
  readonly schema_version: "autopilot.roster_candidate.v1";
  readonly candidate_id: string;
  readonly candidate_sort_key: string;
  readonly scope: "user" | "trusted-project";
  readonly profile_id: string;
  readonly recipe_id: string;
  readonly recipe_revision: number;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly roster_id: string;
  readonly roster_revision: number;
  readonly assignment_set_sha256: string;
  readonly roster_sha256: string;
  readonly candidate_state: "qualification-required" | "blocked-live-certification" | "synthetic-fixture-ready";
  readonly launch_readiness: "not-ready-until-w4" | "blocked" | "synthetic-fixture-only";
  readonly qualification_state: "unqualified-non-certifying-seed" | "qualification-required" | "synthetic-test-ready" | "w4-certified-ready" | "blocked-live-certification";
  readonly non_certifying_seed: boolean;
  readonly synthetic_fixture_ready_only: boolean;
  readonly converges_with: string | null;
  readonly diagnostic_codes: readonly (string)[];
  readonly candidate_sha256: string;
}

export interface AutopilotRosterRosterCandidateSetV1 {
  readonly schema_version: "autopilot.roster_candidate_set.v1";
  readonly candidate_set_id: string;
  readonly scope: "user" | "trusted-project";
  readonly inventory_sha256: string;
  readonly recipe_registry_sha256: string;
  readonly candidates: readonly (AutopilotRosterRosterCandidateV1)[];
  readonly recommended_profile_id: string;
  readonly created_at: string;
  readonly candidate_set_sha256: string;
}

export interface AutopilotRosterRosterConfigV1 {
  readonly schema_version: "autopilot.roster_config.v1";
  readonly scope: "user" | "trusted-project";
  readonly default_roster_id: string;
  readonly default_roster_revision: number;
  readonly default_roster_sha256: string;
  readonly rosters: readonly (AutopilotRosterSavedRosterRefV1)[];
  readonly previous_config_sha256: string | null;
  readonly updated_at: string;
  readonly config_sha256: string;
}

export interface AutopilotRosterRosterDiagnosticV1 {
  readonly code: string;
  readonly severity: "info" | "warning" | "error" | "fatal";
  readonly message: string;
  readonly remediation: string;
  readonly secret_free: boolean;
}

export interface AutopilotRosterRosterDoctorResultV1 {
  readonly schema_version: "autopilot.roster_doctor_result.v1";
  readonly status: "pass" | "warn" | "blocked" | "failed";
  readonly inventory_sha256: string;
  readonly route_results: readonly (AutopilotRosterRouteResolutionResultV1)[];
  readonly recipe_results: readonly (AutopilotRosterRecipeResolutionResultV1)[];
  readonly diagnostics: readonly (AutopilotRosterRosterDiagnosticV1)[];
  readonly result_sha256: string;
}

export interface AutopilotRosterRosterInventoryV1 {
  readonly schema_version: "autopilot.roster_inventory.v1";
  readonly inventory_id: string;
  readonly created_at: string;
  readonly source: "ctx.modelRegistry" | "synthetic-fixture";
  readonly project_trusted: boolean;
  readonly providers: readonly (AutopilotRosterInventoryProviderV1)[];
  readonly inventory_sha256: string;
}

export interface AutopilotRosterRosterSetupReceiptV1 {
  readonly schema_version: "autopilot.roster_setup_receipt.v1";
  readonly receipt_id: string;
  readonly scope: "user" | "trusted-project";
  readonly saved_rosters: readonly (AutopilotRosterSavedRosterRefV1)[];
  readonly default_roster_id: string;
  readonly default_roster_revision: number;
  readonly default_roster_sha256: string;
  readonly approved_candidate_set_sha256: string;
  readonly approved_roster_sha256s: readonly (string)[];
  readonly config_sha256: string;
  readonly original_command: string;
  readonly fresh_session_required: boolean;
  readonly zero_secrets: boolean;
  readonly issued_at: string;
  readonly receipt_sha256: string;
}

export interface AutopilotRosterRosterToolRequestV1 {
  readonly schema_version: "autopilot.roster_tool_request.v1";
  readonly action: "inspect" | "propose" | "save" | "reject" | "doctor";
  readonly scope: "user" | "trusted-project";
  readonly state_root_override: string | null;
  readonly trusted_project_root: string | null;
  readonly candidate_set_sha256: string | null;
  readonly approved_roster_sha256s: readonly (string)[];
  readonly default_roster_id: string | null;
  readonly default_roster_revision: number | null;
  readonly default_roster_sha256: string | null;
  readonly original_command: string;
}

export interface AutopilotRosterRosterToolResultV1 {
  readonly schema_version: "autopilot.roster_tool_result.v1";
  readonly action: "inspect" | "propose" | "save" | "reject" | "doctor";
  readonly ok: boolean;
  readonly status: "inspected" | "proposed" | "saved" | "rejected" | "blocked" | "failed";
  readonly candidate_set: AutopilotRosterRosterCandidateSetV1 | null;
  readonly receipt: AutopilotRosterRosterSetupReceiptV1 | null;
  readonly diagnostics: readonly (AutopilotRosterRosterDiagnosticV1)[];
  readonly write_count: number;
  readonly lock_count: number;
  readonly files_touched: readonly (string)[];
  readonly result_sha256: string;
}

export interface AutopilotRosterRosterTransitionV1 {
  readonly schema_version: "autopilot.roster_transition.v1";
  readonly transition_id: string;
  readonly from_roster: AutopilotRosterSavedRosterRefV1;
  readonly to_roster: AutopilotRosterSavedRosterRefV1;
  readonly reason: string;
  readonly requires_explicit_user_approval: boolean;
  readonly approved_at: string;
  readonly transition_sha256: string;
}

export interface AutopilotRosterRoutePolicyV1 {
  readonly schema_version: "autopilot.route_policy.v1";
  readonly route_policy_id: string;
  readonly revision: number;
  readonly provider_id: string;
  readonly allowed_auth_classes: readonly ("oauth" | "api-key-plan-token" | "api-key" | "none" | "unknown")[];
  readonly allowed_auth_sources: readonly ("stored" | "runtime" | "environment" | "not-configured" | "unknown")[];
  readonly billing_class: "plan-backed-subscription" | "plan-token" | "metered-third-party-blocked" | "forbidden-metered-gateway" | "unknown";
  readonly billing_route_class: "subscription-oauth" | "plan-api-token" | "third-party-metered-blocked" | "gateway-forbidden";
  readonly allowed_apis: readonly ("openai-codex-responses" | "anthropic-messages" | "openai-completions")[];
  readonly allowed_service_tiers: readonly (null | "priority" | null)[];
  readonly allowed_cache_policies: readonly ("provider-default" | "none" | "short" | "long")[];
  readonly allowed_system_prompt_profiles: readonly ("pi-default.v1" | "anthropic-autopilot-sanitized.v1")[];
  readonly forbidden_gateways: readonly ("openrouter" | "metered-frontier" | "arbitrary-api-key")[];
  readonly requires_live_billing_proof: boolean;
  readonly policy_state: "unqualified-seed" | "blocked-live-certification";
  readonly qualification_state: "unqualified-non-certifying-seed" | "qualification-required" | "synthetic-test-ready" | "w4-certified-ready" | "blocked-live-certification";
  readonly non_certifying_seed: boolean;
  readonly route_policy_sha256: string;
}

export interface AutopilotRosterRouteResolutionRequestV1 {
  readonly schema_version: "autopilot.route_resolution_request.v1";
  readonly provider_id: string;
  readonly api: "openai-codex-responses" | "anthropic-messages" | "openai-completions";
  readonly auth_class: "oauth" | "api-key-plan-token" | "api-key" | "none" | "unknown";
  readonly auth_source: "stored" | "runtime" | "environment" | "not-configured" | "unknown";
  readonly project_trusted: boolean;
}

export interface AutopilotRosterRouteResolutionResultV1 {
  readonly schema_version: "autopilot.route_resolution_result.v1";
  readonly matched: boolean;
  readonly route_policy_id: string | null;
  readonly route_policy_revision: number | null;
  readonly diagnostics: readonly (AutopilotRosterRosterDiagnosticV1)[];
  readonly result_sha256: string;
}

export interface AutopilotRosterSavedRosterRefV1 {
  readonly roster_id: string;
  readonly roster_revision: number;
  readonly roster_sha256: string;
  readonly assignment_set_sha256: string;
  readonly path: string;
}

export interface AutopilotRosterUnitSpecV2 {
  readonly schema_version: "autopilot.unit_spec.v2";
  readonly workstream: string;
  readonly unit_id: string;
  readonly role: "strategy" | "implement" | "validate" | "fix" | "adjudicate" | "bughunt" | "extract";
  readonly template: "strategy" | "implement" | "validate" | "fix" | "adjudicate" | "bughunt" | "extract";
  readonly attempt: number;
  readonly objective: string;
  readonly cwd: string;
  readonly model: string;
  readonly thinking: "high" | "xhigh";
  readonly owned_paths: readonly (string)[];
  readonly read_only_paths: readonly (string)[];
  readonly untouchable_paths: readonly (string)[];
  readonly context_refs: readonly (AutopilotRosterContextRefV2)[];
  readonly validation_commands: readonly (string)[];
  readonly status_output: string;
  readonly receipt_output: string;
  readonly evidence_dir: string;
  readonly stop_boundary: string;
  readonly quality_profile: string | null;
  readonly risk_level: "low" | "medium" | "high" | "critical" | null | null;
  readonly acceptance_criteria: readonly (string)[];
  readonly verification_plan: AutopilotRosterVerificationPlanV1 | null;
  readonly closure_criteria: readonly (string)[];
  readonly upstream_refs: readonly (AutopilotRosterUpstreamRefV1)[];
  readonly timeout_seconds: number | null;
  readonly render_prompt_snapshot: boolean | null;
  readonly roster_id: string;
  readonly roster_revision: number;
  readonly roster_sha256: string;
  readonly assignment_sha256: string;
  readonly pre_run_selection_sha256: string;
  readonly request_profile: AutopilotRosterRequestProfileV1;
}

export interface AutopilotRosterContractBySchemaVersion {
  readonly "autopilot.assignment.v1": AutopilotRosterAssignmentV1;
  readonly "autopilot.auth_summary.v1": AutopilotRosterAuthSummaryV1;
  readonly "autopilot.billing_summary.v1": AutopilotRosterBillingSummaryV1;
  readonly "autopilot.capability_summary.v1": AutopilotRosterCapabilitySummaryV1;
  readonly "autopilot.certification_manifest.v1": AutopilotRosterCertificationManifestV1;
  readonly "autopilot.certification_role_result.v1": AutopilotRosterCertificationRoleResultV1;
  readonly "autopilot.context_ref.v2": AutopilotRosterContextRefV2;
  readonly "autopilot.evidence_ref.v1": AutopilotRosterEvidenceRefV1;
  readonly "autopilot.existing_run_resolution_request.v1": AutopilotRosterExistingRunResolutionRequestV1;
  readonly "autopilot.existing_run_resolution_result.v1": AutopilotRosterExistingRunResolutionResultV1;
  readonly "autopilot.historical_fixed_roster_adapter_admission.v1": AutopilotRosterHistoricalFixedRosterAdapterAdmissionV1;
  readonly "autopilot.historical_fixed_roster_adapter_request.v1": AutopilotRosterHistoricalFixedRosterAdapterRequestV1;
  readonly "autopilot.historical_fixed_roster_adapter_result.v1": AutopilotRosterHistoricalFixedRosterAdapterResultV1;
  readonly "autopilot.historical_fixed_roster_artifact.v1": AutopilotRosterHistoricalFixedRosterArtifactV1;
  readonly "autopilot.historical_fixed_roster_role.v1": AutopilotRosterHistoricalFixedRosterRoleV1;
  readonly "autopilot.inventory_model.v1": AutopilotRosterInventoryModelV1;
  readonly "autopilot.inventory_provider.v1": AutopilotRosterInventoryProviderV1;
  readonly "autopilot.observed_profile.v1": AutopilotRosterObservedProfileV1;
  readonly "autopilot.pre_run_selection.v1": AutopilotRosterPreRunSelectionV1;
  readonly "autopilot.pre_run_selection_publish_request.v1": AutopilotRosterPreRunSelectionPublishRequestV1;
  readonly "autopilot.pre_run_selection_publish_result.v1": AutopilotRosterPreRunSelectionPublishResultV1;
  readonly "autopilot.profile_template.v1": AutopilotRosterProfileTemplateV1;
  readonly "autopilot.provider_recipe.v1": AutopilotRosterProviderRecipeV1;
  readonly "autopilot.receipt.v2": AutopilotRosterReceiptV2;
  readonly "autopilot.receipt_validation_request.v1": AutopilotRosterReceiptValidationRequestV1;
  readonly "autopilot.receipt_validation_result.v1": AutopilotRosterReceiptValidationResultV1;
  readonly "autopilot.recipe_resolution_request.v1": AutopilotRosterRecipeResolutionRequestV1;
  readonly "autopilot.recipe_resolution_result.v1": AutopilotRosterRecipeResolutionResultV1;
  readonly "autopilot.request_profile.v1": AutopilotRosterRequestProfileV1;
  readonly "autopilot.role_template.v1": AutopilotRosterRoleTemplateV1;
  readonly "autopilot.roster.v1": AutopilotRosterRosterV1;
  readonly "autopilot.roster_candidate.v1": AutopilotRosterRosterCandidateV1;
  readonly "autopilot.roster_candidate_set.v1": AutopilotRosterRosterCandidateSetV1;
  readonly "autopilot.roster_config.v1": AutopilotRosterRosterConfigV1;
  readonly "autopilot.roster_diagnostic.v1": AutopilotRosterRosterDiagnosticV1;
  readonly "autopilot.roster_doctor_result.v1": AutopilotRosterRosterDoctorResultV1;
  readonly "autopilot.roster_inventory.v1": AutopilotRosterRosterInventoryV1;
  readonly "autopilot.roster_setup_receipt.v1": AutopilotRosterRosterSetupReceiptV1;
  readonly "autopilot.roster_tool_request.v1": AutopilotRosterRosterToolRequestV1;
  readonly "autopilot.roster_tool_result.v1": AutopilotRosterRosterToolResultV1;
  readonly "autopilot.roster_transition.v1": AutopilotRosterRosterTransitionV1;
  readonly "autopilot.route_policy.v1": AutopilotRosterRoutePolicyV1;
  readonly "autopilot.route_resolution_request.v1": AutopilotRosterRouteResolutionRequestV1;
  readonly "autopilot.route_resolution_result.v1": AutopilotRosterRouteResolutionResultV1;
  readonly "autopilot.saved_roster_ref.v1": AutopilotRosterSavedRosterRefV1;
  readonly "autopilot.unit_spec.v2": AutopilotRosterUnitSpecV2;
}

export type AutopilotRosterContract = AutopilotRosterContractBySchemaVersion[AutopilotRosterContractSchemaVersion];


export type AutopilotRosterAssignment = AutopilotRosterAssignmentV1;
export type AutopilotRosterRoutePolicy = AutopilotRosterRoutePolicyV1;
export type AutopilotRosterProviderRecipe = AutopilotRosterProviderRecipeV1;
export type AutopilotRoster = AutopilotRosterRosterV1;
export type AutopilotRosterCandidate = AutopilotRosterRosterCandidateV1;
export type AutopilotRosterCandidateSet = AutopilotRosterRosterCandidateSetV1;
export type AutopilotRosterConfig = AutopilotRosterRosterConfigV1;
export type AutopilotRosterDiagnostic = AutopilotRosterRosterDiagnosticV1;
export type AutopilotRosterSetupReceipt = AutopilotRosterRosterSetupReceiptV1;
export type AutopilotPreRunSelection = AutopilotRosterPreRunSelectionV1;
export type AutopilotUnitSpecV2 = AutopilotRosterUnitSpecV2;
export type AutopilotReceiptV2 = AutopilotRosterReceiptV2;
export type AutopilotHistoricalFixedRosterAdapterRequest = AutopilotRosterHistoricalFixedRosterAdapterRequestV1;
export type AutopilotHistoricalFixedRosterAdapterAdmission = AutopilotRosterHistoricalFixedRosterAdapterAdmissionV1;
export type AutopilotHistoricalFixedRosterAdapterResult = AutopilotRosterHistoricalFixedRosterAdapterResultV1;
