import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { runCoordinationMigration, COORDINATION_MIGRATION_MAX_JSONL_LINE_BYTES } from '../../src/core/coordination/migration.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { coordinationRootForRepo, readActiveAutopilots, readPathClaims, writePathClaims, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import { runMigrationRecoveryCli } from '../../src/cli/migration-recovery.ts';
import { writeCoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { migrationTestClock, withMigrationTestFixture } from '../helpers/migration-fixture.ts';

async function fixtureActive(fixture: { repoKey: string; env: ProcessEnvLike }): Promise<Awaited<ReturnType<typeof readActiveAutopilots>>[number]> {
  const row = (await readActiveAutopilots(coordinationRootForRepo(fixture.repoKey, fixture.env)))[0];
  if (row === undefined) throw new Error('missing fixture active row');
  return row;
}

// BUG-172: sanitized historical-ingress, scale, runtime-state, and stale-session witnesses.
void describe('real legacy corpus migration compatibility', () => {
  void it('accepts the exact checkout-era v1 and coordination-only v2 task generations while rejecting partial generations', async () => {
    for (const generation of ['checkout-v1', 'coordination-v2'] as const) {
      await withMigrationTestFixture(async (fixture) => {
        const active = await fixtureActive(fixture);
        const path = join(dirname(active.main_worktree_path), '_task-info.json');
        const current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        if (generation === 'checkout-v1') {
          delete current['coordination_authority'];
          current['schema_version'] = 'autopilot.task_info.v1';
        } else {
          for (const field of ['checkout_mode', 'checkout_profile_origin', 'checkout_profile_ref', 'checkout_profile_sha256']) delete current[field];
          current['schema_version'] = 'autopilot.task_info.v2';
        }
        await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
        assert.equal((await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() })).active_run_count, 1);
        current['checkout_mode'] = 'legacy-full';
        delete current['checkout_profile_sha256'];
        await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
        await assert.rejects(() => runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() }), /partial checkout metadata generation/u);
      });
    }
  });

  void it('accepts terminal unit-index advancement over immutable creation metadata and fences a missing active branch row', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const active = await fixtureActive(fixture);
      const taskRoot = dirname(active.main_worktree_path);
      const unitPath = join(taskRoot, 'units', 'legacy-orphan', 'attempt-1', 'worktree');
      const terminal = { unit_id: 'legacy-orphan', attempt: 1, branch: `autopilot/unit/${active.workstream_run}/legacy-orphan/attempt-1`, worktree_path: unitPath, base_sha: active.target_base_sha, current_sha: active.target_base_sha, archive_ref: null, status: 'aborted' };
      await writeFile(join(taskRoot, '_unit-index.json'), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [terminal] }, null, 2)}\n`, 'utf8');
      const branches = JSON.parse(await readFile(join(taskRoot, '_branches.json'), 'utf8')) as Record<string, unknown>;
      await writeFile(join(taskRoot, '_branches.json'), `${JSON.stringify({ ...branches, unit_branches: [terminal] }, null, 2)}\n`, 'utf8');
      await mkdir(dirname(unitPath), { recursive: true });
      await writeFile(join(dirname(unitPath), '_unit-info.json'), `${JSON.stringify({ schema_version: 'autopilot.unit_info.v1', workstream: active.workstream, workstream_run: active.workstream_run, autopilot_id: active.autopilot_id, ...terminal, status: 'active', runtime_root: active.runtime_root, created_at: '2026-07-12T11:00:30.000Z' }, null, 2)}\n`, 'utf8');
      assert.equal((await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() })).active_run_count, 1);

      const orphan = { ...terminal, unit_id: 'missing-branch-row', branch: `autopilot/unit/${active.workstream_run}/missing-branch-row/attempt-1`, worktree_path: join(taskRoot, 'units', 'missing-branch-row', 'attempt-1', 'worktree'), status: 'active' };
      await writeFile(join(taskRoot, '_unit-index.json'), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [orphan] }, null, 2)}\n`, 'utf8');
      await writeFile(join(taskRoot, '_branches.json'), `${JSON.stringify({ ...branches, unit_branches: [] }, null, 2)}\n`, 'utf8');
      const root = coordinationRootForRepo(fixture.repoKey, fixture.env);
      const claim = (await readPathClaims(root))[0];
      if (claim === undefined) throw new Error('missing fixture claim');
      await writePathClaims(root, [{ ...claim, unit_id: orphan.unit_id }]);
      const dry = await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      assert.equal(dry.recovery_work_count, 1);
      assert.equal(dry.imported_lease_count, 1);
    });
  });

  void it('accepts bounded historical JSONL lines above 64 KiB and rejects lines above the published ceiling', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const active = await fixtureActive(fixture);
      const path = join(coordinationRootForRepo(fixture.repoKey, fixture.env), 'claim-events.jsonl');
      const event = { schema_version: 'autopilot.claim_event.v1', event: 'rejected', ts: '2026-07-12T11:02:00.000Z', repo_key: fixture.repoKey, autopilot_id: active.autopilot_id, workstream: active.workstream, workstream_run: active.workstream_run, active_run_epoch: 2, reason: 'bounded historical conflict', blockers: Array.from({ length: 100 }, () => 'x'.repeat(1024)) };
      await writeFile(path, `${JSON.stringify(event)}\n`, 'utf8');
      assert.equal((await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() })).active_run_count, 1);
      event.blockers = Array.from({ length: Math.ceil(COORDINATION_MIGRATION_MAX_JSONL_LINE_BYTES / 1024) + 8 }, () => 'x'.repeat(1024));
      await writeFile(path, `${JSON.stringify(event)}\n`, 'utf8');
      await assert.rejects(() => runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() }), /JSONL line bound exceeded/u);
    });
  });

  void it('preserves supplemental historical adjudication evidence without treating it as terminal release proof', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const active = await fixtureActive(fixture);
      const quarantine = join(active.runtime_root, 'quarantine');
      await mkdir(quarantine, { recursive: true });
      await writeFile(join(quarantine, 'legacy-adjudication.json'), `${JSON.stringify({ schema_version: 'autopilot.unit_index_adjudication.v1', workstream: active.workstream, workstream_run: active.workstream_run, unit_id: 'unit-old-session', attempt: 1, action: 'align_branches_snapshot_with_quarantined_unit_index_status', reason: 'preserved historical adjudication only', branches_ref: '_branches.json', unit_index_ref: '_unit-index.json', unit_info_ref: 'units/unit-old-session/attempt-1/_unit-info.json', transport_failure_ref: 'evidence/failure.log', created_at: '2026-07-12T11:03:00.000Z' }, null, 2)}\n`, 'utf8');
      const dry = await runCoordinationMigration({ command: 'dry-run', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      assert.equal(dry.terminal_leak_count, 0);
      assert.equal(dry.recovery_work_count, 1);
    });
  });

  void it('BUG-172 bulk-retains every explicitly reviewed claim through one recovery-only fenced attachment', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const active = await fixtureActive(fixture);
      const root = coordinationRootForRepo(fixture.repoKey, fixture.env);
      const claim = (await readPathClaims(root))[0];
      if (claim === undefined) throw new Error('missing fixture claim');
      await writePathClaims(root, Array.from({ length: 1014 }, (_, index) => ({ ...claim, path: `bulk/path-${String(index).padStart(4, '0')}.ts`, acquired_at: '2026-07-12T11:01:01.000Z' })));
      await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      const result = await runMigrationRecoveryCli(['retain-authority', '--state-root', fixture.stateRoot, '--repo-root', fixture.source, '--run', active.workstream_run, '--all'], fixture.env);
      assert.equal(result['resolved_count'], 1014);
      assert.equal(result['remaining_recovery_count'], 0);
      const paths = coordinatorRuntimePaths(fixture.env);
      assert.equal(await new CoordinatorClient({ env: fixture.env, autoStart: false }).query('doctor').then((response) => response.payload['healthy']), true);
      assert.equal((await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() })).state, 'cutover-ready');
      assert.equal(existsSync(paths.lockPath), false);
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
    });
  });

  void it('drains an exact dead handoff-pending session through package-owned authority instead of editing coordinator storage', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const active = await fixtureActive(fixture);
      const store = await CoordinatorStore.open(coordinatorRuntimePaths(fixture.env), migrationTestClock());
      const sessionId = 'dead-handoff-session';
      const leaseId = 'dead-handoff-lease';
      const token = 'a'.repeat(64);
      try {
        store.handle({ schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.3', request_id: 'dead-handoff-run', action: 'attach-run', idempotency_key: 'dead-handoff-run', repo_id: fixture.repoKey, workstream_run: active.workstream_run, session_id: null, fencing_generation: null, expected_version: 0, payload: { repo_key: fixture.repoKey, canonical_root: active.source_repo, git_common_dir: active.git_common_dir, autopilot_id: active.autopilot_id, workstream: active.workstream, coordination_authority: 'coordinator-edit-leases-v1', run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: fixture.repoKey, workstream_run: active.workstream_run, source_repo: active.source_repo, git_common_dir: active.git_common_dir, worktree_root: active.worktree_root, main_worktree_path: active.main_worktree_path, runtime_root: active.runtime_root, branch: active.branch, target_branch: active.target_branch, target_base_sha: active.target_base_sha, origin_url: active.origin_url, started_at: active.started_at, version: 1 } } });
        store.handle({ schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.3', request_id: 'dead-handoff-attach', action: 'attach-session', idempotency_key: 'dead-handoff-attach', repo_id: fixture.repoKey, workstream_run: active.workstream_run, session_id: sessionId, fencing_generation: 1, expected_version: 1, payload: { boot_id: 'prior-boot', handoff_token: null, lease_expires_at: '2026-07-12T11:30:00.000Z', pid: 999_999_999, session_lease_id: leaseId, session_token: token } });
        store.handle({ schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.3', request_id: 'dead-handoff-prepare', action: 'prepare-handoff', idempotency_key: 'dead-handoff-prepare', repo_id: fixture.repoKey, workstream_run: active.workstream_run, session_id: sessionId, fencing_generation: 1, expected_version: 1, payload: { handoff_token: 'dead-handoff-token', session_lease_id: leaseId, session_token: token } });
      } finally { store.close(); }
      const contextPath = join(coordinatorRuntimePaths(fixture.env).sessionsRoot, 'dead-handoff.json');
      await writeCoordinatorSessionContext(contextPath, { schema_version: 'autopilot.coordinator_session_context.v1', state_root: fixture.stateRoot, repo_id: fixture.repoKey, repo_key: fixture.repoKey, autopilot_id: active.autopilot_id, workstream: active.workstream, workstream_run: active.workstream_run, session_id: sessionId, session_generation: 1, run_version: 2, session_lease_id: leaseId, session_token: token, session_version: 2, pid: 999_999_999, boot_id: 'prior-boot' });
      const result = await runMigrationRecoveryCli(['drain-stale-sessions', '--state-root', fixture.stateRoot, '--repo-root', fixture.source, '--run', active.workstream_run], fixture.env);
      assert.equal(result['drained_count'], 1);
      const status = await new CoordinatorClient({ env: fixture.env, autoStart: false }).query('status', fixture.repoKey, active.workstream_run);
      const sessions = status.payload['session_leases'];
      assert.equal(Array.isArray(sessions) && typeof sessions[0] === 'object' && sessions[0] !== null ? (sessions[0] as Record<string, unknown>)['status'] : null, 'detached');
      assert.equal((await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() })).state, 'imported');
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
    });
  });

  void it('imports historical runtime pause state instead of making a dormant parent dispatch-active', async () => {
    await withMigrationTestFixture(async (fixture) => {
      const active = await fixtureActive(fixture);
      await writePathClaims(coordinationRootForRepo(fixture.repoKey, fixture.env), []);
      await mkdir(active.runtime_root, { recursive: true });
      await writeFile(join(active.runtime_root, 'state.json'), `${JSON.stringify({ schema_version: 'autopilot.state.v1', workstream: active.workstream, updated_at: '2026-07-12T11:04:00.000Z', status: 'paused', context_gate: { gate: 'ok', percent: 20 }, last_event_id: 1, last_decision_id: 1, ready_queue: [], running: [], blocked: [], completed: [], notes: 'historical paused state', operator_questions: ['legacy operator packet'], next_actions: [], units: {} }, null, 2)}\n`, 'utf8');
      await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
      const store = await CoordinatorStore.open(coordinatorRuntimePaths(fixture.env), migrationTestClock());
      try {
        const runs = store.status(fixture.repoKey, active.workstream_run).payload['runs'];
        assert.equal(Array.isArray(runs) && typeof runs[0] === 'object' && runs[0] !== null ? (runs[0] as Record<string, unknown>)['status'] : null, 'paused');
      } finally { store.close(); }
      await runCoordinationMigration({ command: 'rollback', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
    });
  });
});
