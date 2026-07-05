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
