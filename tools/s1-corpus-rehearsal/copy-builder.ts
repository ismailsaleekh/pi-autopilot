import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { mkdir, open, readdir, realpath, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { closedGitWorktreeRegistrationFacts } from './closed-git-registration.ts';
import { assertCloneSymlinksContained, assertNoSharedRegularFileIdentity, compareCodeUnits, copyRegularFileNoFollow, inventoryTree, type TreeInventory } from './inventory.ts';

export interface StateCopyResult {
  readonly source_inventory: TreeInventory;
  readonly copy_inventory: TreeInventory;
  readonly skipped_authority_paths: readonly string[];
  readonly skipped_registered_worktrees: readonly string[];
  readonly capability_sha256: `sha256:${string}`;
}

export interface ImmutableArtifactCopyResult {
  readonly source_inventory: TreeInventory;
  readonly copy_inventory: TreeInventory;
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function exactOrDescendant(path: string, roots: ReadonlySet<string>): boolean {
  for (const root of roots) if (inside(root, path)) return true;
  return false;
}

function authorityExclusions(stateRoot: string): readonly string[] {
  const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
  return Object.freeze([
    paths.databasePath, `${paths.databasePath}-journal`, `${paths.databasePath}-wal`, `${paths.databasePath}-shm`,
    paths.writerGuardPath, paths.storesRoot, paths.currentStorePointerPath, paths.runtimeIdentityPath,
    paths.lockPath, paths.lifecycleElectionPath, paths.startupLockPath, paths.startupElectionPath,
    paths.predecessorLockPath, paths.predecessorStartupLockPath,
    paths.capabilityPath, paths.sessionsRoot, paths.startupReportsRoot,
    paths.socketPath, paths.predecessorSocketPath,
  ].filter((path) => inside(stateRoot, path)).map((path) => resolve(path)).sort(compareCodeUnits));
}

async function copyDirectory(input: {
  readonly source_root: string;
  readonly copy_root: string;
  readonly source_directory: string;
  readonly copy_directory: string;
  readonly exclusions: ReadonlySet<string>;
}): Promise<void> {
  const entries = (await readdir(input.source_directory, { withFileTypes: true })).sort((left, right) => compareCodeUnits(left.name, right.name));
  for (const entry of entries) {
    const source = resolve(input.source_directory, entry.name);
    if (exactOrDescendant(source, input.exclusions)) continue;
    const destination = resolve(input.copy_directory, entry.name);
    if (!inside(input.copy_root, destination)) throw new Error('C5 state copy destination escaped clone root');
    const stat = lstatSync(source);
    if (stat.isSocket()) continue;
    if (stat.isDirectory()) {
      await mkdir(destination, { mode: stat.mode & 0o777 });
      await copyDirectory({ ...input, source_directory: source, copy_directory: destination });
      continue;
    }
    if (stat.isFile()) {
      await copyRegularFileNoFollow(source, destination, stat.mode);
      continue;
    }
    if (stat.isSymbolicLink()) {
      let sourceTarget: string;
      try { sourceTarget = realpathSync(source); }
      catch { throw new Error('C5 source symlink is dangling or cannot be resolved safely'); }
      if (!inside(input.source_root, sourceTarget)) throw new Error('C5 source symlink escapes source state');
      const mappedTarget = resolve(input.copy_root, relative(input.source_root, sourceTarget));
      if (!inside(input.copy_root, mappedTarget)) throw new Error('C5 mapped symlink target escapes clone state');
      const copyTarget = relative(dirname(destination), mappedTarget);
      await symlink(copyTarget, destination);
      continue;
    }
    throw new Error('C5 source state contains an unsupported filesystem node');
  }
}

async function publishFreshCapability(stateRoot: string): Promise<`sha256:${string}`> {
  const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
  await mkdir(paths.coordinatorRoot, { recursive: true, mode: 0o700 });
  const capability = randomBytes(32).toString('hex');
  const handle = await open(paths.capabilityPath, 'wx', 0o600);
  try { await handle.writeFile(`${capability}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  return `sha256:${createHash('sha256').update(Buffer.from(capability, 'hex')).digest('hex')}`;
}

export async function buildImmutableArtifactCopy(input: { readonly source_root: string; readonly copy_root: string }): Promise<ImmutableArtifactCopyResult> {
  const sourceRoot = await realpath(input.source_root);
  const copyRoot = resolve(input.copy_root);
  if (existsSync(copyRoot)) throw new Error('C5 immutable-artifact destination must be absent');
  await realpath(dirname(copyRoot));
  if (inside(sourceRoot, copyRoot) || inside(copyRoot, sourceRoot)) throw new Error('C5 immutable-artifact source and destination roots are not disjoint');
  const sourceInventory = await inventoryTree(sourceRoot);
  await mkdir(copyRoot, { mode: 0o700 });
  await copyDirectory({ source_root: sourceRoot, copy_root: copyRoot, source_directory: sourceRoot, copy_directory: copyRoot, exclusions: new Set() });
  const copyInventory = await inventoryTree(copyRoot);
  assertNoSharedRegularFileIdentity(sourceInventory, copyInventory);
  assertCloneSymlinksContained(copyRoot, copyInventory);
  return Object.freeze({ source_inventory: sourceInventory, copy_inventory: copyInventory });
}

export async function buildIsolatedStateCopy(input: {
  readonly source_state_root: string;
  readonly source_repository_root: string;
  readonly copy_state_root: string;
}): Promise<StateCopyResult> {
  const sourceState = await realpath(input.source_state_root);
  const copyState = resolve(input.copy_state_root);
  if (existsSync(copyState)) throw new Error('C5 state-copy destination must be absent');
  await realpath(dirname(copyState));
  if (inside(sourceState, copyState) || inside(copyState, sourceState)) throw new Error('C5 state-copy source and destination roots are not disjoint');
  const authority = authorityExclusions(sourceState);
  const registrations = closedGitWorktreeRegistrationFacts(input.source_repository_root);
  const registeredWorktrees = registrations.filter((entry) => existsSync(entry.worktree_path) && inside(sourceState, entry.worktree_path)).map((entry) => resolve(entry.worktree_path)).sort(compareCodeUnits);
  const exclusions = new Set([...authority, ...registeredWorktrees]);
  const sourceInventory = await inventoryTree(sourceState);
  await mkdir(copyState, { mode: 0o700 });
  await copyDirectory({ source_root: sourceState, copy_root: copyState, source_directory: sourceState, copy_directory: copyState, exclusions });
  const capabilitySha256 = await publishFreshCapability(copyState);
  const copyInventory = await inventoryTree(copyState);
  assertNoSharedRegularFileIdentity(sourceInventory, copyInventory);
  assertCloneSymlinksContained(copyState, copyInventory);
  return Object.freeze({ source_inventory: sourceInventory, copy_inventory: copyInventory, skipped_authority_paths: authority, skipped_registered_worktrees: Object.freeze(registeredWorktrees), capability_sha256: capabilitySha256 });
}
