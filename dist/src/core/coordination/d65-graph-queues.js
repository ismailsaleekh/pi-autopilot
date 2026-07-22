import { CoordinationRuntimeError } from "./failures.js";
export const D65_QUEUE_KEYS = [
    'unit_ready', 'unit_running', 'unit_blocked', 'unit_completed', 'unit_held', 'work_audit_review', 'work_validation_ready',
];
function sortedByBytes(values) {
    return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
/**
 * Derive the exact seven complete-graph queue indexes from the loaded authority
 * `state`. The five unit sets partition U; each work item is deterministically
 * in/out of both work queues; sort is decoded unsigned identity bytes.
 */
export function deriveD65QueueProjection(state) {
    const units = state.units;
    const ready = [];
    const running = [];
    const blocked = [];
    const completed = [];
    const held = [];
    for (const unitId of Object.keys(units)) {
        const unit = units[unitId];
        if (unit === undefined)
            continue;
        switch (unit.state) {
            case 'ready':
                ready.push(unitId);
                break;
            case 'running':
                running.push(unitId);
                break;
            case 'blocked':
            case 'failed':
                blocked.push(unitId);
                break;
            case 'completed':
                completed.push(unitId);
                break;
            case 'queued':
                held.push(unitId);
                break;
        }
    }
    const workItems = state.work_items ?? {};
    const auditReview = [];
    const validationReady = [];
    for (const [workItemId, workItem] of Object.entries(workItems)) {
        if (workItem.state === 'audit-review')
            auditReview.push(workItemId);
        if (workItem.state === 'validation-ready' || workItem.state === 'revalidation-ready')
            validationReady.push(workItemId);
    }
    return {
        unit_ready: sortedByBytes(ready),
        unit_running: sortedByBytes(running),
        unit_blocked: sortedByBytes(blocked),
        unit_completed: sortedByBytes(completed),
        unit_held: sortedByBytes(held),
        work_audit_review: sortedByBytes(auditReview),
        work_validation_ready: sortedByBytes(validationReady),
    };
}
function equalArrays(left, right) {
    if (left.length !== right.length)
        return false;
    for (let index = 0; index < left.length; index += 1)
        if (left[index] !== right[index])
            return false;
    return true;
}
/**
 * Prove a complete graph's loaded queue projection members equal the derived
 * equations from `state`. Members come from the loaded projection shards (each
 * queue value is exactly `{identity}`). The five unit sets must partition U.
 */
export function assertD65QueueProjectionMembers(input) {
    const derived = deriveD65QueueProjection(input.state);
    const unitIds = new Set(Object.keys(input.state.units));
    const partition = [derived.unit_ready, derived.unit_running, derived.unit_blocked, derived.unit_completed, derived.unit_held];
    const seen = new Set();
    for (const set of partition) {
        for (const id of set) {
            if (seen.has(id))
                throw new CoordinationRuntimeError('invalid-state', `semantic-graph-projection-mismatch: unit ${id} appears in more than one queue`);
            seen.add(id);
        }
    }
    if (seen.size !== unitIds.size || [...unitIds].some((id) => !seen.has(id)))
        throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-projection-mismatch: the five unit queues do not partition the unit set');
    for (const key of D65_QUEUE_KEYS) {
        if (!equalArrays(input.members[key], derived[key]))
            throw new CoordinationRuntimeError('invalid-state', `semantic-graph-projection-mismatch: ${key} members do not equal the derived equation`);
    }
}
/**
 * Prove the complete-graph loaded queue-projection INDEXES are entry-count
 * consistent with the derived equation from `state`. An empty derived queue
 * requires an empty index (count 0); a nonempty derived queue requires the index
 * entry_count to equal the derived queue length. Full member equality is proven
 * separately once the projection shards are loaded.
 */
export function assertD65QueueProjectionCounts(input) {
    const derived = deriveD65QueueProjection(input.state);
    for (const key of D65_QUEUE_KEYS) {
        const derivedQueue = derived[key];
        const index = input.indexes[key];
        if (index.entry_count !== derivedQueue.length)
            throw new CoordinationRuntimeError('invalid-state', `semantic-graph-projection-mismatch: ${key} index entry_count ${String(index.entry_count)} does not equal the derived queue size ${String(derivedQueue.length)}`);
    }
}
// ---- closed legal transition relations --------------------------------------
const D65_UNIT_EDGES = Object.freeze({
    queued: ['ready', 'blocked', 'failed'],
    ready: ['running', 'blocked', 'failed'],
    running: ['completed', 'blocked', 'failed'],
    blocked: ['ready'],
    failed: ['ready'],
    completed: [],
});
const D65_WORK_ITEM_EDGES = Object.freeze({
    planned: ['running'],
    running: ['transport-complete', 'needs-fix'],
    'transport-complete': ['audit-review', 'validation-ready', 'needs-fix'],
    'audit-review': ['validation-ready', 'needs-fix'],
    'validation-ready': ['validated', 'needs-fix'],
    'needs-fix': ['fixed'],
    fixed: ['revalidation-ready'],
    'revalidation-ready': ['validated', 'needs-fix'],
    validated: ['closed'],
    closed: [],
});
/** True iff `from→to` is a legal complete-mode unit edge. */
export function isD65LegalUnitEdge(from, to) {
    return (D65_UNIT_EDGES[from] ?? []).includes(to);
}
/** True iff `from→to` is a legal complete-mode work-item edge. */
export function isD65LegalWorkItemEdge(from, to) {
    return (D65_WORK_ITEM_EDGES[from] ?? []).includes(to);
}
/**
 * Assert a unit transition is legal. `blocked|failed→ready` additionally
 * requires attempt+1 plus accepted recovery evidence; `completed` is terminal;
 * attempt increments only on that recovery edge.
 */
export function assertD65UnitTransition(input) {
    if (input.from === input.to)
        throw new CoordinationRuntimeError('invalid-state', `semantic-graph-transition-invalid: unit ${input.unitId} has an undocumented same-state mutation`);
    if (!isD65LegalUnitEdge(input.from, input.to))
        throw new CoordinationRuntimeError('invalid-state', `semantic-graph-transition-invalid: unit ${input.unitId} ${input.from}->${input.to} is not a legal edge`);
    const recoveryEdge = (input.from === 'blocked' || input.from === 'failed') && input.to === 'ready';
    if (recoveryEdge) {
        if (input.toAttempt !== input.fromAttempt + 1)
            throw new CoordinationRuntimeError('invalid-state', `semantic-graph-transition-invalid: unit ${input.unitId} recovery edge requires attempt+1`);
        if (!input.hasRecoveryEvidence)
            throw new CoordinationRuntimeError('invalid-state', `semantic-graph-transition-invalid: unit ${input.unitId} recovery edge requires accepted recovery/decision evidence`);
    }
    else if (input.toAttempt !== input.fromAttempt) {
        throw new CoordinationRuntimeError('invalid-state', `semantic-graph-transition-invalid: unit ${input.unitId} attempt may only increment on the recovery edge`);
    }
}
/** Assert a work-item transition is legal; `closed` is terminal. */
export function assertD65WorkItemTransition(input) {
    if (input.from === input.to)
        throw new CoordinationRuntimeError('invalid-state', `semantic-graph-transition-invalid: work item ${input.workItemId} has an undocumented same-state mutation`);
    if (!isD65LegalWorkItemEdge(input.from, input.to))
        throw new CoordinationRuntimeError('invalid-state', `semantic-graph-transition-invalid: work item ${input.workItemId} ${input.from}->${input.to} is not a legal edge`);
}
