import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { AutopilotStatusToolContext } from './forced-output/identity.ts';
import type { AutopilotToolCallContextLike, AutopilotToolCallEventLike, AutopilotGuardDecision } from './git-guard.ts';
import type { AutopilotUnitSpec, AutopilotVerificationPlan, AutopilotWitnessSpec } from './contracts/types.ts';
import {
  AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE,
  estimateBytesForMaterializationPaths,
  normalizeMaterializationPath,
  pathMatchesMaterializationPattern,
  readCheckoutProfileSnapshot,
  scanTrackedTree,
  sparseIncludePatternsForPaths,
  submodulePathsForMaterialization,
  trackedPathExists,
  type AutopilotCheckoutProfileSnapshot,
  type AutopilotTrackedTreeScan,
} from './checkout-profile.ts';
import { assertAutopilotDiskGate } from './disk-gate.ts';
import { addSparseCheckoutPatterns, assertSparseCheckoutEnabled, isSparseCheckoutEnabled, isSparseMissingPath } from './sparse-worktree.ts';
import {
  acquireReadClaimsForUnitPaths,
  appendJsonl,
  coordinationRootForRepo,
  readActiveAutopilots,
  readPathClaims,
  releaseReadClaimsForUnitPaths,
  taskRootForActiveAutopilot,
  writeJsonAtomic,
  type ActiveAutopilotContext,
  type ActiveAutopilotRow,
  type AutopilotClaimType,
  type ProcessEnvLike,
} from './parallel-runtime.ts';
import { AUTOPILOT_RUNTIME_ROOT_PREFIX } from './names.ts';

export const AUTOPILOT_MATERIALIZATION_LEDGER_FILE = '_materialization-ledger.jsonl';
export const AUTOPILOT_MATERIALIZED_PATHS_FILE = '_materialized-paths.json';
export const AUTOPILOT_MATERIALIZE_CONTEXT_TOOL = 'autopilot_materialize_context';

export interface AutopilotMaterializedPathRow {
  readonly path: string;
  readonly claim_type: AutopilotClaimType;
  readonly byte_count: number;
  readonly reason: string;
  readonly automatic: boolean;
  readonly materialized_at: string;
}

export interface AutopilotMaterializedPathsFile {
  readonly schema_version: 'autopilot.materialized_paths.v1';
  readonly workstream: string;
  readonly workstream_run: string;
  readonly unit_id: string;
  readonly attempt: number;
  readonly paths: readonly AutopilotMaterializedPathRow[];
}

export interface AutopilotMaterializationEvent {
  readonly schema_version: 'autopilot.materialization_event.v1';
  readonly event: 'materialize';
  readonly ts: string;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly unit_id: string;
  readonly attempt: number;
  readonly claim_type: AutopilotClaimType;
  readonly paths: readonly string[];
  readonly targets: readonly ('main' | 'unit')[];
  readonly reason: string;
  readonly byte_count: number;
  readonly automatic: boolean;
}

export interface SourceMaterializationPath {
  readonly path: string;
  readonly claim_type: AutopilotClaimType;
  readonly reason: string;
}

export interface MaterializationResult {
  readonly checkout_mode: 'sparse' | 'full' | 'legacy-full';
  readonly materialized_paths: readonly SourceMaterializationPath[];
  readonly targets: readonly ('main' | 'unit')[];
  readonly byte_count: number;
}

export class AutopilotMaterializationError extends Error {
  override readonly name = 'AutopilotMaterializationError';
  readonly code: string;
  readonly evidence: readonly string[];

  constructor(code: string, message: string, evidence: readonly string[] = []) {
    super(`AutopilotMaterializationError [${code}]: ${message}`);
    this.code = code;
    this.evidence = Object.freeze([...evidence]);
  }
}

function fail(code: string, message: string, evidence: readonly string[] = []): never {
  throw new AutopilotMaterializationError(code, message, evidence);
}

export async function assertAutopilotSpecMaterializationDiskGate(input: {
  readonly context: ActiveAutopilotContext;
  readonly spec: AutopilotUnitSpec;
  readonly now?: Date;
}): Promise<void> {
  const taskRoot = taskRootForActiveAutopilot(input.context.active);
  const snapshot = await readCheckoutProfileSnapshot(join(taskRoot, AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE));
  if (snapshot === null || snapshot.profile.mode === 'full') return;
  const paths = sourceMaterializationPathsForSpec(input.spec).map((path) => path.path);
  const scan = scanTrackedTree(input.context.active.main_worktree_path, input.now ?? new Date());
  const byteCount = estimateBytesForMaterializationPaths(scan, paths);
  assertAutopilotDiskGate({
    path: input.context.active.worktree_root,
    projection: {
      profileMode: snapshot.profile.mode,
      diskGate: snapshot.profile.disk_gate,
      perWorktreeEstimateBytes: snapshot.base_checkout_bytes,
      additionalMaterializationBytes: byteCount,
      worktreeCount: 1,
    },
  });
}

export async function materializeAutopilotSpecPaths(input: {
  readonly context: ActiveAutopilotContext;
  readonly spec: AutopilotUnitSpec;
  readonly reason: string;
  readonly env?: ProcessEnvLike;
  readonly now?: Date;
}): Promise<MaterializationResult> {
  const materializationPaths = sourceMaterializationPathsForSpec(input.spec);
  return await materializePathsForSpec({
    context: input.context,
    spec: input.spec,
    paths: materializationPaths,
    reason: input.reason,
    automatic: false,
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

export async function materializeAdditionalReadPathsForSpec(input: {
  readonly context: ActiveAutopilotContext;
  readonly spec: AutopilotUnitSpec;
  readonly paths: readonly string[];
  readonly reason: string;
  readonly env?: ProcessEnvLike;
  readonly now?: Date;
}): Promise<MaterializationResult> {
  const now = input.now ?? new Date();
  const normalized = sortedUnique(input.paths.map((path) => normalizeMaterializationPath(path, 'auto READ path')).filter((path) => !isRuntimeRepoPath(path, input.spec.workstream)));
  if (normalized.length === 0) return { checkout_mode: 'legacy-full', materialized_paths: [], targets: [], byte_count: 0 };
  const taskRoot = taskRootForActiveAutopilot(input.context.active);
  const snapshot = await readCheckoutProfileSnapshot(join(taskRoot, AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE));
  if (snapshot === null || snapshot.profile.mode === 'full') {
    return { checkout_mode: snapshot === null ? 'legacy-full' : 'full', materialized_paths: [], targets: [], byte_count: 0 };
  }
  if (!snapshot.profile.materialization.auto_read_claims) {
    fail('auto-read-disabled', 'Autopilot sparse materialization refused: automatic READ materialization is disabled by checkout profile.', normalized);
  }
  const materialized = await readMaterializedPaths(input.context.active, input.spec);
  const existingAutoReadRows = materialized.paths.filter((row) => row.automatic && row.claim_type === 'READ');
  const existingAutoReadBytes = existingAutoReadRows.reduce((sum, row) => sum + row.byte_count, 0);
  const scan = scanTrackedTree(input.context.active.main_worktree_path, now);
  for (const path of normalized) {
    if (!trackedPathExists(scan, path)) {
      fail('auto-read-untracked', 'Autopilot sparse materialization refused: requested READ path is not tracked at this worktree HEAD.', [path]);
    }
  }
  const byteCount = estimateBytesForMaterializationPaths(scan, normalized);
  if (normalized.length + existingAutoReadRows.length > snapshot.profile.materialization.max_auto_read_paths) {
    fail('auto-read-path-cap', 'Autopilot sparse materialization refused: automatic READ path count exceeds checkout profile cap.', [
      `requested=${String(normalized.length)}`,
      `existing=${String(existingAutoReadRows.length)}`,
      `cap=${String(snapshot.profile.materialization.max_auto_read_paths)}`,
    ]);
  }
  if (byteCount > snapshot.profile.materialization.max_single_materialization_bytes) {
    fail('auto-read-single-byte-cap', 'Autopilot sparse materialization refused: path is tracked but exceeds auto-read materialization cap. Ask parent to amend read_only_paths or split the unit.', [
      `requested_bytes=${String(byteCount)}`,
      `cap=${String(snapshot.profile.materialization.max_single_materialization_bytes)}`,
      ...normalized,
    ]);
  }
  if (existingAutoReadBytes + byteCount > snapshot.profile.materialization.max_auto_read_bytes) {
    fail('auto-read-total-byte-cap', 'Autopilot sparse materialization refused: unit automatic READ materialization total exceeds checkout profile cap.', [
      `existing_bytes=${String(existingAutoReadBytes)}`,
      `requested_bytes=${String(byteCount)}`,
      `cap=${String(snapshot.profile.materialization.max_auto_read_bytes)}`,
    ]);
  }
  await acquireReadClaimsForUnitPaths({
    context: input.context,
    unitId: input.spec.unit_id,
    attempt: input.spec.attempt,
    paths: normalized,
    reason: input.reason,
    now,
  });
  const rows = normalized.map((path): SourceMaterializationPath => ({ path, claim_type: 'READ', reason: input.reason }));
  try {
    return await materializePathsForSpec({
      context: input.context,
      spec: input.spec,
      paths: rows,
      reason: input.reason,
      automatic: true,
      ...(input.env === undefined ? {} : { env: input.env }),
      now,
    });
  } catch (error) {
    await releaseReadClaimsForUnitPaths({
      context: input.context,
      unitId: input.spec.unit_id,
      attempt: input.spec.attempt,
      paths: normalized,
      reason: 'auto READ materialization failure claim rollback',
      now,
    }).catch(() => undefined);
    throw error;
  }
}

export async function expandedReadOnlyPathsForAudit(input: {
  readonly context: ActiveAutopilotContext;
  readonly spec: AutopilotUnitSpec;
}): Promise<readonly string[]> {
  const claims = await readPathClaims(input.context.coordinationRoot);
  const expanded = claims.filter((claim) =>
    claim.autopilot_id === input.context.active.autopilot_id &&
    claim.workstream_run === input.context.active.workstream_run &&
    claim.unit_id === input.spec.unit_id &&
    claim.attempt === input.spec.attempt &&
    claim.claim_type === 'READ',
  ).map((claim) => claim.path);
  return sortedUnique([...input.spec.read_only_paths, ...expanded]);
}

export async function materializeSparseReadForToolCall(input: {
  readonly event: AutopilotToolCallEventLike;
  readonly toolContext: AutopilotToolCallContextLike;
  readonly statusContext: AutopilotStatusToolContext;
  readonly env?: ProcessEnvLike;
}): Promise<AutopilotGuardDecision> {
  if (input.event.toolName !== 'read' && input.event.toolName !== 'Read') return undefined;
  const rawPath = input.event.input?.['path'] ?? input.event.input?.['file_path'];
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) return undefined;
  const spec = input.statusContext.unit_spec;
  const cwd = input.toolContext.cwd ?? spec.cwd;
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
  if (!isPathInsideRoot(spec.cwd, absolute)) return undefined;
  if (existsSync(absolute)) return undefined;
  const repoRelative = relativePathInsideRoot(spec.cwd, absolute);
  if (repoRelative === null) return undefined;
  if (!isSparseCheckoutEnabled(spec.cwd, input.env)) return undefined;
  if (!isSparseMissingPath(spec.cwd, repoRelative, input.env)) return undefined;
  try {
    const context = await resolveActiveContextForStatusContext(input.statusContext, input.env ?? process.env);
    await materializeAdditionalReadPathsForSpec({
      context,
      spec,
      paths: [repoRelative],
      reason: 'child Read sparse miss auto-materialization',
      ...(input.env === undefined ? {} : { env: input.env }),
    });
    return undefined;
  } catch (error) {
    return {
      block: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function resolveActiveContextForStatusContext(
  statusContext: AutopilotStatusToolContext,
  env: ProcessEnvLike = process.env,
): Promise<ActiveAutopilotContext> {
  const spec = statusContext.unit_spec;
  const taskRoot = taskRootFromArtifactRoot(statusContext.artifact_root, spec.workstream);
  if (taskRoot === null) fail('invalid-artifact-root', 'Autopilot status context artifact_root does not end with the workstream runtime root.', [statusContext.artifact_root]);
  const taskInfoPath = join(taskRoot, '_task-info.json');
  let taskInfo: Readonly<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(await readFile(taskInfoPath, 'utf8')) as unknown;
    if (!isRecord(parsed)) fail('invalid-task-info', '_task-info.json must contain an object.', [taskInfoPath]);
    taskInfo = parsed;
  } catch (error) {
    if (error instanceof AutopilotMaterializationError) throw error;
    fail('task-info-read-failed', `failed to read Autopilot task info: ${errorMessage(error)}`, [taskInfoPath]);
  }
  const repoKey = taskInfo['repo_key'];
  if (typeof repoKey !== 'string' || repoKey.length === 0) fail('invalid-task-info', '_task-info.json repo_key must be a non-empty string.', [taskInfoPath]);
  const coordinationRoot = coordinationRootForRepo(repoKey, env);
  const rows = await readActiveAutopilots(coordinationRoot);
  const active = rows.find((row) => row.workstream === spec.workstream && row.runtime_root === statusContext.artifact_root && row.workstream_run === taskInfo['workstream_run']);
  if (active === undefined) fail('active-row-not-found', 'no active Autopilot row matches child status context.', [spec.workstream, statusContext.artifact_root]);
  return Object.freeze({
    repo: {
      repoRoot: active.source_repo,
      gitCommonDir: active.git_common_dir,
      repoKey: active.repo_key,
      headSha: active.target_base_sha,
      targetBranch: active.target_branch,
      originUrl: active.origin_url,
    },
    active,
    coordinationRoot,
    claimsPath: join(coordinationRoot, 'path-claims.json'),
    claimEventsPath: join(coordinationRoot, 'claim-events.jsonl'),
  });
}

export function sourceMaterializationPathsForSpec(spec: AutopilotUnitSpec): readonly SourceMaterializationPath[] {
  const rows: SourceMaterializationPath[] = [];
  const add = (path: string, claimType: AutopilotClaimType, reason: string): void => {
    const normalized = normalizeMaterializationPath(path, reason);
    if (isRuntimeRepoPath(normalized, spec.workstream)) return;
    rows.push({ path: normalized, claim_type: claimType, reason });
  };
  for (const path of spec.owned_paths) add(path, 'WRITE', 'unit owned_paths');
  for (const path of spec.read_only_paths) add(path, 'READ', 'unit read_only_paths');
  for (const ref of spec.context_refs) add(ref.path, 'READ', 'unit context_refs');
  for (const witness of witnessesFromVerificationPlan(spec.verification_plan)) {
    if (witness.inspection_target !== undefined) add(witness.inspection_target, 'READ', 'unit verification inspection_target');
  }
  return Object.freeze(dedupeMaterializationRows(rows));
}

export function sourceReadClaimPathsForSpec(spec: AutopilotUnitSpec): readonly string[] {
  const owned = spec.owned_paths.map((path) => normalizeMaterializationPath(path, 'owned path'));
  const rows = sourceMaterializationPathsForSpec(spec).filter((row) => row.claim_type === 'READ' && !owned.some((ownedPath) => pathMatchesMaterializationPattern(row.path, ownedPath) || pathMatchesMaterializationPattern(ownedPath, row.path)));
  return sortedUnique(rows.map((row) => row.path));
}

async function materializePathsForSpec(input: {
  readonly context: ActiveAutopilotContext;
  readonly spec: AutopilotUnitSpec;
  readonly paths: readonly SourceMaterializationPath[];
  readonly reason: string;
  readonly automatic: boolean;
  readonly env?: ProcessEnvLike;
  readonly now?: Date;
}): Promise<MaterializationResult> {
  const now = input.now ?? new Date();
  const paths = dedupeMaterializationRows(input.paths);
  if (paths.length === 0) return { checkout_mode: 'legacy-full', materialized_paths: [], targets: [], byte_count: 0 };
  const taskRoot = taskRootForActiveAutopilot(input.context.active);
  const snapshotPath = join(taskRoot, AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE);
  const snapshot = await readCheckoutProfileSnapshot(snapshotPath);
  if (snapshot === null) {
    await ensureFutureOwnedParents(input.spec.cwd, paths.filter((path) => path.claim_type === 'WRITE').map((path) => path.path));
    return { checkout_mode: 'legacy-full', materialized_paths: paths, targets: [], byte_count: 0 };
  }
  if (snapshot.profile.mode === 'full') {
    await ensureFutureOwnedParents(input.spec.cwd, paths.filter((path) => path.claim_type === 'WRITE').map((path) => path.path));
    return { checkout_mode: 'full', materialized_paths: paths, targets: [], byte_count: 0 };
  }
  const scan = scanTrackedTree(input.context.active.main_worktree_path, now);
  assertNoUnsupportedSubmodules(scan, paths.map((path) => path.path));
  const byteCount = estimateBytesForMaterializationPaths(scan, paths.map((path) => path.path));
  assertAutopilotDiskGate({
    path: input.context.active.worktree_root,
    projection: {
      profileMode: snapshot.profile.mode,
      diskGate: snapshot.profile.disk_gate,
      perWorktreeEstimateBytes: snapshot.base_checkout_bytes,
      additionalMaterializationBytes: byteCount,
      worktreeCount: 1,
    },
  });
  const targets = materializationTargets(input.context.active, input.spec);
  const patterns = sparseIncludePatternsForPaths(paths.map((path) => path.path));
  for (const target of targets) {
    const worktreePath = target === 'main' ? input.context.active.main_worktree_path : input.spec.cwd;
    assertSparseCheckoutEnabled(worktreePath, input.env);
    addSparseCheckoutPatterns(worktreePath, patterns, input.env);
    if (target === 'unit') {
      await ensureFutureOwnedParents(worktreePath, paths.filter((path) => path.claim_type === 'WRITE').map((path) => path.path));
    }
    assertTrackedPathsMaterialized(worktreePath, scan, paths.map((path) => path.path));
    assertNoLfsPointerMaterialized(worktreePath, scan, paths.map((path) => path.path));
  }
  await appendMaterializationLedger(input.context.active, input.spec, paths, targets, byteCount, input.reason, input.automatic, now);
  await upsertMaterializedPaths(input.context.active, input.spec, paths, scan, input.reason, input.automatic, now);
  return { checkout_mode: 'sparse', materialized_paths: paths, targets, byte_count: byteCount };
}

function materializationTargets(active: ActiveAutopilotRow, spec: AutopilotUnitSpec): readonly ('main' | 'unit')[] {
  if ((spec.role === 'implement' || spec.role === 'fix') && resolve(spec.cwd) !== resolve(active.main_worktree_path)) return Object.freeze(['main', 'unit'] as const);
  return Object.freeze(['main'] as const);
}

async function appendMaterializationLedger(
  active: ActiveAutopilotRow,
  spec: AutopilotUnitSpec,
  paths: readonly SourceMaterializationPath[],
  targets: readonly ('main' | 'unit')[],
  byteCount: number,
  reason: string,
  automatic: boolean,
  now: Date,
): Promise<void> {
  for (const claimType of ['WRITE', 'READ'] as const) {
    const typedPaths = paths.filter((path) => path.claim_type === claimType).map((path) => path.path);
    if (typedPaths.length === 0) continue;
    const event: AutopilotMaterializationEvent = {
      schema_version: 'autopilot.materialization_event.v1',
      event: 'materialize',
      ts: now.toISOString(),
      workstream: active.workstream,
      workstream_run: active.workstream_run,
      unit_id: spec.unit_id,
      attempt: spec.attempt,
      claim_type: claimType,
      paths: typedPaths,
      targets,
      reason,
      byte_count: byteCount,
      automatic,
    };
    await appendJsonl(join(taskRootForActiveAutopilot(active), AUTOPILOT_MATERIALIZATION_LEDGER_FILE), event);
  }
}

async function upsertMaterializedPaths(
  active: ActiveAutopilotRow,
  spec: AutopilotUnitSpec,
  paths: readonly SourceMaterializationPath[],
  scan: AutopilotTrackedTreeScan,
  reason: string,
  automatic: boolean,
  now: Date,
): Promise<void> {
  const path = join(dirname(spec.cwd), AUTOPILOT_MATERIALIZED_PATHS_FILE);
  const existing = await readMaterializedPaths(active, spec);
  const rows = new Map(existing.paths.map((row) => [row.path, row]));
  for (const item of paths) {
    rows.set(item.path, {
      path: item.path,
      claim_type: item.claim_type,
      byte_count: estimateBytesForMaterializationPaths(scan, [item.path]),
      reason,
      automatic,
      materialized_at: now.toISOString(),
    });
  }
  const next: AutopilotMaterializedPathsFile = {
    schema_version: 'autopilot.materialized_paths.v1',
    workstream: active.workstream,
    workstream_run: active.workstream_run,
    unit_id: spec.unit_id,
    attempt: spec.attempt,
    paths: [...rows.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
  await writeJsonAtomic(path, next);
}

async function readMaterializedPaths(active: ActiveAutopilotRow, spec: AutopilotUnitSpec): Promise<AutopilotMaterializedPathsFile> {
  const path = join(dirname(spec.cwd), AUTOPILOT_MATERIALIZED_PATHS_FILE);
  if (!existsSync(path)) {
    return { schema_version: 'autopilot.materialized_paths.v1', workstream: active.workstream, workstream_run: active.workstream_run, unit_id: spec.unit_id, attempt: spec.attempt, paths: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    fail('invalid-materialized-paths', `failed to read materialized paths file: ${errorMessage(error)}`, [path]);
  }
  return parseMaterializedPaths(parsed, path);
}

function parseMaterializedPaths(value: unknown, path: string): AutopilotMaterializedPathsFile {
  const record = requireRecord(value, 'materialized paths file');
  const rowsValue = record['paths'];
  if (!Array.isArray(rowsValue)) fail('invalid-materialized-paths', 'paths must be an array.', [path]);
  const rows = Object.freeze(rowsValue.map((row) => parseMaterializedPathRow(row, path)));
  return Object.freeze({
    schema_version: expectConst(record, 'schema_version', 'autopilot.materialized_paths.v1'),
    workstream: expectString(record, 'workstream'),
    workstream_run: expectString(record, 'workstream_run'),
    unit_id: expectString(record, 'unit_id'),
    attempt: expectInteger(record, 'attempt'),
    paths: rows,
  });
}

function parseMaterializedPathRow(value: unknown, path: string): AutopilotMaterializedPathRow {
  const record = requireRecord(value, 'materialized path row');
  return Object.freeze({
    path: normalizeMaterializationPath(expectString(record, 'path'), path),
    claim_type: expectClaimType(record, 'claim_type'),
    byte_count: expectInteger(record, 'byte_count'),
    reason: expectString(record, 'reason'),
    automatic: expectBoolean(record, 'automatic'),
    materialized_at: expectString(record, 'materialized_at'),
  });
}

function assertNoUnsupportedSubmodules(scan: AutopilotTrackedTreeScan, paths: readonly string[]): void {
  const submodules = submodulePathsForMaterialization(scan, paths);
  if (submodules.length > 0) {
    fail('submodule-materialization-unsupported', 'Autopilot sparse materialization refused: claimed path overlaps a git submodule and no package submodule policy is enabled.', submodules);
  }
}

function assertTrackedPathsMaterialized(worktreePath: string, scan: AutopilotTrackedTreeScan, paths: readonly string[]): void {
  const missing: string[] = [];
  for (const path of paths) {
    for (const entry of scan.entries) {
      if (entry.object_type !== 'blob') continue;
      if (!pathMatchesMaterializationPattern(entry.path, path)) continue;
      if (!existsSync(join(worktreePath, ...entry.path.split('/')))) missing.push(entry.path);
      break;
    }
  }
  if (missing.length > 0) fail('materialization-missing-tracked-path', 'sparse checkout did not materialize tracked path(s) after successful sparse add.', missing);
}

function assertNoLfsPointerMaterialized(worktreePath: string, scan: AutopilotTrackedTreeScan, paths: readonly string[]): void {
  const lfsPointers: string[] = [];
  for (const path of paths) {
    for (const entry of scan.entries) {
      if (entry.object_type !== 'blob' || entry.byte_count > 1_000_000) continue;
      if (!pathMatchesMaterializationPattern(entry.path, path)) continue;
      const absolute = join(worktreePath, ...entry.path.split('/'));
      if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
      const text = readFileSync(absolute, 'utf8').slice(0, 120);
      if (text.startsWith('version https://git-lfs.github.com/spec/v1')) lfsPointers.push(entry.path);
    }
  }
  if (lfsPointers.length > 0) {
    fail('lfs-materialization-unsupported', 'Autopilot sparse materialization refused: claimed path materialized as a Git LFS pointer; enable an explicit operator-approved LFS policy before child launch.', lfsPointers);
  }
}

async function ensureFutureOwnedParents(worktreePath: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const normalized = normalizeMaterializationPath(path, 'future owned path');
    if (normalized.endsWith('/**')) {
      await mkdir(join(worktreePath, ...normalized.slice(0, -3).split('/')), { recursive: true });
      continue;
    }
    await mkdir(dirname(join(worktreePath, ...normalized.split('/'))), { recursive: true });
  }
}

function taskRootFromArtifactRoot(artifactRoot: string, workstream: string): string | null {
  const suffix = `${AUTOPILOT_RUNTIME_ROOT_PREFIX}/${workstream}`;
  if (!artifactRoot.endsWith(suffix)) return null;
  const mainWorktree = artifactRoot.slice(0, artifactRoot.length - suffix.length).replace(/\/$/u, '');
  return dirname(mainWorktree);
}

function isRuntimeRepoPath(path: string, workstream: string): boolean {
  const runtime = `${AUTOPILOT_RUNTIME_ROOT_PREFIX}/${workstream}`;
  return pathMatchesMaterializationPattern(path, runtime) || pathMatchesMaterializationPattern(runtime, path);
}

function relativePathInsideRoot(root: string, absolute: string): string | null {
  const rel = relative(resolve(root), resolve(absolute));
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return null;
  return rel.replace(/\\/gu, '/');
}

function isPathInsideRoot(root: string, absolute: string): boolean {
  return relativePathInsideRoot(root, absolute) !== null;
}

function witnessesFromVerificationPlan(plan: AutopilotVerificationPlan | undefined): readonly AutopilotWitnessSpec[] {
  if (plan === undefined) return [];
  return Object.freeze([
    ...plan.positive_witnesses,
    ...plan.negative_witnesses,
    ...plan.regression_witnesses,
    ...plan.real_boundary_witnesses,
    ...plan.blast_radius_checks,
    ...plan.docs_schema_prompt_checks,
    ...plan.dirty_tree_checks,
  ]);
}

function dedupeMaterializationRows(rows: readonly SourceMaterializationPath[]): readonly SourceMaterializationPath[] {
  const byKey = new Map<string, SourceMaterializationPath>();
  for (const row of rows) {
    const key = `${row.claim_type}\0${row.path}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return Object.freeze([...byKey.values()].sort((left, right) => `${left.claim_type}:${left.path}`.localeCompare(`${right.claim_type}:${right.path}`)));
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) fail('invalid-json', `${label} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) fail('invalid-json', `${key} must be a non-empty string.`);
  return value;
}

function expectInteger(record: Readonly<Record<string, unknown>>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('invalid-json', `${key} must be a non-negative safe integer.`);
  return value;
}

function expectBoolean(record: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') fail('invalid-json', `${key} must be boolean.`);
  return value;
}

function expectConst<T extends string>(record: Readonly<Record<string, unknown>>, key: string, expected: T): T {
  const value = record[key];
  if (value !== expected) fail('invalid-json', `${key} must equal ${expected}.`);
  return expected;
}

function expectClaimType(record: Readonly<Record<string, unknown>>, key: string): AutopilotClaimType {
  const value = record[key];
  if (value === 'READ' || value === 'WRITE' || value === 'EXCLUSIVE') return value;
  fail('invalid-json', `${key} must be READ, WRITE, or EXCLUSIVE.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
