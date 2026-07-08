import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AUTOPILOT_RUNTIME_ROOT_PREFIX } from "./names.js";
import { BRANCHES_FILE, MATERIALIZED_PATHS_FILE, UNIT_INDEX_FILE, UNIT_INFO_FILE, WORKTREE_LEDGER_FILE, appendJsonl, readGitStatus, readUnitIndex, taskRootForActiveAutopilot, unitWorktreePathForActiveAutopilot, withAutopilotFileLock, writeJsonAtomic, writeUnitIndex, } from "./parallel-runtime.js";
export class AutopilotWorktreeCleanupError extends Error {
    name = 'AutopilotWorktreeCleanupError';
    code;
    evidence;
    constructor(code, message, evidence = []) {
        super(`AutopilotWorktreeCleanupError [${code}]: ${message}`);
        this.code = code;
        this.evidence = [...evidence];
    }
}
function fail(code, message, evidence = []) {
    throw new AutopilotWorktreeCleanupError(code, message, evidence);
}
export async function cleanupTerminalUnitWorktreesForRun(input) {
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
export async function cleanupTerminalUnitWorktree(input) {
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
export async function rollbackCreatedUnitWorktree(input) {
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
            dirtyBlockMessage: 'refusing to roll back a newly-created unit worktree with dirty residue; quarantine or operator review is required.',
        });
        await retireBranchIfPresent(input.active, unit.branch, acc, 'preflight-rollback', input.reason, now, input.env, unit);
        await removeUnitMetadataForRollback(input.active, unit, now, input.reason);
        await removeUnitAttemptRootAfterRollback(input.active, unit, now, input.reason);
        await pruneGitMetadataAfterProof(input.active, acc, 'preflight-rollback', input.reason, now, input.env);
        verifyNoPathResidue(input.active.source_repo, [...acc.removedPaths, ...acc.reconciledMissingPaths], input.env);
        return cleanupResult(input.active, 'preflight-rollback', acc, now);
    });
}
export async function cleanupClosedAutopilotRun(input) {
    return await withCleanupLock(input.active, async () => {
        const now = input.now ?? new Date();
        const acc = emptyAccumulator();
        const units = await loadScopedUnitRows(input.active);
        runGitForCleanup(['update-ref', `refs/heads/${input.archiveRef}`, input.archiveSha], input.active.source_repo, runtimeGitEnv('worktree-cleanup-archive-ref', input.env));
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
        await removeMainWorktree(input.active, acc, input.reason, now, input.env);
        await retireBranchIfPresent(input.active, input.active.branch, acc, 'closed-run-cleanup', input.reason, now, input.env);
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
export function gitWorktreeListPorcelain(repoRoot, env = process.env) {
    const output = runGitForCleanup(['worktree', 'list', '--porcelain'], repoRoot, runtimeGitEnv('worktree-cleanup-list', env));
    return parseWorktreeList(output);
}
function emptyAccumulator() {
    return { removedPaths: [], reconciledMissingPaths: [], retiredBranches: [], prunedGitMetadata: false, activeTaskDirRemoved: false };
}
async function withCleanupLock(active, run) {
    assertActiveRowScope(active);
    const lockPath = join(active.worktree_root, '.locks', `${active.workstream_run}.worktree-cleanup.lock`);
    return await withAutopilotFileLock(lockPath, `worktree-cleanup:${active.autopilot_id}:${active.workstream_run}`, run);
}
async function cleanupTerminalUnit(active, unit, acc, input) {
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
        dirtyBlockMessage: 'refusing to remove dirty terminal unit worktree; reset, abort, quarantine, or operator review is required.',
    });
    if (input.retireBranch)
        await retireBranchIfPresent(active, unit.branch, acc, input.mode, input.reason, input.now, input.env, unit);
}
async function removeRegisteredWorktree(active, worktreePath, acc, input) {
    const listedBefore = gitWorktreeListPorcelain(active.source_repo, input.env);
    const registeredBefore = listedBefore.some((entry) => samePath(entry.path, worktreePath));
    if (!existsSync(worktreePath)) {
        acc.reconciledMissingPaths.push(worktreePath);
        await appendLedger(active, {
            mode: input.mode,
            event: 'worktree-missing-reconcile',
            reason: input.reason,
            now: input.now,
            path: worktreePath,
            ...ledgerUnitFields(input.unit),
            proof: [registeredBefore ? 'git_metadata_present_before_prune' : 'git_metadata_absent_before_prune'],
        });
        return;
    }
    if (!registeredBefore) {
        await appendLedger(active, {
            mode: input.mode,
            event: 'worktree-cleanup-blocked',
            reason: input.reason,
            now: input.now,
            path: worktreePath,
            ...ledgerUnitFields(input.unit),
            blockers: ['path is not registered by git worktree list'],
        });
        fail('worktree-not-registered', 'refusing to remove a physical path that is not registered as a Git worktree for this repository.', [worktreePath]);
    }
    const dirtyPaths = readGitStatus(worktreePath).changedPaths;
    if (dirtyPaths.length > 0) {
        await appendLedger(active, {
            mode: input.mode,
            event: 'worktree-cleanup-blocked',
            reason: input.reason,
            now: input.now,
            path: worktreePath,
            ...ledgerUnitFields(input.unit),
            blockers: dirtyPaths,
        });
        fail(input.dirtyBlockCode, input.dirtyBlockMessage, dirtyPaths);
    }
    runGitForCleanup(['worktree', 'remove', worktreePath], active.source_repo, runtimeGitEnv('worktree-cleanup-remove', input.env));
    if (existsSync(worktreePath))
        fail('worktree-remove-incomplete', 'git worktree remove returned success but the path still exists.', [worktreePath]);
    acc.removedPaths.push(worktreePath);
    await appendLedger(active, {
        mode: input.mode,
        event: 'worktree-remove',
        reason: input.reason,
        now: input.now,
        path: worktreePath,
        ...ledgerUnitFields(input.unit),
        proof: ['git_worktree_remove_succeeded', 'path_absent_after_remove'],
    });
}
async function removeMainWorktree(active, acc, reason, now, env) {
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
        return;
    }
    if (!registeredBefore) {
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
    const dirtySourcePaths = readGitStatus(mainPath).changedPaths.filter((path) => !isRuntimeRepoPath(active, path));
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
    runGitForCleanup(['worktree', 'remove', mainPath], active.source_repo, runtimeGitEnv('worktree-cleanup-remove-main', env));
    if (existsSync(mainPath))
        fail('main-worktree-remove-incomplete', 'git worktree remove returned success but the main path still exists.', [mainPath]);
    acc.removedPaths.push(mainPath);
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
async function removeArchivedRuntimeResidue(active, reason, now) {
    const expectedRuntimeRoot = join(active.main_worktree_path, AUTOPILOT_RUNTIME_ROOT_PREFIX, active.workstream);
    if (!samePath(active.runtime_root, expectedRuntimeRoot)) {
        fail('runtime-root-not-run-owned', 'refusing main cleanup because runtime_root is not the deterministic path inside the main worktree.', [active.runtime_root, expectedRuntimeRoot]);
    }
    if (!existsSync(active.runtime_root))
        return;
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
async function removeEmptyDirectoryIfPresent(path) {
    try {
        const entries = await readdir(path, { withFileTypes: true });
        if (entries.length > 0)
            return;
        await rm(path, { recursive: true, force: false });
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT')
            return;
        throw error;
    }
}
async function retireBranchIfPresent(active, branch, acc, mode, reason, now, env, unit) {
    const result = spawnSync('git', ['branch', '-D', branch], { cwd: active.source_repo, encoding: 'utf8', env: runtimeGitEnv('worktree-cleanup-branch-retire', env) });
    if ((result.status ?? -1) !== 0 && !result.stderr.includes('not found')) {
        fail('branch-retire-failed', 'failed to retire Autopilot branch after worktree removal.', [branch, result.stderr.trim()]);
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
        proof: [(result.status ?? -1) === 0 ? 'branch_deleted' : 'branch_already_absent'],
    });
}
async function pruneGitMetadataAfterProof(active, acc, mode, reason, now, env) {
    const proofPaths = sortedUnique([...acc.removedPaths, ...acc.reconciledMissingPaths]);
    if (proofPaths.length === 0)
        return;
    runGitForCleanup(['worktree', 'prune'], active.source_repo, runtimeGitEnv('worktree-cleanup-prune', env));
    acc.prunedGitMetadata = true;
    await appendLedger(active, {
        mode,
        event: 'git-worktree-prune',
        reason,
        now,
        proof: proofPaths.map((path) => `run_owned_path=${path}`),
    });
}
async function removeUnitMetadataForRollback(active, unit, now, reason) {
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
async function removeUnitAttemptRootAfterRollback(active, unit, now, reason) {
    const attemptRoot = dirname(unit.worktree_path);
    assertPathWithinRoot(taskRootForActiveAutopilot(active), attemptRoot, 'rollback-attempt-root-outside-run');
    if (!existsSync(attemptRoot))
        return;
    const entries = await collectResidualEntries(attemptRoot);
    const allowed = new Set([UNIT_INFO_FILE, MATERIALIZED_PATHS_FILE]);
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
async function removeActiveTaskDirectory(active, units, acc, reason, now, env) {
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
    if (existsSync(taskRoot))
        fail('active-task-dir-remove-incomplete', 'active task directory removal returned success but the path still exists.', [taskRoot]);
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
async function activeTaskDirectoryResidueBlockers(taskRoot, units) {
    const entries = await collectResidualEntries(taskRoot);
    const blockers = [];
    for (const entry of entries) {
        if (!isAllowedTaskResidual(entry, units))
            blockers.push(entry.relativePath);
    }
    return sortedUnique(blockers);
}
function isAllowedTaskResidual(entry, units) {
    const rootFiles = new Set(['_task-info.json', BRANCHES_FILE, UNIT_INDEX_FILE, '_checkout-profile.json', '_materialization-ledger.jsonl']);
    if (!entry.directory && rootFiles.has(entry.relativePath))
        return true;
    if (entry.relativePath === 'units' && entry.directory)
        return true;
    if (entry.relativePath === '.locks' && entry.directory)
        return true;
    if (entry.relativePath.startsWith('.locks/'))
        return true;
    for (const unit of units) {
        const unitRoot = `units/${unit.unit_id}`;
        const attemptRoot = `${unitRoot}/attempt-${String(unit.attempt)}`;
        if (entry.relativePath === unitRoot && entry.directory)
            return true;
        if (entry.relativePath === attemptRoot && entry.directory)
            return true;
        if (!entry.directory && entry.relativePath === `${attemptRoot}/${UNIT_INFO_FILE}`)
            return true;
        if (!entry.directory && entry.relativePath === `${attemptRoot}/${MATERIALIZED_PATHS_FILE}`)
            return true;
    }
    return false;
}
async function collectResidualEntries(root) {
    const entries = [];
    await collectResidualEntriesInto(root, '', entries);
    return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
async function collectResidualEntriesInto(root, relativeDir, entries) {
    const absoluteDir = relativeDir.length === 0 ? root : join(root, relativeDir);
    const dirents = await readdir(absoluteDir, { withFileTypes: true });
    for (const dirent of dirents) {
        const rel = relativeDir.length === 0 ? dirent.name : `${relativeDir}/${dirent.name}`;
        entries.push({ relativePath: rel, directory: dirent.isDirectory() });
        if (dirent.isDirectory())
            await collectResidualEntriesInto(root, rel, entries);
    }
}
async function loadScopedUnitRows(active) {
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
async function requireScopedUnit(active, unitId, attempt) {
    const units = await loadScopedUnitRows(active);
    const unit = units.find((candidate) => candidate.unit_id === unitId && candidate.attempt === attempt);
    if (unit === undefined)
        fail('unit-metadata-missing', 'unit attempt metadata is missing; cleanup refuses to infer ownership.', [unitId, String(attempt)]);
    return unit;
}
async function readBranchesSnapshot(taskRoot) {
    const path = join(taskRoot, BRANCHES_FILE);
    if (!existsSync(path))
        return null;
    let parsed;
    try {
        parsed = JSON.parse(await readFile(path, 'utf8'));
    }
    catch (error) {
        fail('invalid-branches-info', `failed to read _branches.json: ${errorMessage(error)}`, [path]);
    }
    if (!isRecord(parsed))
        fail('invalid-branches-info', '_branches.json must contain an object.', [path]);
    expectConst(parsed, 'schema_version', 'autopilot.branches.v1', 'invalid-branches-info');
    const unitBranchesRaw = parsed['unit_branches'];
    if (!Array.isArray(unitBranchesRaw))
        fail('invalid-branches-info', '_branches.json unit_branches must be an array.', [path]);
    return {
        activeBranch: expectString(parsed, 'active_branch', 'invalid-branches-info'),
        baseSha: expectString(parsed, 'base_sha', 'invalid-branches-info'),
        currentSha: expectString(parsed, 'current_sha', 'invalid-branches-info'),
        archiveRef: expectNullableString(parsed, 'archive_ref', 'invalid-branches-info'),
        unitBranches: unitBranchesRaw.map(parseUnitBranchInfo),
    };
}
function parseUnitBranchInfo(value) {
    if (!isRecord(value))
        fail('invalid-unit-branch-info', 'unit branch info must be an object.');
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
function assertMatchingUnitRows(indexUnit, branchUnit) {
    const mismatches = [];
    if (indexUnit.branch !== branchUnit.branch)
        mismatches.push('branch');
    if (!samePath(indexUnit.worktree_path, branchUnit.worktree_path))
        mismatches.push('worktree_path');
    if (indexUnit.base_sha !== branchUnit.base_sha)
        mismatches.push('base_sha');
    if (indexUnit.current_sha !== branchUnit.current_sha)
        mismatches.push('current_sha');
    if (indexUnit.archive_ref !== branchUnit.archive_ref)
        mismatches.push('archive_ref');
    if (indexUnit.status !== branchUnit.status)
        mismatches.push('status');
    if (mismatches.length > 0)
        fail('unit-metadata-mismatch', '_unit-index.json and _branches.json disagree for a unit cleanup target.', [unitKey(indexUnit), ...mismatches]);
}
function assertActiveRowScope(active) {
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
function assertScopedUnitPath(active, unit) {
    const expectedPath = unitWorktreePathForActiveAutopilot(active, unit.unit_id, unit.attempt);
    if (!samePath(unit.worktree_path, expectedPath)) {
        fail('foreign-unit-worktree-path', 'unit worktree path is not derived from this active row; refusing cleanup.', [unit.worktree_path, expectedPath]);
    }
    const expectedBranch = `autopilot/unit/${active.workstream_run}/${unit.unit_id}/attempt-${String(unit.attempt)}`;
    if (unit.branch !== expectedBranch) {
        fail('foreign-unit-branch', 'unit branch is not derived from this active row; refusing cleanup.', [unit.branch, expectedBranch]);
    }
}
function assertPathWithinRoot(root, candidate, code) {
    if (!isPathWithinRoot(root, candidate))
        fail(code, 'path is outside the expected run-owned root.', [candidate, root]);
}
function isCleanTerminalStatus(status) {
    return status === 'merged' || status === 'aborted' || status === 'superseded';
}
function isRuntimeRepoPath(active, repoPath) {
    const runtimeRoot = `${AUTOPILOT_RUNTIME_ROOT_PREFIX}/${active.workstream}`;
    const normalized = repoPath.split('/').filter((segment) => segment.length > 0).join('/');
    return normalized === runtimeRoot || normalized.startsWith(`${runtimeRoot}/`);
}
function parseWorktreeList(output) {
    const entries = [];
    let currentPath = null;
    let currentBranch = null;
    let currentPrunable = false;
    const flush = () => {
        if (currentPath !== null)
            entries.push({ path: currentPath, branch: currentBranch, prunable: currentPrunable });
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
        if (line.startsWith('prunable'))
            currentPrunable = true;
    }
    flush();
    return entries;
}
function verifyNoPathResidue(repoRoot, paths, env) {
    const uniquePaths = sortedUnique(paths);
    if (uniquePaths.length === 0)
        return;
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
function cleanupResult(active, mode, acc, now) {
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
function ledgerUnitFields(unit) {
    if (unit === undefined)
        return {};
    return { branch: unit.branch, unitId: unit.unit_id, attempt: unit.attempt, status: unit.status };
}
async function appendLedger(active, input) {
    const row = {
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
function runGitForCleanup(args, cwd, env) {
    const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env });
    if (result.error !== undefined)
        fail('git-spawn-failed', `git ${args.join(' ')} failed to spawn: ${result.error.message}`);
    if ((result.status ?? -1) !== 0)
        fail('git-command-failed', `git ${args.join(' ')} exited with status ${String(result.status ?? -1)}.`, [result.stderr.trim(), result.stdout.trim()]);
    return result.stdout;
}
function runtimeGitEnv(authority, env = process.env) {
    return {
        ...process.env,
        ...env,
        AUTOPILOT_RUNTIME: '1',
        AUTOPILOT_RUNTIME_AUTHORITY: authority,
        GIT_LFS_SKIP_SMUDGE: '1',
    };
}
function expectString(record, key, code) {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0)
        fail(code, `${key} must be a non-empty string.`);
    return value;
}
function expectNullableString(record, key, code) {
    const value = record[key];
    if (value === null)
        return null;
    if (typeof value !== 'string' || value.length === 0)
        fail(code, `${key} must be a non-empty string or null.`);
    return value;
}
function expectInteger(record, key, code) {
    const value = record[key];
    if (!Number.isInteger(value))
        fail(code, `${key} must be an integer.`);
    return value;
}
function expectConst(record, key, expected, code) {
    const value = record[key];
    if (value !== expected)
        fail(code, `${key} must equal ${expected}.`);
    return expected;
}
function expectStatus(record, key, code) {
    const value = expectString(record, key, code);
    if (value === 'active' || value === 'merged' || value === 'aborted' || value === 'quarantined' || value === 'superseded')
        return value;
    fail(code, `${key} must be a known unit status.`);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPathWithinRoot(root, candidate) {
    const normalizedRoot = normalizePath(root);
    const normalizedCandidate = normalizePath(candidate);
    const rel = relative(normalizedRoot, normalizedCandidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}
function samePath(left, right) {
    return normalizePath(left) === normalizePath(right);
}
function normalizePath(path) {
    if (existsSync(path)) {
        try {
            return realpathSync(path);
        }
        catch {
            return resolve(path);
        }
    }
    return resolve(path);
}
function unitKey(unit) {
    return `${unit.unit_id}\0${String(unit.attempt)}`;
}
function sortedUnique(values) {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
