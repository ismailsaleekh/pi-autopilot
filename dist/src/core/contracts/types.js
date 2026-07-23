export const AUTOPILOT_ROLE_VALUES = [
    'strategy',
    'implement',
    'validate',
    'fix',
    'adjudicate',
    'bughunt',
    'extract',
];
export const AUTOPILOT_TEMPLATE_VALUES = AUTOPILOT_ROLE_VALUES;
export const AUTOPILOT_STATUS_CHANGED_PATHS_LIMIT = 500;
export const AUTOPILOT_THINKING_VALUES = ['high', 'xhigh'];
export const AUTOPILOT_VERDICT_VALUES = ['DONE', 'PASS', 'NEEDS_FIX', 'BLOCKED'];
export const AUTOPILOT_SEVERITY_VALUES = [
    'clean',
    'minor-local',
    'major-local',
    'critical',
];
export const AUTOPILOT_COMMAND_STATUS_VALUES = ['passed', 'failed', 'not-run', 'blocked'];
export const AUTOPILOT_CONTEXT_GATE_VALUES = ['ok', 'halt', 'unknown'];
export const AUTOPILOT_WORKSTREAM_STATUS_VALUES = ['running', 'paused', 'blocked', 'completed'];
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
];
export const AUTOPILOT_RISK_LEVEL_VALUES = ['low', 'medium', 'high', 'critical'];
export const AUTOPILOT_AUDIT_CLASSIFICATION_VALUES = [
    'clean',
    'scope-review-required',
    'protected-path-review-required',
    'critical-protected-path-violation',
    'audit-unavailable',
];
export const AUTOPILOT_HEAD_CHANGE_KIND_VALUES = [
    'none',
    'fast-forward',
    'rewrite',
    'unavailable',
];
export const AUTOPILOT_EXECUTION_COMMIT_ORIGIN_VALUES = ['runtime', 'child', 'mixed'];
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
];
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
];
export const AUTOPILOT_EXCEPTION_STATE_VALUES = [
    'open',
    'ratified',
    'split',
    'remediated',
    'operator-decision',
];
export const AUTOPILOT_ADJUDICATION_OUTCOME_VALUES = [
    'ratify',
    'split',
    'remediate',
    'operator-decision',
];
export const AUTOPILOT_CLOSURE_GATE_STATUS_VALUES = ['not-run', 'passed', 'failed'];
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
];
export const AUTOPILOT_UNIT_STATE_VALUES = [
    'queued',
    'ready',
    'running',
    'blocked',
    'completed',
    'failed',
];
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
];
export const AUTOPILOT_HANDOFF_REASON_VALUES = [
    'context-halt',
    'operator-pause',
    'terminal-transfer',
];
// Phase 37 W1 roster contracts. Generated from design/phase37/roster-contract-definitions.v1.json.
export const AUTOPILOT_ROSTER_FREEZE_ID = 'phase37-roster-w0-2026-07-22';
export const AUTOPILOT_ROSTER_PROFILE_VALUES = ['precision', 'cruise', 'afterburner'];
export const AUTOPILOT_ROSTER_ROLE_ORDER = [
    'parent',
    'strategy',
    'implement',
    'validate',
    'fix',
    'adjudicate',
    'bughunt',
    'extract',
];
export const AUTOPILOT_ROSTER_CHILD_ROLE_ORDER = [
    'strategy',
    'implement',
    'validate',
    'fix',
    'adjudicate',
    'bughunt',
    'extract',
];
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
];
