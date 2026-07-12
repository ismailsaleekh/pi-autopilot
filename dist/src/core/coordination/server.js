import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, open, readFile, stat, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { platform } from 'node:os';
import { encodeCoordinatorFrame, parseCoordinatorLegacyReplayTransportRequest, parseCoordinatorTransportRequest, CoordinatorFrameDecoder, writeCoordinatorResponse } from "./ipc.js";
import { CoordinationRuntimeError } from "./failures.js";
import { currentBootId, isProcessAlive } from "./process-identity.js";
import { COORDINATOR_GRANT_OFFER_SWEEP_MS, ensureCoordinatorPrivateRoots, readOrCreateCoordinatorCapability } from "./runtime-paths.js";
import { CoordinatorStore } from "./store.js";
export class CoordinatorAlreadyRunningError extends Error {
    name = 'CoordinatorAlreadyRunningError';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseLockRecord(value) {
    if (!isRecord(value))
        return null;
    const pid = value['pid'];
    const bootId = value['boot_id'];
    const token = value['token'];
    const startedAt = value['started_at'];
    if (value['schema_version'] !== 'autopilot.coordinator_lock.v1' || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || typeof bootId !== 'string' || typeof token !== 'string' || typeof startedAt !== 'string')
        return null;
    return { schema_version: 'autopilot.coordinator_lock.v1', pid, boot_id: bootId, token, started_at: startedAt };
}
async function readLock(path) {
    try {
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        return parseLockRecord(parsed);
    }
    catch {
        return null;
    }
}
async function readLockAfterConcurrentCreation(path) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const record = await readLock(path);
        if (record !== null)
            return record;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    return null;
}
async function acquireCoordinatorLock(paths) {
    await ensureCoordinatorPrivateRoots(paths);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        let handle = null;
        try {
            handle = await open(paths.lockPath, 'wx', 0o600);
            const record = {
                schema_version: 'autopilot.coordinator_lock.v1',
                pid: process.pid,
                boot_id: currentBootId(),
                token: randomBytes(24).toString('hex'),
                started_at: new Date().toISOString(),
            };
            await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
            await handle.sync();
            await handle.close();
            handle = null;
            return {
                record,
                release: async () => {
                    const current = await readLock(paths.lockPath);
                    if (current === null || current.token !== record.token)
                        throw new CoordinationRuntimeError('system-fatal', 'coordinator lifecycle lock ownership changed before release');
                    await unlink(paths.lockPath);
                },
            };
        }
        catch (error) {
            if (handle !== null) {
                try {
                    await handle.close();
                }
                catch (closeError) {
                    throw new CoordinationRuntimeError('system-fatal', 'coordinator lifecycle lock creation and file close both failed', [error instanceof Error ? error.message : String(error), closeError instanceof Error ? closeError.message : String(closeError)]);
                }
            }
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
                throw error;
            const existing = await readLockAfterConcurrentCreation(paths.lockPath);
            if (existing !== null && existing.boot_id === currentBootId() && isProcessAlive(existing.pid))
                throw new CoordinatorAlreadyRunningError(`coordinator is already running as pid ${String(existing.pid)}`);
            if (existing === null) {
                const lockStat = await stat(paths.lockPath).catch((statError) => {
                    if (statError instanceof Error && 'code' in statError && statError.code === 'ENOENT')
                        return null;
                    throw statError;
                });
                if (lockStat !== null && Date.now() - lockStat.mtimeMs < 30_000)
                    throw new CoordinationRuntimeError('coordinator-contention', 'coordinator lifecycle lock is fresh but incomplete');
            }
            await unlink(paths.lockPath).catch((unlinkError) => {
                if (!(unlinkError instanceof Error && 'code' in unlinkError && unlinkError.code === 'ENOENT'))
                    throw unlinkError;
            });
        }
    }
    throw new CoordinationRuntimeError('coordinator-contention', 'could not acquire coordinator lifecycle lock');
}
function authenticated(provided, expected) {
    const left = Buffer.from(provided, 'utf8');
    const right = Buffer.from(expected, 'utf8');
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
function writeLegacyReplayResponse(socket, response) {
    const legacy = { ...response, protocol_version: '1.1' };
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
        protocol_version: '1.2',
        request_id: requestId,
        ok: false,
        committed_event_seq: null,
        error_code: runtime.code,
        retryable: runtime.retry_policy !== 'never',
        payload: { message: runtime.message, evidence: runtime.evidence },
    };
}
function handleSocket(socket, store, capability, backgroundFailure) {
    const decoder = new CoordinatorFrameDecoder();
    let chain = Promise.resolve();
    socket.on('data', (chunk) => {
        chain = chain.then(async () => {
            const frames = decoder.push(chunk);
            for (const frame of frames) {
                let requestId = `transport-error-${randomBytes(8).toString('hex')}`;
                try {
                    let response = null;
                    let legacyReplay = false;
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
                        response = store.replayLegacyRequest(legacy.request);
                        legacyReplay = true;
                    }
                    if (currentTransport !== null) {
                        requestId = currentTransport.request.request_id;
                        if (!authenticated(currentTransport.capability, capability))
                            throw new CoordinationRuntimeError('unauthorized-client', 'coordinator capability proof was rejected');
                        response = store.handle(currentTransport.request);
                    }
                    if (response === null)
                        throw new CoordinationRuntimeError('system-fatal', 'coordinator request parsing produced no response path');
                    const timerFailure = backgroundFailure();
                    if (timerFailure !== null)
                        throw new CoordinationRuntimeError('system-fatal', `coordinator grant-offer timer failed: ${timerFailure.message}`);
                    if (legacyReplay)
                        await writeLegacyReplayResponse(socket, response);
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
export async function startCoordinatorServer(paths, clock) {
    const lifecycleLock = await acquireCoordinatorLock(paths);
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
        offerTimer = setInterval(() => {
            try {
                openedStore.sweepExpiredGrantOffers();
            }
            catch (error) {
                timerFailure = error instanceof Error ? error : new Error(String(error));
            }
        }, COORDINATOR_GRANT_OFFER_SWEEP_MS);
        server = createServer((socket) => handleSocket(socket, openedStore, capability, () => timerFailure));
        await listen(server, paths.socketPath);
        serverListening = true;
        const openedServer = server;
        if (platform() !== 'win32')
            await chmod(paths.socketPath, 0o600);
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
            await lifecycleLock.release();
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
