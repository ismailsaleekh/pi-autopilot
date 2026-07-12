import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { platform, tmpdir } from 'node:os';

import { AUTOPILOT_STATE_ROOT_ENV, resolveAutopilotStateRoot, type ProcessEnvLike } from '../parallel-runtime.ts';
import { CoordinationRuntimeError } from './failures.ts';

export const COORDINATOR_PACKAGE_BUILD = '0.12.0-cf33';
export const COORDINATOR_DATABASE_SCHEMA_VERSION = 5;
export const COORDINATOR_MAX_FRAME_BYTES = 1_048_576;
export const COORDINATOR_BUSY_TIMEOUT_MS = 5_000;
export const COORDINATOR_SESSION_LEASE_MS = 30_000;
export const COORDINATOR_HEARTBEAT_MS = 10_000;
export const COORDINATOR_GRANT_OFFER_TTL_MS = 30_000;
export const COORDINATOR_GRANT_OFFER_SWEEP_MS = 1_000;

export interface CoordinatorRuntimePaths {
  readonly stateRoot: string;
  readonly coordinatorRoot: string;
  readonly databasePath: string;
  readonly lockPath: string;
  readonly startupLockPath: string;
  readonly socketPath: string;
  readonly capabilityPath: string;
  readonly backupsRoot: string;
  readonly exportsRoot: string;
  readonly sessionsRoot: string;
}

export function coordinatorRuntimePaths(env: ProcessEnvLike = process.env): CoordinatorRuntimePaths {
  const stateRoot = resolveAutopilotStateRoot(env);
  const coordinatorRoot = join(stateRoot, 'coordinator');
  const pipeHash = createHash('sha256').update(coordinatorRoot, 'utf8').digest('hex').slice(0, 24);
  const preferredSocketPath = join(coordinatorRoot, 'coordinator.sock');
  const socketPath = platform() === 'win32'
    ? `\\\\.\\pipe\\pi-autopilot-${pipeHash}`
    : Buffer.byteLength(preferredSocketPath, 'utf8') <= 100
      ? preferredSocketPath
      : join(tmpdir(), `pi-autopilot-${pipeHash}.sock`);
  return {
    stateRoot,
    coordinatorRoot,
    databasePath: join(coordinatorRoot, 'coordinator.db'),
    lockPath: join(coordinatorRoot, 'coordinator.lock'),
    startupLockPath: join(coordinatorRoot, 'coordinator.startup.lock'),
    socketPath,
    capabilityPath: join(coordinatorRoot, 'capability'),
    backupsRoot: join(coordinatorRoot, 'backups'),
    exportsRoot: join(coordinatorRoot, 'exports'),
    sessionsRoot: join(coordinatorRoot, 'sessions'),
  };
}

export async function ensureCoordinatorPrivateRoots(paths: CoordinatorRuntimePaths): Promise<void> {
  for (const path of [paths.stateRoot, paths.coordinatorRoot, paths.backupsRoot, paths.exportsRoot, paths.sessionsRoot]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (platform() !== 'win32') await chmod(path, 0o700);
  }
}

export async function readOrCreateCoordinatorCapability(paths: CoordinatorRuntimePaths): Promise<string> {
  await ensureCoordinatorPrivateRoots(paths);
  let created = false;
  try {
    const handle = await open(paths.capabilityPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${randomBytes(32).toString('hex')}\n`, 'utf8');
      await handle.sync();
      created = true;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  if (platform() !== 'win32') await chmod(paths.capabilityPath, 0o600);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const capability = (await readFile(paths.capabilityPath, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/u.test(capability)) return capability;
    if (created) break;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new CoordinationRuntimeError('system-fatal', 'coordinator capability file is malformed or remained incomplete after concurrent creation', [paths.capabilityPath]);
}

export function stateRootEnvironment(stateRoot: string): ProcessEnvLike {
  return { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: resolve(stateRoot) };
}
