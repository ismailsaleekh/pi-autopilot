import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, readFileSync } from 'node:fs';
import { appendFile, copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { parseCoordinationRunResource } from '../../src/core/coordination/contracts.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { gitWorktreeRegistrationFacts } from '../../src/core/coordination/worktree-postconditions.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { buildIsolatedStateCopy } from '../../tools/s1-corpus-rehearsal/copy-builder.ts';
import { forkScenarioState } from '../../tools/s1-corpus-rehearsal/clone-injections.ts';
import { parseCorpusCloneRequest } from '../../tools/s1-corpus-rehearsal/contracts.ts';
import { buildIsolatedGitMirror, verifyGitObjectClosure } from '../../tools/s1-corpus-rehearsal/git-mirror.ts';
import {
  assertCloneSymlinksContained,
  assertDisjointCanonicalRoots,
  assertNoSharedRegularFileIdentity,
  inventoryTree,
} from '../../tools/s1-corpus-rehearsal/inventory.ts';
import { preflightCorpusCloneRequest } from '../../tools/s1-corpus-rehearsal/request-preflight.ts';
import { createCoherentSqliteSnapshot, logicalSqliteDigest } from '../../tools/s1-corpus-rehearsal/sqlite-snapshot.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

void describe('C5 filesystem and SQLite isolation proofs', () => {
  void it('preflights canonical private source, immutable tarballs, and a disjoint absent destination', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-autopilot-c5-request-preflight-')));
    const state = join(root, 'state');
    const repository = join(root, 'repository');
    const database = join(state, 'coordinator', 'coordinator.db');
    const candidate = join(root, 'candidate.tgz');
    const cf50 = await realpath(join(process.cwd(), 'tests', 'fixtures', 'releases', 'cf50', 'pi-autopilot-1.1.8-cf50.tgz'));
    try {
      await mkdir(join(database, '..'), { recursive: true });
      await mkdir(repository, { recursive: true });
      git(repository, ['init']);
      await writeFile(database, 'schema-12 snapshot\n', 'utf8');
      await writeFile(candidate, 'candidate bytes\n', 'utf8');
      const candidateSha = `sha256:${createHash('sha256').update('candidate bytes\n').digest('hex')}`;
      const request = parseCorpusCloneRequest({ schema_version: 'autopilot.s1_corpus_clone_request.v1', rehearsal_id: 'request-preflight', created_at: '2026-07-16T00:00:00.000Z', destination_root: join(root, 'clone'), result_path: join(root, 'clone', 'private', 'result.json'), candidate_tarball_path: candidate, candidate_tarball_sha256: candidateSha, cf50_tarball_path: cf50, cf50_tarball_sha256: 'sha256:e98ccee99e95d5ba9c958c91c354eef40326fa21cf89a8ba37bd10e6650485a7', corpora: [{ corpus_id: 'corpus', state_root: state, repository_root: repository, database_path: database, retained_snapshot_roots: [] }] });
      const inheritedGitDir = process.env['GIT_DIR'];
      let preflight: Awaited<ReturnType<typeof preflightCorpusCloneRequest>>;
      try {
        process.env['GIT_DIR'] = join(root, 'ambient-git-redirection-must-not-be-observed');
        preflight = await preflightCorpusCloneRequest(request);
      } finally {
        if (inheritedGitDir === undefined) delete process.env['GIT_DIR'];
        else process.env['GIT_DIR'] = inheritedGitDir;
      }
      assert.equal(preflight.destination_root, join(root, 'clone'));
      await assert.rejects(() => preflightCorpusCloneRequest({ ...request, destination_root: join(state, 'clone'), result_path: join(state, 'clone', 'result.json') }), /not disjoint/u);
      await assert.rejects(() => preflightCorpusCloneRequest({ ...request, candidate_tarball_sha256: `sha256:${'0'.repeat(64)}` }), /candidate tarball digest mismatch/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('independently proves disjoint copied identities and rejects containment, hardlinks, and live symlink escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-c5-isolation-'));
    const source = join(root, 'source');
    const copy = join(root, 'copy');
    const nested = join(source, 'nested-copy');
    try {
      await mkdir(source, { recursive: true });
      await mkdir(copy, { recursive: true });
      await mkdir(nested, { recursive: true });
      await writeFile(join(source, 'authority.txt'), 'source authority\n', 'utf8');
      await copyFile(join(source, 'authority.txt'), join(copy, 'authority.txt'));
      await mkdir(join(copy, 'inside'), { recursive: true });
      await writeFile(join(copy, 'inside', 'target.txt'), 'clone target\n', 'utf8');
      await symlink('inside/target.txt', join(copy, 'internal-link'));
      assertDisjointCanonicalRoots(source, copy);
      assert.throws(() => assertDisjointCanonicalRoots(source, nested), /not disjoint/u);
      const sourceInventory = await inventoryTree(source);
      const copyInventory = await inventoryTree(copy);
      assertNoSharedRegularFileIdentity(sourceInventory, copyInventory);
      assertCloneSymlinksContained(copy, copyInventory);

      const hardlinked = join(root, 'hardlinked-copy');
      await mkdir(hardlinked, { recursive: true });
      linkSync(join(source, 'authority.txt'), join(hardlinked, 'authority.txt'));
      const hardlinkedInventory = await inventoryTree(hardlinked);
      assert.throws(() => assertNoSharedRegularFileIdentity(sourceInventory, hardlinkedInventory), /shares a regular-file identity/u);

      const escaping = join(root, 'escaping-copy');
      await mkdir(escaping, { recursive: true });
      await symlink(join(source, 'authority.txt'), join(escaping, 'live-link'));
      const escapingInventory = await inventoryTree(escaping);
      assert.throws(() => assertCloneSymlinksContained(escaping, escapingInventory), /escapes clone authority/u);

      const chained = join(root, 'chained-escape-copy');
      await mkdir(join(chained, 'inside'), { recursive: true });
      await symlink(source, join(chained, 'inside', 'jump'));
      await symlink('inside/jump/authority.txt', join(chained, 'chain'));
      const chainedInventory = await inventoryTree(chained);
      assert.throws(() => assertCloneSymlinksContained(chained, chainedInventory), /escapes clone authority/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('copies state without live authority or registered worktree bytes and rotates capability', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-autopilot-c5-state-copy-')));
    const sourceRepository = join(root, 'source-repository');
    const sourceState = join(root, 'source-state');
    const copyState = join(root, 'copy', 'state');
    const registeredPath = join(sourceState, 'worktrees', 'registered', 'worktree');
    try {
      await mkdir(sourceRepository, { recursive: true });
      await mkdir(join(registeredPath, '..'), { recursive: true });
      git(sourceRepository, ['init']);
      git(sourceRepository, ['config', 'user.email', 'c5@example.invalid']);
      git(sourceRepository, ['config', 'user.name', 'C5 Test']);
      await writeFile(join(sourceRepository, 'tracked.txt'), 'state copy fixture\n', 'utf8');
      git(sourceRepository, ['add', 'tracked.txt']);
      git(sourceRepository, ['commit', '-m', 'state copy fixture']);
      git(sourceRepository, ['worktree', 'add', '-b', 'autopilot/registered', registeredPath, 'HEAD']);
      await mkdir(join(sourceState, 'evidence'), { recursive: true });
      await writeFile(join(sourceState, 'evidence', 'retained.json'), '{"retained":true}\n', 'utf8');
      await symlink('retained.json', join(sourceState, 'evidence', 'retained-link'));
      const sourcePaths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: sourceState });
      await mkdir(sourcePaths.coordinatorRoot, { recursive: true });
      await mkdir(sourcePaths.sessionsRoot, { recursive: true });
      await writeFile(sourcePaths.databasePath, 'source database placeholder\n', 'utf8');
      await writeFile(sourcePaths.capabilityPath, `${'a'.repeat(64)}\n`, 'utf8');
      await writeFile(sourcePaths.lockPath, '{"live":true}\n', 'utf8');
      await writeFile(join(sourcePaths.sessionsRoot, 'live-session.json'), '{"token":"secret"}\n', 'utf8');
      await mkdir(join(copyState, '..'), { recursive: true });
      const copied = await buildIsolatedStateCopy({ source_state_root: sourceState, source_repository_root: sourceRepository, copy_state_root: copyState });
      const copyPaths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: copyState });
      assert.equal(existsSync(copyPaths.databasePath), false);
      assert.equal(existsSync(copyPaths.lockPath), false);
      assert.equal(existsSync(copyPaths.sessionsRoot), false);
      assert.equal(existsSync(join(copyState, 'worktrees', 'registered', 'worktree', 'tracked.txt')), false);
      assert.equal(readFileSync(join(copyState, 'evidence', 'retained.json'), 'utf8'), '{"retained":true}\n');
      assert.equal(readFileSync(copyPaths.capabilityPath, 'utf8').trim() === 'a'.repeat(64), false);
      assert.match(copied.capability_sha256, /^sha256:[a-f0-9]{64}$/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('rebuilds an isolated no-remote Git mirror with exact present and path-missing registrations', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-autopilot-c5-git-mirror-')));
    const sourceRepository = join(root, 'source-repository');
    const sourceState = join(root, 'source-state');
    const missingPath = join(sourceState, 'worktrees', 'missing', 'worktree');
    const copyRoot = join(root, 'copy');
    try {
      await mkdir(sourceRepository, { recursive: true });
      await mkdir(join(missingPath, '..'), { recursive: true });
      git(sourceRepository, ['init']);
      git(sourceRepository, ['config', 'user.email', 'c5@example.invalid']);
      git(sourceRepository, ['config', 'user.name', 'C5 Test']);
      await writeFile(join(sourceRepository, 'tracked.txt'), 'isolated mirror fixture\n', 'utf8');
      await symlink('tracked.txt', join(sourceRepository, 'tracked-link'));
      git(sourceRepository, ['add', 'tracked.txt', 'tracked-link']);
      git(sourceRepository, ['commit', '-m', 'isolated mirror fixture']);
      const head = git(sourceRepository, ['rev-parse', 'HEAD']);
      git(sourceRepository, ['worktree', 'add', '-b', 'autopilot/missing', missingPath, head]);
      await rm(missingPath, { recursive: true, force: false });
      const before = gitWorktreeRegistrationFacts(sourceRepository);
      assert.equal(before.filter((entry) => entry.prunable).length, 1);
      await mkdir(copyRoot, { recursive: true });
      const result = await buildIsolatedGitMirror({ source_repository_root: sourceRepository, source_state_root: sourceState, copy_root: copyRoot, copy_repository_root: join(copyRoot, 'project'), copy_state_root: join(copyRoot, 'state') });
      assert.equal(result.registrations.length, before.length);
      assert.equal(result.registrations.filter((entry) => entry.prunable).length, 1);
      assert.equal(existsSync(join(copyRoot, 'state', 'worktrees', 'missing', 'worktree')), false);
      assert.equal(readFileSync(join(copyRoot, 'project', 'tracked.txt'), 'utf8'), 'isolated mirror fixture\n');
      assert.equal(readFileSync(join(copyRoot, 'project', 'tracked-link'), 'utf8'), 'isolated mirror fixture\n');
      assert.equal(git(result.git_common_dir, ['--git-dir', result.git_common_dir, 'remote']), '');
      assert.equal(existsSync(join(result.git_common_dir, 'objects', 'info', 'alternates')), false);
      assert.equal(existsSync(join(result.git_common_dir, 'FETCH_HEAD')), false);
      assert.equal(existsSync(join(result.git_common_dir, 'logs')), false);
      assert.equal(git(sourceRepository, ['rev-parse', 'refs/heads/autopilot/missing']), head);
      await appendFile(join(result.git_common_dir, 'config'), '[includeIf "gitdir:/live/"]\n\tpath = /live/config\n', 'utf8');
      await assert.rejects(() => verifyGitObjectClosure(result.git_common_dir), /closed generated allowlist/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('forks controlled I4 states only under clone authority and injects exact isolated fault classes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-autopilot-c5-injections-')));
    const sandboxRoot = join(root, 'clone');
    const source = join(sandboxRoot, 'source.db');
    try {
      await mkdir(sandboxRoot, { recursive: true });
      const database = new DatabaseSync(source);
      try {
        database.exec(`
          PRAGMA user_version=12;
          CREATE TABLE repositories(repo_id TEXT PRIMARY KEY,event_seq INTEGER NOT NULL) STRICT;
          CREATE TABLE events(repo_id TEXT NOT NULL,event_seq INTEGER NOT NULL,PRIMARY KEY(repo_id,event_seq)) STRICT;
          CREATE TABLE runs(repo_id TEXT NOT NULL,workstream_run TEXT NOT NULL,PRIMARY KEY(repo_id,workstream_run)) STRICT;
          CREATE TABLE run_resources(repo_id TEXT NOT NULL,workstream_run TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(repo_id,workstream_run)) STRICT;
          INSERT INTO repositories VALUES('repo',2);
          INSERT INTO events VALUES('repo',1),('repo',2);
          INSERT INTO runs VALUES('repo','run-a'),('repo','run-b');
        `);
        const resource = (run: string) => JSON.stringify({ schema_version: 'autopilot.coordination_run_resource.v1', repo_id: 'repo', workstream_run: run, source_repo: sandboxRoot, git_common_dir: join(sandboxRoot, '.git'), worktree_root: join(sandboxRoot, 'worktrees'), main_worktree_path: join(sandboxRoot, 'worktrees', run, 'main'), runtime_root: join(sandboxRoot, 'worktrees', run, 'main', '.pi', 'autopilot'), branch: `autopilot/${run}`, target_branch: 'main', target_base_sha: 'a'.repeat(40), origin_url: null, started_at: '2026-07-16T00:00:00.000Z', version: 1 });
        database.prepare('INSERT INTO run_resources VALUES(?,?,?)').run('repo', 'run-a', resource('run-a'));
        database.prepare('INSERT INTO run_resources VALUES(?,?,?)').run('repo', 'run-b', resource('run-b'));
      } finally { database.close(); }
      const behind = await forkScenarioState({ rehearsal_id: 'i4-injections', corpus_id: 'corpus', sandbox_root: sandboxRoot, base_database_path: source, scenario_id: 'behind', injection: 'counter-behind' });
      const ahead = await forkScenarioState({ rehearsal_id: 'i4-injections', corpus_id: 'corpus', sandbox_root: sandboxRoot, base_database_path: source, scenario_id: 'ahead', injection: 'counter-ahead' });
      const ambiguous = await forkScenarioState({ rehearsal_id: 'i4-injections', corpus_id: 'corpus', sandbox_root: sandboxRoot, base_database_path: source, scenario_id: 'ambiguous', injection: 'payload-owner-ambiguous' });
      const physical = await forkScenarioState({ rehearsal_id: 'i4-injections', corpus_id: 'corpus', sandbox_root: sandboxRoot, base_database_path: source, scenario_id: 'physical', injection: 'physical-integrity' });
      const inspect = (path: string, sql: string): object => { const value = new DatabaseSync(path, { readOnly: true }); try { const row: unknown = value.prepare(sql).get(); if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new Error('I4 fixture query returned no row'); return row; } finally { value.close(); } };
      assert.equal(Reflect.get(inspect(behind.database_path, 'SELECT event_seq FROM repositories'), 'event_seq'), 1);
      assert.equal(Reflect.get(inspect(ahead.database_path, 'SELECT event_seq FROM repositories'), 'event_seq'), 3);
      const ambiguousPayload = String(Reflect.get(inspect(ambiguous.database_path, "SELECT payload_json FROM run_resources WHERE workstream_run='run-a'"), 'payload_json'));
      assert.equal(parseCoordinationRunResource(JSON.parse(ambiguousPayload) as unknown).workstream_run, 'run-b');
      assert.throws(() => logicalSqliteDigest(physical.database_path), /integrity_check failed|malformed|corrupt/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('backs up a WAL database coherently without copying sidecars and rejects source drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-c5-sqlite-'));
    const source = join(root, 'source.db');
    const firstRaw = join(root, 'raw', 'coordinator.db');
    const firstCopy = join(root, 'copy', 'coordinator.db');
    const driftRaw = join(root, 'drift-raw', 'coordinator.db');
    const driftCopy = join(root, 'drift-copy', 'coordinator.db');
    const keeper = new DatabaseSync(source);
    try {
      keeper.exec('PRAGMA journal_mode=WAL; PRAGMA user_version=12; CREATE TABLE facts(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO facts(value) VALUES(\'retained\')');
      const snapshot = await createCoherentSqliteSnapshot({ rehearsal_id: 'rehearsal-sqlite', corpus_id: 'corpus-sqlite', source_database_path: source, raw_snapshot_database_path: firstRaw, copy_database_path: firstCopy, expected_user_version: 12 });
      assert.equal(snapshot.source_logical_before.logical_sha256, snapshot.copy_logical.logical_sha256);
      assert.equal(logicalSqliteDigest(firstCopy).user_version, 12);

      const rollbackSource = join(root, 'rollback.db');
      const rollback = new DatabaseSync(rollbackSource);
      try { rollback.exec('PRAGMA journal_mode=DELETE; PRAGMA user_version=12; CREATE TABLE facts(id INTEGER PRIMARY KEY) STRICT'); }
      finally { rollback.close(); }
      await writeFile(`${rollbackSource}-journal`, 'unbounded hot journal\n', 'utf8');
      await assert.rejects(() => createCoherentSqliteSnapshot({ rehearsal_id: 'rehearsal-journal', corpus_id: 'corpus-sqlite', source_database_path: rollbackSource, raw_snapshot_database_path: join(root, 'journal-raw', 'coordinator.db'), copy_database_path: join(root, 'journal-copy', 'coordinator.db'), expected_user_version: 12 }), /rollback journal/u);

      await assert.rejects(() => createCoherentSqliteSnapshot({
        rehearsal_id: 'rehearsal-sqlite-drift',
        corpus_id: 'corpus-sqlite',
        source_database_path: source,
        raw_snapshot_database_path: driftRaw,
        copy_database_path: driftCopy,
        expected_user_version: 12,
        observe_after_backup_before_source_recheck: () => { keeper.exec("INSERT INTO facts(value) VALUES('drift')"); },
      }), /drifted during coherent snapshot|logical state disagrees/u);
    } finally {
      keeper.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
