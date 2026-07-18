import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationRun, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { resolveCanonicalIdentityFault } from '../../src/core/coordination/identity-fault-resolution.ts';
import { currentBootId } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import { readCurrentStoreGeneration } from '../../src/core/coordination/store-generation.ts';
import type { CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import type { CoordinationOwnerIdentity, CoordinationWorktree, CoordinationWorktreeOperation } from '../../src/core/coordination/types.ts';
import { deterministicWorktreeId } from '../../src/core/coordination/worktree-identity.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function retireTestPublicationToExactSchema12(paths: ReturnType<typeof coordinatorRuntimePaths>): Promise<void> {
  const store = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-16T00:00:00.000Z') });
  store.close();
  const fixed = new DatabaseSync(paths.databasePath);
  try {
    for (const row of fixed.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'autopilot_s1_deny_%' ORDER BY name").all()) {
      const name = row['name'];
      if (typeof name !== 'string' || !/^autopilot_s1_deny_[a-f0-9]{20}_(insert|update|delete)$/u.test(name)) throw new Error('fixture found an unknown fixed-path trigger');
      fixed.exec(`DROP TRIGGER "${name}"`);
    }
    fixed.exec('DROP TABLE autopilot_s1_fixed_path_barrier');
  } finally { fixed.close(); }
  await rm(paths.currentStorePointerPath, { force: true });
  await rm(paths.storesRoot, { recursive: true, force: true });
  await mkdir(paths.storesRoot, { recursive: true, mode: 0o700 });
}

void describe('I3 audited canonical identity fault resolution', () => {
  void it('mechanically resolves exact twins, audits once, replays, survives restart, and unblocks safe dispatch', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-autopilot-s1-identity-resolution-')));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const repoId = 'repo-identity-resolution';
    const run = 'run-identity-resolution';
    const autopilotId = 'autopilot-identity-resolution';
    const unitId = 'unit-identity-resolution';
    const repo = join(root, 'repository');
    const worktreeRoot = join(stateRoot, 'worktrees', repoId);
    const worktreePath = join(worktreeRoot, 'active', run, 'units', unitId, 'attempt-1', 'worktree');
    const branch = `autopilot/unit/${run}/${unitId}/attempt-1`;
    let server: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      await mkdir(repo, { recursive: true });
      git(repo, ['init']);
      git(repo, ['config', 'user.email', 'autopilot@example.invalid']);
      git(repo, ['config', 'user.name', 'Autopilot Test']);
      await writeFile(join(repo, 'tracked.txt'), 'identity resolution fixture\n', 'utf8');
      git(repo, ['add', 'tracked.txt']);
      git(repo, ['commit', '-m', 'identity resolution fixture']);
      const head = git(repo, ['rev-parse', 'HEAD']);
      await mkdir(join(worktreePath, '..'), { recursive: true });
      git(repo, ['worktree', 'add', '-b', branch, worktreePath, head]);
      const gitCommonDir = await realpath(join(repo, '.git'));

      await retireTestPublicationToExactSchema12(paths);
      const owner: CoordinationOwnerIdentity = { repo_id: repoId, autopilot_id: autopilotId, workstream_run: run, unit_id: unitId, attempt: 1 };
      const canonicalId = deterministicWorktreeId(owner, 'unit');
      const historicalId = 'migration-worktree-identity-resolution';
      const common = { owner, kind: 'unit' as const, canonical_path: worktreePath, git_common_dir: gitCommonDir, branch, state: 'active' as const, version: 1 };
      const canonical: CoordinationWorktree = { schema_version: 'autopilot.coordination_worktree.v2', worktree_id: canonicalId, ...common };
      const historical: CoordinationWorktree = { schema_version: 'autopilot.coordination_worktree.v2', worktree_id: historicalId, ...common };
      const historicalDigest = `sha256:${'a'.repeat(64)}` as const;
      const operation: CoordinationWorktreeOperation = {
        schema_version: 'autopilot.worktree_operation.v2', operation_id: 'historical-identity-resolution-operation', worktree_id: historicalId, owner,
        operation_type: 'materialize', stage: 'committed', authority_version: 1, intent_event_seq: 1,
        intent: { repo_root: repo, worktree_path: worktreePath, git_common_dir: gitCommonDir, branch, reason: 'historical twin identity resolution fixture', base_sha: head, target_sha: null, archive_ref: null, checkout_mode: 'full', sparse_patterns: [], paths: [], metadata_refs: [] },
        completed_steps: ['registered'], current_step: null, recovery_attempts: 0, verification_evidence: { ref: 'historical/identity-resolution.json', sha256: historicalDigest }, error_code: null, version: 1,
      };
      const runResource = {
        schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: run, source_repo: repo, git_common_dir: gitCommonDir,
        worktree_root: worktreeRoot, main_worktree_path: join(worktreeRoot, 'active', run, 'main'), runtime_root: join(worktreeRoot, 'active', run, 'main', '.pi', 'autopilot', 'identity-resolution'),
        branch: `autopilot/${run}`, target_branch: null, target_base_sha: head, origin_url: null, started_at: '2026-07-16T00:00:00.000Z', version: 1,
      };
      const fixed = new DatabaseSync(paths.databasePath);
      try {
        fixed.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
        fixed.prepare('INSERT INTO repositories(repo_id,repo_key,canonical_root,git_common_dir,event_seq,created_event_seq,version) VALUES(?,?,?,?,1,1,1)').run(repoId, repoId, repo, gitCommonDir);
        fixed.prepare("INSERT INTO runs(repo_id,autopilot_id,workstream,workstream_run,status,active_session_generation,created_event_seq,version,coordination_authority) VALUES(?,?,?,?,'recovering',0,1,1,'coordinator-edit-leases-v1')").run(repoId, autopilotId, 'identity-resolution', run);
        fixed.prepare('INSERT INTO run_resources(entity_id,repo_id,workstream_run,payload_json,version) VALUES(?,?,?,?,1)').run(`run-resource:${repoId}:${run}`, repoId, run, canonicalJson(runResource));
        fixed.prepare("INSERT INTO events(repo_id,event_seq,event_type,entity_type,entity_id,idempotency_key,request_sha256,occurred_at) VALUES(?,1,'historical-seed','repository',?,'historical-seed',?,'2026-07-15T23:59:59.000Z')").run(repoId, repoId, historicalDigest);
        for (const worktree of [canonical, historical]) fixed.prepare('INSERT INTO worktrees(entity_id,repo_id,workstream_run,payload_json,version) VALUES(?,?,?,?,1)').run(worktree.worktree_id, repoId, run, canonicalJson(worktree));
        fixed.prepare('INSERT INTO worktree_operations(entity_id,repo_id,workstream_run,payload_json,version) VALUES(?,?,?,?,1)').run(operation.operation_id, repoId, run, canonicalJson(operation));
        fixed.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
      } catch (error) {
        if (fixed.isTransaction) fixed.exec('ROLLBACK');
        throw error;
      } finally { fixed.close(); }

      const migrated = await CoordinatorStore.open(paths, { now: () => new Date('2026-07-16T00:00:01.000Z') });
      try {
        const faults = migrated.negotiatedRunScopedFaults(repoId, run);
        assert.equal(faults.length, 1);
        assert.equal(faults[0]?.invariant_id, 'F3-SEMANTIC-UNIQUENESS');
      } finally { migrated.close(); }

      server = await startCoordinatorServer(paths);
      const client = new CoordinatorClient({ env, autoStart: false });
      const sessionId = 'session-identity-resolution';
      const leaseId = 'lease-identity-resolution';
      const sessionToken = createHash('sha256').update('identity-resolution-session').digest('hex');
      const attached = await client.mutate('attach-session', {
        repoId, workstreamRun: run, sessionId, fencingGeneration: 1, expectedVersion: 1, idempotencyKey: 'attach-identity-resolution-session',
      }, { session_lease_id: leaseId, session_token: sessionToken, pid: process.pid, boot_id: currentBootId(), lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });
      const attachedRun = parseCoordinationRun(attached.payload['run']);
      const attachedSession = parseCoordinationSessionLease(attached.payload['session']);
      const session: CoordinatorSessionContext = {
        schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: repoId, repo_key: repoId, autopilot_id: autopilotId,
        workstream: 'identity-resolution', workstream_run: run, session_id: sessionId, session_generation: 1, run_version: attachedRun.version,
        session_lease_id: leaseId, session_token: sessionToken, session_version: attachedSession.version, pid: process.pid, boot_id: currentBootId(),
      };
      const attemptPayload = { unit_id: 'safe-next-unit', attempt: 1, spec_ref: 'unit-specs/safe-next-unit.json', spec_sha256: `sha256:${'b'.repeat(64)}`, role: 'fix', preemptible: true, checkpoint_ordinal: 0, session_lease_id: leaseId, session_token: sessionToken };
      await assert.rejects(() => client.mutate('register-attempt', {
        repoId, workstreamRun: run, sessionId, fencingGeneration: 1, expectedVersion: attachedRun.version, idempotencyKey: 'blocked-before-identity-resolution',
      }, attemptPayload), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'recovery-required');

      const statusBefore = await client.query('status', repoId, run);
      const recoveryBefore = statusBefore.payload['negotiated_identity_recovery'];
      const aliasesBefore = statusBefore.payload['negotiated_worktree_aliases'];
      assert.equal(Array.isArray(recoveryBefore), true);
      assert.equal(Array.isArray(aliasesBefore), true);
      assert.equal(Array.isArray(aliasesBefore) && typeof aliasesBefore[0] === 'object' && aliasesBefore[0] !== null ? (aliasesBefore[0] as Record<string, unknown>)['alias_worktree_id'] : null, historical.worktree_id);
      assert.equal(Array.isArray(aliasesBefore) && typeof aliasesBefore[0] === 'object' && aliasesBefore[0] !== null ? (aliasesBefore[0] as Record<string, unknown>)['canonical_worktree_id'] : null, canonical.worktree_id);
      const faultId = Array.isArray(recoveryBefore) && typeof recoveryBefore[0] === 'object' && recoveryBefore[0] !== null ? (recoveryBefore[0] as Record<string, unknown>)['fault_id'] : null;
      if (typeof faultId !== 'string') throw new Error('negotiated identity recovery omitted its fault ID');
      git(repo, ['update-ref', '-d', `refs/heads/${branch}`]);
      await assert.rejects(() => resolveCanonicalIdentityFault({ client, session, fault_id: faultId }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'recovery-required');
      const stillFaulted = await client.query('status', repoId, run);
      assert.equal(Array.isArray(stillFaulted.payload['run_scoped_logical_faults']) ? stillFaulted.payload['run_scoped_logical_faults'].length : -1, 1, 'missing external branch truth must not clear the run fence');
      git(repo, ['update-ref', `refs/heads/${branch}`, head]);
      const first = await resolveCanonicalIdentityFault({ client, session, fault_id: faultId });
      assert.equal(first.fault.status, 'resolved');
      assert.equal(first.replayed, false);
      const replay = await resolveCanonicalIdentityFault({ client, session, fault_id: faultId });
      assert.equal(replay.replayed, true);
      assert.equal(replay.fault.resolved_event_seq, first.fault.resolved_event_seq);
      assert.equal(replay.evidence_ref, first.evidence_ref);

      await client.mutate('register-attempt', {
        repoId, workstreamRun: run, sessionId, fencingGeneration: 1, expectedVersion: attachedRun.version, idempotencyKey: 'safe-dispatch-after-identity-resolution',
      }, attemptPayload);
      const statusAfter = await client.query('status', repoId, run);
      assert.deepEqual(statusAfter.payload['run_scoped_logical_faults'], []);
      const recoveryAfter = statusAfter.payload['negotiated_identity_recovery'];
      assert.equal(Array.isArray(recoveryAfter), true);
      const recoveredFault = Array.isArray(recoveryAfter) && typeof recoveryAfter[0] === 'object' && recoveryAfter[0] !== null ? (recoveryAfter[0] as Record<string, unknown>)['fault'] : null;
      assert.equal(typeof recoveredFault === 'object' && recoveredFault !== null ? (recoveredFault as Record<string, unknown>)['status'] : null, 'resolved');

      await server.close();
      server = null;
      const generation = await readCurrentStoreGeneration(paths);
      if (generation === null) throw new Error('resolved identity-fault store generation disappeared');
      const inspect = new DatabaseSync(generation.database_path, { readOnly: true });
      try {
        assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='run-scoped-fault-resolved' AND entity_type='run-scoped-fault' AND entity_id=?").get(faultId)?.['count'], 1);
        const row = inspect.prepare("SELECT results.payload_json FROM events JOIN idempotency_results results ON results.repo_id=events.repo_id AND results.idempotency_key=events.idempotency_key AND results.committed_event_seq=events.event_seq WHERE events.event_type='run-scoped-fault-resolved' AND events.entity_id=?").get(faultId);
        assert.equal(typeof row?.['payload_json'], 'string');
        const payload = JSON.parse(row?.['payload_json'] as string) as Record<string, unknown>;
        assert.equal((payload['run_scoped_fault'] as Record<string, unknown>)['status'], 'resolved');
        assert.equal((payload['identity_resolution'] as Record<string, unknown>)['resolution'], 'exact-canonical-routing-confirmed');
      } finally { inspect.close(); }
      const reopened = await CoordinatorStore.open(paths);
      try {
        assert.equal(reopened.negotiatedRunScopedFaults(repoId, run).length, 0);
        assert.deepEqual(reopened.negotiatedWorktreeAliases(repoId, run).map((alias) => [alias.alias_worktree_id, alias.canonical_worktree_id]), [[historical.worktree_id, canonical.worktree_id]]);
        const projection = reopened.negotiatedIdentityRecovery(repoId, run);
        assert.equal((projection[0]?.['fault'] as Record<string, unknown>)['status'], 'resolved');
        const exportRequest = (requestId: string, outputPath: string) => ({
          schema_version: 'autopilot.coordinator_request.v1' as const, protocol_version: '1.6' as const, request_id: requestId, action: 'export' as const, idempotency_key: null,
          repo_id: repoId, workstream_run: run, session_id: null, fencing_generation: null, expected_version: null, payload: { output_path: outputPath },
        });
        const legacyExportPath = join(root, 'legacy-identity-export.json');
        const negotiatedExportPath = join(root, 'negotiated-identity-export.json');
        assert.equal(reopened.handle(exportRequest('legacy-identity-export', legacyExportPath), 'cf50-legacy').ok, true);
        assert.equal(reopened.handle(exportRequest('negotiated-identity-export', negotiatedExportPath), 'negotiated-s1').ok, true);
        assert.equal((await readFile(legacyExportPath, 'utf8')).includes('identity_resolution'), false, 'anonymous cf50 export must not expose S1 identity-resolution vocabulary');
        assert.equal((await readFile(negotiatedExportPath, 'utf8')).includes('identity_resolution'), true, 'negotiated S1 export must retain exact identity-resolution audit history');
      } finally { reopened.close(); }
      const tamper = new DatabaseSync(generation.database_path);
      try {
        tamper.prepare("UPDATE idempotency_results SET payload_json='{}' WHERE repo_id=? AND idempotency_key=(SELECT idempotency_key FROM events WHERE repo_id=? AND event_type='run-scoped-fault-resolved' AND entity_id=?)").run(repoId, repoId, faultId);
      } finally { tamper.close(); }
      await assert.rejects(() => CoordinatorStore.open(paths), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'store-corrupt');
    } finally {
      if (server !== null) await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
