// Coordinator multiprocess LIFECYCLE tests (election, stale-lock reclamation,
// speculative WRITE, offline requester replay, disjoint EXCLUSIVE, restart
// recovery). The 5/10/32-client persistent release-trace cohorts were extracted
// to sibling files (coordinator-release-trace-{5,10,32}.test.ts) so they can be
// scheduled concurrently (Phase 40 / D70 C3+C4); the shared harness holds every
// helper byte-identically. Test names and bodies here are unchanged.

import assert from 'node:assert/strict';
import { type ChildProcessLite } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { isExactProcessAlive } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { assertNoLeakedCoordinators } from '../helpers/coordinator-process-lifecycle.ts';
import { startServe, readLock, hardKillExactLock, waitFor, waitForCoordinator, closeResult, finishCoordinatorProcessTest, runNegotiationClient, sleep } from '../helpers/coordinator-process-harness.ts';

void describe('coordinator multiprocess lifecycle', () => {
  after(async () => { await assertNoLeakedCoordinators(); });

  void it('elects one writer from concurrent starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-process-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const first = startServe(stateRoot);
    const second = startServe(stateRoot);
    const firstClosed = closeResult(first);
    const secondClosed = closeResult(second);
    let testFailure: unknown = null;
    try {
      await waitFor(() => existsSync(paths.lockPath) && existsSync(paths.capabilityPath));
      const client = new CoordinatorClient({ env, autoStart: false });
      await waitForCoordinator(client);
      const response = await client.query('status');
      assert.equal(response.payload['schema_version'], 'autopilot.coordinator_status.v1');
      const outcome = await Promise.race([
        firstClosed.then((code) => ({ process: 'first', code })),
        secondClosed.then((code) => ({ process: 'second', code })),
        sleep(10_000).then(() => ({ process: 'timeout', code: -1 })),
      ]);
      assert.notEqual(outcome.process, 'timeout');
      assert.equal(outcome.code, 0, 'an exact lifecycle-election loser exits cleanly before attempting writer-guard authority');
      const lock = await readLock(paths.lockPath);
      if (lock === null) throw new Error('missing elected coordinator lock');
      const elected = [first.pid, second.pid].filter((pid) => pid === lock.pid);
      assert.equal(elected.length, 1);
    } catch (error) { testFailure = error; }
    await finishCoordinatorProcessTest({ primaryFailure: testFailure, root, stateRoot, lockPath: paths.lockPath, children: [first, second], label: 'concurrent coordinator election' });
  });

  void it('serializes two exact stale lifecycle-lock reclaimers without a dual writer window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-stale-election-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const predecessor = startServe(stateRoot);
    let first: ChildProcessLite | null = null;
    let second: ChildProcessLite | null = null;
    let testFailure: unknown = null;
    try {
      await waitFor(() => existsSync(paths.lockPath));
      await waitForCoordinator(new CoordinatorClient({ env, autoStart: false }));
      const stale = await readLock(paths.lockPath);
      if (stale === null) throw new Error('missing lifecycle lock before hard stop');
      hardKillExactLock(stale, 'stale lifecycle predecessor');
      await waitFor(() => !isExactProcessAlive(stale.pid, stale.process_start_identity));
      assert.equal((await readLock(paths.lockPath))?.pid, stale.pid, 'hard stop must leave the exact stale identity for elected reclamation');

      first = startServe(stateRoot);
      second = startServe(stateRoot);
      const firstClosed = closeResult(first);
      const secondClosed = closeResult(second);
      await waitForCoordinator(new CoordinatorClient({ env, autoStart: false }));
      const elected = await readLock(paths.lockPath);
      if (elected === null) throw new Error('missing lifecycle lock after serialized reclamation');
      assert.equal([first.pid, second.pid].filter((pid) => pid === elected.pid).length, 1);
      const loser = await Promise.race([
        firstClosed.then((code) => ({ code, pid: first?.pid })),
        secondClosed.then((code) => ({ code, pid: second?.pid })),
        sleep(10_000).then(() => ({ code: -1, pid: -1 })),
      ]);
      assert.equal(loser.code, 0, 'serialized stale-lock reclamation elects one candidate before writer-guard acquisition');
      assert.notEqual(loser.pid, elected.pid);
      assert.equal((await new CoordinatorClient({ env, autoStart: false }).query('doctor')).payload['integrity'], 'ok');
    } catch (error) { testFailure = error; }
    await finishCoordinatorProcessTest({ primaryFailure: testFailure, root, stateRoot, lockPath: paths.lockPath, children: [predecessor, first, second], label: 'stale lifecycle election' });
  });

  void it('grants overlapping speculative WRITE intentions to independent worktree processes without claim negotiation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-speculative-write-process-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const server = startServe(stateRoot);
    let testFailure: unknown = null;
    try {
      await waitFor(() => existsSync(paths.lockPath) && existsSync(paths.capabilityPath));
      await waitForCoordinator(new CoordinatorClient({ env, autoStart: false }));
      const first = runNegotiationClient(stateRoot, 'attach-acquire-write', 'w');
      const second = runNegotiationClient(stateRoot, 'attach-acquire-write', 'x');
      assert.equal(first['outcome'], 'granted');
      assert.equal(second['outcome'], 'granted');
      const firstRun = await new CoordinatorClient({ env, autoStart: false }).query('status', 'repo-process-negotiation', 'run-w');
      const secondRun = await new CoordinatorClient({ env, autoStart: false }).query('status', 'repo-process-negotiation', 'run-x');
      assert.equal(Array.isArray(firstRun.payload['edit_leases']) ? firstRun.payload['edit_leases'].length : -1, 1);
      assert.equal(Array.isArray(secondRun.payload['edit_leases']) ? secondRun.payload['edit_leases'].length : -1, 1);
    } catch (error) { testFailure = error; }
    await finishCoordinatorProcessTest({ primaryFailure: testFailure, root, stateRoot, lockPath: paths.lockPath, children: [server], label: 'speculative write process' });
  });

  void it('replays an offline requester release across a hard coordinator restart before reacquisition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-negotiation-process-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const server = startServe(stateRoot);
    let testFailure: unknown = null;
    try {
      await waitFor(() => existsSync(paths.lockPath) && existsSync(paths.capabilityPath));
      await waitForCoordinator(new CoordinatorClient({ env, autoStart: false }));
      const owner = runNegotiationClient(stateRoot, 'attach-acquire', 'a');
      const requester = runNegotiationClient(stateRoot, 'attach-acquire', 'b');
      assert.equal(owner['outcome'], 'granted');
      assert.equal(requester['outcome'], 'waiting-for-peer-release');
      const release = runNegotiationClient(stateRoot, 'release', 'a', 'group-b');
      assert.equal(release['status'], 'grant-ready');
      const elected = await readLock(paths.lockPath);
      if (elected === null) throw new Error('missing coordinator lock before offline replay kill');
      hardKillExactLock(elected, 'offline replay coordinator');
      await waitFor(async () => {
        const current = await readLock(paths.lockPath);
        return current === null || !isExactProcessAlive(current.pid, current.process_start_identity);
      });
      const restartedClient = new CoordinatorClient({ env });
      const replayStatus = await restartedClient.query('status', 'repo-process-negotiation', 'run-b');
      assert.equal(typeof replayStatus.payload['pending_messages'] === 'number' && replayStatus.payload['pending_messages'] >= 2, true);
      const cursors = replayStatus.payload['mailbox_cursors'];
      assert.equal(Array.isArray(cursors) && cursors.length === 1, true);
      const grant = runNegotiationClient(stateRoot, 'ack', 'b');
      assert.equal(grant['state'], 'granted');
      assert.equal(grant['lease_count'], 2);
      const status = await new CoordinatorClient({ env, autoStart: false }).query('status', 'repo-process-negotiation', 'run-b');
      assert.equal(Array.isArray(status.payload['edit_leases']) ? status.payload['edit_leases'].length : -1, 2);
    } catch (error) { testFailure = error; }
    await finishCoordinatorProcessTest({ primaryFailure: testFailure, root, stateRoot, lockPath: paths.lockPath, children: [server], label: 'offline requester replay' });
  });

  void it('does not synthesize wait edges or deadlocks for disjoint EXCLUSIVE operations in independent processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-disjoint-exclusive-process-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const server = startServe(stateRoot);
    let testFailure: unknown = null;
    try {
      await waitFor(() => existsSync(paths.lockPath) && existsSync(paths.capabilityPath));
      const client = new CoordinatorClient({ env, autoStart: false });
      await waitForCoordinator(client);
      assert.equal(runNegotiationClient(stateRoot, 'attach-acquire-path', 'a', 'group-a-held', 'src/a.ts')['outcome'], 'granted');
      assert.equal(runNegotiationClient(stateRoot, 'attach-acquire-path', 'b', 'group-b-held', 'src/b.ts')['outcome'], 'granted');
      const status = await client.query('status', 'repo-process-negotiation');
      const groups = status.payload['acquisition_groups'];
      assert.equal(Array.isArray(groups) ? groups.filter((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry) && (entry as Readonly<Record<string, unknown>>)['state'] !== 'granted').length : -1, 0);
      const resolutions = status.payload['deadlock_resolutions'];
      assert.equal(Array.isArray(resolutions) ? resolutions.length : -1, 0);
      const escalations = status.payload['escalations'];
      assert.equal(Array.isArray(escalations) ? escalations.length : -1, 0);
    } catch (error) { testFailure = error; }
    await finishCoordinatorProcessTest({ primaryFailure: testFailure, root, stateRoot, lockPath: paths.lockPath, children: [server], label: 'disjoint exclusive process' });
  });


  void it('recovers committed state after a hard coordinator kill and client restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-restart-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const server = startServe(stateRoot);
    let testFailure: unknown = null;
    try {
      await waitFor(() => existsSync(paths.lockPath) && existsSync(paths.capabilityPath));
      const client = new CoordinatorClient({ env });
      await waitForCoordinator(client);
      await client.mutate('attach-run', {
        repoId: 'repo-process-test', workstreamRun: 'run-process-test', sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-process-test',
      }, {
        repo_key: 'repo-process-test', canonical_root: '/tmp/generic-process-repository', git_common_dir: '/tmp/generic-process-repository/.git', autopilot_id: 'autopilot-process-test', workstream: 'process-test', coordination_authority: 'coordinator-edit-leases-v1',
        run_resource: {
          schema_version: 'autopilot.coordination_run_resource.v1', repo_id: 'repo-process-test', workstream_run: 'run-process-test',
          source_repo: '/tmp/generic-process-repository', git_common_dir: '/tmp/generic-process-repository/.git',
          worktree_root: join(stateRoot, 'worktrees', 'repo-process-test'), main_worktree_path: join(stateRoot, 'worktrees', 'repo-process-test', 'active', 'run-process-test', 'main'),
          runtime_root: join(stateRoot, 'worktrees', 'repo-process-test', 'active', 'run-process-test', 'main', '.pi', 'autopilot', 'process-test'),
          branch: 'autopilot/run-process-test', target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null,
          started_at: '2026-07-12T00:00:00.000Z', version: 1,
        },
      });
      const lock = await readLock(paths.lockPath);
      if (lock === null) throw new Error('missing coordinator lock before kill');
      hardKillExactLock(lock, 'restart recovery coordinator');
      await waitFor(async () => {
        const current = await readLock(paths.lockPath);
        return current === null || !isExactProcessAlive(current.pid, current.process_start_identity);
      });
      const recovered = await client.query('status', 'repo-process-test', 'run-process-test');
      const runs = recovered.payload['runs'];
      assert.equal(Array.isArray(runs) ? runs.length : -1, 1);
      const doctor = await client.query('doctor');
      assert.equal(doctor.payload['integrity'], 'ok');
    } catch (error) { testFailure = error; }
    await finishCoordinatorProcessTest({ primaryFailure: testFailure, root, stateRoot, lockPath: paths.lockPath, children: [server], label: 'hard restart recovery' });
  });
});

