import assert from 'node:assert/strict';
import { spawn, type ChildProcessLite } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { isProcessAlive } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { assertNoLeakedCoordinators, stopCoordinatorByLock, stopSpawnedChild, stopTestCoordinatorsForStateRoot } from '../helpers/coordinator-process-lifecycle.ts';
import { armStartupBarrier, releaseStartupBarrier, STARTUP_BARRIER_ENV, waitForStartupBarrier, type StartupBoundary } from '../helpers/coordinator-startup-barrier.ts';

after(async () => { await assertNoLeakedCoordinators(); });

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const coordinatorCli = join(packageRoot, 'src', 'cli', 'autopilot-coordinator.ts');

interface StartupReport {
  readonly outcome: string;
  readonly spawned_pid: number;
  readonly phase: string;
  readonly lifecycle?: Readonly<Record<string, unknown>> | null;
}

async function reports(stateRoot: string): Promise<readonly StartupReport[]> {
  const root = join(stateRoot, 'coordinator', 'startup-reports');
  let names: readonly string[];
  try { names = await readdir(root); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
  const output: StartupReport[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) output.push(JSON.parse(await readFile(join(root, name), 'utf8')) as StartupReport);
  return output;
}

async function waitForReport(stateRoot: string, predicate: (report: StartupReport) => boolean, timeoutMs = 10_000): Promise<StartupReport> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = (await reports(stateRoot)).find(predicate);
    if (match !== undefined) return match;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('coordinator startup report did not reach the required state');
}

async function delayedWinnerFixture(root: string, readinessTimeoutMs: number): Promise<{
  readonly stateRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly winnerBarrier: string;
  readonly winner: ChildProcessLite;
  readonly winnerLock: Readonly<Record<string, unknown>>;
  readonly pending: Promise<Awaited<ReturnType<CoordinatorClient['query']>>>;
}> {
  const stateRoot = join(root, 'state');
  const loserBarrier = join(stateRoot, 'test-startup-barriers', 'loser');
  const winnerBarrier = join(stateRoot, 'test-startup-barriers', 'winner');
  const commonEnv = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
  await armStartupBarrier(loserBarrier, 'before-lifecycle-election');
  await armStartupBarrier(winnerBarrier, 'first-exact-handshake-served');
  const client = new CoordinatorClient({ env: { ...commonEnv, [STARTUP_BARRIER_ENV]: loserBarrier }, readinessTimeoutMs });
  const pending = client.query('handshake');
  void pending.catch(() => undefined);
  await waitForStartupBarrier(loserBarrier, 'before-lifecycle-election');
  let winnerStderr = '';
  const winner = spawn(process.execPath, ['--experimental-strip-types', coordinatorCli, 'serve', '--state-root', stateRoot], {
    cwd: packageRoot, env: { ...commonEnv, [STARTUP_BARRIER_ENV]: winnerBarrier }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  winner.stderr?.on('data', (chunk) => { winnerStderr += chunk.toString('utf8'); });
  try {
    await waitForReport(stateRoot, (report) => report.spawned_pid === winner.pid && report.phase === 'after-activation-before-first-handshake', 30_000);
    const winnerLock = JSON.parse(await readFile(coordinatorRuntimePaths(commonEnv).lockPath, 'utf8')) as Readonly<Record<string, unknown>>;
    await releaseStartupBarrier(loserBarrier, 'before-lifecycle-election');
    await waitForReport(stateRoot, (report) => report.outcome === 'election-loser', 30_000);
    await waitForStartupBarrier(winnerBarrier, 'first-exact-handshake-served', 30_000);
    return { stateRoot, env: commonEnv, winnerBarrier, winner, winnerLock, pending };
  } catch (error) {
    await stopSpawnedChild(winner);
    // The client auto-start child is detached and may have published a lock
    // even when fixture construction failed. Stop it before the temp root can
    // be deleted; the suite-level sweep closes the pre-lock race.
    await stopCoordinatorByLock(coordinatorRuntimePaths(commonEnv).lockPath);
    await stopTestCoordinatorsForStateRoot(stateRoot);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; winner_exit=${String(winner.exitCode)}; winner_stderr=${winnerStderr}`);
  }
}

async function cleanupDelayedWinnerFixture(fixture: Awaited<ReturnType<typeof delayedWinnerFixture>> | null): Promise<void> {
  await stopSpawnedChild(fixture?.winner ?? null);
  if (fixture === null) return;
  await stopCoordinatorByLock(coordinatorRuntimePaths(fixture.env).lockPath);
  // A client can spawn a detached replacement in the interval after its exact
  // winner dies and before it reports failure. That process may not have a lock
  // yet; exact temp-state-root argv cleanup closes the pre-lock window.
  await stopTestCoordinatorsForStateRoot(fixture.stateRoot);
}

void it('provides independently releasable real-process barriers at every startup boundary', async () => {
  const boundaries: readonly StartupBoundary[] = [
    'before-lifecycle-election',
    'after-lifecycle-lock-acquisition',
    'before-private-root-capability-setup',
    'after-private-root-capability-setup',
    'before-sqlite-open-reconciliation',
    'after-sqlite-open-reconciliation',
    'before-socket-bind',
    'after-listen-before-lifecycle-activation',
    'after-activation-before-first-handshake',
    'first-exact-handshake-served',
  ];
  for (const boundary of boundaries) {
    const root = await mkdtemp(join(tmpdir(), `pi-autopilot-boundary-${boundary}-`));
    const stateRoot = join(root, 'state');
    const barrier = join(stateRoot, 'test-startup-barriers', boundary);
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot, [STARTUP_BARRIER_ENV]: barrier, PI_OFFLINE: '1' };
    let child: ChildProcessLite | null = null;
    try {
      await armStartupBarrier(barrier, boundary);
      child = spawn(process.execPath, ['--experimental-strip-types', coordinatorCli, 'serve', '--state-root', stateRoot], { cwd: packageRoot, env, stdio: 'ignore' });
      let handshake: Promise<unknown> | null = null;
      if (boundary === 'first-exact-handshake-served') {
        await waitForReport(stateRoot, (report) => report.spawned_pid === child?.pid && report.phase === 'after-activation-before-first-handshake');
        handshake = new CoordinatorClient({ env, autoStart: false }).query('handshake');
      }
      await waitForStartupBarrier(barrier, boundary);
      await releaseStartupBarrier(barrier, boundary);
      if (handshake === null) {
        await waitForReport(stateRoot, (report) => report.spawned_pid === child?.pid && report.phase === 'after-activation-before-first-handshake');
        handshake = new CoordinatorClient({ env, autoStart: false }).query('handshake');
      }
      await handshake;
    } finally {
      await stopSpawnedChild(child);
      await stopCoordinatorByLock(coordinatorRuntimePaths(env).lockPath);
      await stopTestCoordinatorsForStateRoot(stateRoot);
      await rm(root, { recursive: true, force: true });
    }
  }
});

void it('fails at the original deadline when the exact stable winner never publishes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-delayed-winner-timeout-'));
  let fixture: Awaited<ReturnType<typeof delayedWinnerFixture>> | null = null;
  try {
    fixture = await delayedWinnerFixture(root, 30_000);
    const active = fixture;
    await assert.rejects(() => active.pending, (error: unknown) => {
      if (!(error instanceof Error)) return false;
      assert.match(error.message, /exact delayed startup winner did not publish.*original readiness deadline/u);
      return true;
    });
  } finally {
    if (fixture !== null) await releaseStartupBarrier(fixture.winnerBarrier, 'first-exact-handshake-served').catch(() => undefined);
    await cleanupDelayedWinnerFixture(fixture);
    await rm(root, { recursive: true, force: true });
  }
});

void it('fails promptly when the exact delayed winner dies before publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-delayed-winner-death-'));
  let fixture: Awaited<ReturnType<typeof delayedWinnerFixture>> | null = null;
  try {
    fixture = await delayedWinnerFixture(root, 30_000);
    if (fixture.winner.pid === undefined) throw new Error('winner pid is unavailable');
    process.kill(fixture.winner.pid, 'SIGKILL');
    const active = fixture;
    await assert.rejects(() => active.pending, (error: unknown) => {
      if (!(error instanceof CoordinationRuntimeError)) return false;
      assert.equal(error.code, 'coordinator-unavailable');
      // A SIGKILLed child can remain kill(0)-visible as a zombie after libproc
      // has retired its birth record. Both observations fail closed on the same
      // exact delayed winner; neither permits replacement or endpoint use.
      assert.match(error.message, /exact delayed startup winner (?:died before endpoint publication|process-birth identity became unavailable)/u);
      return true;
    });
  } finally {
    // Regression for S0-B: after the exact winner dies, CoordinatorClient may
    // spawn a detached replacement before reporting the expected failure. The
    // prior fixture removed the root without stopping that replacement; two
    // pi-autopilot-delayed-winner-death coordinators survived for days.
    await cleanupDelayedWinnerFixture(fixture);
    await rm(root, { recursive: true, force: true });
  }
});

void it('fails closed when the delayed winner lock identity changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-delayed-winner-drift-'));
  let fixture: Awaited<ReturnType<typeof delayedWinnerFixture>> | null = null;
  try {
    fixture = await delayedWinnerFixture(root, 30_000);
    const paths = coordinatorRuntimePaths(fixture.env);
    await (await import('node:fs/promises')).writeFile(paths.lockPath, `${JSON.stringify({ ...fixture.winnerLock, instance_id: 'synthetic-drift-instance' })}\n`, { encoding: 'utf8', mode: 0o600 });
    await releaseStartupBarrier(fixture.winnerBarrier, 'first-exact-handshake-served');
    const active = fixture;
    await assert.rejects(() => active.pending, (error: unknown) => {
      if (!(error instanceof Error)) return false;
      assert.match(error.message, /lifecycle identity changed before endpoint publication|failed exact lifecycle attestation/u);
      return true;
    });
  } finally {
    if (fixture?.winner.pid !== undefined && isProcessAlive(fixture.winner.pid)) process.kill(fixture.winner.pid, 'SIGKILL');
    await cleanupDelayedWinnerFixture(fixture);
    await rm(root, { recursive: true, force: true });
  }
});

void it('waits for the stable exact winner when the spawned election loser exits before endpoint publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-delayed-winner-'));
  let fixture: Awaited<ReturnType<typeof delayedWinnerFixture>> | null = null;
  try {
    fixture = await delayedWinnerFixture(root, 30_000);
    const loser = await waitForReport(fixture.stateRoot, (report) => report.outcome === 'election-loser');
    assert.notEqual(loser.spawned_pid, fixture.winner.pid);
    assert.equal(loser.lifecycle?.['pid'], fixture.winner.pid);
    const active = fixture;
    const concurrent = [active.pending, ...Array.from({ length: 4 }, () => new CoordinatorClient({ env: active.env, readinessTimeoutMs: 10_000 }).query('handshake'))];
    await releaseStartupBarrier(fixture.winnerBarrier, 'first-exact-handshake-served');
    const handshakes = await Promise.all(concurrent);
    for (const handshake of handshakes) {
      assert.equal(handshake.payload['lifecycle_pid'], fixture.winner.pid);
      assert.equal(handshake.payload['lifecycle_instance_id'], fixture.winnerLock['instance_id']);
    }
  } finally {
    await cleanupDelayedWinnerFixture(fixture);
    await rm(root, { recursive: true, force: true });
  }
});
