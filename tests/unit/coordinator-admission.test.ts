import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  COORDINATOR_ADMISSION_DOMAIN,
  COORDINATOR_ADMISSION_VOCABULARY,
  createCoordinatorAdmissionOffer,
  createCoordinatorAdmissionRequest,
  createCoordinatorAdmissionResponse,
  parseCoordinatorAdmissionOffer,
  parseCoordinatorAdmissionRequest,
  parseCoordinatorAdmissionRequestEnvelope,
  parseCoordinatorAdmissionResponse,
  sha256CoordinatorAuthorityBytes,
  verifyCoordinatorAdmissionResponse,
  type CoordinatorAdmissionEndpointFacts,
  type CoordinatorAdmissionIdentity,
  type CoordinatorAdmissionResponse,
  type CoordinatorAdmissionVerificationExpectation,
} from '../../src/core/coordination/admission.ts';
import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';

const IDENTITY: CoordinatorAdmissionIdentity = Object.freeze({
  implementationBuild: '1.2.0-s1',
  wireLineage: 'protocol-1.6-api-schema-12',
  apiSchemaVersion: 12,
  storeSchemaVersion: 13,
  knownClientBuilds: Object.freeze(['1.2.0-s1']),
});
const CAPABILITY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const NONCE = 'ab'.repeat(32);
const ENDPOINT: CoordinatorAdmissionEndpointFacts = Object.freeze({
  lifecycle_pid: 4242,
  lifecycle_boot_id: 'boot-vector',
  lifecycle_process_start_identity: 'start-vector',
  lifecycle_instance_id: 'instance-vector',
  legacy_lock_sha256: `sha256:${'11'.repeat(32)}`,
  runtime_identity_sha256: `sha256:${'22'.repeat(32)}`,
  store_generation_id: `generation-${'33'.repeat(16)}`,
});

function admittedResponse(): CoordinatorAdmissionResponse {
  const request = createCoordinatorAdmissionRequest({ requestId: 'request-vector', identity: IDENTITY, nonce: NONCE });
  return createCoordinatorAdmissionResponse({ request: request.payload, identity: IDENTITY, endpoint: ENDPOINT, capability: CAPABILITY });
}

function expected(admitted = true): CoordinatorAdmissionVerificationExpectation {
  return Object.freeze({
    actualClientBuild: '1.2.0-s1',
    requestedVocabulary: COORDINATOR_ADMISSION_VOCABULARY,
    nonce: NONCE,
    admitted,
    ...ENDPOINT,
  });
}

function mutate(response: CoordinatorAdmissionResponse, field: keyof CoordinatorAdmissionResponse, value: unknown): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...response, [field]: value });
}

void describe('S1 admission contracts and domain-separated HMAC', () => {
  void it('locks the exact offer, request envelope, sorted vocabulary, and nonce shape', () => {
    const offer = createCoordinatorAdmissionOffer(IDENTITY);
    assert.deepEqual(offer, {
      schema_version: 'autopilot.coordinator_admission_offer.v1',
      action: 'negotiate-admission',
      algorithm: 'hmac-sha256',
      wire_lineage: 'protocol-1.6-api-schema-12',
    });
    assert.deepEqual(parseCoordinatorAdmissionOffer(offer, IDENTITY.wireLineage), offer);
    const envelope = createCoordinatorAdmissionRequest({ requestId: 'request-contract', identity: IDENTITY, nonce: NONCE });
    assert.deepEqual(Object.keys(envelope).sort(), ['action', 'expected_version', 'fencing_generation', 'idempotency_key', 'payload', 'protocol_version', 'repo_id', 'request_id', 'schema_version', 'session_id', 'workstream_run'].sort());
    assert.deepEqual(Object.keys(envelope.payload).sort(), ['api_schema_version', 'client_build', 'nonce', 'requested_vocabulary', 'schema_version', 'wire_lineage'].sort());
    assert.deepEqual(envelope.payload.requested_vocabulary, [...COORDINATOR_ADMISSION_VOCABULARY]);
    assert.deepEqual(parseCoordinatorAdmissionRequestEnvelope(envelope, IDENTITY), envelope);
  });

  void it('rejects malformed requests without turning policy rejections into parser errors', () => {
    const valid = createCoordinatorAdmissionRequest({ requestId: 'request-negative', identity: IDENTITY, nonce: NONCE }).payload;
    const invalid: readonly unknown[] = [
      { ...valid, extra: true },
      { ...valid, nonce: 'AB'.repeat(32) },
      { ...valid, nonce: 'ab'.repeat(31) },
      { ...valid, requested_vocabulary: [] },
      { ...valid, requested_vocabulary: ['legacy-protocol-1.6', 'admission-v1'] },
      { ...valid, requested_vocabulary: ['admission-v1', 'admission-v1'] },
      { ...valid, wire_lineage: 'protocol-1.7-api-schema-12' },
      { ...valid, api_schema_version: 13 },
      { ...valid, schema_version: 'autopilot.coordinator_admission_request.v2' },
    ];
    for (const candidate of invalid) assert.throws(() => parseCoordinatorAdmissionRequest(candidate, IDENTITY));

    const unknownBuild = parseCoordinatorAdmissionRequest({ ...valid, client_build: '1.2.1-s2' }, IDENTITY);
    const unknownVocabulary = parseCoordinatorAdmissionRequest({ ...valid, requested_vocabulary: ['admission-v1', 'future-vocabulary-v1'] }, IDENTITY);
    assert.equal(unknownBuild.client_build, '1.2.1-s2');
    assert.deepEqual(unknownVocabulary.requested_vocabulary, ['admission-v1', 'future-vocabulary-v1']);
  });

  void it('pins the independent canonical/HMAC vector and uses raw decoded capability bytes', () => {
    const response = admittedResponse();
    assert.equal(response.attestation, '22aec9ec60863a4e56a2c87d3d54c6e55ac69ec6c676bf6217d2cf49a607e938');
    const withoutAttestation = {
      schema_version: response.schema_version,
      admission_mode: response.admission_mode,
      admitted: response.admitted,
      actual_client_build: response.actual_client_build,
      actual_coordinator_build: response.actual_coordinator_build,
      wire_lineage: response.wire_lineage,
      api_schema_version: response.api_schema_version,
      store_schema_version: response.store_schema_version,
      requested_vocabulary: response.requested_vocabulary,
      granted_vocabulary: response.granted_vocabulary,
      nonce: response.nonce,
      lifecycle_pid: response.lifecycle_pid,
      lifecycle_boot_id: response.lifecycle_boot_id,
      lifecycle_process_start_identity: response.lifecycle_process_start_identity,
      lifecycle_instance_id: response.lifecycle_instance_id,
      legacy_lock_sha256: response.legacy_lock_sha256,
      runtime_identity_sha256: response.runtime_identity_sha256,
      store_generation_id: response.store_generation_id,
      result: response.result,
      algorithm: response.algorithm,
    };
    const asciiKeyHmac = createHmac('sha256', Buffer.from(CAPABILITY, 'utf8'))
      .update(COORDINATOR_ADMISSION_DOMAIN, 'utf8')
      .update(canonicalJson(withoutAttestation), 'utf8')
      .digest('hex');
    assert.notEqual(response.attestation, asciiKeyHmac, 'the 64-character hex text must never be used as the HMAC key');
    assert.equal(response.attestation.length, 64);
    assert.doesNotThrow(() => verifyCoordinatorAdmissionResponse({ response, identity: IDENTITY, capability: CAPABILITY, expected: expected() }));
  });

  void it('returns signed all-or-nothing rejections for unknown build or vocabulary', () => {
    const valid = createCoordinatorAdmissionRequest({ requestId: 'request-rejection', identity: IDENTITY, nonce: NONCE }).payload;
    for (const request of [
      { ...valid, client_build: '1.2.1-s2' },
      { ...valid, requested_vocabulary: ['admission-v1', 'future-vocabulary-v1'] },
    ]) {
      const parsed = parseCoordinatorAdmissionRequest(request, IDENTITY);
      const response = createCoordinatorAdmissionResponse({ request: parsed, identity: IDENTITY, endpoint: ENDPOINT, capability: CAPABILITY });
      assert.equal(response.admitted, false);
      assert.equal(response.result, 'rejected');
      assert.deepEqual(response.granted_vocabulary, []);
      assert.equal(response.actual_client_build, parsed.client_build);
      assert.equal(response.attestation.length, 64);
      const rejectionExpectation = { ...expected(false), actualClientBuild: parsed.client_build, requestedVocabulary: parsed.requested_vocabulary };
      assert.doesNotThrow(() => verifyCoordinatorAdmissionResponse({ response, identity: IDENTITY, capability: CAPABILITY, expected: rejectionExpectation }));
    }
  });

  void it('rejects every authority-bearing response field when modified', () => {
    const response = admittedResponse();
    const tampered: readonly Readonly<Record<string, unknown>>[] = [
      mutate(response, 'nonce', 'cd'.repeat(32)),
      mutate(response, 'actual_client_build', '1.2.1-s2'),
      mutate(response, 'actual_coordinator_build', '1.2.1-s2'),
      mutate(response, 'wire_lineage', 'protocol-1.7-api-schema-12'),
      mutate(response, 'api_schema_version', 13),
      mutate(response, 'store_schema_version', 14),
      mutate(response, 'requested_vocabulary', ['admission-v1']),
      mutate(response, 'granted_vocabulary', ['admission-v1']),
      mutate(response, 'admitted', false),
      mutate(response, 'result', 'rejected'),
      mutate(response, 'lifecycle_pid', 4243),
      mutate(response, 'lifecycle_boot_id', 'boot-tampered'),
      mutate(response, 'lifecycle_process_start_identity', 'start-tampered'),
      mutate(response, 'lifecycle_instance_id', 'instance-tampered'),
      mutate(response, 'legacy_lock_sha256', `sha256:${'44'.repeat(32)}`),
      mutate(response, 'runtime_identity_sha256', `sha256:${'55'.repeat(32)}`),
      mutate(response, 'store_generation_id', `generation-${'66'.repeat(16)}`),
      mutate(response, 'algorithm', 'sha256'),
      mutate(response, 'attestation', '00'.repeat(32)),
      { ...response, extra: true },
    ];
    for (const candidate of tampered) {
      assert.throws(() => verifyCoordinatorAdmissionResponse({ response: candidate, identity: IDENTITY, capability: CAPABILITY, expected: expected() }));
    }
  });

  void it('rejects wrong or malformed capabilities, malformed HMACs, and never exposes capability text', () => {
    const response = admittedResponse();
    assert.throws(() => verifyCoordinatorAdmissionResponse({ response, identity: IDENTITY, capability: 'ff'.repeat(32), expected: expected() }));
    for (const capability of ['', 'A'.repeat(64), '0'.repeat(62), 'z'.repeat(64)]) {
      let diagnostic = '';
      try {
        createCoordinatorAdmissionResponse({
          request: createCoordinatorAdmissionRequest({ requestId: 'request-capability', identity: IDENTITY, nonce: NONCE }).payload,
          identity: IDENTITY,
          endpoint: ENDPOINT,
          capability,
        });
      } catch (error) { diagnostic = error instanceof Error ? error.message : String(error); }
      assert.ok(diagnostic.length > 0);
      if (capability.length > 0) assert.equal(diagnostic.includes(capability), false);
    }
    for (const attestation of ['', '00', 'AA'.repeat(32), '0'.repeat(66)]) {
      assert.throws(() => parseCoordinatorAdmissionResponse({ ...response, attestation }, IDENTITY));
    }
    assert.equal(JSON.stringify(response).includes(CAPABILITY), false);
  });

  void it('hashes exact raw authority bytes instead of reparsed JSON', () => {
    const left = Buffer.from('{"a":1,"b":2}\n', 'utf8');
    const right = Buffer.from('{ "b": 2, "a": 1 }\n', 'utf8');
    assert.notEqual(sha256CoordinatorAuthorityBytes(left), sha256CoordinatorAuthorityBytes(right));
  });
});
