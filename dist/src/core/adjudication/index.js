import { parseAutopilotDecisionRow, parseAutopilotExecutionAudit, parseAutopilotMasterPlan, } from "../contracts/index.js";
export class AutopilotAdjudicationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AutopilotAdjudicationError';
    }
}
export function autopilotAuditNeedsAdjudication(audit) {
    const parsed = parseAutopilotExecutionAudit(audit);
    return parsed.classification !== 'clean';
}
export function buildAutopilotScopeException(input) {
    const audit = parseAutopilotExecutionAudit(input.audit);
    if (audit.outside_owned_paths.length === 0)
        return null;
    return Object.freeze({
        exception_id: `${audit.unit_id}:scope`,
        unit_id: audit.unit_id,
        audit_ref: input.auditRef,
        paths: audit.outside_owned_paths,
        state: 'open',
        summary: `Scope review required for ${audit.outside_owned_paths.length.toString()} outside-owned path(s).`,
    });
}
export function buildAutopilotProtectedPathException(input) {
    const audit = parseAutopilotExecutionAudit(input.audit);
    if (audit.read_only_touched_paths.length === 0 && audit.untouchable_touched_paths.length === 0) {
        return null;
    }
    return Object.freeze({
        exception_id: `${audit.unit_id}:protected`,
        unit_id: audit.unit_id,
        audit_ref: input.auditRef,
        read_only_paths: audit.read_only_touched_paths,
        untouchable_paths: audit.untouchable_touched_paths,
        state: 'open',
        summary: `Protected-path review required for ${audit.read_only_touched_paths.length.toString()} read-only ` +
            `and ${audit.untouchable_touched_paths.length.toString()} untouchable path(s).`,
    });
}
export function ratifyAutopilotScopeException(input) {
    const masterPlan = parseAutopilotMasterPlan(input.masterPlan);
    const audit = parseAutopilotExecutionAudit(input.audit);
    const decision = parseAutopilotDecisionRow(input.decision);
    if (audit.outside_owned_paths.length === 0) {
        throw new AutopilotAdjudicationError('scope ratification requires outside_owned_paths in the execution audit');
    }
    if (decision.event !== 'scope_exception_ratified') {
        throw new AutopilotAdjudicationError('scope ratification requires a scope_exception_ratified decision row');
    }
    if (decision.workstream !== masterPlan.workstream || decision.workstream !== audit.workstream) {
        throw new AutopilotAdjudicationError('scope ratification workstream must match master plan and audit');
    }
    if (decision.unit_id !== audit.unit_id) {
        throw new AutopilotAdjudicationError('scope ratification decision must reference the audited unit_id');
    }
    const amendedOwnedPaths = sortedUnique([
        ...masterPlan.ownership_matrix.owned_paths,
        ...audit.outside_owned_paths,
    ]);
    const amendedPlan = {
        ...masterPlan,
        ownership_matrix: {
            ...masterPlan.ownership_matrix,
            owned_paths: amendedOwnedPaths,
            held_paths: removeMatchingPaths(masterPlan.ownership_matrix.held_paths, audit.outside_owned_paths),
        },
        last_decision_id: Math.max(masterPlan.last_decision_id, decision.id),
        updated_at: decision.ts,
    };
    return parseAutopilotMasterPlan(amendedPlan);
}
export function isAutopilotScopeAuditRatified(input) {
    const audit = parseAutopilotExecutionAudit(input.audit);
    const masterPlan = parseAutopilotMasterPlan(input.masterPlan);
    if (audit.outside_owned_paths.length === 0)
        return true;
    const hasDecision = input.decisions.some((decision) => decision.event === 'scope_exception_ratified' &&
        decision.workstream === audit.workstream &&
        decision.unit_id === audit.unit_id);
    if (!hasDecision)
        return false;
    return audit.outside_owned_paths.every((path) => matchesAnyPathPattern(path, masterPlan.ownership_matrix.owned_paths));
}
export function isAutopilotProtectedAuditResolved(input) {
    const audit = parseAutopilotExecutionAudit(input.audit);
    const masterPlan = parseAutopilotMasterPlan(input.masterPlan);
    const touchedPaths = [...audit.read_only_touched_paths, ...audit.untouchable_touched_paths];
    if (touchedPaths.length === 0)
        return true;
    const hasDecision = input.decisions.some((decision) => (decision.event === 'operator_approval_recorded' || decision.event === 'ownership_amended') &&
        decision.workstream === audit.workstream &&
        decision.unit_id === audit.unit_id);
    if (!hasDecision)
        return false;
    return touchedPaths.every((path) => matchesAnyPathPattern(path, masterPlan.ownership_matrix.owned_paths) &&
        !matchesAnyPathPattern(path, masterPlan.ownership_matrix.read_only_paths) &&
        !matchesAnyPathPattern(path, masterPlan.ownership_matrix.untouchable_paths));
}
function removeMatchingPaths(paths, removed) {
    return Object.freeze(paths.filter((path) => !removed.some((entry) => path === entry)));
}
function matchesAnyPathPattern(path, patterns) {
    return patterns.some((pattern) => matchesPathPattern(path, pattern));
}
function matchesPathPattern(path, pattern) {
    const normalizedPath = normalizeRelativePath(path);
    const normalizedPattern = normalizeRelativePath(pattern);
    if (normalizedPattern.endsWith('/**')) {
        const base = normalizedPattern.slice(0, -3);
        return normalizedPath === base || normalizedPath.startsWith(`${base}/`);
    }
    return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
}
function normalizeRelativePath(path) {
    return path.replace(/\\/gu, '/').replace(/\/+/gu, '/');
}
function sortedUnique(values) {
    return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}
