import { assertCoordinationInvariants } from "./invariants.js";
import { claimModesConflict, coordinationPathsOverlap } from "./contracts.js";
import { CoordinationRuntimeError } from "./failures.js";
import { AUTOPILOT_COORDINATION_SNAPSHOT_SCHEMA } from "./types.js";
export function emptyCoordinationSnapshot() {
    return {
        schema_version: AUTOPILOT_COORDINATION_SNAPSHOT_SCHEMA,
        repository_event_seq: 0,
        repositories: [],
        runs: [],
        session_leases: [],
        child_leases: [],
        unit_attempts: [],
        acquisition_groups: [],
        edit_leases: [],
        change_reservations: [],
        reservation_obligations: [],
        run_terminal_intents: [],
        claim_requests: [],
        mailbox_cursors: [],
        reconciliation_evidence: [],
        messages: [],
        worktrees: [],
        worktree_operations: [],
        escalations: [],
        events: [],
    };
}
function replayed(snapshot, input) {
    const event = snapshot.events.find((candidate) => candidate.repo_id === input.repoId && candidate.idempotency_key === input.idempotencyKey);
    if (event === undefined)
        return false;
    if (event.request_sha256 !== input.requestHash)
        throw new CoordinationRuntimeError('idempotency-conflict', 'idempotency key was reused with a different request hash');
    return true;
}
function nextEvent(snapshot, input, eventType, entityType, entityId) {
    const sequence = snapshot.repository_event_seq + 1;
    return {
        sequence,
        event: {
            schema_version: 'autopilot.coordination_event.v1',
            repo_id: input.repoId,
            event_seq: sequence,
            event_type: eventType,
            entity_type: entityType,
            entity_id: entityId,
            idempotency_key: input.idempotencyKey,
            request_sha256: input.requestHash,
            occurred_at: input.occurredAt,
        },
    };
}
function currentRun(snapshot, input) {
    const run = snapshot.runs.find((candidate) => candidate.repo_id === input.repoId && candidate.workstream_run === input.workstreamRun);
    if (run === undefined)
        throw new CoordinationRuntimeError('invalid-request', `run ${input.workstreamRun} does not exist`);
    return run;
}
function assertCurrentSession(snapshot, input) {
    const run = currentRun(snapshot, input);
    if (run.active_session_generation !== input.fencingGeneration)
        throw new CoordinationRuntimeError('fenced-session', 'session generation is no longer current');
    const attached = snapshot.session_leases.find((session) => session.repo_id === input.repoId && session.workstream_run === input.workstreamRun && session.session_id === input.sessionId && session.session_generation === input.fencingGeneration && session.status === 'attached');
    if (attached === undefined)
        throw new CoordinationRuntimeError('fenced-session', 'session is not the attached current generation');
}
export function attachCoordinationSession(snapshot, input) {
    assertCoordinationInvariants(snapshot);
    if (replayed(snapshot, input))
        return snapshot;
    const run = currentRun(snapshot, input);
    const nextGeneration = run.active_session_generation + 1;
    if (input.fencingGeneration !== nextGeneration)
        throw new CoordinationRuntimeError('stale-version', `next session generation must be ${String(nextGeneration)}`);
    const event = nextEvent(snapshot, input, 'session-attached', 'session-lease', input.sessionLeaseId);
    const fenced = snapshot.session_leases.map((session) => session.repo_id === input.repoId && session.workstream_run === input.workstreamRun && session.status === 'attached'
        ? { ...session, status: 'fenced', version: session.version + 1 }
        : session);
    const lease = {
        schema_version: 'autopilot.session_lease.v1',
        session_lease_id: input.sessionLeaseId,
        repo_id: input.repoId,
        workstream_run: input.workstreamRun,
        session_id: input.sessionId,
        session_generation: input.fencingGeneration,
        pid: input.pid,
        boot_id: input.bootId,
        lease_expires_at: input.leaseExpiresAt,
        status: 'attached',
        attached_event_seq: event.sequence,
        version: 1,
    };
    const next = {
        ...snapshot,
        repository_event_seq: event.sequence,
        runs: snapshot.runs.map((candidate) => candidate.repo_id === input.repoId && candidate.workstream_run === input.workstreamRun ? { ...candidate, active_session_generation: input.fencingGeneration, version: candidate.version + 1 } : candidate),
        session_leases: [...fenced, lease],
        events: [...snapshot.events, event.event],
    };
    assertCoordinationInvariants(next);
    return next;
}
export function grantCoordinationAcquisitionGroup(snapshot, input) {
    assertCoordinationInvariants(snapshot);
    if (replayed(snapshot, input))
        return snapshot;
    assertCurrentSession(snapshot, input);
    const group = snapshot.acquisition_groups.find((candidate) => candidate.acquisition_group_id === input.acquisitionGroupId);
    if (group === undefined)
        throw new CoordinationRuntimeError('invalid-request', `acquisition group ${input.acquisitionGroupId} does not exist`);
    if (group.owner.repo_id !== input.repoId || group.owner.workstream_run !== input.workstreamRun)
        throw new CoordinationRuntimeError('unauthorized-client', 'session does not own acquisition group');
    if (group.state !== 'waiting' && group.state !== 'grant-ready')
        throw new CoordinationRuntimeError('invalid-state', `acquisition group is ${group.state}`);
    const blockers = group.requested_leases.flatMap((requested) => snapshot.edit_leases.filter((active) => active.owner.repo_id === input.repoId && coordinationPathsOverlap(active.path, requested.path) && claimModesConflict(active.mode, requested.mode)));
    if (blockers.length > 0)
        throw new CoordinationRuntimeError('coordinator-contention', 'complete acquisition group is blocked', blockers.map((lease) => lease.edit_lease_id));
    const event = nextEvent(snapshot, input, 'acquisition-group-granted', 'acquisition-group', group.acquisition_group_id);
    const leases = group.requested_leases.map((requested, index) => ({
        schema_version: 'autopilot.edit_lease.v1',
        edit_lease_id: `${group.acquisition_group_id}:lease:${String(index + 1)}`,
        owner: group.owner,
        acquisition_group_id: group.acquisition_group_id,
        path: requested.path,
        mode: requested.mode,
        purpose: requested.purpose,
        acquired_event_seq: event.sequence,
        normal_release_condition: input.normalReleaseCondition,
        version: 1,
    }));
    const grantedGroup = { ...group, state: 'granted', grant_event_seq: event.sequence, offer_expires_at: null, version: group.version + 1 };
    const next = {
        ...snapshot,
        repository_event_seq: event.sequence,
        acquisition_groups: snapshot.acquisition_groups.map((candidate) => candidate.acquisition_group_id === group.acquisition_group_id ? grantedGroup : candidate),
        edit_leases: [...snapshot.edit_leases, ...leases],
        events: [...snapshot.events, event.event],
    };
    assertCoordinationInvariants(next);
    return next;
}
export function releaseCoordinationLeaseAndNotify(snapshot, input) {
    assertCoordinationInvariants(snapshot);
    if (replayed(snapshot, input))
        return snapshot;
    assertCurrentSession(snapshot, input);
    const lease = snapshot.edit_leases.find((candidate) => candidate.edit_lease_id === input.editLeaseId);
    if (lease === undefined)
        throw new CoordinationRuntimeError('invalid-request', `edit lease ${input.editLeaseId} does not exist`);
    if (lease.owner.repo_id !== input.repoId || lease.owner.workstream_run !== input.workstreamRun)
        throw new CoordinationRuntimeError('unauthorized-client', 'session does not own edit lease');
    const request = snapshot.claim_requests.find((candidate) => candidate.request_id === input.requestId && candidate.blocking_lease_ids.includes(input.editLeaseId));
    if (request === undefined)
        throw new CoordinationRuntimeError('invalid-request', `claim request ${input.requestId} does not reference the lease`);
    const event = nextEvent(snapshot, input, 'lease-released-and-requester-notified', 'claim-request', request.request_id);
    const notification = {
        schema_version: 'autopilot.coordination_message.v1',
        message_id: input.messageId,
        repo_id: input.repoId,
        recipient_workstream_run: request.requester.workstream_run,
        message_type: 'release-notification',
        correlation_id: request.request_id,
        payload: { request_id: request.request_id, released_lease_id: lease.edit_lease_id },
        status: 'pending',
        created_event_seq: event.sequence,
        delivered_event_seq: null,
        acknowledged_event_seq: null,
        version: 1,
    };
    const remainingGroupLeases = snapshot.edit_leases.filter((candidate) => candidate.acquisition_group_id === lease.acquisition_group_id && candidate.edit_lease_id !== lease.edit_lease_id);
    const next = {
        ...snapshot,
        repository_event_seq: event.sequence,
        edit_leases: snapshot.edit_leases.filter((candidate) => candidate.edit_lease_id !== lease.edit_lease_id),
        acquisition_groups: snapshot.acquisition_groups.map((group) => group.acquisition_group_id === lease.acquisition_group_id && remainingGroupLeases.length === 0 ? { ...group, state: 'released', version: group.version + 1 } : group),
        claim_requests: snapshot.claim_requests.map((candidate) => candidate.request_id === request.request_id ? { ...candidate, status: 'released', release_event_seq: event.sequence, version: candidate.version + 1 } : candidate),
        messages: [...snapshot.messages, notification],
        events: [...snapshot.events, event.event],
    };
    assertCoordinationInvariants(next);
    return next;
}
