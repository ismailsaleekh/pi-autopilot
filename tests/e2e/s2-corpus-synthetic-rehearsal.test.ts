import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { DurableRunSupervisorClient } from '../../src/core/coordination/supervisor.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ActiveAutopilotRow, type AutopilotRepoIdentity, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import { buildMutableClone, writeRehearsalResult } from '../../tools/s2-corpus-rehearsal/release-gate.ts';
import { digestBytes, inventoryDigest, inventoryTree, readRegularFileNoFollow } from '../../tools/s2-corpus-rehearsal/inventory.ts';
import { assertMetadataCloneContained } from '../../tools/s2-corpus-rehearsal/path-rebase.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fileText(path: string): string {
  return Buffer.from(readRegularFileNoFollow(path, 1024 * 1024).bytes).toString('utf8');
}

void it('constructs a generic synthetic S2-D clone with no live route and rehearses every durable run', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-s2-d-synthetic-')));
  const sourceState = join(root, 'source-state');
  const sourceRepository = join(root, 'source-repository');
  const sourceMain = join(sourceState, 'worktrees', 'run-a', 'main');
  const sourceCoordinator = join(sourceState, 'coordinator');
  let sourceDatabasePath = join(sourceCoordinator, 'coordinator.db');
  const sourceCapabilityPath = join(sourceCoordinator, 'capability');
  const cloneRoot = join(root, 'clone');
  try {
    await mkdir(sourceRepository, { recursive: true });
    await mkdir(sourceMain, { recursive: true });
    await mkdir(sourceCoordinator, { recursive: true });
    git(sourceRepository, ['init']);
    git(sourceRepository, ['config', 'user.email', 's2@example.invalid']);
    git(sourceRepository, ['config', 'user.name', 'S2 Test']);
    await writeFile(join(sourceRepository, 'tracked.txt'), 's2 synthetic source\n', { encoding: 'utf8', mode: 0o600 });
    git(sourceRepository, ['add', 'tracked.txt']);
    git(sourceRepository, ['commit', '-m', 's2 synthetic source']);
    git(sourceRepository, ['remote', 'add', 'origin', `file://${sourceRepository}`]);
    const head = git(sourceRepository, ['rev-parse', 'HEAD']);
    const sourceGit = await realpath(join(sourceRepository, '.git'));
    const repo: AutopilotRepoIdentity = { repoRoot: sourceRepository, gitCommonDir: sourceGit, repoKey: 'repo-one', headSha: head, targetBranch: null, originUrl: `file://${sourceRepository}` };
    const activeRow = (runId: string): ActiveAutopilotRow => ({ schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1', autopilot_id: `autopilot-${runId}`, workstream: `workstream-${runId}`, workstream_run: runId, repo_key: repo.repoKey, source_repo: sourceRepository, git_common_dir: sourceGit, worktree_root: join(sourceState, 'worktrees'), main_worktree_path: sourceMain, branch: `autopilot/${runId}`, runtime_root: join(sourceMain, '.pi', 'autopilot', runId), target_branch: null, target_base_sha: head, origin_url: repo.originUrl, pid: process.pid, boot_id: 's2-d-synthetic', status: 'active', started_at: '2026-07-23T00:00:00.000Z', active_run_epoch: 1, active_epoch_started_at: '2026-07-23T00:00:00.000Z', active_run_receipt_id: `receipt-${runId}` });
    const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: sourceState };
    const supervisor = new DurableRunSupervisorClient(env);
    for (const active of [activeRow('run-a'), activeRow('run-b')]) {
      const attachment = await supervisor.attach({ repo, active, rawSessionId: `seed-${active.workstream_run}` });
      await supervisor.client.mutate('detach-session', { repoId: attachment.context.repo_id, workstreamRun: attachment.context.workstream_run, sessionId: attachment.session.session_id, fencingGeneration: attachment.session.session_generation, expectedVersion: attachment.session.version, idempotencyKey: `seed-detach-${active.workstream_run}` }, { reason: 'synthetic S2-D source seeding complete', session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token });
    }
    const pointer = JSON.parse(await readFile(join(sourceCoordinator, 'current-store.json'), 'utf8')) as { readonly relative_generation_path: string };
    sourceDatabasePath = join(sourceCoordinator, pointer.relative_generation_path, 'coordinator.db');
    await writeFile(join(sourceCoordinator, 'coordinator.lock'), 'live lock must not route from clone\n', { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(sourceState, 'active-autopilots.json'), `${canonicalJson([{ ...activeRow('run-a'), target_registration_path: join(sourceRepository, '.git', 'worktrees', 'run-a'), approved_prunable_registration_paths: [join(sourceRepository, '.git', 'worktrees', 'run-a-old')] }, activeRow('run-b')])}\n`, { encoding: 'utf8', mode: 0o600 });

    const sourceBefore = digestBytes(canonicalJson([inventoryDigest(await inventoryTree(sourceState)), inventoryDigest(await inventoryTree(sourceRepository))].sort()));
    const sourceCapabilityBefore = fileText(sourceCapabilityPath);
    const clone = await buildMutableClone({
      schema_version: 'autopilot.s2_d_corpus_clone_request.v1',
      rehearsal_id: 's2-d-synthetic',
      created_at: '2026-07-23T00:00:00.000Z',
      destination_root: cloneRoot,
      result_path: join(cloneRoot, 'private', 'result.json'),
      candidate_build: 'phase36-s2',
      corpora: [{ corpus_id: 'synthetic-corpus', state_root: sourceState, repository_root: sourceRepository, database_path: sourceDatabasePath, capability_path: sourceCapabilityPath, retained_snapshot_roots: [] }],
    });
    const result = await writeRehearsalResult(clone);
    const sourceAfter = digestBytes(canonicalJson([inventoryDigest(await inventoryTree(sourceState)), inventoryDigest(await inventoryTree(sourceRepository))].sort()));
    assert.equal(sourceAfter, sourceBefore);
    assert.equal(fileText(sourceCapabilityPath), sourceCapabilityBefore);

    const copyState = join(cloneRoot, 'corpora', 'synthetic-corpus', 'state');
    const copyRepository = join(cloneRoot, 'corpora', 'synthetic-corpus', 'repository');
    const copyCapability = join(copyState, 'coordinator', 'capability');
    const copyDatabase = join(copyState, relative(sourceState, sourceDatabasePath));
    assert.notEqual(fileText(copyCapability).trim(), sourceCapabilityBefore.trim());
    await assertMetadataCloneContained(copyState, cloneRoot, [copyDatabase]);
    assert.equal(git(copyRepository, ['remote']), '');
    assert.equal(result.action_results.length, 8);
    assert.deepEqual([...new Set(result.action_results.map((entry) => entry.action))].sort(), ['attach', 'dispatch-dry-run', 'doctor', 'reconcile']);
    assert.equal(clone.manifest.durable_runs.length, 2);
    assert.deepEqual([...new Set(clone.manifest.durable_runs.map((run) => run.attachment_strategy))].sort(), ['safe-attachment']);
    assert.equal(clone.manifest.durable_runs.every((run) => run.authority_version_mismatch === 'no-operation-authority-version-mismatch'), true);
    assert.equal(clone.manifest.durable_runs.every((run) => run.terminal_attempt_lease === 'no-retained-terminal-attempt-lease'), true);
    assert.equal(clone.manifest.durable_runs.every((run) => run.evidence_sha256.startsWith('sha256:')), true);
    assert.equal(clone.manifest.path_rebase_ledger.some((entry) => entry.target_kind === 'sqlite-cell'), true);
    assert.equal(clone.manifest.path_rebase_ledger.some((entry) => entry.rewrite_kind === 'remote-neutralization'), true);
    assert.equal(Object.values(clone.manifest.isolation_proofs).every((proof) => proof.passed), true);
    assert.equal(result.live_unchanged.passed, true);
    assert.equal(result.new_blockers.length, 0);

    const manifestText = await readFile(join(cloneRoot, 'private', 'manifest.json'), 'utf8');
    const resultText = await readFile(join(cloneRoot, 'private', 'result.json'), 'utf8');
    assert.equal(manifestText.includes(sourceState), false);
    assert.equal(manifestText.includes(sourceRepository), false);
    assert.equal(resultText.includes(sourceState), false);
    assert.equal(resultText.includes(sourceRepository), false);
  } finally {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await rm(root, { recursive: true, force: true }); break; }
      catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolveRetry) => setTimeout(resolveRetry, 100));
      }
    }
  }
});
