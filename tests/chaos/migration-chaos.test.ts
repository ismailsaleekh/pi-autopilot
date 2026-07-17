import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runCoordinationMigration } from '../../src/core/coordination/migration.ts';
import { migrationTestClock, withMigrationTestFixture } from '../helpers/migration-fixture.ts';

void describe('migration filesystem and source-drift chaos', () => {
  void it('resumes through stale .reclaim residue without discarding a different elected lock identity', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const migrationRoot = join(fixture.stateRoot, 'migrations', fixture.repoKey);
      const lock = join(migrationRoot, 'migration.lock');
      const reclaim = `${lock}.reclaim`;
      await mkdir(migrationRoot, { recursive: true });
      const stale = `${JSON.stringify({ schema_version: 'autopilot.coordination_migration_lock.v1', pid: 999_999_999, boot_id: 'prior-boot', token: 'a'.repeat(48), created_at: '2026-07-12T11:00:00.000Z' })}\n`;
      await writeFile(lock, stale, 'utf8');
      await writeFile(reclaim, stale, 'utf8');
      const applied = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      assert.equal(applied.state, 'imported');
      assert.equal(existsSync(reclaim), false);
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
    });
  });

  void it('removes an unelected partial candidate left by hard death and acquires normally', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const migrationRoot = join(fixture.stateRoot, 'migrations', fixture.repoKey);
      const candidate = join(migrationRoot, `migration.lock.candidate-999999999-${'d'.repeat(48)}`);
      await mkdir(migrationRoot, { recursive: true });
      await writeFile(candidate, '{"partial":', 'utf8');
      const applied = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      assert.equal(applied.state, 'imported');
      assert.equal(existsSync(candidate), false);
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
    });
  });

  void it('reclaims only the identity-fenced stale lock and completes migration', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const migrationRoot = join(fixture.stateRoot, 'migrations', fixture.repoKey);
      const lock = join(migrationRoot, 'migration.lock');
      await mkdir(migrationRoot, { recursive: true });
      await writeFile(lock, `${JSON.stringify({ schema_version: 'autopilot.coordination_migration_lock.v1', pid: 999_999_999, boot_id: 'prior-boot', token: 'b'.repeat(48), created_at: '2026-07-12T11:00:00.000Z' })}\n`, 'utf8');
      const applied = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      assert.equal(applied.state, 'imported');
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
    });
  });

  void it('rejects post-import source drift, restores the verified boundary, and requires a fresh snapshot', async () => {
    await withMigrationTestFixture(async (fixture) => {
      await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      const claims = join(fixture.stateRoot, 'coordination', fixture.repoKey, 'path-claims.json');
      const original = await readFile(claims, 'utf8');
      await writeFile(claims, `${original.trim()} \n`, 'utf8');
      await assert.rejects(() => runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() }), /source hash drift rejected verification/u);
      const journal = JSON.parse(await readFile(join(fixture.stateRoot, 'migrations', fixture.repoKey, 'journal.json'), 'utf8')) as unknown;
      assert.equal(typeof journal === 'object' && journal !== null && !Array.isArray(journal) && (journal as Readonly<Record<string, unknown>>)['state'], 'frozen');
      const reapplied = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      assert.equal(reapplied.state, 'imported');
    });
  });

  void it('rejects external Git HEAD movement before verification and requires a new snapshot', async () => {
    await withMigrationTestFixture(async (fixture) => {
      await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      await writeFile(join(fixture.source, 'external-drift.txt'), 'external drift\n', 'utf8');
      for (const args of [['add', 'external-drift.txt'], ['commit', '-m', 'external drift']]) {
        const result = spawnSync('git', args, { cwd: fixture.source, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      }
      await assert.rejects(() => runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() }), /source hash drift rejected verification/u);
      const reapplied = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      assert.equal(reapplied.state, 'imported');
    });
  });

  void it('rejects duplicate JSON keys before semantic parsing', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const claims = join(fixture.stateRoot, 'coordination', fixture.repoKey, 'path-claims.json');
      await writeFile(claims, '[{"schema_version":"autopilot.path_claim.v1","schema_version":"autopilot.path_claim.v1"}]\n', 'utf8');
      await assert.rejects(() => runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() }), /duplicate JSON object key/u);
    });
  });

  void it('refuses symlinked legacy authority instead of following it', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const claims = join(fixture.stateRoot, 'coordination', fixture.repoKey, 'path-claims.json');
      const outside = join(fixture.root, 'outside-claims.json');
      await writeFile(outside, '[]\n', 'utf8');
      await rm(claims);
      await symlink(outside, claims);
      await assert.rejects(() => runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() }), /single-link regular non-symbolic file/u);
    });
  });

  void it('refuses symbolic substitution in migration control and snapshot destination ancestry', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const outside = join(fixture.root, 'outside-migrations');
      await mkdir(outside, { recursive: true });
      const migrations = join(fixture.stateRoot, 'migrations');
      await symlink(outside, migrations, 'dir');
      await assert.rejects(() => runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() }), /symbolic-link|junction/u);
    });
    await withMigrationTestFixture(async (fixture) => {
      const migrationRoot = join(fixture.stateRoot, 'migrations', fixture.repoKey);
      const outsideSnapshot = join(fixture.root, 'outside-snapshot');
      await mkdir(migrationRoot, { recursive: true });
      await mkdir(outsideSnapshot, { recursive: true });
      await symlink(outsideSnapshot, join(migrationRoot, 'snapshot'), 'dir');
      await assert.rejects(() => runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() }), /symbolic-link|junction/u);
    });
  });

  void it('refuses cutover destination ancestry substituted with a physical escape', async () => {
    await withMigrationTestFixture(async (fixture) => {
      await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      const outside = join(fixture.root, 'outside-cutovers');
      const cutovers = join(fixture.stateRoot, 'cutovers');
      await mkdir(outside, { recursive: true });
      await rm(cutovers, { recursive: true, force: true });
      await symlink(outside, cutovers, 'dir');
      await assert.rejects(() => runCoordinationMigration({ command: 'cutover', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() }), /symbolic-link|junction/u);
    });
  });

  void it('refuses a symlinked parent directory that physically escapes the isolated state root', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const coordination = join(fixture.stateRoot, 'coordination', fixture.repoKey);
      const outside = join(fixture.root, 'outside-coordination');
      await rename(coordination, outside);
      await symlink(outside, coordination, 'dir');
      try {
        await assert.rejects(() => runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() }), /escapes isolated state root physically/u);
      } finally {
        await rm(coordination, { force: true });
        await rename(outside, coordination);
      }
    });
  });
});
