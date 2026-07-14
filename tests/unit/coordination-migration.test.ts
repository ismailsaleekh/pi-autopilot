import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { closeAutopilotWorkstream } from '../../src/core/close-runtime.ts';
import { acquireCoordinationGlobalMigrationLock, runCoordinationMigration } from '../../src/core/coordination/migration.ts';
import { ClaimNegotiationClient } from '../../src/core/coordination/negotiation.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { currentBootId, processStartIdentity } from '../../src/core/coordination/process-identity.ts';
import { parseCoordinationMigrationRecoveryWork, parseCoordinationRun, parseCoordinationUnitAttempt } from '../../src/core/coordination/contracts.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { CoordinatorStore, stageCoordinatorSemanticReplay } from '../../src/core/coordination/store.ts';
import { DurableRunSupervisorClient } from '../../src/core/coordination/supervisor.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { coordinationRootForRepo, prepareAutopilotUnitWorktree, prepareAutopilotWorkstream, readActiveAutopilots, readPathClaims, resolveRepoIdentity, writeActiveAutopilots, writePathClaims, type AutopilotPathClaim, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import { migrationTestClock, seedPhase34Schema6Database, terminateExactMigrationFixtureCoordinator, withEmptyMigrationTestFixture, withMigrationTestFixture } from '../helpers/migration-fixture.ts';

void describe('Coordination Fabric legacy migration and cutover', () => {
  void it('inspects an exact live Phase-34 schema-6 WAL copy without changing one source-tree byte or SHM byte', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const databasePath = await seedPhase34Schema6Database(fixture.env);
      const paths = coordinatorRuntimePaths(fixture.env);
      const predecessor = new DatabaseSync(databasePath);
      predecessor.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE schema_migrations SET applied_at=applied_at || '-live-wal' WHERE version=6; BEGIN IMMEDIATE;");
      await writeFile(paths.lockPath, `${JSON.stringify({ schema_version: 'autopilot.coordinator_lock.v1', pid: process.pid, boot_id: currentBootId(), token: 'a'.repeat(48), started_at: '2026-07-12T11:59:00.000Z' })}\n`, 'utf8');
      try {
        assert.equal(existsSync(`${databasePath}-wal`), true);
        assert.equal(existsSync(`${databasePath}-shm`), true);
        const before = await bytes(fixture.stateRoot);
        const temporaryBefore = (await readdir(tmpdir())).filter((entry) => entry.startsWith('autopilot-coordinator-inspection-')).sort();
        const report = await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
        assert.equal(report.dry_run, true);
        assert.deepEqual(await bytes(fixture.stateRoot), before);
        const temporaryAfter = (await readdir(tmpdir())).filter((entry) => entry.startsWith('autopilot-coordinator-inspection-')).sort();
        assert.deepEqual(temporaryAfter, temporaryBefore);
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
          const version = database.prepare('PRAGMA user_version').get();
          assert.equal(version?.['user_version'], 6);
          const phase35Table = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='coordination_migrations'").get();
          assert.equal(phase35Table, undefined);
        } finally { database.close(); }
        assert.equal(existsSync(join(fixture.stateRoot, 'migrations')), false);
      } finally {
        await rm(paths.lockPath, { force: true });
        predecessor.exec('ROLLBACK');
        predecessor.close();
      }
    });
  });

  void it('never auto-starts status during freeze and rejects a live-writer cutover before the one-way marker', async () => {
    await withEmptyMigrationTestFixture(async (fixture) => {
      const paths = coordinatorRuntimePaths(fixture.env);
      assert.equal((await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, repoRoot: fixture.source, env: fixture.env, clock: fixedClock() })).state, 'imported');
      await assert.rejects(
        () => new CoordinatorClient({ env: fixture.env }).query('status', fixture.repoKey, null),
        (error: unknown) => error instanceof Error && /auto-start is forbidden while coordination migration is frozen/u.test(error.message),
      );
      assert.equal(existsSync(paths.lockPath), false, 'status query must not strand a writer during freeze');
      assert.equal((await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, repoRoot: fixture.source, env: fixture.env, clock: fixedClock() })).state, 'cutover-ready');
      const startIdentity = processStartIdentity(process.pid);
      if (startIdentity === null) throw new Error('test process lacks exact birth identity');
      await writeFile(paths.lockPath, `${JSON.stringify({
        schema_version: 'autopilot.coordinator_lock.v2', pid: process.pid, boot_id: currentBootId(), process_start_identity: startIdentity,
        token: 'd'.repeat(48), instance_id: 'e'.repeat(48), package_build: '1.0.3-cf40', protocol_version: '1.3', database_schema_version: 9,
        started_at: '2026-07-12T12:00:00.000Z',
      })}\n`, 'utf8');
      const marker = join(fixture.stateRoot, 'cutovers', `${fixture.repoKey}.json`);
      await assert.rejects(
        () => runCoordinationMigration({ command: 'cutover', repoKey: fixture.repoKey, repoRoot: fixture.source, env: fixture.env, clock: fixedClock() }),
        /could not retire the drained coordinator/u,
      );
      assert.equal(existsSync(marker), false, 'failed election must precede one-way marker publication');
      await rm(paths.lockPath, { force: true });
      assert.equal((await runCoordinationMigration({ command: 'cutover', repoKey: fixture.repoKey, repoRoot: fixture.source, env: fixture.env, clock: fixedClock() })).state, 'legacy-archived');
    });
  });

  void it('rejects arbitrary but well-formed migration checksums at both schema-6 and schema-9 boundaries', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const databasePath = await seedPhase34Schema6Database(fixture.env);
      const database = new DatabaseSync(databasePath);
      try { database.prepare('UPDATE schema_migrations SET checksum=? WHERE version=6').run('f'.repeat(64)); }
      finally { database.close(); }
      await assert.rejects(() => runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() }), /exact locked schema-6\/7\/8\/9\/10 package lineage/u);
    });
    await withMigrationTestFixture(async (fixture) => {
      const paths = coordinatorRuntimePaths(fixture.env);
      const store = await CoordinatorStore.open(paths, migrationTestClock());
      store.close();
      const database = new DatabaseSync(paths.databasePath);
      try { database.prepare('UPDATE schema_migrations SET checksum=? WHERE version=9').run('e'.repeat(64)); }
      finally { database.close(); }
      await assert.rejects(() => runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() }), /exact locked schema-6\/7\/8\/9\/10 package lineage/u);
    });
  });

  void it('dry-runs without mutation, transactionally imports, verifies, and restores the verified pre-import boundary', async () => {
    await withFixture(async (fixture) => {
      const before = await bytes(fixture.stateRoot);
      const dry = await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(dry.dry_run, true);
      assert.equal(dry.rebound_old_epoch_claim_count, 2);
      assert.equal(dry.legacy_claim_count, 2);
      assert.equal(dry.classified_claim_count, 2);
      assert.equal(dry.equivalent_lease_count, 0);
      assert.equal(dry.terminal_leak_count, 1);
      assert.equal(dry.recovery_work_count, 1);
      assert.deepEqual(await bytes(fixture.stateRoot), before);

      const applied = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(applied.state, 'imported');
      assert.equal(applied.imported_lease_count, 1);
      assert.equal(applied.imported_reservation_count, 1);
      const importedStore = await CoordinatorStore.open(coordinatorRuntimePaths(fixture.env), fixedClock());
      try {
        const status = importedStore.status(fixture.repoKey, fixture.workstreamRun);
        assert.equal(Array.isArray(status.payload['change_reservations']) ? status.payload['change_reservations'].length : -1, 1);
        assert.equal(Array.isArray(status.payload['migration_recovery_work']) ? status.payload['migration_recovery_work'].length : -1, 1);
        assert.equal(Array.isArray(status.payload['coordination_migrations']) ? status.payload['coordination_migrations'].length : -1, 1);
        const doctor = importedStore.doctor();
        assert.equal(Array.isArray(doctor.payload['pending_migration_recovery_work']) ? doctor.payload['pending_migration_recovery_work'].length : -1, 1);
        const exportPath = join(dirname(fixture.stateRoot), 'migration-export.json');
        importedStore.exportTo(exportPath);
        const exported = await readFile(exportPath, 'utf8');
        assert.match(exported, /coordination_migrations/u);
        assert.match(exported, /evidence_ref/u);
        assert.match(exported, /evidence_sha256/u);
        assert.match(exported, /exact_git_objects/u);
        assert.match(exported, /filesystem_postconditions/u);
      } finally { importedStore.close(); }
      const verified = await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(verified.state, 'cutover-ready');

      const rolledBack = await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(rolledBack.state, 'rolled-back');
      assert.equal(existsSync(join(fixture.stateRoot, 'migrations', fixture.repoKey, 'freeze.json')), false);
      const store = await CoordinatorStore.open(coordinatorRuntimePaths(fixture.env), fixedClock());
      try {
        const status = store.status(fixture.repoKey, null);
        assert.deepEqual(status.payload['runs'], []);
      } finally { store.close(); }
      const reapplied = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: { now: () => new Date('2026-07-12T12:10:00.000Z') } });
      assert.equal(reapplied.state, 'imported');
      assert.equal(existsSync(join(fixture.stateRoot, 'migrations', fixture.repoKey, 'history', String(rolledBack.migration_id), 'journal.json')), true);
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: { now: () => new Date('2026-07-12T12:11:00.000Z') } });
    });
  });

  void it('BUG-172 inspects a bounded coordinator database larger than the legacy single-file ceiling', async () => {
    await withFixture(async (fixture) => {
      const paths = coordinatorRuntimePaths(fixture.env);
      const store = await CoordinatorStore.open(paths, fixedClock());
      store.close();
      const database = new DatabaseSync(paths.databasePath);
      try {
        database.exec('PRAGMA journal_mode=DELETE; CREATE TABLE migration_bound_filler(payload BLOB); INSERT INTO migration_bound_filler VALUES(zeroblob(73400320)); DROP TABLE migration_bound_filler;');
      } finally { database.close(); }
      assert.equal(statSync(paths.databasePath).size > 64 * 1024 * 1024, true);
      const dry = await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(dry.blockers.length, 0);
    });
  });

  void it('BUG-172 promotes an authentic pre-checkout v1 task projection during one-way cutover', async () => {
    await withFixture(async (fixture) => {
      const root = coordinationRootForRepo(fixture.repoKey, fixture.env);
      const active = (await readActiveAutopilots(root))[0];
      if (active === undefined) throw new Error('missing legacy-v1 active row');
      const taskInfoPath = join(dirname(active.main_worktree_path), '_task-info.json');
      const taskInfo = JSON.parse(await readFile(taskInfoPath, 'utf8')) as Readonly<Record<string, unknown>>;
      const legacy = Object.fromEntries(Object.entries(taskInfo).filter(([field]) => !['checkout_mode', 'checkout_profile_origin', 'checkout_profile_ref', 'checkout_profile_sha256', 'coordination_authority'].includes(field)));
      await writeFile(taskInfoPath, `${JSON.stringify({ ...legacy, schema_version: 'autopilot.task_info.v1' }, null, 2)}\n`, 'utf8');
      await writePathClaims(root, []);
      assert.equal((await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() })).state, 'imported');
      assert.equal((await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() })).state, 'cutover-ready');
      assert.equal((await runCoordinationMigration({ command: 'cutover', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() })).state, 'legacy-archived');
      const promoted = JSON.parse(await readFile(taskInfoPath, 'utf8')) as Readonly<Record<string, unknown>>;
      assert.equal(promoted['schema_version'], 'autopilot.task_info.v2');
      assert.equal(promoted['coordination_authority'], 'coordinator-edit-leases-v1');
    });
  });

  void it('BUG-172 accepts exact pre-checkout v1 task/unit metadata and pre-capture failure evidence without inventing release proof', async () => {
    await withFixture(async (fixture) => {
      const coordinationRoot = coordinationRootForRepo(fixture.repoKey, fixture.env);
      const active = (await readActiveAutopilots(coordinationRoot))[0];
      if (active === undefined) throw new Error('missing legacy-v1 active row');
      const taskRoot = dirname(active.main_worktree_path);
      const taskInfoPath = join(taskRoot, '_task-info.json');
      const taskInfo = JSON.parse(await readFile(taskInfoPath, 'utf8')) as Readonly<Record<string, unknown>>;
      const legacyTaskInfo = Object.fromEntries(Object.entries(taskInfo).filter(([field]) => !['checkout_mode', 'checkout_profile_origin', 'checkout_profile_ref', 'checkout_profile_sha256', 'coordination_authority'].includes(field)));
      await writeFile(taskInfoPath, `${JSON.stringify({ ...legacyTaskInfo, schema_version: 'autopilot.task_info.v1' }, null, 2)}\n`, 'utf8');

      const unitPath = join(taskRoot, 'units', 'legacy-v1-unit', 'attempt-1', 'worktree');
      const unit = { unit_id: 'legacy-v1-unit', attempt: 1, branch: `autopilot/unit/${active.workstream_run}/legacy-v1-unit/attempt-1`, worktree_path: unitPath, base_sha: active.target_base_sha, current_sha: active.target_base_sha, archive_ref: null, status: 'aborted' };
      await writeFile(join(taskRoot, '_unit-index.json'), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [unit] }, null, 2)}\n`, 'utf8');
      const branches = JSON.parse(await readFile(join(taskRoot, '_branches.json'), 'utf8')) as Readonly<Record<string, unknown>>;
      await writeFile(join(taskRoot, '_branches.json'), `${JSON.stringify({ ...branches, unit_branches: [unit] }, null, 2)}\n`, 'utf8');
      await mkdir(dirname(unitPath), { recursive: true });
      await writeFile(join(dirname(unitPath), '_unit-info.json'), `${JSON.stringify({ schema_version: 'autopilot.unit_info.v1', workstream: active.workstream, workstream_run: active.workstream_run, autopilot_id: active.autopilot_id, ...unit, runtime_root: active.runtime_root, created_at: '2026-07-12T11:00:30.000Z' }, null, 2)}\n`, 'utf8');

      await mkdir(join(active.runtime_root, 'quarantine'), { recursive: true });
      await writeFile(join(active.runtime_root, 'quarantine', 'legacy-v1-unit.attempt-1.abort.json'), `${JSON.stringify({ schema_version: 'autopilot.unit_failure.v1', action: 'abort', workstream: active.workstream, workstream_run: active.workstream_run, unit_id: 'legacy-v1-unit', attempt: 1, unit_worktree_path: unitPath, dirty_paths: [], summary: 'pre-capture historical abort evidence', created_at: '2026-07-12T11:04:00.000Z' }, null, 2)}\n`, 'utf8');

      const before = await bytes(fixture.stateRoot);
      const dry = await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(dry.active_run_count, 1);
      assert.equal(dry.imported_worktree_count, 2);
      assert.equal(dry.terminal_leak_count, 1, 'pre-capture evidence must not invent a second terminal release');
      assert.equal(dry.recovery_work_count, 1, 'ambiguous live WRITE authority remains fenced recovery work');
      assert.deepEqual(await bytes(fixture.stateRoot), before, 'legacy compatibility dry-run must remain byte-read-only');
    });
  });

  void it('BUG-172 exposes a recovery CLI that resolves imported authority while migration remains frozen', async () => {
    await withFixture(async (fixture) => {
      const applied = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(applied.state, 'imported');
      assert.equal(applied.recovery_work_count, 1);
      const cli = join(process.cwd(), 'src', 'cli', 'autopilot-coordinator.ts');
      const common = ['--experimental-strip-types', cli, 'recovery'];
      const listed = spawnSync(process.execPath, [...common, 'list', '--state-root', fixture.stateRoot, '--repo-root', join(dirname(fixture.stateRoot), 'source')], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
      assert.equal(listed.status, 0, listed.stderr);
      const listPayload = JSON.parse(listed.stdout) as Readonly<Record<string, unknown>>;
      const recoveryRows = listPayload['recovery'];
      assert.equal(Array.isArray(recoveryRows), true);
      if (!Array.isArray(recoveryRows) || recoveryRows.length !== 1 || typeof recoveryRows[0] !== 'object' || recoveryRows[0] === null) throw new Error('recovery CLI did not list one exact row');
      const recoveryId = (recoveryRows[0] as Readonly<Record<string, unknown>>)['recovery_id'];
      if (typeof recoveryId !== 'string') throw new Error('recovery CLI omitted recovery_id');

      const retained = spawnSync(process.execPath, [...common, 'retain', '--state-root', fixture.stateRoot, '--repo-root', join(dirname(fixture.stateRoot), 'source'), '--run', fixture.workstreamRun, '--recovery-id', recoveryId], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
      assert.equal(retained.status, 0, retained.stderr);
      const retainPayload = JSON.parse(retained.stdout) as Readonly<Record<string, unknown>>;
      assert.equal(retainPayload['outcome'], 'authority-retained');
      assert.equal(retainPayload['remaining_recovery_count'], 0);

      const relisted = spawnSync(process.execPath, [...common, 'list', '--state-root', fixture.stateRoot, '--repo-root', join(dirname(fixture.stateRoot), 'source'), '--run', fixture.workstreamRun], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
      assert.equal(relisted.status, 0, relisted.stderr);
      const relistedPayload = JSON.parse(relisted.stdout) as Readonly<Record<string, unknown>>;
      assert.equal(Array.isArray(relistedPayload['recovery']) ? relistedPayload['recovery'].length : -1, 0);
      const paths = coordinatorRuntimePaths(fixture.env);
      assert.equal(existsSync(paths.lockPath), true, 'recovery CLI must not race another client by retiring the shared coordinator');
      assert.equal((await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() })).state, 'cutover-ready');
      assert.equal(existsSync(paths.lockPath), false, 'verify owns drained coordinator retirement under the migration lock');
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
    });
  });

  void it('merges matching Phase 34 coordinator state instead of rejecting the real mixed migration source', async () => {
    await withFixture(async (fixture) => {
      const coordinationRoot = coordinationRootForRepo(fixture.repoKey, fixture.env);
      const active = (await readActiveAutopilots(coordinationRoot))[0];
      if (active === undefined) throw new Error('missing mixed-state active row');
      const store = await CoordinatorStore.open(coordinatorRuntimePaths(fixture.env), fixedClock());
      try {
        const attached = store.handle({
          schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.5', request_id: 'mixed-attach', action: 'attach-run', idempotency_key: 'mixed-attach',
          repo_id: fixture.repoKey, workstream_run: active.workstream_run, session_id: null, fencing_generation: null, expected_version: 0,
          payload: {
            repo_key: fixture.repoKey, canonical_root: active.source_repo, git_common_dir: active.git_common_dir, autopilot_id: active.autopilot_id, workstream: active.workstream, coordination_authority: 'coordinator-edit-leases-v1',
            run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: fixture.repoKey, workstream_run: active.workstream_run, source_repo: active.source_repo, git_common_dir: active.git_common_dir, worktree_root: active.worktree_root, main_worktree_path: active.main_worktree_path, runtime_root: active.runtime_root, branch: active.branch, target_branch: active.target_branch, target_base_sha: active.target_base_sha, origin_url: active.origin_url, started_at: active.started_at, version: 1 },
          },
        });
        assert.equal(attached.ok, true);
      } finally { store.close(); }
      const applied = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(applied.state, 'imported');
      const verified = await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(verified.state, 'cutover-ready');
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      const restored = await CoordinatorStore.open(coordinatorRuntimePaths(fixture.env), fixedClock());
      try {
        assert.equal(Array.isArray(restored.status(fixture.repoKey, null).payload['runs']) ? (restored.status(fixture.repoKey, null).payload['runs'] as readonly unknown[]).length : -1, 1);
        assert.equal(restored.readMigrationImport(fixture.repoKey), null);
      } finally { restored.close(); }
    });
  });

  void it('atomically promotes a real detached legacy-authority supervisor run during mixed-state import', async () => {
    await withFixture(async (fixture) => {
      const coordinationRoot = coordinationRootForRepo(fixture.repoKey, fixture.env);
      const active = (await readActiveAutopilots(coordinationRoot))[0];
      if (active === undefined) throw new Error('missing legacy supervisor active row');
      const repo = resolveRepoIdentity(active.source_repo);
      const supervisor = new DurableRunSupervisorClient(fixture.env);
      const attachment = await supervisor.attach({ repo, active, rawSessionId: 'legacy-supervisor-before-migration' });
      assert.equal(attachment.run.coordination_authority, 'legacy-path-claims-v1');
      await supervisor.client.mutate('detach-session', {
        repoId: fixture.repoKey, workstreamRun: active.workstream_run, sessionId: attachment.session.session_id,
        fencingGeneration: attachment.session.session_generation, expectedVersion: attachment.session.version,
        idempotencyKey: `detach-before-migration:${attachment.session.session_lease_id}`,
      }, { reason: 'bounded migration drain', session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token });
      const applied = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(applied.state, 'imported');
      const store = await CoordinatorStore.open(coordinatorRuntimePaths(fixture.env), fixedClock());
      try {
        const status = store.status(fixture.repoKey, active.workstream_run).payload;
        const runs = status['runs'];
        const resources = status['run_resources'];
        assert.equal(Array.isArray(runs) && typeof runs[0] === 'object' && runs[0] !== null ? (runs[0] as Readonly<Record<string, unknown>>)['coordination_authority'] : null, 'coordinator-edit-leases-v1');
        assert.equal(Array.isArray(resources) ? resources.length : -1, 1);
      } finally { store.close(); }
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
    });
  });

  void it('preserves mixed terminal coordinator state while fencing unmatched legacy WRITE authority as recovery work', async () => {
    await withFixture(async (fixture) => {
      const coordinationRoot = coordinationRootForRepo(fixture.repoKey, fixture.env);
      const active = (await readActiveAutopilots(coordinationRoot))[0];
      if (active === undefined) throw new Error('missing terminal mixed-state active row');
      const store = await CoordinatorStore.open(coordinatorRuntimePaths(fixture.env), fixedClock());
      try {
        const attached = store.handle({
          schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.5', request_id: 'terminal-mixed-attach', action: 'attach-run', idempotency_key: 'terminal-mixed-attach', repo_id: fixture.repoKey, workstream_run: active.workstream_run, session_id: null, fencing_generation: null, expected_version: 0,
          payload: { repo_key: fixture.repoKey, canonical_root: active.source_repo, git_common_dir: active.git_common_dir, autopilot_id: active.autopilot_id, workstream: active.workstream, coordination_authority: 'coordinator-edit-leases-v1', run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: fixture.repoKey, workstream_run: active.workstream_run, source_repo: active.source_repo, git_common_dir: active.git_common_dir, worktree_root: active.worktree_root, main_worktree_path: active.main_worktree_path, runtime_root: active.runtime_root, branch: active.branch, target_branch: active.target_branch, target_base_sha: active.target_base_sha, origin_url: active.origin_url, started_at: active.started_at, version: 1 } },
        });
        assert.equal(attached.ok, true);
      } finally { store.close(); }
      const database = new DatabaseSync(coordinatorRuntimePaths(fixture.env).databasePath);
      try { database.prepare("UPDATE runs SET status='closed', version=version+1 WHERE repo_id=? AND workstream_run=?").run(fixture.repoKey, active.workstream_run); }
      finally { database.close(); }
      const applied = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(applied.state, 'imported');
      assert.equal(applied.imported_lease_count, 1);
      assert.equal(applied.recovery_work_count >= 1, true);
      const imported = await CoordinatorStore.open(coordinatorRuntimePaths(fixture.env), fixedClock());
      try {
        const status = imported.status(fixture.repoKey, active.workstream_run).payload;
        const runs = status['runs'];
        const leases = status['edit_leases'];
        assert.equal(Array.isArray(runs) && typeof runs[0] === 'object' && runs[0] !== null && !Array.isArray(runs[0]) ? (runs[0] as Readonly<Record<string, unknown>>)['status'] : null, 'closed');
        assert.equal(Array.isArray(leases) ? leases.length : -1, 1);
      } finally { imported.close(); }
      await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      await runCoordinationMigration({ command: 'cutover', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      await assert.rejects(() => prepareAutopilotWorkstream({ workstream: active.workstream, sourceCwd: active.source_repo, coordinationSessionId: 'terminal-ordinary-activation', env: fixture.env }), /fenced until its imported authority recovery is resolved/u);
      const supervisor = new DurableRunSupervisorClient(fixture.env);
      const status = await supervisor.client.query('status', fixture.repoKey, active.workstream_run);
      const recoveryValues = status.payload['migration_recovery_work'];
      if (!Array.isArray(recoveryValues) || recoveryValues[0] === undefined) throw new Error('missing terminal migration recovery');
      const recovery = parseCoordinationMigrationRecoveryWork(recoveryValues[0]);
      const recoveryAttachment = await supervisor.attachMigrationRecovery({ repo: resolveRepoIdentity(active.source_repo), workstreamRun: active.workstream_run, recoveryId: recovery.recovery_id, rawSessionId: 'terminal-recovery-only' });
      assert.equal(recoveryAttachment.run.status, 'closed');
      assert.equal(recoveryAttachment.session.attachment_kind, 'migration-recovery');
    });
  });

  void it('cuts over a nonactive ambiguous WRITE owner, fences activation, and completes retained authority only through a recovery-only supervisor', async () => {
    await withFixture(async (fixture) => {
      const coordinationRoot = coordinationRootForRepo(fixture.repoKey, fixture.env);
      const rows = await readActiveAutopilots(coordinationRoot);
      const active = rows[0];
      if (active === undefined) throw new Error('missing nonactive recovery row');
      await writeActiveAutopilots(coordinationRoot, [{ ...active, status: 'paused' }]);
      await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      await runCoordinationMigration({ command: 'cutover', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      const supervisor = new DurableRunSupervisorClient(fixture.env);
      const status = await supervisor.client.query('status', fixture.repoKey, active.workstream_run);
      const runValues = status.payload['runs'];
      if (!Array.isArray(runValues) || runValues.length !== 1 || runValues[0] === undefined) throw new Error('expected one recovering durable run');
      const recoveringRun = parseCoordinationRun(runValues[0]);
      await assert.rejects(() => supervisor.client.mutate('attach-session', {
        repoId: fixture.repoKey, workstreamRun: active.workstream_run, sessionId: 'ordinary-session-before-recovery', fencingGeneration: recoveringRun.active_session_generation + 1,
        expectedVersion: recoveringRun.version, idempotencyKey: 'ordinary-session-before-recovery',
      }, { session_lease_id: 'ordinary-lease-before-recovery', session_token: 'a'.repeat(64), pid: process.pid, boot_id: currentBootId(), lease_expires_at: '2026-07-12T12:05:00.000Z', handoff_token: null }), /cannot attach ordinary dispatch while migration recovery is pending/u);
      await assert.rejects(() => prepareAutopilotWorkstream({ workstream: active.workstream, sourceCwd: active.source_repo, coordinationSessionId: 'ordinary-activation-before-recovery', env: fixture.env, now: new Date('2026-07-12T12:02:00.000Z') }), /fenced until its imported authority recovery is resolved/u);


      const recoveryValues = status.payload['migration_recovery_work'];
      if (!Array.isArray(recoveryValues) || recoveryValues.length !== 1 || recoveryValues[0] === undefined) throw new Error('expected one pending migration recovery row');
      const recovery = parseCoordinationMigrationRecoveryWork(recoveryValues[0]);
      const staleAttachToken = await supervisor.withMigrationRecoveryAuthority(async (operationToken) => operationToken);
      await assert.rejects(() => supervisor.client.mutate('attach-migration-recovery', {
        repoId: fixture.repoKey, workstreamRun: active.workstream_run, sessionId: 'missing-token-recovery-attach', fencingGeneration: recoveringRun.active_session_generation + 1,
        expectedVersion: recoveringRun.version, idempotencyKey: 'missing-token-recovery-attach',
      }, { recovery_id: recovery.recovery_id, session_lease_id: 'missing-token-recovery-lease', session_token: 'b'.repeat(64), pid: process.pid, boot_id: currentBootId(), lease_expires_at: '2026-07-12T12:05:00.000Z' }), /missing required field migration_operation_token/u);
      await assert.rejects(() => supervisor.withMigrationRecoveryAuthority(async () => await supervisor.client.mutate('attach-migration-recovery', {
        repoId: fixture.repoKey, workstreamRun: active.workstream_run, sessionId: 'stale-token-recovery-attach', fencingGeneration: recoveringRun.active_session_generation + 1,
        expectedVersion: recoveringRun.version, idempotencyKey: 'stale-token-recovery-attach',
      }, { recovery_id: recovery.recovery_id, session_lease_id: 'stale-token-recovery-lease', session_token: 'c'.repeat(64), pid: process.pid, boot_id: currentBootId(), lease_expires_at: '2026-07-12T12:05:00.000Z', migration_operation_token: staleAttachToken })), /not bound to this request/u);
      let attachment = await supervisor.attachMigrationRecovery({ repo: resolveRepoIdentity(active.source_repo), workstreamRun: active.workstream_run, recoveryId: recovery.recovery_id, rawSessionId: 'migration-recovery-supervisor' });
      assert.equal(attachment.session.attachment_kind, 'migration-recovery');
      assert.equal(attachment.run.status, 'recovering');
      await assert.rejects(() => supervisor.client.mutate('reconcile-run', {
        repoId: fixture.repoKey, workstreamRun: active.workstream_run, sessionId: attachment.session.session_id, fencingGeneration: attachment.session.session_generation,
        expectedVersion: attachment.run.version, idempotencyKey: 'recovery-session-cannot-dispatch',
      }, { reason: 'must remain recovery-only', session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token }), /recovery-only session rejects ordinary dispatch/u);
      const initialSessionVersion = attachment.session.version;
      attachment = await supervisor.heartbeatMigrationRecovery(attachment);
      assert.equal(attachment.session.version, initialSessionVersion + 1);
      const staleOperationToken = await supervisor.withMigrationRecoveryAuthority(async (operationToken) => operationToken);
      await assert.rejects(() => supervisor.client.mutate('detach-session', {
        repoId: fixture.repoKey, workstreamRun: active.workstream_run, sessionId: attachment.session.session_id, fencingGeneration: attachment.session.session_generation,
        expectedVersion: attachment.session.version, idempotencyKey: 'missing-token-recovery-detach',
      }, { reason: 'must reject missing operation token', session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token }), /lacks the serialized global recovery operation authority/u);
      await assert.rejects(() => supervisor.withMigrationRecoveryAuthority(async () => await supervisor.client.mutate('detach-session', {
        repoId: fixture.repoKey, workstreamRun: active.workstream_run, sessionId: attachment.session.session_id, fencingGeneration: attachment.session.session_generation,
        expectedVersion: attachment.session.version, idempotencyKey: 'stale-token-recovery-detach',
      }, { reason: 'must reject stale operation token', session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token, migration_operation_token: staleOperationToken })), /not bound to this request/u);
      await assert.rejects(() => supervisor.withMigrationRecoveryAuthority(async () => await supervisor.client.mutate('resolve-migration-recovery', {
        repoId: fixture.repoKey, workstreamRun: active.workstream_run, sessionId: attachment.session.session_id, fencingGeneration: attachment.session.session_generation,
        expectedVersion: recovery.version, idempotencyKey: 'stale-ambient-recovery-authorization',
      }, { recovery_id: recovery.recovery_id, resolution_type: 'authority-retained', evidence_ref: 'missing.json', evidence_sha256: `sha256:${'f'.repeat(64)}`, release_source: null, release_target_id: null, session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token, migration_operation_token: staleOperationToken })), /not bound to this request/u);
      await assert.rejects(() => supervisor.withMigrationRecoveryAuthority(async (operationToken) => await supervisor.client.mutate('resolve-migration-recovery', {
        repoId: fixture.repoKey, workstreamRun: active.workstream_run, sessionId: attachment.session.session_id, fencingGeneration: attachment.session.session_generation,
        expectedVersion: recovery.version, idempotencyKey: 'missing-recovery-evidence',
      }, { recovery_id: recovery.recovery_id, resolution_type: 'authority-retained', evidence_ref: 'missing.json', evidence_sha256: `sha256:${'f'.repeat(64)}`, release_source: null, release_target_id: null, session_lease_id: attachment.session.session_lease_id, session_token: attachment.context.session_token, migration_operation_token: operationToken })), /evidence is unreadable/u);
      const resolved = await supervisor.resolveMigrationRecovery({ attachment, recoveryWork: recovery, resolution: { resolutionType: 'authority-retained' } });
      assert.equal(resolved.recoveryWork.status, 'resolved');
      assert.equal(resolved.recoveryWork.resolution?.resolution_type, 'authority-retained');
      assert.equal(resolved.remainingRecoveryCount, 0);
      assert.equal(resolved.run.status, 'recovering');
      const replayed = await supervisor.resolveMigrationRecovery({ attachment, recoveryWork: recovery, resolution: { resolutionType: 'authority-retained' } });
      assert.equal(replayed.recoveryWork.version, resolved.recoveryWork.version);
      await supervisor.detachMigrationRecovery(attachment);
      await supervisor.detachMigrationRecovery(attachment);

      const prepared = await prepareAutopilotWorkstream({ workstream: active.workstream, sourceCwd: active.source_repo, coordinationSessionId: 'ordinary-activation-after-recovery', env: fixture.env, now: new Date('2026-07-12T12:03:00.000Z') });
      assert.equal(prepared.resumed, true);
      const ordinary = await supervisor.attach({ repo: prepared.repo, active: prepared.active, rawSessionId: 'ordinary-activation-after-recovery' });
      assert.equal(ordinary.session.attachment_kind, 'dispatch');
      assert.equal(ordinary.run.status, 'active');
      const finalStatus = await supervisor.client.query('status', fixture.repoKey, active.workstream_run);
      const leases = finalStatus.payload['edit_leases'];
      assert.equal(Array.isArray(leases) ? leases.length : -1, 1);
    });
  });

  void it('releases reset leaks only with matching immutable attempt evidence', async () => {
    await withFixture(async (fixture) => {
      const coordinationRoot = coordinationRootForRepo(fixture.repoKey, fixture.env);
      const active = (await readActiveAutopilots(coordinationRoot))[0];
      if (active === undefined) throw new Error('missing reset-evidence active row');
      const taskRoot = dirname(active.main_worktree_path);
      const unitPath = join(taskRoot, 'units', 'unit-reset', 'attempt-1', 'worktree');
      const branchInfo = { unit_id: 'unit-reset', attempt: 1, branch: `autopilot/unit/${active.workstream_run}/unit-reset/attempt-1`, worktree_path: unitPath, base_sha: active.target_base_sha, current_sha: active.target_base_sha, archive_ref: null, status: 'aborted' };
      await writeFile(join(taskRoot, '_unit-index.json'), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [branchInfo] }, null, 2)}\n`, 'utf8');
      const branches = JSON.parse(await readFile(join(taskRoot, '_branches.json'), 'utf8')) as Readonly<Record<string, unknown>>;
      await writeFile(join(taskRoot, '_branches.json'), `${JSON.stringify({ ...branches, unit_branches: [branchInfo] }, null, 2)}\n`, 'utf8');
      const claims = await readPathClaims(coordinationRoot);
      await writePathClaims(coordinationRoot, [...claims, { schema_version: 'autopilot.path_claim.v1', path: 'src/reset.ts', autopilot_id: active.autopilot_id, workstream: active.workstream, workstream_run: active.workstream_run, unit_id: 'unit-reset', attempt: 1, claim_type: 'WRITE', acquired_at: '2026-07-12T11:03:00.000Z', active_run_epoch: 1, reason: 'reset terminal proof' }]);
      await mkdir(join(active.runtime_root, 'quarantine'), { recursive: true });
      await writeFile(join(active.runtime_root, 'quarantine', 'unit-reset.attempt-1.reset.json'), `${JSON.stringify({ schema_version: 'autopilot.unit_failure.v1', action: 'reset', workstream: active.workstream, workstream_run: active.workstream_run, unit_id: 'unit-reset', attempt: 1, unit_worktree_path: unitPath, dirty_paths: [], capture_commit_sha: null, summary: 'verified reset', created_at: '2026-07-12T11:04:00.000Z' }, null, 2)}\n`, 'utf8');
      const dry = await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(dry.terminal_leak_count, 2);
      assert.equal(dry.recovery_work_count, 1);
    });
  });

  void it('never releases a claim from an exact merge of a different path, during import or recovery', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const coordinationRoot = coordinationRootForRepo(fixture.repoKey, fixture.env);
      const active = (await readActiveAutopilots(coordinationRoot))[0];
      if (active === undefined) throw new Error('missing claim-path proof active row');
      const before = git(active.main_worktree_path, ['rev-parse', 'HEAD']);
      await writeFile(join(active.main_worktree_path, 'README.md'), '# generic migration repository\n\nUnrelated accepted merge.\n', 'utf8');
      git(active.main_worktree_path, ['add', 'README.md']);
      git(active.main_worktree_path, ['commit', '-m', 'unrelated legacy merge']);
      const after = git(active.main_worktree_path, ['rev-parse', 'HEAD']);
      const evidencePath = join(active.runtime_root, 'unit-merges', 'unit-old-session.implement.attempt-1.json');
      await mkdir(dirname(evidencePath), { recursive: true });
      const evidence = new TextEncoder().encode(`${JSON.stringify({ schema_version: 'autopilot.unit_merge.v1', workstream: active.workstream, workstream_run: active.workstream_run, autopilot_id: active.autopilot_id, active_run_epoch: 1, unit_id: 'unit-old-session', role: 'implement', attempt: 1, unit_branch: `autopilot/unit/${active.workstream_run}/unit-old-session/attempt-1`, main_branch: active.branch, unit_head: after, integration_before: before, integration_after: after, merge_commit_sha: after, changed_paths: ['README.md'], status_ref: 'statuses/unit-old-session.json', receipt_ref: 'receipts/unit-old-session.json', audit_ref: 'execution-audits/unit-old-session.json', execution_commit_ref: 'execution-commits/unit-old-session.json', merged_at: '2026-07-12T11:02:00.000Z' }, null, 2)}\n`);
      await writeFile(evidencePath, evidence);
      const dry = await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(dry.terminal_leak_count, 0);
      assert.equal(dry.recovery_work_count, 1);
      assert.equal(dry.classified_claim_count, 1);
      await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      await runCoordinationMigration({ command: 'cutover', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      const supervisor = new DurableRunSupervisorClient(fixture.env);
      const status = await supervisor.client.query('status', fixture.repoKey, active.workstream_run);
      const values = status.payload['migration_recovery_work'];
      if (!Array.isArray(values) || values[0] === undefined) throw new Error('missing claim-path recovery work');
      const recovery = parseCoordinationMigrationRecoveryWork(values[0]);
      const attachment = await supervisor.attachMigrationRecovery({ repo: resolveRepoIdentity(active.source_repo), workstreamRun: active.workstream_run, recoveryId: recovery.recovery_id, rawSessionId: 'claim-path-recovery' });
      await assert.rejects(() => supervisor.resolveMigrationRecovery({ attachment, recoveryWork: recovery, resolution: { resolutionType: 'authority-released', releaseSource: 'unit-merge', releaseTargetId: 'unit-old-session:1', evidenceBytes: evidence } }), /exact claim\/Git object\/ref\/ancestry\/diff postconditions/u);
      const resolved = await supervisor.resolveMigrationRecovery({ attachment, recoveryWork: recovery, resolution: { resolutionType: 'authority-retained' } });
      assert.equal(resolved.recoveryWork.status, 'resolved');
    });
  });

  void it('keeps authority in recovery when forged terminal evidence does not prove exact Git and filesystem postconditions', async () => {
    await withFixture(async (fixture) => {
      const coordinationRoot = coordinationRootForRepo(fixture.repoKey, fixture.env);
      const active = (await readActiveAutopilots(coordinationRoot))[0];
      if (active === undefined) throw new Error('missing forged-evidence active row');
      const taskRoot = dirname(active.main_worktree_path);
      const unitPath = join(taskRoot, 'units', 'unit-forged', 'attempt-1', 'worktree');
      const branchInfo = { unit_id: 'unit-forged', attempt: 1, branch: `autopilot/unit/${active.workstream_run}/unit-forged/attempt-1`, worktree_path: unitPath, base_sha: active.target_base_sha, current_sha: active.target_base_sha, archive_ref: null, status: 'aborted' };
      await writeFile(join(taskRoot, '_unit-index.json'), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [branchInfo] }, null, 2)}\n`, 'utf8');
      const branches = JSON.parse(await readFile(join(taskRoot, '_branches.json'), 'utf8')) as Readonly<Record<string, unknown>>;
      await writeFile(join(taskRoot, '_branches.json'), `${JSON.stringify({ ...branches, unit_branches: [branchInfo] }, null, 2)}\n`, 'utf8');
      const claims = await readPathClaims(coordinationRoot);
      await writePathClaims(coordinationRoot, [...claims, { schema_version: 'autopilot.path_claim.v1', path: 'src/forged.ts', autopilot_id: active.autopilot_id, workstream: active.workstream, workstream_run: active.workstream_run, unit_id: 'unit-forged', attempt: 1, claim_type: 'WRITE', acquired_at: '2026-07-12T11:03:00.000Z', active_run_epoch: 1, reason: 'forged reset proof must not release authority' }]);
      await mkdir(join(active.runtime_root, 'quarantine'), { recursive: true });
      await writeFile(join(active.runtime_root, 'quarantine', 'unit-forged.attempt-1.reset.json'), `${JSON.stringify({ schema_version: 'autopilot.unit_failure.v1', action: 'reset', workstream: active.workstream, workstream_run: active.workstream_run, unit_id: 'unit-forged', attempt: 1, unit_worktree_path: `${unitPath}-substituted`, dirty_paths: [], capture_commit_sha: null, summary: 'forged path', created_at: '2026-07-12T11:04:00.000Z' }, null, 2)}\n`, 'utf8');
      const dry = await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(dry.legacy_claim_count, 3);
      assert.equal(dry.terminal_leak_count, 1);
      assert.equal(dry.recovery_work_count, 2);
      const applied = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(applied.imported_lease_count, 2);
      assert.equal(applied.classified_claim_count, 3);
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
    });
  });

  void it('migrates an empty legacy repository through apply, verify, rollback, reapply, and cutover using canonical repository identity', async () => {
    await withEmptyMigrationTestFixture(async (fixture) => {
      const dry = await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, repoRoot: fixture.source, env: fixture.env, clock: migrationTestClock() });
      assert.equal(dry.active_run_count, 0);
      assert.equal(dry.legacy_claim_count, 0);
      assert.equal(dry.classified_claim_count, 0);
      const applied = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, repoRoot: fixture.source, env: fixture.env, clock: migrationTestClock() });
      assert.equal(applied.state, 'imported');
      assert.equal(applied.imported_run_count, 0);
      assert.equal(applied.imported_lease_count, 0);
      assert.equal((await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() })).state, 'cutover-ready');
      assert.equal((await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() })).state, 'rolled-back');
      assert.equal((await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, repoRoot: fixture.source, env: fixture.env, clock: { now: () => new Date('2026-07-12T12:01:00.000Z') } })).state, 'imported');
      await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      const cutover = await runCoordinationMigration({ command: 'cutover', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      assert.equal(cutover.state, 'legacy-archived');
      assert.equal(existsSync(join(fixture.stateRoot, 'cutovers', `${fixture.repoKey}.json`)), true);
    });
  });

  void it('uses an existing coordinator repository identity when empty legacy state has no active row and no --repo-root', async () => {
    await withEmptyMigrationTestFixture(async (fixture) => {
      const store = await CoordinatorStore.open(coordinatorRuntimePaths(fixture.env), migrationTestClock());
      const head = git(fixture.source, ['rev-parse', 'HEAD']);
      try {
        const attached = store.handle({
          schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.5', request_id: 'empty-existing-repository', action: 'attach-run', idempotency_key: 'empty-existing-repository', repo_id: fixture.repoKey, workstream_run: 'coordinator-only-run', session_id: null, fencing_generation: null, expected_version: 0,
          payload: { repo_key: fixture.repoKey, canonical_root: fixture.source, git_common_dir: join(fixture.source, '.git'), autopilot_id: 'coordinator-only', workstream: 'coordinator-only', coordination_authority: 'coordinator-edit-leases-v1', run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: fixture.repoKey, workstream_run: 'coordinator-only-run', source_repo: fixture.source, git_common_dir: join(fixture.source, '.git'), worktree_root: join(fixture.stateRoot, 'worktrees', fixture.repoKey), main_worktree_path: fixture.source, runtime_root: join(fixture.source, '.pi', 'autopilot', 'coordinator-only'), branch: git(fixture.source, ['symbolic-ref', '--short', 'HEAD']), target_branch: null, target_base_sha: head, origin_url: null, started_at: '2026-07-12T11:00:00.000Z', version: 1 } },
        });
        assert.equal(attached.ok, true);
      } finally { store.close(); }
      const dry = await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      assert.equal(dry.active_run_count, 0);
      assert.equal((await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() })).state, 'imported');
      assert.equal((await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() })).state, 'cutover-ready');
      assert.equal((await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() })).state, 'rolled-back');
    });
  });

  void it('accepts a durable compatible freeze drain acknowledgement but fails closed for an unacknowledged live client', async () => {
    await withFixture(async (fixture) => {
      const coordinationRoot = join(fixture.stateRoot, 'coordination', fixture.repoKey);
      const rows = await readActiveAutopilots(coordinationRoot);
      const active = rows[0];
      if (active === undefined) throw new Error('missing active migration row');
      await writeActiveAutopilots(coordinationRoot, [{ ...active, pid: process.pid, boot_id: currentBootId() }]);
      const blocked = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(blocked.blockers.some((entry) => entry.includes('has not durably acknowledged')), true);
      const claims = await readPathClaims(coordinationRoot);
      await assert.rejects(() => writePathClaims(coordinationRoot, claims), /migration freeze is active/u);
      const resumed = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(resumed.state, 'imported');
      assert.equal(resumed.blockers.length, 0);
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
    });
  });

  void it('serializes recovery commands against migration retirement with one global operation lock', async () => {
    await withFixture(async (fixture) => {
      const supervisor = new DurableRunSupervisorClient(fixture.env, { allowMigrationRecoveryAutoStart: true });
      const lock = await acquireCoordinationGlobalMigrationLock(fixture.stateRoot);
      try {
        await assert.rejects(
          () => runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() }),
          /another migration process owns the repository migration lock/u,
        );
        await assert.rejects(
          () => supervisor.withMigrationRecoveryAuthority(async () => undefined),
          /another migration process owns the repository migration lock/u,
        );
      } finally { await lock.release(); }

      let markEntered!: () => void;
      let releaseHeld!: () => void;
      const entered = new Promise<void>((resolve) => { markEntered = resolve; });
      const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
      const first = supervisor.withMigrationRecoveryAuthority(async () => { markEntered(); await held; });
      await entered;
      try {
        await assert.rejects(
          () => supervisor.withMigrationRecoveryAuthority(async () => undefined),
          /another migration process owns the repository migration lock/u,
        );
      } finally { releaseHeld(); }
      await first;
    });
  });

  void it('requires a global coordinator drain and rejects cross-repository drain mutations after writer authority', async () => {
    await withFixture(async (fixture) => {
      const active = (await readActiveAutopilots(coordinationRootForRepo(fixture.repoKey, fixture.env)))[0];
      if (active === undefined) throw new Error('missing active row');
      const foreignRepo = `sha256-${'f'.repeat(64)}`;
      const store = await CoordinatorStore.open(coordinatorRuntimePaths(fixture.env), fixedClock());
      try {
        const attachedRun = store.handle({ schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.5', request_id: 'foreign-run', action: 'attach-run', idempotency_key: 'foreign-run', repo_id: foreignRepo, workstream_run: 'foreign-run', session_id: null, fencing_generation: null, expected_version: 0, payload: { repo_key: foreignRepo, canonical_root: active.source_repo, git_common_dir: active.git_common_dir, autopilot_id: 'foreign', workstream: 'foreign', coordination_authority: 'coordinator-edit-leases-v1', run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: foreignRepo, workstream_run: 'foreign-run', source_repo: active.source_repo, git_common_dir: active.git_common_dir, worktree_root: active.worktree_root, main_worktree_path: active.main_worktree_path, runtime_root: active.runtime_root, branch: active.branch, target_branch: active.target_branch, target_base_sha: active.target_base_sha, origin_url: active.origin_url, started_at: active.started_at, version: 1 } } });
        assert.equal(attachedRun.ok, true);
        const attachedSession = store.handle({ schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.5', request_id: 'foreign-session', action: 'attach-session', idempotency_key: 'foreign-session', repo_id: foreignRepo, workstream_run: 'foreign-run', session_id: 'foreign-session', fencing_generation: 1, expected_version: 1, payload: { boot_id: currentBootId(), handoff_token: null, lease_expires_at: '2026-07-12T12:30:00.000Z', pid: process.pid, session_lease_id: 'foreign-session-lease', session_token: 'f'.repeat(64) } });
        assert.equal(attachedSession.ok, true);
      } finally { store.close(); }
      const blocked = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(blocked.state, 'frozen');
      assert.equal(blocked.blockers.some((value) => value.includes(`${foreignRepo}:foreign-run:foreign-session-lease`)), true);
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
    });

    await withEmptyMigrationTestFixture(async (fixture) => {
      assert.equal((await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, repoRoot: fixture.source, env: fixture.env, clock: fixedClock() })).state, 'imported');
      const secondSource = join(fixture.root, 'second-source');
      await mkdir(secondSource, { recursive: true });
      await writeFile(join(secondSource, 'README.md'), 'second repository\n', 'utf8');
      git(secondSource, ['init']); git(secondSource, ['config', 'user.email', 'test@example.invalid']); git(secondSource, ['config', 'user.name', 'Test']); git(secondSource, ['add', '.']); git(secondSource, ['commit', '-m', 'initial']);
      const secondRepo = resolveRepoIdentity(secondSource);
      const frozenBytes = await bytes(fixture.stateRoot);
      await assert.rejects(() => runCoordinationMigration({ command: 'dry-run', repoKey: secondRepo.repoKey, repoRoot: secondSource, env: fixture.env, clock: fixedClock() }), /dry-run is forbidden while a global coordination migration freeze is active/u);
      await assert.rejects(() => runCoordinationMigration({ command: 'apply', repoKey: secondRepo.repoKey, repoRoot: secondSource, env: fixture.env, clock: fixedClock() }), /another repository already owns the global coordination migration freeze/u);
      assert.deepEqual(await bytes(fixture.stateRoot), frozenBytes, 'foreign migration admission must not touch shared authority bytes');
      const store = await CoordinatorStore.open(coordinatorRuntimePaths(fixture.env), fixedClock());
      try {
        const denied = store.handle({ schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.5', request_id: 'foreign-heartbeat-after-backup', action: 'heartbeat', idempotency_key: 'foreign-heartbeat-after-backup', repo_id: `sha256-${'e'.repeat(64)}`, workstream_run: 'foreign-run', session_id: 'foreign-session', fencing_generation: 1, expected_version: 1, payload: { lease_expires_at: '2026-07-12T12:30:00.000Z', session_lease_id: 'foreign-session-lease', session_token: 'e'.repeat(64) } });
        assert.equal(denied.ok, false);
        assert.equal(denied.error_code, 'coordinator-contention');
        assert.match(String(denied.payload['message']), /after global migration writer authority was acquired/u);
      } finally { store.close(); }
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
    });
  });

  void it('defers semantic replay and startup recovery across the global rollback boundary', async () => {
    await withEmptyMigrationTestFixture(async (fixture) => {
      assert.equal((await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, repoRoot: fixture.source, env: fixture.env, clock: fixedClock() })).state, 'imported');
      const paths = coordinatorRuntimePaths(fixture.env);
      const foreignRepo = `sha256-${'d'.repeat(64)}`;
      const head = git(fixture.source, ['rev-parse', 'HEAD']);
      await stageCoordinatorSemanticReplay(paths, 'freeze-deferred-replay', [{
        schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.5', request_id: 'freeze-deferred-run', action: 'attach-run', idempotency_key: 'freeze-deferred-run', repo_id: foreignRepo, workstream_run: 'freeze-deferred-run', session_id: null, fencing_generation: null, expected_version: 0,
        payload: { repo_key: foreignRepo, canonical_root: fixture.source, git_common_dir: join(fixture.source, '.git'), autopilot_id: 'freeze-deferred', workstream: 'freeze-deferred', coordination_authority: 'coordinator-edit-leases-v1', run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: foreignRepo, workstream_run: 'freeze-deferred-run', source_repo: fixture.source, git_common_dir: join(fixture.source, '.git'), worktree_root: join(fixture.stateRoot, 'worktrees', foreignRepo), main_worktree_path: fixture.source, runtime_root: join(fixture.source, '.pi', 'autopilot', 'freeze-deferred'), branch: git(fixture.source, ['symbolic-ref', '--short', 'HEAD']), target_branch: null, target_base_sha: head, origin_url: null, started_at: '2026-07-12T12:00:00.000Z', version: 1 } },
      }]);
      const frozenStore = await CoordinatorStore.open(paths, fixedClock());
      try { assert.deepEqual(frozenStore.status(foreignRepo, null).payload['runs'], []); }
      finally { frozenStore.close(); }
      assert.equal(existsSync(paths.semanticReplayPath), true, 'frozen startup must preserve pending replay bytes');
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      const resumedStore = await CoordinatorStore.open(paths, fixedClock());
      try {
        const runs = resumedStore.status(foreignRepo, null).payload['runs'];
        assert.equal(Array.isArray(runs) ? runs.length : -1, 1);
      } finally { resumedStore.close(); }
      assert.equal(existsSync(paths.semanticReplayPath), false, 'unfrozen startup consumes the preserved replay');
    });
  });

  void it('retires a drained current coordinator automatically before transactional import', async () => {
    await withFixture(async (fixture) => {
      const paths = coordinatorRuntimePaths(fixture.env);
      await new CoordinatorClient({ env: fixture.env }).query('status');
      assert.equal(existsSync(paths.lockPath), true);
      const applied = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(applied.state, 'imported');
      assert.equal(existsSync(paths.lockPath), false);
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
    });
  });

  void it('freezes dispatch and refuses a reachable legacy process instead of racing it', async () => {
    await withFixture(async (fixture) => {
      const coordinationRoot = join(fixture.stateRoot, 'coordination', fixture.repoKey);
      const rows = await readActiveAutopilots(coordinationRoot);
      const active = rows[0];
      if (active === undefined) throw new Error('missing active migration row');
      await writeActiveAutopilots(coordinationRoot, [{ ...active, pid: process.pid, boot_id: currentBootId() }]);
      const blocked = await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(blocked.state, 'frozen');
      assert.equal(blocked.blockers.some((entry) => entry.includes('reachable legacy client')), true);
      assert.equal(existsSync(join(fixture.stateRoot, 'migrations', fixture.repoKey, 'freeze.json')), true);
      const server = await startCoordinatorServer(coordinatorRuntimePaths(fixture.env), fixedClock());
      try {
        const client = new CoordinatorClient({ env: fixture.env, autoStart: false });
        await assert.rejects(() => client.mutate('attach-run', { repoId: fixture.repoKey, workstreamRun: 'forbidden-during-freeze', sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'forbidden-during-freeze' }, {
          repo_key: fixture.repoKey, canonical_root: join(dirname(fixture.stateRoot), 'source'), git_common_dir: join(dirname(fixture.stateRoot), 'source', '.git'), autopilot_id: 'forbidden', workstream: 'forbidden', coordination_authority: 'coordinator-edit-leases-v1',
          run_resource: {
            schema_version: 'autopilot.coordination_run_resource.v1', repo_id: fixture.repoKey, workstream_run: 'forbidden-during-freeze',
            source_repo: join(dirname(fixture.stateRoot), 'source'), git_common_dir: join(dirname(fixture.stateRoot), 'source', '.git'), worktree_root: join(fixture.stateRoot, 'worktrees', fixture.repoKey),
            main_worktree_path: join(fixture.stateRoot, 'worktrees', fixture.repoKey, 'active', 'forbidden-during-freeze', 'main'), runtime_root: join(fixture.stateRoot, 'worktrees', fixture.repoKey, 'active', 'forbidden-during-freeze', 'main', '.pi', 'autopilot', 'forbidden'),
            branch: 'autopilot/forbidden-during-freeze', target_branch: 'main', target_base_sha: '0'.repeat(40), origin_url: null,
            started_at: '2026-07-12T12:00:00.000Z', version: 1,
          },
        }), /migration freeze is active/u);
      } finally { await server.close(); }
      const rollback = await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(rollback.state, 'rolled-back');
      assert.equal(existsSync(join(fixture.stateRoot, 'migrations', fixture.repoKey, 'freeze.json')), false);
    });
  });

  void it('commits a one-way marker, archives legacy mutable truth read-only, and rejects rollback', async () => {
    await withFixture(async (fixture) => {
      await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      const cutover = await runCoordinationMigration({ command: 'cutover', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() });
      assert.equal(cutover.state, 'legacy-archived');
      const marker = join(fixture.stateRoot, 'cutovers', `${fixture.repoKey}.json`);
      assert.equal(existsSync(marker), true);
      assert.equal(existsSync(join(fixture.stateRoot, 'coordination', fixture.repoKey, 'path-claims.json')), false);
      const archive = join(fixture.stateRoot, 'migrations', fixture.repoKey, 'legacy-archive', 'coordination', fixture.repoKey, 'path-claims.json');
      assert.equal(existsSync(archive), true);
      await assert.rejects(() => prepareAutopilotWorkstream({ workstream: 'forbidden-unmanaged-post-cutover', sourceCwd: join(dirname(fixture.stateRoot), 'source'), env: fixture.env, now: new Date('2026-07-12T12:00:30.000Z') }), /requires a durable coordinator session/u);
      const server = await startCoordinatorServer(coordinatorRuntimePaths(fixture.env), fixedClock());
      try {
        const supervisor = new DurableRunSupervisorClient(fixture.env);
        const recoveryStatus = await supervisor.client.query('status', fixture.repoKey, fixture.workstreamRun);
        const recoveryValues = recoveryStatus.payload['migration_recovery_work'];
        if (!Array.isArray(recoveryValues) || recoveryValues[0] === undefined) throw new Error('missing retained-authority recovery work');
        const recovery = parseCoordinationMigrationRecoveryWork(recoveryValues[0]);
        const recoveryAttachment = await supervisor.attachMigrationRecovery({ repo: resolveRepoIdentity(join(dirname(fixture.stateRoot), 'source')), workstreamRun: fixture.workstreamRun, recoveryId: recovery.recovery_id, rawSessionId: 'cutover-recovery-only' });
        await supervisor.resolveMigrationRecovery({ attachment: recoveryAttachment, recoveryWork: recovery, resolution: { resolutionType: 'authority-retained' } });
        await supervisor.detachMigrationRecovery(recoveryAttachment, 'cutover recovery completed');
        const resumed = await prepareAutopilotWorkstream({ workstream: 'migration-proof', sourceCwd: join(dirname(fixture.stateRoot), 'source'), coordinationSessionId: 'post-cutover-session', env: fixture.env, now: new Date('2026-07-12T12:01:00.000Z') });
        assert.equal(resumed.resumed, true);
        assert.equal(resumed.active.coordination_authority, 'coordinator-edit-leases-v1');
        assert.equal(existsSync(join(fixture.stateRoot, 'coordination', fixture.repoKey, 'active-autopilots.json')), false);
        const attachment = await supervisor.attach({ repo: resumed.repo, active: resumed.active, rawSessionId: 'rebound-claim-session' });
        const postCutoverEnv = { ...fixture.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
        const unitWorktree = await prepareAutopilotUnitWorktree({ active: resumed.active, unitId: 'post-cutover-unit', attempt: 1, env: postCutoverEnv, now: new Date('2026-07-12T12:01:30.000Z') });
        assert.equal(unitWorktree.created, true);
        assert.equal(existsSync(unitWorktree.unitInfo.worktree_path), true);
        assert.equal(existsSync(join(fixture.stateRoot, 'worktrees', fixture.repoKey, '_ledger.jsonl')), false);
        const negotiation = new ClaimNegotiationClient(supervisor.client, attachment.context);
        const reboundStatus = await supervisor.client.query('status', fixture.repoKey, fixture.workstreamRun);
        const attempts = reboundStatus.payload['unit_attempts'];
        if (!Array.isArray(attempts)) throw new Error('post-cutover unit attempts are missing');
        const migratedAttempt = attempts.map((entry) => parseCoordinationUnitAttempt(entry)).find((entry) => entry.owner.unit_id === 'unit-old-session' && entry.owner.attempt === 1);
        if (migratedAttempt === undefined) throw new Error('exact migrated attempt is missing before rebound');
        const rebound = await negotiation.acquire({ acquisitionGroupId: 'current-runner-group', unitId: 'unit-old-session', attempt: 1, requestedLeases: [{ path: 'src/future.ts', mode: 'WRITE', purpose: 'resumed exact old-session authority' }], acquisitionKind: 'initial', reason: 'resume valid migrated attempt', normalReleaseCondition: { condition_type: 'unit-merged', target_id: 'unit-old-session:1', evidence: null }, specRef: migratedAttempt.spec.ref, specSha256: migratedAttempt.spec.sha256, role: 'implement', preemptible: true, checkpointOrdinal: 0 });
        assert.equal(rebound.outcome, 'granted');
        if (rebound.outcome !== 'granted') throw new Error('migrated authority did not rebound');
        assert.equal(rebound.acquisitionGroup.acquisition_kind, 'legacy-unknown');
        assert.equal(rebound.editLeases.length, 1);
        const closeDryRun = await closeAutopilotWorkstream({ workstream: resumed.active.workstream, workstreamRun: resumed.active.workstream_run, sourceCwd: resumed.repo.repoRoot, dryRun: true, env: postCutoverEnv, now: new Date('2026-07-12T12:02:00.000Z') });
        assert.equal(closeDryRun.outcome, 'dry-run');
      } finally { await server.close(); }
      await assert.rejects(() => runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: fixedClock() }), /rollback is forbidden/u);
      if (platform() !== 'win32') {
        await assert.rejects(() => writeFile(archive, 'mutation', 'utf8'));
      } else {
        const attributes = spawnSync('attrib', [archive], { encoding: 'utf8' });
        assert.equal(attributes.status, 0, attributes.stderr);
        assert.match(attributes.stdout, /\bR\b/u, 'Windows archive must retain the read-only attribute');
        const before = await readFile(archive);
        for (const source of [
          "require('node:fs').writeFileSync(process.argv[1], 'replacement')",
          "require('node:fs').appendFileSync(process.argv[1], 'append')",
        ]) {
          const mutation = spawnSync(process.execPath, ['-e', source, archive], { encoding: 'utf8' });
          assert.notEqual(mutation.status, 0, `Windows read-only archive mutation unexpectedly succeeded: ${source}`);
          assert.deepEqual(await readFile(archive), before);
        }
      }
    });
  });
});

interface Fixture {
  readonly stateRoot: string;
  readonly repoKey: string;
  readonly workstreamRun: string;
  readonly env: ProcessEnvLike;
}

function fixedClock(): { readonly now: () => Date } { return { now: () => new Date('2026-07-12T12:00:00.000Z') }; }

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-migration-'));
  const source = join(root, 'source');
  const stateRoot = join(root, 'state');
  const env: ProcessEnvLike = { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot };
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
    const terminalLeak: AutopilotPathClaim = { ...claim, path: 'README.md', unit_id: 'unit-merged', reason: 'terminal merge leak proof' };
    await writePathClaims(coordinationRoot, [claim, terminalLeak]);
    const integrationBefore = git(prepared.mainWorktreePath, ['rev-parse', 'HEAD']);
    await writeFile(join(prepared.mainWorktreePath, 'README.md'), '# generic migration repository\n\nAccepted legacy unit merge.\n', 'utf8');
    git(prepared.mainWorktreePath, ['add', 'README.md']);
    git(prepared.mainWorktreePath, ['commit', '-m', 'legacy accepted unit merge']);
    const integrationAfter = git(prepared.mainWorktreePath, ['rev-parse', 'HEAD']);
    await mkdir(join(prepared.runtimeRoot, 'unit-merges'), { recursive: true });
    await writeFile(join(prepared.runtimeRoot, 'unit-merges', 'unit-merged.implement.attempt-1.json'), `${JSON.stringify({ schema_version: 'autopilot.unit_merge.v1', workstream: dormant.workstream, workstream_run: dormant.workstream_run, autopilot_id: dormant.autopilot_id, active_run_epoch: 1, unit_id: 'unit-merged', role: 'implement', attempt: 1, unit_branch: `autopilot/unit/${dormant.workstream_run}/unit-merged/attempt-1`, main_branch: dormant.branch, unit_head: integrationAfter, integration_before: integrationBefore, integration_after: integrationAfter, merge_commit_sha: integrationAfter, changed_paths: ['README.md'], status_ref: 'statuses/unit-merged.json', receipt_ref: 'receipts/unit-merged.json', audit_ref: 'execution-audits/unit-merged.json', execution_commit_ref: 'execution-commits/unit-merged.json', merged_at: '2026-07-12T11:02:00.000Z' }, null, 2)}\n`, 'utf8');
    await run({ stateRoot, repoKey: prepared.active.repo_key, workstreamRun: prepared.active.workstream_run, env });
  } finally {
    await terminateExactMigrationFixtureCoordinator(stateRoot);
    await makeRemovable(root);
    await rm(root, { recursive: true, force: true });
  }
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

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function bytes(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  await walk(root);
  const rows: string[] = [];
  for (const path of paths.sort()) rows.push(`${path.slice(root.length)}:${createHash('sha256').update(await readFile(path)).digest('hex')}`);
  return rows;
}
