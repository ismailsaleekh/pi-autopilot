import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  COORDINATOR_ADMISSION_VOCABULARY,
  createCoordinatorAdmissionRequest,
  parseCoordinatorAdmissionResponse,
  verifyCoordinatorAdmissionResponse,
} from '../../src/core/coordination/admission.ts';
import { captureCoordinatorAdmissionAuthority, COORDINATOR_S1_ADMISSION_IDENTITY } from '../../src/core/coordination/admission-runtime.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinatorResponseEnvelope } from '../../src/core/coordination/contracts.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { AUTOPILOT_COORDINATOR_TRANSPORT_VERSION, CoordinatorFrameDecoder, encodeCoordinatorFrame } from '../../src/core/coordination/ipc.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import type { CoordinatorStartupObserver } from '../../src/core/coordination/startup-observation.ts';
import type { CoordinatorRequestEnvelope, CoordinatorResponseEnvelope } from '../../src/core/coordination/types.ts';
import { parseCurrentCoordinatorLock } from '../../src/core/coordination/upgrade-contracts.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

const EMPTY_PAYLOAD: Readonly<Record<string, unknown>> = Object.freeze({});

function request(action: 'handshake' | 'status', requestId: string): CoordinatorRequestEnvelope {
  return {
    schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.6', request_id: requestId, action,
    idempotency_key: null, repo_id: 'global', workstream_run: null, session_id: null, fencing_generation: null, expected_version: null, payload: EMPTY_PAYLOAD,
  };
}

class RawCoordinatorSocket {
  readonly #socket: Socket;
  readonly #decoder = new CoordinatorFrameDecoder();
  #pending: { readonly expectedRequestId: string | null; readonly resolve: (response: CoordinatorResponseEnvelope) => void; readonly reject: (error: Error) => void } | null = null;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on('data', (chunk: NodeBuffer) => {
      try {
        const frames = this.#decoder.push(chunk);
        if (frames.length !== 1 || this.#pending === null) throw new Error('raw test socket received an unsolicited or duplicate frame');
        const response = parseCoordinatorResponseEnvelope(frames[0]);
        if (this.#pending.expectedRequestId !== null && response.request_id !== this.#pending.expectedRequestId) throw new Error('raw test socket response id mismatch');
        const pending = this.#pending;
        this.#pending = null;
        pending.resolve(response);
      } catch (error) {
        const pending = this.#pending;
        this.#pending = null;
        if (pending !== null) pending.reject(error instanceof Error ? error : new Error(String(error)));
        this.#socket.destroy();
      }
    });
  }

  static async open(path: string): Promise<RawCoordinatorSocket> {
    const socket = await new Promise<Socket>((resolveConnect, rejectConnect) => {
      const candidate = connect(path);
      candidate.once('connect', () => resolveConnect(candidate));
      candidate.once('error', rejectConnect);
    });
    return new RawCoordinatorSocket(socket);
  }

  async exchange(requestValue: Readonly<Record<string, unknown>>, capability: string, exactRequestId = true): Promise<CoordinatorResponseEnvelope> {
    if (this.#pending !== null) throw new Error('raw test socket has an in-flight request');
    const requestId = requestValue['request_id'];
    if (typeof requestId !== 'string') throw new Error('raw test request id is missing');
    return await new Promise<CoordinatorResponseEnvelope>((resolveResponse, rejectResponse) => {
      this.#pending = { expectedRequestId: exactRequestId ? requestId : null, resolve: resolveResponse, reject: rejectResponse };
      this.#socket.write(encodeCoordinatorFrame({ transport_version: AUTOPILOT_COORDINATOR_TRANSPORT_VERSION, capability, request: requestValue }));
    });
  }

  close(): void { this.#socket.end(); }
}

function asRecord(value: object): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...value });
}

void describe('integrated S1 admission server security', () => {
  void it('contains an abrupt peer disconnect during response publication without terminating coordinator service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s1-peer-reset-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    let resolveHandshakeReached = (): void => {};
    let releaseHandshake = (): void => {};
    const handshakeReached = new Promise<void>((resolve) => { resolveHandshakeReached = resolve; });
    const handshakeRelease = new Promise<void>((resolve) => { releaseHandshake = resolve; });
    const startupObserver: CoordinatorStartupObserver = {
      attemptId: 'startup-11111111111111111111111111111111',
      reportPath: join(root, 'unused-startup-report.json'),
      transition: async (phase) => {
        if (phase === 'first-exact-handshake-served') {
          resolveHandshakeReached();
          await handshakeRelease;
        }
      },
      electionLoser: async () => {},
      failed: async () => {},
    };
    let running: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      running = await startCoordinatorServer(paths, undefined, undefined, undefined, startupObserver);
      const capability = (await readFile(paths.capabilityPath, 'utf8')).trim();
      const resetPeer = await new Promise<Socket>((resolveConnect, rejectConnect) => {
        const socket = connect(paths.socketPath);
        socket.once('connect', () => resolveConnect(socket));
        socket.once('error', rejectConnect);
      });
      resetPeer.on('error', () => {});
      resetPeer.write(encodeCoordinatorFrame({ transport_version: AUTOPILOT_COORDINATOR_TRANSPORT_VERSION, capability, request: request('handshake', 'reset-before-response') }));
      await handshakeReached;
      resetPeer.destroy();
      releaseHandshake();
      const client = new CoordinatorClient({ env, autoStart: false });
      const status = await client.query('status');
      assert.equal(status.ok, true);
    } finally {
      releaseHandshake();
      if (running !== null) await running.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('rejects lock, sidecar, pointer, and generation tamper before a negotiated operation reaches the store', async () => {
    for (const target of ['legacy-lock', 'runtime-sidecar', 'current-pointer', 'generation-publication'] as const) {
      const root = await mkdtemp(join(tmpdir(), `pi-autopilot-s1-${target}-tamper-`));
      const stateRoot = join(root, 'state');
      const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
      const paths = coordinatorRuntimePaths(env);
      let authorityPath: string | null = null;
      let originalBytes: Uint8Array | null = null;
      let negotiatedStoreOperations = 0;
      let running: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
      try {
        running = await startCoordinatorServer(paths, undefined, undefined, {
          afterAdmissionAttestedBeforeResponse: async () => {
            const path = authorityPath;
            if (path === null) throw new Error('tamper target path was not selected before admission');
            const original = await readFile(path);
            originalBytes = original;
            await writeFile(path, Buffer.concat([Buffer.from('\n', 'utf8'), original]));
          },
          beforeNegotiatedStoreOperation: () => { negotiatedStoreOperations += 1; },
        });
        authorityPath = target === 'legacy-lock'
          ? paths.lockPath
          : target === 'runtime-sidecar'
            ? paths.runtimeIdentityPath
            : target === 'current-pointer'
              ? paths.currentStorePointerPath
              : running.store.currentGeneration().publication_path;
        const client = new CoordinatorClient({ env, autoStart: false });
        await assert.rejects(() => client.query('status'), (error: unknown) => {
          if (!(error instanceof CoordinationRuntimeError)) return false;
          assert.ok(error.code === 'coordinator-unavailable' || error.code === 'store-corrupt');
          assert.match(error.message, /changed|digest|identity|pointer|publication|generation/u);
          return true;
        });
        assert.equal(negotiatedStoreOperations, 0, `${target} drift reached the store after admission`);
      } finally {
        if (authorityPath !== null && originalBytes !== null) await writeFile(authorityPath, originalBytes);
        if (running !== null) await running.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  void it('rejects live generation inode replacement before a negotiated operation reaches the store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s1-generation-inode-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    let running: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    let originalPath: string | null = null;
    let replacementPath: string | null = null;
    let negotiatedStoreOperations = 0;
    try {
      running = await startCoordinatorServer(paths, undefined, undefined, {
        afterAdmissionAttestedBeforeResponse: async () => {
          if (running === null) throw new Error('generation inode fixture lost its server');
          replacementPath = running.store.currentGeneration().database_path;
          originalPath = `${replacementPath}.serving-inode`;
          await rename(replacementPath, originalPath);
          await copyFile(originalPath, replacementPath);
        },
        beforeNegotiatedStoreOperation: () => { negotiatedStoreOperations += 1; },
      });
      const client = new CoordinatorClient({ env, autoStart: false });
      await assert.rejects(() => client.query('status'), (error: unknown) => error instanceof CoordinationRuntimeError && (error.code === 'store-corrupt' || error.code === 'coordinator-unavailable'));
      assert.equal(negotiatedStoreOperations, 0);
    } finally {
      if (originalPath !== null && replacementPath !== null) {
        await unlink(replacementPath).catch((error: unknown) => {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        });
        await rename(originalPath, replacementPath);
      }
      if (running !== null) await running.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('distinguishes malformed input from signed policy rejection and keeps authority socket-scoped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s1-admission-server-'));
    const stateRoot = join(root, 'state');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const paths = coordinatorRuntimePaths(env);
    let running: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      running = await startCoordinatorServer(paths);
      const capability = (await readFile(paths.capabilityPath, 'utf8')).trim();

      for (const invalidCapability of ['ff'.repeat(32), 'AA'.repeat(32)]) {
        const channel = await RawCoordinatorSocket.open(paths.socketPath);
        const denied = await channel.exchange(asRecord(request('handshake', `wrong-capability-${invalidCapability.slice(0, 2)}`)), invalidCapability, invalidCapability.startsWith('f'));
        assert.equal(denied.ok, false);
        assert.equal(denied.payload['attestation'], undefined);
        assert.equal(JSON.stringify(denied).includes(invalidCapability), false);
        channel.close();
      }

      const historicalProtocol = await RawCoordinatorSocket.open(paths.socketPath);
      const historicalReplay = await historicalProtocol.exchange(asRecord({ ...request('status', 'historical-protocol-status'), protocol_version: '1.5' }), capability, false);
      assert.equal(historicalReplay.ok, false);
      assert.equal(historicalReplay.payload['attestation'], undefined);
      const historicalContinuation = await historicalProtocol.exchange(asRecord(request('handshake', 'historical-protocol-continuation')), capability);
      assert.equal(historicalContinuation.ok, false);
      historicalProtocol.close();

      const beforeHandshake = await RawCoordinatorSocket.open(paths.socketPath);
      const premature = await beforeHandshake.exchange(asRecord(request('status', 'operation-before-handshake')), capability);
      assert.equal(premature.ok, false);
      assert.equal(premature.payload['attestation'], undefined);
      beforeHandshake.close();

      const driftedAuthority = await RawCoordinatorSocket.open(paths.socketPath);
      assert.equal((await driftedAuthority.exchange(asRecord(request('handshake', 'authority-drift-handshake')), capability)).ok, true);
      const exactLockBytes = await readFile(paths.lockPath);
      const exactLock = parseCurrentCoordinatorLock(JSON.parse(Buffer.from(exactLockBytes).toString('utf8')) as unknown);
      if (exactLock === null) throw new Error('authority drift test lifecycle lock is invalid');
      try {
        await writeFile(paths.lockPath, `${JSON.stringify({ ...exactLock, token: 'tampered-lifecycle-token' })}\n`);
        const driftRequest = createCoordinatorAdmissionRequest({ requestId: 'authority-drift-admission', identity: COORDINATOR_S1_ADMISSION_IDENTITY, nonce: '10'.repeat(32) });
        const driftResponse = await driftedAuthority.exchange(asRecord(driftRequest), capability);
        assert.equal(driftResponse.ok, false);
        assert.equal(driftResponse.payload['attestation'], undefined);
      } finally {
        await writeFile(paths.lockPath, exactLockBytes);
        driftedAuthority.close();
      }

      const malformed = await RawCoordinatorSocket.open(paths.socketPath);
      const malformedHandshake = await malformed.exchange(asRecord(request('handshake', 'malformed-handshake')), capability);
      assert.equal(malformedHandshake.ok, true);
      const malformedAdmission = createCoordinatorAdmissionRequest({ requestId: 'malformed-admission', identity: COORDINATOR_S1_ADMISSION_IDENTITY, nonce: '11'.repeat(32) });
      const malformedResponse = await malformed.exchange(asRecord({ ...malformedAdmission, payload: { ...malformedAdmission.payload, requested_vocabulary: ['legacy-protocol-1.6', 'admission-v1'] } }), capability, false);
      assert.equal(malformedResponse.ok, false);
      assert.equal(malformedResponse.payload['attestation'], undefined);
      const malformedContinuation = await malformed.exchange(asRecord(request('status', 'malformed-continuation')), capability);
      assert.equal(malformedContinuation.ok, false);
      malformed.close();

      for (const policy of ['unknown-build', 'unknown-vocabulary'] as const) {
        const channel = await RawCoordinatorSocket.open(paths.socketPath);
        assert.equal((await channel.exchange(asRecord(request('handshake', `handshake-${policy}`)), capability)).ok, true);
        const base = createCoordinatorAdmissionRequest({ requestId: `admission-${policy}`, identity: COORDINATOR_S1_ADMISSION_IDENTITY, nonce: policy === 'unknown-build' ? '22'.repeat(32) : '33'.repeat(32) });
        const payload = policy === 'unknown-build'
          ? { ...base.payload, client_build: '1.2.1-unknown' }
          : { ...base.payload, requested_vocabulary: ['admission-v1', 'future-vocabulary-v1'] };
        const signedEnvelope = await channel.exchange(asRecord({ ...base, payload }), capability);
        assert.equal(signedEnvelope.ok, true);
        const signed = parseCoordinatorAdmissionResponse(signedEnvelope.payload, COORDINATOR_S1_ADMISSION_IDENTITY);
        assert.equal(signed.admitted, false);
        assert.equal(signed.result, 'rejected');
        assert.deepEqual(signed.granted_vocabulary, []);
        const lifecycle = parseCurrentCoordinatorLock(JSON.parse(await readFile(paths.lockPath, 'utf8')) as unknown);
        if (lifecycle === null) throw new Error('integrated admission test lifecycle lock is invalid');
        const authority = await captureCoordinatorAdmissionAuthority({ paths, expectedLifecycle: lifecycle });
        assert.doesNotThrow(() => verifyCoordinatorAdmissionResponse({
          response: signed,
          identity: COORDINATOR_S1_ADMISSION_IDENTITY,
          capability,
          expected: {
            actualClientBuild: policy === 'unknown-build' ? '1.2.1-unknown' : COORDINATOR_S1_ADMISSION_IDENTITY.implementationBuild,
            requestedVocabulary: payload.requested_vocabulary,
            nonce: base.payload.nonce,
            admitted: false,
            ...authority.endpoint,
          },
        }));
        const afterRejection = await channel.exchange(asRecord(request('status', `after-${policy}`)), capability);
        assert.equal(afterRejection.ok, false);
        channel.close();
      }

      const legacy = await RawCoordinatorSocket.open(paths.socketPath);
      assert.equal((await legacy.exchange(asRecord(request('handshake', 'legacy-handshake')), capability)).ok, true);
      const legacyStatus = await legacy.exchange(asRecord(request('status', 'legacy-status')), capability);
      const legacyProjection = legacyStatus.payload['projection'];
      assert.equal(typeof legacyProjection, 'object');
      assert.equal(JSON.stringify(legacyProjection).includes('negotiated_coordinator_identity'), false);
      assert.equal(JSON.stringify(legacyProjection).includes('run_scoped_logical_faults'), false);
      const owner = { repo_id: 'legacy-repo', autopilot_id: 'legacy-autopilot', workstream_run: 'legacy-run', unit_id: 'legacy-unit', attempt: 1 };
      const worktreeId = `worktree-${'55'.repeat(16)}`;
      const metadataOnly = await legacy.exchange(asRecord({
        schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.6', request_id: 'legacy-metadata-reconcile', action: 'prepare-operation',
        idempotency_key: 'legacy-metadata-reconcile-key', repo_id: owner.repo_id, workstream_run: owner.workstream_run,
        session_id: 'legacy-session', fencing_generation: 1, expected_version: 0,
        payload: {
          session_lease_id: 'legacy-session-lease', session_token: '66'.repeat(32),
          worktree: { schema_version: 'autopilot.coordination_worktree.v2', worktree_id: worktreeId, owner, kind: 'unit', canonical_path: join(root, 'legacy-worktree'), git_common_dir: join(root, 'legacy-repo', '.git'), branch: 'autopilot/unit/legacy-run/legacy-unit/attempt-1', state: 'planned', version: 1 },
          operation: {
            schema_version: 'autopilot.worktree_operation.v2', operation_id: 'legacy-metadata-operation', worktree_id: worktreeId, owner,
            operation_type: 'metadata-reconcile', stage: 'prepared', authority_version: 1, intent_event_seq: 0,
            intent: { repo_root: join(root, 'legacy-repo'), worktree_path: join(root, 'legacy-worktree'), git_common_dir: join(root, 'legacy-repo', '.git'), branch: 'autopilot/unit/legacy-run/legacy-unit/attempt-1', reason: 'legacy peer must not access S1 metadata vocabulary', base_sha: '7'.repeat(40), target_sha: null, archive_ref: null, checkout_mode: 'full', sparse_patterns: [], paths: [], metadata_refs: [] },
            completed_steps: [], current_step: null, recovery_attempts: 0, verification_evidence: null, error_code: null, version: 1,
          },
        },
      }), capability);
      assert.equal(metadataOnly.ok, false);
      assert.equal(metadataOnly.error_code, 'unauthorized-client');
      legacy.close();

      const duplicate = await RawCoordinatorSocket.open(paths.socketPath);
      assert.equal((await duplicate.exchange(asRecord(request('handshake', 'duplicate-handshake')), capability)).ok, true);
      const admission = createCoordinatorAdmissionRequest({ requestId: 'duplicate-admission', identity: COORDINATOR_S1_ADMISSION_IDENTITY, nonce: '44'.repeat(32), requestedVocabulary: COORDINATOR_ADMISSION_VOCABULARY });
      const admitted = await duplicate.exchange(asRecord(admission), capability);
      assert.equal(parseCoordinatorAdmissionResponse(admitted.payload, COORDINATOR_S1_ADMISSION_IDENTITY).admitted, true);
      const duplicated = await duplicate.exchange(asRecord({ ...admission, request_id: 'duplicate-admission-again' }), capability);
      assert.equal(duplicated.ok, false);
      assert.equal(duplicated.payload['attestation'], undefined);
      duplicate.close();
    } finally {
      if (running !== null) await running.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
