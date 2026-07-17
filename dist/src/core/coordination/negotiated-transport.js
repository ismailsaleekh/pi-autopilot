import { connect } from 'node:net';
import { parseCoordinatorAdmissionOffer } from "./admission.js";
import { parseCoordinatorResponseEnvelope } from "./contracts.js";
import { CoordinationRuntimeError } from "./failures.js";
import { AUTOPILOT_COORDINATOR_TRANSPORT_VERSION, CoordinatorFrameDecoder, encodeCoordinatorFrame } from "./ipc.js";
class CoordinatorSocketChannel {
    #socket;
    #capability;
    #timeoutMs;
    #decoder = new CoordinatorFrameDecoder();
    #pending = null;
    #failure = null;
    #closed = false;
    constructor(socket, capability, timeoutMs) {
        this.#socket = socket;
        this.#capability = capability;
        this.#timeoutMs = timeoutMs;
        socket.on('data', (chunk) => this.#onData(chunk));
        socket.once('error', (error) => this.#fail(error));
        socket.once('close', () => {
            try {
                this.#decoder.assertComplete();
            }
            catch (error) {
                this.#fail(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            if (!this.#closed)
                this.#fail(Object.assign(new Error('coordinator connection closed between protocol phases'), { code: 'ECONNRESET' }));
        });
    }
    static async connect(path, capability, timeoutMs) {
        const socket = await new Promise((resolveConnect, rejectConnect) => {
            const candidate = connect(path);
            const timer = setTimeout(() => {
                candidate.destroy();
                rejectConnect(Object.assign(new Error(`coordinator connection timed out after ${String(timeoutMs)} ms`), { code: 'ETIMEDOUT' }));
            }, timeoutMs);
            const onError = (error) => { clearTimeout(timer); rejectConnect(error); };
            candidate.once('error', onError);
            candidate.once('connect', () => {
                clearTimeout(timer);
                candidate.off('error', onError);
                resolveConnect(candidate);
            });
        });
        return new CoordinatorSocketChannel(socket, capability, timeoutMs);
    }
    async exchange(request) {
        if (this.#closed)
            throw new CoordinationRuntimeError('invalid-state', 'coordinator socket is already closed');
        if (this.#failure !== null)
            throw this.#failure;
        if (this.#pending !== null)
            throw new CoordinationRuntimeError('invalid-state', 'coordinator socket already has an in-flight protocol phase');
        return await new Promise((resolveResponse, rejectResponse) => {
            const timer = setTimeout(() => {
                const error = Object.assign(new Error(`coordinator request phase timed out after ${String(this.#timeoutMs)} ms`), { code: 'ETIMEDOUT' });
                this.#fail(error);
            }, this.#timeoutMs);
            this.#pending = { requestId: request.request_id, resolve: resolveResponse, reject: rejectResponse, timer };
            const transport = { transport_version: AUTOPILOT_COORDINATOR_TRANSPORT_VERSION, capability: this.#capability, request };
            this.#socket.write(encodeCoordinatorFrame(transport), (error) => {
                if (error !== null && error !== undefined)
                    this.#fail(error);
            });
        });
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        const pending = this.#pending;
        this.#pending = null;
        if (pending !== null) {
            clearTimeout(pending.timer);
            pending.reject(new CoordinationRuntimeError('invalid-state', 'coordinator socket closed with an in-flight phase'));
        }
        this.#socket.end();
    }
    destroy() {
        this.#closed = true;
        this.#socket.destroy();
    }
    #onData(chunk) {
        if (this.#failure !== null || this.#closed)
            return;
        let frames;
        try {
            frames = this.#decoder.push(chunk);
        }
        catch (error) {
            this.#fail(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        if (frames.length === 0)
            return;
        if (frames.length !== 1) {
            this.#fail(new CoordinationRuntimeError('invalid-state', 'coordinator sent multiple or unsolicited response frames for one phase'));
            return;
        }
        const pending = this.#pending;
        if (pending === null) {
            this.#fail(new CoordinationRuntimeError('invalid-state', 'coordinator sent a response before its requested phase'));
            return;
        }
        let response;
        try {
            response = parseCoordinatorResponseEnvelope(frames[0]);
        }
        catch (error) {
            this.#fail(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        if (response.request_id !== pending.requestId) {
            this.#fail(new CoordinationRuntimeError('invalid-state', 'coordinator response request id does not match its protocol phase'));
            return;
        }
        this.#pending = null;
        clearTimeout(pending.timer);
        pending.resolve(response);
    }
    #fail(error) {
        if (this.#failure !== null)
            return;
        this.#failure = error;
        const pending = this.#pending;
        this.#pending = null;
        if (pending !== null) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.#socket.destroy();
    }
}
/** Existing cf50 two-phase consumer of the same strict per-socket channel. */
export async function runCoordinatorLegacySameSocketTransport(input) {
    if (input.handshake.action !== 'handshake' || Object.keys(input.handshake.payload).length !== 0 || input.operation.action === 'handshake')
        throw new CoordinationRuntimeError('invalid-request', 'legacy same-socket transport requires one exact handshake followed by one operation');
    const channel = await CoordinatorSocketChannel.connect(input.socketPath, input.capability, input.timeoutMs);
    try {
        const handshake = await channel.exchange(input.handshake);
        await input.validateHandshake(handshake);
        const response = await channel.exchange(input.operation);
        channel.close();
        return response;
    }
    catch (error) {
        channel.destroy();
        throw error;
    }
}
/**
 * Executes one closed connection journey. Admission is deliberately local to
 * this stack frame and socket; no result is returned as reusable authority.
 */
export async function runCoordinatorNegotiatedTransport(input) {
    if (input.handshake.action !== 'handshake' || Object.keys(input.handshake.payload).length !== 0)
        throw new CoordinationRuntimeError('invalid-request', 'negotiated transport requires the exact empty legacy handshake first');
    if (input.operation?.action === 'handshake')
        throw new CoordinationRuntimeError('invalid-request', 'explicit handshake queries must not contain a second operation');
    const channel = await CoordinatorSocketChannel.connect(input.socketPath, input.capability, input.timeoutMs);
    try {
        const handshake = input.hooks.assertSuccess(await channel.exchange(input.handshake));
        await input.hooks.validateLegacyHandshake(handshake);
        if (input.operation === null) {
            channel.close();
            return Object.freeze({ peerMode: null, handshake, admission: null, response: handshake });
        }
        const offered = handshake.payload['admission_upgrade'];
        if (offered === undefined) {
            await input.hooks.validateKnownCf50Predecessor(handshake);
            const response = input.hooks.assertSuccess(await channel.exchange(input.operation));
            channel.close();
            return Object.freeze({ peerMode: 'known-cf50-predecessor', handshake, admission: null, response });
        }
        const offer = parseCoordinatorAdmissionOffer(offered, input.hooks.identity.wireLineage);
        const prepared = await input.hooks.prepareAdmission(handshake, offer);
        const admissionEnvelope = input.hooks.assertSuccess(await channel.exchange(prepared.request));
        const admission = await input.hooks.verifyAdmission(admissionEnvelope, prepared.endpoint);
        if (!admission.admitted)
            throw new CoordinationRuntimeError('unauthorized-client', 'coordinator returned a signed admission rejection');
        await input.hooks.verifyEndpointUnchanged(prepared.endpoint);
        const response = input.hooks.assertSuccess(await channel.exchange(input.operation));
        channel.close();
        return Object.freeze({ peerMode: 'negotiated-s1', handshake, admission, response });
    }
    catch (error) {
        channel.destroy();
        throw error;
    }
}
