import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { currentBootId, isProcessAlive } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths, type CoordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import type { CurrentStoreGeneration } from '../../src/core/coordination/store-generation.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import { parseCurrentCoordinatorLock, parsePredecessorCoordinatorLock } from '../../src/core/coordination/upgrade-contracts.ts';
import { coordinationRootForRepo, prepareAutopilotWorkstream, resolveRepoIdentity, writeActiveAutopilots, writePathClaims, type AutopilotPathClaim, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

export interface MigrationTestFixture {
  readonly root: string;
  readonly source: string;
  readonly stateRoot: string;
  readonly repoKey: string;
  readonly env: ProcessEnvLike;
}

export function migrationTestClock(): { readonly now: () => Date } { return { now: () => new Date('2026-07-12T12:00:00.000Z') }; }

/**
 * Reifies the closed current generation as an exact unbarriered schema-12
 * predecessor fixture. Production never runs this reverse projection: tests use
 * it only to exercise the package-owned historical schema upgrade chain before
 * S1 publishes a new generation.
 */
export async function stageCurrentGenerationAsExactSchema12(paths: CoordinatorRuntimePaths, current: CurrentStoreGeneration): Promise<string> {
  if (!existsSync(paths.currentStorePointerPath) || !existsSync(current.database_path)) throw new Error('schema-12 predecessor fixture requires a published current generation');
  if (existsSync(`${current.database_path}-wal`) || existsSync(`${current.database_path}-shm`)) throw new Error('schema-12 predecessor fixture refuses a live or incompletely closed generation');
  const stagingPath = `${paths.databasePath}.schema12-fixture-${String(process.pid)}`;
  await rm(stagingPath, { force: true });
  try {
    await copyFile(current.database_path, stagingPath);
    const database = new DatabaseSync(stagingPath);
    try {
      const version = database.prepare('PRAGMA user_version').get()?.['user_version'];
      if (version !== 13) throw new Error(`schema-12 predecessor fixture expected schema 13, found ${String(version)}`);
      database.exec(`
        PRAGMA foreign_keys=OFF;
        BEGIN IMMEDIATE;
        DROP INDEX idx_worktree_aliases_canonical;
        DROP INDEX idx_worktrees_canonical;
        DROP INDEX idx_worktrees_current_semantic;
        DROP INDEX idx_worktree_operations_canonical;
        DROP TABLE worktree_aliases;
        DROP TABLE run_scoped_faults;
        ALTER TABLE worktree_operations DROP COLUMN canonical_worktree_id;
        ALTER TABLE worktrees DROP COLUMN is_current_canonical;
        ALTER TABLE worktrees DROP COLUMN kind;
        ALTER TABLE worktrees DROP COLUMN attempt;
        ALTER TABLE worktrees DROP COLUMN unit_id;
        ALTER TABLE worktrees DROP COLUMN autopilot_id;
        ALTER TABLE worktrees DROP COLUMN canonical_worktree_id;
        DELETE FROM schema_migrations WHERE version=13;
        PRAGMA user_version=12;
        COMMIT;
        PRAGMA wal_checkpoint(TRUNCATE);
        PRAGMA journal_mode=DELETE;
      `);
      const integrity = database.prepare('PRAGMA integrity_check').get()?.['integrity_check'];
      const stagedVersion = database.prepare('PRAGMA user_version').get()?.['user_version'];
      if (integrity !== 'ok' || stagedVersion !== 12) throw new Error(`schema-12 predecessor fixture is invalid: integrity=${String(integrity)} schema=${String(stagedVersion)}`);
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    } finally { database.close(); }
    await rm(paths.currentStorePointerPath, { force: true });
    await rm(paths.storesRoot, { recursive: true, force: true });
    await mkdir(paths.storesRoot, { recursive: true, mode: 0o700 });
    await rm(paths.databasePath, { force: true });
    await rename(stagingPath, paths.databasePath);
    return paths.databasePath;
  } finally { await rm(stagingPath, { force: true }); }
}

/** Creates the exact Phase-34 schema boundary from the current migration chain. */
export async function seedPhase34Schema6Database(env: ProcessEnvLike): Promise<string> {
  const paths = coordinatorRuntimePaths(env);
  const store = await CoordinatorStore.open(paths, migrationTestClock());
  const generation = store.currentGeneration();
  store.close();
  await stageCurrentGenerationAsExactSchema12(paths, generation);
  const database = new DatabaseSync(paths.databasePath);
  try {
    database.exec(`
      BEGIN IMMEDIATE;
      DROP TABLE result_details;
      DROP TABLE result_receipts;
      DROP TABLE mailbox_delivery_items;
      DROP TABLE mailbox_deliveries;
      DROP TABLE reconciliation_details;
      DROP TABLE reconciliation_receipts;
      DROP TABLE observations;
      DROP TABLE semantic_replays;
      ALTER TABLE session_leases DROP COLUMN attachment_kind;
      DROP TABLE migration_legacy_audit;
      DROP TABLE migration_recovery_work;
      DROP TABLE coordination_migrations;
      DROP TABLE run_resources;
      DELETE FROM schema_migrations WHERE version >= 7;
      PRAGMA user_version=6;
      COMMIT;
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
  } finally { database.close(); }
  return paths.databasePath;
}

export async function withEmptyMigrationTestFixture(run: (fixture: MigrationTestFixture) => Promise<void>): Promise<readonly number[]> {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-empty-migration-proof-'));
  const source = join(root, 'source');
  const stateRoot = join(root, 'state');
  const env: ProcessEnvLike = { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot };
  let coordinatorPids: readonly number[] = [];
  try {
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'README.md'), '# empty legacy coordination repository\n', 'utf8');
    for (const args of [['init'], ['config', 'user.email', 'migration@example.invalid'], ['config', 'user.name', 'Migration Test'], ['add', '.'], ['commit', '-m', 'baseline']]) {
      const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    await mkdir(stateRoot, { recursive: true });
    await run({ root, source, stateRoot, repoKey: resolveRepoIdentity(source).repoKey, env });
  } finally {
    coordinatorPids = await terminateExactMigrationFixtureCoordinator(stateRoot);
    await makeRemovable(root);
    await rm(root, { recursive: true, force: true });
  }
  return coordinatorPids;
}

export async function withMigrationTestFixture(run: (fixture: MigrationTestFixture) => Promise<void>): Promise<readonly number[]> {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-migration-proof-'));
  const source = join(root, 'source');
  const stateRoot = join(root, 'state');
  const env: ProcessEnvLike = { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot };
  let coordinatorPids: readonly number[] = [];
  try {
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'README.md'), '# generic migration repository\n', 'utf8');
    for (const args of [['init'], ['config', 'user.email', 'migration@example.invalid'], ['config', 'user.name', 'Migration Test'], ['add', '.'], ['commit', '-m', 'baseline']]) {
      const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const prepared = await prepareAutopilotWorkstream({ workstream: 'migration-proof', sourceCwd: source, env, now: new Date('2026-07-12T11:00:00.000Z') });
    const coordinationRoot = coordinationRootForRepo(prepared.active.repo_key, env);
    const dormant = { ...prepared.active, pid: 999_999_999, boot_id: 'prior-boot', active_run_epoch: 2 };
    await writeActiveAutopilots(coordinationRoot, [dormant]);
    const claim: AutopilotPathClaim = { schema_version: 'autopilot.path_claim.v1', path: 'src/future.ts', autopilot_id: dormant.autopilot_id, workstream: dormant.workstream, workstream_run: dormant.workstream_run, unit_id: 'unit-old-session', attempt: 1, claim_type: 'WRITE', acquired_at: '2026-07-12T11:01:00.000Z', active_run_epoch: 1, reason: 'old-session durable ownership proof' };
    await writePathClaims(coordinationRoot, [claim]);
    await run({ root, source, stateRoot, repoKey: prepared.active.repo_key, env });
  } finally {
    coordinatorPids = await terminateExactMigrationFixtureCoordinator(stateRoot);
    await makeRemovable(root);
    await rm(root, { recursive: true, force: true });
  }
  return coordinatorPids;
}

export async function terminateExactMigrationFixtureCoordinator(stateRoot: string): Promise<readonly number[]> {
  const lockPath = coordinatorRuntimePaths({ ...process.env, AUTOPILOT_STATE_ROOT: stateRoot }).lockPath;
  if (!existsSync(lockPath)) return Object.freeze([]);
  const exactText = await readFile(lockPath, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(exactText) as unknown; } catch (error) { throw new Error(`fixture coordinator lifecycle lock is malformed: ${error instanceof Error ? error.message : String(error)}`); }
  const identity = parseCurrentCoordinatorLock(parsed) ?? parsePredecessorCoordinatorLock(parsed);
  if (identity === null) throw new Error('fixture coordinator lifecycle lock has an unknown identity');
  if (identity.boot_id !== currentBootId()) {
    if (isProcessAlive(identity.pid)) throw new Error('fixture coordinator lifecycle lock belongs to another boot but its pid is live');
    return Object.freeze([identity.pid]);
  }
  if (!isProcessAlive(identity.pid)) return Object.freeze([identity.pid]);
  if (identity.pid === process.pid) throw new Error('fixture leaked an in-process coordinator lifecycle instead of closing it');

  const assertIdentityStillExact = async (): Promise<void> => {
    if (!existsSync(lockPath)) return;
    assert.equal(await readFile(lockPath, 'utf8'), exactText, 'fixture coordinator lifecycle identity changed during cleanup');
  };
  await assertIdentityStillExact();
  process.kill(identity.pid, 'SIGTERM');
  let deadline = Date.now() + 5_000;
  while (isProcessAlive(identity.pid) && Date.now() < deadline) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  if (isProcessAlive(identity.pid)) {
    await assertIdentityStillExact();
    process.kill(identity.pid, 'SIGKILL');
    deadline = Date.now() + 5_000;
    while (isProcessAlive(identity.pid) && Date.now() < deadline) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.equal(isProcessAlive(identity.pid), false, `fixture coordinator process ${String(identity.pid)} leaked past cleanup`);
  if (existsSync(lockPath)) await assertIdentityStillExact();
  return Object.freeze([identity.pid]);
}

async function makeRemovable(root: string): Promise<void> {
  if (!existsSync(root)) return;
  await chmod(root, 0o700).catch(() => undefined);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await makeRemovable(path);
    else await chmod(path, 0o600).catch(() => undefined);
  }
}
