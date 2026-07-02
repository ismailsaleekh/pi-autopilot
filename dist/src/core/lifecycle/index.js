import { parseAutopilotDecisionRow, parseAutopilotExecutionAudit, parseAutopilotMasterPlan, parseAutopilotState, parseAutopilotStatusEntry, } from "../contracts/index.js";
import { isAutopilotProtectedAuditResolved, isAutopilotScopeAuditRatified, } from "../adjudication/index.js";
export function nextAutopilotWorkItemStateAfterTransport(input) {
    const audit = parseAutopilotExecutionAudit(input.audit);
    if (!input.workItem.source_changing)
        return 'closed';
    if (audit.classification === 'clean')
        return 'validation-ready';
    return 'audit-review';
}
export function nextAutopilotWorkItemStateAfterValidation(input) {
    const status = parseAutopilotStatusEntry(input.validationStatus);
    if (status.role !== 'validate' && status.role !== 'bughunt')
        return input.workItem.state;
    if (status.verdict === 'PASS')
        return 'closed';
    if (status.verdict === 'NEEDS_FIX')
        return 'needs-fix';
    return 'audit-review';
}
export function evaluateAutopilotClosureGate(input) {
    const state = parseAutopilotState(input.state);
    const masterPlan = parseAutopilotMasterPlan(input.masterPlan);
    const statuses = input.statuses.map((status) => parseAutopilotStatusEntry(status));
    const audits = input.audits.map((audit) => parseAutopilotExecutionAudit(audit));
    const decisions = input.decisions.map((decision) => parseAutopilotDecisionRow(decision));
    const blockingReasons = [];
    if (state.running.length > 0) {
        blockingReasons.push(`running unit(s) remain: ${state.running.join(', ')}`);
    }
    for (const exception of state.scope_exceptions ?? []) {
        if (exception.state === 'open') {
            blockingReasons.push(`unresolved scope exception ${exception.exception_id}`);
        }
    }
    for (const exception of state.protected_path_exceptions ?? []) {
        if (exception.state === 'open') {
            blockingReasons.push(`unresolved protected-path exception ${exception.exception_id}`);
        }
    }
    for (const audit of audits) {
        if (audit.classification === 'clean')
            continue;
        if (audit.classification === 'scope-review-required') {
            if (!isAutopilotScopeAuditRatified({ audit, masterPlan, decisions })) {
                blockingReasons.push(`scope review unresolved for ${audit.unit_id}`);
            }
            continue;
        }
        if (audit.classification === 'protected-path-review-required' ||
            audit.classification === 'critical-protected-path-violation') {
            if (!isAutopilotProtectedAuditResolved({ audit, masterPlan, decisions })) {
                blockingReasons.push(`protected-path review unresolved for ${audit.unit_id}`);
            }
            continue;
        }
        blockingReasons.push(`audit unavailable for ${audit.unit_id}`);
    }
    const sourceChangingWorkItems = Object.entries(state.work_items ?? {}).filter((entry) => entry[1].source_changing);
    for (const [workItemId, workItem] of sourceChangingWorkItems) {
        if (workItem.state !== 'closed') {
            blockingReasons.push(`source-changing work item ${workItemId} is ${workItem.state}, not closed`);
        }
        blockingReasons.push(...sourceChangingWorkItemValidationBlockers({ state, workItemId, workItem, statuses }));
    }
    const sourceChangingAuditExists = audits.some(isSourceChangingAudit);
    if (sourceChangingAuditExists && sourceChangingWorkItems.length === 0) {
        blockingReasons.push('source-changing audits require work_items with independent validation refs');
    }
    const requiresFinalBughunt = masterPlan.risk_level === 'high' || masterPlan.risk_level === 'critical' || masterPlan.lanes.length > 1;
    if (requiresFinalBughunt && !hasBughuntPass(statuses) && !hasAcceptedBlocker(decisions)) {
        blockingReasons.push('high/critical or multi-lane closure requires final bughunt PASS or accepted blocker');
    }
    const status = blockingReasons.length === 0 ? 'passed' : 'failed';
    return Object.freeze({
        status,
        checked_at: input.checkedAt ?? new Date().toISOString(),
        blocking_reasons: [...blockingReasons],
        summary: status === 'passed'
            ? 'Autopilot closure gate passed.'
            : `Autopilot closure gate failed with ${blockingReasons.length.toString()} blocker(s).`,
    });
}
function sourceChangingWorkItemValidationBlockers(input) {
    const blockers = [];
    const validationUnitId = input.workItem.validation_unit_id;
    const validationStatusRef = input.workItem.validation_status_ref;
    if (validationUnitId === undefined) {
        blockers.push(`source-changing work item ${input.workItemId} lacks validation_unit_id`);
        return blockers;
    }
    if (validationStatusRef === undefined) {
        blockers.push(`source-changing work item ${input.workItemId} lacks validation_status_ref`);
        return blockers;
    }
    if (validationUnitId === input.workItem.implementation_unit_id) {
        blockers.push(`source-changing work item ${input.workItemId} uses its implementation unit as validation`);
    }
    if (!input.workItem.unit_ids.includes(validationUnitId)) {
        blockers.push(`source-changing work item ${input.workItemId} validation_unit_id is outside unit_ids`);
    }
    const stateUnit = input.state.units[validationUnitId];
    if (stateUnit === undefined) {
        blockers.push(`source-changing work item ${input.workItemId} validation_unit_id is missing from state units`);
        return blockers;
    }
    if (stateUnit.status_ref !== undefined && stateUnit.status_ref !== validationStatusRef) {
        blockers.push(`source-changing work item ${input.workItemId} validation_status_ref does not match state unit status_ref`);
    }
    const validationStatuses = input.statuses.filter((status) => status.workstream === input.state.workstream &&
        status.unit_id === validationUnitId &&
        isValidationRole(status.role));
    const matchingStatus = validationStatuses.find((status) => statusRefCandidates(status, stateUnit.status_ref).includes(validationStatusRef));
    if (matchingStatus === undefined) {
        const reason = validationStatuses.length === 0
            ? 'lacks referenced validation PASS status'
            : 'validation_status_ref does not match validation status identity';
        blockers.push(`source-changing work item ${input.workItemId} ${reason}`);
        return blockers;
    }
    if (matchingStatus.verdict !== 'PASS') {
        blockers.push(`source-changing work item ${input.workItemId} validation status is ${matchingStatus.verdict}, not PASS`);
    }
    return blockers;
}
function statusRefCandidates(status, stateStatusRef) {
    const canonical = `statuses/${status.unit_id}.${status.role}.attempt-${String(status.attempt)}.json`;
    return stateStatusRef === undefined ? [canonical] : [canonical, stateStatusRef];
}
function isValidationRole(role) {
    return role === 'validate' || role === 'bughunt';
}
function isSourceChangingAudit(audit) {
    return audit.role === 'implement' || audit.role === 'fix';
}
function hasBughuntPass(statuses) {
    return statuses.some((status) => status.role === 'bughunt' && status.verdict === 'PASS');
}
function hasAcceptedBlocker(decisions) {
    return decisions.some((decision) => decision.event === 'blocker_ruling');
}
