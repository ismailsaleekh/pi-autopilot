import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessLite } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

const packageRoot = resolve(new URL('../../', import.meta.url).pathname);
const coordinatorCli = join(packageRoot, 'src', 'cli', 'autopilot-coordinator.ts');
const negotiationClient = join(packageRoot, 'tests', 'helpers', 'negotiation-process-client.ts');

interface LockRecord {
  readonly pid: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error('condition did not become true before timeout');
}

async function waitForCoordinator(client: CoordinatorClient): Promise<void> {
  await waitFor(async () => {
    try {
      await client.query('status');
      return true;
    } catch {
      return false;
    }
  });
}

async function readLock(path: string): Promise<LockRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const pid = (parsed as Readonly<Record<string, unknown>>)['pid'];
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? { pid } : null;
  } catch {
    return null;
  }
}

function startServe(stateRoot: string): ChildProcessLite {
  return spawn(process.execPath, ['--experimental-strip-types', coordinatorCli, 'serve', '--state-root', stateRoot], {
    cwd: packageRoot,
    env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
}

function runNegotiationClient(stateRoot: string, action: 'attach-acquire' | 'release' | 'ack', suffix: string, targetGroup?: string): Readonly<Record<string, unknown>> {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', negotiationClient, action, stateRoot, suffix, ...(targetGroup === undefined ? [] : [targetGroup])], {
    cwd: packageRoot,
    env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed: unknown = JSON.parse(result.stdout.trim()) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('negotiation process output is not an object');
  return parsed as Readonly<Record<string, unknown>>;
}

function closeResult(child: ChildProcessLite): Promise<number | null> {
  return new Promise((resolveClose) => child.on('close', (code) => resolveClose(code)));
}

async function stopCoordinator(lockPath: string): Promise<void> {
  const lock = await readLock(lockPath);
  if (lock === null) return;
  try {
    process.kill(lock.pid, 'SIGTERM');
  } catch {
    return;
  }
  await waitFor(() => !existsSync(lockPath));
}

void describe('coordinator multiprocess lifecycle', () => {
  void it('elects one writer from concurrent starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-process-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const first = startServe(stateRoot);
    const second = startServe(stateRoot);
    const firstClosed = closeResult(first);
    const secondClosed = closeResult(second);
    try {
      await waitFor(() => existsSync(paths.lockPath) && existsSync(paths.capabilityPath));
      const client = new CoordinatorClient({ env, autoStart: false });
      await waitForCoordinator(client);
      const response = await client.query('status');
      assert.equal(response.payload['schema_version'], 'autopilot.coordinator_status.v1');
      const outcome = await Promise.race([
        firstClosed.then((code) => ({ process: 'first', code })),
        secondClosed.then((code) => ({ process: 'second', code })),
        sleep(5_000).then(() => ({ process: 'timeout', code: -1 })),
      ]);
      assert.notEqual(outcome.process, 'timeout');
      assert.equal(outcome.code, 0);
      const lock = await readLock(paths.lockPath);
      if (lock === null) throw new Error('missing elected coordinator lock');
      const elected = [first.pid, second.pid].filter((pid) => pid === lock.pid);
      assert.equal(elected.length, 1);
    } finally {
      await stopCoordinator(paths.lockPath);
      if (!first.killed) first.kill('SIGTERM');
      if (!second.killed) second.kill('SIGTERM');
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('negotiates release and reacquisition through two independent client processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-negotiation-process-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const server = startServe(stateRoot);
    try {
      await waitFor(() => existsSync(paths.lockPath) && existsSync(paths.capabilityPath));
      await waitForCoordinator(new CoordinatorClient({ env, autoStart: false }));
      const owner = runNegotiationClient(stateRoot, 'attach-acquire', 'a');
      const requester = runNegotiationClient(stateRoot, 'attach-acquire', 'b');
      assert.equal(owner['outcome'], 'granted');
      assert.equal(requester['outcome'], 'waiting-for-peer-release');
      const release = runNegotiationClient(stateRoot, 'release', 'a', 'group-b');
      assert.equal(release['status'], 'grant-ready');
      const grant = runNegotiationClient(stateRoot, 'ack', 'b');
      assert.equal(grant['state'], 'granted');
      assert.equal(grant['lease_count'], 1);
      const status = await new CoordinatorClient({ env, autoStart: false }).query('status', 'repo-process-negotiation', 'run-b');
      assert.equal(Array.isArray(status.payload['edit_leases']) ? status.payload['edit_leases'].length : -1, 1);
    } finally {
      await stopCoordinator(paths.lockPath);
      if (!server.killed) server.kill('SIGTERM');
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('recovers committed state after a hard coordinator kill and client restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-coordinator-restart-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    const server = startServe(stateRoot);
    try {
      await waitFor(() => existsSync(paths.lockPath) && existsSync(paths.capabilityPath));
      const client = new CoordinatorClient({ env });
      await waitForCoordinator(client);
      await client.mutate('attach-run', {
        repoId: 'repo-process-test', workstreamRun: 'run-process-test', sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-process-test',
      }, {
        repo_key: 'repo-process-test', canonical_root: '/tmp/generic-process-repository', git_common_dir: '/tmp/generic-process-repository/.git', autopilot_id: 'autopilot-process-test', workstream: 'process-test',
      });
      const lock = await readLock(paths.lockPath);
      if (lock === null) throw new Error('missing coordinator lock before kill');
      process.kill(lock.pid, 'SIGKILL');
      await waitFor(async () => {
        const current = await readLock(paths.lockPath);
        if (current === null) return true;
        try {
          process.kill(current.pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      const recovered = await client.query('status', 'repo-process-test', 'run-process-test');
      const runs = recovered.payload['runs'];
      assert.equal(Array.isArray(runs) ? runs.length : -1, 1);
      const doctor = await client.query('doctor');
      assert.equal(doctor.payload['integrity'], 'ok');
    } finally {
      await stopCoordinator(paths.lockPath);
      if (!server.killed) server.kill('SIGTERM');
      await rm(root, { recursive: true, force: true });
    }
  });
});
