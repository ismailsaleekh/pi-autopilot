import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseAutopilotExecutionAudit, parseAutopilotExecutionCommit, parseAutopilotMasterPlan, parseAutopilotState, parseAutopilotStatusEntry, parseAutopilotDecisionRow, } from "./contracts/index.js";
import { evaluateAutopilotClosureGate } from "./lifecycle/index.js";
import { parseAutopilotUnitMerge } from "./unit-merge.js";
import { ACTIVE_AUTOPILOTS_FILE, BRANCHES_FILE, CLAIM_EVENTS_FILE, FOREIGN_MERGE_ACKS_FILE, MERGE_LOG_FILE, PATH_CLAIMS_FILE, TASK_INFO_FILE, WORKTREE_INDEX_FILE, appendClaimEvent, appendJsonl, coordinationRootForRepo, gitHead, isAutopilotRuntimeRepoPath, mainMergeLockPathForRepo, matchesRepoPathPattern, pathOverlapsOrContains, readActiveAutopilots, readGitStatus, readPathClaims, readWorktreeIndex, resolveRepoIdentity, runGit, taskRootForActiveAutopilot, updateTaskInfoStatus, withAutopilotFileLock, worktreeRootForRepo, writeActiveAutopilots, writeJsonAtomic, writePathClaims, } from "./parallel-runtime.js";
export class AutopilotCloseError extends Error {
    name = 'AutopilotCloseError';
    code;
    evidence;
    constructor(code, message, evidence = []) {
        super(`AutopilotCloseError [${code}]: ${message}`);
        this.code = code;
        this.evidence = Object.freeze([...evidence]);
    }
}
function fail(code, message, evidence = []) {
    throw new AutopilotCloseError(code, message, evidence);
}
export async function closeAutopilotWorkstream(options) {
    const env = options.env ?? process.env;
    const now = options.now ?? new Date();
    const dryRun = options.dryRun === true;
    const prepared = await resolveCloseContext(options, env);
    if (dryRun) {
        const validation = await validateCloseReadiness(prepared, now);
        return buildCloseResult({
            outcome: 'dry-run',
            active: prepared.active,
            repoKey: prepared.repo.repoKey,
            targetBefore: gitHead(prepared.repo.repoRoot),
            targetAfter: null,
            workstreamBefore: gitHead(prepared.active.main_worktree_path),
            workstreamAfter: null,
            integrationCommitSha: null,
            changedPaths: validation.preIntegrationChangedPaths,
            releasedClaims: [],
            archivedRuntimePath: null,
            archiveRef: null,
            mergeId: null,
            blockers: validation.blockers,
            closeResultPath: null,
            now,
        });
    }
    return await withAutopilotFileLock(mainMergeLockPathForRepo(prepared.repo.repoKey, env), `autopilot-close:${prepared.active.autopilot_id}:${prepared.active.workstream_run}`, async () => {
        let active = await setActiveStatus(prepared.coordinationRoot, prepared.active, 'merging', now, null);
        const context = { ...prepared, active };
        const attemptPath = await writeCloseAttempt(context, now);
        try {
            const validation = await validateCloseReadiness(context, now);
            if (validation.blockers.length > 0) {
                active = await setActiveStatus(context.coordinationRoot, active, 'blocked', now, null);
                const result = buildCloseResult({
                    outcome: 'blocked',
                    active,
                    repoKey: context.repo.repoKey,
                    targetBefore: gitHead(context.repo.repoRoot),
                    targetAfter: null,
                    workstreamBefore: gitHead(active.main_worktree_path),
                    workstreamAfter: null,
                    integrationCommitSha: null,
                    changedPaths: validation.preIntegrationChangedPaths,
                    releasedClaims: [],
                    archivedRuntimePath: null,
                    archiveRef: null,
                    mergeId: null,
                    blockers: validation.blockers,
                    closeResultPath: null,
                    now,
                });
                const resultPath = await writeCloseResult(active.runtime_root, result, now);
                return { ...result, close_result_path: resultPath };
            }
            const targetBefore = gitHead(context.repo.repoRoot);
            const workstreamBefore = gitHead(active.main_worktree_path);
            const integrationCommitSha = integrateTargetIntoWorkstream({ active, targetHead: targetBefore });
            const workstreamAfter = gitHead(active.main_worktree_path);
            const changedPaths = diffPaths(active.main_worktree_path, targetBefore, workstreamAfter);
            const postIntegrationBlockers = validation.unitMerges.length > 0
                ? phaseTwoCloseBlockers(active, validation.unitMerges, [], changedPaths)
                : finalDiffBlockers(changedPaths, validation.retainedWriteClaims, validation.executionCommits);
            if (postIntegrationBlockers.length > 0) {
                active = await setActiveStatus(context.coordinationRoot, active, 'blocked', now, null);
                const result = buildCloseResult({
                    outcome: 'blocked',
                    active,
                    repoKey: context.repo.repoKey,
                    targetBefore,
                    targetAfter: null,
                    workstreamBefore,
                    workstreamAfter,
                    integrationCommitSha,
                    changedPaths,
                    releasedClaims: [],
                    archivedRuntimePath: null,
                    archiveRef: null,
                    mergeId: null,
                    blockers: postIntegrationBlockers,
                    closeResultPath: null,
                    now,
                });
                const resultPath = await writeCloseResult(active.runtime_root, result, now);
                return { ...result, close_result_path: resultPath };
            }
            fastForwardTargetToWorkstream(context.repo.repoRoot, active.branch);
            const targetAfter = gitHead(context.repo.repoRoot);
            const mergeId = buildId('merge', active.workstream_run, now);
            const mergeEvent = {
                schema_version: 'autopilot.merge_event.v1',
                merge_id: mergeId,
                repo_key: context.repo.repoKey,
                autopilot_id: active.autopilot_id,
                workstream: active.workstream,
                workstream_run: active.workstream_run,
                branch: active.branch,
                target_branch: requireTargetBranch(active),
                target_before: targetBefore,
                target_after: targetAfter,
                workstream_before: workstreamBefore,
                workstream_after: workstreamAfter,
                integration_commit_sha: integrationCommitSha,
                changed_paths: changedPaths,
                merged_at: now.toISOString(),
            };
            await appendJsonl(join(context.coordinationRoot, MERGE_LOG_FILE), parseMergeEvent(mergeEvent));
            await appendForeignMergeAcks(context, validation.nonIntersectingForeignMerges, now);
            const archiveRef = `autopilot/archive/${active.workstream_run}/main`;
            active = await setActiveStatus(context.coordinationRoot, active, 'closed', now, now.toISOString());
            await updateBranchesInfo(active, archiveRef, targetAfter);
            const closedContext = { ...context, active };
            const archivedRuntimePath = await archiveRuntimeArtifacts(closedContext, archiveRef, now);
            const releasedClaims = await releaseRetainedClaims(closedContext, validation.retainedClaims, now);
            await archiveWorktreeIndex(active, now);
            retireBranchAndRemoveWorktree(context.repo.repoRoot, active, archiveRef, targetAfter);
            const archiveCloseResultPath = join(dirname(archivedRuntimePath), '_close-result.json');
            const result = buildCloseResult({
                outcome: 'closed',
                active,
                repoKey: context.repo.repoKey,
                targetBefore,
                targetAfter,
                workstreamBefore,
                workstreamAfter,
                integrationCommitSha,
                changedPaths,
                releasedClaims,
                archivedRuntimePath,
                archiveRef,
                mergeId,
                blockers: [],
                closeResultPath: archiveCloseResultPath,
                now,
            });
            await writeJsonAtomic(archiveCloseResultPath, result);
            return result;
        }
        catch (error) {
            await setActiveStatus(prepared.coordinationRoot, active, 'blocked', now, null).catch(() => undefined);
            if (error instanceof AutopilotCloseError)
                throw error;
            fail('close-failed', `Autopilot close failed after attempt ${attemptPath}: ${errorMessage(error)}`);
        }
    });
}
export async function abortAutopilotWorkstream(options) {
    const env = options.env ?? process.env;
    const now = options.now ?? new Date();
    const dryRun = options.dryRun === true;
    const prepared = await resolveCloseContext(options, env);
    const currentHead = existsSync(prepared.active.main_worktree_path) ? gitHead(prepared.active.main_worktree_path) : prepared.active.target_base_sha;
    const changedPaths = existsSync(prepared.active.main_worktree_path) && commitExists(prepared.active.main_worktree_path, prepared.active.target_base_sha)
        ? diffPaths(prepared.active.main_worktree_path, prepared.active.target_base_sha, currentHead)
        : [];
    const blockers = abortReadinessBlockers(prepared.active);
    if (dryRun) {
        return buildCloseResult({
            outcome: 'dry-run',
            active: prepared.active,
            repoKey: prepared.repo.repoKey,
            targetBefore: gitHead(prepared.repo.repoRoot),
            targetAfter: null,
            workstreamBefore: currentHead,
            workstreamAfter: null,
            integrationCommitSha: null,
            changedPaths,
            releasedClaims: [],
            archivedRuntimePath: null,
            archiveRef: null,
            mergeId: null,
            blockers,
            closeResultPath: null,
            now,
        });
    }
    return await withAutopilotFileLock(mainMergeLockPathForRepo(prepared.repo.repoKey, env), `autopilot-abort:${prepared.active.autopilot_id}:${prepared.active.workstream_run}`, async () => {
        let active = await setActiveStatus(prepared.coordinationRoot, prepared.active, 'merging', now, null);
        const context = { ...prepared, active };
        const attemptPath = await writeCloseAttempt(context, now);
        try {
            const latestBlockers = abortReadinessBlockers(active);
            if (latestBlockers.length > 0) {
                active = await setActiveStatus(context.coordinationRoot, active, 'blocked', now, null);
                const result = buildCloseResult({
                    outcome: 'blocked',
                    active,
                    repoKey: context.repo.repoKey,
                    targetBefore: gitHead(context.repo.repoRoot),
                    targetAfter: null,
                    workstreamBefore: currentHead,
                    workstreamAfter: null,
                    integrationCommitSha: null,
                    changedPaths,
                    releasedClaims: [],
                    archivedRuntimePath: null,
                    archiveRef: null,
                    mergeId: null,
                    blockers: latestBlockers,
                    closeResultPath: null,
                    now,
                });
                const resultPath = await writeCloseResult(active.runtime_root, result, now);
                return { ...result, close_result_path: resultPath };
            }
            const archiveRef = `autopilot/archive/${active.workstream_run}/aborted`;
            const workstreamHead = gitHead(active.main_worktree_path);
            active = await setActiveStatus(context.coordinationRoot, active, 'closed', now, now.toISOString());
            await updateBranchesInfo(active, archiveRef, workstreamHead);
            const closedContext = { ...context, active };
            const archivedRuntimePath = await archiveRuntimeArtifacts(closedContext, archiveRef, now);
            const latestRetainedClaims = (await readPathClaims(closedContext.coordinationRoot)).filter((claim) => claim.autopilot_id === active.autopilot_id && claim.workstream_run === active.workstream_run);
            const releasedClaims = await releaseRetainedClaims(closedContext, latestRetainedClaims, now);
            await archiveWorktreeIndex(active, now);
            retireBranchAndRemoveWorktree(context.repo.repoRoot, active, archiveRef, workstreamHead);
            const archiveCloseResultPath = join(dirname(archivedRuntimePath), '_abort-result.json');
            const result = buildCloseResult({
                outcome: 'aborted',
                active,
                repoKey: context.repo.repoKey,
                targetBefore: gitHead(context.repo.repoRoot),
                targetAfter: null,
                workstreamBefore: workstreamHead,
                workstreamAfter: workstreamHead,
                integrationCommitSha: null,
                changedPaths,
                releasedClaims,
                archivedRuntimePath,
                archiveRef,
                mergeId: null,
                blockers: [],
                closeResultPath: archiveCloseResultPath,
                now,
            });
            await writeJsonAtomic(archiveCloseResultPath, result);
            return result;
        }
        catch (error) {
            await setActiveStatus(prepared.coordinationRoot, active, 'blocked', now, null).catch(() => undefined);
            if (error instanceof AutopilotCloseError)
                throw error;
            fail('abort-failed', `Autopilot abort failed after attempt ${attemptPath}: ${errorMessage(error)}`);
        }
    });
}
async function resolveCloseContext(options, env) {
    const repo = resolveRepoIdentity(options.sourceCwd);
    const coordinationRoot = coordinationRootForRepo(repo.repoKey, env);
    const worktreeRoot = worktreeRootForRepo(repo.repoKey, env);
    const activeRows = await readActiveAutopilots(coordinationRoot);
    const matches = activeRows.filter((row) => {
        if (row.repo_key !== repo.repoKey || row.workstream !== options.workstream)
            return false;
        if (options.workstreamRun !== undefined && options.workstreamRun !== null && row.workstream_run !== options.workstreamRun)
            return false;
        return row.status !== 'closed' && row.status !== 'crashed';
    });
    if (matches.length === 0) {
        fail('active-run-not-found', 'No active Autopilot workstream run matched close request.', [
            `workstream=${options.workstream}`,
            `repo_key=${repo.repoKey}`,
            ...(options.workstreamRun === undefined || options.workstreamRun === null ? [] : [`workstream_run=${options.workstreamRun}`]),
        ]);
    }
    if (matches.length > 1) {
        fail('ambiguous-close-run', 'Multiple active Autopilot runs match; pass --run <workstream_run>.', matches.map((row) => row.workstream_run));
    }
    const active = matches[0];
    if (active === undefined)
        fail('internal-missing-active-row', 'matched active row disappeared.');
    if (active.status === 'merging') {
        fail('close-already-in-progress', 'Autopilot workstream is already marked merging.', [active.workstream_run]);
    }
    return { repo, coordinationRoot, worktreeRoot, active };
}
async function validateCloseReadiness(context, now) {
    const blockers = [];
    const active = context.active;
    const targetBranch = active.target_branch;
    if (targetBranch === null)
        blockers.push('activation target branch was detached HEAD; local close requires a named target branch');
    if (context.repo.targetBranch !== targetBranch) {
        blockers.push(`source checkout must be on captured target branch ${String(targetBranch)}, got ${String(context.repo.targetBranch)}`);
    }
    if (targetBranch !== null) {
        const targetRefHead = revParse(context.repo.repoRoot, `refs/heads/${targetBranch}`);
        if (gitHead(context.repo.repoRoot) !== targetRefHead)
            blockers.push('source checkout HEAD must equal target branch HEAD');
    }
    if (normalizeSha(active.target_base_sha) === null)
        blockers.push('active row target_base_sha is not a valid commit SHA');
    const sourceDirty = sourceDirtyPaths(context.repo.repoRoot, active.workstream);
    if (sourceDirty.length > 0)
        blockers.push(`source checkout has dirty paths: ${sourceDirty.join(', ')}`);
    if (!existsSync(active.main_worktree_path))
        blockers.push(`registered worktree is missing: ${active.main_worktree_path}`);
    const worktreeDirty = existsSync(active.main_worktree_path) ? sourceDirtyPaths(active.main_worktree_path, active.workstream) : [];
    if (worktreeDirty.length > 0)
        blockers.push(`Autopilot worktree has dirty source paths: ${worktreeDirty.join(', ')}`);
    if (existsSync(active.main_worktree_path)) {
        const branch = currentBranch(active.main_worktree_path);
        if (branch !== active.branch)
            blockers.push(`registered worktree must be on ${active.branch}, got ${String(branch)}`);
    }
    const claims = await readPathClaims(context.coordinationRoot);
    const retainedClaims = claims.filter((claim) => claim.autopilot_id === active.autopilot_id && claim.workstream_run === active.workstream_run);
    const retainedWriteClaims = retainedClaims.filter((claim) => claim.claim_type === 'WRITE' || claim.claim_type === 'EXCLUSIVE');
    const targetHead = targetBranch === null ? gitHead(context.repo.repoRoot) : revParse(context.repo.repoRoot, `refs/heads/${targetBranch}`);
    const workstreamHead = existsSync(active.main_worktree_path) ? gitHead(active.main_worktree_path) : active.target_base_sha;
    const preIntegrationChangedPaths = commitExists(active.main_worktree_path, active.target_base_sha)
        ? diffPaths(active.main_worktree_path, active.target_base_sha, workstreamHead)
        : [];
    const targetDeltaPaths = commitExists(context.repo.repoRoot, active.target_base_sha)
        ? diffPaths(context.repo.repoRoot, active.target_base_sha, targetHead)
        : [];
    const artifacts = await readRuntimeArtifacts(active.runtime_root);
    const executionCommits = artifacts.executionCommits.filter((commit) => commit.autopilot_id === active.autopilot_id && commit.workstream_run === active.workstream_run);
    const unitMerges = relevantUnitMerges(active, artifacts.unitMerges);
    const closeSurfacePaths = unitMerges.length > 0
        ? sortedUnique(unitMerges.flatMap((merge) => [...merge.changed_paths]))
        : retainedWriteClaims.map((claim) => claim.path);
    blockers.push(...semanticClosureBlockers(artifacts, preIntegrationChangedPaths));
    if (unitMerges.length > 0) {
        blockers.push(...phaseTwoExecutionCommitBlockers(active, executionCommits, artifacts.audits, unitMerges));
    }
    else {
        blockers.push(...executionCommitBlockers(active, executionCommits, artifacts.audits, retainedWriteClaims, preIntegrationChangedPaths));
    }
    blockers.push(...phaseTwoCloseBlockers(active, unitMerges, artifacts.validationStalenessRefs, preIntegrationChangedPaths));
    blockers.push(...branchCommitBlockers(active, executionCommits, unitMerges));
    const targetIntersection = intersectingPaths(targetDeltaPaths, closeSurfacePaths);
    if (targetIntersection.length > 0) {
        blockers.push(`target branch changed retained claimed path(s) since activation: ${targetIntersection.join(', ')}; targeted revalidation required before close`);
    }
    const mergeLog = await readMergeLog(context.coordinationRoot);
    const ackedIds = await readAckedMergeIds(context.coordinationRoot, active);
    const unackedForeignMerges = mergeLog.filter((row) => row.repo_key === active.repo_key &&
        row.autopilot_id !== active.autopilot_id &&
        !ackedIds.has(row.merge_id));
    const nonIntersectingForeignMerges = [];
    for (const merge of unackedForeignMerges) {
        const intersection = intersectingPaths(merge.changed_paths, closeSurfacePaths);
        if (intersection.length > 0) {
            blockers.push(`foreign merge ${merge.merge_id} touched retained claimed path(s): ${intersection.join(', ')}; targeted revalidation required before close`);
        }
        else {
            nonIntersectingForeignMerges.push(merge);
        }
    }
    if (unitMerges.length === 0)
        blockers.push(...finalDiffBlockers(preIntegrationChangedPaths, retainedWriteClaims, executionCommits));
    if (blockers.length === 0 && targetBranch !== null && !isAncestor(context.repo.repoRoot, targetHead, workstreamHead)) {
        // This is allowed: the runtime will merge target into the clean workstream.
        // The explicit branch keeps this invariant visible and prevents accidental silent fallback.
    }
    void now;
    return {
        retainedClaims,
        retainedWriteClaims,
        executionCommits,
        unitMerges,
        preIntegrationChangedPaths,
        targetDeltaPaths,
        unackedForeignMerges,
        nonIntersectingForeignMerges,
        blockers: sortedUnique(blockers),
    };
}
function sourceDirtyPaths(cwd, workstream) {
    return readGitStatus(cwd).changedPaths.filter((path) => !isAutopilotRuntimeRepoPath(path, workstream));
}
function abortReadinessBlockers(active) {
    const blockers = [];
    if (!existsSync(active.main_worktree_path))
        blockers.push(`registered worktree is missing: ${active.main_worktree_path}`);
    if (existsSync(active.main_worktree_path)) {
        const dirty = sourceDirtyPaths(active.main_worktree_path, active.workstream);
        if (dirty.length > 0)
            blockers.push(`abort refused dirty source paths in worktree: ${dirty.join(', ')}`);
        const branch = currentBranch(active.main_worktree_path);
        if (branch !== active.branch)
            blockers.push(`registered worktree must be on ${active.branch}, got ${String(branch)}`);
    }
    return sortedUnique(blockers);
}
function semanticClosureBlockers(artifacts, changedPaths) {
    if (changedPaths.length === 0 && artifacts.executionCommits.length === 0)
        return [];
    const blockers = [];
    if (artifacts.state === null)
        blockers.push('source-changing close requires schema-valid state.json');
    if (artifacts.masterPlan === null)
        blockers.push('source-changing close requires schema-valid master-plan.json');
    if (artifacts.state !== null && artifacts.state.running.length > 0) {
        blockers.push(`state.json still has running unit(s): ${artifacts.state.running.join(', ')}`);
    }
    if (artifacts.state !== null && artifacts.masterPlan !== null) {
        const gate = evaluateAutopilotClosureGate({
            state: artifacts.state,
            masterPlan: artifacts.masterPlan,
            statuses: artifacts.statuses,
            audits: artifacts.audits,
            decisions: artifacts.decisions,
        });
        if (gate.status !== 'passed')
            blockers.push(...gate.blocking_reasons.map((reason) => `closure gate: ${reason}`));
    }
    return blockers;
}
function relevantUnitMerges(active, unitMerges) {
    return Object.freeze(unitMerges.filter((merge) => merge.autopilot_id === active.autopilot_id && merge.workstream_run === active.workstream_run));
}
function executionCommitBlockers(active, executionCommits, audits, retainedWriteClaims, finalChangedPaths) {
    const blockers = [];
    const writeClaimPaths = retainedWriteClaims.map((claim) => claim.path);
    if (finalChangedPaths.length > 0 && retainedWriteClaims.length === 0) {
        blockers.push('source-changing close requires retained WRITE/EXCLUSIVE path claims');
    }
    for (const commit of executionCommits) {
        if (commit.branch !== active.branch)
            blockers.push(`execution commit ${commit.commit_sha} branch does not match active branch`);
        for (const sha of commit.commit_shas ?? [commit.commit_sha]) {
            if (!isAncestor(active.main_worktree_path, sha, gitHead(active.main_worktree_path))) {
                blockers.push(`execution commit ${sha} is not reachable from workstream branch`);
            }
        }
        const matchingAudit = audits.find((audit) => audit.workstream === commit.workstream &&
            audit.unit_id === commit.unit_id &&
            audit.role === commit.role &&
            audit.attempt === commit.attempt);
        if (matchingAudit === undefined)
            blockers.push(`execution commit ${commit.commit_sha} lacks matching execution audit`);
        else if (matchingAudit.classification !== 'clean')
            blockers.push(`execution commit ${commit.commit_sha} audit is ${matchingAudit.classification}, not clean`);
        for (const path of commit.edited_claimed_paths) {
            if (!pathMatchesAnyClaim(path, writeClaimPaths)) {
                blockers.push(`execution commit ${commit.commit_sha} edited path outside retained claims: ${path}`);
            }
        }
    }
    const executionEditedPaths = sortedUnique(executionCommits.flatMap((commit) => [...commit.edited_claimed_paths]));
    for (const path of finalChangedPaths) {
        if (!pathMatchesAnyClaim(path, writeClaimPaths))
            blockers.push(`final changed path is outside retained claims: ${path}`);
        if (!pathMatchesAnyClaim(path, executionEditedPaths))
            blockers.push(`final changed path lacks execution commit evidence: ${path}`);
    }
    return blockers;
}
function phaseTwoExecutionCommitBlockers(active, executionCommits, audits, unitMerges) {
    const blockers = [];
    for (const merge of unitMerges) {
        const matchingCommit = executionCommits.find((commit) => commit.unit_id === merge.unit_id && commit.attempt === merge.attempt && commit.role === merge.role);
        if (matchingCommit === undefined) {
            blockers.push(`Phase 2 close: unit merge ${merge.unit_id} attempt ${String(merge.attempt)} lacks execution commit evidence`);
            continue;
        }
        if (matchingCommit.branch !== merge.unit_branch) {
            blockers.push(`Phase 2 close: execution commit ${matchingCommit.commit_sha} branch does not match unit branch ${merge.unit_branch}`);
        }
        if (matchingCommit.after_head !== merge.unit_head) {
            blockers.push(`Phase 2 close: execution commit ${matchingCommit.commit_sha} head does not match merged unit head ${merge.unit_head}`);
        }
        const matchingAudit = audits.find((audit) => audit.workstream === matchingCommit.workstream &&
            audit.unit_id === matchingCommit.unit_id &&
            audit.role === matchingCommit.role &&
            audit.attempt === matchingCommit.attempt);
        if (matchingAudit === undefined)
            blockers.push(`Phase 2 close: execution commit ${matchingCommit.commit_sha} lacks matching execution audit`);
        else if (matchingAudit.classification !== 'clean')
            blockers.push(`Phase 2 close: execution commit ${matchingCommit.commit_sha} audit is ${matchingAudit.classification}, not clean`);
        for (const path of merge.changed_paths) {
            if (!pathMatchesAnyClaim(path, matchingCommit.edited_claimed_paths)) {
                blockers.push(`Phase 2 close: unit merge ${merge.unit_id} path lacks execution commit evidence: ${path}`);
            }
        }
        for (const path of matchingCommit.edited_claimed_paths) {
            if (!pathMatchesAnyClaim(path, merge.changed_paths)) {
                blockers.push(`Phase 2 close: execution commit ${matchingCommit.commit_sha} path missing from unit merge evidence: ${path}`);
            }
        }
        if (!isAncestor(active.main_worktree_path, matchingCommit.commit_sha, gitHead(active.main_worktree_path))) {
            blockers.push(`Phase 2 close: execution commit ${matchingCommit.commit_sha} is not reachable from integration branch`);
        }
    }
    return sortedUnique(blockers);
}
function phaseTwoCloseBlockers(active, unitMerges, validationStalenessRefs, finalChangedPaths) {
    const blockers = [];
    if (unitMerges.length === 0 && validationStalenessRefs.length === 0)
        return blockers;
    const relevantMerges = relevantUnitMerges(active, unitMerges);
    const unionPaths = sortedUnique(relevantMerges.flatMap((merge) => [...merge.changed_paths]));
    for (const path of finalChangedPaths) {
        if (!pathMatchesAnyClaim(path, unionPaths))
            blockers.push(`Phase 2 close: final path lacks accepted unit-merge evidence: ${path}`);
    }
    for (const path of unionPaths) {
        if (!pathMatchesAnyClaim(path, finalChangedPaths))
            blockers.push(`Phase 2 close: accepted unit merge path missing from final integrated diff: ${path}`);
    }
    for (const merge of relevantMerges) {
        if (!isAncestor(active.main_worktree_path, merge.merge_commit_sha, gitHead(active.main_worktree_path))) {
            blockers.push(`Phase 2 close: unit merge ${merge.unit_id} attempt ${String(merge.attempt)} is not reachable from integration branch`);
        }
    }
    if (validationStalenessRefs.length > 0)
        blockers.push(`Phase 2 close: stale validation artifacts remain: ${validationStalenessRefs.join(', ')}`);
    return sortedUnique(blockers);
}
function branchCommitBlockers(active, executionCommits, unitMerges) {
    if (!commitExists(active.main_worktree_path, active.target_base_sha))
        return [`target_base_sha ${active.target_base_sha} is not reachable in workstream repo`];
    const commits = revList(active.main_worktree_path, active.target_base_sha, gitHead(active.main_worktree_path));
    const executionShas = new Set([
        ...executionCommits.flatMap((commit) => [...(commit.commit_shas ?? [commit.commit_sha])]),
        ...unitMerges.flatMap((merge) => [merge.unit_head, merge.merge_commit_sha]),
    ]);
    const unknownCommits = commits.filter((sha) => !executionShas.has(sha));
    if (unknownCommits.length === 0)
        return [];
    return unknownCommits.map((sha) => `workstream branch contains non-runtime execution commit ${sha}`);
}
function finalDiffBlockers(changedPaths, retainedWriteClaims, executionCommits) {
    const blockers = [];
    const claimPaths = retainedWriteClaims.map((claim) => claim.path);
    const executionPaths = sortedUnique(executionCommits.flatMap((commit) => [...commit.edited_claimed_paths]));
    for (const path of changedPaths) {
        if (!pathMatchesAnyClaim(path, claimPaths))
            blockers.push(`post-integration changed path is outside retained claims: ${path}`);
        if (!pathMatchesAnyClaim(path, executionPaths))
            blockers.push(`post-integration changed path lacks execution commit evidence: ${path}`);
    }
    return blockers;
}
async function readRuntimeArtifacts(runtimeRoot) {
    return {
        state: await readOptionalJson(runtimeRoot, 'state.json', parseAutopilotState),
        masterPlan: await readOptionalJson(runtimeRoot, 'master-plan.json', parseAutopilotMasterPlan),
        statuses: await readJsonObjectsFromDir(join(runtimeRoot, 'statuses'), parseAutopilotStatusEntry),
        audits: await readJsonObjectsFromDir(join(runtimeRoot, 'execution-audits'), parseAutopilotExecutionAudit),
        decisions: await readDecisionRows(join(runtimeRoot, 'decision-log.jsonl')),
        executionCommits: await readJsonObjectsFromDir(join(runtimeRoot, 'execution-commits'), parseAutopilotExecutionCommit),
        unitMerges: await readJsonObjectsFromDir(join(runtimeRoot, 'unit-merges'), parseAutopilotUnitMerge),
        validationStalenessRefs: await listRuntimeJsonRefs(join(runtimeRoot, 'validation-staleness'), runtimeRoot),
    };
}
async function readOptionalJson(root, file, parse) {
    const path = join(root, file);
    if (!existsSync(path))
        return null;
    try {
        return parse(JSON.parse(await readFile(path, 'utf8')));
    }
    catch (error) {
        fail('invalid-runtime-artifact', `${file} is present but invalid: ${errorMessage(error)}`, [path]);
    }
}
async function readJsonObjectsFromDir(dir, parse) {
    if (!existsSync(dir))
        return [];
    const out = [];
    for (const path of await listFilesRecursive(dir)) {
        if (!path.endsWith('.json'))
            continue;
        try {
            out.push(parse(JSON.parse(await readFile(path, 'utf8'))));
        }
        catch (error) {
            fail('invalid-runtime-artifact', `runtime JSON artifact is invalid: ${errorMessage(error)}`, [path]);
        }
    }
    return Object.freeze(out);
}
async function readDecisionRows(path) {
    if (!existsSync(path))
        return [];
    const text = await readFile(path, 'utf8');
    const rows = [];
    for (const [index, line] of text.split('\n').entries()) {
        if (line.trim().length === 0)
            continue;
        try {
            rows.push(parseAutopilotDecisionRow(JSON.parse(line)));
        }
        catch (error) {
            fail('invalid-runtime-artifact', `decision-log.jsonl line ${String(index + 1)} is invalid: ${errorMessage(error)}`, [path]);
        }
    }
    return Object.freeze(rows);
}
async function listRuntimeJsonRefs(root, runtimeRoot) {
    if (!existsSync(root))
        return [];
    const files = await listFilesRecursive(root);
    const prefix = runtimeRoot.endsWith('/') ? runtimeRoot : `${runtimeRoot}/`;
    return Object.freeze(files.filter((file) => file.endsWith('.json')).map((file) => file.startsWith(prefix) ? file.slice(prefix.length) : file).sort((left, right) => left.localeCompare(right)));
}
async function listFilesRecursive(root) {
    const out = [];
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory())
            out.push(...await listFilesRecursive(path));
        else
            out.push(path);
    }
    return Object.freeze(out.sort((left, right) => left.localeCompare(right)));
}
async function copyPath(source, destination) {
    const info = await stat(source);
    if (info.isDirectory()) {
        await mkdir(destination, { recursive: true });
        for (const entry of await readdir(source, { withFileTypes: true })) {
            await copyPath(join(source, entry.name), join(destination, entry.name));
        }
        return;
    }
    if (info.isFile()) {
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, await readFile(source));
    }
}
function integrateTargetIntoWorkstream(input) {
    const workstreamHead = gitHead(input.active.main_worktree_path);
    if (isAncestor(input.active.main_worktree_path, input.targetHead, workstreamHead))
        return null;
    const targetBranch = requireTargetBranch(input.active);
    try {
        runGit(['merge', '--no-ff', '--no-edit', '-m', `autopilot close integration ${input.active.workstream_run}`, targetBranch], input.active.main_worktree_path, runtimeGitEnv('close-integration'));
    }
    catch (error) {
        const abort = spawnSync('git', ['merge', '--abort'], { cwd: input.active.main_worktree_path, encoding: 'utf8', env: runtimeGitEnv('close-integration') });
        if (abort.status !== 0 && readGitStatus(input.active.main_worktree_path).changedPaths.length > 0) {
            fail('integration-merge-conflict', `target merge into workstream conflicted and merge --abort failed: ${errorMessage(error)}`, [abort.stderr.trim()]);
        }
        fail('integration-merge-conflict', `target merge into workstream conflicted; targeted revalidation required before close: ${errorMessage(error)}`);
    }
    const after = gitHead(input.active.main_worktree_path);
    return after === workstreamHead ? null : after;
}
function fastForwardTargetToWorkstream(sourceRepo, branch) {
    runGit(['merge', '--ff-only', branch], sourceRepo, runtimeGitEnv('final-merge'));
}
async function setActiveStatus(coordinationRoot, row, status, now, closedAt) {
    return await withAutopilotFileLock(join(coordinationRoot, '.locks', 'activation.lock'), `close-status:${row.autopilot_id}`, async () => {
        const rows = await readActiveAutopilots(coordinationRoot);
        const updated = {
            ...row,
            status,
            active_epoch_started_at: now.toISOString(),
        };
        const replaced = rows.map((candidate) => candidate.autopilot_id === row.autopilot_id ? updated : candidate);
        if (!replaced.some((candidate) => candidate.autopilot_id === row.autopilot_id))
            fail('active-row-missing', 'active Autopilot row disappeared during close.', [row.autopilot_id]);
        await writeActiveAutopilots(coordinationRoot, replaced);
        await updateTaskInfoStatus(updated, status);
        if (closedAt !== null)
            await updateTaskInfoClosedAt(updated, closedAt);
        return updated;
    });
}
async function updateTaskInfoClosedAt(row, closedAt) {
    const path = join(taskRootForActiveAutopilot(row), TASK_INFO_FILE);
    if (!existsSync(path))
        return;
    const value = JSON.parse(await readFile(path, 'utf8'));
    await writeJsonAtomic(path, { ...value, status: row.status, closed_at: closedAt });
}
async function updateBranchesInfo(row, archiveRef, currentSha) {
    const path = join(taskRootForActiveAutopilot(row), BRANCHES_FILE);
    if (!existsSync(path))
        return;
    const value = JSON.parse(await readFile(path, 'utf8'));
    await writeJsonAtomic(path, { ...value, current_sha: currentSha, archive_ref: archiveRef });
}
async function writeCloseAttempt(context, now) {
    const attemptPath = join(context.active.runtime_root, 'close', `attempt-${safeTimestamp(now)}.json`);
    await writeJsonAtomic(attemptPath, {
        schema_version: 'autopilot.close_attempt.v1',
        workstream: context.active.workstream,
        workstream_run: context.active.workstream_run,
        autopilot_id: context.active.autopilot_id,
        repo_key: context.repo.repoKey,
        branch: context.active.branch,
        target_branch: context.active.target_branch,
        source_repo: context.repo.repoRoot,
        worktree_path: context.active.main_worktree_path,
        created_at: now.toISOString(),
    });
    return attemptPath;
}
async function writeCloseResult(runtimeRoot, result, now) {
    const path = join(runtimeRoot, 'close', `result-${safeTimestamp(now)}.json`);
    await writeJsonAtomic(path, result);
    return path;
}
function buildCloseResult(input) {
    return Object.freeze({
        schema_version: 'autopilot.close_result.v1',
        outcome: input.outcome,
        workstream: input.active.workstream,
        workstream_run: input.active.workstream_run,
        autopilot_id: input.active.autopilot_id,
        repo_key: input.repoKey,
        branch: input.active.branch,
        target_branch: input.active.target_branch,
        target_before: input.targetBefore,
        target_after: input.targetAfter,
        workstream_before: input.workstreamBefore,
        workstream_after: input.workstreamAfter,
        integration_commit_sha: input.integrationCommitSha,
        changed_paths: sortedUnique(input.changedPaths),
        released_claims: sortedUnique(input.releasedClaims),
        archived_runtime_path: input.archivedRuntimePath,
        archive_ref: input.archiveRef,
        merge_id: input.mergeId,
        blockers: sortedUnique(input.blockers),
        close_result_path: input.closeResultPath,
        created_at: input.now.toISOString(),
    });
}
async function archiveRuntimeArtifacts(context, archiveRef, now) {
    const archiveRoot = join(context.worktreeRoot, '_archive', context.active.workstream_run);
    const archiveRuntime = join(archiveRoot, 'runtime');
    await rm(archiveRoot, { recursive: true, force: true });
    await mkdir(archiveRoot, { recursive: true });
    if (existsSync(context.active.runtime_root))
        await copyPath(context.active.runtime_root, archiveRuntime);
    const taskRoot = taskRootForActiveAutopilot(context.active);
    for (const file of [TASK_INFO_FILE, BRANCHES_FILE]) {
        const source = join(taskRoot, file);
        if (existsSync(source))
            await copyPath(source, join(archiveRoot, file));
    }
    await writeJsonAtomic(join(archiveRoot, '_archive-info.json'), {
        schema_version: 'autopilot.archive_info.v1',
        workstream: context.active.workstream,
        workstream_run: context.active.workstream_run,
        autopilot_id: context.active.autopilot_id,
        branch: context.active.branch,
        archive_ref: archiveRef,
        archived_at: now.toISOString(),
    });
    return archiveRuntime;
}
async function archiveWorktreeIndex(row, now) {
    const path = join(row.worktree_root, WORKTREE_INDEX_FILE);
    const index = await readWorktreeIndex(path);
    const archivedRow = {
        workstream: row.workstream,
        workstream_run: row.workstream_run,
        autopilot_id: row.autopilot_id,
        started_at: row.started_at,
        main_path: row.main_worktree_path,
        branch: row.branch,
        status: 'archived',
    };
    await writeJsonAtomic(path, {
        schema_version: 'autopilot.worktree_index.v1',
        active: index.active.filter((candidate) => candidate.workstream_run !== row.workstream_run),
        archive: [
            ...index.archive.filter((candidate) => candidate.workstream_run !== row.workstream_run),
            archivedRow,
        ],
    });
    await appendJsonl(join(row.worktree_root, '_ledger.jsonl'), {
        schema_version: 'autopilot.worktree_ledger.v1',
        event: 'archive',
        ts: now.toISOString(),
        workstream: row.workstream,
        workstream_run: row.workstream_run,
        autopilot_id: row.autopilot_id,
        branch: row.branch,
        main_path: row.main_worktree_path,
    });
}
async function releaseRetainedClaims(context, retainedClaims, now) {
    if (retainedClaims.length === 0)
        return [];
    return await withAutopilotFileLock(join(context.coordinationRoot, '.locks', 'path-claims.lock'), `close-release:${context.active.autopilot_id}`, async () => {
        const current = await readPathClaims(context.coordinationRoot);
        const releaseKeys = new Set(retainedClaims.map(claimKey));
        const released = current.filter((claim) => releaseKeys.has(claimKey(claim)));
        const remaining = current.filter((claim) => !releaseKeys.has(claimKey(claim)));
        await writePathClaims(context.coordinationRoot, remaining);
        for (const claim of released) {
            await appendClaimEvent(context.coordinationRoot, {
                schema_version: 'autopilot.claim_event.v1',
                event: 'release',
                ts: now.toISOString(),
                repo_key: context.active.repo_key,
                autopilot_id: claim.autopilot_id,
                workstream: claim.workstream,
                workstream_run: claim.workstream_run,
                unit_id: claim.unit_id,
                attempt: claim.attempt,
                path: claim.path,
                claim_type: claim.claim_type,
                active_run_epoch: claim.active_run_epoch,
                reason: 'autopilot close/archive release',
            });
        }
        return sortedUnique(released.map((claim) => `${claim.claim_type} ${claim.path}`));
    });
}
function claimKey(claim) {
    return `${claim.autopilot_id}\0${claim.workstream_run}\0${claim.active_run_epoch}\0${claim.unit_id}\0${String(claim.attempt)}\0${claim.claim_type}\0${claim.path}`;
}
function retireBranchAndRemoveWorktree(sourceRepo, row, archiveRef, targetAfter) {
    runGit(['update-ref', `refs/heads/${archiveRef}`, targetAfter], sourceRepo, runtimeGitEnv('archive-ref'));
    if (existsSync(row.main_worktree_path))
        runGit(['worktree', 'remove', '--force', row.main_worktree_path], sourceRepo, runtimeGitEnv('worktree-remove'));
    const deleteResult = spawnSync('git', ['branch', '-D', row.branch], { cwd: sourceRepo, encoding: 'utf8', env: runtimeGitEnv('branch-retire') });
    if (deleteResult.status !== 0 && !deleteResult.stderr.includes('not found')) {
        fail('branch-retire-failed', 'failed to retire Autopilot branch after successful merge', [deleteResult.stderr.trim()]);
    }
}
async function appendForeignMergeAcks(context, merges, now) {
    for (const merge of merges) {
        const ack = {
            schema_version: 'autopilot.foreign_merge_ack.v1',
            ack_id: buildId('ack', `${context.active.workstream_run}-${merge.merge_id}`, now),
            merge_id: merge.merge_id,
            repo_key: context.active.repo_key,
            acknowledging_autopilot_id: context.active.autopilot_id,
            acknowledging_workstream_run: context.active.workstream_run,
            foreign_autopilot_id: merge.autopilot_id,
            foreign_workstream_run: merge.workstream_run,
            action: 'non-intersecting',
            intersection_paths: [],
            acked_at: now.toISOString(),
        };
        await appendJsonl(join(context.coordinationRoot, FOREIGN_MERGE_ACKS_FILE), parseForeignMergeAck(ack));
    }
}
async function readMergeLog(coordinationRoot) {
    const path = join(coordinationRoot, MERGE_LOG_FILE);
    if (!existsSync(path))
        return [];
    const text = await readFile(path, 'utf8');
    const out = [];
    for (const [index, line] of text.split('\n').entries()) {
        if (line.trim().length === 0)
            continue;
        try {
            out.push(parseMergeEvent(JSON.parse(line)));
        }
        catch (error) {
            fail('invalid-merge-log', `merge-log.jsonl line ${String(index + 1)} is invalid: ${errorMessage(error)}`, [path]);
        }
    }
    return Object.freeze(out);
}
async function readAckedMergeIds(coordinationRoot, active) {
    const path = join(coordinationRoot, FOREIGN_MERGE_ACKS_FILE);
    if (!existsSync(path))
        return new Set();
    const text = await readFile(path, 'utf8');
    const ids = new Set();
    for (const [index, line] of text.split('\n').entries()) {
        if (line.trim().length === 0)
            continue;
        try {
            const ack = parseForeignMergeAck(JSON.parse(line));
            if (ack.acknowledging_autopilot_id === active.autopilot_id && ack.acknowledging_workstream_run === active.workstream_run)
                ids.add(ack.merge_id);
        }
        catch (error) {
            fail('invalid-foreign-merge-acks', `foreign-merge-acks.jsonl line ${String(index + 1)} is invalid: ${errorMessage(error)}`, [path]);
        }
    }
    return ids;
}
function parseMergeEvent(value) {
    const row = requireRecord(value, 'merge event');
    const parsed = {
        schema_version: expectConst(row, 'schema_version', 'autopilot.merge_event.v1'),
        merge_id: expectString(row, 'merge_id'),
        repo_key: expectString(row, 'repo_key'),
        autopilot_id: expectString(row, 'autopilot_id'),
        workstream: expectString(row, 'workstream'),
        workstream_run: expectString(row, 'workstream_run'),
        branch: expectString(row, 'branch'),
        target_branch: expectString(row, 'target_branch'),
        target_before: expectString(row, 'target_before'),
        target_after: expectString(row, 'target_after'),
        workstream_before: expectString(row, 'workstream_before'),
        workstream_after: expectString(row, 'workstream_after'),
        integration_commit_sha: expectNullableString(row, 'integration_commit_sha'),
        changed_paths: expectStringArray(row, 'changed_paths'),
        merged_at: expectString(row, 'merged_at'),
    };
    return parsed;
}
function parseForeignMergeAck(value) {
    const row = requireRecord(value, 'foreign merge ack');
    const action = expectString(row, 'action');
    if (action !== 'non-intersecting')
        fail('invalid-foreign-merge-ack', 'foreign merge ack action is invalid.', [action]);
    return {
        schema_version: expectConst(row, 'schema_version', 'autopilot.foreign_merge_ack.v1'),
        ack_id: expectString(row, 'ack_id'),
        merge_id: expectString(row, 'merge_id'),
        repo_key: expectString(row, 'repo_key'),
        acknowledging_autopilot_id: expectString(row, 'acknowledging_autopilot_id'),
        acknowledging_workstream_run: expectString(row, 'acknowledging_workstream_run'),
        foreign_autopilot_id: expectString(row, 'foreign_autopilot_id'),
        foreign_workstream_run: expectString(row, 'foreign_workstream_run'),
        action,
        intersection_paths: expectStringArray(row, 'intersection_paths'),
        acked_at: expectString(row, 'acked_at'),
    };
}
function requireTargetBranch(row) {
    if (row.target_branch === null)
        fail('missing-target-branch', 'active Autopilot row has no target branch.');
    return row.target_branch;
}
function revParse(cwd, ref) {
    return runGit(['rev-parse', ref], cwd).trim();
}
function revList(cwd, fromExclusive, toInclusive) {
    const output = runGit(['rev-list', `${fromExclusive}..${toInclusive}`], cwd).trim();
    if (output.length === 0)
        return [];
    return Object.freeze(output.split('\n').filter((line) => line.length > 0));
}
function diffPaths(cwd, left, right) {
    const output = runGit(['diff', '--name-only', '-z', left, right], cwd);
    return Object.freeze(output.split('\0').filter((path) => path.length > 0).map((path) => path.replace(/\\/gu, '/')).sort((a, b) => a.localeCompare(b)));
}
function currentBranch(cwd) {
    const result = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}
function commitExists(cwd, sha) {
    const result = spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, encoding: 'utf8' });
    return result.status === 0;
}
function isAncestor(cwd, ancestor, descendant) {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, encoding: 'utf8' });
    return result.status === 0;
}
function intersectingPaths(paths, patterns) {
    return sortedUnique(paths.filter((path) => patterns.some((pattern) => pathOverlapsOrContains(path, pattern))));
}
function pathMatchesAnyClaim(path, patterns) {
    return patterns.some((pattern) => matchesRepoPathPattern(path, pattern));
}
function runtimeGitEnv(authority) {
    return {
        AUTOPILOT_RUNTIME: '1',
        AUTOPILOT_RUNTIME_AUTHORITY: authority,
        GIT_AUTHOR_NAME: 'autopilot-runtime',
        GIT_AUTHOR_EMAIL: 'autopilot-runtime@example.invalid',
        GIT_COMMITTER_NAME: 'autopilot-runtime',
        GIT_COMMITTER_EMAIL: 'autopilot-runtime@example.invalid',
    };
}
function buildId(prefix, seed, now) {
    return `${prefix}-${seed}-${safeTimestamp(now)}-${Math.random().toString(16).slice(2, 8)}`;
}
function safeTimestamp(now) {
    return now.toISOString().replace(/[-:.]/gu, '').replace(/Z$/u, 'Z');
}
function normalizeSha(value) {
    return /^[a-f0-9]{40,64}$/u.test(value) ? value : null;
}
function sortedUnique(values) {
    return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}
function requireRecord(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        fail('invalid-runtime-record', `${label} must be an object.`);
    return value;
}
function expectString(record, field) {
    const value = record[field];
    if (typeof value !== 'string' || value.length === 0)
        fail('invalid-runtime-record', `field ${field} must be a non-empty string.`);
    return value;
}
function expectNullableString(record, field) {
    const value = record[field];
    if (value === null)
        return null;
    if (typeof value === 'string')
        return value;
    fail('invalid-runtime-record', `field ${field} must be a string or null.`);
}
function expectConst(record, field, expected) {
    const value = record[field];
    if (value !== expected)
        fail('invalid-runtime-record', `field ${field} must equal ${expected}.`);
    return expected;
}
function expectStringArray(record, field) {
    const value = record[field];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
        fail('invalid-runtime-record', `field ${field} must be a string array.`);
    return Object.freeze([...value]);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
void ACTIVE_AUTOPILOTS_FILE;
void PATH_CLAIMS_FILE;
void CLAIM_EVENTS_FILE;
