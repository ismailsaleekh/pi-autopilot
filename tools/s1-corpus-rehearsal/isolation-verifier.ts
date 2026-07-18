import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { gitWorktreeRegistrationFacts } from '../../src/core/coordination/worktree-postconditions.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import type { IsolationProof, IsolationProofs, Sha256Digest } from './contracts.ts';
import { type CloneEnvironment, verifyCloneEnvironment } from './environment.ts';
import { verifyGitObjectClosure } from './git-mirror.ts';
import { assertCloneSymlinksContained, assertDisjointCanonicalRoots, assertNoSharedRegularFileIdentity, compareCodeUnits, inventoryDigest, inventoryTree, readRegularFileNoFollow, type TreeInventory } from './inventory.ts';
import { actionableJsonFacts } from './path-rebase.ts';
import { proveSandboxWriteConfinement } from './sandbox.ts';
import type { CoherentSqliteSnapshot } from './sqlite-snapshot.ts';

const READ_ONLY_GIT_ENV = Object.freeze({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });

export interface IsolationVerificationResult {
  readonly proofs: IsolationProofs;
  readonly source_before_sha256: Sha256Digest;
  readonly source_after_sha256: Sha256Digest;
  readonly copy_sha256: Sha256Digest;
}

function digest(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function proof(value: unknown): IsolationProof {
  return Object.freeze({ passed: true, evidence_sha256: digest(canonicalJson(value)) });
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function inventorySetDigest(inventories: readonly TreeInventory[]): Sha256Digest {
  const facts = inventories.map((inventory) => ({ canonical_root_sha256: digest(inventory.canonical_root), inventory_sha256: inventoryDigest(inventory) })).sort((left, right) => compareCodeUnits(left.canonical_root_sha256, right.canonical_root_sha256));
  return digest(canonicalJson(facts));
}

function capabilityDigest(stateRoot: string, requirePrivateCloneAuthority: boolean): Sha256Digest {
  const path = coordinatorRuntimePaths({ [AUTOPILOT_STATE_ROOT_ENV]: stateRoot }).capabilityPath;
  const input = readRegularFileNoFollow(path, 1024);
  if (requirePrivateCloneAuthority && (input.identity.link_count !== 1 || process.platform !== 'win32' && (input.mode & 0o077) !== 0)) throw new Error('C5 clone capability does not have private single-link authority');
  const capability = Buffer.from(input.bytes).toString('utf8').trim();
  if (!/^[a-f0-9]{64}$/u.test(capability)) throw new Error('C5 clone capability is missing or malformed');
  return digest(Buffer.from(capability, 'hex'));
}

function assertAuthorityRetired(stateRoot: string): readonly string[] {
  const paths = coordinatorRuntimePaths({ [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
  const forbidden = [
    `${paths.databasePath}-journal`, `${paths.databasePath}-wal`, `${paths.databasePath}-shm`, paths.writerGuardPath,
    paths.currentStorePointerPath, paths.runtimeIdentityPath, paths.storesRoot,
    paths.lockPath, paths.lifecycleElectionPath, paths.startupLockPath, paths.startupElectionPath,
    paths.predecessorLockPath, paths.predecessorStartupLockPath, paths.sessionsRoot, paths.startupReportsRoot,
    ...(inside(stateRoot, paths.socketPath) ? [paths.socketPath] : []),
    ...(inside(stateRoot, paths.predecessorSocketPath) ? [paths.predecessorSocketPath] : []),
  ];
  if (forbidden.some(existsSync)) throw new Error('C5 executable clone retained live authority artifacts');
  capabilityDigest(stateRoot, true);
  return Object.freeze(forbidden.map((path) => relative(stateRoot, path).split(sep).join('/')).sort(compareCodeUnits));
}

async function assertGitIsolated(cloneRoot: string, repositoryRoots: readonly string[]): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const facts: Readonly<Record<string, unknown>>[] = [];
  for (const repositoryRoot of repositoryRoots) {
    if (!inside(cloneRoot, repositoryRoot)) throw new Error('C5 repository root escapes clone authority');
    const gitCommon = join(repositoryRoot, '.git');
    await verifyGitObjectClosure(gitCommon);
    const hooks = join(gitCommon, 'hooks');
    const hookNames = existsSync(hooks) ? readdirSync(hooks).sort(compareCodeUnits) : [];
    if (hookNames.length > 10_000) throw new Error('C5 hooks directory exceeds bounded verifier size');
    if (hookNames.length > 0) throw new Error('C5 Git hooks remain');
    const registrations = gitWorktreeRegistrationFacts(gitCommon, READ_ONLY_GIT_ENV);
    for (const registration of registrations) if (!inside(cloneRoot, registration.worktree_path)) throw new Error('C5 Git registration targets outside clone authority');
    facts.push(Object.freeze({ git_common_sha256: digest(gitCommon), registrations }));
  }
  return Object.freeze(facts);
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name=?").get(table)?.['count'] === 1;
}

function assertActionableDatabasePaths(cloneRoot: string, databasePath: string): readonly Readonly<Record<string, unknown>>[] {
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 30_000 });
  const facts: Readonly<Record<string, unknown>>[] = [];
  try {
    database.exec('PRAGMA query_only=ON');
    if (!tableExists(database, 'repositories')) throw new Error('C5 clone database omits repositories');
    for (const row of database.prepare('SELECT repo_id,canonical_root,git_common_dir FROM repositories ORDER BY repo_id').all()) {
      const repoId = row['repo_id'];
      const root = row['canonical_root'];
      const common = row['git_common_dir'];
      if (typeof repoId !== 'string' || typeof root !== 'string' || typeof common !== 'string' || !inside(cloneRoot, root) || !inside(cloneRoot, common)) throw new Error('C5 repository projection retains an outside actionable path');
      facts.push(Object.freeze({ table: 'repositories', identity_sha256: digest(repoId), path_count: 2 }));
    }
    for (const table of ['run_resources', 'worktrees', 'worktree_operations'] as const) {
      if (!tableExists(database, table)) throw new Error(`C5 clone database omits ${table}`);
      for (const row of database.prepare(`SELECT entity_id,payload_json FROM "${table}" ORDER BY entity_id`).all()) {
        const id = row['entity_id'];
        const payload = row['payload_json'];
        if (typeof id !== 'string' || typeof payload !== 'string') throw new Error(`C5 ${table} projection is malformed`);
        const parsed = JSON.parse(payload) as unknown;
        const actionable = actionableJsonFacts(parsed);
        for (const path of actionable.absolute_paths) if (!inside(cloneRoot, path.value)) throw new Error(`C5 ${table} projection retains an outside actionable path at ${path.pointer}`);
        if (actionable.writable_remote_pointers.length > 0) throw new Error(`C5 ${table} projection retains writable remote fields`);
        facts.push(Object.freeze({ table, identity_sha256: digest(id), path_count: actionable.absolute_paths.length }));
      }
    }
  } finally { database.close(); }
  return Object.freeze(facts);
}

export async function verifyCloneIsolation(input: {
  readonly source_roots: readonly string[];
  readonly source_state_roots: readonly string[];
  readonly clone_root: string;
  readonly copy_state_roots: readonly string[];
  readonly copy_repository_roots: readonly string[];
  readonly copy_artifact_roots?: readonly string[];
  readonly copy_database_paths: readonly string[];
  readonly coherent_sqlite_snapshots: readonly CoherentSqliteSnapshot[];
  readonly source_before: readonly TreeInventory[];
  readonly clone_environment: CloneEnvironment;
  readonly sandbox_clone_root?: string;
  readonly sandbox_cwd: string;
  readonly sandbox_outside_sentinel_path: string;
  readonly sandbox_outside_sentinel_owner_root: string;
}): Promise<IsolationVerificationResult> {
  if (input.source_roots.length === 0 || input.copy_state_roots.length === 0 || input.copy_repository_roots.length === 0 || input.copy_database_paths.length === 0) throw new Error('C5 isolation verifier requires complete source/copy roots');
  const cloneRoot = resolve(input.clone_root);
  const sandboxRoot = resolve(input.sandbox_clone_root ?? cloneRoot);
  if (!inside(cloneRoot, sandboxRoot)) throw new Error('C5 sandbox root escapes the measured clone root');
  const environmentProof = verifyCloneEnvironment(sandboxRoot, input.clone_environment.env);
  if (environmentProof !== input.clone_environment.proof_sha256) throw new Error('C5 clone environment proof does not match independently derived environment');
  const sandboxProof = await proveSandboxWriteConfinement({ clone_root: sandboxRoot, cwd: input.sandbox_cwd, env: input.clone_environment.env, outside_sentinel_path: input.sandbox_outside_sentinel_path, outside_sentinel_owner_root: input.sandbox_outside_sentinel_owner_root, denied_source_roots: input.source_roots });
  const copyRoots = [...input.copy_state_roots, ...input.copy_repository_roots, ...(input.copy_artifact_roots ?? [])];
  for (const source of input.source_roots) for (const copy of copyRoots) assertDisjointCanonicalRoots(source, copy);
  const copyInventories = await Promise.all(copyRoots.map(async (root) => await inventoryTree(root)));
  const sourceAfter = await Promise.all(input.source_roots.map(async (root) => await inventoryTree(root)));
  for (const source of sourceAfter) for (const copy of copyInventories) assertNoSharedRegularFileIdentity(source, copy);
  for (const copy of copyInventories) assertCloneSymlinksContained(cloneRoot, copy);
  const sourceBeforeSha256 = inventorySetDigest(input.source_before);
  const sourceAfterSha256 = inventorySetDigest(sourceAfter);
  if (sourceBeforeSha256 !== sourceAfterSha256) throw new Error('C5 live/source inventory changed during clone construction');
  const authority = input.copy_state_roots.map(assertAuthorityRetired);
  const sourceCapabilities = input.source_state_roots.map((root) => capabilityDigest(root, false));
  const copyCapabilities = input.copy_state_roots.map((root) => capabilityDigest(root, true));
  if (copyCapabilities.some((value) => sourceCapabilities.includes(value)) || new Set(copyCapabilities).size !== copyCapabilities.length) throw new Error('C5 clone capability was copied or reused');
  const gitFacts = await assertGitIsolated(cloneRoot, input.copy_repository_roots);
  const pathFacts = input.copy_database_paths.flatMap((path) => assertActionableDatabasePaths(cloneRoot, path));
  const sqliteFacts = input.coherent_sqlite_snapshots.map((snapshot) => ({ source: snapshot.source_logical_before.logical_sha256, copy: snapshot.copy_logical.logical_sha256, stable: snapshot.source_logical_before.logical_sha256 === snapshot.source_logical_after.logical_sha256 && snapshot.source_logical_before.logical_sha256 === snapshot.copy_logical.logical_sha256 }));
  if (sqliteFacts.some((fact) => !fact.stable)) throw new Error('C5 coherent SQLite snapshot proof drifted');
  const rootsEvidence = { source: input.source_roots.map((path) => digest(resolve(path))).sort(compareCodeUnits), copy: copyRoots.map((path) => digest(resolve(path))).sort(compareCodeUnits) };
  const identityEvidence = { source: sourceAfter.map(inventoryDigest).sort(compareCodeUnits), copy: copyInventories.map(inventoryDigest).sort(compareCodeUnits) };
  const copySha256 = inventorySetDigest(copyInventories);
  const proofs: IsolationProofs = Object.freeze({
    roots_disjoint: proof(rootsEvidence),
    no_shared_regular_file_identity: proof(identityEvidence),
    no_live_symlink_or_hardlink: proof(copyInventories.map((inventory) => inventory.tree_sha256)),
    coherent_sqlite_snapshot: proof(sqliteFacts),
    git_objects_self_contained: proof(gitFacts),
    git_no_alternates_or_shared_metadata: proof(gitFacts),
    no_live_writable_remote_or_config_include: proof(gitFacts),
    authority_files_removed: proof(authority),
    capability_fresh: proof({ source: sourceCapabilities, copy: copyCapabilities }),
    actionable_paths_clone_contained: proof(pathFacts),
    environment_clone_only: Object.freeze({ passed: true, evidence_sha256: environmentProof }),
    sandbox_write_confinement: Object.freeze({ passed: true, evidence_sha256: sandboxProof }),
    construction_live_unchanged: proof({ source_before: sourceBeforeSha256, source_after: sourceAfterSha256 }),
  });
  return Object.freeze({ proofs, source_before_sha256: sourceBeforeSha256, source_after_sha256: sourceAfterSha256, copy_sha256: copySha256 });
}
