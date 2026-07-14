import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, open, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { platform } from 'node:os';
import { encodeCoordinatorFrame, parseCoordinatorLegacyReplayTransportRequest, parseCoordinatorTransportRequest, CoordinatorFrameDecoder, writeCoordinatorResponse } from "./ipc.js";
import { CoordinationRuntimeError } from "./failures.js";
import { currentBootId, isProcessAlive, predecessorCompatibleBootId, processStartIdentity } from "./process-identity.js";
import { COORDINATOR_GRANT_OFFER_SWEEP_MS, enforcePrivateAuthorityPath, ensureCoordinatorPrivateRoots, readOrCreateCoordinatorCapability } from "./runtime-paths.js";
import { acquireSerializedProcessGuard, discardLockTombstone, quarantineExactLock, readExactLockText, restoreLockTombstone } from "./serialized-lock.js";
import { CoordinatorStore } from "./store.js";
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION } from "./types.js";
import { readKnownCoordinatorUpgradeIntent, recordCoordinatorFenceHandoff } from "./upgrade.js";
import { COORDINATOR_UPGRADE_PATH, parseCurrentCoordinatorLock, parseKnownCompatibleCurrentCoordinatorLock, parsePredecessorCoordinatorLock, parsePriorSchema11CurrentCoordinatorLock, parsePriorSchema10CurrentCoordinatorLock, parsePriorSchema9CurrentCoordinatorLock } from "./upgrade-contracts.js";
export class CoordinatorAlreadyRunningError extends Error {
    name = 'CoordinatorAlreadyRunningError';
}
function failureText(error) { return error instanceof Error ? error.message : String(error); }
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
async function acquireCoordinatorLock(paths, adoption) {
    await ensureCoordinatorPrivateRoots(paths);
    const election = adoption === undefined
        ? acquireSerializedProcessGuard(paths.lifecycleElectionPath, 10_000, 'coordinator lifecycle election')
        : { release: () => adoption.releaseElection() };
    let currentTombstone = null;
    let predecessorTombstone = null;
    let predecessorRestore = null;
    let createdCurrent = false;
    let createdFence = false;
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
        package_build: COORDINATOR_UPGRADE_PATH.target.package_build,
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
            try {
                const parsed = JSON.parse(currentText);
                current = parseKnownCompatibleCurrentCoordinatorLock(parsed) ?? parsePriorSchema11CurrentCoordinatorLock(parsed) ?? parsePriorSchema10CurrentCoordinatorLock(parsed) ?? parsePriorSchema9CurrentCoordinatorLock(parsed);
            }
            catch { /* fail below */ }
            if (current === null)
                throw new CoordinationRuntimeError('protocol-mismatch', 'current-generation lifecycle lock belongs to an unknown build');
            // PID liveness always wins. Boot-id disagreement is never stale proof.
            if (isProcessAlive(current.pid))
                throw new CoordinatorAlreadyRunningError(`coordinator is already running as pid ${String(current.pid)}`);
            currentTombstone = await quarantineExactLock(paths.lockPath, currentText, 'dead current-generation coordinator lock');
        }
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
            if (isProcessAlive(predecessor.pid) && !authorizedHandoff)
                throw new CoordinatorAlreadyRunningError(`predecessor lifecycle path is fenced by live pid ${String(predecessor.pid)}`);
            if (authorizedHandoff) {
                predecessorRestore = predecessor;
                await replacePredecessorFence(paths.predecessorLockPath, predecessorFence);
                createdFence = true;
                if (upgradeHandoff)
                    await recordCoordinatorFenceHandoff(paths, predecessor, predecessorFence);
                adoption?.adopted(predecessorFence);
            }
            else {
                predecessorTombstone = await quarantineExactLock(paths.predecessorLockPath, predecessorText, 'dead predecessor fence replacement');
                await writePredecessorFence(paths.predecessorLockPath, predecessorFence);
                createdFence = true;
            }
        }
        else {
            await writePredecessorFence(paths.predecessorLockPath, predecessorFence);
            createdFence = true;
        }
        if (currentTombstone !== null) {
            await discardLockTombstone(currentTombstone);
            currentTombstone = null;
        }
        if (predecessorTombstone !== null) {
            await discardLockTombstone(predecessorTombstone);
            predecessorTombstone = null;
        }
        const verifyOrRepairFence = async () => {
            const guard = acquireSerializedProcessGuard(paths.lifecycleElectionPath, 2_000, 'predecessor fence maintenance');
            try {
                const text = await readExactLockText(paths.predecessorLockPath);
                if (text === null) {
                    await writePredecessorFence(paths.predecessorLockPath, predecessorFence);
                    return;
                }
                const observed = parsePredecessorCoordinatorLock(JSON.parse(text));
                if (observed !== null && samePredecessorFenceOwner(observed, predecessorFence)) {
                    const refreshed = { ...predecessorFence, boot_id: predecessorCompatibleBootId() };
                    if (!samePredecessorLock(observed, refreshed))
                        await replacePredecessorFence(paths.predecessorLockPath, refreshed);
                    predecessorFence = refreshed;
                    return;
                }
                if (observed === null)
                    throw new CoordinationRuntimeError('system-fatal', 'old-format predecessor fence became unreadable');
                if (isProcessAlive(observed.pid))
                    throw new CoordinationRuntimeError('system-fatal', 'a live stale coordinator displaced the predecessor fence', [`pid=${String(observed.pid)}`]);
                const tombstone = await quarantineExactLock(paths.predecessorLockPath, text, 'dead stale predecessor lock');
                predecessorFence = { ...predecessorFence, boot_id: predecessorCompatibleBootId() };
                await writePredecessorFence(paths.predecessorLockPath, predecessorFence);
                await discardLockTombstone(tombstone);
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
function writeLegacyReplayResponse(socket, response, protocol) {
    const legacy = { ...response, protocol_version: protocol };
    return new Promise((resolveWrite, rejectWrite) => {
        socket.write(encodeCoordinatorFrame(legacy), (error) => {
            if (error === undefined || error === null)
                resolveWrite();
            else
                rejectWrite(error);
        });
    });
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
        retryable: runtime.retry_policy !== 'never',
        payload: { message: runtime.message, evidence: runtime.evidence },
    };
}
function handleSocket(socket, store, capability, paths, backgroundFailure, testHooks) {
    const decoder = new CoordinatorFrameDecoder();
    let chain = Promise.resolve();
    socket.on('data', (chunk) => {
        chain = chain.then(async () => {
            const frames = decoder.push(chunk);
            for (const frame of frames) {
                let requestId = `transport-error-${randomBytes(8).toString('hex')}`;
                try {
                    let response = null;
                    let legacyReplayProtocol = null;
                    let action = null;
                    let currentTransport = null;
                    try {
                        currentTransport = parseCoordinatorTransportRequest(frame);
                    }
                    catch (currentProtocolError) {
                        let legacy;
                        try {
                            legacy = parseCoordinatorLegacyReplayTransportRequest(frame);
                        }
                        catch {
                            throw currentProtocolError;
                        }
                        const legacyRequestId = legacy.request['request_id'];
                        if (typeof legacyRequestId === 'string')
                            requestId = legacyRequestId;
                        if (!authenticated(legacy.capability, capability))
                            throw new CoordinationRuntimeError('unauthorized-client', 'coordinator capability proof was rejected');
                        action = typeof legacy.request['action'] === 'string' ? legacy.request['action'] : null;
                        const timerFailure = backgroundFailure();
                        if (timerFailure !== null)
                            throw new CoordinationRuntimeError('system-fatal', `coordinator predecessor fence maintenance failed: ${timerFailure.message}`);
                        const upgradeIntent = await readKnownCoordinatorUpgradeIntent(paths);
                        if (upgradeIntent !== null && upgradeIntent.state !== 'committed' && action !== 'handshake' && action !== 'status' && action !== 'doctor')
                            throw new CoordinationRuntimeError('coordinator-contention', 'coordinator upgrade is not durably committed; mutation/replay authority remains closed');
                        response = store.replayLegacyRequest(legacy.request);
                        legacyReplayProtocol = legacy.replay_protocol;
                    }
                    if (currentTransport !== null) {
                        requestId = currentTransport.request.request_id;
                        action = currentTransport.request.action;
                        if (!authenticated(currentTransport.capability, capability))
                            throw new CoordinationRuntimeError('unauthorized-client', 'coordinator capability proof was rejected');
                        const timerFailure = backgroundFailure();
                        if (timerFailure !== null)
                            throw new CoordinationRuntimeError('system-fatal', `coordinator predecessor fence maintenance failed: ${timerFailure.message}`);
                        const upgradeIntent = await readKnownCoordinatorUpgradeIntent(paths);
                        if (upgradeIntent !== null && upgradeIntent.state !== 'committed' && action !== 'handshake' && action !== 'status' && action !== 'doctor')
                            throw new CoordinationRuntimeError('coordinator-contention', 'coordinator upgrade is not durably committed; mutation authority remains closed');
                        response = store.handle(currentTransport.request);
                        if (response.ok && response.committed_event_seq !== null)
                            await testHooks?.afterStoreCommitBeforeResponse?.(currentTransport.request.action, response);
                    }
                    if (response === null)
                        throw new CoordinationRuntimeError('system-fatal', 'coordinator request parsing produced no response path');
                    if (legacyReplayProtocol !== null)
                        await writeLegacyReplayResponse(socket, response, legacyReplayProtocol);
                    else
                        await writeCoordinatorResponse(socket, response);
                }
                catch (error) {
                    await writeCoordinatorResponse(socket, errorResponse(requestId, error));
                }
            }
        }).catch(() => socket.destroy());
    });
    socket.on('end', () => {
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
export async function startCoordinatorServer(paths, clock, adoption, testHooks) {
    const lifecycleLock = await acquireCoordinatorLock(paths, adoption);
    let store = null;
    let server = null;
    let offerTimer = null;
    let serverListening = false;
    try {
        const capability = await readOrCreateCoordinatorCapability(paths);
        if (platform() !== 'win32' && existsSync(paths.socketPath))
            await unlink(paths.socketPath);
        store = clock === undefined ? await CoordinatorStore.open(paths) : await CoordinatorStore.open(paths, clock);
        const openedStore = store;
        let timerFailure = null;
        server = createServer((socket) => handleSocket(socket, openedStore, capability, paths, () => timerFailure, testHooks));
        await listen(server, paths.socketPath);
        serverListening = true;
        const openedServer = server;
        if (platform() !== 'win32')
            await chmod(paths.socketPath, 0o600);
        // Schema migration, current socket publication, and old-format fence handoff
        // all complete under one lifecycle election. Only then may another startup or
        // restore operation enter the election.
        lifecycleLock.activate();
        offerTimer = setInterval(() => {
            void lifecycleLock.verifyOrRepairFence().then(() => {
                openedStore.sweepExpiredGrantOffers();
                timerFailure = null;
            }).catch((error) => {
                timerFailure = error instanceof Error ? error : new Error(String(error));
            });
        }, COORDINATOR_GRANT_OFFER_SWEEP_MS);
        let closed = false;
        let serverClosed = false;
        let storeClosed = false;
        return {
            paths,
            store: openedStore,
            close: async () => {
                if (closed)
                    return;
                if (offerTimer !== null)
                    clearInterval(offerTimer);
                offerTimer = null;
                if (!serverClosed) {
                    await closeServer(openedServer);
                    serverClosed = true;
                }
                if (platform() !== 'win32') {
                    await unlink(paths.socketPath).catch((unlinkError) => {
                        if (!(unlinkError instanceof Error && 'code' in unlinkError && unlinkError.code === 'ENOENT'))
                            throw unlinkError;
                    });
                }
                if (!storeClosed) {
                    openedStore.close();
                    storeClosed = true;
                }
                await lifecycleLock.release();
                closed = true;
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
                await closeServer(server);
            }
            catch (closeError) {
                cleanupFailures.push(`server-close: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
            }
        }
        if (store !== null) {
            try {
                store.close();
            }
            catch (closeError) {
                cleanupFailures.push(`store-close: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
            }
        }
        try {
            await lifecycleLock.abortStartup();
        }
        catch (releaseError) {
            cleanupFailures.push(`lock-release: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
        }
        if (cleanupFailures.length > 0)
            throw new CoordinationRuntimeError('system-fatal', 'coordinator startup failed and cleanup was incomplete', [error instanceof Error ? error.message : String(error), ...cleanupFailures]);
        throw error;
    }
}
export async function runCoordinatorUntilSignal(paths) {
    let finishSignal = null;
    const signal = new Promise((resolveSignal) => {
        finishSignal = resolveSignal;
    });
    const finish = () => finishSignal?.();
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    process.once('SIGHUP', finish);
    try {
        const running = await startCoordinatorServer(paths);
        await signal;
        await running.close();
    }
    finally {
        process.off('SIGINT', finish);
        process.off('SIGTERM', finish);
        process.off('SIGHUP', finish);
    }
}
