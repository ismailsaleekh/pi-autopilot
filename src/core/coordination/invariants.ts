import { claimModesConflict, coordinationPathsOverlap } from './contracts.ts';
import { CoordinationRuntimeError } from './failures.ts';
import type { CoordinationOwnerIdentity, CoordinationSnapshot } from './types.ts';

export type CoordinationInvariantSeverity = 'error' | 'warning';

export interface CoordinationInvariantFinding {
  readonly code: string;
  readonly severity: CoordinationInvariantSeverity;
  readonly entity: string;
  readonly detail: string;
}

const TERMINAL_REQUEST_STATES = new Set(['resolved', 'cancelled', 'superseded']);
const LIVE_RUN_STATES = new Set(['active', 'paused', 'merging', 'blocked', 'recovering']);

function ownerKey(owner: CoordinationOwnerIdentity): string {
  return `${owner.repo_id}\0${owner.autopilot_id}\0${owner.workstream_run}\0${owner.unit_id}\0${String(owner.attempt)}`;
}

function runKey(repoId: string, workstreamRun: string): string {
  return `${repoId}\0${workstreamRun}`;
}

function finding(code: string, entity: string, detail: string, severity: CoordinationInvariantSeverity = 'error'): CoordinationInvariantFinding {
  return { code, severity, entity, detail };
}

function duplicateFindings(values: readonly string[], code: string, entity: string): CoordinationInvariantFinding[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .filter((entry) => entry[1] > 1)
    .map((entry) => finding(code, entity, `duplicate identity ${entry[0]}`));
}

export function checkCoordinationInvariants(snapshot: CoordinationSnapshot): readonly CoordinationInvariantFinding[] {
  const findings: CoordinationInvariantFinding[] = [];
  const repositoryIds = new Set(snapshot.repositories.map((repository) => repository.repo_id));
  const runs = new Map(snapshot.runs.map((run) => [runKey(run.repo_id, run.workstream_run), run]));
  const attempts = new Map(snapshot.unit_attempts.map((attempt) => [ownerKey(attempt.owner), attempt]));
  const groups = new Map(snapshot.acquisition_groups.map((group) => [group.acquisition_group_id, group]));
  const worktrees = new Map(snapshot.worktrees.map((worktree) => [worktree.worktree_id, worktree]));

  findings.push(...duplicateFindings(snapshot.repositories.map((value) => value.repo_id), 'duplicate-repository', 'repositories'));
  findings.push(...duplicateFindings(snapshot.runs.map((value) => runKey(value.repo_id, value.workstream_run)), 'duplicate-run', 'runs'));
  findings.push(...duplicateFindings(snapshot.session_leases.map((value) => value.session_lease_id), 'duplicate-session-lease', 'session_leases'));
  findings.push(...duplicateFindings(snapshot.child_leases.map((value) => value.child_lease_id), 'duplicate-child-lease', 'child_leases'));
  findings.push(...duplicateFindings(snapshot.unit_attempts.map((value) => ownerKey(value.owner)), 'duplicate-unit-attempt', 'unit_attempts'));
  findings.push(...duplicateFindings(snapshot.acquisition_groups.map((value) => value.acquisition_group_id), 'duplicate-acquisition-group', 'acquisition_groups'));
  findings.push(...duplicateFindings(snapshot.edit_leases.map((value) => value.edit_lease_id), 'duplicate-edit-lease', 'edit_leases'));
  findings.push(...duplicateFindings(snapshot.change_reservations.map((value) => value.reservation_id), 'duplicate-reservation', 'change_reservations'));
  findings.push(...duplicateFindings(snapshot.claim_requests.map((value) => value.request_id), 'duplicate-claim-request', 'claim_requests'));
  findings.push(...duplicateFindings(snapshot.messages.map((value) => value.message_id), 'duplicate-message', 'messages'));
  findings.push(...duplicateFindings(snapshot.worktrees.map((value) => value.worktree_id), 'duplicate-worktree', 'worktrees'));
  findings.push(...duplicateFindings(snapshot.worktree_operations.map((value) => value.operation_id), 'duplicate-operation', 'worktree_operations'));
  findings.push(...duplicateFindings(snapshot.escalations.map((value) => value.escalation_id), 'duplicate-escalation', 'escalations'));
  findings.push(...duplicateFindings(snapshot.events.map((value) => `${value.repo_id}\0${String(value.event_seq)}`), 'duplicate-event-sequence', 'events'));
  findings.push(...duplicateFindings(snapshot.events.map((value) => `${value.repo_id}\0${value.idempotency_key}`), 'duplicate-idempotency-key', 'events'));

  for (const run of snapshot.runs) {
    if (!repositoryIds.has(run.repo_id)) findings.push(finding('run-repository-missing', run.workstream_run, `repository ${run.repo_id} does not exist`));
  }

  for (const session of snapshot.session_leases) {
    const run = runs.get(runKey(session.repo_id, session.workstream_run));
    if (run === undefined) {
      findings.push(finding('session-run-missing', session.session_lease_id, 'owning run does not exist'));
      continue;
    }
    if (session.status === 'attached' && session.session_generation !== run.active_session_generation) {
      findings.push(finding('attached-session-generation-mismatch', session.session_lease_id, `attached generation ${String(session.session_generation)} differs from run generation ${String(run.active_session_generation)}`));
    }
  }
  for (const run of snapshot.runs) {
    const attached = snapshot.session_leases.filter((session) => session.repo_id === run.repo_id && session.workstream_run === run.workstream_run && session.status === 'attached');
    if (attached.length > 1) findings.push(finding('multiple-attached-sessions', run.workstream_run, `${String(attached.length)} sessions are attached`));
  }

  const assertOwner = (owner: CoordinationOwnerIdentity, entity: string): void => {
    const run = runs.get(runKey(owner.repo_id, owner.workstream_run));
    if (run === undefined) {
      findings.push(finding('owner-run-missing', entity, `run ${owner.workstream_run} does not exist`));
      return;
    }
    if (run.autopilot_id !== owner.autopilot_id) findings.push(finding('owner-autopilot-mismatch', entity, `owner ${owner.autopilot_id} differs from run owner ${run.autopilot_id}`));
  };

  for (const attempt of snapshot.unit_attempts) assertOwner(attempt.owner, ownerKey(attempt.owner));
  for (const child of snapshot.child_leases) {
    assertOwner(child.owner, child.child_lease_id);
    if (!attempts.has(ownerKey(child.owner))) findings.push(finding('child-attempt-missing', child.child_lease_id, 'owning unit attempt does not exist'));
    if (child.status === 'terminal' && child.terminal_evidence === null) findings.push(finding('terminal-child-evidence-missing', child.child_lease_id, 'terminal child requires immutable evidence'));
  }
  for (const group of snapshot.acquisition_groups) {
    assertOwner(group.owner, group.acquisition_group_id);
    if (!attempts.has(ownerKey(group.owner))) findings.push(finding('group-attempt-missing', group.acquisition_group_id, 'owning unit attempt does not exist'));
    const leases = snapshot.edit_leases.filter((lease) => lease.acquisition_group_id === group.acquisition_group_id);
    if (group.state === 'waiting' || group.state === 'grant-ready' || group.state === 'released' || group.state === 'cancelled' || group.state === 'superseded') {
      if (leases.length > 0) findings.push(finding('ungranted-group-holds-leases', group.acquisition_group_id, `${group.state} group holds ${String(leases.length)} active leases`));
    }
    if (group.state === 'granted') {
      const requested = new Set(group.requested_leases.map((lease) => `${lease.mode}\0${lease.path}`));
      const unexpected = leases.filter((lease) => !requested.has(`${lease.mode}\0${lease.path}`));
      if (unexpected.length > 0) findings.push(finding('acquisition-group-unrequested-lease', group.acquisition_group_id, 'active lease set contains authority outside the requested set'));
      if (group.grant_event_seq === null) findings.push(finding('granted-group-event-missing', group.acquisition_group_id, 'granted group requires grant_event_seq'));
    }
  }

  for (const lease of snapshot.edit_leases) {
    assertOwner(lease.owner, lease.edit_lease_id);
    const group = groups.get(lease.acquisition_group_id);
    if (group === undefined) findings.push(finding('lease-group-missing', lease.edit_lease_id, 'acquisition group does not exist'));
    else if (ownerKey(group.owner) !== ownerKey(lease.owner)) findings.push(finding('lease-group-owner-mismatch', lease.edit_lease_id, 'lease and acquisition group have different owners'));
  }
  for (let leftIndex = 0; leftIndex < snapshot.edit_leases.length; leftIndex += 1) {
    const left = snapshot.edit_leases[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < snapshot.edit_leases.length; rightIndex += 1) {
      const right = snapshot.edit_leases[rightIndex];
      if (right === undefined || left.owner.repo_id !== right.owner.repo_id) continue;
      if (coordinationPathsOverlap(left.path, right.path) && claimModesConflict(left.mode, right.mode)) {
        findings.push(finding('incompatible-active-edit-leases', `${left.edit_lease_id},${right.edit_lease_id}`, `${left.mode} ${left.path} overlaps ${right.mode} ${right.path}`));
      }
    }
  }

  for (const reservation of snapshot.change_reservations) {
    const run = runs.get(runKey(reservation.repo_id, reservation.workstream_run));
    if (run === undefined) findings.push(finding('reservation-run-missing', reservation.reservation_id, 'owning run does not exist'));
    else if (run.autopilot_id !== reservation.autopilot_id) findings.push(finding('reservation-owner-mismatch', reservation.reservation_id, 'reservation owner differs from run owner'));
  }

  for (const request of snapshot.claim_requests) {
    assertOwner(request.requester, request.request_id);
    assertOwner(request.owner, request.request_id);
    if (!groups.has(request.acquisition_group_id)) findings.push(finding('request-group-missing', request.request_id, 'request acquisition group does not exist'));
    for (const leaseId of request.blocking_lease_ids) {
      const lease = snapshot.edit_leases.find((candidate) => candidate.edit_lease_id === leaseId);
      if (lease === undefined) {
        if (!TERMINAL_REQUEST_STATES.has(request.status) && request.status !== 'released' && request.status !== 'requester-notified') findings.push(finding('request-blocking-lease-missing', request.request_id, `blocking lease ${leaseId} is absent before release evidence`));
      } else if (ownerKey(lease.owner) !== ownerKey(request.owner)) {
        findings.push(finding('request-addressed-to-wrong-owner', request.request_id, `blocking lease ${leaseId} has a different owner`));
      }
    }
    if (request.status === 'deferred' && (request.owner_reason === null || request.release_condition === null)) findings.push(finding('deferred-request-promise-incomplete', request.request_id, 'deferred request requires owner_reason and typed release_condition'));
    if ((request.status === 'released' || request.status === 'grant-ready' || request.status === 'granted' || request.status === 'requester-notified' || request.status === 'resolved') && request.release_event_seq === null) findings.push(finding('released-request-event-missing', request.request_id, `${request.status} request requires release_event_seq`));
    if ((request.status === 'granted' || request.status === 'requester-notified' || request.status === 'resolved') && request.grant_event_seq === null) findings.push(finding('granted-request-event-missing', request.request_id, `${request.status} request requires grant_event_seq`));
    if (!TERMINAL_REQUEST_STATES.has(request.status) && request.status !== 'deferred' && request.status !== 'contradiction-review') {
      const run = runs.get(runKey(request.requester.repo_id, request.requester.workstream_run));
      if (run !== undefined && !LIVE_RUN_STATES.has(run.status)) findings.push(finding('nonterminal-request-on-terminal-run', request.request_id, `requester run is ${run.status}`));
    }
    if (request.release_event_seq !== null) {
      const notification = snapshot.messages.find((message) => message.message_type === 'release-notification' && message.correlation_id === request.request_id && message.created_event_seq === request.release_event_seq);
      if (notification === undefined) findings.push(finding('release-notification-not-atomic', request.request_id, 'release event lacks a same-sequence requester notification'));
    }
  }

  for (const message of snapshot.messages) {
    if (!runs.has(runKey(message.repo_id, message.recipient_workstream_run))) findings.push(finding('message-recipient-run-missing', message.message_id, 'recipient run does not exist'));
    if (message.status === 'delivered' && message.delivered_event_seq === null) findings.push(finding('delivered-message-event-missing', message.message_id, 'delivered message requires delivered_event_seq'));
    if (message.status === 'acknowledged' && (message.delivered_event_seq === null || message.acknowledged_event_seq === null)) findings.push(finding('acknowledged-message-events-missing', message.message_id, 'acknowledged message requires delivery and acknowledgement events'));
  }

  for (const worktree of snapshot.worktrees) assertOwner(worktree.owner, worktree.worktree_id);
  for (const operation of snapshot.worktree_operations) {
    assertOwner(operation.owner, operation.operation_id);
    const worktree = worktrees.get(operation.worktree_id);
    if (worktree === undefined) findings.push(finding('operation-worktree-missing', operation.operation_id, 'worktree does not exist'));
    else if (ownerKey(worktree.owner) !== ownerKey(operation.owner)) findings.push(finding('foreign-worktree-operation', operation.operation_id, 'operation owner differs from worktree owner'));
    if ((operation.stage === 'verified' || operation.stage === 'committed') && operation.verification_evidence === null) findings.push(finding('operation-verification-missing', operation.operation_id, `${operation.stage} operation requires verification evidence`));
    if (operation.operation_type === 'remove' && operation.stage === 'committed' && worktree?.state === 'dirty') findings.push(finding('dirty-worktree-removed', operation.operation_id, 'dirty worktree cannot be removed without quarantine capture'));
  }

  for (const escalation of snapshot.escalations) {
    if (!repositoryIds.has(escalation.repo_id)) findings.push(finding('escalation-repository-missing', escalation.escalation_id, 'repository does not exist'));
    for (const participatingRun of escalation.participating_runs) {
      if (!runs.has(runKey(escalation.repo_id, participatingRun))) findings.push(finding('escalation-run-missing', escalation.escalation_id, `participating run ${participatingRun} does not exist`));
    }
  }

  const eventsByRepo = new Map<string, number[]>();
  for (const event of snapshot.events) {
    if (!repositoryIds.has(event.repo_id)) findings.push(finding('event-repository-missing', `${event.repo_id}:${String(event.event_seq)}`, 'repository does not exist'));
    const sequences = eventsByRepo.get(event.repo_id) ?? [];
    sequences.push(event.event_seq);
    eventsByRepo.set(event.repo_id, sequences);
    if (event.event_seq > snapshot.repository_event_seq) findings.push(finding('event-sequence-ahead-of-snapshot', event.entity_id, `${String(event.event_seq)} exceeds ${String(snapshot.repository_event_seq)}`));
  }
  for (const [repoId, sequences] of eventsByRepo) {
    const ordered = [...sequences].sort((left, right) => left - right);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous !== undefined && current !== undefined && current <= previous) findings.push(finding('nonmonotonic-event-sequence', repoId, `${String(previous)} then ${String(current)}`));
    }
  }

  return Object.freeze(findings);
}

export function assertCoordinationInvariants(snapshot: CoordinationSnapshot): void {
  const findings = checkCoordinationInvariants(snapshot).filter((entry) => entry.severity === 'error');
  if (findings.length > 0) {
    throw new CoordinationRuntimeError('invalid-state', 'coordination snapshot violates required invariants', findings.slice(0, 32).map((entry) => `${entry.code}: ${entry.entity}: ${entry.detail}`));
  }
}
