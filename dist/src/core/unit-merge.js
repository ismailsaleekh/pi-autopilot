import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAutopilotExecutionAudit, parseAutopilotExecutionCommit, parseAutopilotReceipt, parseAutopilotStatusEntry } from "./contracts/index.js";
import { gitHead, readGitStatus, releaseClaimsForUnit, runGit, updateUnitBranchStatus, withAutopilotFileLock, writeJsonAtomic } from "./parallel-runtime.js";
import { cleanupTerminalUnitWorktree } from "./worktree-cleanup.js";
export class AutopilotUnitMergeError extends Error {
    name = 'AutopilotUnitMergeError';
    code;
    evidence;
    constructor(code, message, evidence = []) {
        super(`AutopilotUnitMergeError [${code}]: ${message}`);
        this.code = code;
        this.evidence = Object.freeze([...evidence]);
    }
}
function fail(code, message, evidence = []) {
    throw new AutopilotUnitMergeError(code, message, evidence);
}
export async function mergeAutopilotUnit(input) {
    const now = input.now ?? new Date();
    const active = input.context.active;
    return await withAutopilotFileLock(join(active.runtime_root, '.locks', 'unit-merge.lock'), `unit-merge:${active.autopilot_id}:${input.unitId}:${String(input.attempt)}`, async () => {
        const status = parseAutopilotStatusEntry(await readJsonFile(input.statusPath));
        const receipt = parseAutopilotReceipt(await readJsonFile(input.receiptPath));
        const audit = parseAutopilotExecutionAudit(await readJsonFile(input.auditPath));
        const executionCommit = parseAutopilotExecutionCommit(await readJsonFile(input.executionCommitPath));
        const blockers = mergePreflightBlockers(active, input.unitId, input.attempt, status, receipt, audit, executionCommit);
        if (blockers.length > 0)
            return { outcome: 'blocked', merge: null, blockers, conflict_path: null };
        const before = gitHead(active.main_worktree_path);
        const unitBranch = executionCommit.branch;
        const unitHead = gitHead(executionCommit.cwd);
        try {
            runGit(['merge', '--no-ff', '--no-edit', '-m', `autopilot unit merge ${active.workstream_run} ${input.unitId} attempt ${String(input.attempt)}`, unitBranch], active.main_worktree_path, runtimeGitEnv('unit-merge', input.env));
        }
        catch (error) {
            const dirty = readGitStatus(active.main_worktree_path).changedPaths;
            const abort = spawnSync('git', ['merge', '--abort'], { cwd: active.main_worktree_path, encoding: 'utf8', env: runtimeGitEnv('unit-merge-abort', input.env) });
            const conflictPath = join(active.runtime_root, 'merge-conflicts', `${input.unitId}.attempt-${String(input.attempt)}.${timestamp(now)}.json`);
            await writeJsonAtomic(conflictPath, {
                schema_version: 'autopilot.merge_conflict.v1',
                workstream: active.workstream,
                workstream_run: active.workstream_run,
                unit_id: input.unitId,
                attempt: input.attempt,
                unit_branch: unitBranch,
                integration_head: before,
                dirty_paths: dirty,
                abort_status: abort.status ?? -1,
                error: errorMessage(error),
                created_at: now.toISOString(),
            });
            if ((abort.status ?? -1) !== 0)
                fail('merge-abort-failed', 'unit merge conflicted and git merge --abort failed.', [abort.stderr.trim(), conflictPath]);
            return { outcome: 'conflict', merge: null, blockers: [], conflict_path: conflictPath };
        }
        const after = gitHead(active.main_worktree_path);
        const changedPaths = diffPaths(active.main_worktree_path, before, after);
        const merge = {
            schema_version: 'autopilot.unit_merge.v1',
            workstream: active.workstream,
            workstream_run: active.workstream_run,
            autopilot_id: active.autopilot_id,
            active_run_epoch: active.active_run_epoch,
            unit_id: input.unitId,
            role: executionCommit.role,
            attempt: input.attempt,
            unit_branch: unitBranch,
            main_branch: active.branch,
            unit_head: unitHead,
            integration_before: before,
            integration_after: after,
            merge_commit_sha: after,
            changed_paths: changedPaths,
            status_ref: relativeRuntimeRef(active.runtime_root, input.statusPath),
            receipt_ref: relativeRuntimeRef(active.runtime_root, input.receiptPath),
            audit_ref: relativeRuntimeRef(active.runtime_root, input.auditPath),
            execution_commit_ref: relativeRuntimeRef(active.runtime_root, input.executionCommitPath),
            merged_at: now.toISOString(),
        };
        const mergePath = join(active.runtime_root, 'unit-merges', `${input.unitId}.${executionCommit.role}.attempt-${String(input.attempt)}.json`);
        await writeJsonAtomic(mergePath, merge);
        await releaseClaimsForUnit({ context: input.context, unitId: input.unitId, attempt: input.attempt, reason: 'autopilot unit merge release', now });
        const archiveRef = `autopilot/archive/${active.workstream_run}/unit/${input.unitId}/attempt-${String(input.attempt)}`;
        runGit(['update-ref', `refs/heads/${archiveRef}`, unitHead], active.source_repo, runtimeGitEnv('unit-archive', input.env));
        await updateUnitBranchStatus({ active, unitId: input.unitId, attempt: input.attempt, status: 'merged', currentSha: unitHead, archiveRef });
        await cleanupTerminalUnitWorktree({
            active,
            unitId: input.unitId,
            attempt: input.attempt,
            allowedStatuses: ['merged'],
            reason: 'autopilot unit merge cleanup',
            ...(input.env === undefined ? {} : { env: input.env }),
            now,
        });
        return { outcome: 'merged', merge, blockers: [], conflict_path: null };
    });
}
export function parseAutopilotUnitMerge(value) {
    if (!isRecord(value))
        fail('invalid-unit-merge', 'unit merge evidence must be an object.');
    return {
        schema_version: expectConst(value, 'schema_version', 'autopilot.unit_merge.v1'),
        workstream: expectString(value, 'workstream'),
        workstream_run: expectString(value, 'workstream_run'),
        autopilot_id: expectString(value, 'autopilot_id'),
        active_run_epoch: expectInteger(value, 'active_run_epoch'),
        unit_id: expectString(value, 'unit_id'),
        role: expectRole(value),
        attempt: expectInteger(value, 'attempt'),
        unit_branch: expectString(value, 'unit_branch'),
        main_branch: expectString(value, 'main_branch'),
        unit_head: expectString(value, 'unit_head'),
        integration_before: expectString(value, 'integration_before'),
        integration_after: expectString(value, 'integration_after'),
        merge_commit_sha: expectString(value, 'merge_commit_sha'),
        changed_paths: expectStringArray(value, 'changed_paths'),
        status_ref: expectString(value, 'status_ref'),
        receipt_ref: expectString(value, 'receipt_ref'),
        audit_ref: expectString(value, 'audit_ref'),
        execution_commit_ref: expectString(value, 'execution_commit_ref'),
        merged_at: expectString(value, 'merged_at'),
    };
}
function mergePreflightBlockers(active, unitId, attempt, status, receipt, audit, executionCommit) {
    const blockers = [];
    if (status.workstream !== active.workstream || receipt.workstream !== active.workstream || audit.workstream !== active.workstream || executionCommit.workstream !== active.workstream)
        blockers.push('workstream identity mismatch across unit evidence');
    if (status.unit_id !== unitId || receipt.unit_id !== unitId || audit.unit_id !== unitId || executionCommit.unit_id !== unitId)
        blockers.push('unit identity mismatch across unit evidence');
    if (status.attempt !== attempt || receipt.attempt !== attempt || audit.attempt !== attempt || executionCommit.attempt !== attempt)
        blockers.push('attempt mismatch across unit evidence');
    if (status.verdict !== 'DONE')
        blockers.push(`source-changing unit status verdict must be DONE, got ${status.verdict}`);
    if (audit.classification !== 'clean')
        blockers.push(`execution audit must be clean, got ${audit.classification}`);
    if (executionCommit.autopilot_id !== active.autopilot_id || executionCommit.workstream_run !== active.workstream_run || executionCommit.active_run_epoch !== active.active_run_epoch)
        blockers.push('execution commit authority does not match active workstream');
    if (!existsSync(executionCommit.cwd))
        blockers.push(`unit worktree is missing: ${executionCommit.cwd}`);
    if (existsSync(executionCommit.cwd) && readGitStatus(executionCommit.cwd).changedPaths.length > 0)
        blockers.push('unit worktree must be clean before mergeback');
    return Object.freeze(blockers);
}
async function readJsonFile(path) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch (error) {
        fail('json-read-failed', `failed to read ${path}: ${errorMessage(error)}`);
    }
}
function diffPaths(cwd, left, right) {
    const output = runGit(['diff', '--name-only', '-z', left, right], cwd);
    return Object.freeze(output.split('\0').filter((path) => path.length > 0).map((path) => path.replace(/\\/gu, '/')).sort((leftPath, rightPath) => leftPath.localeCompare(rightPath)));
}
function relativeRuntimeRef(runtimeRoot, absolutePath) {
    const normalizedRoot = runtimeRoot.endsWith('/') ? runtimeRoot : `${runtimeRoot}/`;
    if (!absolutePath.startsWith(normalizedRoot))
        fail('artifact-outside-runtime-root', 'unit merge artifact ref is outside authoritative runtime root.', [absolutePath, runtimeRoot]);
    return absolutePath.slice(normalizedRoot.length);
}
function runtimeGitEnv(authority, env = process.env) {
    return {
        ...process.env,
        ...env,
        AUTOPILOT_RUNTIME: '1',
        AUTOPILOT_RUNTIME_AUTHORITY: authority,
        GIT_AUTHOR_NAME: 'autopilot-runtime',
        GIT_AUTHOR_EMAIL: 'autopilot-runtime@example.invalid',
        GIT_COMMITTER_NAME: 'autopilot-runtime',
        GIT_COMMITTER_EMAIL: 'autopilot-runtime@example.invalid',
    };
}
function timestamp(now) {
    return now.toISOString().replace(/[-:.]/gu, '').replace(/Z$/u, 'Z');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function expectString(record, key) {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0)
        fail('invalid-unit-merge', `${key} must be a non-empty string.`);
    return value;
}
function expectInteger(record, key) {
    const value = record[key];
    if (!Number.isInteger(value))
        fail('invalid-unit-merge', `${key} must be an integer.`);
    return value;
}
function expectConst(record, key, expected) {
    const value = record[key];
    if (value !== expected)
        fail('invalid-unit-merge', `${key} must equal ${expected}.`);
    return expected;
}
function expectStringArray(record, key) {
    const value = record[key];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
        fail('invalid-unit-merge', `${key} must be a string array.`);
    return Object.freeze([...value]);
}
function expectRole(record) {
    const role = expectString(record, 'role');
    if (role !== 'implement' && role !== 'fix')
        fail('invalid-unit-merge', 'role must be implement or fix.');
    return role;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
