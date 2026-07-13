import { parseCoordinatorRequestEnvelope, parseCoordinatorResponseEnvelope } from "./contracts.js";
import { CoordinationRuntimeError } from "./failures.js";
import { COORDINATOR_MAX_FRAME_BYTES } from "./runtime-paths.js";
export const AUTOPILOT_COORDINATOR_TRANSPORT_VERSION = 'autopilot.coordinator_transport.v1';
function isJsonMap(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseTransportShell(value) {
    if (!isJsonMap(value))
        throw new CoordinationRuntimeError('invalid-request', 'coordinator transport frame must be an object');
    const fields = Object.keys(value).sort();
    const expected = ['capability', 'request', 'transport_version'];
    if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index]))
        throw new CoordinationRuntimeError('invalid-request', 'coordinator transport frame fields are invalid', fields);
    if (value['transport_version'] !== AUTOPILOT_COORDINATOR_TRANSPORT_VERSION)
        throw new CoordinationRuntimeError('protocol-mismatch', 'coordinator transport version is incompatible');
    const capability = value['capability'];
    if (typeof capability !== 'string' || !/^[a-f0-9]{64}$/u.test(capability))
        throw new CoordinationRuntimeError('unauthorized-client', 'coordinator capability proof is malformed');
    return { capability, request: value['request'] };
}
export function parseCoordinatorLegacyReplayTransportRequest(value) {
    const shell = parseTransportShell(value);
    if (!isJsonMap(shell.request))
        throw new CoordinationRuntimeError('invalid-request', 'legacy replay request must be an object');
    const request = shell.request;
    const fields = Object.keys(request).sort();
    const expected = ['action', 'expected_version', 'fencing_generation', 'idempotency_key', 'payload', 'protocol_version', 'repo_id', 'request_id', 'schema_version', 'session_id', 'workstream_run'];
    if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index]))
        throw new CoordinationRuntimeError('invalid-request', 'legacy replay request fields are invalid', fields);
    const replayProtocol = request['protocol_version'];
    if (request['schema_version'] !== 'autopilot.coordinator_request.v1' || (replayProtocol !== '1.1' && replayProtocol !== '1.2'))
        throw new CoordinationRuntimeError('protocol-mismatch', 'only exact proven-compatible protocol 1.1 or 1.2 requests may use idempotency replay');
    if (typeof request['request_id'] !== 'string' || typeof request['repo_id'] !== 'string' || typeof request['idempotency_key'] !== 'string' || typeof request['action'] !== 'string' || !isJsonMap(request['payload']))
        throw new CoordinationRuntimeError('invalid-request', 'legacy replay identity or payload is malformed');
    return { transport_version: AUTOPILOT_COORDINATOR_TRANSPORT_VERSION, capability: shell.capability, replay_protocol: replayProtocol, request };
}
export function parseCoordinatorTransportRequest(value) {
    const shell = parseTransportShell(value);
    return { transport_version: AUTOPILOT_COORDINATOR_TRANSPORT_VERSION, capability: shell.capability, request: parseCoordinatorRequestEnvelope(shell.request) };
}
export function encodeCoordinatorFrame(value) {
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    if (payload.byteLength > COORDINATOR_MAX_FRAME_BYTES) {
        throw new CoordinationRuntimeError('frame-too-large', `coordinator frame exceeds ${String(COORDINATOR_MAX_FRAME_BYTES)} bytes`);
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.byteLength, 0);
    return Buffer.concat([header, payload]);
}
export class CoordinatorFrameDecoder {
    #buffer = Buffer.alloc(0);
    push(chunk) {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        const frames = [];
        while (this.#buffer.byteLength >= 4) {
            const length = this.#buffer.readUInt32BE(0);
            if (length < 2 || length > COORDINATOR_MAX_FRAME_BYTES) {
                throw new CoordinationRuntimeError('frame-too-large', `invalid coordinator frame length ${String(length)}`);
            }
            if (this.#buffer.byteLength < 4 + length)
                break;
            const bytes = this.#buffer.subarray(4, 4 + length);
            this.#buffer = this.#buffer.subarray(4 + length);
            let parsed;
            try {
                parsed = JSON.parse(bytes.toString('utf8'));
            }
            catch (error) {
                throw new CoordinationRuntimeError('invalid-request', 'coordinator frame contains invalid JSON', [error instanceof Error ? error.message : String(error)]);
            }
            frames.push(parsed);
        }
        return Object.freeze(frames);
    }
    assertComplete() {
        if (this.#buffer.byteLength !== 0)
            throw new CoordinationRuntimeError('invalid-request', 'coordinator connection ended with a partial frame');
    }
}
export function writeCoordinatorResponse(socket, response) {
    const parsed = parseCoordinatorResponseEnvelope(response);
    return new Promise((resolveWrite, rejectWrite) => {
        socket.write(encodeCoordinatorFrame(parsed), (error) => {
            if (error === undefined || error === null)
                resolveWrite();
            else
                rejectWrite(error);
        });
    });
}
