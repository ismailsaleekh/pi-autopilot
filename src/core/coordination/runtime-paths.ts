import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { platform, tmpdir } from 'node:os';

import { AUTOPILOT_STATE_ROOT_ENV, resolveAutopilotStateRoot, type ProcessEnvLike } from '../parallel-runtime.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { assertPrivatePathNoAliases, enforcePrivateAuthorityPath, enforceWindowsPrivateTree, ensurePrivateAuthorityDirectory, isWindowsPrivateTreeHardened, markWindowsPrivateTreeHardened } from '../private-path.ts';

export { enforcePrivateAuthorityPath, enforceWindowsPrivateAcl, enforceWindowsPrivateTree, ensurePrivateAuthorityDirectory, windowsPrivateAclCommand, windowsPrivateTreeAclCommand } from '../private-path.ts';
export type { WindowsPrivateAclCommand } from '../private-path.ts';

export { COORDINATOR_BUSY_TIMEOUT_MS, COORDINATOR_DATABASE_SCHEMA_VERSION, COORDINATOR_GRANT_OFFER_SWEEP_MS, COORDINATOR_GRANT_OFFER_TTL_MS, COORDINATOR_HEARTBEAT_MS, COORDINATOR_MAX_FRAME_BYTES, COORDINATOR_PACKAGE_BUILD, COORDINATOR_SESSION_LEASE_MS } from './runtime-constants.ts';

export interface CoordinatorRuntimePaths {
  readonly stateRoot: string;
  readonly coordinatorRoot: string;
  readonly databasePath: string;
  /** Current-generation paths are deliberately invisible to protocol 1.2. */
  readonly lockPath: string;
  readonly lifecycleElectionPath: string;
  readonly startupLockPath: string;
  readonly startupElectionPath: string;
  readonly socketPath: string;
  /** Exact paths used by the aa3e377 protocol-1.2 predecessor. */
  readonly predecessorLockPath: string;
  readonly predecessorStartupLockPath: string;
  readonly predecessorSocketPath: string;
  readonly capabilityPath: string;
  readonly backupsRoot: string;
  readonly exportsRoot: string;
  readonly sessionsRoot: string;
  readonly startupReportsRoot: string;
  readonly semanticReplayPath: string;
  readonly semanticReplayReceiptsRoot: string;
}

export function coordinatorRuntimePaths(env: ProcessEnvLike = process.env): CoordinatorRuntimePaths {
  const stateRoot = resolveAutopilotStateRoot(env);
  const coordinatorRoot = join(stateRoot, 'coordinator');
  const pipeHash = createHash('sha256').update(coordinatorRoot, 'utf8').digest('hex').slice(0, 24);
  // Retain the established lifecycle authority namespace across the explicit
  // protocol-1.3/schema-9 through protocol-1.6/schema-12 migrations. Sharing the path
  // is intentional: an older live broker is detected and fenced rather than
  // allowing two protocol generations to open the shared database.
  const generation = 'protocol-1.3-schema-9';
  const currentPipeHash = createHash('sha256').update(`${coordinatorRoot}\0${generation}\0${process.env['USERDOMAIN'] ?? ''}\\${process.env['USERNAME'] ?? ''}`, 'utf8').digest('hex').slice(0, 32);
  const preferredPredecessorSocketPath = join(coordinatorRoot, 'coordinator.sock');
  const predecessorSocketPath = platform() === 'win32'
    ? `\\\\.\\pipe\\pi-autopilot-${pipeHash}`
    : Buffer.byteLength(preferredPredecessorSocketPath, 'utf8') <= 100
      ? preferredPredecessorSocketPath
      : join(tmpdir(), `pi-autopilot-${pipeHash}.sock`);
  const preferredCurrentSocketPath = join(coordinatorRoot, `coordinator.${generation}.sock`);
  const socketPath = platform() === 'win32'
    ? `\\\\.\\pipe\\pi-autopilot-${currentPipeHash}`
    : Buffer.byteLength(preferredCurrentSocketPath, 'utf8') <= 100
      ? preferredCurrentSocketPath
      : join(tmpdir(), `pi-autopilot-${currentPipeHash}.sock`);
  return {
    stateRoot,
    coordinatorRoot,
    databasePath: join(coordinatorRoot, 'coordinator.db'),
    lockPath: join(coordinatorRoot, `coordinator.${generation}.lock`),
    lifecycleElectionPath: join(coordinatorRoot, `coordinator.${generation}.lifecycle-election.db`),
    startupLockPath: join(coordinatorRoot, `coordinator.${generation}.startup.lock`),
    startupElectionPath: join(coordinatorRoot, `coordinator.${generation}.startup-election.db`),
    socketPath,
    predecessorLockPath: join(coordinatorRoot, 'coordinator.lock'),
    predecessorStartupLockPath: join(coordinatorRoot, 'coordinator.startup.lock'),
    predecessorSocketPath,
    capabilityPath: join(coordinatorRoot, 'capability'),
    backupsRoot: join(coordinatorRoot, 'backups'),
    exportsRoot: join(coordinatorRoot, 'exports'),
    sessionsRoot: join(coordinatorRoot, 'sessions'),
    startupReportsRoot: join(coordinatorRoot, 'startup-reports'),
    semanticReplayPath: join(coordinatorRoot, 'semantic-replay.jsonl'),
    semanticReplayReceiptsRoot: join(coordinatorRoot, 'semantic-replay-receipts'),
  };
}

export async function ensureCoordinatorPrivateRoots(paths: CoordinatorRuntimePaths, env: ProcessEnvLike = process.env): Promise<void> {
  // The state root itself is authority, including an operator override. Harden it
  // before creating descendants so inherited Windows ACLs never expose new files.
  const roots = [
    paths.stateRoot,
    paths.coordinatorRoot,
    paths.backupsRoot,
    paths.exportsRoot,
    paths.sessionsRoot,
    paths.startupReportsRoot,
    paths.semanticReplayReceiptsRoot,
  ];
  if (platform() === 'win32') {
    if (isWindowsPrivateTreeHardened(paths.stateRoot)) {
      assertPrivatePathNoAliases(paths.stateRoot);
      for (const path of roots.slice(1)) {
        await mkdir(path, { recursive: true });
        assertPrivatePathNoAliases(path);
      }
      if (!isWindowsPrivateTreeHardened(paths.coordinatorRoot)) {
        enforceWindowsPrivateTree(paths.coordinatorRoot, env);
        markWindowsPrivateTreeHardened(paths.coordinatorRoot);
      }
      return;
    }
    // First close the operator-supplied root, then reject/harden every existing
    // descendant before creating package roots. New descendants inherit only the
    // closed current-user ACE; one final tree pass makes every root explicit.
    await ensurePrivateAuthorityDirectory(paths.stateRoot, env);
    enforceWindowsPrivateTree(paths.stateRoot, env);
    for (const path of roots.slice(1)) {
      await mkdir(path, { recursive: true });
      assertPrivatePathNoAliases(path);
    }
    enforceWindowsPrivateTree(paths.stateRoot, env);
    markWindowsPrivateTreeHardened(paths.stateRoot);
    markWindowsPrivateTreeHardened(paths.coordinatorRoot);
    return;
  }
  for (const path of roots) await ensurePrivateAuthorityDirectory(path, env);
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
  await enforcePrivateAuthorityPath(paths.capabilityPath, false);
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
