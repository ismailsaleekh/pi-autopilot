import type { CoordinationOwnerIdentity, CoordinationSnapshot } from '../../src/core/coordination/types.ts';

const digest = `sha256:${'a'.repeat(64)}` as const;

export function coordinationOwner(run: 'run-a' | 'run-b', unit: 'unit-a' | 'unit-b'): CoordinationOwnerIdentity {
  return {
    repo_id: 'repo-1',
    autopilot_id: run === 'run-a' ? 'autopilot-a' : 'autopilot-b',
    workstream_run: run,
    unit_id: unit,
    attempt: 1,
  };
}

export function validCoordinationSnapshot(): CoordinationSnapshot {
  const ownerA = coordinationOwner('run-a', 'unit-a');
  const ownerB = coordinationOwner('run-b', 'unit-b');
  return {
    schema_version: 'autopilot.coordination_snapshot.v1',
    repository_event_seq: 3,
    repositories: [{
      schema_version: 'autopilot.coordination_repository.v1',
      repo_id: 'repo-1',
      repo_key: 'repo-key-1',
      canonical_root: '/tmp/generic-repository',
      git_common_dir: '/tmp/generic-repository/.git',
      created_event_seq: 1,
      version: 1,
    }],
    runs: [
      { schema_version: 'autopilot.coordination_run.v1', repo_id: 'repo-1', autopilot_id: 'autopilot-a', workstream: 'work-a', workstream_run: 'run-a', coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 1, created_event_seq: 1, version: 1 },
      { schema_version: 'autopilot.coordination_run.v1', repo_id: 'repo-1', autopilot_id: 'autopilot-b', workstream: 'work-b', workstream_run: 'run-b', coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 1, created_event_seq: 1, version: 1 },
    ],
    session_leases: [
      { schema_version: 'autopilot.session_lease.v2', session_lease_id: 'session-lease-a', repo_id: 'repo-1', workstream_run: 'run-a', session_id: 'session-a', session_generation: 1, pid: 101, boot_id: 'boot-a', lease_expires_at: '2026-07-11T16:00:00.000Z', attachment_kind: 'dispatch', status: 'attached', attached_event_seq: 2, version: 1 },
      { schema_version: 'autopilot.session_lease.v2', session_lease_id: 'session-lease-b', repo_id: 'repo-1', workstream_run: 'run-b', session_id: 'session-b', session_generation: 1, pid: 102, boot_id: 'boot-b', lease_expires_at: '2026-07-11T16:00:00.000Z', attachment_kind: 'dispatch', status: 'attached', attached_event_seq: 2, version: 1 },
    ],
    child_leases: [{ schema_version: 'autopilot.child_lease.v1', child_lease_id: 'child-a', owner: ownerA, pid: 201, boot_id: 'boot-a', lease_expires_at: '2026-07-11T16:00:00.000Z', status: 'running', terminal_evidence: null, version: 1 }],
    unit_attempts: [
      { schema_version: 'autopilot.unit_attempt.v1', owner: ownerA, state: 'running', role: 'implement', spec: { ref: 'unit-specs/unit-a.json', sha256: digest }, preemptible: false, checkpoint_ordinal: 0, critical_section: null, version: 1 },
      { schema_version: 'autopilot.unit_attempt.v1', owner: ownerB, state: 'queued', role: 'implement', spec: { ref: 'unit-specs/unit-b.json', sha256: digest }, preemptible: true, checkpoint_ordinal: 0, critical_section: null, version: 1 },
    ],
    acquisition_groups: [
      { schema_version: 'autopilot.acquisition_group.v2', acquisition_group_id: 'group-a', owner: ownerA, acquisition_kind: 'initial', requested_leases: [{ path: 'src/shared.ts', mode: 'WRITE', purpose: 'implement shared source' }], reason: 'owner A initial acquisition', normal_release_condition: { condition_type: 'unit-merged', target_id: 'unit-a:1', evidence: null }, state: 'granted', created_event_seq: 2, fairness_event_seq: 2, grant_event_seq: 3, offer_expires_at: null, offer_count: 0, bypass_count: 0, version: 2 },
      { schema_version: 'autopilot.acquisition_group.v2', acquisition_group_id: 'group-b', owner: ownerB, acquisition_kind: 'initial', requested_leases: [{ path: 'src/shared.ts', mode: 'WRITE', purpose: 'implement peer change' }], reason: 'owner B initial acquisition', normal_release_condition: { condition_type: 'unit-merged', target_id: 'unit-b:1', evidence: null }, state: 'waiting', created_event_seq: 3, fairness_event_seq: 3, grant_event_seq: null, offer_expires_at: null, offer_count: 0, bypass_count: 0, version: 1 },
    ],
    observations: [],
    edit_leases: [{ schema_version: 'autopilot.edit_lease.v1', edit_lease_id: 'lease-a', owner: ownerA, acquisition_group_id: 'group-a', path: 'src/shared.ts', mode: 'WRITE', purpose: 'implement shared source', acquired_event_seq: 3, normal_release_condition: { condition_type: 'unit-merged', target_id: 'unit-a:1', evidence: null }, version: 1 }],
    change_reservations: [],
    reservation_obligations: [],
    run_terminal_intents: [],
    claim_requests: [{ schema_version: 'autopilot.claim_request.v1', request_id: 'request-b-a', acquisition_group_id: 'group-b', requester: ownerB, owner: ownerA, blocking_lease_ids: ['lease-a'], requested_leases: [{ path: 'src/shared.ts', mode: 'WRITE', purpose: 'implement peer change' }], reason: 'peer needs shared source', created_event_seq: 3, status: 'deferred', owner_reason: 'unit-a still running', release_condition: { condition_type: 'unit-merged', target_id: 'unit-a:1', evidence: null }, release_event_seq: null, grant_event_seq: null, version: 2 }],
    mailbox_cursors: [
      { schema_version: 'autopilot.mailbox_cursor.v1', repo_id: 'repo-1', workstream_run: 'run-a', delivered_through_event_seq: 3, acknowledged_through_event_seq: 0, version: 2 },
      { schema_version: 'autopilot.mailbox_cursor.v1', repo_id: 'repo-1', workstream_run: 'run-b', delivered_through_event_seq: 0, acknowledged_through_event_seq: 0, version: 1 },
    ],
    reconciliation_evidence: [],
    migration_recovery_work: [],
    messages: [{ schema_version: 'autopilot.coordination_message.v1', message_id: 'message-request-a', repo_id: 'repo-1', recipient_workstream_run: 'run-a', message_type: 'claim-request', correlation_id: 'request-b-a', payload: { request_id: 'request-b-a' }, status: 'delivered', created_event_seq: 3, delivered_event_seq: 3, acknowledged_event_seq: null, version: 2 }],
    worktrees: [{ schema_version: 'autopilot.coordination_worktree.v2', worktree_id: 'worktree-a', owner: ownerA, kind: 'unit', canonical_path: '/tmp/autopilot-state/run-a/unit-a', git_common_dir: '/tmp/generic-repository/.git', branch: 'autopilot/unit/run-a/unit-a/attempt-1', state: 'active', version: 1 }],
    wait_for_edges: [{ schema_version: 'autopilot.wait_for_edge.v1', edge_id: 'wait-request-b-a', repo_id: 'repo-1', request_id: 'request-b-a', requester: ownerB, blocker: ownerA, state: 'active', created_event_seq: 3, resolved_event_seq: null, version: 1 }],
    deadlock_resolutions: [],
    worktree_operations: [{
      schema_version: 'autopilot.worktree_operation.v2', operation_id: 'operation-a', worktree_id: 'worktree-a', owner: ownerA, operation_type: 'materialize', stage: 'prepared', authority_version: 1, intent_event_seq: 3,
      intent: { repo_root: '/tmp/generic-repository', worktree_path: '/tmp/autopilot-state/run-a/unit-a', git_common_dir: '/tmp/generic-repository/.git', branch: 'autopilot/unit/run-a/unit-a/attempt-1', reason: 'materialize claimed paths', base_sha: 'a'.repeat(40), target_sha: null, archive_ref: null, checkout_mode: 'claim-minimal', sparse_patterns: ['/src/shared.ts'], paths: ['src/shared.ts'], metadata_refs: [] },
      completed_steps: [], current_step: null, recovery_attempts: 0, verification_evidence: null, error_code: null, version: 1,
    }],
    authoritative_artifacts: [],
    adjudication_assignments: [],
    escalations: [],
    events: [
      { schema_version: 'autopilot.coordination_event.v1', repo_id: 'repo-1', event_seq: 1, event_type: 'repository-registered', entity_type: 'repository', entity_id: 'repo-1', idempotency_key: 'event-key-1', request_sha256: digest, occurred_at: '2026-07-11T15:00:00.000Z' },
      { schema_version: 'autopilot.coordination_event.v1', repo_id: 'repo-1', event_seq: 2, event_type: 'sessions-attached', entity_type: 'run', entity_id: 'run-a', idempotency_key: 'event-key-2', request_sha256: digest, occurred_at: '2026-07-11T15:00:01.000Z' },
      { schema_version: 'autopilot.coordination_event.v1', repo_id: 'repo-1', event_seq: 3, event_type: 'lease-granted', entity_type: 'edit-lease', entity_id: 'lease-a', idempotency_key: 'event-key-3', request_sha256: digest, occurred_at: '2026-07-11T15:00:02.000Z' },
    ],
  };
}
