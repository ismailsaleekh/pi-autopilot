import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { buildIsolatedStateCopy } from '../../tools/s1-corpus-rehearsal/copy-builder.ts';
import { buildCloneEnvironment } from '../../tools/s1-corpus-rehearsal/environment.ts';
import { buildIsolatedGitMirror } from '../../tools/s1-corpus-rehearsal/git-mirror.ts';
import { verifyCloneIsolation } from '../../tools/s1-corpus-rehearsal/isolation-verifier.ts';
import { inventoryTree } from '../../tools/s1-corpus-rehearsal/inventory.ts';
import { captureLiveWitness } from '../../tools/s1-corpus-rehearsal/live-witness-worker.ts';
import { rebaseCorpusPaths } from '../../tools/s1-corpus-rehearsal/path-rebase.ts';
import { createCoherentSqliteSnapshot } from '../../tools/s1-corpus-rehearsal/sqlite-snapshot.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

void it('constructs and independently verifies a synthetic C5 clone without emitting actual-corpus certification', async () => {
  const root = await realpath(await mkdtemp(join(platform() === 'win32' ? tmpdir() : '/tmp', 'pi-c5-synthetic-')));
  const sourceState = join(root, 'source-state');
  const sourceRepository = join(root, 'source-repository');
  const sourceMain = join(sourceState, 'worktrees', 'run', 'main');
  const cloneRoot = join(root, 'clone');
  const copyState = join(cloneRoot, 'state');
  const copyRepository = join(cloneRoot, 'repository');
  const copyMain = join(copyState, 'worktrees', 'run', 'main');
  const sentinelOwner = join(root, 'harness-sentinel');
  const outsideSentinel = join(sentinelOwner, 'outside-sentinel');
  try {
    await mkdir(sourceRepository, { recursive: true });
    await mkdir(join(sourceMain, '..'), { recursive: true });
    git(sourceRepository, ['init']);
    git(sourceRepository, ['config', 'user.email', 'c5@example.invalid']);
    git(sourceRepository, ['config', 'user.name', 'C5 Test']);
    await writeFile(join(sourceRepository, 'tracked.txt'), 'synthetic structural rehearsal\n', 'utf8');
    git(sourceRepository, ['add', 'tracked.txt']);
    git(sourceRepository, ['commit', '-m', 'synthetic structural rehearsal']);
    git(sourceRepository, ['worktree', 'add', '-b', 'autopilot/run', sourceMain, 'HEAD']);
    const head = git(sourceRepository, ['rev-parse', 'HEAD']);
    const sourceGit = await realpath(join(sourceRepository, '.git'));
    const sourcePaths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: sourceState });
    await mkdir(sourcePaths.coordinatorRoot, { recursive: true });
    await writeFile(sourcePaths.capabilityPath, `${'a'.repeat(64)}\n`, { mode: 0o600 });
    await writeFile(sourcePaths.lockPath, '{"live":true}\n', { mode: 0o600 });
    await writeFile(join(sourceState, 'active-autopilots.json'), `${canonicalJson([{ source_repo: sourceRepository, git_common_dir: sourceGit, main_worktree_path: sourceMain, worktree_root: join(sourceState, 'worktrees'), runtime_root: join(sourceMain, '.pi', 'autopilot', 'synthetic'), origin_url: `file://${sourceRepository}` }])}\n`, 'utf8');
    const sourceDatabase = new DatabaseSync(sourcePaths.databasePath);
    try {
      sourceDatabase.exec(`
        PRAGMA user_version=12;
        CREATE TABLE repositories(repo_id TEXT PRIMARY KEY, canonical_root TEXT NOT NULL, git_common_dir TEXT NOT NULL) STRICT;
        CREATE TABLE run_resources(entity_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL) STRICT;
        CREATE TABLE worktrees(entity_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL) STRICT;
        CREATE TABLE worktree_operations(entity_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL) STRICT;
      `);
      sourceDatabase.prepare('INSERT INTO repositories VALUES(?,?,?)').run('repo', sourceRepository, sourceGit);
      sourceDatabase.prepare('INSERT INTO run_resources VALUES(?,?)').run('resource', canonicalJson({ source_repo: sourceRepository, git_common_dir: sourceGit, worktree_root: join(sourceState, 'worktrees'), main_worktree_path: sourceMain, runtime_root: join(sourceMain, '.pi', 'autopilot', 'synthetic'), origin_url: `file://${sourceRepository}` }));
      sourceDatabase.prepare('INSERT INTO worktrees VALUES(?,?)').run('worktree', canonicalJson({ canonical_path: sourceMain, git_common_dir: sourceGit, branch: 'autopilot/run', head }));
      sourceDatabase.prepare('INSERT INTO worktree_operations VALUES(?,?)').run('operation', canonicalJson({ intent: { repo_root: sourceRepository, worktree_path: sourceMain, git_common_dir: sourceGit, branch: 'autopilot/run', paths: ['tracked.txt'] } }));
      sourceDatabase.exec('PRAGMA journal_mode=DELETE');
    } finally { sourceDatabase.close(); }
    await mkdir(sentinelOwner, { mode: 0o700 });
    await writeFile(outsideSentinel, 'immutable outside sentinel\n', { encoding: 'utf8', mode: 0o600 });
    const sourceBefore = [await inventoryTree(sourceState), await inventoryTree(sourceRepository)];
    const privateRequest = {
      schema_version: 'autopilot.s1_corpus_clone_request.v1' as const,
      rehearsal_id: 'synthetic-structural-only',
      created_at: '2026-07-16T00:00:00.000Z',
      destination_root: cloneRoot,
      result_path: join(cloneRoot, 'private', 'result.json'),
      candidate_tarball_path: join(root, 'candidate.tgz'),
      candidate_tarball_sha256: `sha256:${'1'.repeat(64)}` as const,
      cf50_tarball_path: join(root, 'cf50.tgz'),
      cf50_tarball_sha256: `sha256:${'2'.repeat(64)}` as const,
      corpora: [{ corpus_id: 'synthetic-corpus', state_root: sourceState, repository_root: sourceRepository, database_path: sourcePaths.databasePath, retained_snapshot_roots: [] }],
    };
    const liveBefore = await captureLiveWitness(privateRequest, 'before');

    await mkdir(cloneRoot, { recursive: true });
    await buildIsolatedStateCopy({ source_state_root: sourceState, source_repository_root: sourceRepository, copy_state_root: copyState });
    const mirror = await buildIsolatedGitMirror({ source_repository_root: sourceRepository, source_state_root: sourceState, copy_root: cloneRoot, copy_repository_root: copyRepository, copy_state_root: copyState });
    const copyPaths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: copyState });
    const snapshot = await createCoherentSqliteSnapshot({ rehearsal_id: 'synthetic-structural-only', corpus_id: 'synthetic-corpus', source_database_path: sourcePaths.databasePath, raw_snapshot_database_path: join(cloneRoot, 'private', 'raw-schema12', 'coordinator.db'), copy_database_path: copyPaths.databasePath, expected_user_version: 12 });
    await rebaseCorpusPaths({
      database_path: copyPaths.databasePath,
      state_root: copyState,
      clone_root: cloneRoot,
      mappings: [
        { source_path: sourceGit, copy_path: mirror.git_common_dir, source_label: 'git', kind: 'git-common-dir' },
        { source_path: sourceRepository, copy_path: copyRepository, source_label: 'repository', kind: 'repo-root' },
        { source_path: sourceMain, copy_path: copyMain, source_label: 'main-worktree', kind: 'worktree' },
        { source_path: sourceState, copy_path: copyState, source_label: 'state', kind: 'state-root' },
      ],
      ledger_path: join(cloneRoot, 'private', 'path-rebase-ledger.json'),
      expected_user_version: 12,
    });
    const environment = await buildCloneEnvironment({ clone_root: cloneRoot, state_root: copyState, project_root: copyRepository, home_root: join(cloneRoot, 'home'), temp_root: join(cloneRoot, 'tmp'), npm_cache_root: join(cloneRoot, 'npm-cache') });
    const verified = await verifyCloneIsolation({
      source_roots: [sourceState, sourceRepository],
      source_state_roots: [sourceState],
      clone_root: cloneRoot,
      copy_state_roots: [copyState],
      copy_repository_roots: [copyRepository],
      copy_database_paths: [copyPaths.databasePath],
      coherent_sqlite_snapshots: [snapshot],
      source_before: sourceBefore,
      clone_environment: environment,
      sandbox_cwd: copyRepository,
      sandbox_outside_sentinel_path: outsideSentinel,
      sandbox_outside_sentinel_owner_root: sentinelOwner,
    });
    assert.equal(verified.source_before_sha256, verified.source_after_sha256);
    assert.equal(Object.values(verified.proofs).every((proof) => proof.passed), true);
    const liveAfter = await captureLiveWitness(privateRequest, 'after');
    assert.equal(liveAfter.authority_sha256, liveBefore.authority_sha256);
    assert.equal(liveAfter.database_components_sha256, liveBefore.database_components_sha256);
    assert.equal(liveAfter.evidence_sha256, liveBefore.evidence_sha256);
    assert.equal(liveAfter.authority_objects_sha256, liveBefore.authority_objects_sha256);
    assert.equal(liveAfter.git_refs_sha256, liveBefore.git_refs_sha256);
    assert.equal(liveAfter.registrations_sha256, liveBefore.registrations_sha256);
    assert.equal(liveAfter.worktrees_sha256, liveBefore.worktrees_sha256);
    assert.notEqual(liveAfter.witness_sha256, liveBefore.witness_sha256, 'phase-bound witness digests must remain distinct');
    assert.equal(await readFile(outsideSentinel, 'utf8'), 'immutable outside sentinel\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
