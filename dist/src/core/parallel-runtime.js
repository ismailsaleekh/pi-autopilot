import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, hostname, platform, uptime } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AUTOPILOT_RUNTIME_ROOT_PREFIX } from "./names.js";
import { isValidWorkstreamSlug } from "./paths.js";
export const AUTOPILOT_STATE_ROOT_ENV = 'AUTOPILOT_STATE_ROOT';
export const AUTOPILOT_RUNTIME_ENV = 'AUTOPILOT_RUNTIME';
export const AUTOPILOT_RUNTIME_VALUE = '1';
export const ACTIVE_AUTOPILOTS_FILE = 'active-autopilots.json';
export const PATH_CLAIMS_FILE = 'path-claims.json';
export const CLAIM_EVENTS_FILE = 'claim-events.jsonl';
export const MERGE_LOG_FILE = 'merge-log.jsonl';
export const FOREIGN_MERGE_ACKS_FILE = 'foreign-merge-acks.jsonl';
export const WORKTREE_INDEX_FILE = '_index.json';
export const WORKTREE_LEDGER_FILE = '_ledger.jsonl';
export const TASK_INFO_FILE = '_task-info.json';
export const BRANCHES_FILE = '_branches.json';
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const LOCK_STALE_MULTIPLIER = 5;
const LOCK_BACKOFF_START_MS = 100;
const LOCK_BACKOFF_STEP_MS = 100;
const LOCK_BACKOFF_CAP_MS = 2_000;
export class AutopilotParallelRuntimeError extends Error {
    name = 'AutopilotParallelRuntimeError';
    code;
    evidence;
    constructor(code, message, evidence = []) {
        super(`AutopilotParallelRuntimeError [${code}]: ${message}`);
        this.code = code;
        this.evidence = Object.freeze([...evidence]);
    }
}
function fail(code, message, evidence = []) {
    throw new AutopilotParallelRuntimeError(code, message, evidence);
}
export function resolveAutopilotStateRoot(env = process.env) {
    const override = env[AUTOPILOT_STATE_ROOT_ENV];
    if (override !== undefined) {
        const trimmed = override.trim();
        if (trimmed.length === 0) {
            fail('invalid-state-root', `${AUTOPILOT_STATE_ROOT_ENV} must be non-empty when set.`);
        }
        if (!isAbsolute(trimmed)) {
            fail('invalid-state-root', `${AUTOPILOT_STATE_ROOT_ENV} must be absolute when set.`, [trimmed]);
        }
        return resolve(trimmed);
    }
    return join(homedir(), '.pi', 'agent', 'autopilot');
}
export function coordinationRootForRepo(repoKey, env = process.env) {
    return join(resolveAutopilotStateRoot(env), 'coordination', repoKey);
}
export function worktreeRootForRepo(repoKey, env = process.env) {
    return join(resolveAutopilotStateRoot(env), 'worktrees', repoKey);
}
export function mainMergeLockPathForRepo(repoKey, env = process.env) {
    return join(coordinationRootForRepo(repoKey, env), 'main-merge.lock');
}
export function taskRootForActiveAutopilot(row) {
    return dirname(row.main_worktree_path);
}
export async function prepareAutopilotWorkstream(input) {
    if (!isValidWorkstreamSlug(input.workstream)) {
        fail('invalid-workstream', `Invalid Autopilot workstream slug: ${input.workstream}`);
    }
    const env = input.env ?? process.env;
    const now = input.now ?? new Date();
    const repo = resolveRepoIdentity(input.sourceCwd);
    const coordinationRoot = coordinationRootForRepo(repo.repoKey, env);
    const worktreeRoot = worktreeRootForRepo(repo.repoKey, env);
    await ensureRepoRuntimeFiles(coordinationRoot, worktreeRoot);
    return await withAutopilotFileLock(join(coordinationRoot, '.locks', 'activation.lock'), `activation:${repo.repoKey}`, async () => {
        const activeRows = await readActiveAutopilots(coordinationRoot);
        const matching = activeRows.filter((row) => row.repo_key === repo.repoKey && row.workstream === input.workstream && isLiveParentStatus(row.status));
        if (matching.length > 1) {
            fail('ambiguous-workstream-run', `Multiple active Autopilot runs match workstream ${input.workstream}; resume requires an exact workstream_run.`, matching.map((row) => `${row.workstream_run} ${row.status} ${row.main_worktree_path}`));
        }
        if (matching.length === 1) {
            const row = matching[0];
            if (row === undefined)
                fail('internal-missing-active-row', 'matched active row disappeared.');
            const resumed = reactivateActiveRow(row, repo, now);
            const nextRows = activeRows.map((candidate) => candidate.autopilot_id === row.autopilot_id ? resumed : candidate);
            await writeActiveAutopilots(coordinationRoot, nextRows);
            await updateTaskInfoStatus(resumed, 'active');
            return {
                repo,
                active: resumed,
                worktreeRoot,
                taskRoot: dirname(resumed.main_worktree_path),
                mainWorktreePath: resumed.main_worktree_path,
                runtimeRoot: resumed.runtime_root,
                created: false,
                resumed: true,
            };
        }
        const created = await createNewWorkstream({
            workstream: input.workstream,
            repo,
            coordinationRoot,
            worktreeRoot,
            activeRows,
            now,
            env,
        });
        return created;
    });
}
export async function resolveActiveAutopilotForSpec(spec, env = process.env) {
    const repo = resolveRepoIdentity(spec.cwd);
    const coordinationRoot = coordinationRootForRepo(repo.repoKey, env);
    const activeRows = await readActiveAutopilots(coordinationRoot);
    const cwdReal = realpathExisting(spec.cwd, 'unit spec cwd');
    const matches = activeRows.filter((row) => {
        if (row.repo_key !== repo.repoKey || row.workstream !== spec.workstream || !isChildLaunchParentStatus(row.status))
            return false;
        const worktreeReal = realpathExisting(row.main_worktree_path, 'registered Autopilot worktree');
        return isPathWithinRoot(worktreeReal, cwdReal);
    });
    if (matches.length === 0) {
        fail('unregistered-worktree', 'unit spec cwd is not inside an active registered Autopilot worktree.', [
            `cwd=${spec.cwd}`,
            `workstream=${spec.workstream}`,
            `repo_key=${repo.repoKey}`,
        ]);
    }
    if (matches.length > 1) {
        fail('ambiguous-worktree-registration', 'unit spec cwd matched multiple active Autopilot worktrees.', matches.map((row) => row.workstream_run));
    }
    const active = matches[0];
    if (active === undefined)
        fail('internal-missing-active-row', 'active row disappeared.');
    const expectedRuntimeRoot = resolve(active.main_worktree_path, AUTOPILOT_RUNTIME_ROOT_PREFIX, spec.workstream);
    if (normalizePath(active.runtime_root) !== normalizePath(expectedRuntimeRoot)) {
        fail('runtime-root-mismatch', 'active Autopilot runtime root does not match the registered worktree.', [
            `active.runtime_root=${active.runtime_root}`,
            `expected=${expectedRuntimeRoot}`,
        ]);
    }
    if (!isPathWithinRoot(active.runtime_root, spec.status_output)) {
        fail('status-output-outside-runtime', 'status_output is outside the active Autopilot runtime root.', [spec.status_output, active.runtime_root]);
    }
    if (!isPathWithinRoot(active.runtime_root, spec.receipt_output)) {
        fail('receipt-output-outside-runtime', 'receipt_output is outside the active Autopilot runtime root.', [spec.receipt_output, active.runtime_root]);
    }
    if (!isPathWithinRoot(active.runtime_root, spec.evidence_dir)) {
        fail('evidence-dir-outside-runtime', 'evidence_dir is outside the active Autopilot runtime root.', [spec.evidence_dir, active.runtime_root]);
    }
    if (normalizePath(active.source_repo) === normalizePath(active.main_worktree_path)) {
        fail('invalid-active-row-source', 'active Autopilot row has identical source and worktree paths.', [active.source_repo]);
    }
    if (isSamePath(active.source_repo, spec.cwd)) {
        fail('source-checkout-launch', 'source-changing child launch from the operator checkout is forbidden; use the registered Autopilot worktree.', [
            `source_repo=${active.source_repo}`,
            `cwd=${spec.cwd}`,
        ]);
    }
    return {
        repo,
        active,
        coordinationRoot,
        claimsPath: join(coordinationRoot, PATH_CLAIMS_FILE),
        claimEventsPath: join(coordinationRoot, CLAIM_EVENTS_FILE),
    };
}
export async function acquireClaimsForUnit(input) {
    const requested = requestedClaimsForSpec(input.context.active, input.spec, input.reason);
    if (requested.length === 0)
        return Object.freeze([]);
    const lockPath = join(input.context.coordinationRoot, '.locks', 'path-claims.lock');
    return await withAutopilotFileLock(lockPath, `claims:${input.context.active.autopilot_id}`, async () => {
        const activeRows = await readActiveAutopilots(input.context.coordinationRoot);
        const authority = activeRows.find((row) => row.autopilot_id === input.context.active.autopilot_id);
        if (authority === undefined || !isChildLaunchParentStatus(authority.status)) {
            fail('active-authority-missing', 'active Autopilot row is missing or not child-launch authorized before claim acquisition.', [input.context.active.autopilot_id]);
        }
        if (authority.active_run_epoch !== input.context.active.active_run_epoch) {
            fail('active-epoch-mismatch', 'active Autopilot epoch changed before claim acquisition.', [
                `expected=${String(input.context.active.active_run_epoch)}`,
                `actual=${String(authority.active_run_epoch)}`,
            ]);
        }
        const existing = await readPathClaims(input.context.coordinationRoot);
        const blockers = findClaimBlockers(existing, requested, authority);
        if (blockers.length > 0) {
            for (const requestedClaim of requested) {
                await appendClaimEvent(input.context.coordinationRoot, {
                    schema_version: 'autopilot.claim_event.v1',
                    event: 'rejected',
                    ts: new Date().toISOString(),
                    repo_key: authority.repo_key,
                    autopilot_id: authority.autopilot_id,
                    workstream: authority.workstream,
                    workstream_run: authority.workstream_run,
                    unit_id: input.spec.unit_id,
                    attempt: input.spec.attempt,
                    path: requestedClaim.path,
                    claim_type: requestedClaim.claim_type,
                    active_run_epoch: authority.active_run_epoch,
                    reason: input.reason,
                    blockers,
                });
            }
            fail('claim-conflict', 'Autopilot path claim rejected because another active Autopilot owns an overlapping path.', blockers.map((blocker) => `${blocker.claim_type} ${blocker.path} by ${blocker.workstream_run}/${blocker.unit_id}`));
        }
        const next = mergeClaims(existing, requested);
        await writePathClaims(input.context.coordinationRoot, next);
        for (const claim of requested) {
            await appendClaimEvent(input.context.coordinationRoot, {
                schema_version: 'autopilot.claim_event.v1',
                event: 'acquire',
                ts: claim.acquired_at,
                repo_key: authority.repo_key,
                autopilot_id: authority.autopilot_id,
                workstream: authority.workstream,
                workstream_run: authority.workstream_run,
                unit_id: claim.unit_id,
                attempt: claim.attempt,
                path: claim.path,
                claim_type: claim.claim_type,
                active_run_epoch: authority.active_run_epoch,
                reason: claim.reason,
            });
        }
        return requested;
    });
}
export async function ensureWorktreeCleanForLaunch(input) {
    const status = readGitStatus(input.spec.cwd);
    const sourceDirty = status.changedPaths.filter((path) => !isAutopilotRuntimeRepoPath(path, input.spec.workstream));
    if (sourceDirty.length > 0) {
        fail('dirty-worktree-before-launch', 'registered Autopilot worktree has source changes before child launch.', sourceDirty);
    }
}
export function readGitStatus(cwd) {
    const output = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
    return parseStatusPorcelainZ(output);
}
export function gitHead(cwd) {
    return runGit(['rev-parse', 'HEAD'], cwd).trim();
}
export function runGit(args, cwd, env = process.env) {
    const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
    if (result.error !== undefined) {
        fail('git-spawn-failed', `git ${args.join(' ')} failed to spawn: ${result.error.message}`);
    }
    if ((result.status ?? -1) !== 0) {
        fail('git-command-failed', `git ${args.join(' ')} exited with status ${String(result.status ?? -1)}.`, [
            result.stderr.trim(),
            result.stdout.trim(),
        ]);
    }
    return result.stdout;
}
export function resolveRepoIdentity(cwd) {
    const repoRoot = realpathExisting(runGit(['rev-parse', '--show-toplevel'], cwd).trim(), 'git repo root');
    const commonDirRaw = runGit(['rev-parse', '--git-common-dir'], repoRoot).trim();
    const gitCommonDir = realpathExisting(isAbsolute(commonDirRaw) ? commonDirRaw : resolve(repoRoot, commonDirRaw), 'git common dir');
    const keyHash = sha256Text(`autopilot.repo_key.v1\n${gitCommonDir}\n`);
    const repoKey = `sha256-${keyHash}`;
    const headSha = runGit(['rev-parse', 'HEAD'], repoRoot).trim();
    const targetBranchResult = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    const targetBranch = targetBranchResult.status === 0 ? targetBranchResult.stdout.trim() || null : null;
    const originResult = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: repoRoot, encoding: 'utf8' });
    const originUrl = originResult.status === 0 ? sanitizeOriginUrl(originResult.stdout.trim()) : null;
    return { repoRoot, gitCommonDir, repoKey, headSha, targetBranch, originUrl };
}
export function isAutopilotRuntimeRepoPath(repoRelativePath, workstream) {
    const runtimeRoot = `${AUTOPILOT_RUNTIME_ROOT_PREFIX}/${workstream}`;
    return pathOverlapsOrContains(runtimeRoot, normalizeRepoRelativePath(repoRelativePath));
}
export function pathOverlapsOrContains(left, right) {
    const a = normalizeRepoRelativePath(left);
    const b = normalizeRepoRelativePath(right);
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
export function matchesRepoPathPattern(path, pattern) {
    const normalizedPath = normalizeRepoRelativePath(path);
    const normalizedPattern = normalizeRepoRelativePath(pattern);
    if (normalizedPattern.endsWith('/**')) {
        const base = normalizedPattern.slice(0, -3);
        return normalizedPath === base || normalizedPath.startsWith(`${base}/`);
    }
    return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
}
export function isPathWithinRoot(root, candidate) {
    const normalizedRoot = normalizePath(root);
    const normalizedCandidate = normalizePath(candidate);
    const rel = relative(normalizedRoot, normalizedCandidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}
export function normalizeRepoRelativePath(value) {
    if (value.includes('\0'))
        fail('invalid-repo-path', 'repo-relative path contains NUL.');
    if (isAbsolute(value) || /^[A-Za-z]:/u.test(value))
        fail('invalid-repo-path', 'repo-relative path must not be absolute.', [value]);
    if (value.includes('\\'))
        fail('invalid-repo-path', 'repo-relative path must use POSIX separators.', [value]);
    const normalized = value.split('/').filter((segment) => segment.length > 0).join('/');
    if (normalized.length === 0)
        fail('invalid-repo-path', 'repo-relative path must not be empty.');
    if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) {
        fail('invalid-repo-path', 'repo-relative path must not contain traversal segments.', [value]);
    }
    return normalized;
}
async function createNewWorkstream(input) {
    const startedAt = input.now.toISOString();
    const workstreamRun = buildWorkstreamRun(input.workstream, input.now);
    const autopilotId = `ap-${workstreamRun}`;
    const branch = `autopilot/${workstreamRun}`;
    const taskRoot = join(input.worktreeRoot, 'active', workstreamRun);
    const mainWorktreePath = join(taskRoot, 'main');
    const runtimeRoot = resolve(mainWorktreePath, AUTOPILOT_RUNTIME_ROOT_PREFIX, input.workstream);
    if (existsSync(mainWorktreePath)) {
        fail('worktree-path-exists', 'refusing to create Autopilot worktree at an existing path.', [mainWorktreePath]);
    }
    assertBranchAvailable(input.repo.repoRoot, branch);
    await mkdir(taskRoot, { recursive: true });
    try {
        runGit(['worktree', 'add', '-b', branch, mainWorktreePath, input.repo.headSha], input.repo.repoRoot, {
            ...input.env,
            [AUTOPILOT_RUNTIME_ENV]: AUTOPILOT_RUNTIME_VALUE,
        });
    }
    catch (error) {
        await rm(taskRoot, { recursive: true, force: true });
        throw error;
    }
    await mkdir(runtimeRoot, { recursive: true });
    const row = {
        schema_version: 'autopilot.active_parent.v1',
        autopilot_id: autopilotId,
        workstream: input.workstream,
        workstream_run: workstreamRun,
        repo_key: input.repo.repoKey,
        source_repo: input.repo.repoRoot,
        git_common_dir: input.repo.gitCommonDir,
        worktree_root: input.worktreeRoot,
        main_worktree_path: mainWorktreePath,
        branch,
        runtime_root: runtimeRoot,
        target_branch: input.repo.targetBranch,
        target_base_sha: input.repo.headSha,
        origin_url: input.repo.originUrl,
        pid: process.pid,
        boot_id: getBootId(),
        status: 'active',
        started_at: startedAt,
        active_run_epoch: 1,
        active_epoch_started_at: startedAt,
        active_run_receipt_id: buildReceiptId('bootstrap-register'),
    };
    const taskInfo = {
        schema_version: 'autopilot.task_info.v1',
        workstream: row.workstream,
        workstream_run: row.workstream_run,
        autopilot_id: row.autopilot_id,
        source_repo: row.source_repo,
        git_common_dir: row.git_common_dir,
        repo_key: row.repo_key,
        base_sha: row.target_base_sha,
        branch: row.branch,
        worktree_path: row.main_worktree_path,
        runtime_root: row.runtime_root,
        target_branch: row.target_branch,
        target_base_sha: row.target_base_sha,
        started_at: row.started_at,
        closed_at: null,
        status: row.status,
    };
    const branches = {
        schema_version: 'autopilot.branches.v1',
        active_branch: row.branch,
        base_sha: row.target_base_sha,
        current_sha: row.target_base_sha,
        archive_ref: null,
        unit_branches: [],
    };
    await writeJsonAtomic(join(taskRoot, TASK_INFO_FILE), taskInfo);
    await writeJsonAtomic(join(taskRoot, BRANCHES_FILE), branches);
    await writeActiveAutopilots(input.coordinationRoot, [...input.activeRows, row]);
    await addWorktreeIndexRow(input.worktreeRoot, {
        workstream: row.workstream,
        workstream_run: row.workstream_run,
        autopilot_id: row.autopilot_id,
        started_at: row.started_at,
        main_path: row.main_worktree_path,
        branch: row.branch,
        status: 'active',
    });
    await appendJsonl(join(input.worktreeRoot, WORKTREE_LEDGER_FILE), {
        schema_version: 'autopilot.worktree_ledger.v1',
        event: 'create',
        ts: startedAt,
        workstream: row.workstream,
        workstream_run: row.workstream_run,
        autopilot_id: row.autopilot_id,
        branch: row.branch,
        main_path: row.main_worktree_path,
        base_sha: row.target_base_sha,
    });
    return {
        repo: input.repo,
        active: row,
        worktreeRoot: input.worktreeRoot,
        taskRoot,
        mainWorktreePath,
        runtimeRoot,
        created: true,
        resumed: false,
    };
}
function reactivateActiveRow(row, repo, now) {
    const bootId = getBootId();
    const sameProcess = row.pid === process.pid && row.boot_id === bootId;
    return {
        ...row,
        git_common_dir: repo.gitCommonDir,
        source_repo: repo.repoRoot,
        pid: process.pid,
        boot_id: bootId,
        status: 'active',
        active_run_epoch: sameProcess ? row.active_run_epoch : row.active_run_epoch + 1,
        active_epoch_started_at: now.toISOString(),
        active_run_receipt_id: sameProcess ? row.active_run_receipt_id : buildReceiptId('resume-reactivate'),
    };
}
function requestedClaimsForSpec(active, spec, reason) {
    const now = new Date().toISOString();
    const claims = [];
    const add = (path, claimType) => {
        claims.push({
            schema_version: 'autopilot.path_claim.v1',
            path: normalizeRepoRelativePath(path),
            autopilot_id: active.autopilot_id,
            workstream: active.workstream,
            workstream_run: active.workstream_run,
            unit_id: spec.unit_id,
            attempt: spec.attempt,
            claim_type: claimType,
            acquired_at: now,
            active_run_epoch: active.active_run_epoch,
            reason,
        });
    };
    for (const path of spec.owned_paths)
        add(path, 'WRITE');
    for (const path of spec.read_only_paths)
        add(path, 'READ');
    return Object.freeze(dedupeClaims(claims));
}
function dedupeClaims(claims) {
    const seen = new Set();
    const out = [];
    for (const claim of claims) {
        const key = `${claim.claim_type}\0${claim.path}\0${claim.unit_id}\0${String(claim.attempt)}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(claim);
    }
    return out;
}
function findClaimBlockers(existing, requested, authority) {
    const blockers = [];
    for (const req of requested) {
        for (const claim of existing) {
            if (claim.autopilot_id === authority.autopilot_id)
                continue;
            if (!pathOverlapsOrContains(req.path, claim.path))
                continue;
            if (!claimTypesConflict(req.claim_type, claim.claim_type))
                continue;
            blockers.push({
                path: claim.path,
                claim_type: claim.claim_type,
                autopilot_id: claim.autopilot_id,
                workstream: claim.workstream,
                workstream_run: claim.workstream_run,
                unit_id: claim.unit_id,
                attempt: claim.attempt,
            });
        }
    }
    return Object.freeze(blockers);
}
function claimTypesConflict(requested, existing) {
    if (requested === 'READ' && existing === 'READ')
        return false;
    return true;
}
function mergeClaims(existing, requested) {
    const out = [...existing];
    for (const claim of requested) {
        const alreadyPresent = out.some((candidate) => candidate.autopilot_id === claim.autopilot_id &&
            candidate.active_run_epoch === claim.active_run_epoch &&
            candidate.unit_id === claim.unit_id &&
            candidate.attempt === claim.attempt &&
            candidate.path === claim.path &&
            candidate.claim_type === claim.claim_type);
        if (!alreadyPresent)
            out.push(claim);
    }
    return Object.freeze(out.sort((left, right) => `${left.path}\0${left.autopilot_id}\0${left.unit_id}`.localeCompare(`${right.path}\0${right.autopilot_id}\0${right.unit_id}`)));
}
async function ensureRepoRuntimeFiles(coordinationRoot, worktreeRoot) {
    await mkdir(join(coordinationRoot, '.locks'), { recursive: true });
    await mkdir(join(worktreeRoot, 'active'), { recursive: true });
    await mkdir(join(worktreeRoot, '_archive'), { recursive: true });
    for (const file of [ACTIVE_AUTOPILOTS_FILE, PATH_CLAIMS_FILE]) {
        const path = join(coordinationRoot, file);
        if (!existsSync(path))
            await writeJsonAtomic(path, []);
    }
    for (const file of [CLAIM_EVENTS_FILE, MERGE_LOG_FILE, FOREIGN_MERGE_ACKS_FILE]) {
        const path = join(coordinationRoot, file);
        if (!existsSync(path))
            await writeFile(path, '', { encoding: 'utf8', flag: 'wx' }).catch((error) => {
                if (isNodeError(error) && error.code === 'EEXIST')
                    return;
                throw error;
            });
    }
    const indexPath = join(worktreeRoot, WORKTREE_INDEX_FILE);
    if (!existsSync(indexPath))
        await writeJsonAtomic(indexPath, emptyWorktreeIndex());
    const ledgerPath = join(worktreeRoot, WORKTREE_LEDGER_FILE);
    if (!existsSync(ledgerPath))
        await writeFile(ledgerPath, '', { encoding: 'utf8', flag: 'wx' }).catch((error) => {
            if (isNodeError(error) && error.code === 'EEXIST')
                return;
            throw error;
        });
}
export async function readActiveAutopilots(coordinationRoot) {
    const path = join(coordinationRoot, ACTIVE_AUTOPILOTS_FILE);
    if (!existsSync(path))
        return Object.freeze([]);
    const value = await readJson(path);
    if (!Array.isArray(value))
        fail('invalid-active-autopilots', 'active-autopilots.json must contain an array.');
    return Object.freeze(value.map(parseActiveAutopilotRow));
}
export async function writeActiveAutopilots(coordinationRoot, rows) {
    await writeJsonAtomic(join(coordinationRoot, ACTIVE_AUTOPILOTS_FILE), rows);
}
export async function readPathClaims(coordinationRoot) {
    const path = join(coordinationRoot, PATH_CLAIMS_FILE);
    if (!existsSync(path))
        return Object.freeze([]);
    const value = await readJson(path);
    if (!Array.isArray(value))
        fail('invalid-path-claims', 'path-claims.json must contain an array.');
    return Object.freeze(value.map(parsePathClaim));
}
export async function writePathClaims(coordinationRoot, claims) {
    await writeJsonAtomic(join(coordinationRoot, PATH_CLAIMS_FILE), claims);
}
export async function appendClaimEvent(coordinationRoot, event) {
    await appendJsonl(join(coordinationRoot, CLAIM_EVENTS_FILE), event);
}
async function addWorktreeIndexRow(worktreeRoot, row) {
    const path = join(worktreeRoot, WORKTREE_INDEX_FILE);
    const current = await readWorktreeIndex(path);
    const active = current.active.filter((candidate) => candidate.workstream_run !== row.workstream_run);
    await writeJsonAtomic(path, { ...current, active: [...active, row] });
}
export async function readWorktreeIndex(path) {
    if (!existsSync(path))
        return emptyWorktreeIndex();
    const value = await readJson(path);
    if (!isRecord(value))
        fail('invalid-worktree-index', '_index.json must contain an object.');
    const active = Array.isArray(value['active']) ? value['active'].map(parseWorktreeIndexRow) : [];
    const archive = Array.isArray(value['archive']) ? value['archive'].map(parseWorktreeIndexRow) : [];
    return { schema_version: 'autopilot.worktree_index.v1', active, archive };
}
function emptyWorktreeIndex() {
    return { schema_version: 'autopilot.worktree_index.v1', active: [], archive: [] };
}
export async function updateTaskInfoStatus(row, status) {
    const path = join(dirname(row.main_worktree_path), TASK_INFO_FILE);
    if (!existsSync(path))
        return;
    const value = await readJson(path);
    if (!isRecord(value))
        fail('invalid-task-info', '_task-info.json must contain an object.');
    await writeJsonAtomic(path, { ...value, status, runtime_root: row.runtime_root, worktree_path: row.main_worktree_path });
}
function parseActiveAutopilotRow(value) {
    if (!isRecord(value))
        fail('invalid-active-row', 'active Autopilot row must be an object.');
    const row = value;
    const parsed = {
        schema_version: expectConst(row, 'schema_version', 'autopilot.active_parent.v1'),
        autopilot_id: expectString(row, 'autopilot_id'),
        workstream: expectString(row, 'workstream'),
        workstream_run: expectString(row, 'workstream_run'),
        repo_key: expectString(row, 'repo_key'),
        source_repo: expectString(row, 'source_repo'),
        git_common_dir: expectString(row, 'git_common_dir'),
        worktree_root: expectString(row, 'worktree_root'),
        main_worktree_path: expectString(row, 'main_worktree_path'),
        branch: expectString(row, 'branch'),
        runtime_root: expectString(row, 'runtime_root'),
        target_branch: expectNullableString(row, 'target_branch'),
        target_base_sha: expectString(row, 'target_base_sha'),
        origin_url: expectNullableString(row, 'origin_url'),
        pid: expectInteger(row, 'pid'),
        boot_id: expectString(row, 'boot_id'),
        status: expectOneOf(row, 'status', ['active', 'paused', 'merging', 'blocked', 'crashed', 'closed']),
        started_at: expectString(row, 'started_at'),
        active_run_epoch: expectInteger(row, 'active_run_epoch'),
        active_epoch_started_at: expectString(row, 'active_epoch_started_at'),
        active_run_receipt_id: expectString(row, 'active_run_receipt_id'),
    };
    return parsed;
}
function parsePathClaim(value) {
    if (!isRecord(value))
        fail('invalid-path-claim', 'path claim must be an object.');
    const row = value;
    return {
        schema_version: expectConst(row, 'schema_version', 'autopilot.path_claim.v1'),
        path: normalizeRepoRelativePath(expectString(row, 'path')),
        autopilot_id: expectString(row, 'autopilot_id'),
        workstream: expectString(row, 'workstream'),
        workstream_run: expectString(row, 'workstream_run'),
        unit_id: expectString(row, 'unit_id'),
        attempt: expectInteger(row, 'attempt'),
        claim_type: expectOneOf(row, 'claim_type', ['READ', 'WRITE', 'EXCLUSIVE']),
        acquired_at: expectString(row, 'acquired_at'),
        active_run_epoch: expectInteger(row, 'active_run_epoch'),
        reason: expectString(row, 'reason'),
    };
}
function parseWorktreeIndexRow(value) {
    if (!isRecord(value))
        fail('invalid-worktree-index-row', 'worktree index row must be an object.');
    const row = value;
    return {
        workstream: expectString(row, 'workstream'),
        workstream_run: expectString(row, 'workstream_run'),
        autopilot_id: expectString(row, 'autopilot_id'),
        started_at: expectString(row, 'started_at'),
        main_path: expectString(row, 'main_path'),
        branch: expectString(row, 'branch'),
        status: expectOneOf(row, 'status', ['active', 'archived']),
    };
}
function parseStatusPorcelainZ(output) {
    const records = output.split('\0').filter((record) => record.length > 0);
    const changed = new Set();
    const staged = new Set();
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (record === undefined || record.length < 4)
            continue;
        const x = record.charAt(0);
        const path = normalizeRepoRelativePath(record.slice(3).replace(/\\/gu, '/'));
        changed.add(path);
        if (x !== ' ' && x !== '?')
            staged.add(path);
        if ((x === 'R' || x === 'C') && index + 1 < records.length)
            index += 1;
    }
    return {
        changedPaths: sortedStrings([...changed]),
        stagedPaths: sortedStrings([...staged]),
    };
}
function sortedStrings(values) {
    return Object.freeze([...values].sort((left, right) => left.localeCompare(right)));
}
function assertBranchAvailable(repoRoot, branch) {
    const result = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot, encoding: 'utf8' });
    if (result.status === 0)
        fail('branch-exists', 'Autopilot branch already exists before worktree creation.', [branch]);
    if (result.status !== 1)
        fail('branch-check-failed', 'git show-ref failed while checking Autopilot branch availability.', [branch, result.stderr]);
}
export async function withAutopilotFileLock(lockPath, holderId, run) {
    const handle = await acquireFileLock(lockPath, holderId);
    try {
        return await run();
    }
    finally {
        await handle.release();
    }
}
async function acquireFileLock(lockPath, holderId, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
    await mkdir(dirname(lockPath), { recursive: true });
    const started = Date.now();
    let backoff = LOCK_BACKOFF_START_MS;
    while (true) {
        let fileHandle = null;
        try {
            fileHandle = await open(lockPath, 'wx');
            const content = {
                schema_version: 'autopilot.lock.v1',
                holder_id: holderId,
                acquired_at: new Date().toISOString(),
                pid: process.pid,
                boot_id: getBootId(),
            };
            await fileHandle.writeFile(`${JSON.stringify(content)}\n`, 'utf8');
            await fileHandle.sync();
            await fileHandle.close();
            fileHandle = null;
            return {
                release: async () => {
                    const value = await readJson(lockPath);
                    if (!isRecord(value) || value['holder_id'] !== holderId) {
                        fail('foreign-lock-release', 'refusing to release a lock owned by another holder.', [lockPath]);
                    }
                    await unlink(lockPath);
                },
            };
        }
        catch (error) {
            if (fileHandle !== null)
                await fileHandle.close().catch(() => undefined);
            if (!isNodeError(error) || error.code !== 'EEXIST')
                throw error;
            await reclaimStaleLockIfEligible(lockPath, timeoutMs);
            if (Date.now() - started > timeoutMs) {
                fail('lock-timeout', 'timed out acquiring Autopilot runtime lock.', [lockPath, holderId]);
            }
            await sleep(backoff);
            backoff = Math.min(LOCK_BACKOFF_CAP_MS, backoff + LOCK_BACKOFF_STEP_MS);
        }
    }
}
async function reclaimStaleLockIfEligible(lockPath, timeoutMs) {
    let text;
    let stats;
    try {
        [text, stats] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT')
            return;
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        if (Date.now() - stats.mtimeMs > timeoutMs)
            await unlink(lockPath).catch(() => undefined);
        return;
    }
    if (!isRecord(parsed))
        return;
    const acquiredAtRaw = parsed['acquired_at'];
    const pidRaw = parsed['pid'];
    const bootIdRaw = parsed['boot_id'];
    if (typeof acquiredAtRaw !== 'string' || typeof pidRaw !== 'number' || typeof bootIdRaw !== 'string')
        return;
    const ageMs = Date.now() - Date.parse(acquiredAtRaw);
    if (!Number.isFinite(ageMs) || ageMs < timeoutMs * LOCK_STALE_MULTIPLIER)
        return;
    const currentBoot = getBootId();
    const stale = bootIdRaw !== currentBoot || !isPidAlive(pidRaw);
    if (stale)
        await unlink(lockPath).catch(() => undefined);
}
function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'EPERM')
            return true;
        return false;
    }
}
function getBootId() {
    if (platform() === 'linux') {
        try {
            const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
            if (value.length > 0)
                return `linux:${value}`;
        }
        catch {
            // fall through to deterministic boot-time estimate below
        }
    }
    if (platform() === 'darwin') {
        const result = spawnSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' });
        if (result.status === 0 && result.stdout.trim().length > 0) {
            return `darwin:${sha256Text(result.stdout.trim())}`;
        }
    }
    const bootMs = Math.floor(Date.now() - uptime() * 1000);
    return `boot-estimate:${hostname()}:${String(Math.floor(bootMs / 1000))}`;
}
async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch (error) {
        fail('json-read-failed', `failed to read JSON runtime file ${path}: ${errorMessage(error)}`);
    }
}
export async function writeJsonAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
}
export async function appendJsonl(path, value) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}
function buildWorkstreamRun(workstream, now) {
    const timestamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
    return `${workstream}-${timestamp}-${randomBytes(3).toString('hex')}`;
}
function buildReceiptId(kind) {
    return `${kind}-${new Date().toISOString().replace(/[-:.]/gu, '')}-${randomBytes(4).toString('hex')}`;
}
function isLiveParentStatus(status) {
    return status === 'active' || status === 'paused' || status === 'merging' || status === 'blocked';
}
function isChildLaunchParentStatus(status) {
    return status === 'active';
}
function realpathExisting(path, label) {
    try {
        return realpathSync(path);
    }
    catch (error) {
        fail('realpath-failed', `${label} is not an existing path: ${path}; ${errorMessage(error)}`);
    }
}
function normalizePath(path) {
    return resolve(path);
}
function isSamePath(left, right) {
    try {
        return realpathSync(left) === realpathSync(right);
    }
    catch {
        return normalizePath(left) === normalizePath(right);
    }
}
function sanitizeOriginUrl(value) {
    if (value.length === 0)
        return null;
    return value.replace(/(https?:\/\/)([^/@]+)@/u, '$1<redacted>@');
}
function sha256Text(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}
function sleep(ms) {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
function expectInteger(record, field) {
    const value = record[field];
    if (!Number.isInteger(value))
        fail('invalid-runtime-record', `field ${field} must be an integer.`);
    return value;
}
function expectConst(record, field, expected) {
    const value = record[field];
    if (value !== expected)
        fail('invalid-runtime-record', `field ${field} must equal ${expected}.`);
    return expected;
}
function expectOneOf(record, field, values) {
    const value = record[field];
    if (typeof value !== 'string' || !values.includes(value)) {
        fail('invalid-runtime-record', `field ${field} must be one of ${values.join(', ')}.`);
    }
    return value;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
