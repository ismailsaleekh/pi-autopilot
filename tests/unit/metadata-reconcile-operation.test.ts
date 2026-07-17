import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationRun, parseCoordinationSessionLease, parseCoordinationWorktreeOperation } from '../../src/core/coordination/contracts.ts';
import { executeApprovedMetadataReconcileOperations } from '../../src/core/coordination/metadata-reconcile-operation.ts';
import { gitWorktreeRegistrationFacts } from '../../src/core/coordination/worktree-postconditions.ts';
import { currentBootId } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import type { CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { deterministicWorktreeId } from '../../src/core/coordination/worktree-identity.ts';
import type { CoordinatorRequestEnvelope } from '../../src/core/coordination/types.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

void describe('persisted metadata reconciliation operation consumer', () => {
  void it('persists exact intent before pruning, preserves refs, commits immutable evidence, and replays idempotently', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-autopilot-metadata-operation-')));
    const stateRoot = join(root, 'state');
    const repo = join(root, 'repository');
    const repoId = 'repo-metadata-operation';
    const workstreamRun = 'run-metadata-operation';
    const autopilotId = 'autopilot-metadata-operation';
    const unitId = 'unit-metadata-operation';
    const worktreeRoot = join(stateRoot, 'worktrees', repoId);
    const missingPath = join(worktreeRoot, 'active', workstreamRun, 'units', unitId, 'attempt-1', 'worktree');
    const branch = `autopilot/unit/${workstreamRun}/${unitId}/attempt-1`;
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    let server: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      await mkdir(repo, { recursive: true });
      git(repo, ['init']);
      git(repo, ['config', 'user.email', 'autopilot@example.invalid']);
      git(repo, ['config', 'user.name', 'Autopilot Test']);
      await writeFile(join(repo, 'tracked.txt'), 'metadata operation fixture\n', 'utf8');
      git(repo, ['add', 'tracked.txt']);
      git(repo, ['commit', '-m', 'metadata operation fixture']);
      const baseSha = git(repo, ['rev-parse', 'HEAD']);
      await mkdir(join(missingPath, '..'), { recursive: true });
      git(repo, ['worktree', 'add', '-b', branch, missingPath, baseSha]);
      await rm(missingPath, { recursive: true, force: false });
      const gitCommonDir = await realpath(join(repo, '.git'));
      const before = gitWorktreeRegistrationFacts(gitCommonDir);
      const target = before.find((registration) => registration.worktree_path === missingPath);
      if (target === undefined || !target.prunable || target.branch_ref !== `refs/heads/${branch}`) throw new Error('fixture did not produce one exact prunable registration');
      const approvedPaths = before.filter((registration) => registration.prunable).map((registration) => registration.worktree_path);
      assert.deepEqual(approvedPaths, [missingPath]);
      const after = before.filter((registration) => !registration.prunable);
      const branchSha = git(repo, ['rev-parse', `refs/heads/${branch}`]);
      const recoveryEvidencePath = join(root, 'recovery-evidence.json');
      const recoveryEvidenceBytes = Buffer.from(`${JSON.stringify({ source: 'operator-reviewed-retained-backup-coverage', path_missing: true, branch: `refs/heads/${branch}`, sha: branchSha })}\n`, 'utf8');
      await writeFile(recoveryEvidencePath, recoveryEvidenceBytes, { mode: 0o600 });
      const recoveryEvidenceSha256 = `sha256:${createHash('sha256').update(recoveryEvidenceBytes).digest('hex')}` as const;

      server = await startCoordinatorServer(paths);
      const client = new CoordinatorClient({ env, autoStart: false });
      const runResponse = await client.mutate('attach-run', {
        repoId, workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'metadata-operation-attach-run',
      }, {
        repo_key: repoId, canonical_root: repo, git_common_dir: gitCommonDir, autopilot_id: autopilotId, workstream: 'metadata-operation', coordination_authority: 'coordinator-edit-leases-v1',
        run_resource: {
          schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: workstreamRun, source_repo: repo, git_common_dir: gitCommonDir,
          worktree_root: worktreeRoot, main_worktree_path: join(worktreeRoot, 'active', workstreamRun, 'main'), runtime_root: join(worktreeRoot, 'active', workstreamRun, 'main', '.pi', 'autopilot', 'metadata-operation'),
          branch: `autopilot/${workstreamRun}`, target_branch: null, target_base_sha: baseSha, origin_url: null, started_at: '2026-07-16T00:00:00.000Z', version: 1,
        },
      });
      const attachedRun = parseCoordinationRun(runResponse.payload['run']);
      const sessionId = 'session-metadata-operation';
      const sessionLeaseId = 'lease-metadata-operation';
      const sessionToken = 'a'.repeat(64);
      const sessionResponse = await client.mutate('attach-session', {
        repoId, workstreamRun, sessionId, fencingGeneration: 1, expectedVersion: attachedRun.version, idempotencyKey: 'metadata-operation-attach-session',
      }, {
        boot_id: currentBootId(), handoff_token: null, lease_expires_at: '2099-01-01T00:00:00.000Z', pid: process.pid, session_lease_id: sessionLeaseId, session_token: sessionToken,
      });
      const sessionRun = parseCoordinationRun(sessionResponse.payload['run']);
      const sessionLease = parseCoordinationSessionLease(sessionResponse.payload['session']);
      await client.mutate('register-attempt', {
        repoId, workstreamRun, sessionId, fencingGeneration: 1, expectedVersion: sessionRun.version, idempotencyKey: 'metadata-operation-register-attempt',
      }, {
        unit_id: unitId, attempt: 1, spec_ref: `unit-specs/${unitId}.json`, spec_sha256: `sha256:${'b'.repeat(64)}`, role: 'fix', preemptible: true, checkpoint_ordinal: 0,
        session_lease_id: sessionLeaseId, session_token: sessionToken,
      });
      const session: CoordinatorSessionContext = {
        schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: repoId, repo_key: repoId, autopilot_id: autopilotId,
        workstream: 'metadata-operation', workstream_run: workstreamRun, session_id: sessionId, session_generation: 1, run_version: sessionRun.version,
        session_lease_id: sessionLeaseId, session_token: sessionToken, session_version: sessionLease.version, pid: process.pid, boot_id: currentBootId(),
      };
      const owner = { repo_id: repoId, autopilot_id: autopilotId, workstream_run: workstreamRun, unit_id: unitId, attempt: 1 };
      const canonicalWorktreeId = deterministicWorktreeId(owner, 'unit');
      const worktree = {
        schema_version: 'autopilot.coordination_worktree.v2' as const, worktree_id: canonicalWorktreeId, owner, kind: 'unit' as const,
        canonical_path: missingPath, git_common_dir: gitCommonDir, branch, state: 'terminal' as const, version: 1,
      };
      const approval = {
        semantic_identity: { ...owner, kind: 'unit' as const },
        worktree,
        recovery_evidence_path: recoveryEvidencePath,
        intent: {
          schema_version: 'autopilot.worktree_metadata_reconcile_intent.v1' as const,
          repo_id: repoId,
          canonical_worktree_id: canonicalWorktreeId,
          git_common_dir: gitCommonDir,
          target_registration_path: missingPath,
          approved_before_registrations: before,
          approved_prunable_registration_paths: approvedPaths,
          expected_after_registrations: after,
          preserved_refs: [{ ref: `refs/heads/${branch}`, sha: branchSha }],
          recovery_evidence_sha256: recoveryEvidenceSha256,
        },
      };

      await assert.rejects(() => executeApprovedMetadataReconcileOperations({
        client,
        session,
        worktree_root: worktreeRoot,
        approvals: [{ ...approval, worktree: { ...worktree, worktree_id: 'migration-worktree-unresolved-alias' } }],
      }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'unauthorized-client');
      const first = await executeApprovedMetadataReconcileOperations({ client, session, worktree_root: worktreeRoot, approvals: [approval] });
      assert.equal(first.operations.length, 1);
      assert.equal(first.operations[0]?.stage, 'committed');
      assert.equal(first.batch.mutation_report, 'reported');
      assert.deepEqual(gitWorktreeRegistrationFacts(gitCommonDir), after);
      assert.equal(git(repo, ['rev-parse', `refs/heads/${branch}`]), branchSha);

      const replay = await executeApprovedMetadataReconcileOperations({ client, session, worktree_root: worktreeRoot, approvals: [approval] });
      assert.equal(replay.operations[0]?.operation_id, first.operations[0]?.operation_id);
      assert.equal(replay.operations[0]?.stage, 'committed');
      assert.equal(replay.batch.mutation_report, 'already-satisfied');
      const status = await client.query('status', repoId, workstreamRun);
      const operations = status.payload['worktree_operations'];
      assert.equal(Array.isArray(operations), true);
      assert.equal((operations as readonly unknown[]).map(parseCoordinationWorktreeOperation).filter((operation) => operation.operation_type === 'metadata-reconcile').length, 1);

      await server.close();
      server = null;
      const store = await CoordinatorStore.open(paths);
      try {
        const statusRequest: CoordinatorRequestEnvelope = {
          schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.6', request_id: 'metadata-facade-status', action: 'status', idempotency_key: null,
          repo_id: repoId, workstream_run: workstreamRun, session_id: null, fencing_generation: null, expected_version: null, payload: { section: 'summary' },
        };
        const legacyStatus = store.handle(statusRequest, 'cf50-legacy');
        const negotiatedStatus = store.handle({ ...statusRequest, request_id: 'metadata-negotiated-status' }, 'negotiated-s1');
        assert.equal(JSON.stringify(legacyStatus).includes('metadata-reconcile'), false, 'anonymous cf50 status must not expose S1-only operation vocabulary');
        assert.equal(JSON.stringify(negotiatedStatus).includes('metadata-reconcile'), true, 'negotiated S1 status must retain metadata operation observability');
        const negotiatedScanToken = negotiatedStatus.payload['scan_token'];
        if (typeof negotiatedScanToken !== 'string') throw new Error('negotiated status omitted its scan token');
        const smuggledPage = store.handle({ ...statusRequest, request_id: 'metadata-facade-scan-smuggling', payload: { section: 'worktree_operations', scan_token: negotiatedScanToken } }, 'cf50-legacy');
        assert.equal(smuggledPage.ok, false);
        assert.equal(smuggledPage.error_code, 'unauthorized-client', 'scan tokens must be bound to the negotiated or legacy façade that created them');
        const legacyExportPath = join(root, 'legacy-export.json');
        const negotiatedExportPath = join(root, 'negotiated-export.json');
        const exportRequest = (requestId: string, outputPath: string): CoordinatorRequestEnvelope => ({
          schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.6', request_id: requestId, action: 'export', idempotency_key: null,
          repo_id: repoId, workstream_run: workstreamRun, session_id: null, fencing_generation: null, expected_version: null, payload: { output_path: outputPath },
        });
        assert.equal(store.handle(exportRequest('metadata-legacy-export', legacyExportPath), 'cf50-legacy').ok, true);
        assert.equal(store.handle(exportRequest('metadata-negotiated-export', negotiatedExportPath), 'negotiated-s1').ok, true);
        assert.equal((await readFile(legacyExportPath, 'utf8')).includes('metadata-reconcile'), false, 'anonymous cf50 export must not expose S1-only operation vocabulary');
        assert.equal((await readFile(negotiatedExportPath, 'utf8')).includes('metadata-reconcile'), true, 'negotiated S1 export must preserve exact metadata operation history');
      } finally { store.close(); }
    } finally {
      if (server !== null) await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
