import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { link, mkdir, open, readdir, rm, unlink } from 'node:fs/promises';
import { platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AUTOPILOT_PREFLIGHT_ROLLBACK_REASON_PREFIX, AUTOPILOT_RUNTIME_ROOT_PREFIX } from "./names.js";
import { gitQueryText, runGitMutation, runGitQuery } from "./git-process.js";
import { readImmutableFileBytes } from "./coordination/immutable-file.js";
import { executeOwnedWorktreeSaga } from "./coordination/worktree-saga.js";
import { coordinationCutoverCommitted } from "./coordination/migration-paths.js";
import { BRANCHES_FILE, MATERIALIZED_PATHS_FILE, UNIT_INDEX_FILE, UNIT_INFO_FILE, WORKTREE_LEDGER_FILE, appendJsonl, readGitStatus, readUnitIndex, taskRootForActiveAutopilot, unitWorktreePathForActiveAutopilot, withAutopilotFileLock, writeJsonAtomic, writeUnitIndex, } from "./parallel-runtime.js";
const MAX_CLEANUP_EVIDENCE_BYTES = 1_048_576;
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
function sameCoordinationOwner(left, right) {
    return left.repo_id === right.repo_id
        && left.autopilot_id === right.autopilot_id
        && left.workstream_run === right.workstream_run
        && left.unit_id === right.unit_id
        && left.attempt === right.attempt;
}
function canonicalJson(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new AutopilotWorktreeCleanupError('rollback-supersession-evidence-invalid', 'worktree operation evidence contains a non-finite number.');
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
    if (typeof value !== 'object')
        throw new AutopilotWorktreeCleanupError('rollback-supersession-evidence-invalid', 'worktree operation evidence contains a non-JSON value.');
    const object = value;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
async function hasExactImmutableOperationEvidence(active, operation) {
    const evidence = operation.verification_evidence;
    const expectedRef = `_saga-evidence/${operation.owner.workstream_run}/${operation.operation_id}.json`;
    if (evidence === null || evidence.ref !== expectedRef || operation.completed_steps.length !== 3 || operation.completed_steps[0] !== 'preflight-probe' || operation.completed_steps[1] !== 'external-action' || operation.completed_steps[2] !== 'postcondition-verification' || operation.current_step !== null || operation.error_code !== null)
        return false;
    const evidencePath = resolve(active.worktree_root, ...evidence.ref.split('/'));
    const relativeEvidence = relative(resolve(active.worktree_root), evidencePath);
    if (relativeEvidence.length === 0 || relativeEvidence === '..' || relativeEvidence.startsWith(`..${sep}`) || isAbsolute(relativeEvidence) || !existsSync(evidencePath))
        return false;
    let bytes;
    try {
        bytes = readImmutableFileBytes({ path: evidencePath, maximumBytes: MAX_CLEANUP_EVIDENCE_BYTES, label: 'rollback supersession operation evidence' });
    }
    catch {
        return false;
    }
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== evidence.sha256)
        return false;
    let document;
    try {
        document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch {
        return false;
    }
    if (!isRecord(document))
        return false;
    const intentSha256 = `sha256:${createHash('sha256').update(canonicalJson(operation.intent), 'utf8').digest('hex')}`;
    return document['schema_version'] === 'autopilot.worktree_operation_evidence.v1'
        && document['operation_id'] === operation.operation_id
        && document['worktree_id'] === operation.worktree_id
        && document['operation_type'] === operation.operation_type
        && document['terminal_stage'] === 'verified'
        && document['intent_sha256'] === intentSha256
        && canonicalJson(document['owner']) === canonicalJson(operation.owner);
}
async function exactLaterPackageSupersession(input) {
    const reject = (blocker) => ({ later: null, blocker });
    const rollback = input.rollback;
    const later = input.operations
        .filter((operation) => operation.worktree_id === rollback.worktree_id && sameCoordinationOwner(operation.owner, rollback.owner) && operation.intent_event_seq > rollback.intent_event_seq)
        .sort((left, right) => left.intent_event_seq - right.intent_event_seq || left.operation_id.localeCompare(right.operation_id));
    if (later.some((operation) => operation.operation_type === 'metadata-reconcile'))
        return reject('later-operation-plan-contains-metadata-reconciliation');
    const ordinaryLater = later.filter((operation) => operation.operation_type !== 'metadata-reconcile');
    if (ordinaryLater.length < 4 || ordinaryLater.some((operation) => operation.stage !== 'committed'))
        return reject('later-operation-plan-not-exactly-committed');
    const recreate = ordinaryLater[0];
    const quarantine = ordinaryLater[ordinaryLater.length - 2];
    const archive = ordinaryLater[ordinaryLater.length - 1];
    const materializations = ordinaryLater.slice(1, -2);
    if (recreate === undefined || quarantine === undefined || archive === undefined
        || recreate.operation_type !== 'create'
        || materializations.length === 0
        || materializations.some((operation) => operation.operation_type !== 'materialize')
        || quarantine.operation_type !== 'quarantine'
        || archive.operation_type !== 'archive'
        || rollback.intent.target_sha === null
        || recreate.intent.base_sha !== rollback.intent.target_sha
        || archive.intent.target_sha === null
        || archive.intent.archive_ref === null
        || recreate.authority_version <= rollback.authority_version
        || ordinaryLater.some((operation, index) => index > 0 && operation.authority_version < (ordinaryLater[index - 1]?.authority_version ?? 0)))
        return reject('later-operation-shape-or-authority-order-invalid');
    const authorityMatches = ordinaryLater.every((operation) => operation.intent.repo_root === rollback.intent.repo_root
        && operation.intent.worktree_path === rollback.intent.worktree_path
        && operation.intent.git_common_dir === rollback.intent.git_common_dir
        && operation.intent.branch === rollback.intent.branch);
    if (!authorityMatches)
        return reject('later-operation-authority-drift');
    const matchingChildren = input.childLeases.filter((child) => child.owner.repo_id === rollback.owner.repo_id && child.owner.workstream_run === rollback.owner.workstream_run && child.owner.unit_id === rollback.owner.unit_id && child.owner.attempt === rollback.owner.attempt);
    const matchingAttempts = input.unitAttempts.filter((attempt) => sameCoordinationOwner(attempt.owner, rollback.owner));
    const matchingWorktrees = input.worktrees.filter((worktree) => worktree.worktree_id === rollback.worktree_id && worktree.owner.repo_id === rollback.owner.repo_id && worktree.owner.workstream_run === rollback.owner.workstream_run && worktree.owner.unit_id === rollback.owner.unit_id && worktree.owner.attempt === rollback.owner.attempt);
    const child = matchingChildren[0];
    const attempt = matchingAttempts[0];
    const worktree = matchingWorktrees[0];
    if (matchingChildren.length !== 1 || child === undefined || child.status !== 'recovery-required' || child.terminal_evidence !== null
        || matchingAttempts.length !== 1 || attempt === undefined || attempt.state !== 'quarantined'
        || matchingWorktrees.length !== 1 || worktree === undefined || worktree.kind !== 'unit' || worktree.state !== 'quarantined'
        || worktree.canonical_path !== rollback.intent.worktree_path || worktree.git_common_dir !== rollback.intent.git_common_dir || worktree.branch !== rollback.intent.branch
        || worktree.version !== archive.authority_version)
        return reject('durable-child-attempt-or-worktree-state-invalid');
    for (const operation of [rollback, ...ordinaryLater])
        if (!(await hasExactImmutableOperationEvidence(input.active, operation)))
            return reject(`immutable-operation-evidence-invalid:${operation.operation_type}`);
    const taskRoot = taskRootForActiveAutopilot(input.active);
    const index = await readUnitIndex(taskRoot);
    const branches = await readBranchesSnapshot(taskRoot);
    const indexed = index.units.filter((unit) => unit.unit_id === rollback.owner.unit_id && unit.attempt === rollback.owner.attempt);
    const branched = branches?.unitBranches.filter((unit) => unit.unit_id === rollback.owner.unit_id && unit.attempt === rollback.owner.attempt) ?? [];
    const indexUnit = indexed[0];
    const branchUnit = branched[0];
    if (indexed.length !== 1 || branched.length !== 1 || indexUnit === undefined || branchUnit === undefined)
        return reject('runtime-unit-projection-cardinality-invalid');
    assertMatchingUnitRows(indexUnit, branchUnit);
    if (indexUnit.status !== 'quarantined' || indexUnit.worktree_path !== worktree.canonical_path || indexUnit.branch !== worktree.branch || indexUnit.current_sha !== archive.intent.target_sha || indexUnit.archive_ref !== archive.intent.archive_ref)
        return reject('runtime-unit-projection-does-not-match-archive');
    if (!existsSync(worktree.canonical_path))
        return reject('quarantined-worktree-path-missing');
    const worktreeMetadata = lstatSync(worktree.canonical_path);
    if (!worktreeMetadata.isDirectory() || worktreeMetadata.isSymbolicLink())
        return reject('quarantined-worktree-path-type-invalid');
    const listed = gitWorktreeListPorcelain(input.active.source_repo, input.env).filter((entry) => samePath(entry.path, worktree.canonical_path));
    if (listed.length !== 1 || listed[0]?.branch !== worktree.branch || listed[0]?.prunable === true)
        return reject('git-worktree-registration-invalid');
    const commonRaw = gitQueryText({ descriptor: { kind: 'git-common-dir' }, cwd: worktree.canonical_path, env: runtimeGitEnv('rollback-supersession-common-dir', input.env) }).trim();
    const actualCommon = isAbsolute(commonRaw) ? commonRaw : resolve(worktree.canonical_path, commonRaw);
    if (!samePath(actualCommon, worktree.git_common_dir))
        return reject('git-common-dir-mismatch');
    if (gitQueryText({ descriptor: { kind: 'current-branch' }, cwd: worktree.canonical_path, env: runtimeGitEnv('rollback-supersession-branch', input.env) }).trim() !== worktree.branch)
        return reject('git-branch-mismatch');
    const head = gitQueryText({ descriptor: { kind: 'head' }, cwd: worktree.canonical_path, env: runtimeGitEnv('rollback-supersession-head', input.env) }).trim();
    if (head !== archive.intent.target_sha || readGitStatus(worktree.canonical_path).changedPaths.length > 0)
        return reject('quarantined-worktree-head-or-cleanliness-mismatch');
    if (gitQueryText({ descriptor: { kind: 'resolve-revision', revision: `refs/heads/${archive.intent.archive_ref}`, verify: true }, cwd: input.active.source_repo, env: runtimeGitEnv('rollback-supersession-archive', input.env) }).trim() !== archive.intent.target_sha)
        return reject('archive-ref-mismatch');
    return { later: Object.freeze(ordinaryLater), blocker: null };
}
function assertExactRollbackAudit(path, body, conflictMessage) {
    let actual;
    try {
        actual = new TextDecoder('utf-8', { fatal: true }).decode(readImmutableFileBytes({ path, maximumBytes: MAX_CLEANUP_EVIDENCE_BYTES, label: 'rollback supersession audit' }));
    }
    catch (error) {
        fail('rollback-supersession-audit-invalid', 'immutable rollback supersession audit could not be inspected safely.', [path, errorMessage(error)]);
    }
    if (actual !== body)
        fail('rollback-supersession-audit-conflict', conflictMessage, [path]);
}
function assertNoSymlinkPath(root, target, label) {
    assertPathWithinRoot(root, target, 'rollback-supersession-audit-outside-state');
    let cursor = resolve(root);
    if (!existsSync(cursor) || lstatSync(cursor).isSymbolicLink() || !lstatSync(cursor).isDirectory())
        fail('rollback-supersession-audit-root-invalid', `${label} root must be an existing non-symbolic directory.`, [cursor]);
    for (const segment of relative(cursor, resolve(target)).split(sep).filter((entry) => entry.length > 0)) {
        cursor = join(cursor, segment);
        if (existsSync(cursor) && (lstatSync(cursor).isSymbolicLink() || (!lstatSync(cursor).isDirectory() && cursor !== resolve(target))))
            fail('rollback-supersession-audit-path-invalid', `${label} contains a symbolic or non-directory ancestor.`, [cursor]);
    }
}
async function publishRollbackSupersessionAudit(active, rollback, later) {
    const archive = later[later.length - 1];
    if (archive === undefined || archive.operation_type !== 'archive' || archive.intent.archive_ref === null || archive.intent.target_sha === null)
        fail('rollback-supersession-audit-invalid', 'exact rollback supersession lost its terminal archive identity.');
    const auditRoot = resolve(active.worktree_root, '_saga-evidence', active.workstream_run, 'supersessions');
    const auditPath = resolve(auditRoot, `${rollback.operation_id}.json`);
    assertNoSymlinkPath(active.worktree_root, auditRoot, 'rollback supersession audit');
    await mkdir(auditRoot, { recursive: true, mode: 0o700 });
    assertNoSymlinkPath(active.worktree_root, auditPath, 'rollback supersession audit');
    const body = `${canonicalJson({
        schema_version: 'autopilot.worktree_rollback_supersession.v1',
        owner: rollback.owner,
        worktree_id: rollback.worktree_id,
        superseded_operation: { operation_id: rollback.operation_id, intent_event_seq: rollback.intent_event_seq, verification_evidence: rollback.verification_evidence },
        later_package_operations: later.map((operation) => ({ operation_id: operation.operation_id, operation_type: operation.operation_type, intent_event_seq: operation.intent_event_seq, verification_evidence: operation.verification_evidence })),
        terminal_archive: { archive_ref: archive.intent.archive_ref, target_sha: archive.intent.target_sha },
        disposition: 'historical-preflight-rollback-superseded-by-exact-later-package-quarantine',
    })}\n`;
    if (Buffer.byteLength(body, 'utf8') > MAX_CLEANUP_EVIDENCE_BYTES)
        fail('rollback-supersession-audit-invalid', 'rollback supersession audit exceeds its immutable byte ceiling.', [auditPath]);
    if (existsSync(auditPath)) {
        assertExactRollbackAudit(auditPath, body, 'immutable rollback supersession audit differs from the proven package history.');
        return;
    }
    const temporary = `${auditPath}.tmp-${String(process.pid)}-${randomBytes(8).toString('hex')}`;
    let handle = null;
    try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(body, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        try {
            await link(temporary, auditPath);
        }
        catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
                throw error;
            assertExactRollbackAudit(auditPath, body, 'concurrent rollback supersession audit differs from the proven package history.');
        }
        if (platform() !== 'win32') {
            const directory = await open(auditRoot, 'r');
            try {
                await directory.sync();
            }
            finally {
                await directory.close();
            }
        }
    }
    finally {
        if (handle !== null)
            await handle.close();
        await unlink(temporary).catch((error) => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
            throw error; });
    }
}
export async function recoverCommittedPreflightRollbackProjections(input) {
    return await withCleanupLock(input.active, async () => {
        const recovered = [];
        const taskRoot = taskRootForActiveAutopilot(input.active);
        for (const operation of input.operations) {
            if (operation.stage !== 'committed' || operation.operation_type !== 'remove' || operation.owner.unit_id === 'main' || !operation.intent.reason.startsWith(AUTOPILOT_PREFLIGHT_ROLLBACK_REASON_PREFIX))
                continue;
            if (operation.owner.repo_id !== input.active.repo_key || operation.owner.autopilot_id !== input.active.autopilot_id || operation.owner.workstream_run !== input.active.workstream_run)
                fail('rollback-recovery-owner-mismatch', 'committed preflight rollback operation does not belong to the active run.', [operation.operation_id]);
            if (input.childLeases.some((child) => child.owner.repo_id === operation.owner.repo_id && child.owner.workstream_run === operation.owner.workstream_run && child.owner.unit_id === operation.owner.unit_id && child.owner.attempt === operation.owner.attempt)) {
                const supersession = await exactLaterPackageSupersession({ active: input.active, rollback: operation, operations: input.operations, childLeases: input.childLeases, unitAttempts: input.unitAttempts, worktrees: input.worktrees, ...(input.env === undefined ? {} : { env: input.env }) });
                if (supersession.later !== null) {
                    await publishRollbackSupersessionAudit(input.active, operation, supersession.later);
                    recovered.push(operation.operation_id);
                    continue;
                }
                fail('rollback-recovery-child-exists', 'preflight rollback projection cannot retire metadata for an attempt that launched a child without an exact later package-owned supersession chain.', [operation.operation_id, operation.owner.unit_id, String(operation.owner.attempt), `supersession_blocker=${supersession.blocker ?? 'unknown'}`]);
            }
            const expectedPath = unitWorktreePathForActiveAutopilot(input.active, operation.owner.unit_id, operation.owner.attempt);
            const expectedBranch = `autopilot/unit/${input.active.workstream_run}/${operation.owner.unit_id}/attempt-${String(operation.owner.attempt)}`;
            if (operation.intent.worktree_path !== expectedPath || operation.intent.branch !== expectedBranch || operation.intent.target_sha === null)
                fail('rollback-recovery-authority-mismatch', 'preflight rollback operation disagrees with deterministic unit authority.', [operation.operation_id]);
            const registered = gitWorktreeListPorcelain(input.active.source_repo, input.env).some((entry) => samePath(entry.path, expectedPath));
            if (existsSync(expectedPath) || registered || branchExists(input.active.source_repo, expectedBranch, input.env))
                fail('rollback-recovery-external-effect-incomplete', 'committed preflight rollback cannot project metadata while its worktree or branch remains.', [operation.operation_id, `path_present=${String(existsSync(expectedPath))}`, `git_registered=${String(registered)}`]);
            const index = await readUnitIndex(taskRoot);
            const indexed = index.units.find((unit) => unit.unit_id === operation.owner.unit_id && unit.attempt === operation.owner.attempt);
            const branches = await readBranchesSnapshot(taskRoot);
            const branched = branches?.unitBranches.find((unit) => unit.unit_id === operation.owner.unit_id && unit.attempt === operation.owner.attempt);
            for (const candidate of [indexed, branched]) {
                if (candidate === undefined)
                    continue;
                if (candidate.worktree_path !== expectedPath || candidate.branch !== expectedBranch || candidate.current_sha !== operation.intent.target_sha || candidate.status !== 'active')
                    fail('rollback-recovery-projection-mismatch', 'preflight rollback metadata disagrees with the committed remove authority.', [operation.operation_id, candidate.unit_id, String(candidate.attempt), candidate.status]);
            }
            const attemptRoot = dirname(expectedPath);
            if (indexed === undefined && branched === undefined && !existsSync(attemptRoot))
                continue;
            const unit = indexed ?? branched ?? {
                unit_id: operation.owner.unit_id, attempt: operation.owner.attempt, branch: expectedBranch, worktree_path: expectedPath,
                base_sha: operation.intent.base_sha ?? operation.intent.target_sha, current_sha: operation.intent.target_sha, archive_ref: operation.intent.archive_ref, status: 'active',
            };
            const now = input.now ?? new Date();
            await removeUnitMetadataForRollback(input.active, unit, now, operation.intent.reason);
            await removeUnitAttemptRootAfterRollback(input.active, unit, now, operation.intent.reason);
            recovered.push(operation.operation_id);
        }
        return Object.freeze(recovered);
    });
}
export async function cleanupClosedAutopilotRun(input) {
    return await withCleanupLock(input.active, async () => {
        const now = input.now ?? new Date();
        const acc = emptyAccumulator();
        const units = await loadScopedUnitRows(input.active);
        await executeOwnedWorktreeSaga({
            active: input.active, unitId: 'main', attempt: 1, kind: 'main', operationType: 'archive',
            initialWorktreeState: 'active', committedWorktreeState: 'terminal',
            intent: {
                repo_root: input.active.source_repo, worktree_path: input.active.main_worktree_path, git_common_dir: input.active.git_common_dir,
                branch: input.active.branch, reason: input.reason, base_sha: input.active.target_base_sha, target_sha: input.archiveSha,
                archive_ref: input.archiveRef, checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [`_archive/${input.active.workstream_run}`],
            },
        }, {
            action: async () => { await runGitMutation({ descriptor: { kind: 'update-ref-create', ref: `refs/heads/${input.archiveRef}`, target: input.archiveSha, expectedOld: '0'.repeat(40) }, cwd: input.active.source_repo, env: runtimeGitEnv('worktree-cleanup-archive-ref', input.env) }); },
        }, input.env ?? process.env);
        await input.observeTerminalBoundary?.('after-archive-ref');
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
            await input.observeTerminalBoundary?.('after-unit-cleanup');
        }
        await removeMainWorktree(input.active, units, acc, input.archiveSha, input.reason, now, input.env, input.removeActiveTaskDir);
        await retireBranchIfPresent(input.active, input.active.branch, input.archiveSha, acc, 'closed-run-cleanup', input.reason, now, input.env);
        await pruneGitMetadataAfterProof(input.active, acc, 'closed-run-cleanup', input.reason, now, input.env);
        const runOwnedWorktreePaths = [input.active.main_worktree_path, ...units.map((unit) => unit.worktree_path)];
        verifyNoPathResidue(input.active.source_repo, runOwnedWorktreePaths, input.env);
        verifyNoPathResidue(input.active.source_repo, runOwnedWorktreePaths, input.env);
        if (input.removeActiveTaskDir && existsSync(taskRootForActiveAutopilot(input.active)))
            fail('active-task-dir-remains', 'active task directory still exists after closed-run cleanup.', [taskRootForActiveAutopilot(input.active)]);
        await input.observeTerminalBoundary?.('after-main-cleanup');
        return cleanupResult(input.active, 'closed-run-cleanup', acc, now);
    });
}
export function gitWorktreeListPorcelain(repoRoot, env = process.env) {
    const output = gitQueryText({ descriptor: { kind: 'worktree-list' }, cwd: repoRoot, env: runtimeGitEnv('worktree-cleanup-list', env) });
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
        dirtyBlockMessage: 'refusing to remove dirty terminal unit worktree; owned reset, abort, or quarantine recovery is required.',
    });
    if (input.retireBranch)
        await retireBranchIfPresent(active, unit.branch, unit.current_sha, acc, input.mode, input.reason, input.now, input.env, unit);
}
async function removeRegisteredWorktree(active, worktreePath, acc, input) {
    const unit = input.unit;
    if (unit === undefined)
        fail('unit-cleanup-owner-missing', 'unit worktree removal requires exact unit ownership metadata.', [worktreePath]);
    const listedBefore = gitWorktreeListPorcelain(active.source_repo, input.env);
    const registeredBefore = listedBefore.some((entry) => samePath(entry.path, worktreePath));
    if (!existsSync(worktreePath)) {
        if (registeredBefore) {
            await appendLedger(active, {
                mode: input.mode, event: 'worktree-cleanup-blocked', reason: input.reason, now: input.now, path: worktreePath,
                ...ledgerUnitFields(unit), blockers: ['path-missing registration requires schema-13 approved metadata-reconcile; destructive remove is forbidden'],
            });
            fail('metadata-reconcile-approval-required', 'path-missing Git registration must use the schema-13 exact-set metadata reconciliation runtime.', [worktreePath, unit.branch]);
        }
        acc.reconciledMissingPaths.push(worktreePath);
        await appendLedger(active, {
            mode: input.mode, event: 'worktree-missing-reconcile', reason: input.reason, now: input.now, path: worktreePath,
            ...ledgerUnitFields(unit), proof: ['git_metadata_absent_before_remove_replay'],
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
    await executeOwnedWorktreeSaga({
        active, unitId: unit.unit_id, attempt: unit.attempt, kind: 'unit', operationType: 'remove',
        initialWorktreeState: 'terminal', committedWorktreeState: 'removed',
        intent: {
            repo_root: active.source_repo, worktree_path: worktreePath, git_common_dir: active.git_common_dir, branch: unit.branch,
            reason: input.reason, base_sha: unit.base_sha, target_sha: unit.current_sha, archive_ref: unit.archive_ref,
            checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [],
        },
    }, {
        action: async () => {
            if (existsSync(worktreePath) || gitWorktreeListPorcelain(active.source_repo, input.env).some((entry) => samePath(entry.path, worktreePath)))
                await runGitMutation({ descriptor: { kind: 'worktree-remove', path: worktreePath }, cwd: active.source_repo, env: runtimeGitEnv('worktree-cleanup-remove', input.env) });
            if (branchExists(active.source_repo, unit.branch, input.env)) {
                const actualBranchSha = gitQueryText({ descriptor: { kind: 'resolve-revision', revision: `refs/heads/${unit.branch}`, verify: true }, cwd: active.source_repo, env: runtimeGitEnv('worktree-cleanup-branch-head', input.env) }).trim();
                if (actualBranchSha !== unit.current_sha)
                    fail('branch-retire-sha-mismatch', 'owned branch moved after cleanup intent; refusing retirement.', [unit.branch, `expected=${unit.current_sha}`, `actual=${actualBranchSha}`]);
                await runGitMutation({ descriptor: { kind: 'update-ref-delete', ref: `refs/heads/${unit.branch}`, expectedOld: unit.current_sha }, cwd: active.source_repo, env: runtimeGitEnv('worktree-cleanup-branch-retire', input.env) });
            }
        },
    }, input.env ?? process.env);
    if (existsSync(worktreePath))
        fail('worktree-remove-incomplete', 'worktree remove saga committed but the path still exists.', [worktreePath]);
    acc.removedPaths.push(worktreePath);
    if (!acc.retiredBranches.includes(unit.branch))
        acc.retiredBranches.push(unit.branch);
    await appendLedger(active, {
        mode: input.mode, event: 'worktree-remove', reason: input.reason, now: input.now, path: worktreePath,
        ...ledgerUnitFields(unit), proof: ['saga_committed', 'git_worktree_remove_succeeded_or_already_absent', 'branch_absent', 'path_absent_after_remove'],
    });
}
async function removeMainWorktree(active, units, acc, expectedSha, reason, now, env, removeActiveTaskDir = false) {
    assertActiveRowScope(active);
    const mainPath = active.main_worktree_path;
    const listedBefore = gitWorktreeListPorcelain(active.source_repo, env);
    const registeredBefore = listedBefore.some((entry) => samePath(entry.path, mainPath));
    if (!existsSync(mainPath)) {
        if (registeredBefore) {
            await appendLedger(active, {
                mode: 'closed-run-cleanup', event: 'main-worktree-cleanup-blocked', reason, now, path: mainPath, branch: active.branch,
                blockers: ['path-missing registration requires schema-13 approved metadata-reconcile; destructive remove is forbidden'],
            });
            fail('metadata-reconcile-approval-required', 'path-missing main Git registration must use the schema-13 exact-set metadata reconciliation runtime.', [mainPath, active.branch]);
        }
        acc.reconciledMissingPaths.push(mainPath);
        await appendLedger(active, {
            mode: 'closed-run-cleanup', event: 'main-worktree-missing-reconcile', reason, now, path: mainPath, branch: active.branch,
            proof: ['git_metadata_absent_before_remove_replay'],
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
    if (removeActiveTaskDir && !existsSync(mainPath) && !registeredBefore && !branchExists(active.source_repo, active.branch, env) && existsSync(taskRootForActiveAutopilot(active))) {
        await removeActiveTaskDirectory(active, units, acc, reason, now, env);
    }
    await executeOwnedWorktreeSaga({
        active, unitId: 'main', attempt: 1, kind: 'main', operationType: 'remove',
        initialWorktreeState: 'terminal', committedWorktreeState: 'removed',
        intent: {
            repo_root: active.source_repo, worktree_path: mainPath, git_common_dir: active.git_common_dir, branch: active.branch,
            reason, base_sha: active.target_base_sha, target_sha: expectedSha, archive_ref: null, checkout_mode: null,
            sparse_patterns: [], paths: [`${AUTOPILOT_RUNTIME_ROOT_PREFIX}/${active.workstream}`], metadata_refs: [`_archive/${active.workstream_run}`],
        },
    }, {
        action: async () => {
            await removeArchivedRuntimeResidue(active, reason, now);
            if (existsSync(mainPath) || gitWorktreeListPorcelain(active.source_repo, env).some((entry) => samePath(entry.path, mainPath)))
                await runGitMutation({ descriptor: { kind: 'worktree-remove', path: mainPath }, cwd: active.source_repo, env: runtimeGitEnv('worktree-cleanup-remove-main', env) });
            if (branchExists(active.source_repo, active.branch, env)) {
                const actualBranchSha = gitQueryText({ descriptor: { kind: 'resolve-revision', revision: `refs/heads/${active.branch}`, verify: true }, cwd: active.source_repo, env: runtimeGitEnv('worktree-cleanup-branch-head', env) }).trim();
                if (actualBranchSha !== expectedSha)
                    fail('branch-retire-sha-mismatch', 'main branch moved after cleanup intent; refusing retirement.', [active.branch, `expected=${expectedSha}`, `actual=${actualBranchSha}`]);
                await runGitMutation({ descriptor: { kind: 'update-ref-delete', ref: `refs/heads/${active.branch}`, expectedOld: expectedSha }, cwd: active.source_repo, env: runtimeGitEnv('worktree-cleanup-branch-retire', env) });
            }
            if (removeActiveTaskDir)
                await removeActiveTaskDirectory(active, units, acc, reason, now, env);
        },
        finalize: () => {
            if (removeActiveTaskDir && existsSync(taskRootForActiveAutopilot(active)))
                fail('active-task-dir-remains', 'main remove saga cannot commit while active task metadata remains.', [taskRootForActiveAutopilot(active)]);
        },
    }, env ?? process.env);
    if (existsSync(mainPath))
        fail('main-worktree-remove-incomplete', 'main worktree remove saga committed but the main path still exists.', [mainPath]);
    acc.removedPaths.push(mainPath);
    if (!acc.retiredBranches.includes(active.branch))
        acc.retiredBranches.push(active.branch);
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
function branchExists(repoRoot, branch, env) {
    return !runGitQuery({ descriptor: { kind: 'ref-exists', ref: `refs/heads/${branch}` }, cwd: repoRoot, env: runtimeGitEnv('worktree-cleanup-branch-check', env) }).negative;
}
async function retireBranchIfPresent(active, branch, expectedSha, acc, mode, reason, now, env, unit) {
    const existed = branchExists(active.source_repo, branch, env);
    if (existed) {
        const actualSha = gitQueryText({ descriptor: { kind: 'resolve-revision', revision: `refs/heads/${branch}`, verify: true }, cwd: active.source_repo, env: runtimeGitEnv('worktree-cleanup-branch-head', env) }).trim();
        if (actualSha !== expectedSha)
            fail('branch-retire-sha-mismatch', 'owned branch moved before retirement; refusing deletion.', [branch, `expected=${expectedSha}`, `actual=${actualSha}`]);
        await runGitMutation({ descriptor: { kind: 'update-ref-delete', ref: `refs/heads/${branch}`, expectedOld: expectedSha }, cwd: active.source_repo, env: runtimeGitEnv('worktree-cleanup-branch-retire', env) });
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
async function pruneGitMetadataAfterProof(active, acc, mode, reason, now, env) {
    const proofPaths = sortedUnique([...acc.removedPaths, ...acc.reconciledMissingPaths]);
    if (proofPaths.length === 0)
        return;
    const remaining = gitWorktreeListPorcelain(active.source_repo, env).filter((entry) => proofPaths.some((path) => samePath(entry.path, path)));
    if (remaining.length > 0)
        fail('git-worktree-metadata-remains', 'owned worktree metadata remains after exact path removal; refusing global prune that could mutate foreign runs.', remaining.map((entry) => entry.path));
    acc.prunedGitMetadata = true;
    await appendLedger(active, {
        mode,
        event: 'git-worktree-metadata-verified',
        reason,
        now,
        proof: proofPaths.map((path) => `run_owned_path_absent=${path}`),
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
    const taskRoot = taskRootForActiveAutopilot(active);
    const attemptRoot = dirname(unit.worktree_path);
    assertPathWithinRoot(taskRoot, attemptRoot, 'rollback-attempt-root-outside-run');
    if (!existsSync(attemptRoot))
        return;
    const taskMetadata = lstatSync(taskRoot);
    if (taskMetadata.isSymbolicLink() || !taskMetadata.isDirectory())
        fail('rollback-task-root-substitution', 'preflight rollback refuses a symbolic or non-directory task root.', [taskRoot]);
    let cursor = taskRoot;
    const segments = relative(taskRoot, attemptRoot).split(sep).filter((segment) => segment.length > 0);
    for (const segment of segments) {
        cursor = join(cursor, segment);
        const metadata = lstatSync(cursor);
        if (metadata.isSymbolicLink() || !metadata.isDirectory())
            fail('rollback-attempt-root-substitution', 'preflight rollback refuses a symbolic or non-directory attempt-root ancestor.', [cursor]);
    }
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
    const rootFiles = new Set(['_task-info.json', BRANCHES_FILE, UNIT_INDEX_FILE, '_checkout-profile.json', '_materialization-ledger.jsonl', MATERIALIZED_PATHS_FILE]);
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
        const bytes = readImmutableFileBytes({ path, maximumBytes: MAX_CLEANUP_EVIDENCE_BYTES, label: 'worktree cleanup branches snapshot' });
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
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
    if (!coordinationCutoverCommitted(dirname(dirname(active.worktree_root)), active.repo_key))
        await appendJsonl(join(active.worktree_root, WORKTREE_LEDGER_FILE), row);
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
    let cursor = resolve(path);
    const missingSegments = [];
    while (!existsSync(cursor)) {
        const parent = dirname(cursor);
        if (parent === cursor)
            return resolve(path);
        missingSegments.unshift(basename(cursor));
        cursor = parent;
    }
    try {
        return resolve(realpathSync(cursor), ...missingSegments);
    }
    catch {
        return resolve(path);
    }
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
