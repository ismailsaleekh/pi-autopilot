import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCoordinatorRequestEnvelope, parseCoordinatorResponseEnvelope } from "./contracts.js";
import { coordinationFailureDefinition, CoordinationRuntimeError } from "./failures.js";
import { AUTOPILOT_COORDINATOR_TRANSPORT_VERSION, CoordinatorFrameDecoder, encodeCoordinatorFrame } from "./ipc.js";
import { activeCoordinationMigrationFreeze } from "./migration-paths.js";
import { currentBootId, isProcessAlive } from "./process-identity.js";
import { COORDINATOR_DATABASE_SCHEMA_VERSION, coordinatorRuntimePaths, enforcePrivateAuthorityPath, ensureCoordinatorPrivateRoots, readOrCreateCoordinatorCapability } from "./runtime-paths.js";
import { classifyCoordinatorRuntimeIdentity } from "./runtime-compatibility.js";
import { acquireSerializedProcessGuard, discardLockTombstone, quarantineExactLock, readExactLockText, restoreLockTombstone } from "./serialized-lock.js";
import { coordinationErrorCode } from "./store.js";
import { preparePredecessorCoordinatorUpgrade, resumeCoordinatorUpgrade } from "./upgrade.js";
import { parseKnownCompatibleCurrentCoordinatorLock, parsePredecessorCoordinatorLock, parsePriorSchema9CurrentCoordinatorLock } from "./upgrade-contracts.js";
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION } from "./types.js";
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
function sameStartupLock(left, right) {
    return left.pid === right.pid && left.boot_id === right.boot_id && left.acquired_at === right.acquired_at && left.token === right.token;
}
async function acquireStartupLock(paths, deadline) {
    await ensureCoordinatorPrivateRoots(paths);
    while (Date.now() < deadline) {
        let guard;
        try {
            guard = acquireSerializedProcessGuard(paths.startupElectionPath, Math.min(500, Math.max(1, deadline - Date.now())), 'coordinator startup election');
        }
        catch (error) {
            if (Date.now() >= deadline)
                throw error;
            await sleep(25);
            continue;
        }
        let handle = null;
        let reclaimedTombstone = null;
        let createdPath = false;
        try {
            const existingText = await readExactLockText(paths.startupLockPath);
            if (existingText !== null) {
                let existing = null;
                try {
                    existing = parseStartupLock(JSON.parse(existingText));
                }
                catch { /* fail below */ }
                if (existing === null)
                    throw new CoordinationRuntimeError('protocol-mismatch', 'coordinator startup lock is unreadable; refusing destructive replacement');
                // A live PID is never reclaimed because boot identity differs.
                if (isProcessAlive(existing.pid)) {
                    guard.release();
                    await sleep(50);
                    continue;
                }
                reclaimedTombstone = await quarantineExactLock(paths.startupLockPath, existingText, 'stale coordinator startup lock');
            }
            const record = {
                schema_version: 'autopilot.coordinator_startup_lock.v1',
                pid: process.pid,
                boot_id: currentBootId(),
                acquired_at: new Date().toISOString(),
                token: randomBytes(24).toString('hex'),
            };
            handle = await open(paths.startupLockPath, 'wx', 0o600);
            createdPath = true;
            await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
            await handle.sync();
            await handle.close();
            handle = null;
            await enforcePrivateAuthorityPath(paths.startupLockPath, false);
            if (reclaimedTombstone !== null)
                await discardLockTombstone(reclaimedTombstone);
            return {
                release: async () => {
                    try {
                        const currentText = await readExactLockText(paths.startupLockPath);
                        if (currentText === null)
                            throw new CoordinationRuntimeError('system-fatal', 'coordinator startup lock disappeared before release');
                        let current = null;
                        try {
                            current = parseStartupLock(JSON.parse(currentText));
                        }
                        catch { /* fail below */ }
                        if (current === null || !sameStartupLock(current, record))
                            throw new CoordinationRuntimeError('system-fatal', 'coordinator startup lock ownership changed');
                        const tombstone = await quarantineExactLock(paths.startupLockPath, currentText, 'coordinator startup lock');
                        await discardLockTombstone(tombstone);
                    }
                    finally {
                        guard.release();
                    }
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
            if (createdPath)
                await unlink(paths.startupLockPath).catch(() => undefined);
            if (reclaimedTombstone !== null)
                await restoreLockTombstone(paths.startupLockPath, reclaimedTombstone, 'stale coordinator startup lock');
            guard.release();
            throw error;
        }
    }
    throw new CoordinationRuntimeError('coordinator-contention', 'timed out acquiring coordinator startup lock');
}
async function acquirePredecessorStartupFence(paths, deadline) {
    while (Date.now() < deadline) {
        let handle = null;
        try {
            handle = await open(paths.predecessorStartupLockPath, 'wx', 0o600);
            const record = { schema_version: 'autopilot.coordinator_startup_lock.v1', pid: process.pid, boot_id: currentBootId(), acquired_at: new Date().toISOString(), token: randomBytes(24).toString('hex') };
            await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
            await handle.sync();
            await handle.close();
            handle = null;
            await enforcePrivateAuthorityPath(paths.predecessorStartupLockPath, false);
            return {
                release: async () => {
                    const text = await readExactLockText(paths.predecessorStartupLockPath);
                    if (text === null)
                        throw new CoordinationRuntimeError('system-fatal', 'predecessor startup fence disappeared before release');
                    const current = parseStartupLock(JSON.parse(text));
                    if (current === null || !sameStartupLock(current, record))
                        throw new CoordinationRuntimeError('system-fatal', 'predecessor startup fence ownership changed');
                    const tombstone = await quarantineExactLock(paths.predecessorStartupLockPath, text, 'predecessor startup fence');
                    await discardLockTombstone(tombstone);
                },
            };
        }
        catch (error) {
            if (handle !== null)
                await handle.close().catch(() => undefined);
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
                throw error;
            const text = await readExactLockText(paths.predecessorStartupLockPath);
            if (text === null)
                continue;
            let existing = null;
            try {
                existing = parseStartupLock(JSON.parse(text));
            }
            catch { /* fail below */ }
            if (existing === null)
                throw new CoordinationRuntimeError('protocol-mismatch', 'predecessor startup fence is unreadable');
            if (isProcessAlive(existing.pid)) {
                await sleep(50);
                continue;
            }
            const tombstone = await quarantineExactLock(paths.predecessorStartupLockPath, text, 'dead predecessor startup lock');
            await discardLockTombstone(tombstone);
        }
    }
    throw new CoordinationRuntimeError('coordinator-contention', 'timed out acquiring predecessor-compatible startup fence');
}
async function hasLiveExactPredecessor(paths) {
    const text = await readExactLockText(paths.predecessorLockPath);
    if (text === null)
        return false;
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return false;
    }
    const lock = parsePredecessorCoordinatorLock(value);
    return lock !== null && isProcessAlive(lock.pid);
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
                    if (typeof frame === 'object' && frame !== null && !Array.isArray(frame)) {
                        const observedProtocol = frame['protocol_version'];
                        if (typeof observedProtocol === 'string' && observedProtocol !== AUTOPILOT_COORDINATOR_PROTOCOL_VERSION)
                            throw new CoordinationRuntimeError('protocol-mismatch', `coordinator response protocol ${observedProtocol} is incompatible with ${AUTOPILOT_COORDINATOR_PROTOCOL_VERSION}`);
                    }
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
async function sendAfterCompatibleHandshake(paths, capability, probe, request, timeoutMs, validateProbe) {
    const socket = await connectSocket(paths.socketPath, timeoutMs);
    const decoder = new CoordinatorFrameDecoder();
    return await new Promise((resolveResponse, rejectResponse) => {
        let settled = false;
        let phase = 'probe';
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
        const writeRequest = (value) => {
            const transport = { transport_version: AUTOPILOT_COORDINATOR_TRANSPORT_VERSION, capability, request: value };
            socket.write(encodeCoordinatorFrame(transport), (error) => {
                if (error !== null && error !== undefined)
                    finishError(error);
            });
        };
        const timer = setTimeout(() => {
            const error = new Error(`coordinator request timed out after ${String(timeoutMs)} ms`);
            Object.assign(error, { code: 'ETIMEDOUT' });
            finishError(error);
        }, timeoutMs);
        socket.on('data', (chunk) => {
            try {
                const frames = decoder.push(chunk);
                if (frames.length > 1)
                    throw new CoordinationRuntimeError('invalid-state', 'coordinator sent unsolicited response frames before the next request');
                for (const frame of frames) {
                    if (typeof frame === 'object' && frame !== null && !Array.isArray(frame)) {
                        const observedProtocol = frame['protocol_version'];
                        if (typeof observedProtocol === 'string' && observedProtocol !== AUTOPILOT_COORDINATOR_PROTOCOL_VERSION)
                            throw new CoordinationRuntimeError('protocol-mismatch', `coordinator response protocol ${observedProtocol} is incompatible with ${AUTOPILOT_COORDINATOR_PROTOCOL_VERSION}`);
                    }
                    const response = parseCoordinatorResponseEnvelope(frame);
                    if (phase === 'probe') {
                        if (response.request_id !== probe.request_id)
                            throw new CoordinationRuntimeError('invalid-state', 'coordinator handshake response request id mismatch');
                        validateProbe(response);
                        phase = 'request';
                        writeRequest(request);
                    }
                    else {
                        if (response.request_id !== request.request_id)
                            throw new CoordinationRuntimeError('invalid-state', 'coordinator response request id mismatch');
                        finishResponse(response);
                    }
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
        writeRequest(probe);
    });
}
export class CoordinatorClient {
    #paths;
    #autoStart;
    #allowMigrationRecoveryAutoStart;
    #requestTimeoutMs;
    #startupTimeoutMs;
    constructor(options = {}) {
        this.#paths = coordinatorRuntimePaths(options.env ?? process.env);
        this.#autoStart = options.autoStart !== false;
        this.#allowMigrationRecoveryAutoStart = options.allowMigrationRecoveryAutoStart === true;
        this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    }
    get paths() {
        return this.#paths;
    }
    async request(requestValue) {
        const request = parseCoordinatorRequestEnvelope(requestValue);
        const capability = await readOrCreateCoordinatorCapability(this.#paths);
        return await this.#sendWithRecovery(request, capability);
    }
    async #sendCompatibleRequestOnce(request, capability, timeoutMs) {
        if (request.action === 'handshake') {
            const response = this.#assertSuccess(await sendOnce(this.#paths, capability, request, timeoutMs));
            this.#assertCoordinatorCompatibility(response);
            return response;
        }
        return this.#assertSuccess(await sendAfterCompatibleHandshake(this.#paths, capability, this.#probeRequest(), request, timeoutMs, (probeResponse) => {
            this.#assertCoordinatorCompatibility(this.#assertSuccess(probeResponse));
        }));
    }
    async #sendWithRecovery(request, capability) {
        try {
            return await this.#sendCompatibleRequestOnce(request, capability, this.#requestTimeoutMs);
        }
        catch (error) {
            // A responding but incompatible endpoint is authoritative evidence, not a
            // missing daemon. Never route it into replacement or predecessor upgrade.
            if (!this.#autoStart || !isConnectionFailure(error))
                throw error;
            const freeze = activeCoordinationMigrationFreeze(this.#paths.stateRoot);
            const recoveryAction = request.action === 'handshake' || request.action === 'status' || request.action === 'doctor' || request.action === 'export' || request.action === 'migration-recovery' || request.action === 'run-catalog' || request.action === 'attach-migration-recovery' || request.action === 'resolve-migration-recovery' || request.action === 'detach-session' || request.action === 'heartbeat';
            if (freeze !== null && !(this.#allowMigrationRecoveryAutoStart && recoveryAction))
                throw new CoordinationRuntimeError('coordinator-contention', 'coordinator auto-start is forbidden while coordination migration is frozen; only an explicit recovery client may start the imported candidate store', [freeze]);
            await this.#ensureStarted(capability);
            const retryDeadline = Date.now() + this.#requestTimeoutMs;
            let lastRetryError = error;
            while (Date.now() < retryDeadline) {
                try {
                    return await this.#sendCompatibleRequestOnce(request, capability, Math.min(500, this.#requestTimeoutMs));
                }
                catch (retryError) {
                    lastRetryError = retryError;
                    if (!isConnectionFailure(retryError))
                        throw retryError;
                    await sleep(25);
                }
            }
            throw new CoordinationRuntimeError('coordinator-unavailable', lastRetryError instanceof Error ? lastRetryError.message : String(lastRetryError));
        }
    }
    async query(action, repoId = 'global', workstreamRun = null, payload = {}) {
        return await this.request({
            schema_version: 'autopilot.coordinator_request.v1',
            protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
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
            protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
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
        const predecessorStartupFence = await acquirePredecessorStartupFence(this.#paths, deadline).catch(async (error) => { await lock.release(); throw error; });
        let upgrade = null;
        try {
            const probe = this.#probeRequest();
            try {
                const response = this.#assertSuccess(await sendOnce(this.#paths, capability, probe, Math.min(500, this.#requestTimeoutMs)));
                const compatibility = this.#assertCoordinatorCompatibility(response);
                const pendingUpgrade = await resumeCoordinatorUpgrade(this.#paths);
                if (pendingUpgrade !== null) {
                    if (compatibility.kind !== 'exact-target')
                        throw new CoordinationRuntimeError('recovery-required', `upgrade reconnect reached wire-compatible build ${compatibility.package_build}, not the exact target ${pendingUpgrade.intent.target.package_build}`);
                    await pendingUpgrade.markReconnectVerified();
                    await pendingUpgrade.commit();
                }
                return;
            }
            catch (error) {
                if (!isConnectionFailure(error))
                    throw error;
                upgrade = await resumeCoordinatorUpgrade(this.#paths);
                if (upgrade === null) {
                    const currentText = await readExactLockText(this.#paths.lockPath);
                    if (currentText !== null) {
                        let current = null;
                        try {
                            const parsed = JSON.parse(currentText);
                            current = parseKnownCompatibleCurrentCoordinatorLock(parsed) ?? parsePriorSchema9CurrentCoordinatorLock(parsed);
                        }
                        catch { /* fail below */ }
                        if (current === null)
                            throw new CoordinationRuntimeError('protocol-mismatch', 'current-generation lifecycle lock belongs to an unknown build; auto-start will not replace it');
                        if (isProcessAlive(current.pid))
                            throw new CoordinationRuntimeError('coordinator-unavailable', `known coordinator ${current.package_build} is live as pid ${String(current.pid)} but its socket is unavailable; auto-start will not replace or reinterpret its predecessor fence`);
                    }
                    else if (await hasLiveExactPredecessor(this.#paths)) {
                        upgrade = await preparePredecessorCoordinatorUpgrade(this.#paths, capability, deadline);
                    }
                }
            }
            if (upgrade !== null)
                await upgrade.markStarting();
            try {
                spawnCoordinator(this.#paths);
                await this.#waitForExactCoordinator(probe, capability, deadline);
                if (upgrade !== null) {
                    await upgrade.markReconnectVerified();
                    await upgrade.commit();
                }
            }
            catch (error) {
                if (upgrade === null)
                    throw error;
                try {
                    await upgrade.rollback(error);
                }
                catch (rollbackError) {
                    await upgrade.markRecoveryRequired(rollbackError).catch(() => undefined);
                    throw new CoordinationRuntimeError('recovery-required', 'coordinator upgrade failed and exact verified-backup restoration also failed', [error instanceof Error ? error.message : String(error), rollbackError instanceof Error ? rollbackError.message : String(rollbackError)]);
                }
                throw new CoordinationRuntimeError('recovery-required', 'coordinator upgrade failed; the exact schema-6 backup was restored, but this package cannot automatically restart the unavailable aa3e377 binary', [error instanceof Error ? error.message : String(error), `upgrade_id=${upgrade.intent.upgrade_id}`]);
            }
        }
        finally {
            await predecessorStartupFence.release();
            await lock.release();
        }
    }
    async #waitForExactCoordinator(probe, capability, deadline) {
        while (Date.now() < deadline) {
            try {
                const response = this.#assertSuccess(await sendOnce(this.#paths, capability, probe, Math.min(500, this.#requestTimeoutMs)));
                const compatibility = this.#assertCoordinatorCompatibility(response);
                if (compatibility.kind !== 'exact-target')
                    throw new CoordinationRuntimeError('protocol-mismatch', `coordinator startup reached ${compatibility.package_build}, not this package's exact target build`);
                return;
            }
            catch (error) {
                if (!isConnectionFailure(error))
                    throw error;
                await sleep(50);
            }
        }
        throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator did not complete schema migration, start, and exact-target reconnect verification before the deadline');
    }
    #probeRequest() {
        return {
            schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, request_id: `probe-${randomUUID()}`, action: 'handshake', idempotency_key: null, repo_id: 'global', workstream_run: null, session_id: null, fencing_generation: null, expected_version: null, payload: EMPTY_COORDINATOR_PAYLOAD,
        };
    }
    #assertCoordinatorCompatibility(response) {
        if (response.payload['schema_version'] !== 'autopilot.coordinator_handshake.v1')
            throw new CoordinationRuntimeError('schema-mismatch', 'coordinator readiness response omitted the exact handshake schema');
        const compatibility = classifyCoordinatorRuntimeIdentity({
            package_build: response.payload['package_build'],
            protocol_version: response.payload['protocol_version'],
            database_schema_version: response.payload['database_schema_version'],
        });
        if (compatibility.kind !== 'incompatible')
            return compatibility;
        if (compatibility.reason === 'schema-mismatch')
            throw new CoordinationRuntimeError('schema-mismatch', `coordinator database schema is incompatible with ${String(COORDINATOR_DATABASE_SCHEMA_VERSION)}`);
        if (compatibility.reason === 'protocol-mismatch')
            throw new CoordinationRuntimeError('protocol-mismatch', `coordinator handshake protocol is incompatible with ${AUTOPILOT_COORDINATOR_PROTOCOL_VERSION}`);
        if (compatibility.reason === 'unknown-build')
            throw new CoordinationRuntimeError('protocol-mismatch', `coordinator package build ${compatibility.package_build ?? '<missing>'} is outside the closed protocol-1.4/schema-10 compatibility lineage`);
        throw new CoordinationRuntimeError('schema-mismatch', 'coordinator readiness response omitted a valid runtime identity');
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
