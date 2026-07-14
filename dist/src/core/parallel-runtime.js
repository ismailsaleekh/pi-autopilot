import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, hostname, platform, uptime } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { authorityCandidatesForSpec, deriveAutopilotAuthority } from "./authority.js";
import { AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE, checkoutProfileSnapshotFromResolved, parseCheckoutProfileSnapshot, readCheckoutProfileSnapshot, resolveAutopilotCheckoutProfile, sparseIncludePatternsForPaths, } from "./checkout-profile.js";
import { assertAutopilotDiskGate } from "./disk-gate.js";
import { applySparseCheckoutSet, createAutopilotGitWorktree, isSparseCheckoutEnabled } from "./sparse-worktree.js";
import { cleanupTerminalUnitWorktreesForRun } from "./worktree-cleanup.js";
import { executeOwnedWorktreeSaga, OwnedWorktreeSagaClient, recoverOwnedWorktreeSagas } from "./coordination/worktree-saga.js";
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV, AUTOPILOT_RUNTIME_ROOT_PREFIX } from "./names.js";
import { isValidWorkstreamSlug } from "./paths.js";
import { parseLegacyActiveAutopilots, parseLegacyPathClaims, runLegacyCoordinationPreflight } from "./coordination/legacy-preflight.js";
import { DurableRunSupervisorClient } from "./coordination/supervisor.js";
import { CoordinatorClient } from "./coordination/client.js";
import { parseCoordinationRun, parseCoordinationRunResource, parseCoordinationWorktreeOperation } from "./coordination/contracts.js";
import { assertCoordinationDispatchAllowed, assertLegacyCoordinationWritable, coordinationCutoverCommitted } from "./coordination/migration-paths.js";
import { enforcePrivateAuthorityPath, ensurePrivateAuthorityDirectory } from "./private-path.js";
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
export const UNIT_INDEX_FILE = '_unit-index.json';
export const UNIT_INFO_FILE = '_unit-info.json';
export const MATERIALIZED_PATHS_FILE = '_materialized-paths.json';
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
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
export function unitWorktreePathForActiveAutopilot(row, unitId, attempt) {
    return join(taskRootForActiveAutopilot(row), 'units', unitId, `attempt-${String(attempt)}`, 'worktree');
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
    const cutover = coordinationCutoverCommitted(resolveAutopilotStateRoot(env), repo.repoKey);
    const activationLock = cutover ? join(worktreeRoot, '.locks', 'activation.lock') : join(coordinationRoot, '.locks', 'activation.lock');
    await ensurePrivateAuthorityDirectory(dirname(activationLock), env);
    return await withAutopilotFileLock(activationLock, `activation:${repo.repoKey}`, async () => {
        if (cutover && input.coordinationSessionId === undefined)
            fail('coordinator-session-required', 'post-cutover activation requires a durable coordinator session before worktree mutation.', [repo.repoKey]);
        if (cutover && input.coordinationSessionId !== undefined) {
            await assertCoordinatorMigrationRecoveryCleared(repo, input.workstream, env);
            const { recoverAutopilotTerminalCleanup } = await import("./close-runtime.js");
            await recoverAutopilotTerminalCleanup({ workstream: input.workstream, sourceCwd: input.sourceCwd, coordinationSessionId: input.coordinationSessionId, env, now });
        }
        assertCoordinationDispatchAllowed(resolveAutopilotStateRoot(env), repo.repoKey, 'Autopilot activation/new dispatch');
        if (!cutover) {
            assertLegacyCoordinationWritable(resolveAutopilotStateRoot(env), repo.repoKey, 'Autopilot activation/new dispatch');
            await withAutopilotFileLock(join(coordinationRoot, '.locks', 'path-claims.lock'), `activation-preflight:${repo.repoKey}`, async () => {
                await runLegacyCoordinationPreflight({
                    coordinationRoot,
                    repoKey: repo.repoKey,
                    mode: 'activation',
                    activationWorkstream: input.workstream,
                    currentPid: process.pid,
                    currentBootId: getBootId(),
                    now,
                });
            });
            await ensureRepoRuntimeFiles(coordinationRoot, worktreeRoot);
        }
        else {
            await ensurePrivateAuthorityDirectory(join(worktreeRoot, 'active'), env);
            await ensurePrivateAuthorityDirectory(join(worktreeRoot, '_archive'), env);
        }
        const activeRows = cutover ? await readCoordinatorActiveAutopilots(repo, worktreeRoot, env) : await readActiveAutopilots(coordinationRoot);
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
            if (!cutover)
                await writeActiveAutopilots(coordinationRoot, nextRows);
            await updateTaskInfoStatus(resumed, 'active');
            const bootstrapResidue = join(dirname(resumed.main_worktree_path), '_bootstrap-create.json');
            if (existsSync(bootstrapResidue)) {
                const required = [resumed.main_worktree_path, join(dirname(resumed.main_worktree_path), TASK_INFO_FILE), join(dirname(resumed.main_worktree_path), BRANCHES_FILE), join(dirname(resumed.main_worktree_path), UNIT_INDEX_FILE), join(dirname(resumed.main_worktree_path), AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE)];
                const missing = required.filter((path) => !existsSync(path));
                if (missing.length > 0) {
                    if (cutover && input.coordinationSessionId !== undefined) {
                        const recovered = await recoverCoordinatorBootstrapWorkstream({ workstream: input.workstream, repo, coordinationRoot, worktreeRoot, activeRows: activeRows.filter((candidate) => candidate.workstream_run !== row.workstream_run), now, env, coordinationSessionId: input.coordinationSessionId });
                        if (recovered !== null)
                            return recovered;
                    }
                    fail('bootstrap-finalization-incomplete', 'bootstrap residue cannot be cleared until every main worktree metadata postcondition exists.', missing);
                }
                await rm(bootstrapResidue, { force: false });
            }
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
        if (input.coordinationSessionId !== undefined) {
            const recovered = await recoverCoordinatorBootstrapWorkstream({
                workstream: input.workstream, repo, coordinationRoot, worktreeRoot, activeRows, now, env,
                coordinationSessionId: input.coordinationSessionId,
            });
            if (recovered !== null)
                return recovered;
        }
        const created = await createNewWorkstream({
            workstream: input.workstream,
            repo,
            coordinationRoot,
            worktreeRoot,
            activeRows,
            now,
            env,
            ...(input.coordinationSessionId === undefined ? {} : { coordinationSessionId: input.coordinationSessionId }),
        });
        return created;
    });
}
export async function prepareAutopilotUnitWorktree(input) {
    const env = input.env ?? process.env;
    const now = input.now ?? new Date();
    const taskRoot = taskRootForActiveAutopilot(input.active);
    const unitWorktreePath = unitWorktreePathForActiveAutopilot(input.active, input.unitId, input.attempt);
    const unitAttemptRoot = dirname(unitWorktreePath);
    const branch = `autopilot/unit/${input.active.workstream_run}/${input.unitId}/attempt-${String(input.attempt)}`;
    const lockPath = join(taskRoot, '.locks', 'unit-worktrees.lock');
    return await withAutopilotFileLock(lockPath, `unit-worktree:${input.active.autopilot_id}:${input.unitId}:${String(input.attempt)}`, async () => {
        const existing = await readUnitIndex(taskRoot);
        const found = existing.units.find((unit) => unit.unit_id === input.unitId && unit.attempt === input.attempt);
        if (found !== undefined) {
            if (!isSamePath(found.worktree_path, unitWorktreePath))
                fail('unit-worktree-projection-mismatch', 'unit index path disagrees with its deterministic run-owned worktree path.', [found.worktree_path, unitWorktreePath]);
            const infoPath = unitInfoPathForBranch(taskRoot, found);
            const info = existsSync(infoPath) ? parseUnitInfo(JSON.parse(await readFile(infoPath, 'utf8'))) : unitInfoFromBranch(input.active, found, now);
            return { unitInfo: info, created: false, resumed: true };
        }
        await cleanupTerminalUnitWorktreesForRun({ active: input.active, reason: 'prepare unit worktree pre-create cleanup', env, now });
        const checkout = await checkoutMetadataForTaskRoot(taskRoot);
        const unitClaimPaths = input.unitSpec === undefined ? [] : materializationPathsForCheckoutBootstrap(input.unitSpec);
        const sparsePatterns = checkout.mode === 'full' || checkout.mode === 'legacy-full'
            ? []
            : sortedUnique([...checkout.basePatterns, ...sparseIncludePatternsForPaths(unitClaimPaths)]);
        assertAutopilotDiskGate({
            path: input.active.worktree_root,
            projection: {
                profileMode: checkout.mode === 'legacy-full' ? 'full' : checkout.mode,
                diskGate: checkout.diskGate,
                perWorktreeEstimateBytes: checkout.perWorktreeEstimateBytes,
                additionalMaterializationBytes: 0,
                worktreeCount: 1,
            },
        });
        const baseSha = gitHead(input.active.main_worktree_path);
        const unitInfo = {
            schema_version: 'autopilot.unit_info.v1',
            workstream: input.active.workstream,
            workstream_run: input.active.workstream_run,
            autopilot_id: input.active.autopilot_id,
            unit_id: input.unitId,
            attempt: input.attempt,
            branch,
            worktree_path: unitWorktreePath,
            base_sha: baseSha,
            current_sha: baseSha,
            archive_ref: null,
            status: 'active',
            runtime_root: input.active.runtime_root,
            created_at: now.toISOString(),
            checkout_mode: checkout.mode === 'legacy-full' ? 'legacy-full' : checkout.mode === 'full' ? 'full' : 'sparse',
            checkout_profile_ref: checkout.checkoutProfileRef,
            materialized_paths_ref: MATERIALIZED_PATHS_FILE,
        };
        const branchInfo = branchInfoFromUnitInfo(unitInfo);
        const metadataRefs = [
            relative(taskRoot, join(unitAttemptRoot, UNIT_INFO_FILE)).replace(/\\/gu, '/'),
            UNIT_INDEX_FILE,
            BRANCHES_FILE,
        ];
        await executeOwnedWorktreeSaga({
            active: input.active,
            unitId: input.unitId,
            attempt: input.attempt,
            kind: 'unit',
            operationType: 'create',
            operationKey: `unit-create:${input.unitId}:${String(input.attempt)}:${baseSha}`,
            initialWorktreeState: 'planned',
            committedWorktreeState: 'active',
            intent: {
                repo_root: input.active.source_repo,
                worktree_path: unitWorktreePath,
                git_common_dir: input.active.git_common_dir,
                branch,
                reason: 'prepare source-changing unit worktree',
                base_sha: baseSha,
                target_sha: null,
                archive_ref: null,
                checkout_mode: checkout.mode === 'legacy-full' ? 'full' : checkout.mode,
                sparse_patterns: sparsePatterns,
                paths: unitClaimPaths,
                metadata_refs: metadataRefs,
            },
        }, {
            inspect: () => {
                if (!existsSync(unitWorktreePath))
                    return { outcome: 'not-applied', proof: ['unit_worktree_absent'] };
                const actualBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], unitWorktreePath, env).trim();
                if (actualBranch !== branch)
                    return { outcome: 'unsafe', proof: [`expected_branch=${branch}`, `actual_branch=${actualBranch}`] };
                if (checkout.mode !== 'legacy-full' && checkout.mode !== 'full' && !isSparseCheckoutEnabled(unitWorktreePath, env))
                    return { outcome: 'not-applied', proof: ['unit_worktree_registered', 'sparse_configuration_incomplete'] };
                const metadataComplete = existsSync(join(unitAttemptRoot, UNIT_INFO_FILE)) && existsSync(join(taskRoot, UNIT_INDEX_FILE)) && existsSync(join(taskRoot, BRANCHES_FILE));
                return metadataComplete ? { outcome: 'satisfied', proof: ['unit_worktree_registered', 'unit_metadata_complete'] } : { outcome: 'not-applied', proof: ['unit_worktree_registered', 'unit_metadata_incomplete'] };
            },
            action: async () => {
                if (existsSync(unitAttemptRoot) && !existsSync(unitWorktreePath) && (await readdir(unitAttemptRoot, { withFileTypes: true })).length > 0)
                    fail('unit-worktree-path-exists', 'unit attempt path contains unrelated residue before recoverable worktree creation.', [unitAttemptRoot]);
                await mkdir(unitAttemptRoot, { recursive: true });
                if (!existsSync(unitWorktreePath)) {
                    createAutopilotGitWorktree({
                        repoRoot: input.active.source_repo,
                        worktreePath: unitWorktreePath,
                        branch,
                        startPoint: baseSha,
                        mode: checkout.mode === 'legacy-full' ? 'full' : checkout.mode,
                        sparsePatterns,
                        env: { ...env, [AUTOPILOT_RUNTIME_ENV]: AUTOPILOT_RUNTIME_VALUE },
                    });
                }
                if (checkout.mode !== 'legacy-full' && checkout.mode !== 'full') {
                    applySparseCheckoutSet(unitWorktreePath, sparsePatterns, env);
                    runGit(['checkout', '--force', branch], unitWorktreePath, { ...env, [AUTOPILOT_RUNTIME_ENV]: AUTOPILOT_RUNTIME_VALUE });
                }
                if (input.unitSpec !== undefined)
                    await ensureFutureOwnedParentDirs(unitWorktreePath, input.unitSpec.owned_paths);
                await writeJsonAtomic(join(unitAttemptRoot, UNIT_INFO_FILE), unitInfo);
                const currentIndex = await readUnitIndex(taskRoot);
                await writeUnitIndex(taskRoot, { schema_version: 'autopilot.unit_index.v1', units: [...currentIndex.units.filter((candidate) => !(candidate.unit_id === input.unitId && candidate.attempt === input.attempt)), branchInfo] });
                await upsertUnitBranchInfo(taskRoot, branchInfo);
                if (!coordinationCutoverCommitted(resolveAutopilotStateRoot(env), input.active.repo_key)) {
                    const ledgerPath = join(input.active.worktree_root, WORKTREE_LEDGER_FILE);
                    const ledgerMarker = `\"event\":\"unit-create\"`;
                    const existingLedger = existsSync(ledgerPath) ? await readFile(ledgerPath, 'utf8') : '';
                    if (!existingLedger.split('\n').some((line) => line.includes(ledgerMarker) && line.includes(`\"workstream_run\":\"${input.active.workstream_run}\"`) && line.includes(`\"unit_id\":\"${input.unitId}\"`) && line.includes(`\"attempt\":${String(input.attempt)}`))) {
                        await appendJsonl(ledgerPath, {
                            schema_version: 'autopilot.worktree_ledger.v1', event: 'unit-create', ts: now.toISOString(), workstream: input.active.workstream,
                            workstream_run: input.active.workstream_run, autopilot_id: input.active.autopilot_id, unit_id: input.unitId, attempt: input.attempt,
                            branch, unit_path: unitWorktreePath, base_sha: baseSha,
                        });
                    }
                }
            },
            verify: async () => {
                const actualBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], unitWorktreePath, env).trim();
                const actualHead = gitHead(unitWorktreePath);
                if (actualBranch !== branch || actualHead !== baseSha)
                    fail('unit-worktree-create-postcondition', 'unit worktree create saga postcondition failed.', [actualBranch, actualHead, branch, baseSha]);
                const indexed = (await readUnitIndex(taskRoot)).units.find((candidate) => candidate.unit_id === input.unitId && candidate.attempt === input.attempt);
                if (indexed === undefined || indexed.worktree_path !== unitWorktreePath || indexed.branch !== branch)
                    fail('unit-worktree-create-postcondition', 'unit worktree metadata is incomplete after saga action.', metadataRefs);
                return ['git_worktree_registered', `branch=${branch}`, `head=${baseSha}`, 'unit_metadata_complete'];
            },
        }, env);
        return { unitInfo, created: true, resumed: false };
    });
}
async function recoverUnitCreateSagaMetadata(active, operation, env) {
    if (operation.operation_type !== 'create' || operation.owner.unit_id === 'main')
        fail('unit-create-recovery-invalid', 'unit create recovery requires an incomplete unit create operation.', [operation.operation_id]);
    const taskRoot = taskRootForActiveAutopilot(active);
    const unitId = operation.owner.unit_id;
    const attempt = operation.owner.attempt;
    const unitWorktreePath = unitWorktreePathForActiveAutopilot(active, unitId, attempt);
    if (operation.intent.worktree_path !== unitWorktreePath || operation.intent.branch !== `autopilot/unit/${active.workstream_run}/${unitId}/attempt-${String(attempt)}`)
        fail('unit-create-recovery-owner-mismatch', 'durable unit create intent disagrees with deterministic owner paths.', [operation.operation_id]);
    const checkout = await checkoutMetadataForTaskRoot(taskRoot);
    const checkoutMode = operation.intent.checkout_mode === 'full' ? 'full' : 'sparse';
    const baseSha = operation.intent.base_sha;
    if (baseSha === null || operation.intent.checkout_mode === null)
        fail('unit-create-recovery-invalid', 'durable unit create intent lacks base SHA or checkout mode.', [operation.operation_id]);
    const unitAttemptRoot = dirname(unitWorktreePath);
    const unitInfo = {
        schema_version: 'autopilot.unit_info.v1', workstream: active.workstream, workstream_run: active.workstream_run, autopilot_id: active.autopilot_id,
        unit_id: unitId, attempt, branch: operation.intent.branch, worktree_path: unitWorktreePath, base_sha: baseSha, current_sha: baseSha, archive_ref: null, status: 'active', runtime_root: active.runtime_root,
        created_at: active.started_at, checkout_mode: checkoutMode, checkout_profile_ref: checkout.checkoutProfileRef, materialized_paths_ref: MATERIALIZED_PATHS_FILE,
    };
    const branchInfo = branchInfoFromUnitInfo(unitInfo);
    const inspect = () => {
        if (!existsSync(unitWorktreePath))
            return { outcome: 'not-applied', proof: ['unit_worktree_absent'] };
        const actualBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], unitWorktreePath, env).trim();
        const actualHead = gitHead(unitWorktreePath);
        if (actualBranch !== operation.intent.branch || actualHead !== baseSha)
            return { outcome: 'unsafe', proof: [`expected_branch=${operation.intent.branch}`, `actual_branch=${actualBranch}`, `expected_head=${baseSha}`, `actual_head=${actualHead}`] };
        if (operation.intent.checkout_mode !== 'full' && !isSparseCheckoutEnabled(unitWorktreePath, env))
            return { outcome: 'not-applied', proof: ['unit_worktree_registered', 'sparse_configuration_incomplete'] };
        const missingMetadata = operation.intent.metadata_refs.filter((ref) => !existsSync(resolve(taskRoot, ...ref.split('/'))));
        return missingMetadata.length === 0 ? { outcome: 'satisfied', proof: ['unit_worktree_registered', 'unit_metadata_complete'] } : { outcome: 'not-applied', proof: missingMetadata.map((ref) => `missing_metadata=${ref}`) };
    };
    const result = await executeOwnedWorktreeSaga({
        active, unitId, attempt, kind: 'unit', operationType: 'create', operationKey: '', operationId: operation.operation_id,
        initialWorktreeState: 'planned', committedWorktreeState: 'active', intent: operation.intent,
    }, {
        inspect,
        action: async () => {
            if (existsSync(unitAttemptRoot) && !existsSync(unitWorktreePath) && (await readdir(unitAttemptRoot, { withFileTypes: true })).length > 0)
                fail('unit-worktree-path-exists', 'unit attempt path contains unrelated residue before recoverable worktree creation.', [unitAttemptRoot]);
            await mkdir(unitAttemptRoot, { recursive: true });
            if (!existsSync(unitWorktreePath))
                createAutopilotGitWorktree({ repoRoot: active.source_repo, worktreePath: unitWorktreePath, branch: operation.intent.branch, startPoint: baseSha, mode: operation.intent.checkout_mode ?? 'full', sparsePatterns: operation.intent.sparse_patterns, env: { ...env, [AUTOPILOT_RUNTIME_ENV]: AUTOPILOT_RUNTIME_VALUE } });
            if (operation.intent.checkout_mode !== 'full') {
                applySparseCheckoutSet(unitWorktreePath, operation.intent.sparse_patterns, env);
                runGit(['checkout', '--force', operation.intent.branch], unitWorktreePath, { ...env, [AUTOPILOT_RUNTIME_ENV]: AUTOPILOT_RUNTIME_VALUE });
            }
            await ensureFutureOwnedParentDirs(unitWorktreePath, operation.intent.paths);
            await writeJsonAtomic(join(unitAttemptRoot, UNIT_INFO_FILE), unitInfo);
            const currentIndex = await readUnitIndex(taskRoot);
            await writeUnitIndex(taskRoot, { schema_version: 'autopilot.unit_index.v1', units: [...currentIndex.units.filter((candidate) => !(candidate.unit_id === unitId && candidate.attempt === attempt)), branchInfo] });
            await upsertUnitBranchInfo(taskRoot, branchInfo);
            if (!coordinationCutoverCommitted(resolveAutopilotStateRoot(env), active.repo_key)) {
                const ledgerPath = join(active.worktree_root, WORKTREE_LEDGER_FILE);
                const existingLedger = existsSync(ledgerPath) ? await readFile(ledgerPath, 'utf8') : '';
                if (!existingLedger.split('\n').some((line) => line.includes('"event":"unit-create"') && line.includes(`"workstream_run":"${active.workstream_run}"`) && line.includes(`"unit_id":"${unitId}"`) && line.includes(`"attempt":${String(attempt)}`)))
                    await appendJsonl(ledgerPath, { schema_version: 'autopilot.worktree_ledger.v1', event: 'unit-create', ts: active.started_at, workstream: active.workstream, workstream_run: active.workstream_run, autopilot_id: active.autopilot_id, unit_id: unitId, attempt, branch: operation.intent.branch, unit_path: unitWorktreePath, base_sha: baseSha });
            }
        },
        verify: () => { const inspected = inspect(); if (inspected.outcome !== 'satisfied')
            fail('unit-create-recovery-postcondition', 'recovered unit create metadata remains incomplete.', inspected.proof); return inspected.proof; },
    }, env);
    if (result.operation === null)
        fail('unit-create-recovery-unmanaged', 'durable unit create recovery unexpectedly ran without coordinator authority.', [operation.operation_id]);
    return result.operation;
}
export async function recoverAutopilotWorktreeSagas(input) {
    const env = input.env ?? process.env;
    if (env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] === undefined) {
        if (input.active.coordination_authority === 'coordinator-edit-leases-v1')
            fail('coordination-authority-unavailable', 'coordinator-authoritative saga recovery requires its durable session.');
        return await recoverOwnedWorktreeSagas({ active: input.active, env });
    }
    const client = await OwnedWorktreeSagaClient.fromEnvironment(env);
    const recoveredUnitCreates = [];
    for (const operation of await client.operations()) {
        if (operation.owner.workstream_run !== input.active.workstream_run || operation.operation_type !== 'create' || operation.owner.unit_id === 'main' || operation.stage === 'committed' || operation.stage === 'compensated' || operation.stage === 'failed')
            continue;
        recoveredUnitCreates.push(await recoverUnitCreateSagaMetadata(input.active, operation, env));
    }
    return Object.freeze([...recoveredUnitCreates, ...await recoverOwnedWorktreeSagas({ active: input.active, env })]);
}
export async function updateUnitBranchStatus(input) {
    const taskRoot = taskRootForActiveAutopilot(input.active);
    const index = await readUnitIndex(taskRoot);
    const nextUnits = index.units.map((unit) => unit.unit_id === input.unitId && unit.attempt === input.attempt
        ? { ...unit, status: input.status, current_sha: input.currentSha, archive_ref: input.archiveRef }
        : unit);
    await writeUnitIndex(taskRoot, { schema_version: 'autopilot.unit_index.v1', units: nextUnits });
    const target = nextUnits.find((unit) => unit.unit_id === input.unitId && unit.attempt === input.attempt);
    if (target !== undefined)
        await upsertUnitBranchInfo(taskRoot, target);
}
function assertLegacyClaimAuthority(active, operation) {
    if (active.coordination_authority !== 'legacy-path-claims-v1')
        fail('coordination-authority-mismatch', `${operation} refused because ${active.workstream_run} is coordinator-edit-lease authoritative; legacy path claims are immutable for this run.`);
}
export async function releaseClaimsForUnit(input) {
    assertLegacyClaimAuthority(input.context.active, 'legacy unit claim release');
    const now = input.now ?? new Date();
    return await withAutopilotFileLock(join(input.context.coordinationRoot, '.locks', 'path-claims.lock'), `unit-claim-release:${input.context.active.autopilot_id}:${input.unitId}:${String(input.attempt)}`, async () => {
        const current = await readPathClaims(input.context.coordinationRoot);
        const released = current.filter((claim) => claim.autopilot_id === input.context.active.autopilot_id && claim.workstream_run === input.context.active.workstream_run && claim.unit_id === input.unitId && claim.attempt === input.attempt);
        if (released.length === 0)
            return Object.freeze([]);
        const remaining = current.filter((claim) => !(claim.autopilot_id === input.context.active.autopilot_id && claim.workstream_run === input.context.active.workstream_run && claim.unit_id === input.unitId && claim.attempt === input.attempt));
        await writePathClaims(input.context.coordinationRoot, remaining);
        for (const claim of released) {
            await appendClaimEvent(input.context.coordinationRoot, {
                schema_version: 'autopilot.claim_event.v1',
                event: 'release',
                ts: now.toISOString(),
                repo_key: input.context.active.repo_key,
                autopilot_id: claim.autopilot_id,
                workstream: claim.workstream,
                workstream_run: claim.workstream_run,
                unit_id: claim.unit_id,
                attempt: claim.attempt,
                path: claim.path,
                claim_type: claim.claim_type,
                active_run_epoch: claim.active_run_epoch,
                reason: input.reason,
            });
        }
        return Object.freeze(released);
    });
}
export async function releaseReadClaimsForUnitPaths(input) {
    assertLegacyClaimAuthority(input.context.active, 'legacy READ claim release');
    const now = input.now ?? new Date();
    const pathSet = new Set(input.paths.map(normalizeRepoRelativePath));
    if (pathSet.size === 0)
        return Object.freeze([]);
    return await withAutopilotFileLock(join(input.context.coordinationRoot, '.locks', 'path-claims.lock'), `read-claim-release:${input.context.active.autopilot_id}:${input.unitId}:${String(input.attempt)}`, async () => {
        const current = await readPathClaims(input.context.coordinationRoot);
        const released = current.filter((claim) => claim.autopilot_id === input.context.active.autopilot_id &&
            claim.workstream_run === input.context.active.workstream_run &&
            claim.unit_id === input.unitId &&
            claim.attempt === input.attempt &&
            claim.claim_type === 'READ' &&
            pathSet.has(claim.path));
        if (released.length === 0)
            return Object.freeze([]);
        const releaseKeys = new Set(released.map((claim) => `${claim.autopilot_id}\0${claim.workstream_run}\0${claim.active_run_epoch}\0${claim.claim_type}\0${claim.path}\0${claim.unit_id}\0${String(claim.attempt)}`));
        const remaining = current.filter((claim) => !releaseKeys.has(`${claim.autopilot_id}\0${claim.workstream_run}\0${claim.active_run_epoch}\0${claim.claim_type}\0${claim.path}\0${claim.unit_id}\0${String(claim.attempt)}`));
        await writePathClaims(input.context.coordinationRoot, remaining);
        for (const claim of released) {
            await appendClaimEvent(input.context.coordinationRoot, {
                schema_version: 'autopilot.claim_event.v1',
                event: 'release',
                ts: now.toISOString(),
                repo_key: input.context.active.repo_key,
                autopilot_id: claim.autopilot_id,
                workstream: claim.workstream,
                workstream_run: claim.workstream_run,
                unit_id: claim.unit_id,
                attempt: claim.attempt,
                path: claim.path,
                claim_type: claim.claim_type,
                active_run_epoch: claim.active_run_epoch,
                reason: input.reason,
            });
        }
        return Object.freeze(released);
    });
}
export async function readUnitIndex(taskRoot) {
    const path = join(taskRoot, UNIT_INDEX_FILE);
    if (!existsSync(path))
        return { schema_version: 'autopilot.unit_index.v1', units: [] };
    const value = await readJson(path);
    return parseUnitIndex(value);
}
export async function writeUnitIndex(taskRoot, index) {
    await writeJsonAtomic(join(taskRoot, UNIT_INDEX_FILE), index);
}
export async function resolveActiveAutopilotForSpec(spec, env = process.env) {
    const repo = resolveRepoIdentity(spec.cwd);
    const coordinationRoot = coordinationRootForRepo(repo.repoKey, env);
    assertCoordinationDispatchAllowed(resolveAutopilotStateRoot(env), repo.repoKey, 'Autopilot runner preflight');
    const activeRows = coordinationCutoverCommitted(resolveAutopilotStateRoot(env), repo.repoKey)
        ? await readCoordinatorActiveAutopilots(repo, worktreeRootForRepo(repo.repoKey, env), env)
        : await readActiveAutopilots(coordinationRoot);
    const cwdReal = realpathExisting(spec.cwd, 'unit spec cwd');
    const matches = activeRows.filter((row) => {
        if (row.repo_key !== repo.repoKey || row.workstream !== spec.workstream || !isChildLaunchParentStatus(row.status))
            return false;
        const taskRoot = taskRootForActiveAutopilot(row);
        if (isSamePath(row.main_worktree_path, cwdReal))
            return true;
        return readRegisteredUnitWorktreeSync(taskRoot, spec.unit_id, spec.attempt, cwdReal) !== null;
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
    if (spec.role === 'implement' || spec.role === 'fix') {
        const unitInfo = readRegisteredUnitWorktreeSync(taskRootForActiveAutopilot(active), spec.unit_id, spec.attempt, cwdReal);
        if (unitInfo === null) {
            fail('source-changing-main-launch', 'Phase 2 source-changing unit attempts must launch from their registered per-unit worktree, not workstream main or another path.', [
                `unit=${spec.unit_id}`,
                `attempt=${String(spec.attempt)}`,
                `cwd=${spec.cwd}`,
            ]);
        }
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
    assertLegacyClaimAuthority(input.context.active, 'legacy claim acquisition');
    const authorityArtifact = input.authority ?? await deriveAutopilotAuthority({ spec: input.spec });
    const requested = requestedClaimsForAuthority(input.context.active, input.spec, authorityArtifact, input.reason);
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
        const granted = effectiveClaims(next, requested);
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
        return granted;
    });
}
export async function acquireReadClaimsForUnitPaths(input) {
    assertLegacyClaimAuthority(input.context.active, 'legacy READ claim expansion');
    const acquiredAt = (input.now ?? new Date()).toISOString();
    const requested = dedupeClaims(input.paths.map((path) => ({
        schema_version: 'autopilot.path_claim.v1',
        path: normalizeRepoRelativePath(path),
        autopilot_id: input.context.active.autopilot_id,
        workstream: input.context.active.workstream,
        workstream_run: input.context.active.workstream_run,
        unit_id: input.unitId,
        attempt: input.attempt,
        claim_type: 'READ',
        acquired_at: acquiredAt,
        active_run_epoch: input.context.active.active_run_epoch,
        reason: input.reason,
    })));
    if (requested.length === 0)
        return Object.freeze([]);
    const lockPath = join(input.context.coordinationRoot, '.locks', 'path-claims.lock');
    return await withAutopilotFileLock(lockPath, `read-claim-expand:${input.context.active.autopilot_id}:${input.unitId}:${String(input.attempt)}`, async () => {
        const activeRows = await readActiveAutopilots(input.context.coordinationRoot);
        const authority = activeRows.find((row) => row.autopilot_id === input.context.active.autopilot_id);
        if (authority === undefined || !isChildLaunchParentStatus(authority.status)) {
            fail('active-authority-missing', 'active Autopilot row is missing or not child-launch authorized before READ claim expansion.', [input.context.active.autopilot_id]);
        }
        if (authority.active_run_epoch !== input.context.active.active_run_epoch) {
            fail('active-epoch-mismatch', 'active Autopilot epoch changed before READ claim expansion.', [
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
                    ts: acquiredAt,
                    repo_key: authority.repo_key,
                    autopilot_id: authority.autopilot_id,
                    workstream: authority.workstream,
                    workstream_run: authority.workstream_run,
                    unit_id: input.unitId,
                    attempt: input.attempt,
                    path: requestedClaim.path,
                    claim_type: requestedClaim.claim_type,
                    active_run_epoch: authority.active_run_epoch,
                    reason: input.reason,
                    blockers,
                });
            }
            fail('claim-conflict', 'Autopilot READ expansion rejected because another active Autopilot owns an overlapping path.', blockers.map((blocker) => `${blocker.claim_type} ${blocker.path} by ${blocker.workstream_run}/${blocker.unit_id}`));
        }
        const next = mergeClaims(existing, requested);
        const granted = effectiveClaims(next, requested);
        await writePathClaims(input.context.coordinationRoot, next);
        for (const claim of requested) {
            await appendClaimEvent(input.context.coordinationRoot, {
                schema_version: 'autopilot.claim_event.v1',
                event: 'expand',
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
        return granted;
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
async function checkoutMetadataForTaskRoot(taskRoot) {
    const snapshot = await readCheckoutProfileSnapshot(join(taskRoot, AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE));
    if (snapshot === null) {
        return {
            mode: 'legacy-full',
            checkoutProfileRef: null,
            basePatterns: [],
            perWorktreeEstimateBytes: 1_048_576,
            diskGate: {
                expected_parallel_units: 1,
                headroom_factor: 1,
                floor_free_bytes: 0,
            },
        };
    }
    return {
        mode: snapshot.profile.mode,
        checkoutProfileRef: AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE,
        basePatterns: snapshot.base_patterns,
        perWorktreeEstimateBytes: snapshot.profile.mode === 'full' ? snapshot.full_checkout_bytes : snapshot.base_checkout_bytes,
        diskGate: snapshot.profile.disk_gate,
    };
}
function materializationPathsForCheckoutBootstrap(spec) {
    return sortedUnique(authorityCandidatesForSpec(spec).map((candidate) => normalizeRepoRelativePath(candidate.path.replace(/\/\*\*$/u, ''))));
}
async function ensureFutureOwnedParentDirs(worktreePath, ownedPaths) {
    for (const path of ownedPaths) {
        const normalized = normalizeRepoRelativePath(path.replace(/\/\*\*$/u, ''));
        const target = join(worktreePath, ...normalized.split('/'));
        if (path.endsWith('/**'))
            await mkdir(target, { recursive: true });
        else
            await mkdir(dirname(target), { recursive: true });
    }
}
async function recoverCoordinatorBootstrapWorkstream(input) {
    const client = new CoordinatorClient({ env: input.env });
    const status = await client.query('status', input.repo.repoKey, null);
    const runValues = status.payload['runs'];
    if (!Array.isArray(runValues))
        fail('coordinator-status-invalid', 'coordinator status omitted durable runs during bootstrap recovery.');
    const candidates = runValues.map((value) => parseCoordinationRun(value)).filter((run) => run.workstream === input.workstream && run.status !== 'closed' && run.status !== 'aborted');
    if (candidates.length === 0)
        return null;
    if (candidates.length > 1)
        fail('ambiguous-bootstrap-run', 'multiple durable bootstrap runs require exact recovery before activation.', candidates.map((run) => run.workstream_run));
    const run = candidates[0];
    if (run === undefined)
        return null;
    const runStatus = await client.query('status', input.repo.repoKey, run.workstream_run);
    const operationValues = runStatus.payload['worktree_operations'];
    if (!Array.isArray(operationValues))
        fail('coordinator-status-invalid', 'coordinator status omitted bootstrap operations.');
    const operations = operationValues.map((value) => parseCoordinationWorktreeOperation(value));
    const expectedMainPath = join(input.worktreeRoot, 'active', run.workstream_run, 'main');
    const createOperations = operations.filter((operation) => operation.operation_type === 'create' && operation.owner.unit_id === 'main' && operation.intent.worktree_path === expectedMainPath);
    if (createOperations.length > 1)
        fail('bootstrap-operation-duplicate', 'durable bootstrap run owns duplicate main create operations.', [run.workstream_run]);
    const taskRoot = dirname(expectedMainPath);
    const bootstrapPath = join(taskRoot, '_bootstrap-create.json');
    const bootstrap = await readJson(bootstrapPath);
    if (!isRecord(bootstrap) || bootstrap['schema_version'] !== 'autopilot.worktree_bootstrap.v1')
        fail('bootstrap-state-invalid', 'worktree bootstrap state is malformed.', [bootstrapPath]);
    const parsedRows = parseLegacyActiveAutopilots([bootstrap['active']]);
    const active = parsedRows[0];
    if (active === undefined || active.repo_key !== input.repo.repoKey || active.workstream !== input.workstream || active.workstream_run !== run.workstream_run || active.autopilot_id !== run.autopilot_id || active.main_worktree_path !== expectedMainPath)
        fail('bootstrap-owner-mismatch', 'bootstrap state does not match durable coordinator ownership.', [bootstrapPath]);
    const profileSnapshot = parseCheckoutProfileSnapshot(bootstrap['profile_snapshot'], bootstrapPath);
    const bootstrapTaskInfo = bootstrap['task_info'];
    const bootstrapBranches = bootstrap['branches'];
    if (!isRecord(bootstrapTaskInfo) || (bootstrapTaskInfo['schema_version'] !== 'autopilot.task_info.v1' && bootstrapTaskInfo['schema_version'] !== 'autopilot.task_info.v2') || !isRecord(bootstrapBranches) || bootstrapBranches['schema_version'] !== 'autopilot.branches.v1')
        fail('bootstrap-state-invalid', 'worktree bootstrap metadata is malformed.', [bootstrapPath]);
    const bootstrapMetadataPaths = [join(taskRoot, AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE), join(taskRoot, TASK_INFO_FILE), join(taskRoot, BRANCHES_FILE), join(taskRoot, UNIT_INDEX_FILE)];
    const attachment = await new DurableRunSupervisorClient(input.env).attach({ repo: input.repo, active, rawSessionId: input.coordinationSessionId });
    const recoveryEnv = { ...input.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
    {
        const inspect = () => {
            if (!existsSync(active.main_worktree_path))
                return { outcome: 'not-applied', proof: ['main_worktree_absent'] };
            const actualBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], active.main_worktree_path, input.env).trim();
            const actualHead = gitHead(active.main_worktree_path);
            if (actualBranch !== active.branch || actualHead !== active.target_base_sha)
                return { outcome: 'unsafe', proof: [`actual_branch=${actualBranch}`, `actual_head=${actualHead}`] };
            if (profileSnapshot.profile.mode !== 'full' && !isSparseCheckoutEnabled(active.main_worktree_path, input.env))
                return { outcome: 'not-applied', proof: ['main_worktree_registered', 'sparse_configuration_incomplete'] };
            const missingMetadata = bootstrapMetadataPaths.filter((path) => !existsSync(path));
            return missingMetadata.length === 0 ? { outcome: 'satisfied', proof: ['main_worktree_registered', 'main_metadata_complete', `branch=${actualBranch}`, `head=${actualHead}`] } : { outcome: 'not-applied', proof: ['main_worktree_registered', ...missingMetadata.map((path) => `missing_metadata=${path}`)] };
        };
        await executeOwnedWorktreeSaga({
            active, unitId: 'main', attempt: 1, kind: 'main', operationType: 'create', operationKey: `main-create:${active.workstream_run}:${active.target_base_sha}`,
            initialWorktreeState: 'planned', committedWorktreeState: 'active',
            intent: { repo_root: active.source_repo, worktree_path: active.main_worktree_path, git_common_dir: active.git_common_dir, branch: active.branch, reason: 'create isolated Autopilot main worktree', base_sha: active.target_base_sha, target_sha: null, archive_ref: null, checkout_mode: profileSnapshot.profile.mode, sparse_patterns: profileSnapshot.base_patterns, paths: [], metadata_refs: [AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE, TASK_INFO_FILE, BRANCHES_FILE, UNIT_INDEX_FILE] },
        }, {
            inspect,
            action: async () => {
                if (!existsSync(active.main_worktree_path))
                    createAutopilotGitWorktree({ repoRoot: active.source_repo, worktreePath: active.main_worktree_path, branch: active.branch, startPoint: active.target_base_sha, mode: profileSnapshot.profile.mode, sparsePatterns: profileSnapshot.base_patterns, env: { ...input.env, [AUTOPILOT_RUNTIME_ENV]: AUTOPILOT_RUNTIME_VALUE } });
                if (profileSnapshot.profile.mode !== 'full') {
                    applySparseCheckoutSet(active.main_worktree_path, profileSnapshot.base_patterns, input.env);
                    runGit(['checkout', '--force', active.branch], active.main_worktree_path, { ...input.env, [AUTOPILOT_RUNTIME_ENV]: AUTOPILOT_RUNTIME_VALUE });
                }
                await mkdir(active.runtime_root, { recursive: true });
                await writeJsonAtomic(join(taskRoot, AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE), profileSnapshot);
                await writeJsonAtomic(join(taskRoot, TASK_INFO_FILE), bootstrapTaskInfo);
                await writeJsonAtomic(join(taskRoot, BRANCHES_FILE), bootstrapBranches);
                await writeJsonAtomic(join(taskRoot, UNIT_INDEX_FILE), { schema_version: 'autopilot.unit_index.v1', units: [] });
            },
            verify: () => { const inspected = inspect(); if (inspected.outcome !== 'satisfied')
                fail('bootstrap-recovery-postcondition', 'recovered main create postcondition failed.', inspected.proof); return inspected.proof; },
        }, recoveryEnv);
    }
    if (!existsSync(active.main_worktree_path))
        fail('bootstrap-recovery-incomplete', 'main worktree remains absent after durable create recovery.', [active.main_worktree_path]);
    await mkdir(active.runtime_root, { recursive: true });
    await writeJsonAtomic(join(taskRoot, AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE), profileSnapshot);
    const taskInfo = {
        schema_version: 'autopilot.task_info.v2', coordination_authority: active.coordination_authority, workstream: active.workstream, workstream_run: active.workstream_run, autopilot_id: active.autopilot_id,
        source_repo: active.source_repo, git_common_dir: active.git_common_dir, repo_key: active.repo_key, base_sha: active.target_base_sha, branch: active.branch,
        worktree_path: active.main_worktree_path, runtime_root: active.runtime_root, target_branch: active.target_branch, target_base_sha: active.target_base_sha,
        started_at: active.started_at, closed_at: null, status: active.status, checkout_mode: profileSnapshot.profile.mode === 'full' ? 'full' : 'sparse',
        checkout_profile_ref: AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE, checkout_profile_sha256: profileSnapshot.profile_sha256, checkout_profile_origin: profileSnapshot.profile_origin,
    };
    const branches = {
        schema_version: 'autopilot.branches.v1', active_branch: active.branch, base_sha: active.target_base_sha, current_sha: gitHead(active.main_worktree_path), archive_ref: null, unit_branches: [],
    };
    await writeJsonAtomic(join(taskRoot, TASK_INFO_FILE), taskInfo);
    await writeJsonAtomic(join(taskRoot, BRANCHES_FILE), branches);
    await writeJsonAtomic(join(taskRoot, UNIT_INDEX_FILE), { schema_version: 'autopilot.unit_index.v1', units: [] });
    if (!coordinationCutoverCommitted(resolveAutopilotStateRoot(input.env), active.repo_key)) {
        await writeActiveAutopilots(input.coordinationRoot, [...input.activeRows, active]);
        await addWorktreeIndexRow(input.worktreeRoot, { workstream: active.workstream, workstream_run: active.workstream_run, autopilot_id: active.autopilot_id, started_at: active.started_at, main_path: active.main_worktree_path, branch: active.branch, status: 'active' });
        await appendJsonl(join(input.worktreeRoot, WORKTREE_LEDGER_FILE), { schema_version: 'autopilot.worktree_ledger.v1', event: 'bootstrap-recover', ts: input.now.toISOString(), workstream: active.workstream, workstream_run: active.workstream_run, autopilot_id: active.autopilot_id, branch: active.branch, main_path: active.main_worktree_path, base_sha: active.target_base_sha });
    }
    await rm(bootstrapPath, { force: false });
    return { repo: input.repo, active, worktreeRoot: input.worktreeRoot, taskRoot, mainWorktreePath: active.main_worktree_path, runtimeRoot: active.runtime_root, created: true, resumed: true };
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
    const checkoutProfile = await resolveAutopilotCheckoutProfile({ repoRoot: input.repo.repoRoot, env: input.env, now: input.now });
    const profileSnapshot = checkoutProfileSnapshotFromResolved({ resolved: checkoutProfile, now: input.now });
    const perWorktreeEstimateBytes = checkoutProfile.profile.mode === 'full'
        ? checkoutProfile.full_checkout_bytes
        : checkoutProfile.base_checkout_bytes;
    assertAutopilotDiskGate({
        path: input.worktreeRoot,
        projection: {
            profileMode: checkoutProfile.profile.mode,
            diskGate: checkoutProfile.profile.disk_gate,
            perWorktreeEstimateBytes,
            expectedParallelUnits: checkoutProfile.profile.disk_gate.expected_parallel_units,
        },
    });
    const row = {
        schema_version: 'autopilot.active_parent.v2', coordination_authority: input.coordinationSessionId === undefined ? 'legacy-path-claims-v1' : 'coordinator-edit-leases-v1', autopilot_id: autopilotId, workstream: input.workstream, workstream_run: workstreamRun,
        repo_key: input.repo.repoKey, source_repo: input.repo.repoRoot, git_common_dir: input.repo.gitCommonDir, worktree_root: input.worktreeRoot,
        main_worktree_path: mainWorktreePath, branch, runtime_root: runtimeRoot, target_branch: input.repo.targetBranch,
        target_base_sha: input.repo.headSha, origin_url: input.repo.originUrl, pid: process.pid, boot_id: getBootId(), status: 'active',
        started_at: startedAt, active_run_epoch: 1, active_epoch_started_at: startedAt, active_run_receipt_id: buildReceiptId('bootstrap-register'),
    };
    const taskInfo = {
        schema_version: 'autopilot.task_info.v2', coordination_authority: row.coordination_authority, workstream: row.workstream, workstream_run: row.workstream_run, autopilot_id: row.autopilot_id,
        source_repo: row.source_repo, git_common_dir: row.git_common_dir, repo_key: row.repo_key, base_sha: row.target_base_sha, branch: row.branch,
        worktree_path: row.main_worktree_path, runtime_root: row.runtime_root, target_branch: row.target_branch, target_base_sha: row.target_base_sha,
        started_at: row.started_at, closed_at: null, status: row.status, checkout_mode: checkoutProfile.profile.mode === 'full' ? 'full' : 'sparse',
        checkout_profile_ref: AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE, checkout_profile_sha256: checkoutProfile.profile_sha256, checkout_profile_origin: checkoutProfile.origin,
    };
    const branches = {
        schema_version: 'autopilot.branches.v1', active_branch: row.branch, base_sha: row.target_base_sha, current_sha: row.target_base_sha,
        archive_ref: null, unit_branches: [],
    };
    await mkdir(taskRoot, { recursive: true });
    const bootstrapPath = join(taskRoot, '_bootstrap-create.json');
    await writeJsonAtomic(bootstrapPath, { schema_version: 'autopilot.worktree_bootstrap.v1', active: row, task_info: taskInfo, branches, profile_snapshot: profileSnapshot });
    let sagaEnv = input.env;
    if (input.coordinationSessionId !== undefined) {
        const attachment = await new DurableRunSupervisorClient(input.env).attach({ repo: input.repo, active: row, rawSessionId: input.coordinationSessionId });
        sagaEnv = { ...input.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
    }
    const mainMetadataPaths = [
        join(taskRoot, AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE),
        join(taskRoot, TASK_INFO_FILE),
        join(taskRoot, BRANCHES_FILE),
        join(taskRoot, UNIT_INDEX_FILE),
    ];
    const inspectMainCreate = () => {
        if (!existsSync(mainWorktreePath))
            return { outcome: 'not-applied', proof: ['main_worktree_absent'] };
        const actualBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], mainWorktreePath, input.env).trim();
        const actualHead = gitHead(mainWorktreePath);
        if (actualBranch !== branch || actualHead !== input.repo.headSha)
            return { outcome: 'unsafe', proof: [`expected_branch=${branch}`, `actual_branch=${actualBranch}`, `expected_head=${input.repo.headSha}`, `actual_head=${actualHead}`] };
        if (checkoutProfile.profile.mode !== 'full' && !isSparseCheckoutEnabled(mainWorktreePath, input.env))
            return { outcome: 'not-applied', proof: ['main_worktree_registered', 'sparse_configuration_incomplete'] };
        const missingMetadata = mainMetadataPaths.filter((path) => !existsSync(path));
        return missingMetadata.length === 0
            ? { outcome: 'satisfied', proof: ['main_worktree_registered', 'main_metadata_complete', `branch=${branch}`, `head=${actualHead}`] }
            : { outcome: 'not-applied', proof: ['main_worktree_registered', ...missingMetadata.map((path) => `missing_metadata=${path}`)] };
    };
    await executeOwnedWorktreeSaga({
        active: row, unitId: 'main', attempt: 1, kind: 'main', operationType: 'create',
        operationKey: `main-create:${workstreamRun}:${input.repo.headSha}`, initialWorktreeState: 'planned', committedWorktreeState: 'active',
        intent: {
            repo_root: input.repo.repoRoot, worktree_path: mainWorktreePath, git_common_dir: input.repo.gitCommonDir, branch,
            reason: 'create isolated Autopilot main worktree', base_sha: input.repo.headSha, target_sha: null, archive_ref: null,
            checkout_mode: checkoutProfile.profile.mode, sparse_patterns: checkoutProfile.base_patterns, paths: [],
            metadata_refs: [AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE, TASK_INFO_FILE, BRANCHES_FILE, UNIT_INDEX_FILE],
        },
    }, {
        inspect: inspectMainCreate,
        action: async () => {
            if (!existsSync(mainWorktreePath)) {
                createAutopilotGitWorktree({
                    repoRoot: input.repo.repoRoot, worktreePath: mainWorktreePath, branch, startPoint: input.repo.headSha,
                    mode: checkoutProfile.profile.mode, sparsePatterns: checkoutProfile.base_patterns,
                    env: { ...input.env, [AUTOPILOT_RUNTIME_ENV]: AUTOPILOT_RUNTIME_VALUE },
                });
            }
            if (checkoutProfile.profile.mode !== 'full') {
                applySparseCheckoutSet(mainWorktreePath, checkoutProfile.base_patterns, input.env);
                runGit(['checkout', '--force', branch], mainWorktreePath, { ...input.env, [AUTOPILOT_RUNTIME_ENV]: AUTOPILOT_RUNTIME_VALUE });
            }
            await mkdir(runtimeRoot, { recursive: true });
            await writeJsonAtomic(join(taskRoot, AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE), profileSnapshot);
            await writeJsonAtomic(join(taskRoot, TASK_INFO_FILE), taskInfo);
            await writeJsonAtomic(join(taskRoot, BRANCHES_FILE), branches);
            await writeJsonAtomic(join(taskRoot, UNIT_INDEX_FILE), { schema_version: 'autopilot.unit_index.v1', units: [] });
        },
        verify: () => {
            const inspected = inspectMainCreate();
            if (inspected.outcome !== 'satisfied')
                fail('main-worktree-create-postcondition', 'main worktree create saga postcondition failed.', inspected.proof);
            return inspected.proof;
        },
    }, sagaEnv);
    await mkdir(runtimeRoot, { recursive: true });
    await writeJsonAtomic(join(taskRoot, AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE), profileSnapshot);
    await writeJsonAtomic(join(taskRoot, TASK_INFO_FILE), taskInfo);
    await writeJsonAtomic(join(taskRoot, BRANCHES_FILE), branches);
    await writeJsonAtomic(join(taskRoot, UNIT_INDEX_FILE), { schema_version: 'autopilot.unit_index.v1', units: [] });
    if (!coordinationCutoverCommitted(resolveAutopilotStateRoot(input.env), row.repo_key)) {
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
    }
    await rm(bootstrapPath, { force: false });
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
function sortedUnique(values) {
    return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}
function requestedClaimsForAuthority(active, spec, authorityArtifact, reason) {
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
    for (const observation of authorityArtifact.observations)
        add(observation.path, 'READ');
    for (const edit of authorityArtifact.edit_intentions)
        add(edit.path, 'WRITE');
    for (const exclusive of authorityArtifact.exclusives)
        add(exclusive.path, 'EXCLUSIVE');
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
            if (isIdempotentSameUnitClaim(req, claim, authority))
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
    // READ is a stable observation and WRITE is speculative edit intent in an
    // isolated worktree. A pre-existing READ may finish against immutable bytes;
    // an active bounded EXCLUSIVE excludes every new overlapping mode, and a new
    // EXCLUSIVE excludes active WRITE. Real WRITE/WRITE conflicts are classified
    // from actual diffs at integration time.
    if (existing === 'READ')
        return false;
    return requested === 'EXCLUSIVE' || existing === 'EXCLUSIVE';
}
function isIdempotentSameUnitClaim(req, claim, authority) {
    return claim.autopilot_id === authority.autopilot_id &&
        claim.workstream_run === authority.workstream_run &&
        claim.unit_id === req.unit_id &&
        claim.attempt === req.attempt &&
        claim.path === req.path &&
        claim.claim_type === req.claim_type;
}
function mergeClaims(existing, requested) {
    const out = [...existing];
    for (const claim of requested) {
        const alreadyPresent = out.some((candidate) => candidate.autopilot_id === claim.autopilot_id &&
            candidate.workstream_run === claim.workstream_run &&
            candidate.unit_id === claim.unit_id &&
            candidate.attempt === claim.attempt &&
            candidate.path === claim.path &&
            candidate.claim_type === claim.claim_type);
        if (!alreadyPresent)
            out.push(claim);
    }
    return Object.freeze(out.sort((left, right) => `${left.path}\0${left.autopilot_id}\0${left.unit_id}`.localeCompare(`${right.path}\0${right.autopilot_id}\0${right.unit_id}`)));
}
function effectiveClaims(stored, requested) {
    return Object.freeze(requested.map((claim) => {
        const effective = stored.find((candidate) => candidate.autopilot_id === claim.autopilot_id &&
            candidate.workstream_run === claim.workstream_run &&
            candidate.unit_id === claim.unit_id &&
            candidate.attempt === claim.attempt &&
            candidate.path === claim.path &&
            candidate.claim_type === claim.claim_type);
        if (effective === undefined)
            fail('claim-persistence-mismatch', 'granted durable claim is absent after atomic claim persistence.', [claim.path]);
        return effective;
    }));
}
function branchInfoFromUnitInfo(info) {
    return {
        unit_id: info.unit_id,
        attempt: info.attempt,
        branch: info.branch,
        worktree_path: info.worktree_path,
        base_sha: info.base_sha,
        current_sha: info.current_sha,
        archive_ref: info.archive_ref,
        status: info.status,
    };
}
function unitInfoPathForBranch(taskRoot, branch) {
    const expectedAttemptRoot = join(taskRoot, 'units', branch.unit_id, `attempt-${String(branch.attempt)}`);
    return join(expectedAttemptRoot, UNIT_INFO_FILE);
}
function unitInfoFromBranch(active, branch, now) {
    return {
        schema_version: 'autopilot.unit_info.v1',
        workstream: active.workstream,
        workstream_run: active.workstream_run,
        autopilot_id: active.autopilot_id,
        unit_id: branch.unit_id,
        attempt: branch.attempt,
        branch: branch.branch,
        worktree_path: branch.worktree_path,
        base_sha: branch.base_sha,
        current_sha: branch.current_sha,
        archive_ref: branch.archive_ref,
        status: branch.status,
        runtime_root: active.runtime_root,
        created_at: now.toISOString(),
        checkout_mode: 'legacy-full',
        checkout_profile_ref: null,
        materialized_paths_ref: null,
    };
}
async function upsertUnitBranchInfo(taskRoot, branchInfo) {
    const path = join(taskRoot, BRANCHES_FILE);
    const branches = existsSync(path) ? parseBranchesInfo(await readJson(path)) : {
        schema_version: 'autopilot.branches.v1',
        active_branch: '',
        base_sha: branchInfo.base_sha,
        current_sha: branchInfo.base_sha,
        archive_ref: null,
        unit_branches: [],
    };
    const unitBranches = branches.unit_branches.filter((unit) => !(unit.unit_id === branchInfo.unit_id && unit.attempt === branchInfo.attempt));
    await writeJsonAtomic(path, { ...branches, unit_branches: [...unitBranches, branchInfo] });
}
function readRegisteredUnitWorktreeSync(taskRoot, unitId, attempt, cwdReal) {
    const path = join(taskRoot, UNIT_INDEX_FILE);
    if (!existsSync(path))
        return null;
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
    const index = parseUnitIndex(parsed);
    const unit = index.units.find((candidate) => candidate.unit_id === unitId && candidate.attempt === attempt);
    if (unit === undefined)
        return null;
    const expectedPath = join(taskRoot, 'units', unitId, `attempt-${String(attempt)}`, 'worktree');
    if (!isSamePath(unit.worktree_path, expectedPath))
        fail('unit-worktree-projection-mismatch', 'registered unit path disagrees with its deterministic run-owned worktree path.', [unit.worktree_path, expectedPath]);
    const unitReal = realpathExisting(unit.worktree_path, 'registered unit worktree');
    return isSamePath(unitReal, cwdReal) || isPathWithinRoot(unitReal, cwdReal) ? unit : null;
}
function parseUnitIndex(value) {
    if (!isRecord(value))
        fail('invalid-unit-index', '_unit-index.json must contain an object.');
    const schemaVersion = expectConst(value, 'schema_version', 'autopilot.unit_index.v1');
    const unitsRaw = value['units'];
    if (!Array.isArray(unitsRaw))
        fail('invalid-unit-index', 'units must be an array.');
    return { schema_version: schemaVersion, units: [...unitsRaw.map(parseUnitBranchInfo)] };
}
function parseBranchesInfo(value) {
    if (!isRecord(value))
        fail('invalid-branches-info', '_branches.json must contain an object.');
    const unitBranches = value['unit_branches'];
    return {
        schema_version: expectConst(value, 'schema_version', 'autopilot.branches.v1'),
        active_branch: expectString(value, 'active_branch'),
        base_sha: expectString(value, 'base_sha'),
        current_sha: expectString(value, 'current_sha'),
        archive_ref: expectNullableString(value, 'archive_ref'),
        unit_branches: Array.isArray(unitBranches) ? Object.freeze(unitBranches.map(parseUnitBranchInfo)) : [],
    };
}
function parseUnitInfo(value) {
    if (!isRecord(value))
        fail('invalid-unit-info', '_unit-info.json must contain an object.');
    const branch = parseUnitBranchInfo(value);
    return {
        schema_version: expectConst(value, 'schema_version', 'autopilot.unit_info.v1'),
        workstream: expectString(value, 'workstream'),
        workstream_run: expectString(value, 'workstream_run'),
        autopilot_id: expectString(value, 'autopilot_id'),
        ...branch,
        runtime_root: expectString(value, 'runtime_root'),
        created_at: expectString(value, 'created_at'),
        checkout_mode: optionalCheckoutMode(value, 'checkout_mode'),
        checkout_profile_ref: optionalNullableString(value, 'checkout_profile_ref'),
        materialized_paths_ref: optionalNullableString(value, 'materialized_paths_ref'),
    };
}
function parseUnitBranchInfo(value) {
    if (!isRecord(value))
        fail('invalid-unit-branch', 'unit branch info must be an object.');
    return {
        unit_id: expectString(value, 'unit_id'),
        attempt: expectInteger(value, 'attempt'),
        branch: expectString(value, 'branch'),
        worktree_path: expectString(value, 'worktree_path'),
        base_sha: expectString(value, 'base_sha'),
        current_sha: expectString(value, 'current_sha'),
        archive_ref: expectNullableString(value, 'archive_ref'),
        status: expectOneOf(value, 'status', ['active', 'merged', 'aborted', 'quarantined', 'superseded']),
    };
}
async function ensureRepoRuntimeFiles(coordinationRoot, worktreeRoot) {
    const stateRoot = dirname(dirname(coordinationRoot));
    for (const root of [stateRoot, dirname(coordinationRoot), coordinationRoot, dirname(worktreeRoot), worktreeRoot, join(coordinationRoot, '.locks'), join(worktreeRoot, '.locks'), join(worktreeRoot, 'active'), join(worktreeRoot, '_archive')])
        await ensurePrivateAuthorityDirectory(root);
    for (const file of [ACTIVE_AUTOPILOTS_FILE, PATH_CLAIMS_FILE]) {
        const path = join(coordinationRoot, file);
        if (!existsSync(path))
            await writeJsonAtomic(path, []);
    }
    for (const file of [CLAIM_EVENTS_FILE, MERGE_LOG_FILE, FOREIGN_MERGE_ACKS_FILE]) {
        const path = join(coordinationRoot, file);
        if (!existsSync(path))
            await writeFile(path, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 }).catch((error) => {
                if (isNodeError(error) && error.code === 'EEXIST')
                    return;
                throw error;
            });
        await enforcePrivateAuthorityPath(path, false);
    }
    const indexPath = join(worktreeRoot, WORKTREE_INDEX_FILE);
    if (!existsSync(indexPath))
        await writeJsonAtomic(indexPath, emptyWorktreeIndex());
    const ledgerPath = join(worktreeRoot, WORKTREE_LEDGER_FILE);
    if (!existsSync(ledgerPath))
        await writeFile(ledgerPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 }).catch((error) => {
            if (isNodeError(error) && error.code === 'EEXIST')
                return;
            throw error;
        });
    await enforcePrivateAuthorityPath(ledgerPath, false);
}
export async function readActiveAutopilots(coordinationRoot) {
    const path = join(coordinationRoot, ACTIVE_AUTOPILOTS_FILE);
    if (!existsSync(path))
        return Object.freeze([]);
    return parseLegacyActiveAutopilots(await readJson(path));
}
export async function readCoordinatorRunCatalog(client, repoKey) {
    const runs = [];
    const resources = [];
    let cursor = null;
    do {
        const response = await client.query('run-catalog', repoKey, null, { cursor_run: cursor, limit: 128 });
        const rawRuns = response.payload['runs'];
        const rawResources = response.payload['run_resources'];
        if (!Array.isArray(rawRuns) || !Array.isArray(rawResources) || rawRuns.length !== rawResources.length || rawRuns.length > 128)
            fail('invalid-coordinator-status', 'coordinator activation catalog omitted its bounded run/resource page.');
        const pageRuns = rawRuns.map((value) => parseCoordinationRun(value));
        const pageResources = rawResources.map((value) => parseCoordinationRunResource(value));
        if (pageRuns.some((run, index) => pageResources[index]?.workstream_run !== run.workstream_run))
            fail('invalid-coordinator-status', 'coordinator activation catalog run/resource page is not in lockstep.');
        runs.push(...pageRuns);
        resources.push(...pageResources);
        const next = response.payload['next_cursor'];
        if (next !== null && typeof next !== 'string')
            fail('invalid-coordinator-status', 'coordinator activation catalog returned an invalid pagination cursor.');
        if (next !== null && (next === cursor || pageRuns.at(-1)?.workstream_run !== next))
            fail('invalid-coordinator-status', 'coordinator activation catalog returned a non-advancing pagination cursor.');
        cursor = next;
        if (runs.length > 100_000)
            fail('invalid-coordinator-status', 'coordinator activation catalog exceeds its aggregate run bound.');
    } while (cursor !== null);
    return { runs: Object.freeze(runs), resources: Object.freeze(resources) };
}
export async function assertCoordinatorMigrationRecoveryCleared(repo, workstream, env = process.env) {
    const client = new CoordinatorClient({ env });
    const catalog = await readCoordinatorRunCatalog(client, repo.repoKey);
    const matchingRunIds = catalog.runs.filter((run) => run.repo_id === repo.repoKey && run.workstream === workstream).map((run) => run.workstream_run);
    for (const run of matchingRunIds) {
        const exact = await client.query('run-catalog', repo.repoKey, run);
        const pendingCount = exact.payload['pending_migration_recovery_count'];
        const pending = exact.payload['pending_migration_recovery'];
        if (typeof pendingCount !== 'number' || !Number.isSafeInteger(pendingCount) || !Array.isArray(pending))
            fail('invalid-coordinator-status', 'coordinator run catalog omitted bounded recovery identity.');
        if (pendingCount > 0)
            fail('migration-recovery-required', `Autopilot activation for ${workstream} is fenced until its imported authority recovery is resolved by a recovery-only supervisor session.`, pending.map((value) => typeof value === 'object' && value !== null ? `${run}:${String(value['recovery_id'])}` : run));
    }
}
export async function readCoordinatorActiveAutopilots(repo, worktreeRoot, env = process.env, includeTerminal = false) {
    const client = new CoordinatorClient({ env });
    const catalog = await readCoordinatorRunCatalog(client, repo.repoKey);
    const resources = catalog.resources;
    const parsedRuns = catalog.runs;
    const pendingRecoveryRuns = new Set();
    for (const run of parsedRuns) {
        const exact = await client.query('run-catalog', repo.repoKey, run.workstream_run);
        const pendingCount = exact.payload['pending_migration_recovery_count'];
        if (typeof pendingCount !== 'number' || !Number.isSafeInteger(pendingCount) || pendingCount < 0)
            fail('invalid-coordinator-status', 'coordinator run catalog pending recovery count is invalid.');
        if (pendingCount > 0)
            pendingRecoveryRuns.add(run.workstream_run);
    }
    const rawRunValues = parsedRuns;
    const rows = [];
    for (const rawRun of rawRunValues) {
        const run = parseCoordinationRun(rawRun);
        if (run.repo_id !== repo.repoKey || run.coordination_authority !== 'coordinator-edit-leases-v1' || pendingRecoveryRuns.has(run.workstream_run) || (!includeTerminal && (run.status === 'closed' || run.status === 'aborted')))
            continue;
        const matching = resources.filter((resource) => resource.repo_id === repo.repoKey && resource.workstream_run === run.workstream_run);
        if (matching.length !== 1)
            fail('invalid-coordinator-status', 'coordinator run must own exactly one immutable run resource.', [run.workstream_run]);
        const resource = matching[0];
        if (resource === undefined)
            fail('invalid-coordinator-status', 'coordinator run resource disappeared.', [run.workstream_run]);
        const sourceIdentity = resolveRepoIdentity(resource.source_repo);
        if (normalizePath(sourceIdentity.repoRoot) !== normalizePath(resource.source_repo) || sourceIdentity.repoKey !== repo.repoKey || normalizePath(sourceIdentity.gitCommonDir) !== normalizePath(repo.gitCommonDir) || normalizePath(resource.git_common_dir) !== normalizePath(repo.gitCommonDir) || normalizePath(resource.worktree_root) !== normalizePath(worktreeRoot))
            fail('invalid-coordinator-status', 'coordinator run resource disagrees with canonical repository identity.', [run.workstream_run]);
        if (!isPathWithinRoot(resource.worktree_root, resource.main_worktree_path) || !isPathWithinRoot(resource.main_worktree_path, resource.runtime_root))
            fail('invalid-coordinator-status', 'coordinator run resource contains an escaped worktree/runtime path.', [run.workstream_run]);
        const parentStatus = run.status === 'recovering' ? 'blocked' : run.status === 'aborted' ? 'closed' : run.status;
        rows.push({
            schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1', autopilot_id: run.autopilot_id, workstream: run.workstream, workstream_run: run.workstream_run,
            repo_key: repo.repoKey, source_repo: resource.source_repo, git_common_dir: resource.git_common_dir, worktree_root: resource.worktree_root, main_worktree_path: resource.main_worktree_path,
            branch: resource.branch, runtime_root: resource.runtime_root, target_branch: resource.target_branch, target_base_sha: resource.target_base_sha,
            origin_url: resource.origin_url, pid: process.pid, boot_id: getBootId(), status: parentStatus, started_at: resource.started_at,
            active_run_epoch: Math.max(1, run.active_session_generation), active_epoch_started_at: new Date().toISOString(), active_run_receipt_id: `coordinator-projection-${run.version}`,
        });
    }
    return Object.freeze(rows);
}
function legacyRootIdentity(root) {
    const repoKey = root.split(sep).filter((segment) => segment.length > 0).at(-1);
    if (repoKey === undefined)
        fail('invalid-coordination-root', 'legacy coordination root has no repository key.', [root]);
    return { stateRoot: dirname(dirname(root)), repoKey };
}
export async function writeActiveAutopilots(coordinationRoot, rows) {
    const identity = legacyRootIdentity(coordinationRoot);
    assertLegacyCoordinationWritable(identity.stateRoot, identity.repoKey, 'legacy active-autopilots write');
    await writeJsonAtomic(join(coordinationRoot, ACTIVE_AUTOPILOTS_FILE), rows);
}
export async function readPathClaims(coordinationRoot) {
    const path = join(coordinationRoot, PATH_CLAIMS_FILE);
    if (!existsSync(path))
        return Object.freeze([]);
    return parseLegacyPathClaims(await readJson(path));
}
export async function writePathClaims(coordinationRoot, claims) {
    const identity = legacyRootIdentity(coordinationRoot);
    assertLegacyCoordinationWritable(identity.stateRoot, identity.repoKey, 'legacy path-claims write');
    await writeJsonAtomic(join(coordinationRoot, PATH_CLAIMS_FILE), claims);
}
export async function appendClaimEvent(coordinationRoot, event) {
    const identity = legacyRootIdentity(coordinationRoot);
    assertLegacyCoordinationWritable(identity.stateRoot, identity.repoKey, 'legacy claim-event append');
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
    await writeJsonAtomic(path, { ...value, schema_version: 'autopilot.task_info.v2', coordination_authority: row.coordination_authority, status, runtime_root: row.runtime_root, worktree_path: row.main_worktree_path });
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
    await ensurePrivateAuthorityDirectory(dirname(lockPath));
    const started = Date.now();
    let backoff = LOCK_BACKOFF_START_MS;
    while (true) {
        let fileHandle = null;
        try {
            fileHandle = await open(lockPath, 'wx', 0o600);
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
            await enforcePrivateAuthorityPath(lockPath, false);
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
    // Boot identity may be unstable on Windows or after a clock correction. A
    // runtime lock with a live PID is never reclaimed on boot mismatch alone.
    const stale = !isPidAlive(pidRaw);
    if (stale) {
        await unlink(lockPath).catch(() => undefined);
        return;
    }
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
async function fsyncRuntimeDirectory(path) {
    if (platform() === 'win32')
        return;
    const directory = await open(path, 'r');
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
export async function writeJsonAtomic(path, value) {
    await ensurePrivateAuthorityDirectory(dirname(path));
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const handle = await open(tmp, 'wx', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await enforcePrivateAuthorityPath(tmp, false);
    await rename(tmp, path);
    await enforcePrivateAuthorityPath(path, false);
    await fsyncRuntimeDirectory(dirname(path));
}
export async function appendJsonl(path, value) {
    await ensurePrivateAuthorityDirectory(dirname(path));
    const handle = await open(path, 'a', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await enforcePrivateAuthorityPath(path, false);
    await fsyncRuntimeDirectory(dirname(path));
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
function optionalNullableString(record, field) {
    const value = record[field];
    if (value === undefined || value === null)
        return null;
    if (typeof value === 'string')
        return value;
    fail('invalid-runtime-record', `field ${field} must be a string, null, or omitted.`);
}
function optionalCheckoutMode(record, field) {
    const value = record[field];
    if (value === undefined)
        return 'legacy-full';
    if (value === 'sparse' || value === 'full' || value === 'legacy-full')
        return value;
    if (value === 'claim-minimal' || value === 'exclude-heavy')
        return 'sparse';
    fail('invalid-runtime-record', `field ${field} must be a checkout mode.`);
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
