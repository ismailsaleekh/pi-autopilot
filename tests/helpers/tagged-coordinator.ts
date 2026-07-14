import { spawn, spawnSync, type ChildProcessLite } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isProcessAlive } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths, type CoordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

export const V1_0_1_COMMIT = 'f1795f8f820af15b73e73ce399c415a19893f5ef';

export interface TaggedCoordinatorProcess {
  readonly child: ChildProcessLite;
  readonly packageRoot: string;
  readonly paths: CoordinatorRuntimePaths;
  close(): Promise<void>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error('tagged coordinator condition did not become true before timeout');
}

function git(args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: packageRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr)}`);
  return result.stdout;
}

export async function materializeTaggedPackage(destination: string, commit = V1_0_1_COMMIT): Promise<void> {
  const observed = git(['rev-parse', `${commit}^{commit}`]).trim();
  if (observed !== commit) throw new Error(`tagged coordinator commit mismatch: expected ${commit}, observed ${observed}`);
  const paths = git(['ls-tree', '-r', '--name-only', commit, '--', 'dist', 'package.json']).trim().split('\n').filter((entry) => entry.length > 0);
  if (!paths.includes('dist/src/cli/autopilot-coordinator.js')) throw new Error('tagged coordinator archive omitted its compiled CLI');
  for (const path of paths) {
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`unsafe tagged package path ${path}`);
    const target = join(destination, ...path.split('/'));
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, git(['show', `${commit}:${path}`]), 'utf8');
  }
  await symlink(join(packageRoot, 'node_modules'), join(destination, 'node_modules'), platform() === 'win32' ? 'junction' : 'dir');
}

async function endpointReachable(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolveReachable) => {
    const socket = connect(path);
    const finish = (reachable: boolean): void => { clearTimeout(timer); socket.destroy(); resolveReachable(reachable); };
    const timer = setTimeout(() => finish(false), 250);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function lockPid(paths: CoordinatorRuntimePaths): Promise<number | null> {
  try {
    const value: unknown = JSON.parse(await readFile(paths.lockPath, 'utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const pid = (value as Readonly<Record<string, unknown>>)['pid'];
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

export async function startTaggedCoordinator(input: { readonly stateRoot: string; readonly extractionRoot: string; readonly commit?: string }): Promise<TaggedCoordinatorProcess> {
  const taggedRoot = join(input.extractionRoot, 'tagged-package');
  await materializeTaggedPackage(taggedRoot, input.commit ?? V1_0_1_COMMIT);
  const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: input.stateRoot });
  const child = spawn(process.execPath, [join(taggedRoot, 'dist', 'src', 'cli', 'autopilot-coordinator.js'), 'serve', '--state-root', input.stateRoot], {
    cwd: taggedRoot,
    env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: input.stateRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`tagged coordinator exited ${String(child.exitCode)}: ${stderr}`);
      const pid = await lockPid(paths);
      return pid === child.pid && await endpointReachable(paths.socketPath);
    });
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM');
    throw error;
  }
  return {
    child,
    packageRoot: taggedRoot,
    paths,
    close: async () => {
      const pid = child.pid;
      if (pid !== undefined && isProcessAlive(pid)) {
        const closed = new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
        child.kill('SIGTERM');
        await closed;
      }
      if (pid !== undefined) await waitFor(() => !isProcessAlive(pid));
      await rm(taggedRoot, { recursive: true, force: true });
    },
  };
}

export function runTaggedCli(taggedRoot: string, stateRoot: string, args: readonly string[]): Readonly<Record<string, unknown>> {
  const result = spawnSync(process.execPath, [join(taggedRoot, 'dist', 'src', 'cli', 'autopilot-coordinator.js'), ...args, '--state-root', stateRoot], {
    cwd: taggedRoot,
    env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`tagged coordinator CLI failed: ${result.stderr}`);
  const parsed: unknown = JSON.parse(result.stdout.trim()) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('tagged coordinator CLI returned a non-object');
  return parsed as Readonly<Record<string, unknown>>;
}
