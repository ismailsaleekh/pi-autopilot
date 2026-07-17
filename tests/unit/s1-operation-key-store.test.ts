import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import type { CoordinationOwnerIdentity, CoordinationWorktree, CoordinationWorktreeOperation, CoordinatorRequestEnvelope } from '../../src/core/coordination/types.ts';
import { deterministicWorktreeId } from '../../src/core/coordination/worktree-identity.ts';
import { deriveWorktreeOperationKeyV2, operationIdFromWorktreeOperationKey } from '../../src/core/coordination/worktree-operation-identity.ts';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function envelope(id: string, input: Omit<CoordinatorRequestEnvelope, 'schema_version' | 'protocol_version' | 'request_id'>): CoordinatorRequestEnvelope {
  return { schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.6', request_id: id, ...input };
}

void describe('S1 operation-key v2 store consumer', () => {
  void it('rejects caller-selected operation identity and stores only the complete-intent canonical key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s1-operation-key-'));
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root });
    const repoId = 'repo-operation-key';
    const run = 'run-operation-key';
    const repoRoot = join(root, 'repository');
    const gitCommonDir = join(repoRoot, '.git');
    const sessionToken = createHash('sha256').update('operation-key-session', 'utf8').digest('hex');
    const store = await CoordinatorStore.open(paths);
    try {
      assert.equal(store.handle(envelope('attach-operation-run', { action: 'attach-run', idempotency_key: 'attach-operation-run', repo_id: repoId, workstream_run: run, session_id: null, fencing_generation: null, expected_version: 0, payload: { repo_key: repoId, canonical_root: repoRoot, git_common_dir: gitCommonDir, autopilot_id: 'autopilot-operation-key', workstream: 'operation-key', coordination_authority: 'coordinator-edit-leases-v1', run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: run, source_repo: repoRoot, git_common_dir: gitCommonDir, worktree_root: join(root, 'unused-resource-root'), main_worktree_path: join(root, 'unused-main'), runtime_root: join(root, 'unused-runtime'), branch: `autopilot/${run}`, target_branch: null, target_base_sha: 'a'.repeat(40), origin_url: null, started_at: '2026-07-16T02:00:00.000Z', version: 1 } } })).ok, true);
      assert.equal(store.handle(envelope('attach-operation-session', { action: 'attach-session', idempotency_key: 'attach-operation-session', repo_id: repoId, workstream_run: run, session_id: 'session-operation-key', fencing_generation: 1, expected_version: 1, payload: { session_lease_id: 'session-lease-operation-key', session_token: sessionToken, pid: process.pid, boot_id: 'boot-operation-key', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null } })).ok, true);
      const owner: CoordinationOwnerIdentity = { repo_id: repoId, autopilot_id: 'autopilot-operation-key', workstream_run: run, unit_id: 'unit-operation-key', attempt: 1 };
      const canonicalId = deterministicWorktreeId(owner, 'unit');
      const worktree: CoordinationWorktree = { schema_version: 'autopilot.coordination_worktree.v2', worktree_id: canonicalId, owner, kind: 'unit', canonical_path: join(root, 'worktrees', repoId, 'active', run, 'units', owner.unit_id, 'attempt-1', 'worktree'), git_common_dir: gitCommonDir, branch: `autopilot/unit/${run}/${owner.unit_id}/attempt-1`, state: 'planned', version: 1 };
      const intent = { repo_root: repoRoot, worktree_path: worktree.canonical_path, git_common_dir: gitCommonDir, branch: worktree.branch, reason: 'canonical operation-key store witness', base_sha: 'b'.repeat(40), target_sha: null, archive_ref: null, checkout_mode: 'full' as const, sparse_patterns: [], paths: [], metadata_refs: [] };
      const key = deriveWorktreeOperationKeyV2({ canonicalWorktreeId: canonicalId, operationType: 'create', completeImmutableIntent: intent });
      const canonicalOperationId = operationIdFromWorktreeOperationKey(key);
      const operation = (operationId: string): CoordinationWorktreeOperation => ({ schema_version: 'autopilot.worktree_operation.v2', operation_id: operationId, worktree_id: canonicalId, owner, operation_type: 'create', stage: 'prepared', authority_version: 1, intent_event_seq: 0, intent, completed_steps: [], current_step: null, recovery_attempts: 0, verification_evidence: null, error_code: null, version: 1 });
      const wrong = store.handle(envelope('prepare-wrong-operation-key', { action: 'prepare-operation', idempotency_key: 'caller-selected-key', repo_id: repoId, workstream_run: run, session_id: 'session-operation-key', fencing_generation: 1, expected_version: 0, payload: { session_lease_id: 'session-lease-operation-key', session_token: sessionToken, worktree, operation: operation('caller-selected-operation') } }));
      assert.equal(wrong.ok, false);
      assert.equal(wrong.error_code, 'invalid-request');
      const accepted = store.handle(envelope('prepare-canonical-operation-key', { action: 'prepare-operation', idempotency_key: key.operation_key_sha256, repo_id: repoId, workstream_run: run, session_id: 'session-operation-key', fencing_generation: 1, expected_version: 0, payload: { session_lease_id: 'session-lease-operation-key', session_token: sessionToken, worktree, operation: operation(canonicalOperationId) } }));
      assert.equal(accepted.ok, true, JSON.stringify(accepted.payload));
      const stored = accepted.payload['operation'];
      assert.equal(isRecord(stored) ? stored['operation_id'] : null, canonicalOperationId);
      assert.deepEqual(store.canonicalWorktreeIdentity(repoId, canonicalId), { canonical_worktree_id: canonicalId, resolution_state: 'canonical', workstream_run: run });
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });

  void it('converges exact two-client replays and refuses semantic or raw-alias rivals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s1-operation-race-'));
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root };
    const paths = coordinatorRuntimePaths(env);
    const repoId = 'repo-operation-race';
    const run = 'run-operation-race';
    const autopilotId = 'autopilot-operation-race';
    const repoRoot = join(root, 'repository');
    const gitCommonDir = join(repoRoot, '.git');
    const sessionId = 'session-operation-race';
    const sessionLeaseId = 'session-lease-operation-race';
    const sessionToken = createHash('sha256').update('operation-race-session', 'utf8').digest('hex');
    const server = await startCoordinatorServer(paths);
    try {
      const left = new CoordinatorClient({ env, autoStart: false });
      const right = new CoordinatorClient({ env, autoStart: false });
      await left.mutate('attach-run', { repoId, workstreamRun: run, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-operation-race-run' }, {
        repo_key: repoId, canonical_root: repoRoot, git_common_dir: gitCommonDir, autopilot_id: autopilotId, workstream: 'operation-race', coordination_authority: 'coordinator-edit-leases-v1',
        run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: run, source_repo: repoRoot, git_common_dir: gitCommonDir, worktree_root: join(root, 'worktrees'), main_worktree_path: join(root, 'main'), runtime_root: join(root, 'runtime'), branch: `autopilot/${run}`, target_branch: null, target_base_sha: 'a'.repeat(40), origin_url: null, started_at: '2026-07-16T03:00:00.000Z', version: 1 },
      });
      await left.mutate('attach-session', { repoId, workstreamRun: run, sessionId, fencingGeneration: 1, expectedVersion: 1, idempotencyKey: 'attach-operation-race-session' }, { session_lease_id: sessionLeaseId, session_token: sessionToken, pid: process.pid, boot_id: 'boot-operation-race', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });

      const candidate = (unitId: string, reason: string, worktreeId?: string): { readonly worktree: CoordinationWorktree; readonly operation: CoordinationWorktreeOperation; readonly key: `sha256:${string}` } => {
        const owner: CoordinationOwnerIdentity = { repo_id: repoId, autopilot_id: autopilotId, workstream_run: run, unit_id: unitId, attempt: 1 };
        const canonicalId = deterministicWorktreeId(owner, 'unit');
        const worktree: CoordinationWorktree = { schema_version: 'autopilot.coordination_worktree.v2', worktree_id: worktreeId ?? canonicalId, owner, kind: 'unit', canonical_path: join(root, 'worktrees', repoId, 'active', run, 'units', unitId, 'attempt-1', 'worktree'), git_common_dir: gitCommonDir, branch: `autopilot/unit/${run}/${unitId}/attempt-1`, state: 'planned', version: 1 };
        const intent = { repo_root: repoRoot, worktree_path: worktree.canonical_path, git_common_dir: gitCommonDir, branch: worktree.branch, reason, base_sha: 'b'.repeat(40), target_sha: null, archive_ref: null, checkout_mode: 'full' as const, sparse_patterns: [], paths: [], metadata_refs: [] };
        const operationKey = deriveWorktreeOperationKeyV2({ canonicalWorktreeId: canonicalId, operationType: 'create', completeImmutableIntent: intent });
        const operation: CoordinationWorktreeOperation = { schema_version: 'autopilot.worktree_operation.v2', operation_id: operationIdFromWorktreeOperationKey(operationKey), worktree_id: worktree.worktree_id, owner, operation_type: 'create', stage: 'prepared', authority_version: 1, intent_event_seq: 0, intent, completed_steps: [], current_step: null, recovery_attempts: 0, verification_evidence: null, error_code: null, version: 1 };
        return { worktree, operation, key: operationKey.operation_key_sha256 };
      };
      const prepare = (client: CoordinatorClient, value: ReturnType<typeof candidate>) => client.mutate('prepare-operation', { repoId, workstreamRun: run, sessionId, fencingGeneration: 1, expectedVersion: 0, idempotencyKey: value.key }, { session_lease_id: sessionLeaseId, session_token: sessionToken, worktree: value.worktree, operation: value.operation });

      const exact = candidate('unit-exact-race', 'exact two-client replay');
      const exactResponses = await Promise.all([prepare(left, exact), prepare(right, exact)]);
      assert.equal(exactResponses[0].committed_event_seq, exactResponses[1].committed_event_seq);

      const rivalLeft = candidate('unit-semantic-race', 'semantic rival left');
      const rivalRight = candidate('unit-semantic-race', 'semantic rival right');
      const rivalResults = await Promise.allSettled([prepare(left, rivalLeft), prepare(right, rivalRight)]);
      assert.equal(rivalResults.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(rivalResults.filter((result) => result.status === 'rejected').length, 1);

      const aliasLeft = candidate('unit-alias-race', 'raw alias rival', 'migration-worktree-race-left');
      const aliasRight = candidate('unit-alias-race', 'raw alias rival', 'migration-worktree-race-right');
      const aliasResults = await Promise.allSettled([prepare(left, aliasLeft), prepare(right, aliasRight)]);
      assert.equal(aliasResults.every((result) => result.status === 'rejected'), true);

      const status = await left.query('status', repoId, run);
      const worktrees = status.payload['worktrees'];
      const operations = status.payload['worktree_operations'];
      assert.equal(Array.isArray(worktrees) && worktrees.length, 2);
      assert.equal(Array.isArray(operations) && operations.length, 2);
      assert.equal(Array.isArray(worktrees) && worktrees.some((entry) => isRecord(entry) && String(entry['worktree_id']).startsWith('migration-worktree-')), false);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
