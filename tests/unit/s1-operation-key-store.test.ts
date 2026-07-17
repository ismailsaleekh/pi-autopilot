import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
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
});
