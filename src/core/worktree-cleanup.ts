import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { AUTOPILOT_RUNTIME_ROOT_PREFIX } from './names.ts';
import { executeOwnedWorktreeSaga, type WorktreeSagaInspection } from './coordination/worktree-saga.ts';
import {
  BRANCHES_FILE,
  MATERIALIZED_PATHS_FILE,
  UNIT_INDEX_FILE,
  UNIT_INFO_FILE,
  WORKTREE_LEDGER_FILE,
  appendJsonl,
  readGitStatus,
  readUnitIndex,
  taskRootForActiveAutopilot,
  unitWorktreePathForActiveAutopilot,
  withAutopilotFileLock,
  writeJsonAtomic,
  writeUnitIndex,
  type ActiveAutopilotRow,
  type AutopilotUnitBranchInfo,
  type ProcessEnvLike,
} from './parallel-runtime.ts';

export type AutopilotWorktreeCleanupMode =
  | 'terminal-unit-prune'
  | 'terminal-unit-transition'
  | 'preflight-rollback'
  | 'closed-run-cleanup';

export interface AutopilotWorktreeCleanupResult {
  readonly schema_version: 'autopilot.worktree_cleanup_result.v1';
  readonly mode: AutopilotWorktreeCleanupMode;
  readonly repo_key: string;
  readonly autopilot_id: string;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly removed_paths: readonly string[];
  readonly reconciled_missing_paths: readonly string[];
  readonly retired_branches: readonly string[];
  readonly pruned_git_metadata: boolean;
  readonly active_task_dir_removed: boolean;
  readonly ledger_path: string;
  readonly created_at: string;
}

export class AutopilotWorktreeCleanupError extends Error {
  override readonly name = 'AutopilotWorktreeCleanupError';
  readonly code: string;
  readonly evidence: readonly string[];

  constructor(code: string, message: string, evidence: readonly string[] = []) {
    super(`AutopilotWorktreeCleanupError [${code}]: ${message}`);
    this.code = code;
    this.evidence = [...evidence];
  }
}

type UnitStatus = AutopilotUnitBranchInfo['status'];
type CleanTerminalUnitStatus = 'merged' | 'aborted' | 'superseded';

type CleanupLedgerEvent = Readonly<{
  schema_version: 'autopilot.worktree_ledger.v1';
  event: string;
  ts: string;
  repo_key: string;
  workstream: string;
  workstream_run: string;
  autopilot_id: string;
  mode: AutopilotWorktreeCleanupMode;
  reason: string;
  path?: string;
  branch?: string;
  unit_id?: string;
  attempt?: number;
  status?: UnitStatus;
  archive_ref?: string | null;
  proof?: readonly string[];
  blockers?: readonly string[];
}>;

interface CleanupAccumulator {
  readonly removedPaths: string[];
  readonly reconciledMissingPaths: string[];
  readonly retiredBranches: string[];
  prunedGitMetadata: boolean;
  activeTaskDirRemoved: boolean;
}

export interface WorktreeListEntry {
  readonly path: string;
  readonly branch: string | null;
  readonly prunable: boolean;
}

interface BranchesSnapshot {
  readonly activeBranch: string;
  readonly baseSha: string;
  readonly currentSha: string;
  readonly archiveRef: string | null;
  readonly unitBranches: readonly AutopilotUnitBranchInfo[];
}

interface ResidualEntry {
  readonly relativePath: string;
  readonly directory: boolean;
}

function fail(code: string, message: string, evidence: readonly string[] = []): never {
  throw new AutopilotWorktreeCleanupError(code, message, evidence);
}

export async function cleanupTerminalUnitWorktreesForRun(input: {
  readonly active: ActiveAutopilotRow;
  readonly reason: string;
  readonly env?: ProcessEnvLike;
  readonly now?: Date;
}): Promise<AutopilotWorktreeCleanupResult> {
  return await withCleanupLock(input.active, async () => {
    const now = input.now ?? new Date();
    const acc = emptyAccumulator();
    const units = await loadScopedUnitRows(input.active);
    for (const unit of units) {
      if (isCleanTerminalStatus(unit.status)) {
        await cleanupTerminalUnit(input.active, unit, acc, {
          mode: 'terminal-unit-prune',
          reason: input.reason,
          now,
          env: input.env,
          retireBranch: true,
        });
      }
    }
    await pruneGitMetadataAfterProof(input.active, acc, 'terminal-unit-prune', input.reason, now, input.env);
    verifyNoPathResidue(input.active.source_repo, [...acc.removedPaths, ...acc.reconciledMissingPaths], input.env);
    return cleanupResult(input.active, 'terminal-unit-prune', acc, now);
  });
}

export async function cleanupTerminalUnitWorktree(input: {
  readonly active: ActiveAutopilotRow;
  readonly unitId: string;
  readonly attempt: number;
  readonly allowedStatuses?: readonly CleanTerminalUnitStatus[];
  readonly reason: string;
  readonly env?: ProcessEnvLike;
  readonly now?: Date;
}): Promise<AutopilotWorktreeCleanupResult> {
  return await withCleanupLock(input.active, async () => {
    const now = input.now ?? new Date();
    const acc = emptyAccumulator();
    const unit = await requireScopedUnit(input.active, input.unitId, input.attempt);
    const allowed = input.allowedStatuses ?? ['merged', 'aborted', 'superseded'];
    if (!isCleanTerminalStatus(unit.status) || !allowed.includes(unit.status)) {
      await appendLedger(input.active, {
        mode: 'terminal-unit-transition',
        event: 'unit-worktree-cleanup-blocked',
        reason: input.reason,
        now,
        path: unit.worktree_path,
        branch: unit.branch,
        unitId: unit.unit_id,
        attempt: unit.attempt,
        status: unit.status,
        blockers: [`unit status is ${unit.status}`],
      });
      fail('unit-status-not-terminal', 'refusing to remove a unit worktree whose metadata status is not an allowed clean terminal state.', [unit.unit_id, String(unit.attempt), unit.status]);
    }
    await cleanupTerminalUnit(input.active, unit, acc, {
      mode: 'terminal-unit-transition',
      reason: input.reason,
      now,
      env: input.env,
      retireBranch: true,
    });
    await pruneGitMetadataAfterProof(input.active, acc, 'terminal-unit-transition', input.reason, now, input.env);
    verifyNoPathResidue(input.active.source_repo, [...acc.removedPaths, ...acc.reconciledMissingPaths], input.env);
    return cleanupResult(input.active, 'terminal-unit-transition', acc, now);
  });
}

export async function rollbackCreatedUnitWorktree(input: {
  readonly active: ActiveAutopilotRow;
  readonly unitId: string;
  readonly attempt: number;
  readonly reason: string;
  readonly env?: ProcessEnvLike;
  readonly now?: Date;
}): Promise<AutopilotWorktreeCleanupResult> {
  return await withCleanupLock(input.active, async () => {
    const now = input.now ?? new Date();
    const acc = emptyAccumulator();
    const unit = await requireScopedUnit(input.active, input.unitId, input.attempt);
    if (unit.status !== 'active') {
      await appendLedger(input.active, {
        mode: 'preflight-rollback',
        event: 'unit-worktree-rollback-blocked',
        reason: input.reason,
        now,
        path: unit.worktree_path,
        branch: unit.branch,
        unitId: unit.unit_id,
        attempt: unit.attempt,
        status: unit.status,
        blockers: [`unit status is ${unit.status}`],
      });
      fail('rollback-unit-not-active', 'preflight rollback only applies to the active unit attempt created for the failed launch.', [unit.unit_id, String(unit.attempt), unit.status]);
    }
    await removeRegisteredWorktree(input.active, unit.worktree_path, acc, {
      mode: 'preflight-rollback',
      reason: input.reason,
      now,
      env: input.env,
      unit,
      dirtyBlockCode: 'dirty-preflight-rollback',
      dirtyBlockMessage: 'refusing to roll back a newly-created unit worktree with dirty residue; owned quarantine recovery is required.',
    });
    await retireBranchIfPresent(input.active, unit.branch, unit.current_sha, acc, 'preflight-rollback', input.reason, now, input.env, unit);
    await removeUnitMetadataForRollback(input.active, unit, now, input.reason);
    await removeUnitAttemptRootAfterRollback(input.active, unit, now, input.reason);
    await pruneGitMetadataAfterProof(input.active, acc, 'preflight-rollback', input.reason, now, input.env);
    verifyNoPathResidue(input.active.source_repo, [...acc.removedPaths, ...acc.reconciledMissingPaths], input.env);
    return cleanupResult(input.active, 'preflight-rollback', acc, now);
  });
}

export async function cleanupClosedAutopilotRun(input: {
  readonly active: ActiveAutopilotRow;
  readonly archiveRef: string;
  readonly archiveSha: string;
  readonly reason: string;
  readonly removeActiveTaskDir: boolean;
  readonly env?: ProcessEnvLike;
  readonly now?: Date;
}): Promise<AutopilotWorktreeCleanupResult> {
  return await withCleanupLock(input.active, async () => {
    const now = input.now ?? new Date();
    const acc = emptyAccumulator();
    const units = await loadScopedUnitRows(input.active);
    const inspectMainArchive = (): WorktreeSagaInspection => {
      const result = spawnSync('git', ['rev-parse', '--verify', `refs/heads/${input.archiveRef}`], { cwd: input.active.source_repo, encoding: 'utf8', env: runtimeGitEnv('worktree-cleanup-archive-inspect', input.env) });
      if ((result.status ?? -1) !== 0) return { outcome: 'not-applied', proof: ['archive_ref_absent'] };
      return result.stdout.trim() === input.archiveSha ? { outcome: 'satisfied', proof: [`archive_ref=${input.archiveRef}`, `archive_sha=${input.archiveSha}`] } : { outcome: 'unsafe', proof: [`expected=${input.archiveSha}`, `actual=${result.stdout.trim()}`] };
    };
    await executeOwnedWorktreeSaga({
      active: input.active, unitId: 'main', attempt: 1, kind: 'main', operationType: 'archive',
      operationKey: `main-archive:${input.archiveRef}:${input.archiveSha}`,
      initialWorktreeState: 'active', committedWorktreeState: 'terminal',
      intent: {
        repo_root: input.active.source_repo, worktree_path: input.active.main_worktree_path, git_common_dir: input.active.git_common_dir,
        branch: input.active.branch, reason: input.reason, base_sha: input.active.target_base_sha, target_sha: input.archiveSha,
        archive_ref: input.archiveRef, checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [`_archive/${input.active.workstream_run}`],
      },
    }, {
      inspect: inspectMainArchive,
      action: () => { runGitForCleanup(['update-ref', `refs/heads/${input.archiveRef}`, input.archiveSha, '0'.repeat(40)], input.active.source_repo, runtimeGitEnv('worktree-cleanup-archive-ref', input.env)); },
      verify: () => {
        const inspected = inspectMainArchive();
        if (inspected.outcome !== 'satisfied') fail('main-archive-postcondition', 'main archive ref saga postcondition failed.', inspected.proof);
        return inspected.proof;
      },
    }, input.env ?? process.env);
    await appendLedger(input.active, {
      mode: 'closed-run-cleanup',
      event: 'main-branch-archive-ref',
      reason: input.reason,
      now,
      path: input.active.main_worktree_path,
      branch: input.archiveRef,
      proof: [`archive_sha=${input.archiveSha}`],
    });
    for (const unit of units) {
      if (!isCleanTerminalStatus(unit.status)) {
        await appendLedger(input.active, {
          mode: 'closed-run-cleanup',
          event: 'closed-run-cleanup-blocked',
          reason: input.reason,
          now,
          path: unit.worktree_path,
          branch: unit.branch,
          unitId: unit.unit_id,
          attempt: unit.attempt,
          status: unit.status,
          blockers: [`unit status is ${unit.status}`],
        });
        fail('nonterminal-unit-worktree', 'closed-run cleanup refuses active, quarantined, or unresolved unit worktrees.', [unit.unit_id, String(unit.attempt), unit.status]);
      }
      await cleanupTerminalUnit(input.active, unit, acc, {
        mode: 'closed-run-cleanup',
        reason: input.reason,
        now,
        env: input.env,
        retireBranch: true,
      });
    }
    await removeMainWorktree(input.active, acc, input.archiveSha, input.reason, now, input.env);
    await retireBranchIfPresent(input.active, input.active.branch, input.archiveSha, acc, 'closed-run-cleanup', input.reason, now, input.env);
    await pruneGitMetadataAfterProof(input.active, acc, 'closed-run-cleanup', input.reason, now, input.env);
    const runOwnedWorktreePaths = [input.active.main_worktree_path, ...units.map((unit) => unit.worktree_path)];
    verifyNoPathResidue(input.active.source_repo, runOwnedWorktreePaths, input.env);
    if (input.removeActiveTaskDir) {
      await removeActiveTaskDirectory(input.active, units, acc, input.reason, now, input.env);
    }
    verifyNoPathResidue(input.active.source_repo, runOwnedWorktreePaths, input.env);
    if (input.removeActiveTaskDir && existsSync(taskRootForActiveAutopilot(input.active))) {
      fail('active-task-dir-remains', 'active task directory still exists after closed-run cleanup.', [taskRootForActiveAutopilot(input.active)]);
    }
    return cleanupResult(input.active, 'closed-run-cleanup', acc, now);
  });
}

export function gitWorktreeListPorcelain(repoRoot: string, env: ProcessEnvLike = process.env): readonly WorktreeListEntry[] {
  const output = runGitForCleanup(['worktree', 'list', '--porcelain'], repoRoot, runtimeGitEnv('worktree-cleanup-list', env));
  return parseWorktreeList(output);
}

function emptyAccumulator(): CleanupAccumulator {
  return { removedPaths: [], reconciledMissingPaths: [], retiredBranches: [], prunedGitMetadata: false, activeTaskDirRemoved: false };
}

async function withCleanupLock<T>(active: ActiveAutopilotRow, run: () => Promise<T>): Promise<T> {
  assertActiveRowScope(active);
  const lockPath = join(active.worktree_root, '.locks', `${active.workstream_run}.worktree-cleanup.lock`);
  return await withAutopilotFileLock(lockPath, `worktree-cleanup:${active.autopilot_id}:${active.workstream_run}`, run);
}

async function cleanupTerminalUnit(
  active: ActiveAutopilotRow,
  unit: AutopilotUnitBranchInfo,
  acc: CleanupAccumulator,
  input: {
    readonly mode: AutopilotWorktreeCleanupMode;
    readonly reason: string;
    readonly now: Date;
    readonly env?: ProcessEnvLike | undefined;
    readonly retireBranch: boolean;
  },
): Promise<void> {
  assertScopedUnitPath(active, unit);
  if (!isCleanTerminalStatus(unit.status)) {
    fail('unit-status-not-terminal', 'refusing to remove a unit worktree whose metadata status is not clean terminal.', [unit.unit_id, String(unit.attempt), unit.status]);
  }
  await removeRegisteredWorktree(active, unit.worktree_path, acc, {
    mode: input.mode,
    reason: input.reason,
    now: input.now,
    env: input.env,
    unit,
    dirtyBlockCode: 'dirty-terminal-unit-worktree',
    dirtyBlockMessage: 'refusing to remove dirty terminal unit worktree; owned reset, abort, or quarantine recovery is required.',
  });
  if (input.retireBranch) await retireBranchIfPresent(active, unit.branch, unit.current_sha, acc, input.mode, input.reason, input.now, input.env, unit);
}

async function removeRegisteredWorktree(
  active: ActiveAutopilotRow,
  worktreePath: string,
  acc: CleanupAccumulator,
  input: {
    readonly mode: AutopilotWorktreeCleanupMode;
    readonly reason: string;
    readonly now: Date;
    readonly env?: ProcessEnvLike | undefined;
    readonly unit?: AutopilotUnitBranchInfo | undefined;
    readonly dirtyBlockCode: string;
    readonly dirtyBlockMessage: string;
  },
): Promise<void> {
  const unit = input.unit;
  if (unit === undefined) fail('unit-cleanup-owner-missing', 'unit worktree removal requires exact unit ownership metadata.', [worktreePath]);
  const listedBefore = gitWorktreeListPorcelain(active.source_repo, input.env);
  const registeredBefore = listedBefore.some((entry) => samePath(entry.path, worktreePath));
  if (!existsSync(worktreePath)) {
    acc.reconciledMissingPaths.push(worktreePath);
    await appendLedger(active, {
      mode: input.mode, event: 'worktree-missing-reconcile', reason: input.reason, now: input.now, path: worktreePath,
      ...ledgerUnitFields(unit), proof: [registeredBefore ? 'git_metadata_present_before_prune' : 'git_metadata_absent_before_prune'],
    });
  }
  if (existsSync(worktreePath) && !registeredBefore) {
    await appendLedger(active, {
      mode: input.mode, event: 'worktree-cleanup-blocked', reason: input.reason, now: input.now, path: worktreePath,
      ...ledgerUnitFields(unit), blockers: ['path is not registered by git worktree list'],
    });
    fail('worktree-not-registered', 'refusing to remove a physical path that is not registered as a Git worktree for this repository.', [worktreePath]);
  }
  const dirtyPaths = existsSync(worktreePath) ? readGitStatus(worktreePath).changedPaths : [];
  if (dirtyPaths.length > 0) {
    await appendLedger(active, {
      mode: input.mode, event: 'worktree-cleanup-blocked', reason: input.reason, now: input.now, path: worktreePath,
      ...ledgerUnitFields(unit), blockers: dirtyPaths,
    });
    fail(input.dirtyBlockCode, input.dirtyBlockMessage, dirtyPaths);
  }
  const inspectRemove = (): WorktreeSagaInspection => {
    const listed = gitWorktreeListPorcelain(active.source_repo, input.env);
    const present = existsSync(worktreePath);
    const registered = listed.some((entry) => samePath(entry.path, worktreePath));
    if (present !== registered) {
      const metadata = listed.find((entry) => samePath(entry.path, worktreePath));
      if (present || !registered || metadata?.branch !== unit.branch) return { outcome: 'unsafe', proof: [`path_present=${String(present)}`, `git_registered=${String(registered)}`, `expected_metadata_branch=${unit.branch}`, `actual_metadata_branch=${String(metadata?.branch ?? null)}`] };
    }
    if (!present) {
      if (!branchExists(active.source_repo, unit.branch, input.env)) return { outcome: 'satisfied', proof: ['path_absent', 'git_registration_absent', 'branch_absent'] };
      const actualBranchSha = runGitForCleanup(['rev-parse', `refs/heads/${unit.branch}`], active.source_repo, runtimeGitEnv('worktree-cleanup-branch-head', input.env)).trim();
      return actualBranchSha === unit.current_sha ? { outcome: 'not-applied', proof: ['path_absent', 'branch_present'] } : { outcome: 'unsafe', proof: [`branch_expected=${unit.current_sha}`, `branch_actual=${actualBranchSha}`] };
    }
    const dirty = readGitStatus(worktreePath).changedPaths;
    return dirty.length === 0 ? { outcome: 'not-applied', proof: ['worktree_clean'] } : { outcome: 'unsafe', proof: dirty.map((path) => `dirty=${path}`) };
  };
  await executeOwnedWorktreeSaga({
    active, unitId: unit.unit_id, attempt: unit.attempt, kind: 'unit', operationType: 'remove',
    operationKey: `remove:${unit.unit_id}:${String(unit.attempt)}:${unit.current_sha}`,
    initialWorktreeState: 'terminal', committedWorktreeState: 'removed',
    intent: {
      repo_root: active.source_repo, worktree_path: worktreePath, git_common_dir: active.git_common_dir, branch: unit.branch,
      reason: input.reason, base_sha: unit.base_sha, target_sha: unit.current_sha, archive_ref: unit.archive_ref,
      checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [WORKTREE_LEDGER_FILE],
    },
  }, {
    inspect: inspectRemove,
    action: () => {
      if (existsSync(worktreePath) || gitWorktreeListPorcelain(active.source_repo, input.env).some((entry) => samePath(entry.path, worktreePath))) runGitForCleanup(['worktree', 'remove', worktreePath], active.source_repo, runtimeGitEnv('worktree-cleanup-remove', input.env));
      if (branchExists(active.source_repo, unit.branch, input.env)) {
        const actualBranchSha = runGitForCleanup(['rev-parse', `refs/heads/${unit.branch}`], active.source_repo, runtimeGitEnv('worktree-cleanup-branch-head', input.env)).trim();
        if (actualBranchSha !== unit.current_sha) fail('branch-retire-sha-mismatch', 'owned branch moved after cleanup intent; refusing retirement.', [unit.branch, `expected=${unit.current_sha}`, `actual=${actualBranchSha}`]);
        runGitForCleanup(['update-ref', '-d', `refs/heads/${unit.branch}`, unit.current_sha], active.source_repo, runtimeGitEnv('worktree-cleanup-branch-retire', input.env));
      }
    },
    verify: () => {
      const inspected = inspectRemove();
      if (inspected.outcome !== 'satisfied') fail('worktree-remove-incomplete', 'owned worktree remove saga postcondition failed.', inspected.proof);
      return inspected.proof;
    },
  }, input.env ?? process.env);
  if (existsSync(worktreePath)) fail('worktree-remove-incomplete', 'worktree remove saga committed but the path still exists.', [worktreePath]);
  acc.removedPaths.push(worktreePath);
  if (!acc.retiredBranches.includes(unit.branch)) acc.retiredBranches.push(unit.branch);
  await appendLedger(active, {
    mode: input.mode, event: 'worktree-remove', reason: input.reason, now: input.now, path: worktreePath,
    ...ledgerUnitFields(unit), proof: ['saga_committed', 'git_worktree_remove_succeeded_or_already_absent', 'branch_absent', 'path_absent_after_remove'],
  });
}

async function removeMainWorktree(
  active: ActiveAutopilotRow,
  acc: CleanupAccumulator,
  expectedSha: string,
  reason: string,
  now: Date,
  env?: ProcessEnvLike,
): Promise<void> {
  assertActiveRowScope(active);
  const mainPath = active.main_worktree_path;
  const listedBefore = gitWorktreeListPorcelain(active.source_repo, env);
  const registeredBefore = listedBefore.some((entry) => samePath(entry.path, mainPath));
  if (!existsSync(mainPath)) {
    acc.reconciledMissingPaths.push(mainPath);
    await appendLedger(active, {
      mode: 'closed-run-cleanup',
      event: 'main-worktree-missing-reconcile',
      reason,
      now,
      path: mainPath,
      branch: active.branch,
      proof: [registeredBefore ? 'git_metadata_present_before_prune' : 'git_metadata_absent_before_prune'],
    });
  }
  if (existsSync(mainPath) && !registeredBefore) {
    await appendLedger(active, {
      mode: 'closed-run-cleanup',
      event: 'main-worktree-cleanup-blocked',
      reason,
      now,
      path: mainPath,
      branch: active.branch,
      blockers: ['main path is not registered by git worktree list'],
    });
    fail('main-worktree-not-registered', 'refusing to remove a physical main path that is not registered as a Git worktree for this repository.', [mainPath]);
  }
  const dirtySourcePaths = existsSync(mainPath) ? readGitStatus(mainPath).changedPaths.filter((path) => !isRuntimeRepoPath(active, path)) : [];
  if (dirtySourcePaths.length > 0) {
    await appendLedger(active, {
      mode: 'closed-run-cleanup',
      event: 'main-worktree-cleanup-blocked',
      reason,
      now,
      path: mainPath,
      branch: active.branch,
      blockers: dirtySourcePaths,
    });
    fail('dirty-main-worktree', 'refusing to remove main worktree with dirty source residue.', dirtySourcePaths);
  }
  await removeArchivedRuntimeResidue(active, reason, now);
  const inspectMainRemove = (): WorktreeSagaInspection => {
    const listed = gitWorktreeListPorcelain(active.source_repo, env);
    const present = existsSync(mainPath);
    const registered = listed.some((entry) => samePath(entry.path, mainPath));
    if (present !== registered) {
      const metadata = listed.find((entry) => samePath(entry.path, mainPath));
      if (present || !registered || metadata?.branch !== active.branch) return { outcome: 'unsafe', proof: [`path_present=${String(present)}`, `git_registered=${String(registered)}`, `expected_metadata_branch=${active.branch}`, `actual_metadata_branch=${String(metadata?.branch ?? null)}`] };
    }
    if (!present) {
      if (!branchExists(active.source_repo, active.branch, env)) return { outcome: 'satisfied', proof: ['path_absent', 'git_registration_absent', 'branch_absent'] };
      const actualBranchSha = runGitForCleanup(['rev-parse', `refs/heads/${active.branch}`], active.source_repo, runtimeGitEnv('worktree-cleanup-branch-head', env)).trim();
      return actualBranchSha === expectedSha ? { outcome: 'not-applied', proof: ['path_absent', 'branch_present'] } : { outcome: 'unsafe', proof: [`branch_expected=${expectedSha}`, `branch_actual=${actualBranchSha}`] };
    }
    const dirty = readGitStatus(mainPath).changedPaths.filter((path) => !isRuntimeRepoPath(active, path));
    return dirty.length === 0 ? { outcome: 'not-applied', proof: ['main_source_clean'] } : { outcome: 'unsafe', proof: dirty.map((path) => `dirty=${path}`) };
  };
  await executeOwnedWorktreeSaga({
    active, unitId: 'main', attempt: 1, kind: 'main', operationType: 'remove',
    operationKey: `remove-main:${active.workstream_run}:${expectedSha}`,
    initialWorktreeState: 'terminal', committedWorktreeState: 'removed',
    intent: {
      repo_root: active.source_repo, worktree_path: mainPath, git_common_dir: active.git_common_dir, branch: active.branch,
      reason, base_sha: active.target_base_sha, target_sha: expectedSha, archive_ref: null, checkout_mode: null,
      sparse_patterns: [], paths: [], metadata_refs: [`_archive/${active.workstream_run}`],
    },
  }, {
    inspect: inspectMainRemove,
    action: () => {
      if (existsSync(mainPath) || gitWorktreeListPorcelain(active.source_repo, env).some((entry) => samePath(entry.path, mainPath))) runGitForCleanup(['worktree', 'remove', mainPath], active.source_repo, runtimeGitEnv('worktree-cleanup-remove-main', env));
      if (branchExists(active.source_repo, active.branch, env)) {
        const actualBranchSha = runGitForCleanup(['rev-parse', `refs/heads/${active.branch}`], active.source_repo, runtimeGitEnv('worktree-cleanup-branch-head', env)).trim();
        if (actualBranchSha !== expectedSha) fail('branch-retire-sha-mismatch', 'main branch moved after cleanup intent; refusing retirement.', [active.branch, `expected=${expectedSha}`, `actual=${actualBranchSha}`]);
        runGitForCleanup(['update-ref', '-d', `refs/heads/${active.branch}`, expectedSha], active.source_repo, runtimeGitEnv('worktree-cleanup-branch-retire', env));
      }
    },
    verify: () => {
      const inspected = inspectMainRemove();
      if (inspected.outcome !== 'satisfied') fail('main-worktree-remove-incomplete', 'main worktree remove saga postcondition failed.', inspected.proof);
      return inspected.proof;
    },
  }, env ?? process.env);
  if (existsSync(mainPath)) fail('main-worktree-remove-incomplete', 'main worktree remove saga committed but the main path still exists.', [mainPath]);
  acc.removedPaths.push(mainPath);
  if (!acc.retiredBranches.includes(active.branch)) acc.retiredBranches.push(active.branch);
  await appendLedger(active, {
    mode: 'closed-run-cleanup',
    event: 'main-worktree-remove',
    reason,
    now,
    path: mainPath,
    branch: active.branch,
    proof: ['runtime_residue_removed_after_archive', 'git_worktree_remove_succeeded', 'path_absent_after_remove'],
  });
}

async function removeArchivedRuntimeResidue(active: ActiveAutopilotRow, reason: string, now: Date): Promise<void> {
  const expectedRuntimeRoot = join(active.main_worktree_path, AUTOPILOT_RUNTIME_ROOT_PREFIX, active.workstream);
  if (!samePath(active.runtime_root, expectedRuntimeRoot)) {
    fail('runtime-root-not-run-owned', 'refusing main cleanup because runtime_root is not the deterministic path inside the main worktree.', [active.runtime_root, expectedRuntimeRoot]);
  }
  if (!existsSync(active.runtime_root)) return;
  await rm(active.runtime_root, { recursive: true, force: false });
  await removeEmptyDirectoryIfPresent(join(active.main_worktree_path, AUTOPILOT_RUNTIME_ROOT_PREFIX));
  await removeEmptyDirectoryIfPresent(join(active.main_worktree_path, '.pi'));
  await appendLedger(active, {
    mode: 'closed-run-cleanup',
    event: 'runtime-residue-remove',
    reason,
    now,
    path: active.runtime_root,
    proof: ['runtime_archive_completed_before_cleanup'],
  });
}

async function removeEmptyDirectoryIfPresent(path: string): Promise<void> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.length > 0) return;
    await rm(path, { recursive: true, force: false });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}

function branchExists(repoRoot: string, branch: string, env?: ProcessEnvLike): boolean {
  const result = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot, encoding: 'utf8', env: runtimeGitEnv('worktree-cleanup-branch-check', env) });
  if ((result.status ?? -1) === 0) return true;
  if ((result.status ?? -1) === 1) return false;
  fail('branch-check-failed', 'failed to inspect owned branch before cleanup.', [branch, result.stderr.trim()]);
}

async function retireBranchIfPresent(
  active: ActiveAutopilotRow,
  branch: string,
  expectedSha: string,
  acc: CleanupAccumulator,
  mode: AutopilotWorktreeCleanupMode,
  reason: string,
  now: Date,
  env?: ProcessEnvLike,
  unit?: AutopilotUnitBranchInfo,
): Promise<void> {
  const existed = branchExists(active.source_repo, branch, env);
  if (existed) {
    const actualSha = runGitForCleanup(['rev-parse', `refs/heads/${branch}`], active.source_repo, runtimeGitEnv('worktree-cleanup-branch-head', env)).trim();
    if (actualSha !== expectedSha) fail('branch-retire-sha-mismatch', 'owned branch moved before retirement; refusing deletion.', [branch, `expected=${expectedSha}`, `actual=${actualSha}`]);
    runGitForCleanup(['update-ref', '-d', `refs/heads/${branch}`, expectedSha], active.source_repo, runtimeGitEnv('worktree-cleanup-branch-retire', env));
  }
  acc.retiredBranches.push(branch);
  await appendLedger(active, {
    mode,
    event: 'branch-retire',
    reason,
    now,
    path: unit?.worktree_path ?? active.main_worktree_path,
    branch,
    ...ledgerUnitFields(unit),
    proof: [existed ? 'branch_deleted' : 'branch_already_absent'],
  });
}

async function pruneGitMetadataAfterProof(
  active: ActiveAutopilotRow,
  acc: CleanupAccumulator,
  mode: AutopilotWorktreeCleanupMode,
  reason: string,
  now: Date,
  env?: ProcessEnvLike,
): Promise<void> {
  const proofPaths = sortedUnique([...acc.removedPaths, ...acc.reconciledMissingPaths]);
  if (proofPaths.length === 0) return;
  const remaining = gitWorktreeListPorcelain(active.source_repo, env).filter((entry) => proofPaths.some((path) => samePath(entry.path, path)));
  if (remaining.length > 0) fail('git-worktree-metadata-remains', 'owned worktree metadata remains after exact path removal; refusing global prune that could mutate foreign runs.', remaining.map((entry) => entry.path));
  acc.prunedGitMetadata = true;
  await appendLedger(active, {
    mode,
    event: 'git-worktree-metadata-verified',
    reason,
    now,
    proof: proofPaths.map((path) => `run_owned_path_absent=${path}`),
  });
}

async function removeUnitMetadataForRollback(active: ActiveAutopilotRow, unit: AutopilotUnitBranchInfo, now: Date, reason: string): Promise<void> {
  const taskRoot = taskRootForActiveAutopilot(active);
  const index = await readUnitIndex(taskRoot);
  await writeUnitIndex(taskRoot, {
    schema_version: 'autopilot.unit_index.v1',
    units: index.units.filter((candidate) => !(candidate.unit_id === unit.unit_id && candidate.attempt === unit.attempt)),
  });
  const branches = await readBranchesSnapshot(taskRoot);
  if (branches !== null) {
    await writeJsonAtomic(join(taskRoot, BRANCHES_FILE), {
      schema_version: 'autopilot.branches.v1',
      active_branch: branches.activeBranch,
      base_sha: branches.baseSha,
      current_sha: branches.currentSha,
      archive_ref: branches.archiveRef,
      unit_branches: branches.unitBranches.filter((candidate) => !(candidate.unit_id === unit.unit_id && candidate.attempt === unit.attempt)),
    });
  }
  await appendLedger(active, {
    mode: 'preflight-rollback',
    event: 'unit-metadata-rollback',
    reason,
    now,
    path: unit.worktree_path,
    branch: unit.branch,
    unitId: unit.unit_id,
    attempt: unit.attempt,
    status: unit.status,
    proof: ['unit_index_removed', 'branches_index_removed'],
  });
}

async function removeUnitAttemptRootAfterRollback(active: ActiveAutopilotRow, unit: AutopilotUnitBranchInfo, now: Date, reason: string): Promise<void> {
  const attemptRoot = dirname(unit.worktree_path);
  assertPathWithinRoot(taskRootForActiveAutopilot(active), attemptRoot, 'rollback-attempt-root-outside-run');
  if (!existsSync(attemptRoot)) return;
  const entries = await collectResidualEntries(attemptRoot);
  const allowed = new Set<string>([UNIT_INFO_FILE, MATERIALIZED_PATHS_FILE]);
  const blockers = entries.filter((entry) => entry.directory || !allowed.has(entry.relativePath)).map((entry) => entry.relativePath);
  if (blockers.length > 0) {
    await appendLedger(active, {
      mode: 'preflight-rollback',
      event: 'unit-attempt-root-remove-blocked',
      reason,
      now,
      path: attemptRoot,
      branch: unit.branch,
      unitId: unit.unit_id,
      attempt: unit.attempt,
      status: unit.status,
      blockers,
    });
    fail('rollback-attempt-root-residue', 'refusing to remove rollback attempt directory with unexpected residue.', blockers);
  }
  await rm(attemptRoot, { recursive: true, force: false });
  await appendLedger(active, {
    mode: 'preflight-rollback',
    event: 'unit-attempt-root-remove',
    reason,
    now,
    path: attemptRoot,
    branch: unit.branch,
    unitId: unit.unit_id,
    attempt: unit.attempt,
    status: unit.status,
    proof: ['rollback_metadata_only'],
  });
}

async function removeActiveTaskDirectory(
  active: ActiveAutopilotRow,
  units: readonly AutopilotUnitBranchInfo[],
  acc: CleanupAccumulator,
  reason: string,
  now: Date,
  env?: ProcessEnvLike,
): Promise<void> {
  const taskRoot = taskRootForActiveAutopilot(active);
  assertPathWithinRoot(join(active.worktree_root, 'active'), taskRoot, 'active-task-root-outside-worktree-root');
  if (!existsSync(taskRoot)) {
    acc.reconciledMissingPaths.push(taskRoot);
    await appendLedger(active, {
      mode: 'closed-run-cleanup',
      event: 'active-task-dir-missing-reconcile',
      reason,
      now,
      path: taskRoot,
      proof: ['active_task_dir_absent_after_worktree_cleanup'],
    });
    return;
  }
  const listed = gitWorktreeListPorcelain(active.source_repo, env);
  const registeredUnderTaskRoot = listed.filter((entry) => isPathWithinRoot(taskRoot, entry.path)).map((entry) => entry.path);
  if (registeredUnderTaskRoot.length > 0) {
    await appendLedger(active, {
      mode: 'closed-run-cleanup',
      event: 'active-task-dir-remove-blocked',
      reason,
      now,
      path: taskRoot,
      blockers: registeredUnderTaskRoot,
    });
    fail('registered-worktree-under-task-root', 'refusing to remove active task directory while Git still registers run-owned worktree paths.', registeredUnderTaskRoot);
  }
  const blockers = await activeTaskDirectoryResidueBlockers(taskRoot, units);
  if (blockers.length > 0) {
    await appendLedger(active, {
      mode: 'closed-run-cleanup',
      event: 'active-task-dir-remove-blocked',
      reason,
      now,
      path: taskRoot,
      blockers,
    });
    fail('active-task-dir-unsafe-residue', 'refusing to remove active task directory with unexpected residue after archive.', blockers);
  }
  await rm(taskRoot, { recursive: true, force: false });
  if (existsSync(taskRoot)) fail('active-task-dir-remove-incomplete', 'active task directory removal returned success but the path still exists.', [taskRoot]);
  acc.activeTaskDirRemoved = true;
  acc.removedPaths.push(taskRoot);
  await appendLedger(active, {
    mode: 'closed-run-cleanup',
    event: 'active-task-dir-remove',
    reason,
    now,
    path: taskRoot,
    proof: ['archive_completed', 'no_registered_worktrees_under_task_root', 'residual_metadata_allowlist_matched'],
  });
}

async function activeTaskDirectoryResidueBlockers(taskRoot: string, units: readonly AutopilotUnitBranchInfo[]): Promise<readonly string[]> {
  const entries = await collectResidualEntries(taskRoot);
  const blockers: string[] = [];
  for (const entry of entries) {
    if (!isAllowedTaskResidual(entry, units)) blockers.push(entry.relativePath);
  }
  return sortedUnique(blockers);
}

function isAllowedTaskResidual(entry: ResidualEntry, units: readonly AutopilotUnitBranchInfo[]): boolean {
  const rootFiles = new Set<string>(['_task-info.json', BRANCHES_FILE, UNIT_INDEX_FILE, '_checkout-profile.json', '_materialization-ledger.jsonl']);
  if (!entry.directory && rootFiles.has(entry.relativePath)) return true;
  if (entry.relativePath === 'units' && entry.directory) return true;
  if (entry.relativePath === '.locks' && entry.directory) return true;
  if (entry.relativePath.startsWith('.locks/')) return true;
  for (const unit of units) {
    const unitRoot = `units/${unit.unit_id}`;
    const attemptRoot = `${unitRoot}/attempt-${String(unit.attempt)}`;
    if (entry.relativePath === unitRoot && entry.directory) return true;
    if (entry.relativePath === attemptRoot && entry.directory) return true;
    if (!entry.directory && entry.relativePath === `${attemptRoot}/${UNIT_INFO_FILE}`) return true;
    if (!entry.directory && entry.relativePath === `${attemptRoot}/${MATERIALIZED_PATHS_FILE}`) return true;
  }
  return false;
}

async function collectResidualEntries(root: string): Promise<readonly ResidualEntry[]> {
  const entries: ResidualEntry[] = [];
  await collectResidualEntriesInto(root, '', entries);
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function collectResidualEntriesInto(root: string, relativeDir: string, entries: ResidualEntry[]): Promise<void> {
  const absoluteDir = relativeDir.length === 0 ? root : join(root, relativeDir);
  const dirents = await readdir(absoluteDir, { withFileTypes: true });
  for (const dirent of dirents) {
    const rel = relativeDir.length === 0 ? dirent.name : `${relativeDir}/${dirent.name}`;
    entries.push({ relativePath: rel, directory: dirent.isDirectory() });
    if (dirent.isDirectory()) await collectResidualEntriesInto(root, rel, entries);
  }
}

async function loadScopedUnitRows(active: ActiveAutopilotRow): Promise<readonly AutopilotUnitBranchInfo[]> {
  assertActiveRowScope(active);
  const taskRoot = taskRootForActiveAutopilot(active);
  const index = await readUnitIndex(taskRoot);
  const branches = await readBranchesSnapshot(taskRoot);
  if (branches === null && index.units.length > 0) {
    fail('missing-branches-info', '_branches.json is required to prove run-owned unit branch/worktree cleanup authority.', [join(taskRoot, BRANCHES_FILE)]);
  }
  for (const unit of index.units) {
    assertScopedUnitPath(active, unit);
    const branchUnit = branches?.unitBranches.find((candidate) => candidate.unit_id === unit.unit_id && candidate.attempt === unit.attempt);
    if (branchUnit === undefined) {
      fail('unit-branch-metadata-missing', '_branches.json lacks the unit branch row required for cleanup proof.', [unit.unit_id, String(unit.attempt)]);
    }
    assertMatchingUnitRows(unit, branchUnit);
  }
  return [...index.units].sort((left, right) => unitKey(left).localeCompare(unitKey(right)));
}

async function requireScopedUnit(active: ActiveAutopilotRow, unitId: string, attempt: number): Promise<AutopilotUnitBranchInfo> {
  const units = await loadScopedUnitRows(active);
  const unit = units.find((candidate) => candidate.unit_id === unitId && candidate.attempt === attempt);
  if (unit === undefined) fail('unit-metadata-missing', 'unit attempt metadata is missing; cleanup refuses to infer ownership.', [unitId, String(attempt)]);
  return unit;
}

async function readBranchesSnapshot(taskRoot: string): Promise<BranchesSnapshot | null> {
  const path = join(taskRoot, BRANCHES_FILE);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    fail('invalid-branches-info', `failed to read _branches.json: ${errorMessage(error)}`, [path]);
  }
  if (!isRecord(parsed)) fail('invalid-branches-info', '_branches.json must contain an object.', [path]);
  expectConst(parsed, 'schema_version', 'autopilot.branches.v1', 'invalid-branches-info');
  const unitBranchesRaw = parsed['unit_branches'];
  if (!Array.isArray(unitBranchesRaw)) fail('invalid-branches-info', '_branches.json unit_branches must be an array.', [path]);
  return {
    activeBranch: expectString(parsed, 'active_branch', 'invalid-branches-info'),
    baseSha: expectString(parsed, 'base_sha', 'invalid-branches-info'),
    currentSha: expectString(parsed, 'current_sha', 'invalid-branches-info'),
    archiveRef: expectNullableString(parsed, 'archive_ref', 'invalid-branches-info'),
    unitBranches: unitBranchesRaw.map(parseUnitBranchInfo),
  };
}

function parseUnitBranchInfo(value: unknown): AutopilotUnitBranchInfo {
  if (!isRecord(value)) fail('invalid-unit-branch-info', 'unit branch info must be an object.');
  return {
    unit_id: expectString(value, 'unit_id', 'invalid-unit-branch-info'),
    attempt: expectInteger(value, 'attempt', 'invalid-unit-branch-info'),
    branch: expectString(value, 'branch', 'invalid-unit-branch-info'),
    worktree_path: expectString(value, 'worktree_path', 'invalid-unit-branch-info'),
    base_sha: expectString(value, 'base_sha', 'invalid-unit-branch-info'),
    current_sha: expectString(value, 'current_sha', 'invalid-unit-branch-info'),
    archive_ref: expectNullableString(value, 'archive_ref', 'invalid-unit-branch-info'),
    status: expectStatus(value, 'status', 'invalid-unit-branch-info'),
  };
}

function assertMatchingUnitRows(indexUnit: AutopilotUnitBranchInfo, branchUnit: AutopilotUnitBranchInfo): void {
  const mismatches: string[] = [];
  if (indexUnit.branch !== branchUnit.branch) mismatches.push('branch');
  if (!samePath(indexUnit.worktree_path, branchUnit.worktree_path)) mismatches.push('worktree_path');
  if (indexUnit.base_sha !== branchUnit.base_sha) mismatches.push('base_sha');
  if (indexUnit.current_sha !== branchUnit.current_sha) mismatches.push('current_sha');
  if (indexUnit.archive_ref !== branchUnit.archive_ref) mismatches.push('archive_ref');
  if (indexUnit.status !== branchUnit.status) mismatches.push('status');
  if (mismatches.length > 0) fail('unit-metadata-mismatch', '_unit-index.json and _branches.json disagree for a unit cleanup target.', [unitKey(indexUnit), ...mismatches]);
}

function assertActiveRowScope(active: ActiveAutopilotRow): void {
  if (active.repo_key.length === 0 || active.autopilot_id.length === 0 || active.workstream_run.length === 0) {
    fail('invalid-active-row-identity', 'cleanup requires repo_key, autopilot_id, and workstream_run identity.');
  }
  const expectedTaskRoot = join(active.worktree_root, 'active', active.workstream_run);
  const taskRoot = taskRootForActiveAutopilot(active);
  if (!samePath(taskRoot, expectedTaskRoot)) {
    fail('task-root-mismatch', 'active row main worktree path is not derived from active/<workstream-run>/main.', [taskRoot, expectedTaskRoot]);
  }
  const expectedMain = join(expectedTaskRoot, 'main');
  if (!samePath(active.main_worktree_path, expectedMain)) {
    fail('main-worktree-path-mismatch', 'active row main worktree path is not the deterministic run-owned main path.', [active.main_worktree_path, expectedMain]);
  }
  const expectedRuntime = join(active.main_worktree_path, AUTOPILOT_RUNTIME_ROOT_PREFIX, active.workstream);
  if (!samePath(active.runtime_root, expectedRuntime)) {
    fail('runtime-root-mismatch', 'active row runtime_root is not under this run-owned main worktree.', [active.runtime_root, expectedRuntime]);
  }
}

function assertScopedUnitPath(active: ActiveAutopilotRow, unit: AutopilotUnitBranchInfo): void {
  const expectedPath = unitWorktreePathForActiveAutopilot(active, unit.unit_id, unit.attempt);
  if (!samePath(unit.worktree_path, expectedPath)) {
    fail('foreign-unit-worktree-path', 'unit worktree path is not derived from this active row; refusing cleanup.', [unit.worktree_path, expectedPath]);
  }
  const expectedBranch = `autopilot/unit/${active.workstream_run}/${unit.unit_id}/attempt-${String(unit.attempt)}`;
  if (unit.branch !== expectedBranch) {
    fail('foreign-unit-branch', 'unit branch is not derived from this active row; refusing cleanup.', [unit.branch, expectedBranch]);
  }
}

function assertPathWithinRoot(root: string, candidate: string, code: string): void {
  if (!isPathWithinRoot(root, candidate)) fail(code, 'path is outside the expected run-owned root.', [candidate, root]);
}

function isCleanTerminalStatus(status: UnitStatus): status is CleanTerminalUnitStatus {
  return status === 'merged' || status === 'aborted' || status === 'superseded';
}

function isRuntimeRepoPath(active: ActiveAutopilotRow, repoPath: string): boolean {
  const runtimeRoot = `${AUTOPILOT_RUNTIME_ROOT_PREFIX}/${active.workstream}`;
  const normalized = repoPath.split('/').filter((segment) => segment.length > 0).join('/');
  return normalized === runtimeRoot || normalized.startsWith(`${runtimeRoot}/`);
}

function parseWorktreeList(output: string): readonly WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  let currentPrunable = false;
  const flush = (): void => {
    if (currentPath !== null) entries.push({ path: currentPath, branch: currentBranch, prunable: currentPrunable });
    currentPath = null;
    currentBranch = null;
    currentPrunable = false;
  };
  for (const line of output.split('\n')) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      currentPath = line.slice('worktree '.length);
      continue;
    }
    if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      currentBranch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      continue;
    }
    if (line.startsWith('prunable')) currentPrunable = true;
  }
  flush();
  return entries;
}

function verifyNoPathResidue(repoRoot: string, paths: readonly string[], env?: ProcessEnvLike): void {
  const uniquePaths = sortedUnique(paths);
  if (uniquePaths.length === 0) return;
  const listed = gitWorktreeListPorcelain(repoRoot, env);
  const diskResidue = uniquePaths.filter((path) => existsSync(path));
  const gitResidue = uniquePaths.filter((path) => listed.some((entry) => samePath(entry.path, path)));
  if (diskResidue.length > 0 || gitResidue.length > 0) {
    fail('cleanup-residue-remains', 'run-owned cleanup verification failed; path remains on disk or in git worktree metadata.', [
      ...diskResidue.map((path) => `disk=${path}`),
      ...gitResidue.map((path) => `git=${path}`),
    ]);
  }
}

function cleanupResult(active: ActiveAutopilotRow, mode: AutopilotWorktreeCleanupMode, acc: CleanupAccumulator, now: Date): AutopilotWorktreeCleanupResult {
  return {
    schema_version: 'autopilot.worktree_cleanup_result.v1',
    mode,
    repo_key: active.repo_key,
    autopilot_id: active.autopilot_id,
    workstream: active.workstream,
    workstream_run: active.workstream_run,
    removed_paths: sortedUnique(acc.removedPaths),
    reconciled_missing_paths: sortedUnique(acc.reconciledMissingPaths),
    retired_branches: sortedUnique(acc.retiredBranches),
    pruned_git_metadata: acc.prunedGitMetadata,
    active_task_dir_removed: acc.activeTaskDirRemoved,
    ledger_path: join(active.worktree_root, WORKTREE_LEDGER_FILE),
    created_at: now.toISOString(),
  };
}

function ledgerUnitFields(unit: AutopilotUnitBranchInfo | undefined): {
  readonly branch?: string;
  readonly unitId?: string;
  readonly attempt?: number;
  readonly status?: UnitStatus;
} {
  if (unit === undefined) return {};
  return { branch: unit.branch, unitId: unit.unit_id, attempt: unit.attempt, status: unit.status };
}

async function appendLedger(active: ActiveAutopilotRow, input: {
  readonly mode: AutopilotWorktreeCleanupMode;
  readonly event: string;
  readonly reason: string;
  readonly now: Date;
  readonly path?: string;
  readonly branch?: string;
  readonly unitId?: string;
  readonly attempt?: number;
  readonly status?: UnitStatus;
  readonly archiveRef?: string | null;
  readonly proof?: readonly string[];
  readonly blockers?: readonly string[];
}): Promise<void> {
  const row: CleanupLedgerEvent = {
    schema_version: 'autopilot.worktree_ledger.v1',
    event: input.event,
    ts: input.now.toISOString(),
    repo_key: active.repo_key,
    workstream: active.workstream,
    workstream_run: active.workstream_run,
    autopilot_id: active.autopilot_id,
    mode: input.mode,
    reason: input.reason,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    ...(input.unitId === undefined ? {} : { unit_id: input.unitId }),
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.archiveRef === undefined ? {} : { archive_ref: input.archiveRef }),
    ...(input.proof === undefined ? {} : { proof: input.proof }),
    ...(input.blockers === undefined ? {} : { blockers: input.blockers }),
  };
  await appendJsonl(join(active.worktree_root, WORKTREE_LEDGER_FILE), row);
}

function runGitForCleanup(args: readonly string[], cwd: string, env: ProcessEnvLike): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env });
  if (result.error !== undefined) fail('git-spawn-failed', `git ${args.join(' ')} failed to spawn: ${result.error.message}`);
  if ((result.status ?? -1) !== 0) fail('git-command-failed', `git ${args.join(' ')} exited with status ${String(result.status ?? -1)}.`, [result.stderr.trim(), result.stdout.trim()]);
  return result.stdout;
}

function runtimeGitEnv(authority: string, env: ProcessEnvLike = process.env): Record<string, string | undefined> {
  return {
    ...process.env,
    ...env,
    AUTOPILOT_RUNTIME: '1',
    AUTOPILOT_RUNTIME_AUTHORITY: authority,
    GIT_LFS_SKIP_SMUDGE: '1',
  };
}

function expectString(record: Readonly<Record<string, unknown>>, key: string, code: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) fail(code, `${key} must be a non-empty string.`);
  return value;
}

function expectNullableString(record: Readonly<Record<string, unknown>>, key: string, code: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) fail(code, `${key} must be a non-empty string or null.`);
  return value;
}

function expectInteger(record: Readonly<Record<string, unknown>>, key: string, code: string): number {
  const value = record[key];
  if (!Number.isInteger(value)) fail(code, `${key} must be an integer.`);
  return value as number;
}

function expectConst<T extends string>(record: Readonly<Record<string, unknown>>, key: string, expected: T, code: string): T {
  const value = record[key];
  if (value !== expected) fail(code, `${key} must equal ${expected}.`);
  return expected;
}

function expectStatus(record: Readonly<Record<string, unknown>>, key: string, code: string): UnitStatus {
  const value = expectString(record, key, code);
  if (value === 'active' || value === 'merged' || value === 'aborted' || value === 'quarantined' || value === 'superseded') return value;
  fail(code, `${key} must be a known unit status.`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedCandidate = normalizePath(candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(path: string): string {
  let cursor = resolve(path);
  const missingSegments: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(path);
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
  try {
    return resolve(realpathSync(cursor), ...missingSegments);
  } catch {
    return resolve(path);
  }
}

function unitKey(unit: AutopilotUnitBranchInfo): string {
  return `${unit.unit_id}\0${String(unit.attempt)}`;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

interface NodeError extends Error {
  readonly code?: string;
}

function isNodeError(error: unknown): error is NodeError {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
