import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationRun, parseCoordinationSessionLease, parseCoordinationWorktreeOperation } from '../../src/core/coordination/contracts.ts';
import {
  executeApprovedMetadataReconcileBatch,
  type PersistedMetadataReconcileBatchEntry,
} from '../../src/core/coordination/metadata-reconcile-operation.ts';
import { currentBootId } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import type { CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { gitWorktreeRegistrationFacts } from '../../src/core/coordination/worktree-postconditions.ts';
import { deterministicWorktreeId } from '../../src/core/coordination/worktree-identity.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

const REGISTRATION_COUNT = 34;

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

void it('persists all 34 cross-run I5 approvals before one exact repository prune and replays without another effect', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-autopilot-metadata-batch-')));
  const stateRoot = join(root, 'state');
  const repository = join(root, 'repository');
  const repoId = 'repo-metadata-batch';
  const worktreeRoot = join(stateRoot, 'worktrees', repoId);
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const paths = coordinatorRuntimePaths(env);
  let server: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
  try {
    await mkdir(repository, { recursive: true });
    git(repository, ['init']);
    git(repository, ['config', 'user.email', 'autopilot@example.invalid']);
    git(repository, ['config', 'user.name', 'Autopilot Test']);
    await writeFile(join(repository, 'tracked.txt'), 'cross-run metadata reconciliation fixture\n', 'utf8');
    git(repository, ['add', 'tracked.txt']);
    git(repository, ['commit', '-m', 'cross-run metadata reconciliation fixture']);
    const baseSha = git(repository, ['rev-parse', 'HEAD']);
    const rows = Array.from({ length: REGISTRATION_COUNT }, (_entry, index) => {
      const suffix = String(index).padStart(2, '0');
      const run = `run-metadata-batch-${suffix}`;
      const unitId = `unit-metadata-batch-${suffix}`;
      return {
        run,
        unitId,
        autopilotId: `autopilot-metadata-batch-${suffix}`,
        branch: `autopilot/unit/${run}/${unitId}/attempt-1`,
        path: join(worktreeRoot, 'active', run, 'units', unitId, 'attempt-1', 'worktree'),
      };
    });
    for (const row of rows) {
      await mkdir(join(row.path, '..'), { recursive: true });
      git(repository, ['worktree', 'add', '-b', row.branch, row.path, baseSha]);
    }
    for (const row of rows) await rm(row.path, { recursive: true, force: false });
    const gitCommonDir = await realpath(join(repository, '.git'));
    const before = gitWorktreeRegistrationFacts(gitCommonDir);
    const approvedPaths = before.filter((entry) => entry.prunable).map((entry) => entry.worktree_path);
    assert.deepEqual(approvedPaths, rows.map((row) => row.path).sort());
    const after = before.filter((entry) => !entry.prunable);
    const preservedRefs = Object.freeze(rows.map((row) => ({ ref: `refs/heads/${row.branch}`, sha: git(repository, ['rev-parse', `refs/heads/${row.branch}`]) })).sort((left, right) => left.ref.localeCompare(right.ref)));

    server = await startCoordinatorServer(paths);
    const client = new CoordinatorClient({ env, autoStart: false });
    const entries: PersistedMetadataReconcileBatchEntry[] = [];
    for (const [index, row] of rows.entries()) {
      const suffix = String(index).padStart(2, '0');
      const attached = await client.mutate('attach-run', {
        repoId,
        workstreamRun: row.run,
        sessionId: null,
        fencingGeneration: null,
        expectedVersion: 0,
        idempotencyKey: `metadata-batch-attach-run-${suffix}`,
      }, {
        repo_key: repoId,
        canonical_root: repository,
        git_common_dir: gitCommonDir,
        autopilot_id: row.autopilotId,
        workstream: 'metadata-batch',
        coordination_authority: 'coordinator-edit-leases-v1',
        run_resource: {
          schema_version: 'autopilot.coordination_run_resource.v1',
          repo_id: repoId,
          workstream_run: row.run,
          source_repo: repository,
          git_common_dir: gitCommonDir,
          worktree_root: worktreeRoot,
          main_worktree_path: join(worktreeRoot, 'active', row.run, 'main'),
          runtime_root: join(worktreeRoot, 'active', row.run, 'main', '.pi', 'autopilot', 'metadata-batch'),
          branch: `autopilot/${row.run}`,
          target_branch: null,
          target_base_sha: baseSha,
          origin_url: null,
          started_at: '2026-07-16T00:00:00.000Z',
          version: 1,
        },
      });
      const attachedRun = parseCoordinationRun(attached.payload['run']);
      const sessionId = `session-metadata-batch-${suffix}`;
      const sessionLeaseId = `lease-metadata-batch-${suffix}`;
      const sessionToken = createHash('sha256').update(`metadata-batch-session-${suffix}`).digest('hex');
      const attachedSessionResponse = await client.mutate('attach-session', {
        repoId,
        workstreamRun: row.run,
        sessionId,
        fencingGeneration: 1,
        expectedVersion: attachedRun.version,
        idempotencyKey: `metadata-batch-attach-session-${suffix}`,
      }, {
        boot_id: currentBootId(),
        handoff_token: null,
        lease_expires_at: '2099-01-01T00:00:00.000Z',
        pid: process.pid,
        session_lease_id: sessionLeaseId,
        session_token: sessionToken,
      });
      const attachedSessionRun = parseCoordinationRun(attachedSessionResponse.payload['run']);
      const attachedSession = parseCoordinationSessionLease(attachedSessionResponse.payload['session']);
      await client.mutate('register-attempt', {
        repoId,
        workstreamRun: row.run,
        sessionId,
        fencingGeneration: 1,
        expectedVersion: attachedSessionRun.version,
        idempotencyKey: `metadata-batch-register-attempt-${suffix}`,
      }, {
        unit_id: row.unitId,
        attempt: 1,
        spec_ref: `unit-specs/${row.unitId}.json`,
        spec_sha256: `sha256:${createHash('sha256').update(`metadata-batch-spec-${suffix}`).digest('hex')}`,
        role: 'fix',
        preemptible: true,
        checkpoint_ordinal: 0,
        session_lease_id: sessionLeaseId,
        session_token: sessionToken,
      });
      const owner = { repo_id: repoId, autopilot_id: row.autopilotId, workstream_run: row.run, unit_id: row.unitId, attempt: 1 };
      const canonicalWorktreeId = deterministicWorktreeId(owner, 'unit');
      const recoveryEvidencePath = join(root, 'recovery-evidence', `${canonicalWorktreeId}.json`);
      const preservedBranch = preservedRefs.find((entry) => entry.ref === `refs/heads/${row.branch}`);
      if (preservedBranch === undefined) throw new Error('cross-run metadata reconciliation fixture lost a preserved branch');
      const recoveryEvidenceBytes = Buffer.from(`${JSON.stringify({ source: 'retained-backup-coverage', path_missing: true, branch: preservedBranch.ref, sha: preservedBranch.sha })}\n`, 'utf8');
      await mkdir(join(recoveryEvidencePath, '..'), { recursive: true });
      await writeFile(recoveryEvidencePath, recoveryEvidenceBytes, { mode: 0o600 });
      const recoveryEvidenceSha256 = `sha256:${createHash('sha256').update(recoveryEvidenceBytes).digest('hex')}` as const;
      const worktree = {
        schema_version: 'autopilot.coordination_worktree.v2' as const,
        worktree_id: canonicalWorktreeId,
        owner,
        kind: 'unit' as const,
        canonical_path: row.path,
        git_common_dir: gitCommonDir,
        branch: row.branch,
        state: 'terminal' as const,
        version: 1,
      };
      const session: CoordinatorSessionContext = {
        schema_version: 'autopilot.coordinator_session_context.v1',
        state_root: stateRoot,
        repo_id: repoId,
        repo_key: repoId,
        autopilot_id: row.autopilotId,
        workstream: 'metadata-batch',
        workstream_run: row.run,
        session_id: sessionId,
        session_generation: 1,
        run_version: attachedSessionRun.version,
        session_lease_id: sessionLeaseId,
        session_token: sessionToken,
        session_version: attachedSession.version,
        pid: process.pid,
        boot_id: currentBootId(),
      };
      entries.push({
        client,
        session,
        worktree_root: worktreeRoot,
        approval: {
          semantic_identity: { ...owner, kind: 'unit' as const },
          worktree,
          recovery_evidence_path: recoveryEvidencePath,
          intent: {
            schema_version: 'autopilot.worktree_metadata_reconcile_intent.v1',
            repo_id: repoId,
            canonical_worktree_id: canonicalWorktreeId,
            git_common_dir: gitCommonDir,
            target_registration_path: row.path,
            approved_before_registrations: before,
            approved_prunable_registration_paths: approvedPaths,
            expected_after_registrations: after,
            preserved_refs: preservedRefs,
            recovery_evidence_sha256: recoveryEvidenceSha256,
          },
        },
      });
    }

    const forgedEntries = entries.map((entry, index) => index === 0 ? { ...entry, worktree_root: join(root, 'foreign-evidence-root') } : entry);
    await assert.rejects(() => executeApprovedMetadataReconcileBatch({ entries: forgedEntries }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid-request');
    assert.deepEqual(gitWorktreeRegistrationFacts(gitCommonDir), before, 'forged cross-root evidence authority must fail before Git mutation');

    const first = await executeApprovedMetadataReconcileBatch({ entries });
    assert.equal(first.operations.length, REGISTRATION_COUNT);
    assert.equal(first.operations.every((operation) => operation.stage === 'committed'), true);
    assert.equal(first.batch.mutation_report, 'reported');
    assert.deepEqual(gitWorktreeRegistrationFacts(gitCommonDir), after);
    for (const preserved of preservedRefs) assert.equal(git(repository, ['rev-parse', preserved.ref]), preserved.sha);
    for (const row of rows) await assert.rejects(() => realpath(row.path), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');

    const replay = await executeApprovedMetadataReconcileBatch({ entries });
    assert.equal(replay.batch.mutation_report, 'already-satisfied');
    assert.deepEqual(replay.operations.map((operation) => operation.operation_id), first.operations.map((operation) => operation.operation_id));
    for (const entry of entries) {
      const status = await client.query('status', entry.session.repo_id, entry.session.workstream_run);
      const operations = status.payload['worktree_operations'];
      if (!Array.isArray(operations)) throw new Error('cross-run metadata reconciliation status omitted operations');
      const metadata = operations.map(parseCoordinationWorktreeOperation).filter((operation) => operation.operation_type === 'metadata-reconcile');
      assert.equal(metadata.length, 1);
      assert.equal(metadata[0]?.stage, 'committed');
    }
  } finally {
    if (server !== null) await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
