import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { recordCoordinatorReleaseEvidenceFromFile } from "./coordination/reconciliation.js";
import { CoordinatorClient } from "./coordination/client.js";
import { parseCoordinationChildLease, parseCoordinationEditLease, parseCoordinationUnitAttempt, parseCoordinationWorktree, parseCoordinationWorktreeOperation } from "./coordination/contracts.js";
import { CoordinationRuntimeError } from "./coordination/failures.js";
import { readCoordinatorSessionContext } from "./coordination/supervisor.js";
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from "./names.js";
import { gitHead, readGitStatus, releaseClaimsForUnit, runGit, updateUnitBranchStatus, writeJsonAtomic } from "./parallel-runtime.js";
import { cleanupTerminalUnitWorktree } from "./worktree-cleanup.js";
import { executeOwnedWorktreeSaga } from "./coordination/worktree-saga.js";
export async function reconcileRetainedFailedUnitAuthority(input) {
    if (input.context.active.coordination_authority !== 'coordinator-edit-leases-v1')
        return Object.freeze([]);
    const env = input.env ?? process.env;
    const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    if (contextPath === undefined || contextPath.trim().length === 0)
        throw new CoordinationRuntimeError('unauthorized-client', 'retained failed-unit authority reconciliation requires the owner durable session');
    const session = await readCoordinatorSessionContext(contextPath);
    if (session.repo_id !== input.context.active.repo_key || session.autopilot_id !== input.context.active.autopilot_id || session.workstream_run !== input.context.active.workstream_run)
        throw new CoordinationRuntimeError('unauthorized-client', 'retained failed-unit authority does not belong to the attached run');
    const status = await new CoordinatorClient({ env: { ...env, AUTOPILOT_STATE_ROOT: session.state_root } }).query('status', session.repo_id, session.workstream_run);
    const array = (value, label) => {
        if (!Array.isArray(value))
            throw new CoordinationRuntimeError('invalid-state', `coordinator status ${label} is not an array`);
        return value;
    };
    const attempts = array(status.payload['unit_attempts'], 'unit_attempts').map(parseCoordinationUnitAttempt);
    const children = array(status.payload['child_leases'], 'child_leases').map(parseCoordinationChildLease);
    const leases = array(status.payload['edit_leases'], 'edit_leases').map(parseCoordinationEditLease);
    const worktrees = array(status.payload['worktrees'], 'worktrees').map(parseCoordinationWorktree);
    const operations = array(status.payload['worktree_operations'], 'worktree_operations').map(parseCoordinationWorktreeOperation);
    const processed = new Set();
    const records = [];
    for (const lease of leases) {
        const ownerKey = `${lease.owner.unit_id}\0${String(lease.owner.attempt)}`;
        if (processed.has(ownerKey))
            continue;
        const attempt = attempts.find((candidate) => candidate.owner.unit_id === lease.owner.unit_id && candidate.owner.attempt === lease.owner.attempt);
        const child = children.find((candidate) => candidate.owner.unit_id === lease.owner.unit_id && candidate.owner.attempt === lease.owner.attempt);
        if (attempt === undefined)
            throw new CoordinationRuntimeError('invalid-state', 'retained edit authority has no exact durable attempt owner', [lease.edit_lease_id]);
        if (attempt.role !== 'implement' && attempt.role !== 'fix')
            continue;
        if (child === undefined) {
            if (attempt.state === 'running' || attempt.state === 'preflight')
                continue;
            throw new CoordinationRuntimeError('recovery-required', 'terminal source-changing attempt retains edit authority without its child process fact', [lease.edit_lease_id, attempt.state]);
        }
        if (child.status !== 'terminal' && child.status !== 'recovery-required')
            continue;
        const worktree = worktrees.find((candidate) => candidate.kind === 'unit' && candidate.owner.unit_id === lease.owner.unit_id && candidate.owner.attempt === lease.owner.attempt && candidate.state !== 'removed');
        if (worktree === undefined)
            throw new CoordinationRuntimeError('recovery-required', 'terminal source-changing attempt retains edit authority without one recoverable registered unit worktree', [lease.edit_lease_id, child.child_lease_id]);
        if (worktree.state === 'quarantined') {
            const operation = operations.filter((candidate) => candidate.worktree_id === worktree.worktree_id && candidate.operation_type === 'quarantine' && candidate.stage === 'committed').sort((left, right) => right.intent_event_seq - left.intent_event_seq)[0];
            if (operation === undefined)
                throw new CoordinationRuntimeError('recovery-required', 'quarantined retained authority lacks its committed capture operation', [worktree.worktree_id]);
            records.push(await finishCommittedQuarantine({ context: input.context, unitId: lease.owner.unit_id, attempt: lease.owner.attempt, unitWorktreePath: worktree.canonical_path, summary: 'resume immutable quarantine publication for retained failed-attempt authority', env }, operation));
            processed.add(ownerKey);
            continue;
        }
        let metadata;
        try {
            metadata = JSON.parse(await readFile(join(dirname(worktree.canonical_path), '_unit-info.json'), 'utf8'));
        }
        catch (error) {
            throw new CoordinationRuntimeError('recovery-required', 'retained failed-unit authority lacks readable owned unit metadata', [worktree.canonical_path, error instanceof Error ? error.message : String(error)]);
        }
        if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))
            throw new CoordinationRuntimeError('invalid-state', 'owned unit metadata is not an object', [worktree.canonical_path]);
        const unitInfo = metadata;
        const baseSha = unitInfo['base_sha'];
        if (unitInfo['unit_id'] !== lease.owner.unit_id || unitInfo['attempt'] !== lease.owner.attempt || unitInfo['worktree_path'] !== worktree.canonical_path || typeof baseSha !== 'string' || !/^[a-f0-9]{7,64}$/u.test(baseSha))
            throw new CoordinationRuntimeError('invalid-state', 'owned unit metadata identity disagrees with retained authority', [worktree.canonical_path]);
        const cleanUnchanged = existsSync(worktree.canonical_path) && readGitStatus(worktree.canonical_path).changedPaths.length === 0 && gitHead(worktree.canonical_path) === baseSha;
        const failureInput = { context: input.context, unitId: lease.owner.unit_id, attempt: lease.owner.attempt, unitWorktreePath: worktree.canonical_path, summary: cleanUnchanged ? 'automatic clean failed-attempt reset during retained-authority reconciliation' : 'automatic immutable quarantine capture during retained-authority reconciliation', baselineHead: baseSha, env };
        records.push(cleanUnchanged ? await resetFailedUnit(failureInput) : await quarantineFailedUnit(failureInput));
        processed.add(ownerKey);
    }
    return Object.freeze(records);
}
export async function quarantineFailedUnit(input) {
    const record = await writeFailureRecord({ ...input, action: 'quarantine' });
    await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'quarantined', currentSha: record.git_head_after, archiveRef: record.capture_ref });
    await recordFailureEvidence(input, record, 'quarantine-capture');
    await releaseLegacyClaimsIfApplicable(input, 'autopilot failed unit quarantine');
    return record;
}
async function finishCommittedQuarantine(input, operation) {
    if (operation.owner.repo_id !== input.context.active.repo_key || operation.owner.autopilot_id !== input.context.active.autopilot_id || operation.owner.workstream_run !== input.context.active.workstream_run || operation.owner.unit_id !== input.unitId || operation.owner.attempt !== input.attempt || resolve(operation.intent.worktree_path) !== resolve(input.unitWorktreePath))
        throw new CoordinationRuntimeError('invalid-state', 'committed quarantine operation identity differs from retained authority ownership', [operation.operation_id]);
    const facts = inspectOwnedFailureWorktree(input);
    if (facts.mutablePaths.length > 0)
        throw new CoordinationRuntimeError('recovery-required', 'committed quarantine worktree regained mutable residue before evidence publication', facts.mutablePaths.slice(0, 128));
    const baseSha = operation.intent.base_sha;
    const preCaptureHead = operation.intent.target_sha;
    if (baseSha === null || preCaptureHead === null)
        throw new CoordinationRuntimeError('recovery-required', 'committed quarantine operation lacks exact baseline and pre-capture heads', [operation.operation_id]);
    if (operation.intent.paths.length === 0 && (facts.head !== preCaptureHead || facts.head === baseSha))
        throw new CoordinationRuntimeError('recovery-required', 'clean committed quarantine does not prove source commits after the attempt baseline', [operation.operation_id, baseSha, preCaptureHead, facts.head]);
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', baseSha, facts.head], { cwd: input.unitWorktreePath, encoding: 'utf8', timeout: 30_000 });
    const diff = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', baseSha, facts.head], { cwd: input.unitWorktreePath, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    if ((ancestor.status ?? -1) !== 0 || (diff.status ?? -1) !== 0)
        throw new CoordinationRuntimeError('recovery-required', 'committed quarantine capture is not an inspectable descendant of its pre-capture head', [baseSha, facts.head, ancestor.stderr.trim(), diff.stderr.trim()]);
    const capturedPaths = diff.stdout.split('\0').filter((path) => path.length > 0).map((path) => path.replace(/\\/gu, '/'));
    const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
    const uncovered = operation.intent.paths.filter((path) => !capturedPaths.some((candidate) => overlaps(path, candidate)));
    if ((operation.intent.paths.length > 0 && capturedPaths.length === 0) || uncovered.length > 0)
        throw new CoordinationRuntimeError('recovery-required', 'committed quarantine capture does not preserve every originally mutable path', uncovered.length > 0 ? uncovered : operation.intent.paths);
    const action = operation.intent.reason.startsWith('preserve ') ? 'preserve' : 'quarantine';
    const captureRef = `autopilot/archive/${input.context.active.workstream_run}/unit/${input.unitId}/attempt-${String(input.attempt)}/${action}-capture`;
    await archiveFailureBranch(input, facts.head, captureRef, `${action} immutable failure capture recovery`, 'quarantined');
    const evidencePath = join(input.context.active.runtime_root, 'quarantine', `${input.unitId}.attempt-${String(input.attempt)}.${action}.json`);
    let record;
    if (existsSync(evidencePath)) {
        let value;
        try {
            value = JSON.parse(await readFile(evidencePath, 'utf8'));
        }
        catch (error) {
            throw new CoordinationRuntimeError('recovery-required', 'committed quarantine evidence is unreadable during publication recovery', [evidencePath, error instanceof Error ? error.message : String(error)]);
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            throw new CoordinationRuntimeError('invalid-state', 'committed quarantine evidence is not an object', [evidencePath]);
        const candidate = value;
        const exactFields = ['schema_version', 'action', 'workstream', 'workstream_run', 'unit_id', 'attempt', 'unit_worktree_path', 'dirty_paths', 'capture_commit_sha', 'capture_ref', 'git_head_before', 'git_head_after', 'git_common_dir', 'branch', 'postcondition_worktree_clean', 'summary', 'created_at'].sort();
        const actualFields = Object.keys(candidate).sort();
        const exact = actualFields.length === exactFields.length && actualFields.every((field, index) => field === exactFields[index]);
        const dirtyPaths = candidate['dirty_paths'];
        if (!exact || candidate['schema_version'] !== 'autopilot.unit_failure.v1' || candidate['action'] !== action || candidate['workstream'] !== input.context.active.workstream || candidate['workstream_run'] !== input.context.active.workstream_run || candidate['unit_id'] !== input.unitId || candidate['attempt'] !== input.attempt || resolve(String(candidate['unit_worktree_path'])) !== resolve(input.unitWorktreePath) || !Array.isArray(dirtyPaths) || dirtyPaths.some((path) => typeof path !== 'string') || candidate['capture_commit_sha'] !== facts.head || candidate['capture_ref'] !== captureRef || candidate['git_head_before'] !== preCaptureHead || candidate['git_head_after'] !== facts.head || resolve(String(candidate['git_common_dir'])) !== resolve(facts.gitCommonDir) || candidate['branch'] !== facts.branch || candidate['postcondition_worktree_clean'] !== true || typeof candidate['summary'] !== 'string' || typeof candidate['created_at'] !== 'string' || !Number.isFinite(Date.parse(candidate['created_at'])))
            throw new CoordinationRuntimeError('invalid-state', 'committed quarantine evidence differs from exact capture operation and worktree facts', [evidencePath]);
        record = {
            schema_version: 'autopilot.unit_failure.v1', action, workstream: input.context.active.workstream, workstream_run: input.context.active.workstream_run,
            unit_id: input.unitId, attempt: input.attempt, unit_worktree_path: input.unitWorktreePath, dirty_paths: dirtyPaths.map((path) => String(path)),
            capture_commit_sha: facts.head, capture_ref: captureRef, git_head_before: preCaptureHead, git_head_after: facts.head, git_common_dir: facts.gitCommonDir,
            branch: facts.branch, postcondition_worktree_clean: true, summary: String(candidate['summary']), created_at: String(candidate['created_at']),
        };
    }
    else {
        record = {
            schema_version: 'autopilot.unit_failure.v1', action, workstream: input.context.active.workstream, workstream_run: input.context.active.workstream_run,
            unit_id: input.unitId, attempt: input.attempt, unit_worktree_path: input.unitWorktreePath, dirty_paths: operation.intent.paths,
            capture_commit_sha: facts.head, capture_ref: captureRef, git_head_before: preCaptureHead, git_head_after: facts.head, git_common_dir: facts.gitCommonDir,
            branch: facts.branch, postcondition_worktree_clean: true, summary: input.summary, created_at: (input.now ?? new Date()).toISOString(),
        };
        await mkdir(dirname(evidencePath), { recursive: true });
        await writeJsonAtomic(evidencePath, record);
    }
    await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'quarantined', currentSha: record.git_head_after, archiveRef: record.capture_ref });
    await recordFailureEvidence(input, record, 'quarantine-capture');
    await releaseLegacyClaimsIfApplicable(input, 'autopilot resumed failed unit quarantine publication');
    return record;
}
export async function resetFailedUnit(input) {
    const captured = await captureDirtyBeforeDestructiveTransition(input);
    if (captured !== null)
        return captured;
    await resetWorktreeForRecordedTransition(input, 'unit-reset', 'reset');
    const record = await writeFailureRecord({ ...input, action: 'reset' });
    const currentSha = record.git_head_after;
    const archiveRef = null;
    await recordFailureEvidence(input, record, 'attempt-reset');
    await releaseLegacyClaimsIfApplicable(input, 'autopilot failed unit reset');
    await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'aborted', currentSha, archiveRef });
    await cleanupTerminalUnitWorktree({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, allowedStatuses: ['aborted'], reason: 'autopilot failed unit reset cleanup', ...(input.env === undefined ? {} : { env: input.env }), ...(input.now === undefined ? {} : { now: input.now }) });
    return record;
}
export async function preserveFailedUnit(input) {
    const record = await writeFailureRecord({ ...input, action: 'preserve' });
    await updateUnitBranchStatus({ active: input.context.active, unitId: input.unitId, attempt: input.attempt, status: 'quarantined', currentSha: record.git_head_after, archiveRef: record.capture_ref });
    await recordFailureEvidence(input, record, 'quarantine-capture');
    await releaseLegacyClaimsIfApplicable(input, 'autopilot failed unit preserve-after-quarantine-capture');
    return record;
}
export async function abortFailedUnit(input) {
    const captured = await captureDirtyBeforeDestructiveTransition(input);
    if (captured !== null)
        return captured;
    await resetWorktreeForRecordedTransition(input, 'unit-abort-reset', 'abort');
    const record = await writeFailureRecord({ ...input, action: 'abort' });
    await recordFailureEvidence(input, record, 'attempt-reset');
    await releaseLegacyClaimsIfApplicable(input, 'autopilot failed unit abort');
    const currentSha = record.git_head_after;
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
async function archiveFailureBranch(input, sha, archiveRef, reason, worktreeState = 'terminal') {
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
        operationKey: `failure-archive:${archiveRef}:${sha}`, initialWorktreeState: worktreeState, committedWorktreeState: worktreeState,
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
    const facts = inspectOwnedFailureWorktree(input);
    if (facts.mutablePaths.length === 0)
        return null;
    return await quarantineFailedUnit({ ...input, summary: `automatic preservation before destructive transition: ${input.summary}` });
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
        throw new CoordinationRuntimeError('recovery-required', 'owned failed-unit worktree is missing before reset; edit authority remains retained', [input.unitWorktreePath]);
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
function parseFullStatus(output) {
    const records = output.split('\0');
    const mutable = new Set();
    const ignored = new Set();
    for (let index = 0; index < records.length; index += 1) {
        const entry = records[index];
        if (entry === undefined || entry.length === 0)
            continue;
        if (entry.length < 4 || entry[2] !== ' ')
            throw new CoordinationRuntimeError('invalid-state', 'quarantine Git status output is malformed', [entry]);
        const code = entry.slice(0, 2);
        const path = entry.slice(3).replace(/\\/gu, '/').replace(/\/$/u, '');
        if (path.length === 0)
            throw new CoordinationRuntimeError('invalid-state', 'quarantine Git status contains an empty path');
        mutable.add(path);
        if (code === '!!')
            ignored.add(path);
        if (code.includes('R') || code.includes('C')) {
            const second = records[index + 1];
            if (second === undefined || second.length === 0)
                throw new CoordinationRuntimeError('invalid-state', 'quarantine rename/copy status lacks its second path', [entry]);
            mutable.add(second.replace(/\\/gu, '/').replace(/\/$/u, ''));
            index += 1;
        }
    }
    return { mutablePaths: Object.freeze([...mutable].sort()), ignoredPaths: Object.freeze([...ignored].sort()) };
}
function inspectOwnedFailureWorktree(input) {
    if (!existsSync(input.unitWorktreePath))
        throw new CoordinationRuntimeError('recovery-required', 'owned failed-unit worktree is missing; refusing to substitute a base SHA or release edit authority', [input.unitWorktreePath]);
    const root = realpathSync(input.unitWorktreePath);
    const top = realpathSync(runGit(['rev-parse', '--show-toplevel'], input.unitWorktreePath).trim());
    if (root !== top)
        throw new CoordinationRuntimeError('unauthorized-client', 'failed-unit worktree path is not its exact Git toplevel', [root, top]);
    const commonRaw = runGit(['rev-parse', '--git-common-dir'], input.unitWorktreePath).trim();
    const common = realpathSync(isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw));
    const expectedCommon = realpathSync(input.context.active.git_common_dir);
    if (common !== expectedCommon)
        throw new CoordinationRuntimeError('unauthorized-client', 'failed-unit worktree belongs to a foreign Git common directory', [common, expectedCommon]);
    const branch = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], input.unitWorktreePath).trim();
    const expectedBranch = `autopilot/unit/${input.context.active.workstream_run}/${input.unitId}/attempt-${String(input.attempt)}`;
    if (branch !== expectedBranch)
        throw new CoordinationRuntimeError('invalid-state', 'failed-unit worktree branch differs from deterministic durable ownership', [branch, expectedBranch]);
    const head = gitHead(input.unitWorktreePath);
    if (!/^[a-f0-9]{40,64}$/u.test(head))
        throw new CoordinationRuntimeError('invalid-state', 'failed-unit worktree HEAD is not a full Git object id', [head]);
    const status = parseFullStatus(runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'], input.unitWorktreePath));
    return { head, branch, gitCommonDir: common, mutablePaths: status.mutablePaths, ignoredPaths: status.ignoredPaths };
}
function assertNoNestedRepositoryResidue(root, paths) {
    const pending = paths.map((path) => resolve(root, path));
    let inspected = 0;
    while (pending.length > 0) {
        const current = pending.pop();
        if (current === undefined || !existsSync(current))
            continue;
        const rel = relative(root, current);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
            throw new CoordinationRuntimeError('unauthorized-client', 'quarantine candidate escapes its owned worktree', [current]);
        const stat = lstatSync(current);
        inspected += 1;
        if (inspected > 100_000)
            throw new CoordinationRuntimeError('recovery-required', 'quarantine candidate exceeds the bounded filesystem inspection ceiling', [`entries>${String(100_000)}`]);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            continue;
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            if (entry.name === '.git')
                throw new CoordinationRuntimeError('recovery-required', 'quarantine cannot safely flatten nested repository or submodule metadata', [join(current, entry.name)]);
            pending.push(join(current, entry.name));
        }
    }
}
function configuredSubmodulePaths(cwd) {
    const result = spawnSync('git', ['config', '--file', '.gitmodules', '--get-regexp', '^[.]?submodule[.].*[.]path$'], { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    if ((result.status ?? -1) === 1)
        return Object.freeze([]);
    if ((result.status ?? -1) !== 0)
        throw new CoordinationRuntimeError('recovery-required', 'quarantine could not inspect submodule declarations', [result.stderr.trim()]);
    return Object.freeze(result.stdout.split(/\r?\n/u).filter((line) => line.length > 0).map((line) => line.slice(line.indexOf(' ') + 1).trim().replace(/\\/gu, '/')).filter((path) => path.length > 0));
}
async function writeFailureRecord(input) {
    const now = input.now ?? new Date();
    const before = inspectOwnedFailureWorktree(input);
    const dirtyPaths = before.mutablePaths;
    const captureCommitSha = input.action === 'quarantine' || input.action === 'preserve'
        ? await captureQuarantineSnapshot(input, before)
        : null;
    const after = inspectOwnedFailureWorktree(input);
    if (after.mutablePaths.length > 0)
        throw new CoordinationRuntimeError('recovery-required', 'failed-unit evidence cannot be published while mutable or ignored residue remains', after.mutablePaths.slice(0, 128));
    const captureRef = captureCommitSha === null ? null : `autopilot/archive/${input.context.active.workstream_run}/unit/${input.unitId}/attempt-${String(input.attempt)}/${input.action}-capture`;
    if (captureRef !== null && captureCommitSha !== null)
        await archiveFailureBranch(input, captureCommitSha, captureRef, `${input.action} immutable failure capture`, 'quarantined');
    const record = {
        schema_version: 'autopilot.unit_failure.v1', action: input.action, workstream: input.context.active.workstream, workstream_run: input.context.active.workstream_run,
        unit_id: input.unitId, attempt: input.attempt, unit_worktree_path: input.unitWorktreePath, dirty_paths: dirtyPaths,
        capture_commit_sha: captureCommitSha, capture_ref: captureRef, git_head_before: before.head, git_head_after: after.head,
        git_common_dir: after.gitCommonDir, branch: after.branch, postcondition_worktree_clean: true, summary: input.summary, created_at: now.toISOString(),
    };
    const root = join(input.context.active.runtime_root, 'quarantine');
    await mkdir(root, { recursive: true });
    await writeJsonAtomic(join(root, `${input.unitId}.attempt-${String(input.attempt)}.${input.action}.json`), record);
    return record;
}
async function failureBaselineHead(input, beforeFacts) {
    let baseline = input.baselineHead;
    if (baseline === undefined) {
        try {
            const value = JSON.parse(await readFile(join(dirname(input.unitWorktreePath), '_unit-info.json'), 'utf8'));
            if (typeof value !== 'object' || value === null || Array.isArray(value))
                throw new Error('unit metadata is not an object');
            const metadata = value;
            if (metadata['unit_id'] !== input.unitId || metadata['attempt'] !== input.attempt || resolve(String(metadata['worktree_path'])) !== resolve(input.unitWorktreePath) || typeof metadata['base_sha'] !== 'string')
                throw new Error('unit metadata identity is inconsistent');
            baseline = metadata['base_sha'];
        }
        catch (error) {
            if (beforeFacts.mutablePaths.length === 0)
                throw new CoordinationRuntimeError('recovery-required', 'clean committed quarantine requires the exact attempt baseline; refusing to treat current HEAD as provenance', [input.unitWorktreePath, error instanceof Error ? error.message : String(error)]);
            baseline = beforeFacts.head;
        }
    }
    if (!/^[a-f0-9]{40,64}$/u.test(baseline))
        throw new CoordinationRuntimeError('invalid-state', 'failed-unit baseline is not a full Git object id', [baseline]);
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', baseline, beforeFacts.head], { cwd: input.unitWorktreePath, encoding: 'utf8', timeout: 30_000 });
    if ((ancestor.status ?? -1) !== 0)
        throw new CoordinationRuntimeError('recovery-required', 'failed-unit pre-capture HEAD does not descend from its exact attempt baseline', [baseline, beforeFacts.head, ancestor.stderr.trim()]);
    return baseline;
}
async function captureQuarantineSnapshot(input, beforeFacts) {
    const active = input.context.active;
    const baselineHead = await failureBaselineHead(input, beforeFacts);
    assertNoNestedRepositoryResidue(input.unitWorktreePath, beforeFacts.mutablePaths);
    const submodules = configuredSubmodulePaths(input.unitWorktreePath);
    const changedSubmodules = submodules.filter((submodule) => beforeFacts.mutablePaths.some((path) => path === submodule || path.startsWith(`${submodule}/`) || submodule.startsWith(`${path}/`)));
    if (changedSubmodules.length > 0)
        throw new CoordinationRuntimeError('recovery-required', 'quarantine cannot certify dirty submodule bytes as an immutable superproject capture', changedSubmodules);
    const inspect = () => {
        const facts = inspectOwnedFailureWorktree(input);
        return facts.mutablePaths.length === 0 ? { outcome: 'satisfied', proof: [`head=${facts.head}`, `branch=${facts.branch}`, `git_common_dir=${facts.gitCommonDir}`, 'quarantine_capture_immutable', 'worktree_clean_including_ignored'] } : { outcome: 'not-applied', proof: facts.mutablePaths.slice(0, 128).map((path) => `mutable=${path}`) };
    };
    await executeOwnedWorktreeSaga({
        active, unitId: input.unitId, attempt: input.attempt, kind: 'unit', operationType: 'quarantine',
        operationKey: `${input.action}:${input.unitId}:${String(input.attempt)}:${beforeFacts.head}`,
        initialWorktreeState: 'active', committedWorktreeState: 'quarantined',
        intent: {
            repo_root: active.source_repo, worktree_path: input.unitWorktreePath, git_common_dir: active.git_common_dir, branch: beforeFacts.branch,
            reason: `${input.action} dirty failed work before releasing edit authority`, base_sha: baselineHead, target_sha: beforeFacts.head, archive_ref: null,
            checkout_mode: null, sparse_patterns: [], paths: beforeFacts.mutablePaths, metadata_refs: [],
        },
    }, {
        inspect,
        action: () => {
            if (inspectOwnedFailureWorktree(input).mutablePaths.length === 0)
                return;
            const env = {
                AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: 'unit-quarantine-capture',
                GIT_AUTHOR_NAME: 'autopilot-runtime', GIT_AUTHOR_EMAIL: 'autopilot-runtime@example.invalid',
                GIT_COMMITTER_NAME: 'autopilot-runtime', GIT_COMMITTER_EMAIL: 'autopilot-runtime@example.invalid',
            };
            runGit(['add', '--sparse', '-f', '-A', '--', '.'], input.unitWorktreePath, env);
            const staged = spawnSync('git', ['diff', '--cached', '--quiet', '--exit-code'], { cwd: input.unitWorktreePath, encoding: 'utf8', env: { ...process.env, ...env } });
            if ((staged.status ?? -1) === 1)
                runGit(['commit', '--no-verify', '-m', `autopilot quarantine capture ${active.workstream_run} ${input.unitId} attempt ${String(input.attempt)}`], input.unitWorktreePath, env);
            else if ((staged.status ?? -1) !== 0)
                throw new CoordinationRuntimeError('recovery-required', 'quarantine could not verify its staged capture', [staged.stderr.trim()]);
        },
        verify: () => {
            const inspected = inspect();
            if (inspected.outcome !== 'satisfied')
                throw new CoordinationRuntimeError('recovery-required', 'quarantine capture left mutable or ignored paths', inspected.proof);
            return inspected.proof;
        },
    }, input.env ?? process.env);
    return inspectOwnedFailureWorktree(input).head;
}
