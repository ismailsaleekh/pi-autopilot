import { claimModesConflict, coordinationPathsOverlap } from "./contracts.js";
export const MAX_GRANT_BYPASSES = 8;
const TERMINAL_REQUEST_STATES = new Set(['resolved', 'cancelled', 'superseded']);
const TERMINAL_OPERATION_STAGES = new Set(['committed', 'compensated', 'failed']);
const GIT_CRITICAL_OPERATIONS = new Set(['merge', 'reset', 'quarantine', 'archive', 'remove', 'metadata-reconcile']);
export function compareCoordinationGrantPriority(left, right) {
    const leftStarved = left.bypass_count >= MAX_GRANT_BYPASSES ? 0 : 1;
    const rightStarved = right.bypass_count >= MAX_GRANT_BYPASSES ? 0 : 1;
    return leftStarved - rightStarved || left.offer_count - right.offer_count || left.created_event_seq - right.created_event_seq || left.acquisition_group_id.localeCompare(right.acquisition_group_id);
}
export function coordinationOwnerKey(owner) {
    return `${owner.repo_id}\0${owner.autopilot_id}\0${owner.workstream_run}\0${owner.unit_id}\0${String(owner.attempt)}`;
}
export function buildCoordinationWaitForEdges(input) {
    const priorByRequest = new Map((input.priorEdges ?? []).map((edge) => [edge.request_id, edge]));
    const leases = new Map(input.editLeases.map((lease) => [lease.edit_lease_id, lease]));
    const activeRequestIds = new Set();
    const edges = [];
    for (const request of [...input.requests].sort((left, right) => left.created_event_seq - right.created_event_seq || left.request_id.localeCompare(right.request_id))) {
        const hasBlocker = request.blocking_lease_ids.some((leaseId) => {
            const lease = leases.get(leaseId);
            return lease !== undefined
                && coordinationOwnerKey(lease.owner) === coordinationOwnerKey(request.owner)
                && request.requested_leases.some((requested) => coordinationPathsOverlap(requested.path, lease.path) && claimModesConflict(requested.mode, lease.mode));
        });
        if (TERMINAL_REQUEST_STATES.has(request.status) || !hasBlocker)
            continue;
        activeRequestIds.add(request.request_id);
        const prior = priorByRequest.get(request.request_id);
        edges.push(prior === undefined ? {
            schema_version: 'autopilot.wait_for_edge.v1',
            edge_id: `wait-${request.request_id}`,
            repo_id: request.requester.repo_id,
            request_id: request.request_id,
            requester: request.requester,
            blocker: request.owner,
            state: 'active',
            created_event_seq: request.created_event_seq,
            resolved_event_seq: null,
            version: 1,
        } : prior.state === 'active' ? prior : {
            ...prior,
            state: 'active',
            resolved_event_seq: null,
            version: prior.version + 1,
        });
    }
    for (const prior of input.priorEdges ?? []) {
        if (activeRequestIds.has(prior.request_id))
            continue;
        edges.push(prior.state === 'resolved' ? prior : {
            ...prior,
            state: 'resolved',
            resolved_event_seq: input.eventSeq,
            version: prior.version + 1,
        });
    }
    return Object.freeze(edges.sort((left, right) => left.edge_id.localeCompare(right.edge_id)));
}
export function detectCoordinationWaitCycles(edges) {
    const active = edges.filter((edge) => edge.state === 'active');
    const adjacency = new Map();
    for (const edge of active) {
        const from = coordinationOwnerKey(edge.requester);
        const to = coordinationOwnerKey(edge.blocker);
        const targets = adjacency.get(from) ?? new Set();
        targets.add(to);
        adjacency.set(from, targets);
        if (!adjacency.has(to))
            adjacency.set(to, new Set());
    }
    // Iterative Kosaraju avoids JavaScript call-stack exhaustion at the accepted
    // 100k-record production bound. Both passes and edge bucketing stay O(V+E).
    const orderedNodes = [...adjacency.keys()].sort();
    const reverse = new Map(orderedNodes.map((node) => [node, new Set()]));
    for (const [from, targets] of adjacency)
        for (const target of targets)
            reverse.get(target)?.add(from);
    const visited = new Set();
    const finishOrder = [];
    for (const root of orderedNodes) {
        if (visited.has(root))
            continue;
        visited.add(root);
        const frames = [{ node: root, targets: [...(adjacency.get(root) ?? [])].sort(), index: 0 }];
        while (frames.length > 0) {
            const frame = frames[frames.length - 1];
            if (frame === undefined)
                break;
            const target = frame.targets[frame.index];
            if (target !== undefined) {
                frame.index += 1;
                if (!visited.has(target)) {
                    visited.add(target);
                    frames.push({ node: target, targets: [...(adjacency.get(target) ?? [])].sort(), index: 0 });
                }
                continue;
            }
            finishOrder.push(frame.node);
            frames.pop();
        }
    }
    const assigned = new Set();
    const components = [];
    for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
        const root = finishOrder[index];
        if (root === undefined || assigned.has(root))
            continue;
        const component = [];
        const pending = [root];
        assigned.add(root);
        while (pending.length > 0) {
            const node = pending.pop();
            if (node === undefined)
                break;
            component.push(node);
            for (const source of [...(reverse.get(node) ?? [])].sort().reverse())
                if (!assigned.has(source)) {
                    assigned.add(source);
                    pending.push(source);
                }
        }
        components.push(component.sort());
    }
    const selfEdges = new Map();
    for (const edge of active) {
        const requester = coordinationOwnerKey(edge.requester);
        if (requester !== coordinationOwnerKey(edge.blocker))
            continue;
        const entries = selfEdges.get(requester) ?? [];
        entries.push(edge);
        selfEdges.set(requester, entries);
    }
    const componentByParticipant = new Map();
    components.forEach((component, componentIndex) => component.forEach((participant) => componentByParticipant.set(participant, componentIndex)));
    const edgesByComponent = new Map();
    for (const edge of active) {
        const requesterComponent = componentByParticipant.get(coordinationOwnerKey(edge.requester));
        if (requesterComponent === undefined || requesterComponent !== componentByParticipant.get(coordinationOwnerKey(edge.blocker)))
            continue;
        const entries = edgesByComponent.get(requesterComponent) ?? [];
        entries.push(edge);
        edgesByComponent.set(requesterComponent, entries);
    }
    const cycles = [];
    for (const [componentIndex, component] of components.entries()) {
        // A singleton SCC can only be cyclic through a self-edge.
        const componentEdges = component.length === 1
            ? (selfEdges.get(component[0] ?? '') ?? [])
            : (edgesByComponent.get(componentIndex) ?? []);
        if (component.length === 1 && componentEdges.length === 0)
            continue;
        const edgeIds = componentEdges.map((edge) => edge.edge_id).sort();
        const requestIds = [...new Set(componentEdges.map((edge) => edge.request_id))].sort();
        cycles.push({
            cycle_id: `cycle-${edgeIds.join('--')}`,
            participant_keys: [...component],
            edge_ids: [...edgeIds],
            request_ids: [...requestIds],
        });
    }
    return Object.freeze(cycles.sort((left, right) => left.cycle_id.localeCompare(right.cycle_id)));
}
export function selectCoordinationDeadlockVictim(cycle, view) {
    const attempts = view.attempts.filter((attempt) => cycle.participant_keys.includes(coordinationOwnerKey(attempt.owner)));
    const candidates = [];
    for (const attempt of attempts) {
        if (attempt.critical_section !== null || hasGitCriticalSection(attempt.owner, view.worktreeOperations))
            continue;
        const children = view.childLeases.filter((child) => coordinationOwnerKey(child.owner) === coordinationOwnerKey(attempt.owner));
        const hasRunningChild = children.some((child) => child.status === 'running');
        const recoveryChild = children.some((child) => child.status === 'recovery-required');
        const hasUnitWorktree = view.worktrees.some((worktree) => worktree.kind === 'unit' && coordinationOwnerKey(worktree.owner) === coordinationOwnerKey(attempt.owner) && worktree.state !== 'removed');
        let victimClass = null;
        let action = null;
        if (recoveryChild || attempt.state === 'failed') {
            victimClass = 1;
            action = 'request-reset-or-quarantine';
        }
        else if ((attempt.state === 'queued' || attempt.state === 'preflight') && !hasRunningChild && !hasUnitWorktree) {
            victimClass = 2;
            action = 'cancel-and-supersede';
        }
        else if (attempt.state === 'running' && attempt.preemptible && attempt.checkpoint_ordinal > 0 && hasRunningChild) {
            victimClass = 3;
            action = 'request-reset-or-quarantine';
        }
        if (victimClass === null || action === null)
            continue;
        const liveGroupIds = new Set(view.claimRequests.filter((request) => cycle.request_ids.includes(request.request_id)).map((request) => request.acquisition_group_id));
        const groups = view.acquisitionGroups.filter((group) => coordinationOwnerKey(group.owner) === coordinationOwnerKey(attempt.owner) && liveGroupIds.has(group.acquisition_group_id) && (group.state === 'waiting' || group.state === 'grant-ready' || group.state === 'granted'));
        candidates.push({
            owner: attempt.owner,
            victim_class: victimClass,
            action,
            checkpoint_ordinal: attempt.checkpoint_ordinal,
            bypass_count: groups.reduce((maximum, group) => Math.max(maximum, group.bypass_count), 0),
            newest_grant_event_seq: groups.reduce((maximum, group) => Math.max(maximum, group.grant_event_seq ?? 0), 0),
        });
    }
    candidates.sort((left, right) => left.victim_class - right.victim_class ||
        left.checkpoint_ordinal - right.checkpoint_ordinal ||
        left.bypass_count - right.bypass_count ||
        right.newest_grant_event_seq - left.newest_grant_event_seq ||
        coordinationOwnerKey(left.owner).localeCompare(coordinationOwnerKey(right.owner)));
    return candidates[0] ?? null;
}
function hasGitCriticalSection(owner, operations) {
    return operations.some((operation) => coordinationOwnerKey(operation.owner) === coordinationOwnerKey(owner) &&
        !TERMINAL_OPERATION_STAGES.has(operation.stage) &&
        GIT_CRITICAL_OPERATIONS.has(operation.operation_type));
}
