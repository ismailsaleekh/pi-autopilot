import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCoordinatorRequestEnvelope, parseCoordinatorResponseEnvelope } from "./contracts.js";
import { coordinationFailureDefinition, CoordinationRuntimeError } from "./failures.js";
import { AUTOPILOT_COORDINATOR_TRANSPORT_VERSION, CoordinatorFrameDecoder, encodeCoordinatorFrame } from "./ipc.js";
import { currentBootId, isProcessAlive } from "./process-identity.js";
import { COORDINATOR_DATABASE_SCHEMA_VERSION, COORDINATOR_PACKAGE_BUILD, coordinatorRuntimePaths, ensureCoordinatorPrivateRoots, readOrCreateCoordinatorCapability } from "./runtime-paths.js";
import { coordinationErrorCode } from "./store.js";
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const EMPTY_COORDINATOR_PAYLOAD = Object.freeze({});
function sleep(ms) {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
function errorCode(error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string')
        return error.code;
    return null;
}
function isConnectionFailure(error) {
    const code = errorCode(error);
    return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT';
}
function parseStartupLock(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    const record = value;
    const pid = record['pid'];
    const bootId = record['boot_id'];
    const acquiredAt = record['acquired_at'];
    const token = record['token'];
    if (record['schema_version'] !== 'autopilot.coordinator_startup_lock.v1' || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || typeof bootId !== 'string' || typeof acquiredAt !== 'string' || typeof token !== 'string')
        return null;
    return { schema_version: 'autopilot.coordinator_startup_lock.v1', pid, boot_id: bootId, acquired_at: acquiredAt, token };
}
async function readStartupLock(path) {
    try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        return parseStartupLock(value);
    }
    catch {
        return null;
    }
}
async function readStartupLockAfterConcurrentCreation(path) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const record = await readStartupLock(path);
        if (record !== null)
            return record;
        await sleep(10);
    }
    return null;
}
async function acquireStartupLock(paths, deadline) {
    await ensureCoordinatorPrivateRoots(paths);
    while (Date.now() < deadline) {
        let handle = null;
        try {
            handle = await open(paths.startupLockPath, 'wx', 0o600);
            const record = {
                schema_version: 'autopilot.coordinator_startup_lock.v1',
                pid: process.pid,
                boot_id: currentBootId(),
                acquired_at: new Date().toISOString(),
                token: randomBytes(24).toString('hex'),
            };
            await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
            await handle.sync();
            await handle.close();
            handle = null;
            return {
                release: async () => {
                    const current = await readStartupLock(paths.startupLockPath);
                    if (current !== null && current.token !== record.token)
                        throw new CoordinationRuntimeError('system-fatal', 'coordinator startup lock ownership changed');
                    await unlink(paths.startupLockPath).catch((error) => {
                        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                            throw error;
                    });
                },
            };
        }
        catch (error) {
            if (handle !== null) {
                try {
                    await handle.close();
                }
                catch (closeError) {
                    throw new CoordinationRuntimeError('system-fatal', 'coordinator startup lock creation and file close both failed', [error instanceof Error ? error.message : String(error), closeError instanceof Error ? closeError.message : String(closeError)]);
                }
            }
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
                throw error;
            const existing = await readStartupLockAfterConcurrentCreation(paths.startupLockPath);
            if (existing === null) {
                const lockStat = await stat(paths.startupLockPath).catch((statError) => {
                    if (statError instanceof Error && 'code' in statError && statError.code === 'ENOENT')
                        return null;
                    throw statError;
                });
                if (lockStat === null || Date.now() - lockStat.mtimeMs > DEFAULT_STARTUP_TIMEOUT_MS * 2) {
                    await unlink(paths.startupLockPath).catch((unlinkError) => {
                        if (!(unlinkError instanceof Error && 'code' in unlinkError && unlinkError.code === 'ENOENT'))
                            throw unlinkError;
                    });
                }
                else
                    await sleep(50);
            }
            else {
                const stale = existing.boot_id !== currentBootId() || !isProcessAlive(existing.pid) || Date.now() - Date.parse(existing.acquired_at) > DEFAULT_STARTUP_TIMEOUT_MS * 2;
                if (stale) {
                    await unlink(paths.startupLockPath).catch((unlinkError) => {
                        if (!(unlinkError instanceof Error && 'code' in unlinkError && unlinkError.code === 'ENOENT'))
                            throw unlinkError;
                    });
                }
                else
                    await sleep(50);
            }
        }
    }
    throw new CoordinationRuntimeError('coordinator-contention', 'timed out acquiring coordinator startup lock');
}
function coordinatorCliPath() {
    const compiled = fileURLToPath(new URL('../../cli/autopilot-coordinator.js', import.meta.url));
    if (existsSync(compiled))
        return { path: compiled, stripTypes: false };
    const source = fileURLToPath(new URL('../../cli/autopilot-coordinator.ts', import.meta.url));
    if (existsSync(source))
        return { path: source, stripTypes: true };
    throw new CoordinationRuntimeError('coordinator-unavailable', 'packaged coordinator CLI entrypoint is missing', [compiled, source]);
}
function spawnCoordinator(paths) {
    const cli = coordinatorCliPath();
    const args = [...(cli.stripTypes ? ['--experimental-strip-types'] : []), cli.path, 'serve', '--state-root', paths.stateRoot];
    const child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, AUTOPILOT_STATE_ROOT: paths.stateRoot },
    });
    child.unref();
}
function connectSocket(path, timeoutMs) {
    return new Promise((resolveConnect, rejectConnect) => {
        const socket = connect(path);
        const timer = setTimeout(() => {
            socket.destroy();
            const error = new Error(`coordinator connection timed out after ${String(timeoutMs)} ms`);
            Object.assign(error, { code: 'ETIMEDOUT' });
            rejectConnect(error);
        }, timeoutMs);
        socket.once('connect', () => {
            clearTimeout(timer);
            socket.off('error', onError);
            resolveConnect(socket);
        });
        const onError = (error) => {
            clearTimeout(timer);
            rejectConnect(error);
        };
        socket.once('error', onError);
    });
}
async function sendOnce(paths, capability, request, timeoutMs) {
    const socket = await connectSocket(paths.socketPath, timeoutMs);
    const decoder = new CoordinatorFrameDecoder();
    return await new Promise((resolveResponse, rejectResponse) => {
        let settled = false;
        const finishError = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            rejectResponse(error);
        };
        const finishResponse = (response) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket.end();
            resolveResponse(response);
        };
        const timer = setTimeout(() => {
            const error = new Error(`coordinator request timed out after ${String(timeoutMs)} ms`);
            Object.assign(error, { code: 'ETIMEDOUT' });
            finishError(error);
        }, timeoutMs);
        socket.on('data', (chunk) => {
            try {
                for (const frame of decoder.push(chunk)) {
                    const response = parseCoordinatorResponseEnvelope(frame);
                    if (response.request_id !== request.request_id)
                        throw new CoordinationRuntimeError('invalid-state', 'coordinator response request id mismatch');
                    finishResponse(response);
                    break;
                }
            }
            catch (error) {
                finishError(error instanceof Error ? error : new Error(String(error)));
            }
        });
        socket.once('error', finishError);
        socket.once('close', () => {
            if (!settled)
                finishError(new Error('coordinator connection closed before a response'));
        });
        const transport = { transport_version: AUTOPILOT_COORDINATOR_TRANSPORT_VERSION, capability, request };
        socket.write(encodeCoordinatorFrame(transport), (error) => {
            if (error !== null && error !== undefined)
                finishError(error);
        });
    });
}
export class CoordinatorClient {
    #paths;
    #autoStart;
    #requestTimeoutMs;
    #startupTimeoutMs;
    #compatibilityVerified = false;
    constructor(options = {}) {
        this.#paths = coordinatorRuntimePaths(options.env ?? process.env);
        this.#autoStart = options.autoStart !== false;
        this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    }
    get paths() {
        return this.#paths;
    }
    async request(requestValue) {
        const request = parseCoordinatorRequestEnvelope(requestValue);
        const capability = await readOrCreateCoordinatorCapability(this.#paths);
        if (!this.#compatibilityVerified && request.action !== 'status') {
            const probeResponse = await this.#sendWithRecovery(this.#probeRequest(), capability);
            this.#assertCoordinatorCompatibility(probeResponse);
            this.#compatibilityVerified = true;
        }
        const response = await this.#sendWithRecovery(request, capability);
        if (request.action === 'status') {
            this.#assertCoordinatorCompatibility(response);
            this.#compatibilityVerified = true;
        }
        return response;
    }
    async #sendWithRecovery(request, capability) {
        try {
            return this.#assertSuccess(await sendOnce(this.#paths, capability, request, this.#requestTimeoutMs));
        }
        catch (error) {
            if (!this.#autoStart || !isConnectionFailure(error))
                throw error;
            await this.#ensureStarted(capability);
            try {
                return this.#assertSuccess(await sendOnce(this.#paths, capability, request, this.#requestTimeoutMs));
            }
            catch (retryError) {
                if (isConnectionFailure(retryError))
                    throw new CoordinationRuntimeError('coordinator-unavailable', retryError instanceof Error ? retryError.message : String(retryError));
                throw retryError;
            }
        }
    }
    async query(action, repoId = 'global', workstreamRun = null, payload = {}) {
        return await this.request({
            schema_version: 'autopilot.coordinator_request.v1',
            protocol_version: '1.0',
            request_id: `request-${randomUUID()}`,
            action,
            idempotency_key: null,
            repo_id: repoId,
            workstream_run: workstreamRun,
            session_id: null,
            fencing_generation: null,
            expected_version: null,
            payload,
        });
    }
    async mutate(action, identity, payload) {
        return await this.request({
            schema_version: 'autopilot.coordinator_request.v1',
            protocol_version: '1.0',
            request_id: `request-${randomUUID()}`,
            action,
            idempotency_key: identity.idempotencyKey,
            repo_id: identity.repoId,
            workstream_run: identity.workstreamRun,
            session_id: identity.sessionId,
            fencing_generation: identity.fencingGeneration,
            expected_version: identity.expectedVersion,
            payload,
        });
    }
    async #ensureStarted(capability) {
        const deadline = Date.now() + this.#startupTimeoutMs;
        const lock = await acquireStartupLock(this.#paths, deadline);
        try {
            const probe = this.#probeRequest();
            try {
                const response = this.#assertSuccess(await sendOnce(this.#paths, capability, probe, Math.min(500, this.#requestTimeoutMs)));
                this.#assertCoordinatorCompatibility(response);
                this.#compatibilityVerified = true;
                return;
            }
            catch (error) {
                if (!isConnectionFailure(error))
                    throw error;
            }
            spawnCoordinator(this.#paths);
            while (Date.now() < deadline) {
                try {
                    const response = this.#assertSuccess(await sendOnce(this.#paths, capability, probe, Math.min(500, this.#requestTimeoutMs)));
                    this.#assertCoordinatorCompatibility(response);
                    this.#compatibilityVerified = true;
                    return;
                }
                catch (error) {
                    if (!isConnectionFailure(error))
                        throw error;
                    await sleep(50);
                }
            }
            throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator did not become ready before the startup deadline');
        }
        finally {
            await lock.release();
        }
    }
    #probeRequest() {
        return {
            schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.0', request_id: `probe-${randomUUID()}`, action: 'status', idempotency_key: null, repo_id: 'global', workstream_run: null, session_id: null, fencing_generation: null, expected_version: null, payload: EMPTY_COORDINATOR_PAYLOAD,
        };
    }
    #assertCoordinatorCompatibility(response) {
        if (response.payload['schema_version'] !== 'autopilot.coordinator_status.v1')
            throw new CoordinationRuntimeError('schema-mismatch', 'coordinator readiness handshake omitted its status schema');
        if (response.payload['package_build'] !== COORDINATOR_PACKAGE_BUILD)
            throw new CoordinationRuntimeError('protocol-mismatch', `coordinator package build is incompatible with ${COORDINATOR_PACKAGE_BUILD}`);
        if (response.payload['protocol_version'] !== '1.0')
            throw new CoordinationRuntimeError('protocol-mismatch', 'coordinator handshake protocol version is incompatible');
        if (response.payload['database_schema_version'] !== COORDINATOR_DATABASE_SCHEMA_VERSION)
            throw new CoordinationRuntimeError('schema-mismatch', `coordinator database schema is incompatible with ${String(COORDINATOR_DATABASE_SCHEMA_VERSION)}`);
    }
    #assertSuccess(response) {
        if (response.ok)
            return response;
        const code = coordinationErrorCode(response.error_code);
        const definition = coordinationFailureDefinition(code);
        const message = typeof response.payload['message'] === 'string' ? response.payload['message'] : `coordinator request failed with ${code}`;
        throw new CoordinationRuntimeError(code, message, [`failure_class=${definition.failure_class}`]);
    }
}
export function durableIdentifier(prefix, value) {
    return `${prefix}-${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)}`;
}
