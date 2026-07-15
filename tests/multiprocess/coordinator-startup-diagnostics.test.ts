import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { armStartupBarrier, releaseStartupBarrier, STARTUP_BARRIER_ENV, waitForStartupBarrier } from '../helpers/coordinator-startup-barrier.ts';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function evidenceValue(error: CoordinationRuntimeError, prefix: string): string | null {
  const entry = error.evidence.find((candidate) => candidate.startsWith(prefix));
  return entry === undefined ? null : entry.slice(prefix.length);
}

void it('reports a real corrupt SQLite startup failure with exact process and phase evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-startup-corrupt-'));
  const stateRoot = join(root, 'state');
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot, PI_OFFLINE: '1' };
  const paths = coordinatorRuntimePaths(env);
  const corrupt = 'synthetic corrupt sqlite bytes\n';
  try {
    await mkdir(paths.coordinatorRoot, { recursive: true, mode: 0o700 });
    await writeFile(paths.databasePath, corrupt, { encoding: 'utf8', mode: 0o600 });
    await assert.rejects(() => new CoordinatorClient({ env, readinessTimeoutMs: 5_000 }).query('handshake'), (error: unknown) => {
      if (!(error instanceof CoordinationRuntimeError)) return false;
      assert.equal(error.code, 'coordinator-unavailable');
      assert.equal(evidenceValue(error, 'startup_report_failure_code='), 'store-corrupt');
      assert.match(error.message, /failed with exit code 70/u);
      assert.match(evidenceValue(error, 'spawned_pid=') ?? '', /^\d+$/u);
      assert.equal(evidenceValue(error, 'spawned_exit_code='), '70');
      assert.equal(evidenceValue(error, 'spawned_signal='), 'none');
      assert.equal(evidenceValue(error, 'startup_phase='), 'before-sqlite-open-reconciliation');
      assert.equal(evidenceValue(error, 'exact_competing_lifecycle_owner_observed='), 'false');
      assert.match(evidenceValue(error, 'last_endpoint_transport_failure=') ?? '', /ENOENT|ECONNREFUSED|connect/u);
      assert.notEqual(evidenceValue(error, 'startup_report_error='), 'none');
      assert.equal(evidenceValue(error, 'startup_report_truncated='), 'false');
      assert.equal(/spawned coordinator exited and no exact-current endpoint/u.test(error.message), false);
      return true;
    });
    assert.equal(sha256(await readFile(paths.databasePath, 'utf8')), sha256(corrupt), 'failed startup must not rewrite corrupt input bytes');
  } finally { await rm(root, { recursive: true, force: true }); }
});

void it('reports exact signal death while paused at a deterministic pre-election boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-startup-signal-'));
  const stateRoot = join(root, 'state');
  const barrier = join(stateRoot, 'test-startup-barriers', 'signal');
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot, [STARTUP_BARRIER_ENV]: barrier, PI_OFFLINE: '1' };
  try {
    await armStartupBarrier(barrier, 'before-lifecycle-election');
    const pending = new CoordinatorClient({ env, readinessTimeoutMs: 5_000 }).query('handshake');
    await waitForStartupBarrier(barrier, 'before-lifecycle-election');
    const reportRoot = coordinatorRuntimePaths(env).startupReportsRoot;
    const reportNames = (await readdir(reportRoot)).filter((name) => name.endsWith('.json'));
    assert.equal(reportNames.length, 1);
    const report = JSON.parse(await readFile(join(reportRoot, reportNames[0] ?? ''), 'utf8')) as Readonly<Record<string, unknown>>;
    const pid = report['spawned_pid'];
    assert.equal(typeof pid, 'number');
    process.kill(pid as number, 'SIGKILL');
    await assert.rejects(() => pending, (error: unknown) => {
      if (!(error instanceof CoordinationRuntimeError)) return false;
      assert.match(error.message, /terminated by signal SIGKILL/u);
      assert.equal(evidenceValue(error, 'spawned_signal='), 'SIGKILL');
      assert.equal(evidenceValue(error, 'startup_phase='), 'before-lifecycle-election');
      assert.equal(evidenceValue(error, 'exact_competing_lifecycle_owner_observed='), 'false');
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

void it('reports a real private-capability no-follow failure without treating diagnostics as authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-startup-private-'));
  const stateRoot = join(root, 'state');
  const barrier = join(stateRoot, 'test-startup-barriers', 'private');
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot, [STARTUP_BARRIER_ENV]: barrier, PI_OFFLINE: '1' };
  const paths = coordinatorRuntimePaths(env);
  const target = join(root, 'synthetic-secret-target');
  try {
    await armStartupBarrier(barrier, 'after-lifecycle-lock-acquisition');
    const pending = new CoordinatorClient({ env, readinessTimeoutMs: 5_000 }).query('handshake');
    await waitForStartupBarrier(barrier, 'after-lifecycle-lock-acquisition');
    await writeFile(target, 'must-not-be-read-or-mutated\n', { encoding: 'utf8', mode: 0o600 });
    await unlink(paths.capabilityPath);
    await symlink(target, paths.capabilityPath);
    await releaseStartupBarrier(barrier, 'after-lifecycle-lock-acquisition');
    await assert.rejects(() => pending, (error: unknown) => {
      if (!(error instanceof CoordinationRuntimeError)) return false;
      assert.match(error.message, /failed with exit code 70/u);
      assert.equal(evidenceValue(error, 'startup_phase='), 'before-private-root-capability-setup');
      assert.match(evidenceValue(error, 'startup_report_error=') ?? '', /symbolic-link|alias/u);
      assert.equal(evidenceValue(error, 'exact_competing_lifecycle_owner_observed='), 'false');
      return true;
    });
    assert.equal(await readFile(target, 'utf8'), 'must-not-be-read-or-mutated\n');
    assert.equal((await lstat(paths.capabilityPath)).isSymbolicLink(), true, 'diagnostic handling must not repair an authority-path attack');
  } finally { await rm(root, { recursive: true, force: true }); }
});
