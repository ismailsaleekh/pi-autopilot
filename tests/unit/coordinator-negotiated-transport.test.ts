import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  createCoordinatorAdmissionOffer,
  createCoordinatorAdmissionRequest,
  createCoordinatorAdmissionResponse,
  verifyCoordinatorAdmissionResponse,
  type CoordinatorAdmissionEndpointFacts,
  type CoordinatorAdmissionIdentity,
} from '../../src/core/coordination/admission.ts';
import { CoordinatorFrameDecoder, encodeCoordinatorFrame } from '../../src/core/coordination/ipc.ts';
import { runCoordinatorNegotiatedTransport, type CoordinatorNegotiatedTransportHooks } from '../../src/core/coordination/negotiated-transport.ts';
import type { CoordinatorRequestEnvelope, CoordinatorResponseEnvelope } from '../../src/core/coordination/types.ts';

interface JsonObject { readonly [key: string]: unknown }

const IDENTITY: CoordinatorAdmissionIdentity = Object.freeze({
  implementationBuild: '1.2.0-s1', wireLineage: 'protocol-1.6-api-schema-12', apiSchemaVersion: 12, storeSchemaVersion: 13,
  knownClientBuilds: Object.freeze(['1.2.0-s1']),
});
const CAPABILITY = '10'.repeat(32);
const NONCE = '20'.repeat(32);
const EMPTY_PAYLOAD: Readonly<Record<string, unknown>> = Object.freeze({});
const ENDPOINT: CoordinatorAdmissionEndpointFacts = Object.freeze({
  lifecycle_pid: process.pid, lifecycle_boot_id: 'boot', lifecycle_process_start_identity: 'start', lifecycle_instance_id: 'instance',
  legacy_lock_sha256: `sha256:${'31'.repeat(32)}`, runtime_identity_sha256: `sha256:${'32'.repeat(32)}`, store_generation_id: `generation-${'33'.repeat(16)}`,
});

function request(action: 'handshake' | 'status', requestId: string): CoordinatorRequestEnvelope {
  return {
    schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.6', request_id: requestId, action,
    idempotency_key: null, repo_id: 'global', workstream_run: null, session_id: null, fencing_generation: null, expected_version: null, payload: EMPTY_PAYLOAD,
  };
}

function response(requestId: string, payload: unknown): CoordinatorResponseEnvelope {
  return {
    schema_version: 'autopilot.coordinator_response.v1', protocol_version: '1.6', request_id: requestId, ok: true,
    committed_event_seq: null, error_code: null, retryable: false, payload: object(payload),
  };
}

function handshakePayload(withOffer: boolean): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema_version: 'autopilot.coordinator_handshake.v1', package_build: '1.1.8-cf50', protocol_version: '1.6', database_schema_version: 12,
    lifecycle_lock_schema: 'autopilot.coordinator_lock.v2', lifecycle_pid: ENDPOINT.lifecycle_pid, lifecycle_boot_id: ENDPOINT.lifecycle_boot_id,
    lifecycle_process_start_identity: ENDPOINT.lifecycle_process_start_identity, lifecycle_instance_id: ENDPOINT.lifecycle_instance_id,
    lifecycle_started_at: '2026-07-16T00:00:00.000Z',
    ...(withOffer ? { admission_upgrade: createCoordinatorAdmissionOffer(IDENTITY) } : {}),
  });
}

function object(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected object');
  return value as JsonObject;
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => { server.off('listening', onListening); rejectListen(error); };
    const onListening = (): void => { server.off('error', onError); resolveListen(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
}

function hooks(input: { readonly endpointDrift?: boolean; readonly expectedAdmitted?: boolean } = {}): CoordinatorNegotiatedTransportHooks<CoordinatorAdmissionEndpointFacts> {
  return {
    identity: IDENTITY,
    assertSuccess: (envelope) => {
      if (!envelope.ok) throw new Error('server rejected phase');
      return envelope;
    },
    validateLegacyHandshake: async (envelope) => {
      assert.equal(envelope.payload['package_build'], '1.1.8-cf50');
      assert.equal(envelope.payload['database_schema_version'], 12);
    },
    validateKnownCf50Predecessor: async (envelope) => { assert.equal(envelope.payload['admission_upgrade'], undefined); },
    prepareAdmission: async () => ({ endpoint: ENDPOINT, request: createCoordinatorAdmissionRequest({ requestId: 'admission-request', identity: IDENTITY, nonce: NONCE }) }),
    verifyAdmission: async (envelope, endpoint) => verifyCoordinatorAdmissionResponse({
      response: envelope.payload, identity: IDENTITY, capability: CAPABILITY,
      expected: { actualClientBuild: IDENTITY.implementationBuild, requestedVocabulary: COORDINATOR_REQUESTED, nonce: NONCE, admitted: input.expectedAdmitted !== false, ...endpoint },
    }),
    verifyEndpointUnchanged: async () => { if (input.endpointDrift === true) throw new Error('endpoint drift'); },
  };
}

const COORDINATOR_REQUESTED = Object.freeze(['admission-v1', 'canonical-worktree-aliases-v1', 'legacy-protocol-1.6', 'scoped-logical-faults-v1', 'store-generations-v1']);

async function withServer(run: (path: string, server: Server) => Promise<void>, listener: (socket: Socket) => void): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-negotiated-transport-'));
  const socketName = `pi-ap-admission-${String(process.pid)}-${root.slice(-6)}`;
  const path = platform() === 'win32' ? `\\\\.\\pipe\\${socketName}` : join('/tmp', `${socketName}.sock`);
  const server = createServer(listener);
  let listening = false;
  try {
    await listen(server, path);
    listening = true;
    await run(path, server);
  } finally {
    if (listening) await close(server);
    if (platform() !== 'win32') await rm(path, { force: true });
    await rm(root, { recursive: true, force: true });
  }
}

void describe('closed same-socket coordinator transport', () => {
  void it('runs handshake, admission, and operation on exactly one socket', async () => {
    const actions: string[] = [];
    let connections = 0;
    await withServer(async (path) => {
      const result = await runCoordinatorNegotiatedTransport({
        socketPath: path, capability: CAPABILITY, timeoutMs: 2_000,
        handshake: request('handshake', 'handshake-request'), operation: request('status', 'status-request'), hooks: hooks(),
      });
      assert.equal(result.peerMode, 'negotiated-s1');
      assert.equal(result.response.payload['status'], 'ok');
      assert.deepEqual(actions, ['handshake', 'negotiate-admission', 'status']);
      assert.equal(connections, 1);
    }, (socket) => {
      connections += 1;
      const decoder = new CoordinatorFrameDecoder();
      socket.on('data', (chunk: NodeBuffer) => {
        for (const frame of decoder.push(chunk)) {
          const transport = object(frame);
          assert.equal(transport['capability'], CAPABILITY);
          const received = object(transport['request']);
          const action = received['action'];
          if (typeof action !== 'string') throw new Error('action is missing');
          actions.push(action);
          const requestId = received['request_id'];
          if (typeof requestId !== 'string') throw new Error('request id is missing');
          if (action === 'handshake') {
            assert.deepEqual(received['payload'], {});
            socket.write(encodeCoordinatorFrame(response(requestId, handshakePayload(true))));
          } else if (action === 'negotiate-admission') {
            const admissionRequest = object(received['payload']);
            const admission = createCoordinatorAdmissionResponse({
              request: {
                schema_version: 'autopilot.coordinator_admission_request.v1',
                client_build: String(admissionRequest['client_build']), wire_lineage: String(admissionRequest['wire_lineage']),
                api_schema_version: Number(admissionRequest['api_schema_version']),
                requested_vocabulary: Array.isArray(admissionRequest['requested_vocabulary']) ? admissionRequest['requested_vocabulary'].map(String) : [],
                nonce: String(admissionRequest['nonce']),
              },
              identity: IDENTITY, endpoint: ENDPOINT, capability: CAPABILITY,
            });
            socket.write(encodeCoordinatorFrame(response(requestId, admission)));
          } else socket.write(encodeCoordinatorFrame(response(requestId, { status: 'ok' })));
        }
      });
    });
  });

  void it('uses actual cf50 on the same socket without sending negotiate-admission', async () => {
    const actions: string[] = [];
    await withServer(async (path) => {
      const result = await runCoordinatorNegotiatedTransport({
        socketPath: path, capability: CAPABILITY, timeoutMs: 2_000,
        handshake: request('handshake', 'legacy-handshake'), operation: request('status', 'legacy-status'), hooks: hooks(),
      });
      assert.equal(result.peerMode, 'known-cf50-predecessor');
      assert.deepEqual(actions, ['handshake', 'status']);
    }, (socket) => {
      const decoder = new CoordinatorFrameDecoder();
      socket.on('data', (chunk: NodeBuffer) => {
        for (const frame of decoder.push(chunk)) {
          const received = object(object(frame)['request']);
          const action = String(received['action']);
          const requestId = String(received['request_id']);
          actions.push(action);
          socket.write(encodeCoordinatorFrame(response(requestId, action === 'handshake' ? handshakePayload(false) : { status: 'legacy-ok' })));
        }
      });
    });
  });

  void it('returns an explicit legacy handshake without caching or negotiating admission', async () => {
    const actions: string[] = [];
    await withServer(async (path) => {
      const result = await runCoordinatorNegotiatedTransport({
        socketPath: path, capability: CAPABILITY, timeoutMs: 2_000,
        handshake: request('handshake', 'explicit-handshake'), operation: null, hooks: hooks(),
      });
      assert.equal(result.peerMode, null);
      assert.equal(result.response.payload['admission_upgrade'] !== undefined, true);
      assert.deepEqual(actions, ['handshake']);
    }, (socket) => {
      const decoder = new CoordinatorFrameDecoder();
      socket.on('data', (chunk: NodeBuffer) => {
        for (const frame of decoder.push(chunk)) {
          const received = object(object(frame)['request']);
          actions.push(String(received['action']));
          socket.write(encodeCoordinatorFrame(response(String(received['request_id']), handshakePayload(true))));
        }
      });
    });
  });

  void it('does not continue after signed rejection or endpoint drift', async () => {
    for (const mode of ['rejection', 'drift'] as const) {
      const actions: string[] = [];
      await withServer(async (path) => {
        await assert.rejects(() => runCoordinatorNegotiatedTransport({
          socketPath: path, capability: CAPABILITY, timeoutMs: 2_000,
          handshake: request('handshake', `handshake-${mode}`), operation: request('status', `status-${mode}`), hooks: hooks({ endpointDrift: mode === 'drift', expectedAdmitted: mode !== 'rejection' }),
        }));
        assert.deepEqual(actions, ['handshake', 'negotiate-admission']);
      }, (socket) => {
        const decoder = new CoordinatorFrameDecoder();
        socket.on('data', (chunk: NodeBuffer) => {
          for (const frame of decoder.push(chunk)) {
            const received = object(object(frame)['request']);
            const action = String(received['action']);
            const requestId = String(received['request_id']);
            actions.push(action);
            if (action === 'handshake') socket.write(encodeCoordinatorFrame(response(requestId, handshakePayload(true))));
            else {
              const admissionEnvelope = createCoordinatorAdmissionRequest({ requestId: 'server-policy', identity: IDENTITY, nonce: NONCE });
              const serverIdentity = { ...IDENTITY, knownClientBuilds: Object.freeze(mode === 'rejection' ? ['other-s1-build'] : ['1.2.0-s1']) };
              const admission = createCoordinatorAdmissionResponse({ request: admissionEnvelope.payload, identity: serverIdentity, endpoint: ENDPOINT, capability: CAPABILITY });
              socket.write(encodeCoordinatorFrame(response(requestId, admission)));
            }
          }
        });
      });
    }
  });

  void it('rejects wrong request IDs, duplicate frames, and close between phases', async () => {
    for (const behavior of ['wrong-id', 'duplicate', 'close'] as const) {
      await withServer(async (path) => {
        await assert.rejects(() => runCoordinatorNegotiatedTransport({
          socketPath: path, capability: CAPABILITY, timeoutMs: 500,
          handshake: request('handshake', `handshake-${behavior}`), operation: request('status', `status-${behavior}`), hooks: hooks(),
        }));
      }, (socket) => {
        const decoder = new CoordinatorFrameDecoder();
        let servedCloseHandshake = false;
        socket.on('data', (chunk: NodeBuffer) => {
          for (const frame of decoder.push(chunk)) {
            const received = object(object(frame)['request']);
            const requestId = String(received['request_id']);
            if (behavior === 'wrong-id') socket.write(encodeCoordinatorFrame(response('wrong-request-id', handshakePayload(false))));
            else if (behavior === 'duplicate') {
              const encoded = encodeCoordinatorFrame(response(requestId, handshakePayload(false)));
              socket.write(Buffer.concat([encoded, encoded]));
            } else if (!servedCloseHandshake) {
              servedCloseHandshake = true;
              socket.write(encodeCoordinatorFrame(response(requestId, handshakePayload(false))), () => socket.end());
            }
          }
        });
      });
    }
  });
});
