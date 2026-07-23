import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import {
  assertS2IdempotentHeartbeatReplay,
  assertS2PreviousReleaseHandshake,
  installS2PreviousReleasePackage,
  loadS2PreviousReleaseClient,
  s2AttachAndHeartbeat,
  startS2PreviousReleaseCoordinator,
  verifyS2PreviousReleaseFixture,
  type VersionSkewClient,
} from '../helpers/s2-release-fixture.ts';
import { assertNoLeakedCoordinators, stopCoordinatorByLock, stopTestCoordinatorsForStateRoot } from '../helpers/coordinator-process-lifecycle.ts';

interface JsonMap {
  readonly [key: string]: unknown;
}

function record(value: unknown, label: string): JsonMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as JsonMap;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${label} is not an integer`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is not a non-empty string`);
  return value;
}

async function lifecycleLock(path: string): Promise<JsonMap> {
  return record(JSON.parse(await readFile(path, 'utf8')) as unknown, 'coordinator lifecycle lock');
}

void after(async () => { await assertNoLeakedCoordinators(); });

void describe('S2-C permanent previous-release skew lane', () => {
  void it('runs the previous published client against the current coordinator across attach, heartbeat, replay, and natural restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s2-prev-client-current-server-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const installation = await installS2PreviousReleasePackage(root);
    let current: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      await verifyS2PreviousReleaseFixture();
      current = await startCoordinatorServer(paths);
      const previousClient = await loadS2PreviousReleaseClient({ installation, env, autoStart: false });
      assertS2PreviousReleaseHandshake(await previousClient.query('handshake'));
      const journey = await s2AttachAndHeartbeat(previousClient, root, 's2-prev-to-current');
      const before = await lifecycleLock(paths.lockPath);
      assert.equal(before['package_build'], '1.1.8-cf50');

      await current.close();
      current = await startCoordinatorServer(paths);
      const afterRestart = await lifecycleLock(paths.lockPath);
      assert.notEqual(afterRestart['instance_id'], before['instance_id']);
      assertS2PreviousReleaseHandshake(await previousClient.query('handshake'));
      await assertS2IdempotentHeartbeatReplay(journey);
    } finally {
      if (current !== null) await current.close();
      await stopTestCoordinatorsForStateRoot(stateRoot);
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('runs the current client against the previous published coordinator across attach, heartbeat, replay, and natural restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s2-current-client-prev-server-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const installation = await installS2PreviousReleasePackage(root);
    let previous: Awaited<ReturnType<typeof startS2PreviousReleaseCoordinator>> | null = null;
    try {
      previous = await startS2PreviousReleaseCoordinator({ installation, stateRoot });
      const currentClient: VersionSkewClient = new CoordinatorClient({ env, autoStart: false });
      assertS2PreviousReleaseHandshake(await currentClient.query('handshake'));
      const journey = await s2AttachAndHeartbeat(currentClient, root, 's2-current-to-prev');
      const before = await lifecycleLock(previous.paths.lockPath);
      assert.equal(before['pid'], previous.child.pid);
      assert.equal(before['package_build'], '1.1.8-cf50');

      await previous.close();
      previous = await startS2PreviousReleaseCoordinator({ installation, stateRoot });
      const afterRestart = await lifecycleLock(previous.paths.lockPath);
      assert.notEqual(afterRestart['instance_id'], before['instance_id']);
      assert.equal(afterRestart['pid'], previous.child.pid);
      assertS2PreviousReleaseHandshake(await currentClient.query('handshake'));
      await assertS2IdempotentHeartbeatReplay(journey);
      assert.equal((await lifecycleLock(previous.paths.lockPath))['pid'], previous.child.pid);
    } finally {
      if (previous !== null) await previous.close();
      await stopTestCoordinatorsForStateRoot(stateRoot);
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('converges previous and current auto-start clients onto one stable mixed-build election winner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s2-mixed-election-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    try {
      const installation = await installS2PreviousReleasePackage(root);
      const previousClient = await loadS2PreviousReleaseClient({ installation, env, autoStart: true });
      const currentClient: VersionSkewClient = new CoordinatorClient({ env, autoStart: true, startupTimeoutMs: 10_000, readinessTimeoutMs: 30_000 });
      const [previousHandshake, currentHandshake] = await Promise.all([previousClient.query('handshake'), currentClient.query('handshake')]);
      assertS2PreviousReleaseHandshake(previousHandshake);
      assertS2PreviousReleaseHandshake(currentHandshake);
      const winner = await lifecycleLock(paths.lockPath);
      const winnerPid = integer(winner['pid'], 'S2 mixed-election winner pid');
      const winnerInstance = stringValue(winner['instance_id'], 'S2 mixed-election winner instance');
      assert.equal(winner['package_build'], '1.1.8-cf50');

      await Promise.all([
        s2AttachAndHeartbeat(previousClient, root, 's2-mixed-prev-client'),
        s2AttachAndHeartbeat(currentClient, root, 's2-mixed-current-client'),
      ]);
      const stable = await lifecycleLock(paths.lockPath);
      assert.equal(stable['pid'], winnerPid);
      assert.equal(stable['instance_id'], winnerInstance);
    } finally {
      await stopCoordinatorByLock(paths.lockPath);
      await stopTestCoordinatorsForStateRoot(stateRoot);
      await rm(root, { recursive: true, force: true });
    }
  });
});
