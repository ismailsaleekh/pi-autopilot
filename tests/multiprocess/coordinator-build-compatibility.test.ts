import assert from 'node:assert/strict';
import { mkdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationAcquisitionGroup } from '../../src/core/coordination/contracts.ts';
import { CoordinatorFrameDecoder, encodeCoordinatorFrame } from '../../src/core/coordination/ipc.ts';
import { ClaimNegotiationClient } from '../../src/core/coordination/negotiation.ts';
import { isProcessAlive, processStartIdentity } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { coordinatorUpgradeIntentPath, preparePredecessorCoordinatorUpgrade } from '../../src/core/coordination/upgrade.ts';
import type { CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { hardKillProcess } from '../helpers/hard-kill-process.ts';
import { runTaggedCli, startTaggedCoordinator } from '../helpers/tagged-coordinator.ts';

interface JsonMap { readonly [key: string]: unknown }

function record(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as JsonMap;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

async function lockRecord(path: string): Promise<JsonMap> {
  return record(JSON.parse(await readFile(path, 'utf8')) as unknown, 'coordinator lock');
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onListening = (): void => { server.off('error', rejectListen); resolveListen(); };
    server.once('error', rejectListen);
    server.once('listening', onListening);
    server.listen(path);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
}

function historicalUpgradeIntent(state: 'committed' | 'starting', packageBuild = '1.0.1-cf38'): JsonMap {
  return {
    schema_version: 'autopilot.coordinator_upgrade_intent.v1', upgrade_id: 'upgrade-bug-175-historical', state,
    source: { package_build: '0.13.0-cf34', protocol_version: '1.2', database_schema_version: 6, pid: 999_999, boot_id: 'historical-boot', process_start_identity: 'historical-process', lock_token: 'historical-token', lock_started_at: '2026-07-12T00:00:00.000Z' },
    target: { package_build: packageBuild, protocol_version: '1.3', database_schema_version: 9, lifecycle_lock_schema: 'autopilot.coordinator_lock.v2' },
    safe_checkpoints: [], blockers: [], predecessor_fence: null, backup: null,
    created_at: '2026-07-12T00:00:00.000Z', updated_at: '2026-07-12T00:00:01.000Z', failure: null,
  };
}

async function attachDurableRunAndSession(client: CoordinatorClient, stateRoot: string): Promise<CoordinatorSessionContext> {
  const runResponse = await client.mutate('attach-run', {
    repoId: 'repo-bug-175', workstreamRun: 'run-bug-175', sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'BUG-175-attach-run',
  }, {
    repo_key: 'repo-bug-175', canonical_root: '/tmp/bug-175-repository', git_common_dir: '/tmp/bug-175-repository/.git', autopilot_id: 'autopilot-bug-175', workstream: 'bug-175', coordination_authority: 'coordinator-edit-leases-v1',
    run_resource: {
      schema_version: 'autopilot.coordination_run_resource.v1', repo_id: 'repo-bug-175', workstream_run: 'run-bug-175',
      source_repo: '/tmp/bug-175-repository', git_common_dir: '/tmp/bug-175-repository/.git', worktree_root: '/tmp/bug-175-state/worktrees/repo-bug-175',
      main_worktree_path: '/tmp/bug-175-state/worktrees/repo-bug-175/active/run-bug-175/main', runtime_root: '/tmp/bug-175-state/worktrees/repo-bug-175/active/run-bug-175/main/.pi/autopilot/bug-175',
      branch: 'autopilot/run-bug-175', target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null, started_at: '2026-07-14T00:00:00.000Z', version: 1,
    },
  });
  const run = record(runResponse.payload['run'], 'attached run');
  const runVersion = run['version'];
  if (typeof runVersion !== 'number') throw new Error('attached run version is not numeric');
  const sessionResponse = await client.mutate('attach-session', {
    repoId: 'repo-bug-175', workstreamRun: 'run-bug-175', sessionId: 'session-bug-175', fencingGeneration: 1, expectedVersion: runVersion, idempotencyKey: 'BUG-175-attach-session',
  }, {
    session_lease_id: 'session-lease-bug-175', session_token: 'a'.repeat(64), pid: process.pid, boot_id: 'boot-bug-175', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null,
  });
  const attachedRun = record(sessionResponse.payload['run'], 'session attached run');
  const session = record(sessionResponse.payload['session'], 'attached session');
  const attachedRunVersion = attachedRun['version'];
  const sessionVersion = session['version'];
  if (typeof attachedRunVersion !== 'number' || typeof sessionVersion !== 'number') throw new Error('attached durable versions are invalid');
  return {
    schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: 'repo-bug-175', repo_key: 'repo-bug-175',
    autopilot_id: 'autopilot-bug-175', workstream: 'bug-175', workstream_run: 'run-bug-175', session_id: 'session-bug-175', session_generation: 1,
    run_version: attachedRunVersion, session_lease_id: 'session-lease-bug-175', session_token: 'a'.repeat(64), session_version: sessionVersion, pid: process.pid, boot_id: 'boot-bug-175',
  };
}

function acquisitionInput(input: { readonly groupId: string; readonly unitId: string; readonly mode: 'READ' | 'WRITE'; readonly role: 'strategy' | 'implement' }) {
  return {
    acquisitionGroupId: input.groupId, unitId: input.unitId, attempt: 1,
    requestedLeases: [{ path: 'plans/shared.md', mode: input.mode, purpose: `${input.unitId} mixed-build authority` }],
    reason: `${input.unitId} requires mixed-build authority`, normalReleaseCondition: { condition_type: 'unit-merged' as const, target_id: `${input.unitId}:1`, evidence: null },
    specRef: `.pi/autopilot/bug-175/unit-specs/${input.unitId}.json`, specSha256: `sha256:${input.mode === 'READ' ? 'b' : 'c'}${'0'.repeat(63)}` as `sha256:${string}`,
    role: input.role, preemptible: true, checkpointOrdinal: 0,
  };
}

void describe('BUG-175 mixed patch-build coordinator continuity', () => {
  void it('uses the actual v1.0.1 coordinator for new v1.0.3 requests without replacing it or disrupting old clients', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-bug-175-live-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const tagged = await startTaggedCoordinator({ stateRoot, extractionRoot: root });
    try {
      const before = await lockRecord(tagged.paths.lockPath);
      assert.equal(before['package_build'], '1.0.1-cf38');
      assert.equal(before['pid'], tagged.child.pid);

      const clients = [new CoordinatorClient({ env }), new CoordinatorClient({ env })];
      const handshakes = await Promise.all(clients.map(async (client) => await client.query('handshake')));
      assert.deepEqual(handshakes.map((response) => response.payload['package_build']), ['1.0.1-cf38', '1.0.1-cf38']);
      const context = await attachDurableRunAndSession(clients[0] as CoordinatorClient, stateRoot);
      const negotiation = new ClaimNegotiationClient(clients[0] as CoordinatorClient, context);
      const owner = await negotiation.acquire(acquisitionInput({ groupId: 'group-bug-175-owner', unitId: 'legacy-owner', mode: 'READ', role: 'strategy' }));
      assert.equal(owner.outcome, 'granted');
      const requester = await negotiation.acquire(acquisitionInput({ groupId: 'group-bug-175-requester', unitId: 'current-requester', mode: 'WRITE', role: 'implement' }));
      assert.equal(requester.outcome, 'waiting-for-peer-release');
      if (requester.outcome !== 'waiting-for-peer-release') throw new Error('mixed-build requester did not enter durable negotiation');
      const request = requester.claimRequests[0];
      if (request === undefined) throw new Error('mixed-build requester has no claim request');
      const released = await negotiation.respondById({ requestId: request.request_id, response: 'release-now', ownerReason: 'same-run historical READ authority is no longer required', releaseCondition: null });
      assert.equal(released.status, 'grant-ready');
      const status = await clients[0]?.query('status', context.repo_id, context.workstream_run);
      if (status === undefined) throw new Error('mixed-build status is missing');
      const readyGroupValue = array(status.payload['acquisition_groups'], 'mixed-build groups').find((entry) => record(entry, 'mixed-build group')['acquisition_group_id'] === 'group-bug-175-requester');
      if (readyGroupValue === undefined) throw new Error('mixed-build requester group disappeared');
      const granted = await negotiation.acknowledgeGrant(parseCoordinationAcquisitionGroup(readyGroupValue));
      assert.equal(granted.acquisitionGroup.state, 'granted');
      assert.deepEqual(granted.editLeases.map((lease) => [lease.path, lease.mode]), [['plans/shared.md', 'WRITE']]);

      const after = await lockRecord(tagged.paths.lockPath);
      assert.deepEqual(after, before, 'a known compatible live coordinator must retain exact lifecycle authority');
      const oldStatus = runTaggedCli(tagged.packageRoot, stateRoot, ['status', '--repo-id', 'repo-bug-175', '--run', 'run-bug-175']);
      assert.equal(oldStatus['package_build'], '1.0.1-cf38', 'the old client must remain compatible with its still-running broker');
      assert.equal(array(oldStatus['runs'], 'old status runs').length, 1);
      assert.equal(array(oldStatus['session_leases'], 'old status sessions').length, 1);
    } finally {
      await tagged.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('re-attests after replacement and sends the mutation on the exact socket that returned the compatible handshake', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-bug-175-reattest-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const tagged = await startTaggedCoordinator({ stateRoot, extractionRoot: root });
    const client = new CoordinatorClient({ env });
    let fake: Server | null = null;
    try {
      assert.equal((await client.query('handshake')).payload['package_build'], '1.0.1-cf38');
      await tagged.close();
      let connectionCount = 0;
      const events: Array<readonly [number, string]> = [];
      fake = createServer((socket) => {
        const connectionId = ++connectionCount;
        const decoder = new CoordinatorFrameDecoder();
        socket.on('data', (chunk: NodeBuffer) => {
          for (const frame of decoder.push(chunk)) {
            const transport = record(frame, 'compatible replacement transport');
            const request = record(transport['request'], 'compatible replacement request');
            const requestId = request['request_id'];
            const action = request['action'];
            if (typeof requestId !== 'string' || typeof action !== 'string') throw new Error('compatible replacement received malformed request identity');
            events.push([connectionId, action]);
            socket.write(encodeCoordinatorFrame({
              schema_version: 'autopilot.coordinator_response.v1', protocol_version: '1.3', request_id: requestId, ok: true,
              committed_event_seq: action === 'handshake' ? null : 1, error_code: null, retryable: false,
              payload: action === 'handshake'
                ? { schema_version: 'autopilot.coordinator_handshake.v1', package_build: '1.0.1-cf38', protocol_version: '1.3', database_schema_version: 9 }
                : { accepted: true },
            }));
          }
        });
      });
      await listen(fake, tagged.paths.socketPath);
      const response = await client.mutate('heartbeat', {
        repoId: 'repo-same-socket', workstreamRun: 'run-same-socket', sessionId: 'session-same-socket', fencingGeneration: 1, expectedVersion: 0, idempotencyKey: 'BUG-175-same-socket-mutation',
      }, { session_lease_id: 'lease-same-socket', session_token: 'd'.repeat(64), lease_expires_at: '2099-01-01T00:00:00.000Z' });
      assert.equal(response.committed_event_seq, 1);
      assert.equal(connectionCount, 1, 'handshake and mutation must not open separate endpoint connections');
      assert.deepEqual(events, [[1, 'handshake'], [1, 'heartbeat']]);
    } finally {
      if (fake !== null) await closeServer(fake);
      await tagged.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('sends no operation frame to a responding replacement with an unknown build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-bug-175-unknown-'));
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') };
    const paths = coordinatorRuntimePaths(env);
    await mkdir(paths.coordinatorRoot, { recursive: true });
    const actions: string[] = [];
    const fake = createServer((socket) => {
      const decoder = new CoordinatorFrameDecoder();
      socket.on('data', (chunk: NodeBuffer) => {
        for (const frame of decoder.push(chunk)) {
          const transport = record(frame, 'unknown server transport');
          const request = record(transport['request'], 'unknown server request');
          const requestId = request['request_id'];
          const action = request['action'];
          if (typeof requestId !== 'string' || typeof action !== 'string') throw new Error('unknown server received malformed request identity');
          actions.push(action);
          socket.write(encodeCoordinatorFrame({
            schema_version: 'autopilot.coordinator_response.v1', protocol_version: '1.3', request_id: requestId, ok: true,
            committed_event_seq: null, error_code: null, retryable: false,
            payload: { schema_version: 'autopilot.coordinator_handshake.v1', package_build: 'unknown-cf99', protocol_version: '1.3', database_schema_version: 9 },
          }));
        }
      });
    });
    try {
      await listen(fake, paths.socketPath);
      await assert.rejects(() => new CoordinatorClient({ env }).mutate('heartbeat', {
        repoId: 'repo-never-sent', workstreamRun: 'run-never-sent', sessionId: 'session-never-sent', fencingGeneration: 1, expectedVersion: 0, idempotencyKey: 'BUG-175-never-send-mutation',
      }, { session_lease_id: 'lease-never-sent', session_token: 'f'.repeat(64), lease_expires_at: '2099-01-01T00:00:00.000Z' }), /outside the closed protocol-1\.3\/schema-9 compatibility lineage/u);
      assert.deepEqual(actions, ['handshake']);
    } finally {
      await closeServer(fake);
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('never reinterprets a live compatible current coordinator fence as the schema-6 predecessor when its socket is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-bug-175-live-no-socket-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const startIdentity = processStartIdentity(process.pid);
    if (startIdentity === null) throw new Error('test process start identity is unavailable');
    const currentLock = { schema_version: 'autopilot.coordinator_lock.v2', pid: process.pid, boot_id: 'live-compatible-boot', process_start_identity: startIdentity, token: 'live-compatible-token', instance_id: 'live-compatible-instance', package_build: '1.0.1-cf38', protocol_version: '1.3', database_schema_version: 9, started_at: '2026-07-14T00:00:00.000Z' };
    const predecessorFence = { schema_version: 'autopilot.coordinator_lock.v1', pid: process.pid, boot_id: 'live-compatible-boot', token: 'compatibility-fence-token', started_at: '2026-07-14T00:00:00.000Z' };
    try {
      await mkdir(paths.coordinatorRoot, { recursive: true });
      await writeFile(paths.lockPath, `${JSON.stringify(currentLock)}\n`, 'utf8');
      await writeFile(paths.predecessorLockPath, `${JSON.stringify(predecessorFence)}\n`, 'utf8');
      await assert.rejects(() => new CoordinatorClient({ env, startupTimeoutMs: 2_000 }).query('handshake'), /wire-compatible coordinator 1\.0\.1-cf38 is live.*socket is unavailable/u);
      assert.deepEqual(await lockRecord(paths.lockPath), currentLock);
      assert.deepEqual(await lockRecord(paths.predecessorLockPath), predecessorFence);
      assert.equal(isProcessAlive(process.pid), true, 'compatibility handling must never signal the live owner');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('recovers an exact dead v1.0.1 current-generation lock but never treats it as a live replacement request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-bug-175-dead-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const tagged = await startTaggedCoordinator({ stateRoot, extractionRoot: root });
    let current: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      const oldLock = await lockRecord(paths.lockPath);
      hardKillProcess(tagged.child);
      await new Promise<void>((resolveClose) => tagged.child.once('close', () => resolveClose()));
      assert.deepEqual(await lockRecord(paths.lockPath), oldLock, 'hard-kill fixture must preserve the exact old lock');
      const committedIntent = `${JSON.stringify(historicalUpgradeIntent('committed'))}\n`;
      await writeFile(coordinatorUpgradeIntentPath(paths), committedIntent, 'utf8');
      await assert.rejects(() => preparePredecessorCoordinatorUpgrade(paths, 'e'.repeat(64), Date.now() + 2_000), /refuses to overwrite durable committed intent/u);
      assert.equal(await readFile(coordinatorUpgradeIntentPath(paths), 'utf8'), committedIntent);

      current = await startCoordinatorServer(paths);
      const response = await new CoordinatorClient({ env, autoStart: false }).query('handshake');
      assert.equal(response.payload['package_build'], '1.0.3-cf40');
      const newLock = await lockRecord(paths.lockPath);
      assert.notEqual(newLock['instance_id'], oldLock['instance_id']);
      assert.equal(newLock['package_build'], '1.0.3-cf40');
      assert.equal(await readFile(coordinatorUpgradeIntentPath(paths), 'utf8'), committedIntent, 'historical committed intent remains immutable forensic evidence');
    } finally {
      if (current !== null) await current.close();
      await tagged.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('refuses historical noncommitted or unknown-target upgrade intents without creating coordinator authority', async () => {
    for (const [label, intent, expectedCode] of [
      ['noncommitted', historicalUpgradeIntent('starting'), 'recovery-required'],
      ['unknown-target', historicalUpgradeIntent('committed', 'unknown-cf99'), 'protocol-mismatch'],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `pi-autopilot-bug-175-${label}-`));
      const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') });
      try {
        await mkdir(paths.coordinatorRoot, { recursive: true });
        await writeFile(coordinatorUpgradeIntentPath(paths), `${JSON.stringify(intent)}\n`, 'utf8');
        await assert.rejects(() => startCoordinatorServer(paths), (error: unknown) => typeof error === 'object' && error !== null && (error as JsonMap)['code'] === expectedCode);
        await assert.rejects(() => readFile(paths.lockPath, 'utf8'), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });
});
