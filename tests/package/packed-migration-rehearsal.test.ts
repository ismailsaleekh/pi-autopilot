import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { scanStandalonePackageBoundary } from '../../src/core/coordination/package-isolation.ts';
import { withMigrationTestFixture, type MigrationTestFixture } from '../helpers/migration-fixture.ts';

interface PackResult {
  readonly filename: string;
}

interface MigrationReport {
  readonly schema_version: string;
  readonly state: string;
  readonly dry_run: boolean;
  readonly blockers: readonly string[];
  readonly imported_run_count: number;
  readonly rebound_old_epoch_claim_count: number;
}

const packageRoot = new URL('../../', import.meta.url);

function parsePackResult(stdout: string): PackResult {
  const value: unknown = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value) || value.length !== 1) throw new Error('npm pack did not return one tarball');
  const entry = value[0];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('npm pack result is malformed');
  const filename = (entry as Readonly<Record<string, unknown>>)['filename'];
  if (typeof filename !== 'string' || filename.length === 0) throw new Error('npm pack filename is malformed');
  return { filename };
}

function parseMigrationReport(stdout: string, label: string): MigrationReport {
  const value: unknown = JSON.parse(stdout) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} report is malformed`);
  const report = value as Readonly<Record<string, unknown>>;
  const blockers = report['blockers'];
  if (!Array.isArray(blockers) || !blockers.every((entry) => typeof entry === 'string')) throw new Error(`${label} blockers are malformed`);
  const state = report['state'];
  const dryRun = report['dry_run'];
  const importedRunCount = report['imported_run_count'];
  const reboundCount = report['rebound_old_epoch_claim_count'];
  if (typeof state !== 'string' || typeof dryRun !== 'boolean' || typeof importedRunCount !== 'number' || typeof reboundCount !== 'number') throw new Error(`${label} report fields are malformed`);
  return {
    schema_version: String(report['schema_version']),
    state,
    dry_run: dryRun,
    blockers,
    imported_run_count: importedRunCount,
    rebound_old_epoch_claim_count: reboundCount,
  };
}

function runInstalledMigration(installedCoordinator: string, fixture: MigrationTestFixture, args: readonly string[]): MigrationReport {
  const result = spawnSync(process.execPath, [installedCoordinator, ...args, '--state-root', fixture.stateRoot, '--repo-key', fixture.repoKey], {
    cwd: fixture.source,
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTOPILOT_STATE_ROOT: fixture.stateRoot,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --disable-warning=ExperimentalWarning`.trim(),
    },
  });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  const report = parseMigrationReport(result.stdout, args.join(' '));
  assert.equal(report.schema_version, 'autopilot.coordination_migration_report.v1');
  assert.deepEqual(report.blockers, []);
  return report;
}

void describe('packed generic-repository migration certification scaffolding', () => {
  void it('rehearses apply-verify-rollback and apply-verify-cutover only through an installed tarball', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-packed-migration-'));
    try {
      const packRoot = join(root, 'pack');
      const installRoot = join(root, 'generic-consumer');
      const cacheRoot = join(root, 'npm-cache');
      await mkdir(packRoot, { recursive: true });
      await mkdir(installRoot, { recursive: true });
      const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', packRoot], {
        cwd: packageRoot,
        encoding: 'utf8',
        env: { ...process.env, NPM_CONFIG_CACHE: cacheRoot, NPM_CONFIG_OFFLINE: 'true' },
      });
      assert.equal(pack.status, 0, pack.stderr);
      const tarball = join(packRoot, parsePackResult(pack.stdout).filename);
      assert.equal(existsSync(tarball), true);
      const install = spawnSync('npm', ['install', '--ignore-scripts', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', tarball], {
        cwd: installRoot,
        encoding: 'utf8',
        env: { ...process.env, NPM_CONFIG_CACHE: cacheRoot, NPM_CONFIG_OFFLINE: 'true' },
      });
      assert.equal(install.status, 0, install.stderr);

      const installedPackage = join(installRoot, 'node_modules', 'pi-autopilot');
      const installedCoordinator = join(installedPackage, 'bin', 'autopilot-coordinator.mjs');
      assert.equal(existsSync(installedCoordinator), true);
      assert.deepEqual(await scanStandalonePackageBoundary(installedPackage), [], 'installed tarball crossed the standalone package boundary');

      await withMigrationTestFixture(async (fixture) => {
        const applied = runInstalledMigration(installedCoordinator, fixture, ['migrate', '--apply']);
        assert.equal(applied.state, 'imported');
        assert.equal(applied.imported_run_count, 1);
        assert.equal(applied.rebound_old_epoch_claim_count, 1);
        const verified = runInstalledMigration(installedCoordinator, fixture, ['verify']);
        assert.equal(verified.state, 'cutover-ready');
        const rolledBack = runInstalledMigration(installedCoordinator, fixture, ['rollback']);
        assert.equal(rolledBack.state, 'rolled-back');
      });

      await withMigrationTestFixture(async (fixture) => {
        const applied = runInstalledMigration(installedCoordinator, fixture, ['migrate', '--apply']);
        assert.equal(applied.state, 'imported');
        assert.equal(applied.imported_run_count, 1);
        assert.equal(applied.rebound_old_epoch_claim_count, 1);
        const verified = runInstalledMigration(installedCoordinator, fixture, ['verify']);
        assert.equal(verified.state, 'cutover-ready');
        const cutover = runInstalledMigration(installedCoordinator, fixture, ['cutover']);
        assert.equal(cutover.state, 'legacy-archived');
        assert.equal(existsSync(join(fixture.stateRoot, 'cutovers', `${fixture.repoKey}.json`)), true);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
