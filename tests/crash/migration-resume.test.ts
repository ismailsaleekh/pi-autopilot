import assert from 'node:assert/strict';
import { spawn, type ChildProcessLite } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { runCoordinationMigration, type CoordinationMigrationCommand, type CoordinationMigrationCrashBoundary } from '../../src/core/coordination/migration.ts';
import { isProcessAlive } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { readCurrentStoreGeneration } from '../../src/core/coordination/store-generation.ts';
import { hardKillProcess } from '../helpers/hard-kill-process.ts';
import { migrationTestClock, withMigrationTestFixture } from '../helpers/migration-fixture.ts';

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const processClient = join(packageRoot, 'tests', 'helpers', 'migration-process-client.ts');

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`migration subprocess did not reach boundary: ${path}`);
}

function childClose(child: ChildProcessLite): Promise<number | null> {
  return new Promise((resolveClose) => child.on('close', (code) => resolveClose(code)));
}

function assertNoFixtureCoordinatorLeak(pids: readonly number[], phase: string): void {
  for (const pid of pids) assert.equal(isProcessAlive(pid), false, `${phase}: coordinator pid ${String(pid)} leaked after fixture cleanup`);
}

void describe('migration transition crash recovery', () => {
  void it('also resumes idempotently under deterministic in-process boundary injection', async () => {
    const phases: readonly { readonly command: CoordinationMigrationCommand; readonly boundaries: readonly CoordinationMigrationCrashBoundary[] }[] = [
      { command: 'apply', boundaries: ['after-freeze', 'after-snapshot', 'after-backup-created-before-journal', 'after-backup', 'after-import-commit-before-journal', 'after-import'] },
      { command: 'verify', boundaries: ['after-verified', 'after-cutover-ready'] },
      { command: 'cutover', boundaries: ['after-cutover-marker-before-journal', 'after-cutover-marker', 'after-runtime-projections', 'after-legacy-archive'] },
    ];
    for (const phase of phases) {
      for (const boundary of phase.boundaries) {
        const retiredPids = await withMigrationTestFixture(async (fixture) => {
          if (phase.command === 'verify' || phase.command === 'cutover') await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
          if (phase.command === 'cutover') await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
          let injected = false;
          await assert.rejects(() => runCoordinationMigration({
            command: phase.command, repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock(),
            afterBoundary: (reached) => { if (!injected && reached === boundary) { injected = true; throw new Error(`injected crash at ${boundary}`); } },
          }), new RegExp(`injected crash at ${boundary}`, 'u'));
          assert.equal(injected, true, boundary);
          if (phase.command === 'apply') {
            const imported = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
            assert.equal(imported.state, 'imported');
            await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
          } else if (phase.command === 'verify') {
            const ready = await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
            assert.equal(ready.state, 'cutover-ready');
          }
          const completed = await runCoordinationMigration({ command: 'cutover', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
          assert.equal(completed.state, 'legacy-archived');
          assert.equal(existsSync(join(fixture.stateRoot, 'migrations', fixture.repoKey, 'freeze.json')), false);
          assert.equal(existsSync(join(fixture.stateRoot, 'cutovers', `${fixture.repoKey}.json`)), true);
        });
        assertNoFixtureCoordinatorLeak(retiredPids, `${phase.command}:${boundary}:in-process`);
      }
    }
  });

  void it('rejects forward resume when post-marker database bytes drift before the recorded transition', async () => {
    await withMigrationTestFixture(async (fixture) => {
      await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      await assert.rejects(() => runCoordinationMigration({
        command: 'cutover', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock(),
        afterBoundary: (boundary) => { if (boundary === 'after-cutover-marker-before-journal') throw new Error('marker crash'); },
      }), /marker crash/u);
      const generation = readCurrentStoreGeneration(coordinatorRuntimePaths(fixture.env));
      if (generation === null) throw new Error('cutover marker fixture has no current schema-13 generation');
      const database = new DatabaseSync(generation.database_path);
      try { database.exec("UPDATE repositories SET version=version+1 WHERE repo_id='" + fixture.repoKey.replace(/'/gu, "''") + "'"); database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
      finally { database.close(); }
      await assert.rejects(
        () => runCoordinationMigration({ command: 'cutover', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() }),
        /database bytes disagree with the committed marker digest/u,
      );
      assert.equal(existsSync(join(fixture.stateRoot, 'coordination', fixture.repoKey, 'active-autopilots.json')), true, 'unsafe resume must reject before legacy archive');
    });
  });

  void it('hard-kill resumes identity-fenced stale-lock reclamation at both filesystem instructions', async () => {
    for (const boundary of ['after-lock-reclaim-linked', 'after-lock-reclaim-quarantined'] as const) {
      await withMigrationTestFixture(async (fixture) => {
        const migrationRoot = join(fixture.stateRoot, 'migrations', fixture.repoKey);
        const lockPath = join(migrationRoot, 'migration.lock');
        await mkdir(migrationRoot, { recursive: true });
        await writeFile(lockPath, `${JSON.stringify({ schema_version: 'autopilot.coordination_migration_lock.v1', pid: 999_999_999, boot_id: 'prior-boot', token: 'c'.repeat(48), created_at: '2026-07-12T11:00:00.000Z' })}\n`, 'utf8');
        const barrier = join(fixture.root, `barrier-${boundary}`);
        const child = spawn(process.execPath, ['--experimental-strip-types', processClient, 'apply', fixture.repoKey, fixture.stateRoot, boundary, barrier], { cwd: packageRoot, env: { ...process.env, AUTOPILOT_STATE_ROOT: fixture.stateRoot }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
        const closed = childClose(child);
        await waitForFile(barrier);
        hardKillProcess(child);
        assert.notEqual(await closed, 0);
        const imported = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
        assert.equal(imported.state, 'imported');
        assert.equal(existsSync(`${lockPath}.reclaim`), false);
        await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      });
    }
  });

  void it('survives real cross-platform hard death and restart at every durable command boundary', async () => {
    const phases: readonly { readonly command: CoordinationMigrationCommand; readonly boundaries: readonly CoordinationMigrationCrashBoundary[] }[] = [
      { command: 'apply', boundaries: ['after-lock-candidate-synced', 'after-lock-published', 'after-plan', 'after-freeze-written-before-journal', 'after-freeze', 'after-writer-authority', 'after-snapshot-copied-before-journal', 'after-snapshot', 'after-backup-created-before-journal', 'after-backup', 'after-import-commit-before-journal', 'after-import', 'after-lock-release-linked', 'after-lock-release-unlinked'] },
      { command: 'verify', boundaries: ['after-verified-store-before-journal', 'after-verified', 'after-cutover-ready-store-before-journal', 'after-cutover-ready'] },
      { command: 'rollback', boundaries: ['after-rollback-intent', 'after-rollback-restore-before-journal', 'after-rollback-restore', 'after-rollback-verified', 'after-rollback-unfreeze'] },
      { command: 'cutover', boundaries: ['after-cutover-marker-before-journal', 'after-cutover-marker', 'after-cutover-store', 'after-runtime-projections', 'after-legacy-files-archived-before-store', 'after-legacy-archive-store-before-journal', 'after-legacy-archive', 'after-cutover-unfreeze'] },
    ];
    for (const phase of phases) for (const boundary of phase.boundaries) {
      const retiredPids = await withMigrationTestFixture(async (fixture) => {
      if (phase.command === 'verify' || phase.command === 'rollback' || phase.command === 'cutover') await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      if (phase.command === 'cutover') await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      const barrier = join(fixture.root, `barrier-${boundary}`);
      await rm(barrier, { force: true });
      const child = spawn(process.execPath, ['--experimental-strip-types', processClient, phase.command, fixture.repoKey, fixture.stateRoot, boundary, barrier], { cwd: packageRoot, env: { ...process.env, AUTOPILOT_STATE_ROOT: fixture.stateRoot }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      const closed = childClose(child);
      await waitForFile(barrier);
      hardKillProcess(child);
      const exit = await closed;
      assert.notEqual(exit, 0, `${phase.command}:${boundary}`);

      if (phase.command === 'rollback') {
        const rolledBack = await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
        assert.equal(rolledBack.state, 'rolled-back');
        await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
        await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      } else if (phase.command === 'apply') {
        const imported = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
        assert.equal(imported.state, 'imported');
        await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      } else if (phase.command === 'verify') {
        const ready = await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
        assert.equal(ready.state, 'cutover-ready');
      }
      const completed = await runCoordinationMigration({ command: 'cutover', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
        assert.equal(completed.state, 'legacy-archived');
        assert.equal(existsSync(join(fixture.stateRoot, 'migrations', fixture.repoKey, 'freeze.json')), false);
      });
      assertNoFixtureCoordinatorLeak(retiredPids, `${phase.command}:${boundary}:hard-death`);
    }
  });
});
