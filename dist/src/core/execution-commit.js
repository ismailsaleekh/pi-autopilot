import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseAutopilotExecutionCommit } from "./contracts/index.js";
import { executeOwnedWorktreeSaga } from "./coordination/worktree-saga.js";
import { AUTOPILOT_RUNTIME_ENV, AUTOPILOT_RUNTIME_VALUE, gitHead, isAutopilotRuntimeRepoPath, matchesRepoPathPattern, readGitStatus, runGit, } from "./parallel-runtime.js";
export class AutopilotExecutionCommitError extends Error {
    name = 'AutopilotExecutionCommitError';
    code;
    evidence;
    constructor(code, message, evidence = []) {
        super(`AutopilotExecutionCommitError [${code}]: ${message}`);
        this.code = code;
        this.evidence = Object.freeze([...evidence]);
    }
}
function fail(code, message, evidence = []) {
    throw new AutopilotExecutionCommitError(code, message, evidence);
}
export function deriveAutopilotExecutionCommitPath(spec) {
    return resolve(dirname(dirname(spec.status_output)), 'execution-commits', `${spec.unit_id}.${spec.role}.attempt-${String(spec.attempt)}.json`);
}
export async function commitAutopilotExecution(input) {
    if (input.spec.role !== 'implement' && input.spec.role !== 'fix')
        return null;
    if (input.statusEntry.verdict !== 'DONE')
        return null;
    if (input.audit.classification !== 'clean') {
        fail('audit-not-clean', 'runtime commit requires a clean execution audit for source-changing success.', [
            `classification=${input.audit.classification}`,
            ...input.audit.outside_owned_paths.map((path) => `outside_owned=${path}`),
            ...input.audit.read_only_touched_paths.map((path) => `read_only_touched=${path}`),
            ...input.audit.untouchable_touched_paths.map((path) => `untouchable_touched=${path}`),
        ]);
    }
    const headBeforeRuntimeCommit = gitHead(input.spec.cwd);
    const status = readGitStatus(input.spec.cwd);
    const nonRuntimeChangedPaths = status.changedPaths.filter((path) => !isAutopilotRuntimeRepoPath(path, input.spec.workstream));
    const claimedWritePatterns = activeWriteClaimPaths(input);
    const dirtyClaimedPaths = nonRuntimeChangedPaths.filter((path) => claimedWritePatterns.some((pattern) => matchesRepoPathPattern(path, pattern))).sort();
    const unclaimedChangedPaths = nonRuntimeChangedPaths.filter((path) => !dirtyClaimedPaths.includes(path));
    if (unclaimedChangedPaths.length > 0) {
        fail('unclaimed-changes', 'execution-commit evidence refused unclaimed source changes.', unclaimedChangedPaths);
    }
    const committedClaimedPaths = sortedUnique(input.audit.committed_changed_paths ?? []);
    for (const path of committedClaimedPaths) {
        if (!claimedWritePatterns.some((pattern) => matchesRepoPathPattern(path, pattern))) {
            fail('committed-path-outside-claims', 'child-created commit changed a path outside active WRITE claims.', [path]);
        }
    }
    const editedClaimedPaths = sortedUnique([...committedClaimedPaths, ...dirtyClaimedPaths]);
    if (editedClaimedPaths.length === 0) {
        fail('no-claimed-edits', 'source-changing DONE status produced no claimed source edits to commit or capture.');
    }
    assertSameSet('status.changed_paths', input.statusEntry.changed_paths, 'actual claimed changed paths', editedClaimedPaths);
    assertSameSet('audit.actual_changed_paths', input.audit.actual_changed_paths, 'actual claimed changed paths', editedClaimedPaths);
    const stagedOutsideClaims = status.stagedPaths
        .filter((path) => !isAutopilotRuntimeRepoPath(path, input.spec.workstream))
        .filter((path) => !claimedWritePatterns.some((pattern) => matchesRepoPathPattern(path, pattern)));
    if (stagedOutsideClaims.length > 0) {
        fail('preexisting-staged-paths', 'execution-commit evidence refused staged source paths outside active WRITE claims.', stagedOutsideClaims);
    }
    let runtimeCommitCreated = false;
    let commitSubject = `autopilot captured child commit ${input.spec.unit_id} attempt ${String(input.spec.attempt)}`;
    const beforeHead = input.audit.baseline_head ?? headBeforeRuntimeCommit;
    if (dirtyClaimedPaths.length > 0)
        commitSubject = `autopilot runtime commit ${input.spec.unit_id} attempt ${String(input.spec.attempt)}`;
    const inspectCommit = () => {
        const currentHead = gitHead(input.spec.cwd);
        const currentDirty = readGitStatus(input.spec.cwd).changedPaths.filter((path) => !isAutopilotRuntimeRepoPath(path, input.spec.workstream));
        if (currentDirty.some((path) => !dirtyClaimedPaths.includes(path)))
            return { outcome: 'unsafe', proof: currentDirty.map((path) => `unexpected_dirty=${path}`) };
        if (currentDirty.length > 0)
            return { outcome: 'not-applied', proof: currentDirty.map((path) => `dirty=${path}`) };
        if (currentHead !== beforeHead) {
            const actualPaths = committedDiffPaths(input.spec.cwd, beforeHead, currentHead);
            const expectedPaths = [...editedClaimedPaths].sort((left, right) => left.localeCompare(right));
            if (actualPaths.length !== expectedPaths.length || actualPaths.some((path, index) => path !== expectedPaths[index]))
                return { outcome: 'unsafe', proof: [...expectedPaths.map((path) => `expected_path=${path}`), ...actualPaths.map((path) => `actual_path=${path}`)] };
            return { outcome: 'satisfied', proof: [`head=${currentHead}`, ...actualPaths.map((path) => `committed=${path}`), 'source_worktree_clean'] };
        }
        return { outcome: 'unsafe', proof: ['no_dirty_edits_and_head_not_advanced'] };
    };
    const commitPath = input.commitPath ?? deriveAutopilotExecutionCommitPath(input.spec);
    let durableRecord = null;
    const persistExecutionCommit = async () => {
        const afterHead = gitHead(input.spec.cwd);
        if (afterHead === beforeHead)
            fail('commit-not-created', 'source-changing success did not advance or capture a changed HEAD.');
        const diffPaths = committedDiffPaths(input.spec.cwd, beforeHead, afterHead);
        assertSameSet('committed diff paths', diffPaths, 'actual claimed changed paths', editedClaimedPaths);
        const afterStatus = readGitStatus(input.spec.cwd);
        const afterSourceDirty = afterStatus.changedPaths.filter((path) => !isAutopilotRuntimeRepoPath(path, input.spec.workstream));
        if (afterSourceDirty.length > 0)
            fail('post-commit-source-dirty', 'runtime commit left source paths dirty after commit.', afterSourceDirty);
        const record = parseAutopilotExecutionCommit({
            schema_version: 'autopilot.execution_commit.v1', workstream: input.spec.workstream, workstream_run: input.context.active.workstream_run,
            autopilot_id: input.context.active.autopilot_id, active_run_epoch: input.context.active.active_run_epoch, unit_id: input.spec.unit_id,
            role: input.spec.role, attempt: input.spec.attempt, cwd: input.spec.cwd, branch: currentBranch(input.spec.cwd), claimed_paths: claimedWritePatterns,
            edited_claimed_paths: editedClaimedPaths, before_head: beforeHead, after_head: afterHead, commit_sha: afterHead, commit_subject: commitSubject,
            commit_origin: executionCommitOrigin(runtimeCommitCreated, committedClaimedPaths.length > 0), commit_shas: commitRange(input.spec.cwd, beforeHead, afterHead),
            status_ref: relativeArtifactRef(input.spec.status_output, input.context.active.runtime_root), receipt_ref: relativeArtifactRef(input.spec.receipt_output, input.context.active.runtime_root),
            audit_ref: relativeArtifactRef(input.auditPath, input.context.active.runtime_root), created_at: new Date().toISOString(),
        });
        await mkdir(dirname(commitPath), { recursive: true });
        await writeFile(commitPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        return record;
    };
    await executeOwnedWorktreeSaga({
        active: input.context.active,
        unitId: input.spec.unit_id,
        attempt: input.spec.attempt,
        kind: 'unit',
        operationType: 'commit',
        operationKey: `execution-commit:${input.spec.unit_id}:${String(input.spec.attempt)}:${beforeHead}`,
        initialWorktreeState: 'active',
        committedWorktreeState: 'active',
        intent: {
            repo_root: input.context.active.source_repo,
            worktree_path: input.spec.cwd,
            git_common_dir: input.context.active.git_common_dir,
            branch: currentBranch(input.spec.cwd),
            reason: 'capture accepted source-changing child execution',
            base_sha: beforeHead,
            target_sha: null,
            archive_ref: null,
            checkout_mode: null,
            sparse_patterns: [],
            paths: editedClaimedPaths,
            metadata_refs: [relativeArtifactRef(input.commitPath ?? deriveAutopilotExecutionCommitPath(input.spec), input.context.active.runtime_root)],
        },
    }, {
        inspect: inspectCommit,
        action: () => {
            if (dirtyClaimedPaths.length === 0)
                return;
            runGit(['add', '--', ...dirtyClaimedPaths], input.spec.cwd, runtimeGitEnv(input.env));
            const staged = readGitStatus(input.spec.cwd);
            const stagedSource = staged.stagedPaths.filter((path) => !isAutopilotRuntimeRepoPath(path, input.spec.workstream));
            for (const stagedPath of stagedSource) {
                if (!dirtyClaimedPaths.includes(stagedPath))
                    fail('staged-path-set-mismatch', 'runtime staging included a source path outside dirty claimed edits.', [stagedPath]);
            }
            runGit(['commit', '--no-verify', '-m', commitSubject], input.spec.cwd, runtimeGitEnv(input.env));
            runtimeCommitCreated = true;
        },
        verify: async () => {
            const inspected = inspectCommit();
            if (inspected.outcome !== 'satisfied')
                fail('commit-saga-postcondition', 'execution commit saga did not produce a clean advanced HEAD.', inspected.proof);
            durableRecord = await persistExecutionCommit();
            return [...inspected.proof, `execution_commit_ref=${relativeArtifactRef(commitPath, input.context.active.runtime_root)}`];
        },
    }, input.env ?? process.env);
    if (durableRecord !== null)
        return durableRecord;
    return parseAutopilotExecutionCommit(JSON.parse(await readFile(commitPath, 'utf8')));
}
function activeWriteClaimPaths(input) {
    const fromAcquired = input.acquiredClaims.filter((claim) => claim.autopilot_id === input.context.active.autopilot_id &&
        claim.workstream_run === input.context.active.workstream_run &&
        claim.unit_id === input.spec.unit_id &&
        claim.attempt === input.spec.attempt &&
        (claim.claim_type === 'WRITE' || claim.claim_type === 'EXCLUSIVE')).map((claim) => claim.path);
    const unique = [...new Set(fromAcquired)].sort();
    if (unique.length === 0) {
        fail('missing-write-claims', 'source-changing runtime commit requires active WRITE claims for unit owned paths.');
    }
    return Object.freeze(unique);
}
function committedDiffPaths(cwd, beforeHead, afterHead) {
    const output = runGit(['diff', '--name-only', '-z', beforeHead, afterHead], cwd);
    return Object.freeze(output.split('\0').filter((path) => path.length > 0).map((path) => path.replace(/\\/gu, '/')).sort());
}
function commitRange(cwd, beforeHead, afterHead) {
    const output = runGit(['rev-list', '--reverse', `${beforeHead}..${afterHead}`], cwd);
    const shas = output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    return Object.freeze(shas.includes(afterHead) ? shas : [...shas, afterHead]);
}
function executionCommitOrigin(runtimeCommitCreated, childCommitCaptured) {
    if (runtimeCommitCreated && childCommitCaptured)
        return 'mixed';
    if (runtimeCommitCreated)
        return 'runtime';
    return 'child';
}
function currentBranch(cwd) {
    const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim();
    if (branch.length === 0 || branch === 'HEAD')
        fail('detached-execution-head', 'source-changing runtime commit requires the unit worktree to be on a named branch.');
    return branch;
}
function runtimeGitEnv(env = process.env) {
    return {
        ...env,
        [AUTOPILOT_RUNTIME_ENV]: AUTOPILOT_RUNTIME_VALUE,
        AUTOPILOT_RUNTIME_AUTHORITY: 'execution-commit',
        GIT_AUTHOR_NAME: 'autopilot-runtime',
        GIT_AUTHOR_EMAIL: 'autopilot-runtime@example.invalid',
        GIT_COMMITTER_NAME: 'autopilot-runtime',
        GIT_COMMITTER_EMAIL: 'autopilot-runtime@example.invalid',
    };
}
function assertSameSet(leftLabel, left, rightLabel, right) {
    const leftSet = sortedUnique(left);
    const rightSet = sortedUnique(right);
    if (leftSet.length !== rightSet.length || leftSet.some((value, index) => value !== rightSet[index])) {
        fail('path-set-mismatch', `${leftLabel} must equal ${rightLabel}.`, [
            `${leftLabel}=${JSON.stringify(leftSet)}`,
            `${rightLabel}=${JSON.stringify(rightSet)}`,
        ]);
    }
}
function sortedUnique(values) {
    return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}
function relativeArtifactRef(path, runtimeRoot) {
    const rel = path.startsWith(runtimeRoot) ? path.slice(runtimeRoot.length).replace(/^\/+/, '') : path;
    return rel.replace(/\\/gu, '/');
}
