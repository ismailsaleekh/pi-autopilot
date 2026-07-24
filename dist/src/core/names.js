export const AUTOPILOT_PACKAGE_NAME = 'pi-autopilot';
export const AUTOPILOT_EXTENSION_NAME = 'Autopilot';
export const AUTOPILOT_COMMAND = 'autopilot';
export const AUTOPILOT_INJECT_COMMAND = 'autopilot-inject';
export const AUTOPILOT_ONBOARD_COMMAND = 'autopilot-onboard';
export const AUTOPILOT_HANDOFF_COMMAND = 'autopilot-handoff';
export const AUTOPILOT_CLOSE_COMMAND = 'autopilot-close';
export const AUTOPILOT_ABORT_COMMAND = 'autopilot-abort';
export const AUTOPILOT_CONFIG_COMMAND = 'autopilot-config';
export const AUTOPILOT_CLAIM_GC_COMMAND = 'autopilot-claim-gc';
export const AUTOPILOT_COORDINATION_COMMAND = 'autopilot-coordination';
export const AUTOPILOT_RUNNER_BIN = 'autopilot-agent-run';
export const AUTOPILOT_COORDINATOR_BIN = 'autopilot-coordinator';
export const AUTOPILOT_LAUNCH_SIGNER_BIN = 'autopilot-launch-signer';
export const AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV = 'AUTOPILOT_COORDINATOR_SESSION_CONTEXT';
export const AUTOPILOT_PREFLIGHT_ROLLBACK_REASON_PREFIX = 'autopilot-agent-run preflight rollback after failure:';
export const AUTOPILOT_COORDINATION_AUTHORITY_ENV = 'AUTOPILOT_COORDINATION_AUTHORITY';
export const AUTOPILOT_STATUS_TOOL = 'autopilot_emit_status';
export const AUTOPILOT_STATUS_CONTEXT_ENV = 'AUTOPILOT_AGENT_STATUS_CONTEXT';
export const CONTEXT_BUDGET_TOOL_NAME = 'context_budget';
export const AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME = 'autopilot_respond_claim_request';
export const AUTOPILOT_RUNTIME_ROOT_PREFIX = '.pi/autopilot';
export const AUTOPILOT_SCHEMA_NAMES = [
    'autopilot.unit_spec.v1',
    'autopilot.status.v1',
    'autopilot.event.v1',
    'autopilot.state.v1',
    'autopilot.receipt.v1',
    'autopilot.handoff.v1',
    'autopilot.master_plan.v1',
    'autopilot.decision.v1',
    'autopilot.execution_audit.v1',
    'autopilot.execution_commit.v1',
    'autopilot.assignment.v1',
    'autopilot.auth_summary.v1',
    'autopilot.billing_summary.v1',
    'autopilot.capability_summary.v1',
    'autopilot.certification_manifest.v1',
    'autopilot.certification_role_result.v1',
    'autopilot.context_ref.v2',
    'autopilot.evidence_ref.v1',
    'autopilot.existing_run_resolution_request.v1',
    'autopilot.existing_run_resolution_result.v1',
    'autopilot.historical_fixed_roster_adapter_admission.v1',
    'autopilot.historical_fixed_roster_adapter_request.v1',
    'autopilot.historical_fixed_roster_adapter_result.v1',
    'autopilot.historical_fixed_roster_artifact.v1',
    'autopilot.historical_fixed_roster_role.v1',
    'autopilot.inventory_model.v1',
    'autopilot.inventory_provider.v1',
    'autopilot.observed_profile.v1',
    'autopilot.pre_run_selection.v1',
    'autopilot.pre_run_selection_publish_request.v1',
    'autopilot.pre_run_selection_publish_result.v1',
    'autopilot.profile_template.v1',
    'autopilot.provider_recipe.v1',
    'autopilot.receipt.v2',
    'autopilot.receipt_validation_request.v1',
    'autopilot.receipt_validation_result.v1',
    'autopilot.recipe_resolution_request.v1',
    'autopilot.recipe_resolution_result.v1',
    'autopilot.request_profile.v1',
    'autopilot.role_template.v1',
    'autopilot.roster.v1',
    'autopilot.roster_candidate.v1',
    'autopilot.roster_candidate_set.v1',
    'autopilot.roster_config.v1',
    'autopilot.roster_diagnostic.v1',
    'autopilot.roster_doctor_result.v1',
    'autopilot.roster_inventory.v1',
    'autopilot.roster_setup_receipt.v1',
    'autopilot.roster_tool_request.v1',
    'autopilot.roster_tool_result.v1',
    'autopilot.roster_transition.v1',
    'autopilot.route_policy.v1',
    'autopilot.route_resolution_request.v1',
    'autopilot.route_resolution_result.v1',
    'autopilot.saved_roster_ref.v1',
    'autopilot.unit_spec.v2',
];
