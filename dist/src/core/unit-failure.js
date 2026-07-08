import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gitHead, readGitStatus, releaseClaimsForUnit, runGit, updateUnitBranchStatus, writeJsonAtomic } from "./parallel-runtime.js";
export async function quarantineFailedUnit(input) {
    const record = await writeFailureRecord({ ...input, action: 'quarantine' });
    await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'quarantined', currentSha: existsSync(input.unitWorktreePath) ? gitHead(input.unitWorktreePath) : input.context.active.target_base_sha, archiveRef: null });
    await releaseClaimsForUnit(releaseInput(input, 'autopilot failed unit quarantine'));
    return record;
}
export async function resetFailedUnit(input) {
    if (existsSync(input.unitWorktreePath))
        runGit(['reset', '--hard', 'HEAD'], input.unitWorktreePath, { AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: 'unit-reset' });
    const record = await writeFailureRecord({ ...input, action: 'reset' });
    await releaseClaimsForUnit(releaseInput(input, 'autopilot failed unit reset'));
    const currentSha = existsSync(input.unitWorktreePath) ? gitHead(input.unitWorktreePath) : input.context.active.target_base_sha;
    await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'aborted', currentSha, archiveRef: null });
    if (existsSync(input.unitWorktreePath))
        runGit(['worktree', 'remove', '--force', input.unitWorktreePath], input.context.active.source_repo, { AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: 'unit-reset-remove' });
    return record;
}
export async function preserveFailedUnit(input) {
    const record = await writeFailureRecord({ ...input, action: 'preserve' });
    await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'quarantined', currentSha: existsSync(input.unitWorktreePath) ? gitHead(input.unitWorktreePath) : input.context.active.target_base_sha, archiveRef: null });
    return record;
}
export async function abortFailedUnit(input) {
    const record = await writeFailureRecord({ ...input, action: 'abort' });
    await releaseClaimsForUnit(releaseInput(input, 'autopilot failed unit abort'));
    const currentSha = existsSync(input.unitWorktreePath) ? gitHead(input.unitWorktreePath) : input.context.active.target_base_sha;
    const archiveRef = `autopilot/archive/${input.context.active.workstream_run}/unit/${input.unitId}/attempt-${String(input.attempt)}/aborted`;
    runGit(['update-ref', `refs/heads/${archiveRef}`, currentSha], input.context.active.source_repo, { AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: 'unit-abort-archive' });
    await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'aborted', currentSha, archiveRef });
    if (existsSync(input.unitWorktreePath))
        runGit(['worktree', 'remove', '--force', input.unitWorktreePath], input.context.active.source_repo, { AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: 'unit-abort-remove' });
    return record;
}
function releaseInput(input, reason) {
    return input.now === undefined
        ? { context: input.context, unitId: input.unitId, attempt: input.attempt, reason }
        : { context: input.context, unitId: input.unitId, attempt: input.attempt, reason, now: input.now };
}
async function writeFailureRecord(input) {
    const now = input.now ?? new Date();
    const dirtyPaths = existsSync(input.unitWorktreePath) ? readGitStatus(input.unitWorktreePath).changedPaths : [];
    const record = {
        schema_version: 'autopilot.unit_failure.v1',
        action: input.action,
        workstream: input.context.active.workstream,
        workstream_run: input.context.active.workstream_run,
        unit_id: input.unitId,
        attempt: input.attempt,
        unit_worktree_path: input.unitWorktreePath,
        dirty_paths: dirtyPaths,
        summary: input.summary,
        created_at: now.toISOString(),
    };
    const root = join(input.context.active.runtime_root, 'quarantine');
    await mkdir(root, { recursive: true });
    await writeJsonAtomic(join(root, `${input.unitId}.attempt-${String(input.attempt)}.${input.action}.json`), record);
    return record;
}
