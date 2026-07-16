import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { assertNoLeakedCoordinators, stopCoordinatorByLock, stopTestCoordinatorsForStateRoot } from '../helpers/coordinator-process-lifecycle.ts';

after(async () => { await assertNoLeakedCoordinators(); });

// Bug: the coordinator binds its socket only after CoordinatorStore.open
// completes schema migration + per-run terminal-proof reconciliation, but the
// client's readiness wait used a deadline computed once at #ensureStarted entry
// (the startup-lock window), which startup-lock/predecessor-fence contention
// depleted before the coordinator was even spawned. The fix gives the spawned
// coordinator its own spawn-relative readiness window (readinessTimeoutMs) and
// fails fast when the spawned process exits before readiness. These tests prove
// the window is respected (a deliberately tiny window fails loudly and quickly
// rather than hanging) and that a normal spawn reaches readiness within the
// default window. Each test shuts down the coordinator it spawned so no detached
// daemon leaks across the suite.

void it('reaches a freshly spawned real coordinator within the default readiness window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-readiness-ok-'));
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
  try {
    const client = new CoordinatorClient({ env });
    const response = await client.query('handshake');
    assert.equal(response.payload['protocol_version'], '1.6');
    assert.equal(response.payload['database_schema_version'], 12);
  } finally {
    // Stop in finally: a failed assertion must never strand the detached coordinator.
    await stopCoordinatorByLock(coordinatorRuntimePaths(env).lockPath);
    await stopTestCoordinatorsForStateRoot(env[AUTOPILOT_STATE_ROOT_ENV] ?? '');
    await rm(root, { recursive: true, force: true });
  }
});

void it('lets independent startup clients attest one exact lifecycle winner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-readiness-race-'));
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
  try {
    const left = new CoordinatorClient({ env });
    const right = new CoordinatorClient({ env });
    const [leftHandshake, rightHandshake] = await Promise.all([left.query('handshake'), right.query('handshake')]);
    assert.equal(leftHandshake.payload['lifecycle_instance_id'], rightHandshake.payload['lifecycle_instance_id']);
    assert.equal(leftHandshake.payload['lifecycle_pid'], rightHandshake.payload['lifecycle_pid']);
    assert.equal(leftHandshake.payload['package_build'], rightHandshake.payload['package_build']);
    const lock = JSON.parse(await readFile(coordinatorRuntimePaths(env).lockPath, 'utf8')) as Record<string, unknown>;
    assert.equal(lock['instance_id'], leftHandshake.payload['lifecycle_instance_id']);
    assert.equal(lock['pid'], leftHandshake.payload['lifecycle_pid']);
  } finally {
    await stopCoordinatorByLock(coordinatorRuntimePaths(env).lockPath);
    await stopTestCoordinatorsForStateRoot(env[AUTOPILOT_STATE_ROOT_ENV] ?? '');
    await rm(root, { recursive: true, force: true });
  }
});

void it('fails loudly and quickly when the readiness window is deliberately too small', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-readiness-tight-'));
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
  try {
    const client = new CoordinatorClient({ env, readinessTimeoutMs: 1 });
    const start = Date.now();
    await assert.rejects(() => client.query('handshake'), (error: unknown) => {
      // The tiny readiness window must fail loudly (deadline or crash), never hang.
      return error instanceof CoordinationRuntimeError && error.code === 'coordinator-unavailable';
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5_000, `a tiny readiness window must fail quickly, not hang (elapsed=${String(elapsed)}ms)`);
  } finally {
    // Leak root cause (2026-07-16): the client deadline expired before the spawned
    // coordinator published its lock, so a lock-based SIGTERM inside the try block
    // found nothing and the detached process survived. The stop now runs in finally,
    // and the exact-state-root process sweep closes the publish-after-deadline
    // window that a lock read alone cannot see.
    await stopCoordinatorByLock(coordinatorRuntimePaths(env).lockPath);
    await stopTestCoordinatorsForStateRoot(env[AUTOPILOT_STATE_ROOT_ENV] ?? '');
    await rm(root, { recursive: true, force: true });
  }
});
