import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CoordinatorClient, durableIdentifier } from "./client.js";
import { parseCoordinationWorktree, parseCoordinationWorktreeOperation } from "./contracts.js";
import { CoordinationRuntimeError } from "./failures.js";
import { coordinationCutoverCommitted } from "./migration-paths.js";
import { coordinatorRuntimePaths } from "./runtime-paths.js";
import { currentBootId, isProcessAlive } from "./process-identity.js";
import { readCoordinatorSessionContext } from "./supervisor.js";
import { deterministicWorktreeId, sameWorktreeAuthority, worktreeOwnerKindKey } from "./worktree-identity.js";
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from "../names.js";
const TERMINAL_STAGES = new Set(['committed', 'compensated', 'failed']);
export const WORKTREE_SAGA_BOUNDARIES = ['after-prepare', 'before-probe', 'after-probe', 'after-start', 'before-action', 'after-action', 'after-action-report', 'before-verification', 'after-verification', 'after-evidence', 'after-verified-commit', 'after-terminal-commit'];
async function observeBoundary(callbacks, boundary) {
    await callbacks.observeBoundary?.(boundary);
}
export class WorktreeSagaCompensatedError extends Error {
    name = 'WorktreeSagaCompensatedError';
    proof;
    constructor(message, proof) {
        super(message);
        this.proof = Object.freeze([...proof]);
    }
}
function phaseCauseEvidence(prefix, error, maximumDetails) {
    const code = error instanceof CoordinationRuntimeError ? error.code
        : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code
            : 'untyped-error';
    const message = error instanceof Error ? error.message : String(error);
    const details = error instanceof CoordinationRuntimeError ? error.evidence : [];
    const included = details.slice(0, maximumDetails).map((entry, index) => `${prefix}_evidence[${String(index)}]=${entry}`);
    return Object.freeze([
        `${prefix}_code=${code}`,
        `${prefix}_message=${message}`,
        ...included,
        ...(details.length > maximumDetails ? [`${prefix}_evidence_truncated=entries:${String(details.length - maximumDetails)}`] : []),
    ]);
}
function phaseFailure(operation, phase, error, reconciliationError) {
    const original = error instanceof Error ? error.message : String(error);
    const transport = [error, reconciliationError].some((candidate) => candidate instanceof CoordinationRuntimeError
        ? candidate.code === 'coordinator-unavailable' || candidate.code === 'coordinator-contention'
        : candidate instanceof Error && 'code' in candidate && ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(String(candidate.code)));
    const code = error instanceof CoordinationRuntimeError && error.code === 'recovery-required' ? 'recovery-required' : transport ? 'coordinator-unavailable' : error instanceof CoordinationRuntimeError ? error.code : 'recovery-required';
    return new CoordinationRuntimeError(code, `owned worktree saga ${operation.operation_id} failed during ${phase}: ${original}${reconciliationError === undefined ? '' : '; durable reconciling report also failed'}`, [
        `operation_id=${operation.operation_id}`,
        `phase=${phase}`,
        `durable_stage=${operation.stage}`,
        ...phaseCauseEvidence('cause', error, 10),
        ...(reconciliationError === undefined ? [] : phaseCauseEvidence('reconciliation', reconciliationError, 8)),
    ]);
}
function record(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-state', `${label} is not an object`);
    return value;
}
function array(value, label) {
    if (!Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-state', `${label} is not an array`);
    return value;
}
function responseOperation(response) {
    return parseCoordinationWorktreeOperation(response.payload['operation']);
}
function responseWorktree(response) {
    return parseCoordinationWorktree(response.payload['worktree']);
}
function sameOwner(left, right) {
    return left.repo_id === right.repo_id && left.autopilot_id === right.autopilot_id && left.workstream_run === right.workstream_run && left.unit_id === right.unit_id && left.attempt === right.attempt;
}
function canonicalJson(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new CoordinationRuntimeError('invalid-request', 'saga evidence contains a non-finite number');
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
    if (typeof value !== 'object')
        throw new CoordinationRuntimeError('invalid-request', 'saga evidence contains a non-JSON value');
    const object = value;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
function ownerFor(spec) {
    return {
        repo_id: spec.active.repo_key,
        autopilot_id: spec.active.autopilot_id,
        workstream_run: spec.active.workstream_run,
        unit_id: spec.kind === 'main' ? 'main' : spec.unitId,
        attempt: spec.kind === 'main' ? 1 : spec.attempt,
    };
}
function operationId(owner, type, key, intent) {
    return durableIdentifier('operation', `${owner.repo_id}\0${owner.autopilot_id}\0${owner.workstream_run}\0${owner.unit_id}\0${String(owner.attempt)}\0${type}\0${key}\0${canonicalJson(intent)}`);
}
function operationEvidenceRef(owner, id) {
    return `_saga-evidence/${owner.workstream_run}/${id}.json`;
}
function operationEvidencePath(session, ref) {
    return join(session.state_root, 'worktrees', session.repo_key, ...ref.split('/'));
}
async function writeImmutableEvidence(input) {
    const ref = operationEvidenceRef(input.operation.owner, input.operation.operation_id);
    const path = operationEvidencePath(input.session, ref);
    assertNoSymlinkSegments(join(input.session.state_root, 'worktrees', input.session.repo_key), path, 'operation evidence');
    const body = `${canonicalJson({
        schema_version: 'autopilot.worktree_operation_evidence.v1',
        operation_id: input.operation.operation_id,
        worktree_id: input.operation.worktree_id,
        owner: input.operation.owner,
        operation_type: input.operation.operation_type,
        terminal_stage: input.stage,
        completed_steps: input.operation.completed_steps,
        intent_sha256: `sha256:${createHash('sha256').update(canonicalJson(input.operation.intent), 'utf8').digest('hex')}`,
        proof: [...input.proof],
        error_code: input.errorCode,
    })}\n`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
        const handle = await open(path, 'wx', 0o600);
        try {
            await handle.writeFile(body, 'utf8');
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    }
    catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
            throw error;
        const existing = await readFile(path, 'utf8');
        if (existing !== body)
            throw new CoordinationRuntimeError('idempotency-conflict', 'immutable worktree operation evidence differs from the existing artifact', [path]);
    }
    return { ref, sha256: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}` };
}
function assertSessionOwnsSpec(session, spec) {
    if (session.repo_id !== spec.active.repo_key || session.repo_key !== spec.active.repo_key || session.autopilot_id !== spec.active.autopilot_id || session.workstream_run !== spec.active.workstream_run)
        throw new CoordinationRuntimeError('unauthorized-client', 'worktree saga session does not own the requested active run');
    if (spec.attempt < 1 || spec.unitId.length === 0)
        throw new CoordinationRuntimeError('invalid-request', 'worktree saga requires a durable unit attempt identity');
    if (resolve(spec.intent.repo_root) !== resolve(spec.active.source_repo) || resolve(spec.intent.git_common_dir) !== resolve(spec.active.git_common_dir))
        throw new CoordinationRuntimeError('unauthorized-client', 'worktree saga intent repository identity does not match the active run');
    const expectedPath = spec.kind === 'main'
        ? resolve(spec.active.main_worktree_path)
        : resolve(dirname(spec.active.main_worktree_path), 'units', spec.unitId, `attempt-${String(spec.attempt)}`, 'worktree');
    if (resolve(spec.intent.worktree_path) !== expectedPath)
        throw new CoordinationRuntimeError('unauthorized-client', 'worktree saga path is not derived from its durable owner', [spec.intent.worktree_path, expectedPath]);
}
async function durableRunExists(active, env) {
    const paths = coordinatorRuntimePaths(env);
    if (!existsSync(paths.databasePath))
        return false;
    const status = await new CoordinatorClient({ env }).query('status', active.repo_key, active.workstream_run);
    const runs = array(status.payload['runs'], 'coordinator status runs');
    if (runs.length > 1)
        throw new CoordinationRuntimeError('store-corrupt', 'coordinator returned duplicate durable runs');
    return runs.length === 1;
}
export class OwnedWorktreeSagaClient {
    #client;
    #session;
    constructor(client, session) {
        this.#client = client;
        this.#session = session;
    }
    static async fromEnvironment(env = process.env) {
        const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
        if (contextPath === undefined || contextPath.trim().length === 0)
            throw new CoordinationRuntimeError('unauthorized-client', `${AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV} is required for owner-scoped worktree operations`);
        const session = await readCoordinatorSessionContext(contextPath);
        return new OwnedWorktreeSagaClient(new CoordinatorClient({ env: { ...env, AUTOPILOT_STATE_ROOT: session.state_root } }), session);
    }
    get session() {
        return this.#session;
    }
    async operations() {
        const status = await this.#client.query('status', this.#session.repo_id, this.#session.workstream_run);
        return Object.freeze(array(status.payload['worktree_operations'], 'worktree_operations').map((entry) => parseCoordinationWorktreeOperation(entry)));
    }
    async worktrees() {
        const status = await this.#client.query('status', this.#session.repo_id, this.#session.workstream_run);
        return Object.freeze(array(status.payload['worktrees'], 'worktrees').map((entry) => parseCoordinationWorktree(entry)));
    }
    async prepare(spec) {
        assertSessionOwnsSpec(this.#session, spec);
        const owner = ownerFor(spec);
        const id = deterministicWorktreeId(owner, spec.kind);
        const proposed = {
            schema_version: 'autopilot.coordination_worktree.v2', worktree_id: id, owner, kind: spec.kind,
            canonical_path: resolve(spec.intent.worktree_path), git_common_dir: resolve(spec.intent.git_common_dir), branch: spec.intent.branch,
            state: spec.initialWorktreeState, version: 1,
        };
        const allWorktrees = await this.worktrees();
        const semantic = allWorktrees.filter((entry) => entry.state !== 'removed' && worktreeOwnerKindKey(entry) === worktreeOwnerKindKey(proposed));
        if (semantic.some((entry) => !sameWorktreeAuthority(entry, proposed)))
            throw new CoordinationRuntimeError('store-corrupt', 'active worktree owner/kind projections disagree in authority-bearing identity', semantic.map((entry) => entry.worktree_id));
        const deterministic = semantic.find((entry) => entry.worktree_id === id);
        const withHistory = new Set((await this.operations()).map((entry) => entry.worktree_id));
        const historical = semantic.filter((entry) => withHistory.has(entry.worktree_id));
        if (historical.length > 1)
            throw new CoordinationRuntimeError('recovery-required', 'duplicate active worktree projections carry multiple operation histories', historical.map((entry) => entry.worktree_id));
        // A terminal remove replay must retain the exact durable row/version even
        // though it is no longer an active semantic authority candidate.
        const existingWorktree = historical[0] ?? deterministic ?? semantic[0] ?? allWorktrees.find((entry) => entry.worktree_id === id);
        const worktree = existingWorktree ?? proposed;
        const opId = spec.operationId ?? operationId(owner, spec.operationType, spec.operationKey, spec.intent);
        const existing = (await this.operations()).find((entry) => entry.operation_id === opId);
        if (existing !== undefined) {
            if (!sameOwner(existing.owner, owner) || existing.worktree_id !== worktree.worktree_id || existing.operation_type !== spec.operationType || canonicalJson(existing.intent) !== canonicalJson(spec.intent))
                throw new CoordinationRuntimeError('idempotency-conflict', 'worktree operation key was reused with different immutable intent');
            return { operation: existing, worktree, replayed: true };
        }
        const operation = {
            schema_version: 'autopilot.worktree_operation.v2', operation_id: opId, worktree_id: worktree.worktree_id, owner,
            operation_type: spec.operationType, stage: 'prepared', authority_version: worktree.version, intent_event_seq: 0,
            intent: spec.intent, completed_steps: [], current_step: null, recovery_attempts: 0,
            verification_evidence: null, error_code: null, version: 1,
        };
        const response = await this.#client.mutate('prepare-operation', this.#identity(`prepare-operation:${opId}`, existingWorktree?.version ?? 0), {
            worktree, operation, ...this.#proof(),
        });
        return { operation: responseOperation(response), worktree: responseWorktree(response), replayed: false };
    }
    async transition(input) {
        const response = await this.#client.mutate('transition-operation', this.#identity(`transition-operation:${input.operation.operation_id}:${input.transitionKey}`, input.operation.version), {
            operation_id: input.operation.operation_id,
            stage: input.stage,
            completed_steps: [...input.completedSteps],
            current_step: input.currentStep,
            recovery_attempts: input.recoveryAttempts,
            verification_evidence: input.verificationEvidence,
            error_code: input.errorCode,
            worktree_state: input.worktreeState,
            ...this.#proof(),
        });
        return { operation: responseOperation(response), worktree: responseWorktree(response) };
    }
    async writeEvidence(operation, stage, proof, errorCode) {
        return await writeImmutableEvidence({ session: this.#session, operation, stage, proof, errorCode });
    }
    #identity(idempotencyKey, expectedVersion) {
        return {
            repoId: this.#session.repo_id, workstreamRun: this.#session.workstream_run, sessionId: this.#session.session_id,
            fencingGeneration: this.#session.session_generation, expectedVersion, idempotencyKey,
        };
    }
    #proof() {
        return { session_lease_id: this.#session.session_lease_id, session_token: this.#session.session_token };
    }
}
function errorCode(error) {
    if (error instanceof CoordinationRuntimeError)
        return error.code;
    if (error instanceof Error && 'code' in error && typeof error.code === 'string')
        return error.code.slice(0, 128);
    return 'git-partial-effect';
}
async function sagaExecutionLockIsStale(lockPath) {
    try {
        const parsed = record(JSON.parse(await readFile(lockPath, 'utf8')), 'saga execution lock');
        const pid = parsed['pid'];
        const bootId = parsed['boot_id'];
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || typeof bootId !== 'string')
            return true;
        // Never reclaim a lock while its PID is alive merely because boot evidence differs.
        return !isProcessAlive(pid);
    }
    catch {
        const lockStat = await stat(lockPath).catch(() => null);
        return lockStat !== null && Date.now() - lockStat.mtimeMs > 30_000;
    }
}
async function withSagaExecutionLock(session, spec, run) {
    const owner = ownerFor(spec);
    const lockRoot = join(session.state_root, 'worktrees', session.repo_key, '.locks');
    const lockPath = join(lockRoot, `${deterministicWorktreeId(owner, spec.kind)}.saga.lock`);
    const reclaimPath = `${lockPath}.reclaim`;
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 1_400; attempt += 1) {
        let acquiredLock = false;
        try {
            if (existsSync(reclaimPath)) {
                await new Promise((resolveWait) => setTimeout(resolveWait, 25));
                continue;
            }
            const handle = await open(lockPath, 'wx', 0o600);
            acquiredLock = true;
            const token = randomUUID();
            try {
                try {
                    await handle.writeFile(`${JSON.stringify({ schema_version: 'autopilot.saga_execution_lock.v1', pid: process.pid, boot_id: currentBootId(), token })}\n`, 'utf8');
                    await handle.sync();
                }
                finally {
                    await handle.close();
                }
            }
            catch (initializationError) {
                await unlink(lockPath).catch((cleanupError) => {
                    throw new CoordinationRuntimeError('system-fatal', 'saga lock initialization failed and its owned lock file could not be removed', [initializationError instanceof Error ? initializationError.message : String(initializationError), cleanupError instanceof Error ? cleanupError.message : String(cleanupError)]);
                });
                throw initializationError;
            }
            try {
                return await run();
            }
            finally {
                const current = await readFile(lockPath, 'utf8').catch(() => '');
                if (current.includes(token))
                    await unlink(lockPath);
                else
                    throw new CoordinationRuntimeError('system-fatal', 'worktree saga execution lock ownership changed before release', [lockPath]);
            }
        }
        catch (error) {
            if (acquiredLock || !(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
                throw error;
            let reclaimer = null;
            try {
                reclaimer = await open(reclaimPath, 'wx', 0o600);
                if (await sagaExecutionLockIsStale(lockPath))
                    await unlink(lockPath).catch((unlinkError) => {
                        if (!(unlinkError instanceof Error && 'code' in unlinkError && unlinkError.code === 'ENOENT'))
                            throw unlinkError;
                    });
            }
            catch (reclaimError) {
                if (!(reclaimError instanceof Error && 'code' in reclaimError && reclaimError.code === 'EEXIST'))
                    throw reclaimError;
            }
            finally {
                if (reclaimer !== null) {
                    await reclaimer.close();
                    await unlink(reclaimPath);
                }
            }
            await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        }
    }
    throw new CoordinationRuntimeError('coordinator-contention', 'timed out acquiring owner-scoped worktree saga execution lock', [lockPath]);
}
export async function executeOwnedWorktreeSaga(spec, callbacks, env = process.env) {
    const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    if (contextPath === undefined || contextPath.trim().length === 0) {
        if (coordinationCutoverCommitted(coordinatorRuntimePaths(env).stateRoot, spec.active.repo_key))
            throw new CoordinationRuntimeError('unauthorized-client', 'post-cutover worktree mutation requires a current durable coordinator session');
        if (spec.active.coordination_authority === 'coordinator-edit-leases-v1')
            throw new CoordinationRuntimeError('unauthorized-client', 'coordinator-authoritative run is missing its durable session; refusing unmanaged worktree mutation');
        if (await durableRunExists(spec.active, env))
            throw new CoordinationRuntimeError('unauthorized-client', 'durable run exists but no current session can authorize its worktree mutation');
        assertExternalWorktreeAuthority(spec, env, spec.active.worktree_root);
        const inspection = await callbacks.inspect();
        if (inspection.outcome === 'unsafe')
            throw new CoordinationRuntimeError('recovery-required', 'unmanaged legacy worktree operation found unsafe external state', inspection.proof);
        if (inspection.outcome === 'not-applied')
            await callbacks.action();
        await callbacks.verify();
        return { managed: false, operation: null, worktree: null, replayed: false };
    }
    const client = await OwnedWorktreeSagaClient.fromEnvironment(env);
    return await withSagaExecutionLock(client.session, spec, async () => {
        const prepared = await client.prepare(spec);
        let operation = prepared.operation;
        let worktree = prepared.worktree;
        assertExternalWorktreeAuthority(spec, env, join(client.session.state_root, 'worktrees', client.session.repo_key));
        if (operation.stage === 'committed') {
            await callbacks.verify();
            return { managed: true, operation, worktree, replayed: true };
        }
        if (operation.stage === 'compensated' || operation.stage === 'failed')
            throw new CoordinationRuntimeError('recovery-required', `worktree operation is terminal at ${operation.stage}`, [operation.operation_id]);
        if (operation.stage === 'verified') {
            const committed = await client.transition({
                operation, stage: 'committed', completedSteps: operation.completed_steps, currentStep: null,
                recoveryAttempts: operation.recovery_attempts, verificationEvidence: operation.verification_evidence, errorCode: null,
                worktreeState: spec.committedWorktreeState, transitionKey: `committed-${String(operation.version)}`,
            });
            return { managed: true, operation: committed.operation, worktree: committed.worktree, replayed: true };
        }
        let phase = 'prepared';
        try {
            await observeBoundary(callbacks, 'after-prepare');
            phase = 'preflight-probe';
            await observeBoundary(callbacks, 'before-probe');
            const inspection = await callbacks.inspect();
            await observeBoundary(callbacks, 'after-probe');
            if (inspection.outcome === 'unsafe')
                throw new CoordinationRuntimeError('recovery-required', 'worktree operation requires owned recovery before mutation', inspection.proof);
            if (operation.stage === 'prepared' || operation.stage === 'reconciling') {
                const preflightSteps = operation.completed_steps.includes('preflight-probe') ? operation.completed_steps : [...operation.completed_steps, 'preflight-probe'];
                phase = 'start-report';
                const started = await client.transition({
                    operation, stage: 'in-progress', completedSteps: preflightSteps, currentStep: 'external-action',
                    recoveryAttempts: operation.recovery_attempts + (operation.stage === 'reconciling' ? 1 : 0), verificationEvidence: null,
                    errorCode: null, worktreeState: worktree.state, transitionKey: `start-${String(operation.version)}`,
                });
                operation = started.operation;
                worktree = started.worktree;
                await observeBoundary(callbacks, 'after-start');
            }
            else if (operation.stage === 'in-progress' && !operation.completed_steps.includes('preflight-probe')) {
                phase = 'start-report';
                const probed = await client.transition({
                    operation, stage: 'in-progress', completedSteps: [...operation.completed_steps, 'preflight-probe'], currentStep: 'external-action',
                    recoveryAttempts: operation.recovery_attempts, verificationEvidence: null, errorCode: null, worktreeState: worktree.state,
                    transitionKey: `probe-${String(operation.version)}`,
                });
                operation = probed.operation;
                worktree = probed.worktree;
            }
            if (inspection.outcome === 'not-applied') {
                phase = 'external-action';
                await observeBoundary(callbacks, 'before-action');
                await callbacks.action();
                await observeBoundary(callbacks, 'after-action');
            }
            if (!operation.completed_steps.includes('external-action')) {
                phase = 'action-report';
                const acted = await client.transition({
                    operation, stage: 'in-progress', completedSteps: [...operation.completed_steps, 'external-action'], currentStep: 'postcondition-verification',
                    recoveryAttempts: operation.recovery_attempts, verificationEvidence: null, errorCode: null, worktreeState: worktree.state,
                    transitionKey: `action-${String(operation.version)}`,
                });
                operation = acted.operation;
                worktree = acted.worktree;
            }
            await observeBoundary(callbacks, 'after-action-report');
            phase = 'postcondition-verification';
            await observeBoundary(callbacks, 'before-verification');
            const proof = await callbacks.verify();
            await observeBoundary(callbacks, 'after-verification');
            phase = 'evidence-write';
            const evidence = await client.writeEvidence(operation, 'verified', proof, null);
            await observeBoundary(callbacks, 'after-evidence');
            const completedWithVerification = operation.completed_steps.includes('postcondition-verification') ? operation.completed_steps : [...operation.completed_steps, 'postcondition-verification'];
            phase = 'verified-report';
            const verified = await client.transition({
                operation, stage: 'verified', completedSteps: completedWithVerification, currentStep: null,
                recoveryAttempts: operation.recovery_attempts, verificationEvidence: evidence, errorCode: null, worktreeState: worktree.state,
                transitionKey: `verified-${String(operation.version)}`,
            });
            operation = verified.operation;
            worktree = verified.worktree;
            await observeBoundary(callbacks, 'after-verified-commit');
            phase = 'commit-report';
            const committed = await client.transition({
                operation, stage: 'committed', completedSteps: operation.completed_steps, currentStep: null,
                recoveryAttempts: operation.recovery_attempts, verificationEvidence: evidence, errorCode: null,
                worktreeState: spec.committedWorktreeState, transitionKey: `committed-${String(operation.version)}`,
            });
            await observeBoundary(callbacks, 'after-terminal-commit');
            return { managed: true, operation: committed.operation, worktree: committed.worktree, replayed: prepared.replayed };
        }
        catch (error) {
            if (error instanceof CoordinationRuntimeError && (error.code === 'fenced-session' || error.code === 'unauthorized-client' || error.code === 'stale-version'))
                throw error;
            if (error instanceof WorktreeSagaCompensatedError && !TERMINAL_STAGES.has(operation.stage) && operation.stage !== 'verified') {
                const evidence = await client.writeEvidence(operation, 'compensated', error.proof, 'git-partial-effect');
                await client.transition({
                    operation, stage: 'compensated', completedSteps: operation.completed_steps, currentStep: null,
                    recoveryAttempts: operation.recovery_attempts, verificationEvidence: evidence, errorCode: null,
                    worktreeState: worktree.state, transitionKey: `compensated-${String(operation.version)}`,
                });
                throw error;
            }
            if (!TERMINAL_STAGES.has(operation.stage) && operation.stage !== 'verified') {
                try {
                    await client.transition({
                        operation, stage: 'reconciling', completedSteps: operation.completed_steps, currentStep: phase,
                        recoveryAttempts: operation.recovery_attempts, verificationEvidence: operation.verification_evidence, errorCode: errorCode(error),
                        worktreeState: worktree.state, transitionKey: `reconciling-${String(operation.version)}-${phase}`,
                    });
                }
                catch (transitionError) {
                    throw phaseFailure(operation, phase, error, transitionError);
                }
            }
            throw phaseFailure(operation, phase, error);
        }
    });
}
function git(args, cwd, env, input) {
    const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env, AUTOPILOT_RUNTIME: '1', AUTOPILOT_RUNTIME_AUTHORITY: 'owned-worktree-saga', GIT_LFS_SKIP_SMUDGE: '1', GIT_AUTHOR_NAME: 'autopilot-runtime', GIT_AUTHOR_EMAIL: 'autopilot-runtime@example.invalid', GIT_COMMITTER_NAME: 'autopilot-runtime', GIT_COMMITTER_EMAIL: 'autopilot-runtime@example.invalid' }, ...(input === undefined ? {} : { input }) });
    if (result.error !== undefined)
        throw new CoordinationRuntimeError('git-partial-effect', `git ${args.join(' ')} failed to spawn`, [result.error.message]);
    if ((result.status ?? -1) !== 0)
        throw new CoordinationRuntimeError('git-partial-effect', `git ${args.join(' ')} exited with status ${String(result.status ?? -1)}`, [result.stderr.trim(), result.stdout.trim()]);
    return result.stdout.trim();
}
function canonicalPath(path) {
    let cursor = resolve(path);
    const missingSegments = [];
    while (!existsSync(cursor)) {
        const parent = dirname(cursor);
        if (parent === cursor)
            return resolve(path);
        missingSegments.unshift(basename(cursor));
        cursor = parent;
    }
    return resolve(realpathSync(cursor), ...missingSegments);
}
function worktreeEntries(repoRoot, env) {
    return git(['worktree', 'list', '--porcelain'], repoRoot, env).split('\n').filter((line) => line.startsWith('worktree ')).map((line) => canonicalPath(line.slice('worktree '.length)));
}
function registeredBranch(repoRoot, worktreePath, env) {
    const expected = canonicalPath(worktreePath);
    let currentPath = null;
    for (const line of git(['worktree', 'list', '--porcelain'], repoRoot, env).split('\n')) {
        if (line.startsWith('worktree '))
            currentPath = canonicalPath(line.slice('worktree '.length));
        else if (line.startsWith('branch ') && currentPath === expected)
            return line.slice('branch refs/heads/'.length);
    }
    return null;
}
function isRegistered(intent, env) {
    return worktreeEntries(intent.repo_root, env).includes(canonicalPath(intent.worktree_path));
}
function assertNoSymlinkSegments(ownedRoot, target, label) {
    const lexicalRoot = resolve(ownedRoot);
    const lexicalTarget = resolve(target);
    const ownedRelative = relative(lexicalRoot, lexicalTarget);
    if (ownedRelative === '' || ownedRelative.startsWith('..') || isAbsolute(ownedRelative) || ownedRelative.split(sep).includes('..'))
        throw new CoordinationRuntimeError('unauthorized-client', `${label} path escapes its package-owned state root`, [lexicalRoot, lexicalTarget]);
    let cursor = lexicalRoot;
    for (const segment of ownedRelative.split(sep)) {
        if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
            throw new CoordinationRuntimeError('recovery-required', `symlink substitution detected in ${label} path`, [cursor]);
        cursor = join(cursor, segment);
    }
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
        throw new CoordinationRuntimeError('recovery-required', `symlink substitution detected at ${label} path`, [cursor]);
}
function assertExternalWorktreeAuthority(spec, env, ownedWorktreeRoot) {
    const intent = spec.intent;
    assertNoSymlinkSegments(ownedWorktreeRoot, intent.worktree_path, 'worktree authority');
    const present = existsSync(intent.worktree_path);
    const registered = isRegistered(intent, env);
    const absentCreate = spec.operationType === 'create' && !present && !registered;
    const absentRemove = spec.operationType === 'remove' && !present;
    if (!absentCreate && !absentRemove && (!present || !registered))
        throw new CoordinationRuntimeError('recovery-required', 'external worktree path and Git registration disagree with durable authority', [`path_present=${String(present)}`, `git_registered=${String(registered)}`]);
    if (!present) {
        if (registered && registeredBranch(intent.repo_root, intent.worktree_path, env) !== intent.branch)
            throw new CoordinationRuntimeError('recovery-required', 'stale worktree metadata branch disagrees with durable authority', [intent.branch]);
        return;
    }
    const commonRaw = git(['rev-parse', '--git-common-dir'], intent.worktree_path, env);
    const actualCommon = canonicalPath(isAbsolute(commonRaw) ? commonRaw : resolve(intent.worktree_path, commonRaw));
    const expectedCommon = canonicalPath(intent.git_common_dir);
    if (actualCommon !== expectedCommon)
        throw new CoordinationRuntimeError('recovery-required', 'external worktree Git common-dir disagrees with durable repository authority', [`expected=${expectedCommon}`, `actual=${actualCommon}`]);
}
function changedPaths(path, env) {
    return git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], path, env).split('\0').filter((entry) => entry.length >= 4).map((entry) => entry.slice(3).replace(/\\/gu, '/')).sort();
}
function head(path, env) {
    return git(['rev-parse', 'HEAD'], path, env);
}
function branch(path, env) {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], path, env);
}
function fixedInspection(operation, env) {
    const intent = operation.intent;
    const present = existsSync(intent.worktree_path);
    const registered = isRegistered(intent, env);
    if (present !== registered) {
        if (operation.operation_type === 'remove' && !present && registered) {
            const metadataBranch = registeredBranch(intent.repo_root, intent.worktree_path, env);
            if (metadataBranch !== intent.branch)
                return { outcome: 'unsafe', proof: [`expected_metadata_branch=${intent.branch}`, `actual_metadata_branch=${String(metadataBranch)}`] };
        }
        else
            return { outcome: 'unsafe', proof: [`path_present=${String(present)}`, `git_registered=${String(registered)}`] };
    }
    if (operation.operation_type === 'create') {
        if (!present) {
            const branchCheck = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${intent.branch}`], { cwd: intent.repo_root, encoding: 'utf8' });
            if ((branchCheck.status ?? -1) !== 0)
                return { outcome: 'not-applied', proof: ['path_absent', 'git_registration_absent', 'branch_absent'] };
            const branchSha = git(['rev-parse', `refs/heads/${intent.branch}`], intent.repo_root, env);
            return branchSha === intent.base_sha ? { outcome: 'not-applied', proof: ['path_absent', 'git_registration_absent', 'branch_precreated_at_base'] } : { outcome: 'unsafe', proof: [`branch_expected=${String(intent.base_sha)}`, `branch_actual=${branchSha}`] };
        }
        if (branch(intent.worktree_path, env) !== intent.branch)
            return { outcome: 'unsafe', proof: ['registered_branch_mismatch'] };
        const currentHead = head(intent.worktree_path, env);
        if (intent.base_sha !== null && currentHead !== intent.base_sha)
            return { outcome: 'unsafe', proof: [`expected_head=${intent.base_sha}`, `actual_head=${currentHead}`] };
        if (intent.checkout_mode !== null && intent.checkout_mode !== 'full') {
            const sparse = spawnSync('git', ['config', '--bool', 'core.sparseCheckout'], { cwd: intent.worktree_path, encoding: 'utf8' });
            if ((sparse.status ?? -1) !== 0 || sparse.stdout.trim() !== 'true')
                return { outcome: 'not-applied', proof: ['worktree_registered', 'sparse_configuration_incomplete'] };
        }
        const taskRoot = operation.owner.unit_id === 'main'
            ? dirname(intent.worktree_path)
            : dirname(dirname(dirname(dirname(intent.worktree_path))));
        const missingMetadata = intent.metadata_refs.filter((ref) => !existsSync(resolve(taskRoot, ...ref.split('/'))));
        return missingMetadata.length === 0
            ? { outcome: 'satisfied', proof: ['worktree_registered', `head=${currentHead}`, ...(intent.metadata_refs.length > 0 ? ['operation_metadata_complete'] : [])] }
            : { outcome: 'not-applied', proof: ['worktree_registered', ...missingMetadata.map((ref) => `missing_metadata=${ref}`)] };
    }
    if (operation.operation_type === 'remove') {
        const branchCheck = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${intent.branch}`], { cwd: intent.repo_root, encoding: 'utf8' });
        const branchPresent = (branchCheck.status ?? -1) === 0;
        if (branchPresent && intent.target_sha !== null) {
            const branchSha = git(['rev-parse', `refs/heads/${intent.branch}`], intent.repo_root, env);
            if (branchSha !== intent.target_sha)
                return { outcome: 'unsafe', proof: [`branch_expected=${intent.target_sha}`, `branch_actual=${branchSha}`] };
        }
        if (!present)
            return branchPresent ? { outcome: 'not-applied', proof: ['path_absent', 'git_registration_absent', 'branch_present'] } : { outcome: 'satisfied', proof: ['path_absent', 'git_registration_absent', 'branch_absent'] };
        const dirty = changedPaths(intent.worktree_path, env);
        return dirty.length === 0 ? { outcome: 'not-applied', proof: ['worktree_clean'] } : { outcome: 'unsafe', proof: dirty.map((path) => `dirty=${path}`) };
    }
    if (!present)
        return { outcome: 'unsafe', proof: ['owned_worktree_missing'] };
    if (operation.operation_type === 'reset') {
        const dirty = changedPaths(intent.worktree_path, env);
        if (dirty.length > 0)
            return { outcome: 'unsafe', proof: dirty.map((path) => `uncaptured_dirty=${path}`) };
        const currentHead = head(intent.worktree_path, env);
        return intent.target_sha === null || currentHead === intent.target_sha ? { outcome: 'satisfied', proof: [`head=${currentHead}`, 'worktree_clean'] } : { outcome: 'unsafe', proof: [`expected_head=${intent.target_sha}`, `actual_head=${currentHead}`] };
    }
    if (operation.operation_type === 'archive') {
        if (intent.archive_ref === null || intent.target_sha === null)
            return { outcome: 'unsafe', proof: ['archive_intent_incomplete'] };
        const result = spawnSync('git', ['rev-parse', '--verify', `refs/heads/${intent.archive_ref}`], { cwd: intent.repo_root, encoding: 'utf8' });
        if ((result.status ?? -1) !== 0)
            return { outcome: 'not-applied', proof: ['archive_ref_absent'] };
        const actual = result.stdout.trim();
        return actual === intent.target_sha ? { outcome: 'satisfied', proof: [`archive_ref=${intent.archive_ref}`, `archive_sha=${actual}`] } : { outcome: 'unsafe', proof: [`archive_expected=${intent.target_sha}`, `archive_actual=${actual}`] };
    }
    if (operation.operation_type === 'merge' && intent.archive_ref !== null && intent.target_sha !== null && intent.base_sha !== null) {
        const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], intent.repo_root, env);
        const currentHead = head(intent.repo_root, env);
        if (currentBranch !== intent.archive_ref)
            return { outcome: 'unsafe', proof: [`expected_target_branch=${intent.archive_ref}`, `actual_branch=${currentBranch}`] };
        if (currentHead === intent.target_sha)
            return { outcome: 'satisfied', proof: [`target_head=${currentHead}`] };
        return currentHead === intent.base_sha ? { outcome: 'not-applied', proof: [`target_head=${currentHead}`] } : { outcome: 'unsafe', proof: [`expected_before=${intent.base_sha}`, `actual_head=${currentHead}`] };
    }
    if (operation.operation_type === 'merge' && intent.target_sha !== null && intent.base_sha !== null) {
        const mergeHeadPath = git(['rev-parse', '--git-path', 'MERGE_HEAD'], intent.worktree_path, env);
        const currentHead = head(intent.worktree_path, env);
        if (existsSync(isAbsolute(mergeHeadPath) ? mergeHeadPath : resolve(intent.worktree_path, mergeHeadPath)))
            return currentHead === intent.base_sha
                ? { outcome: 'not-applied', proof: ['interrupted_merge_conflict', `head=${currentHead}`] }
                : { outcome: 'unsafe', proof: ['interrupted_merge_head_moved', `expected_head=${intent.base_sha}`, `actual_head=${currentHead}`] };
        if (changedPaths(intent.worktree_path, env).length > 0)
            return { outcome: 'unsafe', proof: ['merge_target_dirty_without_owned_merge_state'] };
        if (currentHead === intent.base_sha) {
            const alreadyAncestor = spawnSync('git', ['merge-base', '--is-ancestor', intent.target_sha, currentHead], { cwd: intent.worktree_path, encoding: 'utf8' });
            return (alreadyAncestor.status ?? -1) === 0 ? { outcome: 'satisfied', proof: [`merged_source=${intent.target_sha}`, `head=${currentHead}`, 'worktree_clean'] } : { outcome: 'not-applied', proof: [`head=${currentHead}`, 'worktree_clean'] };
        }
        const parents = git(['rev-list', '--parents', '-n', '1', currentHead], intent.worktree_path, env).split(/\s+/u).slice(1);
        return parents.includes(intent.base_sha) && parents.includes(intent.target_sha)
            ? { outcome: 'satisfied', proof: [`merged_source=${intent.target_sha}`, `head=${currentHead}`, `base_parent=${intent.base_sha}`, 'worktree_clean'] }
            : { outcome: 'unsafe', proof: [`expected_base_parent=${intent.base_sha}`, `expected_source_parent=${intent.target_sha}`, `actual_head=${currentHead}`, ...parents.map((parent) => `actual_parent=${parent}`)] };
    }
    if (operation.operation_type === 'commit' || operation.operation_type === 'quarantine') {
        const currentHead = head(intent.worktree_path, env);
        const dirty = changedPaths(intent.worktree_path, env);
        if (dirty.length > 0)
            return { outcome: 'not-applied', proof: dirty.map((path) => `dirty=${path}`) };
        if (intent.target_sha !== null)
            return currentHead === intent.target_sha ? { outcome: 'satisfied', proof: [`head=${currentHead}`, 'worktree_clean'] } : { outcome: 'unsafe', proof: [`expected_head=${intent.target_sha}`, `actual_head=${currentHead}`] };
        if (intent.base_sha === null || currentHead === intent.base_sha)
            return operation.operation_type === 'quarantine' && intent.paths.length === 0 ? { outcome: 'satisfied', proof: [`head=${currentHead}`, 'worktree_clean'] } : { outcome: 'not-applied', proof: [`head=${currentHead}`, 'worktree_clean'] };
        const parents = git(['rev-list', '--parents', '-n', '1', currentHead], intent.worktree_path, env).split(/\s+/u).slice(1);
        const actualPaths = git(['diff', '--name-only', intent.base_sha, currentHead, '--'], intent.worktree_path, env).split('\n').filter((path) => path.length > 0).sort((left, right) => left.localeCompare(right));
        const expectedPaths = [...intent.paths].sort((left, right) => left.localeCompare(right));
        const exactPaths = actualPaths.length === expectedPaths.length && actualPaths.every((path, index) => path === expectedPaths[index]);
        const baseRelation = spawnSync('git', ['merge-base', '--is-ancestor', intent.base_sha, currentHead], { cwd: intent.worktree_path, encoding: 'utf8' });
        const expectedHistory = operation.operation_type === 'commit' ? (baseRelation.status ?? -1) === 0 : parents.length === 1 && parents[0] === intent.base_sha;
        return expectedHistory && exactPaths
            ? { outcome: 'satisfied', proof: [`head=${currentHead}`, `base=${intent.base_sha}`, ...actualPaths.map((path) => `committed=${path}`), 'worktree_clean'] }
            : { outcome: 'unsafe', proof: [`expected_base=${intent.base_sha}`, ...parents.map((parent) => `actual_parent=${parent}`), ...expectedPaths.map((path) => `expected_path=${path}`), ...actualPaths.map((path) => `actual_path=${path}`)] };
    }
    if (operation.operation_type === 'materialize') {
        const sparse = spawnSync('git', ['config', '--bool', 'core.sparseCheckout'], { cwd: intent.worktree_path, encoding: 'utf8' });
        if ((sparse.status ?? -1) !== 0 || sparse.stdout.trim() !== 'true')
            return { outcome: 'unsafe', proof: ['sparse_checkout_disabled'] };
        const missing = [];
        const lfsPointers = [];
        for (const path of intent.paths) {
            const result = spawnSync('git', ['ls-files', '-t', '--', path], { cwd: intent.worktree_path, encoding: 'utf8' });
            if ((result.status ?? -1) !== 0 || result.stdout.split('\n').some((line) => line.startsWith('S '))) {
                missing.push(path);
                continue;
            }
            for (const line of result.stdout.split('\n').filter((entry) => entry.length > 2 && !entry.startsWith('S '))) {
                const trackedPath = line.slice(2);
                const absolute = resolve(intent.worktree_path, ...trackedPath.split('/'));
                if (!existsSync(absolute)) {
                    if (!missing.includes(path))
                        missing.push(path);
                    continue;
                }
                const fileInfo = lstatSync(absolute);
                if (!fileInfo.isFile() || fileInfo.size > 1_024)
                    continue;
                if (readFileSync(absolute).subarray(0, 256).toString().startsWith('version https://git-lfs.github.com/spec/v1'))
                    lfsPointers.push(trackedPath);
            }
        }
        if (lfsPointers.length > 0)
            return { outcome: 'unsafe', proof: lfsPointers.map((path) => `lfs_pointer=${path}`) };
        return missing.length === 0 ? { outcome: 'satisfied', proof: ['sparse_checkout_enabled', ...intent.paths.map((path) => `materialized=${path}`), 'lfs_pointer_check_passed'] } : { outcome: 'not-applied', proof: missing.map((path) => `skip_worktree=${path}`) };
    }
    return { outcome: 'not-applied', proof: ['postcondition_not_yet_satisfied'] };
}
function fixedAction(operation, env) {
    const intent = operation.intent;
    switch (operation.operation_type) {
        case 'create': {
            if (intent.base_sha === null || intent.checkout_mode === null)
                throw new CoordinationRuntimeError('invalid-state', 'create operation intent lacks base_sha or checkout_mode');
            const branchCheck = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${intent.branch}`], { cwd: intent.repo_root, encoding: 'utf8' });
            const branchExists = (branchCheck.status ?? -1) === 0;
            const registered = isRegistered(intent, env);
            if (!registered && intent.checkout_mode === 'full')
                git(branchExists ? ['worktree', 'add', intent.worktree_path, intent.branch] : ['worktree', 'add', '-b', intent.branch, intent.worktree_path, intent.base_sha], intent.repo_root, env);
            else if (!registered)
                git(branchExists ? ['worktree', 'add', '--no-checkout', intent.worktree_path, intent.branch] : ['worktree', 'add', '--no-checkout', '-b', intent.branch, intent.worktree_path, intent.base_sha], intent.repo_root, env);
            if (intent.checkout_mode !== 'full') {
                if (intent.sparse_patterns.length === 0)
                    throw new CoordinationRuntimeError('invalid-state', 'sparse create operation lacks patterns');
                git(['sparse-checkout', 'set', '--no-cone', '--skip-checks', '--stdin'], intent.worktree_path, env, `${intent.sparse_patterns.join('\n')}\n`);
                git(['checkout', '--force', intent.branch], intent.worktree_path, env);
            }
            return;
        }
        case 'materialize':
            if (intent.sparse_patterns.length > 0)
                git(['sparse-checkout', 'add', '--skip-checks', '--stdin'], intent.worktree_path, env, `${intent.sparse_patterns.join('\n')}\n`);
            for (const path of intent.paths) {
                const normalized = path.replace(/\/\*\*$/u, '');
                const target = resolve(intent.worktree_path, ...normalized.split('/'));
                mkdirSync(path.endsWith('/**') ? target : dirname(target), { recursive: true });
            }
            return;
        case 'commit':
        case 'quarantine':
            if (changedPaths(intent.worktree_path, env).length === 0)
                return;
            git(['add', '--sparse', '-A', '--', ...intent.paths], intent.worktree_path, env);
            git(['commit', '--no-verify', '-m', `${operation.operation_type} ${operation.owner.workstream_run} ${operation.owner.unit_id} attempt ${String(operation.owner.attempt)}`], intent.worktree_path, env);
            return;
        case 'merge':
            if (intent.target_sha === null)
                throw new CoordinationRuntimeError('invalid-state', 'merge operation intent lacks target_sha');
            if (fixedInspection(operation, env).outcome !== 'satisfied') {
                if (intent.archive_ref !== null)
                    git(['merge', '--ff-only', intent.target_sha], intent.repo_root, env);
                else {
                    const mergeHeadPath = git(['rev-parse', '--git-path', 'MERGE_HEAD'], intent.worktree_path, env);
                    if (existsSync(isAbsolute(mergeHeadPath) ? mergeHeadPath : resolve(intent.worktree_path, mergeHeadPath))) {
                        if (intent.base_sha === null || head(intent.worktree_path, env) !== intent.base_sha)
                            throw new CoordinationRuntimeError('recovery-required', 'interrupted merge cannot be safely compensated because target HEAD moved');
                        git(['merge', '--abort'], intent.worktree_path, env);
                        throw new WorktreeSagaCompensatedError('interrupted conflicting merge was restored to its exact pre-merge HEAD', [`base_head=${intent.base_sha}`, `source_head=${intent.target_sha}`]);
                    }
                    git(['merge', '--no-ff', '--no-edit', '-m', `autopilot saga merge ${operation.owner.workstream_run} ${operation.owner.unit_id}`, intent.target_sha], intent.worktree_path, env);
                }
            }
            return;
        case 'reset':
            git(['reset', '--hard', intent.target_sha ?? 'HEAD'], intent.worktree_path, env);
            return;
        case 'archive':
            if (intent.archive_ref === null || intent.target_sha === null)
                throw new CoordinationRuntimeError('invalid-state', 'archive operation intent lacks ref or target');
            git(['update-ref', `refs/heads/${intent.archive_ref}`, intent.target_sha, '0'.repeat(40)], intent.repo_root, env);
            return;
        case 'remove':
            if (existsSync(intent.worktree_path)) {
                if (changedPaths(intent.worktree_path, env).length > 0)
                    throw new CoordinationRuntimeError('recovery-required', 'dirty worktree cannot be removed; quarantine capture is required first', intent.paths);
                git(['worktree', 'remove', intent.worktree_path], intent.repo_root, env);
            }
            else if (isRegistered(intent, env)) {
                git(['worktree', 'remove', intent.worktree_path], intent.repo_root, env);
            }
            {
                const branchCheck = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${intent.branch}`], { cwd: intent.repo_root, encoding: 'utf8' });
                if ((branchCheck.status ?? -1) === 0) {
                    if (intent.target_sha !== null && git(['rev-parse', `refs/heads/${intent.branch}`], intent.repo_root, env) !== intent.target_sha)
                        throw new CoordinationRuntimeError('recovery-required', 'owned branch moved after operation intent; refusing retirement', [intent.branch]);
                    if (intent.target_sha === null)
                        throw new CoordinationRuntimeError('invalid-state', 'remove operation intent lacks the expected branch SHA');
                    git(['update-ref', '-d', `refs/heads/${intent.branch}`, intent.target_sha], intent.repo_root, env);
                }
            }
            return;
    }
}
function missingOperationMetadata(operation) {
    if (operation.intent.metadata_refs.length === 0)
        return [];
    const taskRoot = operation.owner.unit_id === 'main'
        ? dirname(operation.intent.worktree_path)
        : dirname(dirname(dirname(dirname(operation.intent.worktree_path))));
    const worktreeRoot = dirname(dirname(taskRoot));
    const taskInfoPath = join(taskRoot, '_task-info.json');
    let runtimeRoot = null;
    if (existsSync(taskInfoPath)) {
        try {
            const taskInfo = record(JSON.parse(readFileSync(taskInfoPath, 'utf8')), 'task info for operation metadata recovery');
            runtimeRoot = typeof taskInfo['runtime_root'] === 'string' ? taskInfo['runtime_root'] : null;
        }
        catch {
            runtimeRoot = null;
        }
    }
    return operation.intent.metadata_refs.filter((ref) => ![resolve(taskRoot, ref), resolve(worktreeRoot, ref), ...(runtimeRoot === null ? [] : [resolve(runtimeRoot, ref)])].some((candidate) => existsSync(candidate)));
}
function fixedVerify(operation, env) {
    const inspected = fixedInspection(operation, env);
    if (inspected.outcome !== 'satisfied')
        throw new CoordinationRuntimeError('git-partial-effect', 'worktree operation postcondition is not satisfied', inspected.proof);
    const missingMetadata = missingOperationMetadata(operation);
    if (missingMetadata.length > 0)
        throw new CoordinationRuntimeError('git-partial-effect', 'worktree operation metadata postcondition is not satisfied', missingMetadata.map((ref) => `missing_metadata=${ref}`));
    const intent = operation.intent;
    if (existsSync(intent.worktree_path)) {
        const actualCommon = resolve(git(['rev-parse', '--git-common-dir'], intent.worktree_path, env).startsWith('/') ? git(['rev-parse', '--git-common-dir'], intent.worktree_path, env) : join(intent.worktree_path, git(['rev-parse', '--git-common-dir'], intent.worktree_path, env)));
        const expectedCommon = existsSync(intent.git_common_dir) ? realpathSync(intent.git_common_dir) : resolve(intent.git_common_dir);
        const normalizedActual = existsSync(actualCommon) ? realpathSync(actualCommon) : actualCommon;
        if (normalizedActual !== expectedCommon)
            throw new CoordinationRuntimeError('unauthorized-client', 'worktree Git common-dir identity does not match durable authority', [normalizedActual, expectedCommon]);
    }
    return inspected.proof;
}
export async function ensureMainWorktreeSagaRegistered(input) {
    const env = input.env ?? process.env;
    const active = input.active;
    const client = await OwnedWorktreeSagaClient.fromEnvironment(env);
    const registered = (await client.operations()).filter((operation) => operation.operation_type === 'create' && operation.owner.unit_id === 'main' && operation.owner.attempt === 1 && operation.intent.worktree_path === active.main_worktree_path);
    if (registered.length > 1)
        throw new CoordinationRuntimeError('store-corrupt', 'durable run has duplicate main worktree create operations');
    if (registered.length === 1) {
        const existing = registered[0];
        if (existing === undefined)
            throw new CoordinationRuntimeError('store-corrupt', 'main worktree operation disappeared');
        if (existing.stage !== 'committed')
            throw new CoordinationRuntimeError('recovery-required', 'main worktree create operation must recover before registration can complete', [existing.operation_id, existing.stage]);
        return existing;
    }
    const inspect = () => {
        if (!existsSync(active.main_worktree_path))
            return { outcome: 'unsafe', proof: ['main_worktree_missing'] };
        const intent = {
            repo_root: active.source_repo, worktree_path: active.main_worktree_path, git_common_dir: active.git_common_dir, branch: active.branch,
            reason: 'register existing package-created main worktree with durable saga authority', base_sha: active.target_base_sha, target_sha: null,
            archive_ref: null, checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [],
        };
        if (!isRegistered(intent, env))
            return { outcome: 'unsafe', proof: ['main_worktree_not_git_registered'] };
        const actualBranch = branch(active.main_worktree_path, env);
        return actualBranch === active.branch ? { outcome: 'satisfied', proof: ['main_worktree_registered', `branch=${actualBranch}`, `head=${head(active.main_worktree_path, env)}`] } : { outcome: 'unsafe', proof: [`expected_branch=${active.branch}`, `actual_branch=${actualBranch}`] };
    };
    const result = await executeOwnedWorktreeSaga({
        active, unitId: 'main', attempt: 1, kind: 'main', operationType: 'create',
        operationKey: `main-create:${active.workstream_run}:${active.target_base_sha}`,
        initialWorktreeState: 'planned', committedWorktreeState: 'active',
        intent: {
            repo_root: active.source_repo, worktree_path: active.main_worktree_path, git_common_dir: active.git_common_dir, branch: active.branch,
            reason: 'register package-created main worktree with durable owner authority', base_sha: active.target_base_sha, target_sha: null,
            archive_ref: null, checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: ['_task-info.json', '_branches.json', '_unit-index.json'],
        },
    }, {
        inspect,
        action: () => { throw new CoordinationRuntimeError('recovery-required', 'main worktree creation did not reach durable registration; bootstrap recovery evidence is required'); },
        verify: () => {
            const inspected = inspect();
            if (inspected.outcome !== 'satisfied')
                throw new CoordinationRuntimeError('recovery-required', 'main worktree registration postcondition failed', inspected.proof);
            return inspected.proof;
        },
    }, env);
    if (result.operation === null)
        throw new CoordinationRuntimeError('invalid-state', 'durable main worktree registration unexpectedly used an unmanaged path');
    return result.operation;
}
export async function recoverOwnedWorktreeSagas(input) {
    const env = input.env ?? process.env;
    const client = await OwnedWorktreeSagaClient.fromEnvironment(env);
    if (client.session.repo_id !== input.active.repo_key || client.session.autopilot_id !== input.active.autopilot_id || client.session.workstream_run !== input.active.workstream_run)
        throw new CoordinationRuntimeError('unauthorized-client', 'worktree saga recovery session does not own the active run');
    const recovered = [];
    for (const candidate of await client.operations()) {
        if (TERMINAL_STAGES.has(candidate.stage))
            continue;
        const worktree = (await client.worktrees()).find((entry) => entry.worktree_id === candidate.worktree_id);
        if (worktree === undefined || !sameOwner(worktree.owner, candidate.owner))
            throw new CoordinationRuntimeError('store-corrupt', 'recoverable operation lacks exact worktree ownership', [candidate.operation_id]);
        const spec = {
            active: input.active, unitId: candidate.owner.unit_id, attempt: candidate.owner.attempt, kind: worktree.kind,
            operationType: candidate.operation_type, intent: candidate.intent, operationKey: `recovery:${candidate.operation_id}`, operationId: candidate.operation_id,
            initialWorktreeState: worktree.state,
            committedWorktreeState: candidate.operation_type === 'remove' ? 'removed'
                : candidate.operation_type === 'quarantine' ? 'quarantined'
                    : candidate.operation_type === 'reset' || candidate.operation_type === 'archive' ? 'terminal'
                        : worktree.state === 'planned' ? 'active' : worktree.state,
        };
        const result = await executeOwnedWorktreeSaga(spec, {
            inspect: () => fixedInspection(candidate, env),
            action: () => fixedAction(candidate, env),
            verify: () => fixedVerify(candidate, env),
        }, env);
        if (result.operation !== null)
            recovered.push(result.operation);
    }
    return Object.freeze(recovered);
}
export function fixedWorktreeSagaCallbacks(operation, env = process.env) {
    return {
        inspect: () => fixedInspection(operation, env),
        action: () => fixedAction(operation, env),
        verify: () => fixedVerify(operation, env),
    };
}
