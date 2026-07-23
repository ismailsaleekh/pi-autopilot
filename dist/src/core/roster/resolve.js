import { canonicalSha256, dedupeDiagnostics, } from "./route-policies.js";
function materializeNewRunResult(input) {
    const preimage = {
        schema_version: 'autopilot.new_run_resolution_result.v1',
        ...input,
        diagnostics: input.diagnostics,
        write_count: 0,
        lock_count: 0,
        files_touched: [],
    };
    return { ...preimage, result_sha256: canonicalSha256(preimage) };
}
function authorityDiagnostics(authority) {
    const codes = [];
    if (authority.source === 'trusted-project-default' && authority.trusted === false) {
        codes.push('ROSTER_PROJECT_UNTRUSTED');
    }
    if (authority.state === 'corrupt' || authority.state === 'hash-mismatch') {
        codes.push('ROSTER_READBACK_MISMATCH');
    }
    if (authority.state === 'missing') {
        codes.push('ROSTER_PINNED_SELECTION_UNAVAILABLE');
    }
    return dedupeDiagnostics(codes);
}
function authorityIsSelectable(authority) {
    return (authority.state === 'present' &&
        authority.roster_id !== null &&
        authority.roster_revision !== null &&
        authority.roster_sha256 !== null &&
        authority.assignment_set_sha256 !== null &&
        !(authority.source === 'trusted-project-default' && authority.trusted === false));
}
export function resolveNewRun(request) {
    const precedence = [
        request.explicit_roster,
        request.trusted_project_default,
        request.user_default,
    ];
    for (const authority of precedence) {
        if (authority === null || authority === undefined || authority.state === 'absent') {
            continue;
        }
        const diagnostics = authorityDiagnostics(authority);
        if (diagnostics.length > 0 || !authorityIsSelectable(authority)) {
            return materializeNewRunResult({
                ok: false,
                status: 'blocked',
                source: authority.source,
                selected_scope: null,
                selected_roster_id: null,
                selected_roster_revision: null,
                selected_roster_sha256: null,
                assignment_set_sha256: null,
                diagnostics,
            });
        }
        return materializeNewRunResult({
            ok: true,
            status: 'resolved',
            source: authority.source,
            selected_scope: authority.scope,
            selected_roster_id: authority.roster_id,
            selected_roster_revision: authority.roster_revision,
            selected_roster_sha256: authority.roster_sha256,
            assignment_set_sha256: authority.assignment_set_sha256,
            diagnostics: [],
        });
    }
    return materializeNewRunResult({
        ok: false,
        status: 'onboarding-required',
        source: 'agent-first-onboarding',
        selected_scope: null,
        selected_roster_id: null,
        selected_roster_revision: null,
        selected_roster_sha256: null,
        assignment_set_sha256: null,
        diagnostics: [],
    });
}
function materializeExistingRunResult(input) {
    const preimage = {
        schema_version: 'autopilot.existing_run_resolution_result.v1',
        action: 'resolve-existing-run',
        ...input,
        diagnostics: input.diagnostics,
        write_count: 0,
        lock_count: 0,
        files_touched: [],
    };
    return { ...preimage, result_sha256: canonicalSha256(preimage) };
}
export function resolveExistingRun(request, selection) {
    const explicitSelection = selection;
    const diagnostics = [];
    if (request.runtime_mirror_sha256 !== request.selection_sha256) {
        diagnostics.push('ROSTER_PINNED_SELECTION_UNAVAILABLE', 'ROSTER_TRANSITION_REQUIRED');
    }
    if (request.roster_file_state === 'missing' || request.roster_file_state === 'hash-mismatch') {
        diagnostics.push('ROSTER_PINNED_SELECTION_UNAVAILABLE', 'ROSTER_TRANSITION_REQUIRED');
    }
    if (explicitSelection === null || explicitSelection === undefined || explicitSelection.selection_sha256 !== request.selection_sha256) {
        diagnostics.push('ROSTER_PINNED_SELECTION_UNAVAILABLE', 'ROSTER_TRANSITION_REQUIRED');
    }
    const materializedDiagnostics = dedupeDiagnostics(diagnostics);
    if (materializedDiagnostics.length > 0 || explicitSelection === null || explicitSelection === undefined) {
        return materializeExistingRunResult({
            ok: false,
            status: 'blocked',
            selected_scope: null,
            selected_roster_id: null,
            selected_roster_revision: null,
            selected_roster_sha256: null,
            assignment_set_sha256: null,
            selection_sha256: request.selection_sha256,
            diagnostics: materializedDiagnostics,
        });
    }
    return materializeExistingRunResult({
        ok: true,
        status: 'inspected',
        selected_scope: explicitSelection.scope,
        selected_roster_id: explicitSelection.roster_id,
        selected_roster_revision: explicitSelection.roster_revision,
        selected_roster_sha256: explicitSelection.roster_sha256,
        assignment_set_sha256: explicitSelection.assignment_set_sha256,
        selection_sha256: request.selection_sha256,
        diagnostics: [],
    });
}
function materializeReceiptValidationResult(ok, status, diagnostics) {
    const preimage = {
        schema_version: 'autopilot.receipt_validation_result.v1',
        action: 'validate-receipt',
        ok,
        status,
        diagnostics,
        write_count: 0,
        lock_count: 0,
        files_touched: [],
    };
    return { ...preimage, result_sha256: canonicalSha256(preimage) };
}
function factsMatch(requested, observed) {
    return requested !== null && requested !== undefined && observed !== null && observed !== undefined && requested === observed;
}
function nullableFactsMatch(requested, observed) {
    return requested !== undefined && observed !== undefined && requested === observed;
}
export function validateReceipt(request) {
    const codes = [];
    if (!factsMatch(request.requested_profile_sha256, request.observed_request_profile_sha256)) {
        codes.push('ROSTER_REQUEST_PROFILE_DRIFT');
    }
    if (!factsMatch(request.requested_model_id, request.observed_requested_model_id)) {
        codes.push('ROSTER_OBSERVED_MODEL_MISMATCH');
    }
    if (!factsMatch(request.requested_model_id, request.executed_model_id)) {
        codes.push('ROSTER_OBSERVED_MODEL_MISMATCH');
    }
    if (!factsMatch(request.requested_thinking, request.observed_thinking)) {
        codes.push('ROSTER_OBSERVED_THINKING_MISMATCH');
    }
    if (!factsMatch(request.requested_api, request.observed_api)) {
        codes.push('ROSTER_REQUEST_PROFILE_DRIFT');
    }
    if (!nullableFactsMatch(request.requested_service_tier, request.observed_service_tier)) {
        codes.push('ROSTER_REQUEST_PROFILE_DRIFT');
    }
    if (!factsMatch(request.requested_cache_policy, request.observed_cache_policy)) {
        codes.push('ROSTER_REQUEST_PROFILE_DRIFT');
    }
    if (!factsMatch(request.requested_system_prompt_profile, request.observed_system_prompt_profile)) {
        codes.push('ROSTER_REQUEST_PROFILE_DRIFT');
    }
    const diagnostics = dedupeDiagnostics(codes);
    return materializeReceiptValidationResult(diagnostics.length === 0, diagnostics.length === 0 ? 'inspected' : 'failed', diagnostics);
}
export function publishPreRunSelection(request) {
    const codes = [];
    let ok = true;
    let status = 'published';
    let idempotent_replay = false;
    let write_count = 1;
    let files_touched = [request.selection_path];
    if (request.existing_selection_sha256 !== null) {
        write_count = 0;
        files_touched = [];
        if (request.existing_selection_sha256 === request.selection.selection_sha256) {
            status = 'inspected';
            idempotent_replay = true;
            codes.push('ROSTER_SELECTION_IDEMPOTENT_REPLAY');
        }
        else {
            ok = false;
            status = 'blocked';
            codes.push('ROSTER_CREATE_ONLY_CONFLICT');
        }
    }
    const preimage = {
        schema_version: 'autopilot.pre_run_selection_publish_result.v1',
        action: 'publish-pre-run-selection',
        ok,
        status,
        selection_sha256: request.selection.selection_sha256,
        idempotent_replay,
        diagnostics: dedupeDiagnostics(codes),
        write_count,
        lock_count: 0,
        files_touched,
    };
    return { ...preimage, result_sha256: canonicalSha256(preimage) };
}
