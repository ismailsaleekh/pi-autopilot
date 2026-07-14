import assert from 'node:assert/strict';
import { mkdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { CoordinatorFrameDecoder, encodeCoordinatorFrame } from '../../src/core/coordination/ipc.ts';
import { isProcessAlive, processStartIdentity } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { coordinatorUpgradeIntentPath, preparePredecessorCoordinatorUpgrade } from '../../src/core/coordination/upgrade.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { hardKillProcess } from '../helpers/hard-kill-process.ts';
import { runTaggedCli, startTaggedCoordinator } from '../helpers/tagged-coordinator.ts';

interface JsonMap { readonly [key: string]: unknown }

function record(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as JsonMap;
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


void describe('coordinator protocol and schema version boundary', () => {
  void it('rejects new protocol-1.5 operations against the actual live protocol-1.3 coordinator without replacing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-version-boundary-live-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const tagged = await startTaggedCoordinator({ stateRoot, extractionRoot: root });
    try {
      const before = await lockRecord(tagged.paths.lockPath);
      assert.equal(before['package_build'], '1.0.1-cf38');
      assert.equal(before['pid'], tagged.child.pid);
      await assert.rejects(() => new CoordinatorClient({ env }).query('handshake'), /protocol|compatible|migration|schema/u);
      assert.deepEqual(await lockRecord(tagged.paths.lockPath), before, 'an incompatible live historical broker must retain exact lifecycle authority until explicit migration');
      const oldStatus = runTaggedCli(tagged.packageRoot, stateRoot, ['status']);
      assert.equal(oldStatus['package_build'], '1.0.1-cf38', 'the historical client remains usable with its own broker');
      assert.equal(isProcessAlive(tagged.child.pid ?? -1), true);
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
      await assert.rejects(() => client.query('handshake'), /protocol|compatible|migration|schema/u);
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
              schema_version: 'autopilot.coordinator_response.v1', protocol_version: '1.5', request_id: requestId, ok: true,
              committed_event_seq: action === 'handshake' ? null : 1, error_code: null, retryable: false,
              payload: action === 'handshake'
                ? { schema_version: 'autopilot.coordinator_handshake.v1', package_build: '1.1.0-cf42', protocol_version: '1.5', database_schema_version: 11 }
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
            schema_version: 'autopilot.coordinator_response.v1', protocol_version: '1.5', request_id: requestId, ok: true,
            committed_event_seq: null, error_code: null, retryable: false,
            payload: { schema_version: 'autopilot.coordinator_handshake.v1', package_build: 'unknown-cf99', protocol_version: '1.5', database_schema_version: 11 },
          }));
        }
      });
    });
    try {
      await listen(fake, paths.socketPath);
      await assert.rejects(() => new CoordinatorClient({ env }).mutate('heartbeat', {
        repoId: 'repo-never-sent', workstreamRun: 'run-never-sent', sessionId: 'session-never-sent', fencingGeneration: 1, expectedVersion: 0, idempotencyKey: 'BUG-175-never-send-mutation',
      }, { session_lease_id: 'lease-never-sent', session_token: 'f'.repeat(64), lease_expires_at: '2099-01-01T00:00:00.000Z' }), /outside the closed protocol-1\.5\/schema-11 compatibility lineage/u);
      assert.deepEqual(actions, ['handshake']);
    } finally {
      await closeServer(fake);
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('never reinterprets a live historical current-generation fence as the schema-6 predecessor when its socket is unavailable', async () => {
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
      await assert.rejects(() => new CoordinatorClient({ env, startupTimeoutMs: 2_000 }).query('handshake'), /known coordinator 1\.0\.1-cf38 is live.*socket is unavailable/u);
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
      assert.equal(response.payload['package_build'], '1.1.0-cf42');
      const newLock = await lockRecord(paths.lockPath);
      assert.notEqual(newLock['instance_id'], oldLock['instance_id']);
      assert.equal(newLock['package_build'], '1.1.0-cf42');
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
