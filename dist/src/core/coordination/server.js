import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, open, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { platform } from 'node:os';
import { createCoordinatorAdmissionOffer, createCoordinatorAdmissionResponse, COORDINATOR_ADMISSION_ACTION } from "./admission.js";
import { assertCoordinatorAdmissionAuthorityUnchanged, captureServingCoordinatorAdmissionAuthority, COORDINATOR_S1_ADMISSION_IDENTITY } from "./admission-runtime.js";
import { parseCoordinatorAdmissionTransportRequest, parseCoordinatorTransportRequest, CoordinatorFrameDecoder, writeCoordinatorResponse } from "./ipc.js";
import { CoordinationRuntimeError } from "./failures.js";
import { buildS2CoordinationRuntimeErrorDiagnostic } from "./s2-diagnostics.js";
import { isS2FailureResponseRetryable } from "./s2-failure-taxonomy.js";
import { runCoordinatorOwnedS2RetentionGc } from "./s2-owned-gc.js";
import { currentBootId, isProcessAlive, predecessorCompatibleBootId, processStartIdentity } from "./process-identity.js";
import { COORDINATOR_GRANT_OFFER_SWEEP_MS, enforcePrivateAuthorityPath, ensureCoordinatorPrivateRoots, readOrCreateCoordinatorCapability } from "./runtime-paths.js";
import { acquireSerializedProcessGuard, discardLockTombstone, quarantineExactLock, readExactLockText, restoreLockTombstone } from "./serialized-lock.js";
import { CoordinatorStore } from "./store.js";
import { CoordinatorSocketPeerState } from "./peer-admission-state.js";
import { CoordinatorWriterGuard } from "./writer-guard.js";
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION } from "./types.js";
import { readKnownCoordinatorUpgradeIntent, recordCoordinatorFenceHandoff } from "./upgrade.js";
import { COORDINATOR_PACKAGE_BUILD } from "./runtime-constants.js";
import { publishCoordinatorRuntimeIdentity, readAndVerifyCoordinatorRuntimeIdentity } from "./runtime-identity.js";
import { COORDINATOR_UPGRADE_PATH, parseCurrentCoordinatorLock, parseKnownCompatibleCurrentCoordinatorLock, parsePredecessorCoordinatorLock, parsePriorSchema11CurrentCoordinatorLock, parsePriorSchema10CurrentCoordinatorLock, parsePriorSchema9CurrentCoordinatorLock } from "./upgrade-contracts.js";
export class CoordinatorAlreadyRunningError extends Error {
    name = 'CoordinatorAlreadyRunningError';
}
function failureText(error) { return error instanceof Error ? error.message : String(error); }
function requirePreparedStore(store) {
    if (store === null)
        throw new CoordinationRuntimeError('system-fatal', 'lifecycle authority published before store preparation completed');
    return store;
}
function requirePreparedCapability(capability) {
    if (capability === null)
        throw new CoordinationRuntimeError('system-fatal', 'lifecycle authority published before capability preparation completed');
    return capability;
}
function requirePreparedWriterGuard(writerGuard) {
    if (writerGuard === null)
        throw new CoordinationRuntimeError('system-fatal', 'lifecycle authority published before writer authority was acquired');
    return writerGuard;
}
function closePreparedStore(store) { store?.close(); }
function releasePreparedWriterGuard(writerGuard) { writerGuard?.release(); }
function sameCurrentLock(left, right) {
    return left.pid === right.pid && left.boot_id === right.boot_id && left.process_start_identity === right.process_start_identity && left.token === right.token && left.instance_id === right.instance_id && left.package_build === right.package_build && left.protocol_version === right.protocol_version && left.database_schema_version === right.database_schema_version && left.started_at === right.started_at;
}
function samePredecessorLock(left, right) {
    return left.pid === right.pid && left.boot_id === right.boot_id && left.token === right.token && left.started_at === right.started_at;
}
function samePredecessorFenceOwner(left, right) {
    return left.pid === right.pid && left.token === right.token && left.started_at === right.started_at;
}
async function writePredecessorFence(path, fence) {
    const handle = await open(path, 'wx', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(fence)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await enforcePrivateAuthorityPath(path, false);
}
async function replacePredecessorFence(path, fence) {
    const temporary = `${path}.refresh.${String(process.pid)}.${randomBytes(8).toString('hex')}`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(fence)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await enforcePrivateAuthorityPath(temporary, false);
    await rename(temporary, path);
    await enforcePrivateAuthorityPath(path, false);
}
async function acquireCoordinatorLock(paths, adoption, beforeAuthorityPublication) {
    await ensureCoordinatorPrivateRoots(paths);
    const election = adoption === undefined
        ? acquireSerializedProcessGuard(paths.lifecycleElectionPath, 10_000, 'coordinator lifecycle election')
        : { release: () => adoption.releaseElection() };
    let currentTombstone = null;
    let predecessorTombstone = null;
    let predecessorRestore = null;
    let upgradeHandoffPredecessor = null;
    let predecessorWasAbsent = false;
    let createdCurrent = false;
    let createdFence = false;
    let provenStaleCurrentOwner = null;
    let activated = false;
    const startIdentity = processStartIdentity(process.pid);
    if (startIdentity === null) {
        election.release();
        throw new CoordinationRuntimeError('system-fatal', 'cannot obtain current coordinator process-creation identity');
    }
    const record = {
        schema_version: COORDINATOR_UPGRADE_PATH.target.lifecycle_lock_schema,
        pid: process.pid,
        boot_id: currentBootId(),
        process_start_identity: startIdentity,
        token: randomBytes(24).toString('hex'),
        instance_id: randomBytes(24).toString('hex'),
        package_build: COORDINATOR_PACKAGE_BUILD,
        protocol_version: COORDINATOR_UPGRADE_PATH.target.protocol_version,
        database_schema_version: COORDINATOR_UPGRADE_PATH.target.database_schema_version,
        started_at: new Date().toISOString(),
    };
    let predecessorFence = { schema_version: 'autopilot.coordinator_lock.v1', pid: process.pid, boot_id: predecessorCompatibleBootId(), token: randomBytes(24).toString('hex'), started_at: record.started_at };
    try {
        const startupIntent = await readKnownCoordinatorUpgradeIntent(paths);
        if (startupIntent !== null && startupIntent.target.package_build !== COORDINATOR_UPGRADE_PATH.target.package_build && startupIntent.state !== 'committed')
            throw new CoordinationRuntimeError('recovery-required', `historical coordinator upgrade target ${startupIntent.target.package_build} is ${startupIntent.state}; startup cannot rewrite another build's intent`);
        const currentText = await readExactLockText(paths.lockPath);
        if (currentText !== null) {
            let current = null;
            let knownButNotCf50 = null;
            try {
                const parsed = JSON.parse(currentText);
                const compatible = parseKnownCompatibleCurrentCoordinatorLock(parsed);
                if (compatible !== null && compatible.package_build !== COORDINATOR_PACKAGE_BUILD)
                    knownButNotCf50 = compatible;
                else
                    current = compatible ?? parsePriorSchema11CurrentCoordinatorLock(parsed) ?? parsePriorSchema10CurrentCoordinatorLock(parsed) ?? parsePriorSchema9CurrentCoordinatorLock(parsed);
            }
            catch { /* fail below */ }
            if (knownButNotCf50 !== null)
                throw new CoordinationRuntimeError('protocol-mismatch', 'ordinary S1 startup accepts only the exact cf50 façade as its live or retired wire predecessor', [`observed_build=${knownButNotCf50.package_build}`]);
            if (current === null)
                throw new CoordinationRuntimeError('protocol-mismatch', 'current-generation lifecycle lock belongs to an unknown build');
            // Boot-id disagreement is never stale proof. Current-generation locks also
            // carry OS process-birth identity, so PID reuse can be distinguished from
            // the exact coordinator without signaling or deleting by PID alone.
            if (isProcessAlive(current.pid)) {
                const observedStart = processStartIdentity(current.pid);
                if (observedStart === null)
                    throw new CoordinationRuntimeError('recovery-required', 'live current-generation PID has ambiguous process-creation identity; elected startup cannot reclaim it', [`pid=${String(current.pid)}`]);
                if (observedStart === current.process_start_identity)
                    throw new CoordinatorAlreadyRunningError(`coordinator is already running as pid ${String(current.pid)}`);
            }
            provenStaleCurrentOwner = current;
            currentTombstone = await quarantineExactLock(paths.lockPath, currentText, 'dead or PID-reused current-generation coordinator lock');
        }
        const predecessorText = await readExactLockText(paths.predecessorLockPath);
        if (predecessorText !== null) {
            let predecessor = null;
            try {
                predecessor = parsePredecessorCoordinatorLock(JSON.parse(predecessorText));
            }
            catch { /* fail below */ }
            if (predecessor === null)
                throw new CoordinationRuntimeError('protocol-mismatch', 'predecessor lifecycle path contains an unknown lock');
            const intent = await readKnownCoordinatorUpgradeIntent(paths);
            const upgradeHandoff = intent !== null && intent.target.package_build === COORDINATOR_UPGRADE_PATH.target.package_build && intent.predecessor_fence !== null && ['starting', 'reconnect-verified'].includes(intent.state) && samePredecessorLock(predecessor, intent.predecessor_fence);
            const adoptedHandoff = adoption !== undefined && samePredecessorLock(predecessor, adoption.predecessorFence);
            const authorizedHandoff = upgradeHandoff || adoptedHandoff;
            const pairedProvenStaleFence = provenStaleCurrentOwner !== null && predecessor.pid === provenStaleCurrentOwner.pid && predecessor.started_at === provenStaleCurrentOwner.started_at;
            if (isProcessAlive(predecessor.pid) && !authorizedHandoff && !pairedProvenStaleFence)
                throw new CoordinatorAlreadyRunningError(`predecessor lifecycle path is fenced by live pid ${String(predecessor.pid)}`);
            if (authorizedHandoff) {
                predecessorRestore = predecessor;
                if (upgradeHandoff)
                    upgradeHandoffPredecessor = predecessor;
            }
            else
                predecessorTombstone = await quarantineExactLock(paths.predecessorLockPath, predecessorText, 'dead predecessor fence replacement');
        }
        else
            predecessorWasAbsent = true;
        // The lifecycle election remains held, but no new S1 lock/fence exists yet.
        // Generation verification/migration and the digest-bound runtime sidecar
        // therefore complete before lifecycle/socket reachability.
        await beforeAuthorityPublication?.(record);
        const currentHandle = await open(paths.lockPath, 'wx', 0o600);
        try {
            await currentHandle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
            await currentHandle.sync();
        }
        finally {
            await currentHandle.close();
        }
        await enforcePrivateAuthorityPath(paths.lockPath, false);
        createdCurrent = true;
        if (predecessorRestore !== null)
            await replacePredecessorFence(paths.predecessorLockPath, predecessorFence);
        else if (predecessorTombstone !== null || predecessorWasAbsent)
            await writePredecessorFence(paths.predecessorLockPath, predecessorFence);
        else
            throw new CoordinationRuntimeError('system-fatal', 'predecessor fence publication state is incomplete');
        createdFence = true;
        if (upgradeHandoffPredecessor !== null)
            await recordCoordinatorFenceHandoff(paths, upgradeHandoffPredecessor, predecessorFence);
        if (predecessorRestore !== null)
            adoption?.adopted(predecessorFence);
        if (currentTombstone !== null) {
            await discardLockTombstone(currentTombstone);
            currentTombstone = null;
        }
        if (predecessorTombstone !== null) {
            await discardLockTombstone(predecessorTombstone);
            predecessorTombstone = null;
        }
        const verifyOrRepairFence = async () => {
            let guard;
            try {
                guard = acquireSerializedProcessGuard(paths.lifecycleElectionPath, 25, 'predecessor fence maintenance');
            }
            catch (error) {
                if (error instanceof CoordinationRuntimeError && error.code === 'coordinator-contention')
                    return 'deferred';
                throw error;
            }
            try {
                const text = await readExactLockText(paths.predecessorLockPath);
                if (text === null) {
                    await writePredecessorFence(paths.predecessorLockPath, predecessorFence);
                    return 'verified';
                }
                const observed = parsePredecessorCoordinatorLock(JSON.parse(text));
                if (observed !== null && samePredecessorFenceOwner(observed, predecessorFence)) {
                    const refreshed = { ...predecessorFence, boot_id: predecessorCompatibleBootId() };
                    if (!samePredecessorLock(observed, refreshed))
                        await replacePredecessorFence(paths.predecessorLockPath, refreshed);
                    predecessorFence = refreshed;
                    return 'verified';
                }
                if (observed === null)
                    throw new CoordinationRuntimeError('system-fatal', 'old-format predecessor fence became unreadable');
                if (isProcessAlive(observed.pid))
                    throw new CoordinationRuntimeError('system-fatal', 'a live stale coordinator displaced the predecessor fence', [`pid=${String(observed.pid)}`]);
                const tombstone = await quarantineExactLock(paths.predecessorLockPath, text, 'dead stale predecessor lock');
                predecessorFence = { ...predecessorFence, boot_id: predecessorCompatibleBootId() };
                await writePredecessorFence(paths.predecessorLockPath, predecessorFence);
                await discardLockTombstone(tombstone);
                return 'verified';
            }
            finally {
                guard.release();
            }
        };
        return {
            record,
            activate: () => { if (!activated) {
                activated = true;
                election.release();
            } },
            verifyOrRepairFence,
            abortStartup: async () => {
                if (adoption === undefined || predecessorRestore === null) {
                    const currentTextValue = await readExactLockText(paths.lockPath);
                    const current = currentTextValue === null ? null : parseCurrentCoordinatorLock(JSON.parse(currentTextValue));
                    if (currentTextValue === null || current === null || !sameCurrentLock(current, record))
                        throw new CoordinationRuntimeError('system-fatal', 'failed-startup current lock changed before cleanup');
                    await discardLockTombstone(await quarantineExactLock(paths.lockPath, currentTextValue, 'failed-startup current-generation lifecycle lock'));
                    const fenceText = await readExactLockText(paths.predecessorLockPath);
                    const fence = fenceText === null ? null : parsePredecessorCoordinatorLock(JSON.parse(fenceText));
                    if (fenceText === null || fence === null || !samePredecessorFenceOwner(fence, predecessorFence))
                        throw new CoordinationRuntimeError('system-fatal', 'failed-startup predecessor fence changed before cleanup');
                    await discardLockTombstone(await quarantineExactLock(paths.predecessorLockPath, fenceText, 'failed-startup predecessor lifecycle fence'));
                    election.release();
                    return;
                }
                const currentTextValue = await readExactLockText(paths.lockPath);
                if (currentTextValue === null)
                    throw new CoordinationRuntimeError('system-fatal', 'adopted startup current lock disappeared before crash cleanup');
                const current = parseCurrentCoordinatorLock(JSON.parse(currentTextValue));
                if (current === null || !sameCurrentLock(current, record))
                    throw new CoordinationRuntimeError('system-fatal', 'adopted startup current lock changed before crash cleanup');
                await discardLockTombstone(await quarantineExactLock(paths.lockPath, currentTextValue, 'adopted failed-startup current lock'));
                const fenceText = await readExactLockText(paths.predecessorLockPath);
                const fence = fenceText === null ? null : parsePredecessorCoordinatorLock(JSON.parse(fenceText));
                if (fence === null || !samePredecessorFenceOwner(fence, predecessorFence))
                    throw new CoordinationRuntimeError('system-fatal', 'adopted startup predecessor fence changed before crash cleanup');
                await replacePredecessorFence(paths.predecessorLockPath, predecessorRestore);
                adoption.restored();
                election.release();
            },
            release: async () => {
                const currentTextValue = await readExactLockText(paths.lockPath);
                if (currentTextValue === null)
                    throw new CoordinationRuntimeError('system-fatal', 'current-generation lifecycle lock disappeared before release');
                const current = parseCurrentCoordinatorLock(JSON.parse(currentTextValue));
                if (current === null || !sameCurrentLock(current, record))
                    throw new CoordinationRuntimeError('system-fatal', 'current-generation lifecycle lock ownership changed before release');
                const currentRemoval = await quarantineExactLock(paths.lockPath, currentTextValue, 'current-generation lifecycle lock');
                await discardLockTombstone(currentRemoval);
                const fenceText = await readExactLockText(paths.predecessorLockPath);
                if (fenceText === null)
                    throw new CoordinationRuntimeError('system-fatal', 'predecessor fence disappeared before release');
                const fence = parsePredecessorCoordinatorLock(JSON.parse(fenceText));
                if (fence === null || !samePredecessorFenceOwner(fence, predecessorFence))
                    throw new CoordinationRuntimeError('system-fatal', 'predecessor fence ownership changed before release');
                const fenceRemoval = await quarantineExactLock(paths.predecessorLockPath, fenceText, 'predecessor lifecycle fence');
                await discardLockTombstone(fenceRemoval);
            },
        };
    }
    catch (error) {
        try {
            if (createdFence) {
                const text = await readExactLockText(paths.predecessorLockPath);
                if (text === null)
                    throw new CoordinationRuntimeError('system-fatal', 'new predecessor fence disappeared during failed startup cleanup');
                const observed = parsePredecessorCoordinatorLock(JSON.parse(text));
                if (observed === null || !samePredecessorFenceOwner(observed, predecessorFence))
                    throw new CoordinationRuntimeError('system-fatal', 'new predecessor fence changed identity during failed startup cleanup');
                if (predecessorRestore === null)
                    await discardLockTombstone(await quarantineExactLock(paths.predecessorLockPath, text, 'failed-startup predecessor fence'));
                else {
                    await replacePredecessorFence(paths.predecessorLockPath, predecessorRestore);
                    adoption?.restored();
                }
            }
            if (createdCurrent) {
                const text = await readExactLockText(paths.lockPath);
                if (text === null)
                    throw new CoordinationRuntimeError('system-fatal', 'new current lock disappeared during failed startup cleanup');
                const observed = parseCurrentCoordinatorLock(JSON.parse(text));
                if (observed === null || !sameCurrentLock(observed, record))
                    throw new CoordinationRuntimeError('system-fatal', 'new current lock changed identity during failed startup cleanup');
                await discardLockTombstone(await quarantineExactLock(paths.lockPath, text, 'failed-startup current lock'));
            }
            if (predecessorTombstone !== null)
                await restoreLockTombstone(paths.predecessorLockPath, predecessorTombstone, 'predecessor fence');
            if (currentTombstone !== null)
                await restoreLockTombstone(paths.lockPath, currentTombstone, 'current-generation lifecycle lock');
        }
        catch (cleanupError) {
            election.release();
            throw new CoordinationRuntimeError('system-fatal', 'coordinator election failed and exact lock cleanup was incomplete', [failureText(error), failureText(cleanupError)]);
        }
        election.release();
        throw error;
    }
}
function authenticated(provided, expected) {
    const left = Buffer.from(provided, 'utf8');
    const right = Buffer.from(expected, 'utf8');
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
function errorResponse(requestId, error) {
    const runtime = error instanceof CoordinationRuntimeError ? error : new CoordinationRuntimeError('system-fatal', error instanceof Error ? error.message : String(error));
    return {
        schema_version: 'autopilot.coordinator_response.v1',
        protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
        request_id: requestId,
        ok: false,
        committed_event_seq: null,
        error_code: runtime.code,
        retryable: isS2FailureResponseRetryable(runtime.code),
        payload: { message: runtime.message, evidence: runtime.evidence, s2_diagnostic: buildS2CoordinationRuntimeErrorDiagnostic(runtime) },
    };
}
function jsonObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}
function untrustedFrameAction(frame) {
    const transport = jsonObject(frame);
    const request = transport === null ? null : jsonObject(transport['request']);
    const action = request?.['action'];
    return typeof action === 'string' ? action : null;
}
function operationType(value) {
    const operation = jsonObject(value);
    const type = operation?.['operation_type'];
    return typeof type === 'string' ? type : null;
}
function requestS1Surface(store, request) {
    if (request.action === 'accept-program-heartbeat' || request.action === 'status' && request.payload['dispatch_authority_context'] !== undefined)
        return 'd65-current-build';
    if (request.action === 'resolve-run-scoped-fault')
        return 'scoped-logical-faults';
    if (request.action === 'prepare-operation' && operationType(request.payload['operation']) === 'metadata-reconcile')
        return 'canonical-worktree-aliases';
    if (request.action !== 'transition-operation' || request.workstream_run === null)
        return null;
    const operationId = request.payload['operation_id'];
    if (typeof operationId !== 'string')
        return null;
    const operations = store.status(request.repo_id, request.workstream_run).payload['worktree_operations'];
    if (!Array.isArray(operations))
        throw new CoordinationRuntimeError('store-corrupt', 'worktree operation projection is unavailable for vocabulary enforcement');
    for (const candidate of operations) {
        const operation = jsonObject(candidate);
        if (operation?.['operation_id'] === operationId)
            return operationType(operation) === 'metadata-reconcile' ? 'canonical-worktree-aliases' : null;
    }
    return null;
}
function negotiatedProjectionResponse(store, peer, request, response) {
    if (!response.ok || (request.action !== 'status' && request.action !== 'doctor') || response.payload['section'] !== 'summary')
        return response;
    const projection = jsonObject(response.payload['projection']);
    if (projection === null)
        throw new CoordinationRuntimeError('store-corrupt', 'coordinator projection summary is malformed');
    const negotiated = { ...projection };
    if (peer.grantedVocabulary.has('store-generations-v1'))
        negotiated['negotiated_coordinator_identity'] = store.negotiatedIdentityObservability();
    if (peer.grantedVocabulary.has('scoped-logical-faults-v1'))
        negotiated['run_scoped_logical_faults'] = store.negotiatedRunScopedFaults(request.repo_id, request.workstream_run);
    if (peer.grantedVocabulary.has('canonical-worktree-aliases-v1')) {
        negotiated['negotiated_worktree_aliases'] = store.negotiatedWorktreeAliases(request.repo_id, request.workstream_run);
        negotiated['negotiated_identity_recovery'] = store.negotiatedIdentityRecovery(request.repo_id, request.workstream_run);
    }
    return Object.freeze({ ...response, payload: Object.freeze({ ...response.payload, projection: Object.freeze(negotiated) }) });
}
function admissionEnvelope(requestId, payload) {
    return Object.freeze({
        schema_version: 'autopilot.coordinator_response.v1',
        protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
        request_id: requestId,
        ok: true,
        committed_event_seq: null,
        error_code: null,
        retryable: false,
        payload: Object.freeze({ ...payload }),
    });
}
export const COORDINATOR_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;
class CoordinatorRequestDrain {
    #sockets = new Map();
    #pending = new Set();
    #draining = false;
    register(socket) {
        if (this.#draining) {
            socket.destroy();
            return false;
        }
        this.#sockets.set(socket, 0);
        socket.on('close', () => { this.#sockets.delete(socket); });
        return true;
    }
    acceptRequest(socket) {
        if (!this.#draining && this.#sockets.has(socket))
            return true;
        socket.destroy();
        return false;
    }
    track(socket, pending) {
        const active = this.#sockets.get(socket);
        if (active === undefined)
            throw new CoordinationRuntimeError('system-fatal', 'coordinator request began outside registered socket authority');
        this.#sockets.set(socket, active + 1);
        this.#pending.add(pending);
        const settled = () => {
            this.#pending.delete(pending);
            const remaining = this.#sockets.get(socket);
            if (remaining === undefined)
                return;
            if (remaining <= 1) {
                this.#sockets.set(socket, 0);
                if (this.#draining)
                    socket.destroy();
            }
            else
                this.#sockets.set(socket, remaining - 1);
        };
        void pending.then(settled, settled);
    }
    beginDrain() {
        if (this.#draining)
            return;
        this.#draining = true;
        for (const [socket, active] of this.#sockets)
            if (active === 0)
                socket.destroy();
    }
    async waitForDrain(timeoutMs = COORDINATOR_SHUTDOWN_DRAIN_TIMEOUT_MS) {
        if (!this.#draining)
            throw new CoordinationRuntimeError('system-fatal', 'coordinator request drain was awaited before listener retirement began');
        if (this.#pending.size === 0)
            return;
        let timer = null;
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                for (const socket of this.#sockets.keys())
                    socket.destroy();
                reject(new CoordinationRuntimeError('system-fatal', 'coordinator shutdown could not drain in-flight requests within the bounded deadline; store, lifecycle, and writer authority remain retained until process death', [`pending_requests=${String(this.#pending.size)}`, `timeout_ms=${String(timeoutMs)}`]));
            }, timeoutMs);
        });
        try {
            await Promise.race([Promise.all([...this.#pending]).then(() => undefined), timeout]);
        }
        finally {
            if (timer !== null)
                clearTimeout(timer);
        }
    }
}
function handleSocket(socket, store, capability, paths, lifecycle, backgroundFailure, firstExactHandshake, requestDrain, testHooks) {
    if (!requestDrain.register(socket))
        return;
    const decoder = new CoordinatorFrameDecoder();
    const peer = new CoordinatorSocketPeerState();
    let handshakeAuthority = null;
    let admittedAuthority = null;
    let chain = Promise.resolve();
    // Transport failure is scoped to this peer. In particular, an abrupt client
    // disconnect during an asynchronous authority check or response write must
    // never become an unhandled EventEmitter error that terminates the service.
    socket.on('error', () => { peer.close(); socket.destroy(); });
    socket.on('data', (chunk) => {
        if (!requestDrain.acceptRequest(socket))
            return;
        chain = chain.then(async () => {
            const frames = decoder.push(chunk);
            for (const frame of frames) {
                let requestId = `transport-error-${randomBytes(8).toString('hex')}`;
                try {
                    let response = null;
                    let currentTransport = null;
                    let admissionTransport = null;
                    try {
                        currentTransport = parseCoordinatorTransportRequest(frame);
                    }
                    catch (currentProtocolError) {
                        if (untrustedFrameAction(frame) === COORDINATOR_ADMISSION_ACTION) {
                            try {
                                admissionTransport = parseCoordinatorAdmissionTransportRequest(frame, COORDINATOR_S1_ADMISSION_IDENTITY);
                            }
                            catch (admissionError) {
                                peer.close();
                                throw admissionError;
                            }
                        }
                        else
                            throw currentProtocolError;
                    }
                    if (admissionTransport !== null) {
                        requestId = admissionTransport.request.request_id;
                        if (!authenticated(admissionTransport.capability, capability))
                            throw new CoordinationRuntimeError('unauthorized-client', 'coordinator capability proof was rejected');
                        peer.acceptRequest(COORDINATOR_ADMISSION_ACTION);
                        const initial = handshakeAuthority;
                        if (initial === null)
                            throw new CoordinationRuntimeError('unauthorized-client', 'admission has no same-socket handshake authority');
                        const observed = await captureServingCoordinatorAdmissionAuthority({ paths, expectedLifecycle: lifecycle, expectedGeneration: store.currentGeneration() });
                        assertCoordinatorAdmissionAuthorityUnchanged(initial, observed);
                        const admission = createCoordinatorAdmissionResponse({ request: admissionTransport.request.payload, identity: COORDINATOR_S1_ADMISSION_IDENTITY, endpoint: observed.endpoint, capability });
                        response = admissionEnvelope(requestId, admission);
                        peer.completeAdmission(admission);
                        if (admission.admitted)
                            admittedAuthority = observed;
                        await testHooks?.afterAdmissionAttestedBeforeResponse?.(admission);
                    }
                    if (currentTransport !== null) {
                        requestId = currentTransport.request.request_id;
                        const request = currentTransport.request;
                        if (!authenticated(currentTransport.capability, capability))
                            throw new CoordinationRuntimeError('unauthorized-client', 'coordinator capability proof was rejected');
                        const surface = peer.state === 'awaiting-handshake' ? null : requestS1Surface(store, request);
                        peer.acceptRequest(request.action, surface);
                        const timerFailure = backgroundFailure();
                        if (timerFailure !== null)
                            throw new CoordinationRuntimeError('system-fatal', `coordinator predecessor fence maintenance failed: ${timerFailure.message}`);
                        const upgradeIntent = await readKnownCoordinatorUpgradeIntent(paths);
                        if (upgradeIntent !== null && upgradeIntent.state !== 'committed' && request.action !== 'handshake' && request.action !== 'status' && request.action !== 'doctor')
                            throw new CoordinationRuntimeError('coordinator-contention', 'coordinator upgrade is not durably committed; mutation authority remains closed');
                        if (request.action === 'handshake') {
                            handshakeAuthority = await captureServingCoordinatorAdmissionAuthority({ paths, expectedLifecycle: lifecycle, expectedGeneration: store.currentGeneration() });
                            const legacy = store.handle(request);
                            if (!legacy.ok)
                                response = legacy;
                            else {
                                response = Object.freeze({
                                    ...legacy,
                                    payload: Object.freeze({
                                        schema_version: 'autopilot.coordinator_handshake.v1',
                                        package_build: lifecycle.package_build,
                                        protocol_version: lifecycle.protocol_version,
                                        database_schema_version: lifecycle.database_schema_version,
                                        lifecycle_lock_schema: lifecycle.schema_version,
                                        lifecycle_pid: lifecycle.pid,
                                        lifecycle_boot_id: lifecycle.boot_id,
                                        lifecycle_process_start_identity: lifecycle.process_start_identity,
                                        lifecycle_instance_id: lifecycle.instance_id,
                                        lifecycle_started_at: lifecycle.started_at,
                                        admission_upgrade: createCoordinatorAdmissionOffer(COORDINATOR_S1_ADMISSION_IDENTITY),
                                    }),
                                });
                                await firstExactHandshake();
                            }
                        }
                        else {
                            if (peer.peerMode === 'negotiated-s1') {
                                const initial = admittedAuthority;
                                if (initial === null)
                                    throw new CoordinationRuntimeError('unauthorized-client', 'negotiated peer has no same-socket admission authority');
                                const observed = await captureServingCoordinatorAdmissionAuthority({ paths, expectedLifecycle: lifecycle, expectedGeneration: store.currentGeneration() });
                                assertCoordinatorAdmissionAuthorityUnchanged(initial, observed);
                                await testHooks?.beforeNegotiatedStoreOperation?.(request.action);
                            }
                            response = store.handle(request, peer.peerMode === 'negotiated-s1' ? 'negotiated-s1' : 'cf50-legacy');
                            if (peer.peerMode === 'negotiated-s1')
                                response = negotiatedProjectionResponse(store, peer, request, response);
                            if (response.ok && response.committed_event_seq !== null)
                                await testHooks?.afterStoreCommitBeforeResponse?.(request.action, response);
                        }
                    }
                    if (response === null)
                        throw new CoordinationRuntimeError('system-fatal', 'coordinator request parsing produced no response path');
                    await writeCoordinatorResponse(socket, response);
                }
                catch (error) {
                    peer.close();
                    if (!socket.destroyed)
                        await writeCoordinatorResponse(socket, errorResponse(requestId, error));
                }
            }
        }).catch(() => { peer.close(); socket.destroy(); });
        requestDrain.track(socket, chain);
    });
    socket.on('end', () => {
        peer.close();
        try {
            decoder.assertComplete();
        }
        catch {
            socket.destroy();
        }
    });
}
function listen(server, path) {
    return new Promise((resolveListen, rejectListen) => {
        const onError = (error) => {
            server.off('listening', onListening);
            rejectListen(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolveListen();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(path);
    });
}
function closeServer(server) {
    return new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
            if (error === undefined)
                resolveClose();
            else
                rejectClose(error);
        });
    });
}
function observeServerClose(server) {
    return closeServer(server).then(() => null, (error) => error instanceof Error ? error : new Error(String(error)));
}
export async function startCoordinatorServer(paths, clock, adoption, testHooks, startupObserver) {
    await startupObserver?.transition('before-lifecycle-election');
    await ensureCoordinatorPrivateRoots(paths);
    let writerGuard = null;
    let lifecycleLock = null;
    let store = null;
    let capability = null;
    let server = null;
    let offerTimer = null;
    let serverListening = false;
    const requestDrain = new CoordinatorRequestDrain();
    try {
        lifecycleLock = await acquireCoordinatorLock(paths, adoption, async (plannedLifecycle) => {
            // The serialized lifecycle election chooses the only candidate before it
            // attempts process-lifetime writer authority. The observer boundary is
            // inside that election and before capability validation, so every startup
            // phase remains independently testable without letting a loser block on
            // the winner's writer guard.
            await startupObserver?.transition('after-lifecycle-lock-acquisition', plannedLifecycle);
            writerGuard = await CoordinatorWriterGuard.acquire(paths);
            const preparedWriterGuard = writerGuard;
            await startupObserver?.transition('before-private-root-capability-setup', plannedLifecycle);
            capability = await readOrCreateCoordinatorCapability(paths);
            await startupObserver?.transition('after-private-root-capability-setup', plannedLifecycle);
            if (platform() !== 'win32' && existsSync(paths.socketPath))
                await unlink(paths.socketPath);
            await startupObserver?.transition('before-sqlite-open-reconciliation', plannedLifecycle);
            store = clock === undefined ? await CoordinatorStore.open(paths, undefined, { writerGuard: preparedWriterGuard }) : await CoordinatorStore.open(paths, clock, { writerGuard: preparedWriterGuard });
            await startupObserver?.transition('after-sqlite-open-reconciliation', plannedLifecycle);
            await publishCoordinatorRuntimeIdentity(paths, store.currentGeneration(), plannedLifecycle, preparedWriterGuard);
            readAndVerifyCoordinatorRuntimeIdentity(paths, store.currentGeneration(), plannedLifecycle);
        });
        const acquiredLifecycleLock = lifecycleLock;
        const openedWriterGuard = requirePreparedWriterGuard(writerGuard);
        const openedStore = requirePreparedStore(store);
        const openedCapability = requirePreparedCapability(capability);
        let timerFailure = null;
        let firstHandshakeTransition = null;
        const firstExactHandshake = async () => {
            firstHandshakeTransition ??= startupObserver?.transition('first-exact-handshake-served', acquiredLifecycleLock.record) ?? Promise.resolve();
            await firstHandshakeTransition;
        };
        server = createServer((socket) => handleSocket(socket, openedStore, openedCapability, paths, acquiredLifecycleLock.record, () => timerFailure, firstExactHandshake, requestDrain, testHooks));
        await startupObserver?.transition('before-socket-bind', acquiredLifecycleLock.record);
        await listen(server, paths.socketPath);
        serverListening = true;
        await startupObserver?.transition('after-listen-before-lifecycle-activation', acquiredLifecycleLock.record);
        const openedServer = server;
        if (platform() !== 'win32')
            await chmod(paths.socketPath, 0o600);
        // Schema migration, current socket publication, and old-format fence handoff
        // all complete under one lifecycle election. Only then may another startup or
        // restore operation enter the election.
        acquiredLifecycleLock.activate();
        await startupObserver?.transition('after-activation-before-first-handshake', acquiredLifecycleLock.record);
        offerTimer = setInterval(() => {
            void acquiredLifecycleLock.verifyOrRepairFence().then(async (outcome) => {
                if (outcome === 'verified') {
                    openedStore.sweepExpiredGrantOffers();
                    await runCoordinatorOwnedS2RetentionGc({ stateRoot: paths.stateRoot, runs: openedStore.terminalRunsForS2RetentionGc(), nowIso: new Date().toISOString() });
                }
                timerFailure = null;
            }).catch((error) => {
                timerFailure = error instanceof Error ? error : new Error(String(error));
            });
        }, COORDINATOR_GRANT_OFFER_SWEEP_MS);
        let closePromise = null;
        return {
            paths,
            store: openedStore,
            close: () => {
                closePromise ??= (async () => {
                    if (offerTimer !== null)
                        clearInterval(offerTimer);
                    offerTimer = null;
                    // Calling server.close synchronously retires listener acceptance. Only
                    // then may queued requests drain; idle/exhausted sockets are destroyed
                    // so the listener callback cannot outlive request authority.
                    const listenerClose = observeServerClose(openedServer);
                    requestDrain.beginDrain();
                    await requestDrain.waitForDrain();
                    const listenerCloseError = await listenerClose;
                    if (listenerCloseError !== null)
                        throw listenerCloseError;
                    if (platform() !== 'win32') {
                        await unlink(paths.socketPath).catch((unlinkError) => {
                            if (!(unlinkError instanceof Error && 'code' in unlinkError && unlinkError.code === 'ENOENT'))
                                throw unlinkError;
                        });
                    }
                    openedStore.close();
                    await acquiredLifecycleLock.release();
                    openedWriterGuard.release();
                })();
                return closePromise;
            },
        };
    }
    catch (error) {
        const cleanupFailures = [];
        if (offerTimer !== null)
            clearInterval(offerTimer);
        offerTimer = null;
        if (server !== null && serverListening) {
            try {
                const listenerClose = observeServerClose(server);
                requestDrain.beginDrain();
                await requestDrain.waitForDrain();
                const listenerCloseError = await listenerClose;
                if (listenerCloseError !== null)
                    throw listenerCloseError;
            }
            catch (closeError) {
                cleanupFailures.push(`server-drain-close: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
            }
        }
        try {
            closePreparedStore(store);
        }
        catch (closeError) {
            cleanupFailures.push(`store-close: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
        }
        if (lifecycleLock !== null) {
            try {
                await lifecycleLock.abortStartup();
            }
            catch (releaseError) {
                cleanupFailures.push(`lock-release: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
            }
        }
        if (cleanupFailures.length > 0)
            throw new CoordinationRuntimeError('system-fatal', 'coordinator startup failed and cleanup was incomplete; writer guard remains retained until process death', [error instanceof Error ? error.message : String(error), ...cleanupFailures]);
        releasePreparedWriterGuard(writerGuard);
        throw error;
    }
}
export async function runCoordinatorUntilSignal(paths, startupObserver) {
    let finishSignal = null;
    const signal = new Promise((resolveSignal) => {
        finishSignal = resolveSignal;
    });
    const finish = () => finishSignal?.();
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    process.once('SIGHUP', finish);
    try {
        const running = await startCoordinatorServer(paths, undefined, undefined, undefined, startupObserver);
        await signal;
        await running.close();
    }
    finally {
        process.off('SIGINT', finish);
        process.off('SIGTERM', finish);
        process.off('SIGHUP', finish);
    }
}
