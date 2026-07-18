import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CoordinatorClient } from "./client.js";
import { parseCoordinationWorktree, parseCoordinationWorktreeOperation } from "./contracts.js";
import { CoordinationRuntimeError } from "./failures.js";
import { canonicalJson } from "./canonical-json.js";
import { readImmutableFileBytes } from "./immutable-file.js";
import { coordinationCutoverCommitted } from "./migration-paths.js";
import { coordinatorRuntimePaths } from "./runtime-paths.js";
import { currentBootId, isProcessAlive } from "./process-identity.js";
import { readCoordinatorSessionContext } from "./supervisor.js";
import { deterministicWorktreeId, sameWorktreeAuthority, worktreeOwnerKindKey } from "./worktree-identity.js";
import { deriveWorktreeOperationKeyV2, operationIdFromWorktreeOperationKey } from "./worktree-operation-identity.js";
import { gitWorktreeRegistrationFacts, inspectWorktreePostcondition } from "./worktree-postconditions.js";
import { gitQueryText, runGitMutation, runGitQuery } from "../git-process.js";
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
function ownerFor(spec) {
    return {
        repo_id: spec.active.repo_key,
        autopilot_id: spec.active.autopilot_id,
        workstream_run: spec.active.workstream_run,
        unit_id: spec.kind === 'main' ? 'main' : spec.unitId,
        attempt: spec.kind === 'main' ? 1 : spec.attempt,
    };
}
function operationEvidenceRef(owner, id) {
    return `_saga-evidence/${owner.workstream_run}/${id}.json`;
}
function operationEvidencePath(session, ref) {
    return join(session.state_root, 'worktrees', session.repo_key, ...ref.split('/'));
}
async function assertImmutableEvidenceBytes(path, expected) {
    const actual = new TextDecoder('utf-8', { fatal: true }).decode(readImmutableFileBytes({ path, maximumBytes: 1024 * 1024, label: 'worktree operation evidence' }));
    if (actual !== expected)
        throw new CoordinationRuntimeError('idempotency-conflict', 'immutable worktree operation evidence differs from the existing artifact', [path]);
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
        proof_source: input.proofSource,
        capture_sha: input.captureSha,
        error_code: input.errorCode,
    })}\n`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    assertNoSymlinkSegments(join(input.session.state_root, 'worktrees', input.session.repo_key), path, 'operation evidence');
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
        assertNoSymlinkSegments(join(input.session.state_root, 'worktrees', input.session.repo_key), path, 'operation evidence');
        await assertImmutableEvidenceBytes(path, body);
    }
    assertNoSymlinkSegments(join(input.session.state_root, 'worktrees', input.session.repo_key), path, 'operation evidence');
    await assertImmutableEvidenceBytes(path, body);
    return { ref, sha256: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}` };
}
function assertSpecMatchesActiveAuthority(spec) {
    if (spec.attempt < 1 || spec.unitId.length === 0 || (spec.kind === 'main' && spec.unitId !== 'main') || (spec.kind === 'unit' && spec.unitId === 'main'))
        throw new CoordinationRuntimeError('invalid-request', 'worktree saga requires a durable unit attempt identity and reserves unit ID main for the main worktree');
    if (resolve(spec.intent.repo_root) !== resolve(spec.active.source_repo) || resolve(spec.intent.git_common_dir) !== resolve(spec.active.git_common_dir))
        throw new CoordinationRuntimeError('unauthorized-client', 'worktree saga intent repository identity does not match the active run');
    const expectedPath = spec.kind === 'main'
        ? resolve(spec.active.main_worktree_path)
        : resolve(dirname(spec.active.main_worktree_path), 'units', spec.unitId, `attempt-${String(spec.attempt)}`, 'worktree');
    if (resolve(spec.intent.worktree_path) !== expectedPath)
        throw new CoordinationRuntimeError('unauthorized-client', 'worktree saga path is not derived from its durable owner', [spec.intent.worktree_path, expectedPath]);
    const expectedBranch = spec.kind === 'main' ? spec.active.branch : `autopilot/unit/${spec.active.workstream_run}/${spec.unitId}/attempt-${String(spec.attempt)}`;
    if (spec.intent.branch !== expectedBranch)
        throw new CoordinationRuntimeError('unauthorized-client', 'worktree saga branch is not derived from its durable owner', [spec.intent.branch, expectedBranch]);
}
function assertSessionOwnsSpec(session, spec) {
    assertSpecMatchesActiveAuthority(spec);
    if (session.repo_id !== spec.active.repo_key || session.repo_key !== spec.active.repo_key || session.autopilot_id !== spec.active.autopilot_id || session.workstream_run !== spec.active.workstream_run)
        throw new CoordinationRuntimeError('unauthorized-client', 'worktree saga session does not own the requested active run');
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
        const allOperations = await this.operations();
        const operationKey = deriveWorktreeOperationKeyV2({ canonicalWorktreeId: id, operationType: spec.operationType, completeImmutableIntent: spec.intent });
        const canonicalOperationId = operationIdFromWorktreeOperationKey(operationKey);
        if (spec.operationId !== undefined && !allOperations.some((entry) => entry.operation_id === spec.operationId))
            throw new CoordinationRuntimeError('invalid-request', 'caller-supplied worktree operation ID is allowed only to resume an existing historical operation', [spec.operationId, canonicalOperationId]);
        const opId = spec.operationId ?? canonicalOperationId;
        const exactExisting = allOperations.find((entry) => entry.operation_id === opId);
        const semanticExisting = allOperations.filter((entry) => operationKind(entry.owner) === spec.kind
            && sameOwner(entry.owner, owner)
            && entry.operation_type === spec.operationType
            && canonicalJson(entry.intent) === canonicalJson(spec.intent));
        if (semanticExisting.length > 1)
            throw new CoordinationRuntimeError('recovery-required', 'multiple historical operations match one canonical operation-key v2 identity', semanticExisting.map((entry) => entry.operation_id));
        const existing = exactExisting ?? (spec.operationId === undefined ? semanticExisting[0] : undefined);
        const semantic = allWorktrees.filter((entry) => worktreeOwnerKindKey(entry) === worktreeOwnerKindKey(proposed));
        if (semantic.length > 1)
            throw new CoordinationRuntimeError('recovery-required', 'multiple current worktree projections match one canonical semantic identity', semantic.map((entry) => entry.worktree_id));
        if (semantic.some((entry) => !sameWorktreeAuthority(entry, proposed)))
            throw new CoordinationRuntimeError('store-corrupt', 'current worktree projection disagrees in authority-bearing identity', semantic.map((entry) => entry.worktree_id));
        const canonicalProjection = allWorktrees.find((entry) => entry.worktree_id === id);
        const operationWorktree = existing === undefined ? undefined : canonicalProjection ?? semantic[0] ?? allWorktrees.find((entry) => entry.worktree_id === existing.worktree_id);
        if (existing !== undefined && operationWorktree === undefined)
            throw new CoordinationRuntimeError('store-corrupt', 'existing worktree operation has no current canonical semantic projection', [existing.operation_id, existing.worktree_id, id]);
        if (operationWorktree !== undefined && !sameWorktreeAuthority(operationWorktree, proposed))
            throw new CoordinationRuntimeError('store-corrupt', 'historical operation worktree authority differs from canonical semantic ownership', [operationWorktree.worktree_id, id]);
        // Replays preserve the operation's immutable historical payload ID. New
        // operations route through the canonical semantic projection selected by
        // the schema-13 store/alias layer. The raw-ID fallback is only for a
        // pre-schema-13 historical projection when no canonical projection exists.
        const existingWorktree = operationWorktree ?? canonicalProjection ?? semantic[0];
        const worktree = existingWorktree ?? proposed;
        if (existing !== undefined) {
            if (!sameOwner(existing.owner, owner) || existing.operation_type !== spec.operationType || canonicalJson(existing.intent) !== canonicalJson(spec.intent))
                throw new CoordinationRuntimeError('idempotency-conflict', 'worktree operation key was reused with different immutable intent');
            return { operation: existing, worktree, replayed: true };
        }
        const operation = {
            schema_version: 'autopilot.worktree_operation.v2', operation_id: opId, worktree_id: worktree.worktree_id, owner,
            operation_type: spec.operationType, stage: 'prepared', authority_version: worktree.version, intent_event_seq: 0,
            intent: spec.intent, completed_steps: [], current_step: null, recovery_attempts: 0,
            verification_evidence: null, error_code: null, version: 1,
        };
        const response = await this.#client.mutate('prepare-operation', this.#identity(operationKey.operation_key_sha256, existingWorktree?.version ?? 0), {
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
    async writeEvidence(operation, stage, inspection, proof, errorCode) {
        return await writeImmutableEvidence({ session: this.#session, operation, stage, proof, proofSource: inspection?.proof_source ?? null, captureSha: inspection?.capture_sha ?? null, errorCode });
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
function operationKind(owner) {
    return owner.unit_id === 'main' ? 'main' : 'unit';
}
function inspectOperation(operation, env) {
    if (operation.operation_type === 'metadata-reconcile')
        throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation uses its dedicated exact-set runtime', [operation.operation_id]);
    const kind = operationKind(operation.owner);
    return inspectWorktreePostcondition({
        operationType: operation.operation_type,
        owner: operation.owner,
        kind,
        canonicalWorktreeId: deterministicWorktreeId(operation.owner, kind),
        intent: operation.intent,
        durableStage: operation.stage,
        env,
    });
}
function operationTypeSet(...values) {
    return new Set(values);
}
const COMMITTED_SUPERSEDING_OPERATIONS = Object.freeze({
    create: operationTypeSet('materialize', 'commit', 'merge', 'reset', 'quarantine', 'remove'),
    materialize: operationTypeSet('remove'),
    commit: operationTypeSet('commit', 'merge', 'reset', 'quarantine', 'remove'),
    merge: operationTypeSet('commit', 'merge', 'reset', 'quarantine', 'remove'),
    reset: operationTypeSet('commit', 'merge', 'quarantine', 'remove'),
    quarantine: operationTypeSet('remove'),
    archive: operationTypeSet(),
    remove: operationTypeSet(),
    'metadata-reconcile': operationTypeSet(),
});
async function inspectCommittedOperation(client, operation, env) {
    const direct = inspectOperation(operation, env);
    if (direct.outcome === 'satisfied')
        return direct;
    const supersedingTypes = COMMITTED_SUPERSEDING_OPERATIONS[operation.operation_type];
    const later = (await client.operations()).filter((candidate) => candidate.stage === 'committed'
        && candidate.intent_event_seq > operation.intent_event_seq
        && sameOwner(candidate.owner, operation.owner)
        && supersedingTypes.has(candidate.operation_type))
        .sort((left, right) => right.intent_event_seq - left.intent_event_seq);
    for (const candidate of later) {
        const current = inspectOperation(candidate, env);
        if (current.outcome !== 'satisfied')
            continue;
        return Object.freeze({
            outcome: 'satisfied',
            proof: Object.freeze([`historical_operation_superseded_by=${candidate.operation_id}`, `superseding_operation_type=${candidate.operation_type}`, ...current.proof]),
            effect_applied: true,
            capture_sha: null,
            proof_source: current.proof_source,
        });
    }
    return direct;
}
export function inspectOwnedWorktreeSpecPostcondition(spec, env) {
    const owner = ownerFor(spec);
    return inspectWorktreePostcondition({ operationType: spec.operationType, owner, kind: spec.kind, canonicalWorktreeId: deterministicWorktreeId(owner, spec.kind), intent: spec.intent, env });
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
        const bytes = readImmutableFileBytes({ path: lockPath, maximumBytes: 4_096, label: 'worktree saga execution lock' });
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            return false;
        const pid = Reflect.get(parsed, 'pid');
        const bootId = Reflect.get(parsed, 'boot_id');
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || typeof bootId !== 'string')
            return false;
        // Never reclaim malformed/ambiguous evidence or a live PID from elapsed time.
        return !isProcessAlive(pid);
    }
    catch {
        return false;
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
            const lockBody = `${JSON.stringify({ schema_version: 'autopilot.saga_execution_lock.v1', pid: process.pid, boot_id: currentBootId(), token })}\n`;
            try {
                try {
                    await handle.writeFile(lockBody, 'utf8');
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
                let current;
                try {
                    current = new TextDecoder('utf-8', { fatal: true }).decode(readImmutableFileBytes({ path: lockPath, maximumBytes: 4_096, label: 'worktree saga execution lock' }));
                }
                catch (error) {
                    throw new CoordinationRuntimeError('system-fatal', 'worktree saga execution lock became unreadable before release', [lockPath, error instanceof Error ? error.message : String(error)]);
                }
                if (current === lockBody)
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
    assertSpecMatchesActiveAuthority(spec);
    const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    if (contextPath === undefined || contextPath.trim().length === 0) {
        if (coordinationCutoverCommitted(coordinatorRuntimePaths(env).stateRoot, spec.active.repo_key))
            throw new CoordinationRuntimeError('unauthorized-client', 'post-cutover worktree mutation requires a current durable coordinator session');
        if (spec.active.coordination_authority === 'coordinator-edit-leases-v1')
            throw new CoordinationRuntimeError('unauthorized-client', 'coordinator-authoritative run is missing its durable session; refusing unmanaged worktree mutation');
        if (await durableRunExists(spec.active, env))
            throw new CoordinationRuntimeError('unauthorized-client', 'durable run exists but no current session can authorize its worktree mutation');
        assertExternalWorktreeAuthority(spec, env, spec.active.worktree_root);
        const inspection = inspectOwnedWorktreeSpecPostcondition(spec, env);
        if (inspection.outcome === 'unsafe')
            throw new CoordinationRuntimeError('recovery-required', 'unmanaged legacy worktree operation found unsafe external state', inspection.proof);
        if (inspection.outcome === 'not-applied') {
            let actionError;
            if (!inspection.effect_applied) {
                try {
                    await callbacks.action();
                }
                catch (error) {
                    actionError = error;
                }
            }
            const actionInspection = inspectOwnedWorktreeSpecPostcondition(spec, env);
            if (actionError !== undefined && actionInspection.outcome === 'unsafe')
                throw actionError;
            if (actionInspection.effect_applied)
                await callbacks.finalize?.();
            const verified = inspectOwnedWorktreeSpecPostcondition(spec, env);
            if (verified.outcome !== 'satisfied') {
                if (actionError !== undefined)
                    throw actionError;
                throw new CoordinationRuntimeError('recovery-required', 'unmanaged worktree operation did not satisfy its canonical postcondition', verified.proof);
            }
        }
        return { managed: false, operation: null, worktree: null, replayed: false };
    }
    const client = await OwnedWorktreeSagaClient.fromEnvironment(env);
    return await withSagaExecutionLock(client.session, spec, async () => {
        const prepared = await client.prepare(spec);
        let operation = prepared.operation;
        let worktree = prepared.worktree;
        assertExternalWorktreeAuthority(spec, env, join(client.session.state_root, 'worktrees', client.session.repo_key));
        if (operation.stage === 'committed') {
            const committedInspection = await inspectCommittedOperation(client, operation, env);
            if (committedInspection.outcome !== 'satisfied')
                throw new CoordinationRuntimeError('recovery-required', 'committed worktree operation disagrees with its canonical postcondition', committedInspection.proof);
            return { managed: true, operation, worktree, replayed: true };
        }
        if (operation.stage === 'compensated' || operation.stage === 'failed')
            throw new CoordinationRuntimeError('recovery-required', `worktree operation is terminal at ${operation.stage}`, [operation.operation_id]);
        if (operation.stage === 'verified') {
            const verifiedInspection = inspectOperation(operation, env);
            if (verifiedInspection.outcome !== 'satisfied')
                throw new CoordinationRuntimeError('recovery-required', 'verified worktree operation no longer satisfies its canonical postcondition', verifiedInspection.proof);
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
            const inspection = inspectOperation(operation, env);
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
            else if (operation.stage === 'in-progress') {
                phase = 'start-report';
                const fenced = await client.transition({
                    operation, stage: 'in-progress', completedSteps: operation.completed_steps, currentStep: 'external-action',
                    recoveryAttempts: operation.recovery_attempts, verificationEvidence: operation.verification_evidence, errorCode: operation.error_code,
                    worktreeState: worktree.state, transitionKey: `recovery-authority-${String(operation.version)}`,
                });
                operation = fenced.operation;
                worktree = fenced.worktree;
            }
            let actionError;
            if (inspection.outcome === 'not-applied') {
                phase = 'external-action';
                await observeBoundary(callbacks, 'before-action');
                if (!inspection.effect_applied) {
                    try {
                        await callbacks.action();
                    }
                    catch (error) {
                        actionError = error;
                    }
                }
                await observeBoundary(callbacks, 'after-action');
                const actionInspection = inspectOperation(operation, env);
                if (actionError !== undefined && actionInspection.outcome === 'unsafe')
                    throw actionError;
                if (actionInspection.effect_applied)
                    await callbacks.finalize?.();
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
            const verifiedInspection = inspectOperation(operation, env);
            if (verifiedInspection.outcome !== 'satisfied') {
                if (actionError !== undefined)
                    throw actionError;
                throw new CoordinationRuntimeError('recovery-required', 'worktree operation canonical postcondition is not satisfied', verifiedInspection.proof);
            }
            const proof = verifiedInspection.proof;
            await observeBoundary(callbacks, 'after-verification');
            phase = 'evidence-write';
            const evidence = await client.writeEvidence(operation, 'verified', verifiedInspection, proof, null);
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
                const evidence = await client.writeEvidence(operation, 'compensated', null, error.proof, 'git-partial-effect');
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
    if (!existsSync(intent.worktree_path))
        return;
    const commonRaw = gitQueryText({ descriptor: { kind: 'git-common-dir' }, cwd: intent.worktree_path, env }).trim();
    const actualCommon = canonicalPath(isAbsolute(commonRaw) ? commonRaw : resolve(intent.worktree_path, commonRaw));
    const expectedCommon = canonicalPath(intent.git_common_dir);
    if (actualCommon !== expectedCommon)
        throw new CoordinationRuntimeError('recovery-required', 'external worktree Git common-dir disagrees with durable repository authority', [`expected=${expectedCommon}`, `actual=${actualCommon}`]);
}
function ownedMaterializationDirectory(worktreePath, path) {
    const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '');
    if (normalized.length === 0 || normalized.startsWith('/') || normalized.includes('\0') || normalized.split('/').some((segment) => segment === '..' || segment === ''))
        throw new CoordinationRuntimeError('invalid-state', 'materialize intent contains an unbounded repository path', [path]);
    const wildcard = normalized.search(/[?*[{]/u);
    const prefix = wildcard < 0 ? normalized : normalized.slice(0, wildcard);
    const literal = prefix.replace(/\/$/u, '');
    const directoryRelative = wildcard < 0 ? dirname(literal) : literal.length === 0 ? '.' : prefix.endsWith('/') ? literal : dirname(literal);
    const directory = resolve(worktreePath, ...directoryRelative.split('/'));
    const rel = relative(resolve(worktreePath), directory);
    if (rel.startsWith('..') || isAbsolute(rel))
        throw new CoordinationRuntimeError('invalid-state', 'materialize intent escapes its owned worktree', [path, worktreePath]);
    return directory;
}
function sagaGitEnv(env) {
    return {
        ...process.env,
        ...env,
        AUTOPILOT_RUNTIME: '1',
        AUTOPILOT_RUNTIME_AUTHORITY: 'owned-worktree-saga',
        GIT_LFS_SKIP_SMUDGE: '1',
        GIT_AUTHOR_NAME: 'autopilot-runtime',
        GIT_AUTHOR_EMAIL: 'autopilot-runtime@example.invalid',
        GIT_COMMITTER_NAME: 'autopilot-runtime',
        GIT_COMMITTER_EMAIL: 'autopilot-runtime@example.invalid',
    };
}
async function fixedAction(operation, env) {
    if (operation.operation_type === 'metadata-reconcile')
        throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation requires the exact-set metadata runtime', [operation.operation_id]);
    const intent = operation.intent;
    const gitEnv = sagaGitEnv(env);
    switch (operation.operation_type) {
        case 'create': {
            if (intent.base_sha === null || intent.checkout_mode === null)
                throw new CoordinationRuntimeError('invalid-state', 'create operation intent lacks base_sha or checkout_mode');
            const branchRef = `refs/heads/${intent.branch}`;
            const branchExists = !runGitQuery({ descriptor: { kind: 'ref-exists', ref: branchRef }, cwd: intent.repo_root, env: gitEnv }).negative;
            if (branchExists) {
                const actual = gitQueryText({ descriptor: { kind: 'resolve-revision', revision: branchRef, verify: true }, cwd: intent.repo_root, env: gitEnv }).trim();
                if (actual !== intent.base_sha)
                    throw new CoordinationRuntimeError('recovery-required', 'create branch moved between canonical probe and action', [intent.branch, `expected=${intent.base_sha}`, `actual=${actual}`]);
            }
            const registered = gitWorktreeRegistrationFacts(intent.repo_root, gitEnv).some((entry) => entry.worktree_path === canonicalPath(intent.worktree_path));
            if (!registered)
                await runGitMutation({ descriptor: { kind: 'worktree-add', path: intent.worktree_path, branch: intent.branch, startPoint: branchExists ? null : intent.base_sha, createBranch: !branchExists, noCheckout: intent.checkout_mode !== 'full' }, cwd: intent.repo_root, env: gitEnv });
            if (intent.checkout_mode !== 'full') {
                if (intent.sparse_patterns.length === 0)
                    throw new CoordinationRuntimeError('invalid-state', 'sparse create operation lacks patterns');
                await runGitMutation({ descriptor: { kind: 'sparse-checkout-set', patterns: intent.sparse_patterns }, cwd: intent.worktree_path, env: gitEnv });
                await runGitMutation({ descriptor: { kind: 'checkout-force', branch: intent.branch }, cwd: intent.worktree_path, env: gitEnv });
            }
            return;
        }
        case 'materialize':
            if (intent.sparse_patterns.length > 0)
                await runGitMutation({ descriptor: { kind: 'sparse-checkout-add', patterns: intent.sparse_patterns }, cwd: intent.worktree_path, env: gitEnv });
            for (const path of intent.paths)
                mkdirSync(ownedMaterializationDirectory(intent.worktree_path, path), { recursive: true });
            return;
        case 'commit':
        case 'quarantine': {
            const status = runGitQuery({ descriptor: { kind: 'status-porcelain', ...(operation.operation_type === 'quarantine' ? { includeIgnored: true } : {}) }, cwd: intent.worktree_path, env: gitEnv });
            if (status.stdout.length === 0)
                return;
            await runGitMutation({ descriptor: { kind: 'stage-paths', paths: operation.operation_type === 'quarantine' ? ['.'] : intent.paths, sparse: true, force: operation.operation_type === 'quarantine' }, cwd: intent.worktree_path, env: gitEnv });
            const staged = runGitQuery({ descriptor: { kind: 'staged-clean' }, cwd: intent.worktree_path, env: gitEnv });
            if (staged.negative)
                await runGitMutation({ descriptor: { kind: 'commit', message: `${operation.operation_type} ${operation.owner.workstream_run} ${operation.owner.unit_id} attempt ${String(operation.owner.attempt)}` }, cwd: intent.worktree_path, env: gitEnv });
            return;
        }
        case 'merge': {
            if (intent.target_sha === null)
                throw new CoordinationRuntimeError('invalid-state', 'merge operation intent lacks target_sha');
            if (inspectOperation(operation, env).outcome === 'satisfied')
                return;
            if (intent.archive_ref !== null) {
                await runGitMutation({ descriptor: { kind: 'merge', mode: 'ff-only', target: intent.target_sha }, cwd: intent.repo_root, env: gitEnv });
                return;
            }
            const mergeHeadPath = gitQueryText({ descriptor: { kind: 'git-path', name: 'MERGE_HEAD' }, cwd: intent.worktree_path, env: gitEnv }).trim();
            if (existsSync(isAbsolute(mergeHeadPath) ? mergeHeadPath : resolve(intent.worktree_path, mergeHeadPath))) {
                const currentHead = gitQueryText({ descriptor: { kind: 'head' }, cwd: intent.worktree_path, env: gitEnv }).trim();
                if (intent.base_sha === null || currentHead !== intent.base_sha)
                    throw new CoordinationRuntimeError('recovery-required', 'interrupted merge cannot be safely compensated because target HEAD moved');
                await runGitMutation({ descriptor: { kind: 'merge-abort' }, cwd: intent.worktree_path, env: gitEnv });
                const afterAbort = inspectOperation(operation, env);
                if (afterAbort.outcome === 'unsafe')
                    throw new CoordinationRuntimeError('recovery-required', 'interrupted merge abort did not restore safe repository state', afterAbort.proof);
                throw new WorktreeSagaCompensatedError('interrupted conflicting merge was restored to its exact pre-merge HEAD', [`base_head=${intent.base_sha}`, `source_head=${intent.target_sha}`]);
            }
            await runGitMutation({ descriptor: { kind: 'merge', mode: 'no-ff', message: `autopilot saga merge ${operation.owner.workstream_run} ${operation.owner.unit_id}`, target: intent.target_sha }, cwd: intent.worktree_path, env: gitEnv });
            return;
        }
        case 'reset':
            await runGitMutation({ descriptor: { kind: 'reset-hard', target: intent.target_sha ?? 'HEAD' }, cwd: intent.worktree_path, env: gitEnv });
            return;
        case 'archive':
            if (intent.archive_ref === null || intent.target_sha === null)
                throw new CoordinationRuntimeError('invalid-state', 'archive operation intent lacks ref or target');
            await runGitMutation({ descriptor: { kind: 'update-ref-create', ref: `refs/heads/${intent.archive_ref}`, target: intent.target_sha, expectedOld: '0'.repeat(40) }, cwd: intent.repo_root, env: gitEnv });
            return;
        case 'remove': {
            const branchRef = `refs/heads/${intent.branch}`;
            const branchBefore = runGitQuery({ descriptor: { kind: 'ref-exists', ref: branchRef }, cwd: intent.repo_root, env: gitEnv });
            if (!branchBefore.negative) {
                if (intent.target_sha === null)
                    throw new CoordinationRuntimeError('invalid-state', 'remove operation intent lacks the expected branch SHA');
                const actualBefore = gitQueryText({ descriptor: { kind: 'resolve-revision', revision: branchRef, verify: true }, cwd: intent.repo_root, env: gitEnv }).trim();
                if (actualBefore !== intent.target_sha)
                    throw new CoordinationRuntimeError('recovery-required', 'owned branch moved after operation intent; refusing retirement', [intent.branch, actualBefore, intent.target_sha]);
            }
            const registered = gitWorktreeRegistrationFacts(intent.repo_root, gitEnv).some((entry) => entry.worktree_path === canonicalPath(intent.worktree_path));
            if (existsSync(intent.worktree_path) || registered)
                await runGitMutation({ descriptor: { kind: 'worktree-remove', path: intent.worktree_path }, cwd: intent.repo_root, env: gitEnv });
            const branchAfter = runGitQuery({ descriptor: { kind: 'ref-exists', ref: branchRef }, cwd: intent.repo_root, env: gitEnv });
            if (!branchAfter.negative) {
                if (intent.target_sha === null)
                    throw new CoordinationRuntimeError('recovery-required', 'owned branch appeared during remove without an authorized expected SHA', [intent.branch]);
                await runGitMutation({ descriptor: { kind: 'update-ref-delete', ref: branchRef, expectedOld: intent.target_sha }, cwd: intent.repo_root, env: gitEnv });
            }
            return;
        }
    }
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
        const inspected = await inspectCommittedOperation(client, existing, env);
        if (inspected.outcome !== 'satisfied')
            throw new CoordinationRuntimeError('recovery-required', 'committed main worktree registration disagrees with canonical postcondition truth', inspected.proof);
        return existing;
    }
    const registrationHead = gitQueryText({ descriptor: { kind: 'head' }, cwd: active.main_worktree_path, env }).trim();
    const result = await executeOwnedWorktreeSaga({
        active, unitId: 'main', attempt: 1, kind: 'main', operationType: 'create',
        initialWorktreeState: 'planned', committedWorktreeState: 'active',
        intent: {
            repo_root: active.source_repo, worktree_path: active.main_worktree_path, git_common_dir: active.git_common_dir, branch: active.branch,
            reason: 'register package-created main worktree with durable owner authority', base_sha: registrationHead, target_sha: null,
            archive_ref: null, checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: ['_task-info.json', '_branches.json', '_unit-index.json'],
        },
    }, {
        action: () => { throw new CoordinationRuntimeError('recovery-required', 'main worktree creation did not reach durable registration; bootstrap recovery evidence is required'); },
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
    const operations = await client.operations();
    const worktrees = await client.worktrees();
    for (const candidate of operations) {
        if (TERMINAL_STAGES.has(candidate.stage))
            continue;
        const kind = operationKind(candidate.owner);
        const canonicalWorktreeId = deterministicWorktreeId(candidate.owner, kind);
        const matchingWorktrees = worktrees.filter((entry) => entry.worktree_id === canonicalWorktreeId && entry.kind === kind && sameOwner(entry.owner, candidate.owner));
        const worktree = matchingWorktrees[0];
        if (matchingWorktrees.length !== 1 || worktree === undefined)
            throw new CoordinationRuntimeError('store-corrupt', 'recoverable operation lacks exactly one canonical worktree owner', [candidate.operation_id, candidate.worktree_id, canonicalWorktreeId]);
        if (candidate.operation_type === 'metadata-reconcile')
            throw new CoordinationRuntimeError('recovery-required', 'metadata reconciliation requires its exact-set production consumer', [candidate.operation_id]);
        const spec = {
            active: input.active, unitId: candidate.owner.unit_id, attempt: candidate.owner.attempt, kind: worktree.kind,
            operationType: candidate.operation_type, intent: candidate.intent, operationId: candidate.operation_id,
            initialWorktreeState: worktree.state,
            committedWorktreeState: candidate.operation_type === 'remove' ? 'removed'
                : candidate.operation_type === 'quarantine' ? 'quarantined'
                    : candidate.operation_type === 'reset' || candidate.operation_type === 'archive' ? 'terminal'
                        : worktree.state === 'planned' ? 'active' : worktree.state,
        };
        const result = await executeOwnedWorktreeSaga(spec, { action: async () => { await fixedAction(candidate, env); } }, env);
        if (result.operation !== null)
            recovered.push(result.operation);
    }
    return Object.freeze(recovered);
}
export function fixedWorktreeSagaCallbacks(operation, env = process.env) {
    return { action: async () => { await fixedAction(operation, env); } };
}
