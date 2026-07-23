import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalSha256 } from '../../src/core/coordination/d65-semantic-graph.ts';
import {
  computeD65SemanticSnapshotSha256,
  d65SemanticSnapshotInput,
} from '../../src/core/coordination/d65-semantic-normalizer.ts';
import {
  computeD65SemanticVersionCounts,
  d65SemanticEventWorkstreamRuns,
  type D65AcceptedEventResultJoin,
} from '../../src/core/coordination/d65-semantic-version.ts';

const RUN = { schema_version: 'autopilot.coordination_run.v2', repo_id: 'repo-1', workstream_run: 'run-1', autopilot_id: 'auto-1', workstream: 'workstream-1', status: 'running', active_session_generation: 1, coordination_authority: 'coordinator-edit-leases-v1', created_event_seq: 1, version: 2 } as const;
const SESSION = { schema_version: 'autopilot.session_lease.v2', session_lease_id: 'session-1', repo_id: 'repo-1', workstream_run: 'run-1', session_id: 'physical-1', session_generation: 1, pid: 101, boot_id: 'boot-1', lease_expires_at: '2026-07-21T00:15:00.000Z', attachment_kind: 'dispatch', status: 'attached', attached_event_seq: 2, version: 2 } as const;
const CHILD = { schema_version: 'autopilot.child_lease.v1', child_lease_id: 'child-1', owner: { repo_id: 'repo-1', autopilot_id: 'auto-1', workstream_run: 'run-1', unit_id: 'unit-1', attempt: 1 }, pid: 102, boot_id: 'boot-2', lease_expires_at: '2026-07-21T00:15:00.000Z', status: 'running', terminal_evidence: null, version: 2 } as const;

function joined(overrides: Partial<D65AcceptedEventResultJoin> = {}): D65AcceptedEventResultJoin {
  const base: D65AcceptedEventResultJoin = {
    repo_id: 'repo-1', event_seq: 3, event_type: 'session-heartbeat', entity_type: 'session-lease', entity_id: 'session-1', idempotency_key: 'heartbeat-1', request_sha256: `sha256:${'a'.repeat(64)}`,
    result: { repo_id: 'repo-1', idempotency_key: 'heartbeat-1', request_sha256: `sha256:${'a'.repeat(64)}`, committed_event_seq: 3, payload: { session: SESSION, pending_messages: 0, event_type: 'session-heartbeat', entity_type: 'session-lease', entity_id: 'session-1' } },
  };
  return { ...base, ...overrides };
}

void describe('D65 semantic-version event/result normalization', () => {
  void it('counts exact pure session and child heartbeats and program heartbeat liveness', () => {
    const child = joined({ event_seq: 4, event_type: 'child-heartbeat', entity_type: 'child-lease', entity_id: 'child-1', idempotency_key: 'child-1', request_sha256: `sha256:${'b'.repeat(64)}`, result: { repo_id: 'repo-1', idempotency_key: 'child-1', request_sha256: `sha256:${'b'.repeat(64)}`, committed_event_seq: 4, payload: { child: CHILD, preemption_requested: false, victim_key: null, event_type: 'child-heartbeat', entity_type: 'child-lease', entity_id: 'child-1' } } });
    const heartbeat = joined({ event_seq: 5, event_type: 'program-heartbeat-accepted', entity_type: 'program-heartbeat', entity_id: 'run-1', idempotency_key: 'accept-heartbeat', result: { repo_id: 'repo-1', idempotency_key: 'accept-heartbeat', request_sha256: `sha256:${'a'.repeat(64)}`, committed_event_seq: 5, payload: { schema_version: 'autopilot.program_heartbeat_acceptance_result.v1' } } });
    const counts = computeD65SemanticVersionCounts([joined(), child, heartbeat], 5);
    assert.equal(counts.sessionPureLeaseEvents.get('session-1'), 1);
    assert.equal(counts.childPureLeaseEvents.get('child-1'), 1);
    assert.equal(counts.acceptedProgramHeartbeatEvents, 1);
  });

  void it('does not classify reconciliation or preemption as pure', () => {
    const baseResult = joined().result;
    if (baseResult === null) throw new Error('semantic event fixture omitted result');
    const sessionSemantic = joined({ result: { ...baseResult, payload: { session: SESSION, pending_messages: 0, reconciliation_receipt: { id: 'changed' }, event_type: 'session-heartbeat', entity_type: 'session-lease', entity_id: 'session-1' } } });
    const childSemantic = joined({ event_seq: 4, event_type: 'child-heartbeat', entity_type: 'child-lease', entity_id: 'child-1', idempotency_key: 'child-1', result: { repo_id: 'repo-1', idempotency_key: 'child-1', request_sha256: `sha256:${'a'.repeat(64)}`, committed_event_seq: 4, payload: { child: CHILD, preemption_requested: true, victim_key: 'owner', event_type: 'child-heartbeat', entity_type: 'child-lease', entity_id: 'child-1' } } });
    const counts = computeD65SemanticVersionCounts([sessionSemantic, childSemantic], 4);
    assert.equal(counts.sessionPureLeaseEvents.size, 0);
    assert.equal(counts.childPureLeaseEvents.size, 0);
  });

  void it('fails loudly on a missing or mismatched exact idempotency join', () => {
    assert.throws(() => computeD65SemanticVersionCounts([joined({ result: null })], 3), /lacks its immutable idempotency result/u);
    const result = joined().result;
    if (result === null) throw new Error('semantic event fixture omitted result');
    assert.throws(() => computeD65SemanticVersionCounts([joined({ result: { ...result, request_sha256: `sha256:${'f'.repeat(64)}` } })], 3), /does not match repo, sequence, idempotency key, and request SHA-256 exactly/u);
  });

  void it('rejects generic result metadata contradictions before primary owner normalization', () => {
    const event = joined({ event_type: 'run-attached', entity_type: 'run', entity_id: 'run-1', result: { repo_id: 'repo-1', idempotency_key: 'heartbeat-1', request_sha256: `sha256:${'a'.repeat(64)}`, committed_event_seq: 3, payload: { run: RUN, event_type: 'session-detached', entity_type: 'session-lease', entity_id: 'forged-session' } } });
    assert.throws(() => d65SemanticEventWorkstreamRuns(event), /generic metadata disagrees/u);
  });

  void it('resolves the production primary owner instead of borrowing a related foreign run identity', () => {
    const requester = { repo_id: 'repo-1', autopilot_id: 'auto-current', workstream_run: 'run-current', unit_id: 'unit-current', attempt: 1 };
    const owner = { repo_id: 'repo-1', autopilot_id: 'auto-foreign', workstream_run: 'run-foreign', unit_id: 'unit-foreign', attempt: 1 };
    const claimRequest = {
      schema_version: 'autopilot.claim_request.v1', request_id: 'claim-1', acquisition_group_id: 'group-1', requester, owner,
      blocking_lease_ids: ['lease-1'], requested_leases: [{ path: 'src/a.ts', mode: 'WRITE', purpose: 'conflicting edit' }], reason: 'contention',
      created_event_seq: 3, status: 'deferred', owner_reason: 'not yet releasable', release_condition: null, release_event_seq: null, grant_event_seq: null, version: 2,
    };
    const event = joined({ event_type: 'claim-request-deferred', entity_type: 'claim-request', entity_id: 'claim-1', result: { repo_id: 'repo-1', idempotency_key: 'heartbeat-1', request_sha256: `sha256:${'a'.repeat(64)}`, committed_event_seq: 3, payload: { claim_request: claimRequest, event_type: 'claim-request-deferred', entity_type: 'claim-request', entity_id: 'claim-1' } } });
    assert.deepEqual(d65SemanticEventWorkstreamRuns(event), ['run-foreign']);
  });
});

void describe('D65 endpoint semantic snapshot normalizer', () => {
  void it('retains endpoint schema_version and final negotiated observability fields', () => {
    const status = { schema_version: 'autopilot.coordinator_status.v1', runs: [], negotiated_coordinator_identity: { store: 'g1' }, run_scoped_logical_faults: [], coordinator_time: '2026-07-21T00:00:00.000Z', semantic_snapshot_sha256: `sha256:${'0'.repeat(64)}`, accepted_program_heartbeat: null };
    const input = d65SemanticSnapshotInput('status', status);
    assert.equal(input['schema_version'], 'autopilot.coordinator_status.v1');
    assert.deepEqual(input['negotiated_coordinator_identity'], { store: 'g1' });
    assert.equal('coordinator_time' in input, false);
    assert.equal(computeD65SemanticSnapshotSha256('status', status), canonicalSha256({ schema_version: 'autopilot.coordinator_status.v1', runs: [], negotiated_coordinator_identity: { store: 'g1' }, run_scoped_logical_faults: [] }));
  });

  void it('rejects a partial page envelope instead of authenticating its summary projection', () => {
    const page = { schema_version: 'autopilot.coordinator_status_page.v1', projection_schema_version: 'autopilot.coordinator_status.v1', section: 'summary', scan_token: 'scan-1', observed_at: null, section_counts: { runs: 2 }, projection: { schema_version: 'autopilot.coordinator_status.v1', runs: [] }, items: [], next_cursor: null };
    assert.throws(() => computeD65SemanticSnapshotSha256('status', page), /page envelope is partial/u);
  });

  void it('doctor excludes only query observed_at in addition to common fields and remains endpoint-specific', () => {
    const doctor = { schema_version: 'autopilot.coordinator_doctor.v1', observed_at: '2026-07-21T00:00:00.000Z', healthy: true, coordinator_time: '2026-07-21T00:00:00.000Z', semantic_snapshot_sha256: `sha256:${'0'.repeat(64)}`, accepted_program_heartbeat: null };
    const later = { ...doctor, observed_at: '2026-07-21T00:00:01.000Z', coordinator_time: '2026-07-21T00:00:01.000Z' };
    assert.equal(computeD65SemanticSnapshotSha256('doctor', doctor), computeD65SemanticSnapshotSha256('doctor', later));
    assert.notEqual(computeD65SemanticSnapshotSha256('doctor', doctor), computeD65SemanticSnapshotSha256('status', { schema_version: 'autopilot.coordinator_status.v1', healthy: true }));
  });
});
