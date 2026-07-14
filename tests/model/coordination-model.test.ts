import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertCoordinationInvariants,
  attachCoordinationSession,
  grantCoordinationAcquisitionGroup,
  releaseCoordinationLeaseAndNotify,
  type CoordinationClaimMode,
  type CoordinationSnapshot,
  type CoordinationOperationStage,
  type CoordinationWorktreeOperation,
} from '../../src/core/coordination/index.ts';
import { exclusiveOperation, validCoordinationSnapshot } from '../helpers/coordination-fixture.ts';

const releaseCondition = { condition_type: 'unit-merged' as const, target_id: 'unit-b:1', evidence: null };
const requestHash = `sha256:${'c'.repeat(64)}` as const;

void describe('Coordination Fabric pure transition model', () => {
  void it('fences the old session while preserving run-owned authority', () => {
    const before = validCoordinationSnapshot();
    const attached = attachCoordinationSession(before, {
      repoId: 'repo-1',
      workstreamRun: 'run-a',
      sessionId: 'session-a-next',
      fencingGeneration: 2,
      idempotencyKey: 'attach-next-session',
      requestHash,
      occurredAt: '2026-07-11T15:01:00.000Z',
      sessionLeaseId: 'session-lease-a-next',
      pid: 301,
      bootId: 'boot-a-next',
      leaseExpiresAt: '2026-07-11T16:01:00.000Z',
    });
    assert.equal(attached.runs[0]?.active_session_generation, 2);
    assert.equal(attached.session_leases.find((lease) => lease.session_id === 'session-a')?.status, 'fenced');
    assert.equal(attached.edit_leases[0]?.owner.workstream_run, 'run-a');
    assert.equal(attachCoordinationSession(attached, {
      repoId: 'repo-1', workstreamRun: 'run-a', sessionId: 'session-a-next', fencingGeneration: 2, idempotencyKey: 'attach-next-session', requestHash, occurredAt: '2026-07-11T15:01:00.000Z', sessionLeaseId: 'session-lease-a-next', pid: 301, bootId: 'boot-a-next', leaseExpiresAt: '2026-07-11T16:01:00.000Z',
    }), attached);
    assert.throws(() => attachCoordinationSession(attached, {
      repoId: 'repo-1', workstreamRun: 'run-a', sessionId: 'session-a-next', fencingGeneration: 2, idempotencyKey: 'attach-next-session', requestHash: `sha256:${'d'.repeat(64)}`, occurredAt: '2026-07-11T15:01:00.000Z', sessionLeaseId: 'session-lease-a-next', pid: 301, bootId: 'boot-a-next', leaseExpiresAt: '2026-07-11T16:01:00.000Z',
    }), /idempotency-conflict/u);
    assert.throws(() => releaseCoordinationLeaseAndNotify(attached, {
      repoId: 'repo-1', workstreamRun: 'run-a', sessionId: 'session-a', fencingGeneration: 1, idempotencyKey: 'stale-release', requestHash, occurredAt: '2026-07-11T15:01:01.000Z', editLeaseId: 'lease-a', requestId: 'request-b-a', messageId: 'release-message',
    }), /fenced-session/u);
  });

  void it('holds no partial authority when a complete group is blocked', () => {
    const snapshot = validCoordinationSnapshot();
    assert.throws(() => grantCoordinationAcquisitionGroup(snapshot, {
      repoId: 'repo-1', workstreamRun: 'run-b', sessionId: 'session-b', fencingGeneration: 1, idempotencyKey: 'blocked-grant', requestHash, occurredAt: '2026-07-11T15:02:00.000Z', acquisitionGroupId: 'group-b', normalReleaseCondition: releaseCondition,
    }), /coordinator-contention/u);
    assert.equal(snapshot.edit_leases.some((lease) => lease.acquisition_group_id === 'group-b'), false);
  });

  void it('releases authority and creates requester notification in one modeled transition', () => {
    const released = releaseCoordinationLeaseAndNotify(validCoordinationSnapshot(), {
      repoId: 'repo-1', workstreamRun: 'run-a', sessionId: 'session-a', fencingGeneration: 1, idempotencyKey: 'release-lease-a', requestHash, occurredAt: '2026-07-11T15:03:00.000Z', editLeaseId: 'lease-a', requestId: 'request-b-a', messageId: 'release-message-b',
    });
    const request = released.claim_requests.find((candidate) => candidate.request_id === 'request-b-a');
    const message = released.messages.find((candidate) => candidate.message_id === 'release-message-b');
    assert.equal(request?.status, 'released');
    assert.equal(message?.created_event_seq, request?.release_event_seq);
    assert.deepEqual(released.edit_leases.map((lease) => `${lease.mode}:${lease.path}`), ['WRITE:src/shared.ts']);
    assertCoordinationInvariants(released);

    const granted = grantCoordinationAcquisitionGroup(released, {
      repoId: 'repo-1', workstreamRun: 'run-b', sessionId: 'session-b', fencingGeneration: 1, idempotencyKey: 'grant-group-b', requestHash, occurredAt: '2026-07-11T15:03:01.000Z', acquisitionGroupId: 'group-b', normalReleaseCondition: releaseCondition,
    });
    assert.equal(granted.edit_leases.filter((lease) => lease.acquisition_group_id === 'group-b').length, 1);
    assertCoordinationInvariants(granted);
  });

  void it('preserves worktree operation lifecycle invariants across generated stage and corruption cases', () => {
    let seed = 0x32facade;
    const next = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
    const stages: readonly CoordinationOperationStage[] = ['prepared', 'in-progress', 'verified', 'committed', 'reconciling', 'compensated', 'failed'];
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const stage = stages[next() % stages.length];
      if (stage === undefined) throw new Error('generated operation stage missing');
      const base = validCoordinationSnapshot();
      const original = base.worktree_operations[0];
      const originalWorktree = base.worktrees[0];
      if (original === undefined || originalWorktree === undefined) throw new Error('operation model fixture missing');
      const verified = stage === 'verified' || stage === 'committed';
      const terminalWithEvidence = verified || stage === 'compensated' || stage === 'failed';
      const operation: CoordinationWorktreeOperation = {
        ...original,
        stage,
        completed_steps: verified ? ['preflight-probe', 'external-action', 'postcondition-verification'] : stage === 'prepared' ? [] : ['preflight-probe'],
        current_step: stage === 'in-progress' || stage === 'reconciling' ? 'external-action' : null,
        verification_evidence: terminalWithEvidence ? { ref: '_saga-evidence/run-a/operation-a.json', sha256: `sha256:${'e'.repeat(64)}` } : null,
        error_code: stage === 'reconciling' ? 'git-partial-effect' : null,
      };
      const valid: CoordinationSnapshot = {
        ...base,
        worktrees: [{ ...originalWorktree, version: stage === 'committed' ? 2 : 1 }],
        worktree_operations: [operation],
      };
      assertCoordinationInvariants(valid);

      const corruption = next() % 5;
      let invalid: CoordinationSnapshot;
      if (corruption === 0) invalid = { ...valid, worktrees: [] };
      else if (corruption === 1) invalid = { ...valid, worktree_operations: [{ ...operation, intent: { ...operation.intent, worktree_path: `${operation.intent.worktree_path}-foreign` } }] };
      else if (corruption === 2) invalid = { ...valid, worktree_operations: [{ ...operation, stage: 'verified', completed_steps: ['preflight-probe'], verification_evidence: null }] };
      else if (corruption === 3) invalid = { ...valid, worktree_operations: [{ ...operation, stage: 'prepared', verification_evidence: null }, { ...operation, operation_id: `operation-duplicate-${String(iteration)}`, stage: 'reconciling', verification_evidence: null }] };
      else invalid = { ...valid, worktrees: [{ ...originalWorktree, version: 99 }] };
      assert.throws(() => assertCoordinationInvariants(invalid), /snapshot violates required invariants/u);
    }
  });

  void it('preserves grant and fencing invariants across generated contention cases', () => {
    let seed = 0x5eed1234;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    const modes: readonly CoordinationClaimMode[] = ['READ', 'WRITE', 'EXCLUSIVE'];
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const leftMode = modes[next() % modes.length];
      const rightMode = modes[next() % modes.length];
      if (leftMode === undefined || rightMode === undefined) throw new Error('generated mode missing');
      const overlap = next() % 2 === 0;
      const initial = generatedGrantSnapshot(leftMode, rightMode, overlap);
      const left = grantCoordinationAcquisitionGroup(initial, {
        repoId: 'repo-1', workstreamRun: 'run-a', sessionId: 'session-a', fencingGeneration: 1, idempotencyKey: `left-${String(iteration)}`, requestHash, occurredAt: '2026-07-11T15:04:00.000Z', acquisitionGroupId: 'group-a', normalReleaseCondition: releaseCondition,
      });
      const shouldBlock = overlap && leftMode !== 'READ' && (leftMode === 'EXCLUSIVE' || rightMode === 'EXCLUSIVE');
      if (shouldBlock) {
        assert.throws(() => grantCoordinationAcquisitionGroup(left, {
          repoId: 'repo-1', workstreamRun: 'run-b', sessionId: 'session-b', fencingGeneration: 1, idempotencyKey: `right-${String(iteration)}`, requestHash, occurredAt: '2026-07-11T15:04:01.000Z', acquisitionGroupId: 'group-b', normalReleaseCondition: releaseCondition,
        }), /coordinator-contention/u);
        assert.equal(left.edit_leases.filter((lease) => lease.acquisition_group_id === 'group-b').length, 0);
      } else {
        const both = grantCoordinationAcquisitionGroup(left, {
          repoId: 'repo-1', workstreamRun: 'run-b', sessionId: 'session-b', fencingGeneration: 1, idempotencyKey: `right-${String(iteration)}`, requestHash, occurredAt: '2026-07-11T15:04:01.000Z', acquisitionGroupId: 'group-b', normalReleaseCondition: releaseCondition,
        });
        assertCoordinationInvariants(both);
      }
      assertCoordinationInvariants(left);
    }
  });
});

function generatedGrantSnapshot(leftMode: CoordinationClaimMode, rightMode: CoordinationClaimMode, overlap: boolean): CoordinationSnapshot {
  const base = validCoordinationSnapshot();
  return {
    ...base,
    repository_event_seq: 3,
    acquisition_groups: base.acquisition_groups.map((group) => {
      const mode = group.acquisition_group_id === 'group-a' ? leftMode : rightMode;
      const path = group.acquisition_group_id === 'group-a' || overlap ? 'src/shared.ts' : 'src/independent.ts';
      const requested = mode === 'EXCLUSIVE'
        ? [{ path, mode: 'WRITE' as const, purpose: 'generated model edit layer' }, { path, mode, purpose: 'generated model check', exclusive_operation: exclusiveOperation(`model-${group.acquisition_group_id}`) }]
        : [{ path, mode, purpose: 'generated model check', ...(mode === 'READ' ? { source_identity: { base_commit: 'a'.repeat(40), object_id: 'b'.repeat(40), object_kind: 'blob' as const } } : {}) }];
      return {
      ...group,
      requested_leases: requested,
      state: 'waiting',
      grant_event_seq: null,
      version: 1,
    };
    }),
    edit_leases: [],
    claim_requests: [],
    wait_for_edges: [],
    messages: [],
  };
}
