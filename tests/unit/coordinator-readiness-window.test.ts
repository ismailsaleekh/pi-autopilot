import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

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

async function stopSpawnedCoordinator(lockPath: string): Promise<void> {
  let text: string;
  try { text = await readFile(lockPath, 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
  let pid: number | undefined;
  try { pid = (JSON.parse(text) as { readonly pid?: unknown }).pid as number | undefined; }
  catch { return; }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) return;
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
}

void it('reaches a freshly spawned real coordinator within the default readiness window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-readiness-ok-'));
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
  try {
    const client = new CoordinatorClient({ env });
    const response = await client.query('handshake');
    assert.equal(response.payload['protocol_version'], '1.6');
    assert.equal(response.payload['database_schema_version'], 12);
    await stopSpawnedCoordinator(coordinatorRuntimePaths(env).lockPath);
  } finally {
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
    await stopSpawnedCoordinator(coordinatorRuntimePaths(env).lockPath);
  } finally {
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
    await stopSpawnedCoordinator(coordinatorRuntimePaths(env).lockPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
