import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { recordCoordinatorReleaseEvidenceFromFile } from "./coordination/reconciliation.js";
import { gitHead, readGitStatus, releaseClaimsForUnit, runGit, updateUnitBranchStatus, writeJsonAtomic } from "./parallel-runtime.js";
import { cleanupTerminalUnitWorktree } from "./worktree-cleanup.js";
import { executeOwnedWorktreeSaga } from "./coordination/worktree-saga.js";
export async function quarantineFailedUnit(input) {
    const record = await writeFailureRecord({ ...input, action: 'quarantine' });
    await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'quarantined', currentSha: existsSync(input.unitWorktreePath) ? gitHead(input.unitWorktreePath) : input.context.active.target_base_sha, archiveRef: null });
    await recordFailureEvidence(input, record, 'quarantine-capture');
    await releaseLegacyClaimsIfApplicable(input, 'autopilot failed unit quarantine');
    return record;
}
export async function resetFailedUnit(input) {
    const captured = await captureDirtyBeforeDestructiveTransition(input);
    const record = await writeFailureRecord({ ...input, action: 'reset' });
    await resetWorktreeForRecordedTransition(input, 'unit-reset', 'reset');
    const currentSha = existsSync(input.unitWorktreePath) ? gitHead(input.unitWorktreePath) : input.context.active.target_base_sha;
    const archiveRef = captured === null ? null : `autopilot/archive/${input.context.active.workstream_run}/unit/${input.unitId}/attempt-${String(input.attempt)}/reset-capture`;
    if (archiveRef !== null)
        await archiveFailureBranch(input, currentSha, archiveRef, 'unit reset preservation archive');
    await recordFailureEvidence(input, record, 'attempt-reset');
    await releaseLegacyClaimsIfApplicable(input, 'autopilot failed unit reset');
    await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'aborted', currentSha, archiveRef });
    await cleanupTerminalUnitWorktree({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, allowedStatuses: ['aborted'], reason: 'autopilot failed unit reset cleanup', ...(input.env === undefined ? {} : { env: input.env }), ...(input.now === undefined ? {} : { now: input.now }) });
    return record;
}
export async function preserveFailedUnit(input) {
    const record = await writeFailureRecord({ ...input, action: 'preserve' });
    await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'quarantined', currentSha: existsSync(input.unitWorktreePath) ? gitHead(input.unitWorktreePath) : input.context.active.target_base_sha, archiveRef: null });
    await recordFailureEvidence(input, record, 'quarantine-capture');
    await releaseLegacyClaimsIfApplicable(input, 'autopilot failed unit preserve-after-quarantine-capture');
    return record;
}
export async function abortFailedUnit(input) {
    await captureDirtyBeforeDestructiveTransition(input);
    const record = await writeFailureRecord({ ...input, action: 'abort' });
    await resetWorktreeForRecordedTransition(input, 'unit-abort-reset', 'abort');
    await recordFailureEvidence(input, record, 'attempt-reset');
    await releaseLegacyClaimsIfApplicable(input, 'autopilot failed unit abort');
    const currentSha = existsSync(input.unitWorktreePath) ? gitHead(input.unitWorktreePath) : input.context.active.target_base_sha;
    const archiveRef = `autopilot/archive/${input.context.active.workstream_run}/unit/${input.unitId}/attempt-${String(input.attempt)}/aborted`;
    await archiveFailureBranch(input, currentSha, archiveRef, 'unit abort preservation archive');
    await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'aborted', currentSha, archiveRef });
    await cleanupTerminalUnitWorktree({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, allowedStatuses: ['aborted'], reason: 'autopilot failed unit abort cleanup', ...(input.env === undefined ? {} : { env: input.env }), ...(input.now === undefined ? {} : { now: input.now }) });
    return record;
}
async function releaseLegacyClaimsIfApplicable(input, reason) {
    if (input.context.active.coordination_authority === 'coordinator-edit-leases-v1')
        return;
    await releaseClaimsForUnit(releaseInput(input, reason));
}
async function archiveFailureBranch(input, sha, archiveRef, reason) {
    const active = input.context.active;
    const branch = existsSync(input.unitWorktreePath) ? runGit(['rev-parse', '--abbrev-ref', 'HEAD'], input.unitWorktreePath).trim() : `autopilot/unit/${active.workstream_run}/${input.unitId}/attempt-${String(input.attempt)}`;
    const inspect = () => {
        const result = spawnSync('git', ['rev-parse', '--verify', `refs/heads/${archiveRef}`], { cwd: active.source_repo, encoding: 'utf8' });
        if ((result.status ?? -1) !== 0)
            return { outcome: 'not-applied', proof: ['archive_ref_absent'] };
        return result.stdout.trim() === sha ? { outcome: 'satisfied', proof: [`archive_ref=${archiveRef}`, `archive_sha=${sha}`] } : { outcome: 'unsafe', proof: [`expected=${sha}`, `actual=${result.stdout.trim()}`] };
    };
    await executeOwnedWorktreeSaga({
        active, unitId: input.unitId, attempt: input.attempt, kind: 'unit', operationType: 'archive',
        operationKey: `failure-archive:${archiveRef}:${sha}`, initialWorktreeState: 'terminal', committedWorktreeState: 'terminal',
        intent: {
            repo_root: active.source_repo, worktree_path: input.unitWorktreePath, git_common_dir: active.git_common_dir, branch,
            reason, base_sha: active.target_base_sha, target_sha: sha, archive_ref: archiveRef, checkout_mode: null,
            sparse_patterns: [], paths: [], metadata_refs: [],
        },
    }, {
        inspect,
        action: () => { runGit(['update-ref', `refs/heads/${archiveRef}`, sha, '0'.repeat(40)], active.source_repo, { AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: 'unit-failure-archive' }); },
        verify: () => {
            const inspected = inspect();
            if (inspected.outcome !== 'satisfied')
                throw new Error(`failure archive saga postcondition failed: ${inspected.proof.join(', ')}`);
            return inspected.proof;
        },
    }, input.env ?? process.env);
}
async function captureDirtyBeforeDestructiveTransition(input) {
    if (!existsSync(input.unitWorktreePath) || readGitStatus(input.unitWorktreePath).changedPaths.length === 0)
        return null;
    return await writeFailureRecord({ ...input, action: 'quarantine', summary: `automatic preservation before destructive transition: ${input.summary}` });
}
async function recordFailureEvidence(input, record, source) {
    if (input.context.active.coordination_authority !== 'coordinator-edit-leases-v1')
        return;
    const evidencePath = join(input.context.active.runtime_root, 'quarantine', `${input.unitId}.attempt-${String(input.attempt)}.${record.action}.json`);
    await recordCoordinatorReleaseEvidenceFromFile({
        active: input.context.active,
        source,
        targetId: `${input.unitId}:${String(input.attempt)}`,
        evidencePath,
        ...(input.env === undefined ? {} : { env: input.env }),
    });
}
async function resetWorktreeForRecordedTransition(input, authority, action) {
    if (!existsSync(input.unitWorktreePath))
        return;
    const active = input.context.active;
    const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], input.unitWorktreePath).trim();
    const target = gitHead(input.unitWorktreePath);
    const inspect = () => {
        if (!existsSync(input.unitWorktreePath))
            return { outcome: 'unsafe', proof: ['owned_worktree_missing_before_reset'] };
        const dirty = readGitStatus(input.unitWorktreePath).changedPaths;
        if (dirty.length > 0)
            return { outcome: 'unsafe', proof: dirty.map((path) => `uncaptured_dirty=${path}`) };
        const currentHead = gitHead(input.unitWorktreePath);
        return currentHead === target ? { outcome: 'satisfied', proof: [`head=${currentHead}`, 'worktree_clean'] } : { outcome: 'unsafe', proof: [`expected_head=${target}`, `actual_head=${currentHead}`] };
    };
    await executeOwnedWorktreeSaga({
        active, unitId: input.unitId, attempt: input.attempt, kind: 'unit', operationType: 'reset',
        operationKey: `${action}:${input.unitId}:${String(input.attempt)}:${target}`,
        initialWorktreeState: 'active', committedWorktreeState: 'terminal',
        intent: {
            repo_root: active.source_repo, worktree_path: input.unitWorktreePath, git_common_dir: active.git_common_dir, branch,
            reason: `${action} failed unit after immutable failure evidence`, base_sha: target, target_sha: target, archive_ref: null,
            checkout_mode: null, sparse_patterns: [], paths: readGitStatus(input.unitWorktreePath).changedPaths, metadata_refs: [],
        },
    }, {
        inspect,
        action: () => {
            runGit(['reset', '--hard', target], input.unitWorktreePath, { AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: authority });
        },
        verify: () => {
            const inspected = inspect();
            if (inspected.outcome !== 'satisfied' || gitHead(input.unitWorktreePath) !== target)
                throw new Error(`failed-unit ${action} saga did not restore clean head ${target}: ${inspected.proof.join(', ')}`);
            return inspected.proof;
        },
    }, input.env ?? process.env);
}
function releaseInput(input, reason) {
    return input.now === undefined
        ? { context: input.context, unitId: input.unitId, attempt: input.attempt, reason }
        : { context: input.context, unitId: input.unitId, attempt: input.attempt, reason, now: input.now };
}
async function writeFailureRecord(input) {
    const now = input.now ?? new Date();
    const dirtyPaths = existsSync(input.unitWorktreePath) ? readGitStatus(input.unitWorktreePath).changedPaths : [];
    const captureCommitSha = input.action === 'quarantine' || input.action === 'preserve'
        ? await captureQuarantineSnapshot(input, dirtyPaths)
        : null;
    const record = {
        schema_version: 'autopilot.unit_failure.v1',
        action: input.action,
        workstream: input.context.active.workstream,
        workstream_run: input.context.active.workstream_run,
        unit_id: input.unitId,
        attempt: input.attempt,
        unit_worktree_path: input.unitWorktreePath,
        dirty_paths: dirtyPaths,
        capture_commit_sha: captureCommitSha,
        summary: input.summary,
        created_at: now.toISOString(),
    };
    const root = join(input.context.active.runtime_root, 'quarantine');
    await mkdir(root, { recursive: true });
    await writeJsonAtomic(join(root, `${input.unitId}.attempt-${String(input.attempt)}.${input.action}.json`), record);
    return record;
}
async function captureQuarantineSnapshot(input, dirtyPaths) {
    if (!existsSync(input.unitWorktreePath))
        return input.context.active.target_base_sha;
    const active = input.context.active;
    const before = gitHead(input.unitWorktreePath);
    const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], input.unitWorktreePath).trim();
    const inspect = () => {
        const remaining = readGitStatus(input.unitWorktreePath).changedPaths;
        return remaining.length === 0 ? { outcome: 'satisfied', proof: [`head=${gitHead(input.unitWorktreePath)}`, 'quarantine_capture_immutable'] } : { outcome: 'not-applied', proof: remaining.map((path) => `dirty=${path}`) };
    };
    await executeOwnedWorktreeSaga({
        active, unitId: input.unitId, attempt: input.attempt, kind: 'unit', operationType: 'quarantine',
        operationKey: `${input.action}:${input.unitId}:${String(input.attempt)}:${before}`,
        initialWorktreeState: 'active', committedWorktreeState: 'quarantined',
        intent: {
            repo_root: active.source_repo, worktree_path: input.unitWorktreePath, git_common_dir: active.git_common_dir, branch,
            reason: `${input.action} dirty failed work before releasing edit authority`, base_sha: before, target_sha: null, archive_ref: null,
            checkout_mode: null, sparse_patterns: [], paths: dirtyPaths, metadata_refs: [],
        },
    }, {
        inspect,
        action: () => {
            if (readGitStatus(input.unitWorktreePath).changedPaths.length === 0)
                return;
            const env = {
                AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: 'unit-quarantine-capture',
                GIT_AUTHOR_NAME: 'autopilot-runtime', GIT_AUTHOR_EMAIL: 'autopilot-runtime@example.invalid',
                GIT_COMMITTER_NAME: 'autopilot-runtime', GIT_COMMITTER_EMAIL: 'autopilot-runtime@example.invalid',
            };
            runGit(['add', '--sparse', '-A'], input.unitWorktreePath, env);
            runGit(['commit', '--no-verify', '-m', `autopilot quarantine capture ${active.workstream_run} ${input.unitId} attempt ${String(input.attempt)}`], input.unitWorktreePath, env);
        },
        verify: () => {
            const inspected = inspect();
            if (inspected.outcome !== 'satisfied')
                throw new Error(`quarantine capture left mutable dirty paths: ${inspected.proof.join(', ')}`);
            return inspected.proof;
        },
    }, input.env ?? process.env);
    return gitHead(input.unitWorktreePath);
}
