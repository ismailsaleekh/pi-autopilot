import type {
  CoordinationAcquisitionGroup,
  CoordinationChildLease,
  CoordinationClaimRequest,
  CoordinationDeadlockVictimClass,
  CoordinationEditLease,
  CoordinationOwnerIdentity,
  CoordinationUnitAttempt,
  CoordinationWaitForEdge,
  CoordinationWorktree,
  CoordinationWorktreeOperation,
} from './types.ts';

export const MAX_GRANT_BYPASSES = 8;

const TERMINAL_REQUEST_STATES = new Set(['resolved', 'cancelled', 'superseded']);
const TERMINAL_OPERATION_STAGES = new Set(['committed', 'compensated', 'failed']);
const GIT_CRITICAL_OPERATIONS = new Set(['merge', 'reset', 'quarantine', 'archive', 'remove']);

export interface CoordinationWaitCycle {
  readonly cycle_id: string;
  readonly participant_keys: readonly string[];
  readonly edge_ids: readonly string[];
  readonly request_ids: readonly string[];
}

export interface CoordinationDeadlockVictim {
  readonly owner: CoordinationOwnerIdentity;
  readonly victim_class: CoordinationDeadlockVictimClass;
  readonly action: 'cancel-and-supersede' | 'request-reset-or-quarantine';
  readonly checkpoint_ordinal: number;
  readonly bypass_count: number;
  readonly newest_grant_event_seq: number;
}

export interface CoordinationDeadlockStateView {
  readonly attempts: readonly CoordinationUnitAttempt[];
  readonly acquisitionGroups: readonly CoordinationAcquisitionGroup[];
  readonly claimRequests: readonly CoordinationClaimRequest[];
  readonly childLeases: readonly CoordinationChildLease[];
  readonly worktrees: readonly CoordinationWorktree[];
  readonly worktreeOperations: readonly CoordinationWorktreeOperation[];
}

export function compareCoordinationGrantPriority(left: CoordinationAcquisitionGroup, right: CoordinationAcquisitionGroup): number {
  const leftStarved = left.bypass_count >= MAX_GRANT_BYPASSES ? 0 : 1;
  const rightStarved = right.bypass_count >= MAX_GRANT_BYPASSES ? 0 : 1;
  return leftStarved - rightStarved || left.offer_count - right.offer_count || left.created_event_seq - right.created_event_seq || left.acquisition_group_id.localeCompare(right.acquisition_group_id);
}

export function coordinationOwnerKey(owner: CoordinationOwnerIdentity): string {
  return `${owner.repo_id}\0${owner.autopilot_id}\0${owner.workstream_run}\0${owner.unit_id}\0${String(owner.attempt)}`;
}

export function buildCoordinationWaitForEdges(input: {
  readonly requests: readonly CoordinationClaimRequest[];
  readonly editLeases: readonly CoordinationEditLease[];
  readonly priorEdges?: readonly CoordinationWaitForEdge[];
  readonly eventSeq: number;
}): readonly CoordinationWaitForEdge[] {
  const priorByRequest = new Map((input.priorEdges ?? []).map((edge) => [edge.request_id, edge]));
  const leases = new Map(input.editLeases.map((lease) => [lease.edit_lease_id, lease]));
  const activeRequestIds = new Set<string>();
  const edges: CoordinationWaitForEdge[] = [];
  for (const request of [...input.requests].sort((left, right) => left.created_event_seq - right.created_event_seq || left.request_id.localeCompare(right.request_id))) {
    const hasBlocker = request.blocking_lease_ids.some((leaseId) => leases.has(leaseId));
    if (TERMINAL_REQUEST_STATES.has(request.status) || !hasBlocker) continue;
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
    if (activeRequestIds.has(prior.request_id)) continue;
    edges.push(prior.state === 'resolved' ? prior : {
      ...prior,
      state: 'resolved',
      resolved_event_seq: input.eventSeq,
      version: prior.version + 1,
    });
  }
  return Object.freeze(edges.sort((left, right) => left.edge_id.localeCompare(right.edge_id)));
}

export function detectCoordinationWaitCycles(edges: readonly CoordinationWaitForEdge[]): readonly CoordinationWaitCycle[] {
  const active = edges.filter((edge) => edge.state === 'active');
  const adjacency = new Map<string, Set<string>>();
  for (const edge of active) {
    const from = coordinationOwnerKey(edge.requester);
    const to = coordinationOwnerKey(edge.blocker);
    const targets = adjacency.get(from) ?? new Set<string>();
    targets.add(to);
    adjacency.set(from, targets);
    if (!adjacency.has(to)) adjacency.set(to, new Set<string>());
  }

  let index = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (node: string): void => {
    indexes.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of [...(adjacency.get(node) ?? [])].sort()) {
      if (!indexes.has(target)) {
        visit(target);
        const nodeLow = lowLinks.get(node);
        const targetLow = lowLinks.get(target);
        if (nodeLow !== undefined && targetLow !== undefined) lowLinks.set(node, Math.min(nodeLow, targetLow));
      } else if (onStack.has(target)) {
        const nodeLow = lowLinks.get(node);
        const targetIndex = indexes.get(target);
        if (nodeLow !== undefined && targetIndex !== undefined) lowLinks.set(node, Math.min(nodeLow, targetIndex));
      }
    }
    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort());
  };

  for (const node of [...adjacency.keys()].sort()) if (!indexes.has(node)) visit(node);
  const cycles: CoordinationWaitCycle[] = [];
  for (const component of components) {
    const participants = new Set(component);
    const componentEdges = active.filter((edge) => participants.has(coordinationOwnerKey(edge.requester)) && participants.has(coordinationOwnerKey(edge.blocker)));
    const selfCycle = component.length === 1 && componentEdges.some((edge) => coordinationOwnerKey(edge.requester) === coordinationOwnerKey(edge.blocker));
    if (component.length < 2 && !selfCycle) continue;
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

export function selectCoordinationDeadlockVictim(cycle: CoordinationWaitCycle, view: CoordinationDeadlockStateView): CoordinationDeadlockVictim | null {
  const attempts = view.attempts.filter((attempt) => cycle.participant_keys.includes(coordinationOwnerKey(attempt.owner)));
  const candidates: CoordinationDeadlockVictim[] = [];
  for (const attempt of attempts) {
    if (attempt.critical_section !== null || hasGitCriticalSection(attempt.owner, view.worktreeOperations)) continue;
    const children = view.childLeases.filter((child) => coordinationOwnerKey(child.owner) === coordinationOwnerKey(attempt.owner));
    const hasRunningChild = children.some((child) => child.status === 'running');
    const recoveryChild = children.some((child) => child.status === 'recovery-required');
    const hasUnitWorktree = view.worktrees.some((worktree) => worktree.kind === 'unit' && coordinationOwnerKey(worktree.owner) === coordinationOwnerKey(attempt.owner) && worktree.state !== 'removed');
    let victimClass: CoordinationDeadlockVictimClass | null = null;
    let action: CoordinationDeadlockVictim['action'] | null = null;
    if (recoveryChild || attempt.state === 'failed') {
      victimClass = 1;
      action = 'request-reset-or-quarantine';
    } else if ((attempt.state === 'queued' || attempt.state === 'preflight') && !hasRunningChild && !hasUnitWorktree) {
      victimClass = 2;
      action = 'cancel-and-supersede';
    } else if (attempt.state === 'running' && attempt.preemptible && attempt.checkpoint_ordinal > 0 && hasRunningChild) {
      victimClass = 3;
      action = 'request-reset-or-quarantine';
    }
    if (victimClass === null || action === null) continue;
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
  candidates.sort((left, right) =>
    left.victim_class - right.victim_class ||
    left.checkpoint_ordinal - right.checkpoint_ordinal ||
    left.bypass_count - right.bypass_count ||
    right.newest_grant_event_seq - left.newest_grant_event_seq ||
    coordinationOwnerKey(left.owner).localeCompare(coordinationOwnerKey(right.owner)),
  );
  return candidates[0] ?? null;
}

function hasGitCriticalSection(owner: CoordinationOwnerIdentity, operations: readonly CoordinationWorktreeOperation[]): boolean {
  return operations.some((operation) =>
    coordinationOwnerKey(operation.owner) === coordinationOwnerKey(owner) &&
    !TERMINAL_OPERATION_STAGES.has(operation.stage) &&
    GIT_CRITICAL_OPERATIONS.has(operation.operation_type),
  );
}
