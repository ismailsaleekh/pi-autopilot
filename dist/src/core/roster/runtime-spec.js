import { computeAutopilotRosterContractObjectHash, parseAutopilotPreRunSelection, parseAutopilotReceiptV2, parseAutopilotRoster, parseAutopilotRosterContract, parseAutopilotUnitSpecV2, } from "./contracts.js";
import { canonicalRosterJson } from "./canonical.js";
export class AutopilotRosterRuntimeSpecError extends Error {
    reason;
    constructor(reason) {
        super(reason);
        this.name = 'AutopilotRosterRuntimeSpecError';
        this.reason = reason;
    }
}
const ASSIGNMENT_REQUEST_PROFILE_FIELDS = [
    'provider_id',
    'model_id',
    'model',
    'api',
    'thinking',
    'service_tier',
    'cache_policy',
    'system_prompt_profile',
    'context_window',
    'max_output_tokens',
    'input_modalities',
    'output_modalities',
    'reasoning_capability',
    'tool_capability',
    'route_policy_id',
    'route_policy_revision',
];
const UNIT_SELECTION_FIELDS = [
    'roster_id',
    'roster_revision',
    'roster_sha256',
    'assignment_sha256',
    'pre_run_selection_sha256',
];
export function requestProfileFromAssignment(assignmentValue) {
    const assignment = parseAutopilotRosterContract('autopilot.assignment.v1', assignmentValue);
    const record = {};
    for (const field of ASSIGNMENT_REQUEST_PROFILE_FIELDS)
        record[field] = assignment[field];
    record['request_profile_sha256'] = zeroDigest();
    record['request_profile_sha256'] = requiredHash('autopilot.request_profile.v1', record);
    return parseAutopilotRosterContract('autopilot.request_profile.v1', record);
}
export function resolvePinnedRoleRuntimeFacts(input) {
    const selection = parseAutopilotPreRunSelection(input.selection);
    const roster = parseAutopilotRoster(input.roster);
    const requestProfile = parseAutopilotRosterContract('autopilot.request_profile.v1', input.request_profile);
    if (selection.roster_id !== roster.roster_id) {
        throw new AutopilotRosterRuntimeSpecError('pinned selection roster_id does not match roster');
    }
    if (selection.roster_revision !== roster.roster_revision) {
        throw new AutopilotRosterRuntimeSpecError('pinned selection roster_revision does not match roster');
    }
    if (selection.roster_sha256 !== roster.roster_sha256) {
        throw new AutopilotRosterRuntimeSpecError('pinned selection roster_sha256 does not match roster');
    }
    if (selection.assignment_set_sha256 !== roster.assignment_set_sha256) {
        throw new AutopilotRosterRuntimeSpecError('pinned selection assignment_set_sha256 does not match roster');
    }
    if (selection.scope !== roster.selected_scope) {
        throw new AutopilotRosterRuntimeSpecError('pinned selection scope does not match roster selected_scope');
    }
    const assignment = roster.assignments.find((entry) => entry.role === input.role);
    if (assignment === undefined) {
        throw new AutopilotRosterRuntimeSpecError(`pinned roster is missing role assignment ${input.role}`);
    }
    assertRequestProfileMatchesAssignment(requestProfile, assignment);
    return Object.freeze({ selection, roster, assignment, request_profile: requestProfile });
}
export function assertRequestProfileMatchesAssignment(requestProfileValue, assignmentValue) {
    const requestProfile = parseAutopilotRosterContract('autopilot.request_profile.v1', requestProfileValue);
    const assignment = parseAutopilotRosterContract('autopilot.assignment.v1', assignmentValue);
    const derived = requestProfileFromAssignment(assignment);
    for (const field of [...ASSIGNMENT_REQUEST_PROFILE_FIELDS, 'request_profile_sha256']) {
        if (!jsonEqual(requestProfile[field], derived[field])) {
            throw new AutopilotRosterRuntimeSpecError(`request_profile.${field} does not match role assignment`);
        }
    }
}
export function materializeNewRunUnitSpecV2(input) {
    if (input.schema_version !== undefined && input.schema_version !== 'autopilot.unit_spec.v2') {
        throw new AutopilotRosterRuntimeSpecError('new-run unit spec creation must use autopilot.unit_spec.v2');
    }
    const facts = resolvePinnedRoleRuntimeFacts(input);
    const record = {
        schema_version: 'autopilot.unit_spec.v2',
        workstream: input.workstream,
        unit_id: input.unit_id,
        role: input.role,
        template: input.role,
        attempt: input.attempt,
        objective: input.objective,
        cwd: input.cwd,
        model: facts.request_profile.model,
        thinking: facts.request_profile.thinking,
        owned_paths: input.owned_paths,
        read_only_paths: input.read_only_paths,
        untouchable_paths: input.untouchable_paths,
        context_refs: input.context_refs,
        validation_commands: input.validation_commands,
        status_output: input.status_output,
        receipt_output: input.receipt_output,
        evidence_dir: input.evidence_dir,
        stop_boundary: input.stop_boundary,
        quality_profile: input.quality_profile,
        risk_level: input.risk_level,
        acceptance_criteria: input.acceptance_criteria,
        verification_plan: input.verification_plan,
        closure_criteria: input.closure_criteria,
        upstream_refs: input.upstream_refs,
        timeout_seconds: input.timeout_seconds,
        render_prompt_snapshot: input.render_prompt_snapshot,
        roster_id: facts.selection.roster_id,
        roster_revision: facts.selection.roster_revision,
        roster_sha256: facts.selection.roster_sha256,
        assignment_sha256: facts.assignment.assignment_sha256,
        pre_run_selection_sha256: facts.selection.selection_sha256,
        request_profile: facts.request_profile,
    };
    return parseAutopilotUnitSpecV2(record);
}
export function materializeObservedProfile(input) {
    const requestProfile = parseAutopilotRosterContract('autopilot.request_profile.v1', input.request_profile);
    const record = {
        provider_id: input.provider_id,
        requested_model_id: input.requested_model_id,
        executed_model_id: input.executed_model_id,
        api: input.api,
        thinking: input.thinking,
        service_tier: input.service_tier,
        cache_policy: input.cache_policy,
        system_prompt_profile: input.system_prompt_profile,
        system_prompt_sha256: input.system_prompt_sha256,
        route_policy_id: input.route_policy_id,
        route_policy_revision: input.route_policy_revision,
        request_profile_sha256: requestProfile.request_profile_sha256,
        observed_profile_sha256: zeroDigest(),
    };
    record['observed_profile_sha256'] = requiredHash('autopilot.observed_profile.v1', record);
    const observedProfile = parseAutopilotRosterContract('autopilot.observed_profile.v1', record);
    assertObservedProfileMatchesRequestProfile(observedProfile, requestProfile);
    return observedProfile;
}
export function materializeReceiptV2(input) {
    const unitSpec = parseAutopilotUnitSpecV2(input.unit_spec);
    const facts = resolvePinnedRoleRuntimeFacts({
        selection: input.selection,
        roster: input.roster,
        role: unitSpec.role,
        request_profile: input.request_profile,
    });
    assertUnitSpecMatchesPinnedFacts(unitSpec, facts);
    const observedProfile = parseAutopilotRosterContract('autopilot.observed_profile.v1', input.observed_profile);
    assertObservedProfileMatchesRequestProfile(observedProfile, facts.request_profile);
    const record = {
        schema_version: 'autopilot.receipt.v2',
        tool_name: 'autopilot_emit_status',
        workstream: unitSpec.workstream,
        unit_id: unitSpec.unit_id,
        role: unitSpec.role,
        attempt: unitSpec.attempt,
        emitted_at: input.emitted_at,
        status_output: unitSpec.status_output,
        status_sha256: input.status_sha256,
        schema_sha256: input.schema_sha256,
        tool_call_id: input.tool_call_id,
        provider_identity: input.provider_identity,
        expected_identity_hash: input.expected_identity_hash,
        roster_id: unitSpec.roster_id,
        roster_revision: unitSpec.roster_revision,
        roster_sha256: unitSpec.roster_sha256,
        assignment_sha256: unitSpec.assignment_sha256,
        pre_run_selection_sha256: unitSpec.pre_run_selection_sha256,
        request_profile: facts.request_profile,
        observed_profile: observedProfile,
    };
    return parseAutopilotReceiptV2(record);
}
export function assertUnitSpecMatchesPinnedFacts(unitSpecValue, facts) {
    const unitSpec = parseAutopilotUnitSpecV2(unitSpecValue);
    if (unitSpec.role !== facts.assignment.role) {
        throw new AutopilotRosterRuntimeSpecError('unit_spec.v2 role does not match pinned assignment role');
    }
    if (unitSpec.model !== facts.request_profile.model) {
        throw new AutopilotRosterRuntimeSpecError('unit_spec.v2 model does not match pinned request_profile.model');
    }
    if (unitSpec.thinking !== facts.request_profile.thinking) {
        throw new AutopilotRosterRuntimeSpecError('unit_spec.v2 thinking does not match pinned request_profile.thinking');
    }
    for (const field of UNIT_SELECTION_FIELDS) {
        const expected = field === 'pre_run_selection_sha256'
            ? facts.selection.selection_sha256
            : field === 'assignment_sha256'
                ? facts.assignment.assignment_sha256
                : facts.selection[field];
        if (unitSpec[field] !== expected) {
            throw new AutopilotRosterRuntimeSpecError(`unit_spec.v2 ${field} does not match pinned selection`);
        }
    }
    if (!jsonEqual(unitSpec.request_profile, facts.request_profile)) {
        throw new AutopilotRosterRuntimeSpecError('unit_spec.v2 request_profile does not match pinned request_profile');
    }
}
export function assertReceiptMatchesUnitSpecAndPinnedFacts(receiptValue, unitSpecValue, facts) {
    const receipt = parseAutopilotReceiptV2(receiptValue);
    const unitSpec = parseAutopilotUnitSpecV2(unitSpecValue);
    assertUnitSpecMatchesPinnedFacts(unitSpec, facts);
    for (const field of ['workstream', 'unit_id', 'role', 'attempt', 'status_output']) {
        if (receipt[field] !== unitSpec[field]) {
            throw new AutopilotRosterRuntimeSpecError(`receipt.v2 ${field} does not match unit_spec.v2`);
        }
    }
    for (const field of UNIT_SELECTION_FIELDS) {
        if (receipt[field] !== unitSpec[field]) {
            throw new AutopilotRosterRuntimeSpecError(`receipt.v2 ${field} does not match unit_spec.v2`);
        }
    }
    if (!jsonEqual(receipt.request_profile, facts.request_profile)) {
        throw new AutopilotRosterRuntimeSpecError('receipt.v2 request_profile does not match pinned request_profile');
    }
    assertObservedProfileMatchesRequestProfile(receipt.observed_profile, facts.request_profile);
}
export function assertObservedProfileMatchesRequestProfile(observedProfileValue, requestProfileValue) {
    const observedProfile = parseAutopilotRosterContract('autopilot.observed_profile.v1', observedProfileValue);
    const requestProfile = parseAutopilotRosterContract('autopilot.request_profile.v1', requestProfileValue);
    const exactFieldPairs = [
        ['provider_id', 'provider_id'],
        ['requested_model_id', 'model_id'],
        ['executed_model_id', 'model_id'],
        ['api', 'api'],
        ['thinking', 'thinking'],
        ['service_tier', 'service_tier'],
        ['cache_policy', 'cache_policy'],
        ['system_prompt_profile', 'system_prompt_profile'],
        ['route_policy_id', 'route_policy_id'],
        ['route_policy_revision', 'route_policy_revision'],
        ['request_profile_sha256', 'request_profile_sha256'],
    ];
    for (const [observedField, requestField] of exactFieldPairs) {
        if (observedProfile[observedField] !== requestProfile[requestField]) {
            throw new AutopilotRosterRuntimeSpecError(`observed_profile.${observedField} does not match request_profile.${requestField}`);
        }
    }
}
function requiredHash(schemaVersion, value) {
    const hash = computeAutopilotRosterContractObjectHash(schemaVersion, value);
    if (hash === null)
        throw new AutopilotRosterRuntimeSpecError(`${schemaVersion} does not carry a hash field`);
    return hash;
}
function zeroDigest() {
    return 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
}
function jsonEqual(left, right) {
    return canonicalRosterJson(left) === canonicalRosterJson(right);
}
