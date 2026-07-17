import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { CoordinationContractError } from './contracts.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION } from './types.ts';

export const COORDINATOR_ADMISSION_OFFER_SCHEMA = 'autopilot.coordinator_admission_offer.v1' as const;
export const COORDINATOR_ADMISSION_REQUEST_SCHEMA = 'autopilot.coordinator_admission_request.v1' as const;
export const COORDINATOR_ADMISSION_RESPONSE_SCHEMA = 'autopilot.coordinator_admission_response.v1' as const;
export const COORDINATOR_ADMISSION_ACTION = 'negotiate-admission' as const;
export const COORDINATOR_ADMISSION_ALGORITHM = 'hmac-sha256' as const;
export const COORDINATOR_ADMISSION_DOMAIN = 'pi-autopilot/admission/v1\0' as const;

/** The order is the only valid request order: non-empty, sorted, and unique. */
export const COORDINATOR_ADMISSION_VOCABULARY = Object.freeze([
  'admission-v1',
  'canonical-worktree-aliases-v1',
  'legacy-protocol-1.6',
  'scoped-logical-faults-v1',
  'store-generations-v1',
] as const);

export type CoordinatorAdmissionVocabulary = (typeof COORDINATOR_ADMISSION_VOCABULARY)[number];
export type CoordinatorAdmissionResult = 'admitted' | 'rejected';

export interface CoordinatorAdmissionIdentity {
  readonly implementationBuild: string;
  readonly wireLineage: string;
  readonly apiSchemaVersion: number;
  readonly storeSchemaVersion: number;
  readonly knownClientBuilds: readonly string[];
}

export interface CoordinatorAdmissionOffer {
  readonly schema_version: typeof COORDINATOR_ADMISSION_OFFER_SCHEMA;
  readonly action: typeof COORDINATOR_ADMISSION_ACTION;
  readonly algorithm: typeof COORDINATOR_ADMISSION_ALGORITHM;
  readonly wire_lineage: string;
}

export interface CoordinatorAdmissionRequest {
  readonly schema_version: typeof COORDINATOR_ADMISSION_REQUEST_SCHEMA;
  readonly client_build: string;
  readonly wire_lineage: string;
  readonly api_schema_version: number;
  readonly requested_vocabulary: readonly string[];
  readonly nonce: string;
}

export interface CoordinatorAdmissionRequestEnvelope {
  readonly schema_version: 'autopilot.coordinator_request.v1';
  readonly protocol_version: typeof AUTOPILOT_COORDINATOR_PROTOCOL_VERSION;
  readonly request_id: string;
  readonly action: typeof COORDINATOR_ADMISSION_ACTION;
  readonly idempotency_key: null;
  readonly repo_id: 'global';
  readonly workstream_run: null;
  readonly session_id: null;
  readonly fencing_generation: null;
  readonly expected_version: null;
  readonly payload: CoordinatorAdmissionRequest;
}

export interface CoordinatorAdmissionEndpointFacts {
  readonly lifecycle_pid: number;
  readonly lifecycle_boot_id: string;
  readonly lifecycle_process_start_identity: string;
  readonly lifecycle_instance_id: string;
  readonly legacy_lock_sha256: string;
  readonly runtime_identity_sha256: string;
  readonly store_generation_id: string;
}

export interface CoordinatorAdmissionResponse {
  readonly schema_version: typeof COORDINATOR_ADMISSION_RESPONSE_SCHEMA;
  readonly admission_mode: 'negotiated-s1';
  readonly admitted: boolean;
  readonly actual_client_build: string;
  readonly actual_coordinator_build: string;
  readonly wire_lineage: string;
  readonly api_schema_version: number;
  readonly store_schema_version: number;
  readonly requested_vocabulary: readonly string[];
  readonly granted_vocabulary: readonly CoordinatorAdmissionVocabulary[];
  readonly nonce: string;
  readonly lifecycle_pid: number;
  readonly lifecycle_boot_id: string;
  readonly lifecycle_process_start_identity: string;
  readonly lifecycle_instance_id: string;
  readonly legacy_lock_sha256: string;
  readonly runtime_identity_sha256: string;
  readonly store_generation_id: string;
  readonly result: CoordinatorAdmissionResult;
  readonly algorithm: typeof COORDINATOR_ADMISSION_ALGORITHM;
  readonly attestation: string;
}

export interface CoordinatorAdmissionVerificationExpectation extends CoordinatorAdmissionEndpointFacts {
  readonly actualClientBuild: string;
  readonly requestedVocabulary: readonly string[];
  readonly nonce: string;
  readonly admitted: boolean;
}

interface JsonObject {
  readonly [key: string]: unknown;
}

interface CoordinatorAdmissionUnsignedResponse {
  readonly schema_version: typeof COORDINATOR_ADMISSION_RESPONSE_SCHEMA;
  readonly admission_mode: 'negotiated-s1';
  readonly admitted: boolean;
  readonly actual_client_build: string;
  readonly actual_coordinator_build: string;
  readonly wire_lineage: string;
  readonly api_schema_version: number;
  readonly store_schema_version: number;
  readonly requested_vocabulary: readonly string[];
  readonly granted_vocabulary: readonly CoordinatorAdmissionVocabulary[];
  readonly nonce: string;
  readonly lifecycle_pid: number;
  readonly lifecycle_boot_id: string;
  readonly lifecycle_process_start_identity: string;
  readonly lifecycle_instance_id: string;
  readonly legacy_lock_sha256: string;
  readonly runtime_identity_sha256: string;
  readonly store_generation_id: string;
  readonly result: CoordinatorAdmissionResult;
  readonly algorithm: typeof COORDINATOR_ADMISSION_ALGORITHM;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const LOWER_HEX_64 = /^[a-f0-9]{64}$/u;
const BUILD_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u;
const VOCABULARY_IDENTIFIER = /^[a-z0-9][a-z0-9.-]{0,127}$/u;
const REQUEST_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/u;
const GENERATION_IDENTIFIER = /^generation-[a-f0-9]{32}$/u;

const OFFER_FIELDS = Object.freeze(['action', 'algorithm', 'schema_version', 'wire_lineage']);
const REQUEST_FIELDS = Object.freeze(['api_schema_version', 'client_build', 'nonce', 'requested_vocabulary', 'schema_version', 'wire_lineage']);
const REQUEST_ENVELOPE_FIELDS = Object.freeze(['action', 'expected_version', 'fencing_generation', 'idempotency_key', 'payload', 'protocol_version', 'repo_id', 'request_id', 'schema_version', 'session_id', 'workstream_run']);
const RESPONSE_FIELDS = Object.freeze([
  'actual_client_build', 'actual_coordinator_build', 'admission_mode', 'admitted', 'algorithm', 'api_schema_version', 'attestation',
  'granted_vocabulary', 'legacy_lock_sha256', 'lifecycle_boot_id', 'lifecycle_instance_id', 'lifecycle_pid',
  'lifecycle_process_start_identity', 'nonce', 'requested_vocabulary', 'result', 'runtime_identity_sha256', 'schema_version',
  'store_generation_id', 'store_schema_version', 'wire_lineage',
]);

function fail(label: string, issue: string): never {
  throw new CoordinationContractError(label, [issue]);
}

function object(value: unknown, label: string, fields: readonly string[]): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(label, 'must be an object');
  const record = value as JsonObject;
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(label, `field set must be exactly ${expected.join(',')}`);
  }
  return record;
}

function exactString(record: JsonObject, key: string, expected: string, label: string): string {
  const value = record[key];
  if (value !== expected) fail(label, `${key} must equal ${expected}`);
  return expected;
}

function boundedString(record: JsonObject, key: string, label: string, maximum = 512): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length < 1 || [...value].length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail(label, `${key} must be a bounded non-control string`);
  return value;
}

function safeInteger(record: JsonObject, key: string, label: string, minimum = 0): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail(label, `${key} must be a safe integer >= ${String(minimum)}`);
  return value;
}

function stringArray(record: JsonObject, key: string, label: string, allowEmpty: boolean): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > COORDINATOR_ADMISSION_VOCABULARY.length + 16) fail(label, `${key} must be a bounded${allowEmpty ? '' : ' non-empty'} array`);
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !VOCABULARY_IDENTIFIER.test(entry)) fail(label, `${key} entries must be bounded vocabulary identifiers`);
    entries.push(entry);
  }
  for (let index = 1; index < entries.length; index += 1) {
    const prior = entries[index - 1];
    const current = entries[index];
    if (prior === undefined || current === undefined || prior >= current) fail(label, `${key} must be sorted and unique`);
  }
  return Object.freeze(entries);
}

function parseIdentity(identity: CoordinatorAdmissionIdentity): CoordinatorAdmissionIdentity {
  if (!BUILD_IDENTIFIER.test(identity.implementationBuild)) fail('CoordinatorAdmissionIdentity', 'implementationBuild is malformed');
  if (identity.wireLineage.length < 1 || identity.wireLineage.length > 192) fail('CoordinatorAdmissionIdentity', 'wireLineage is malformed');
  if (!Number.isSafeInteger(identity.apiSchemaVersion) || identity.apiSchemaVersion < 1) fail('CoordinatorAdmissionIdentity', 'apiSchemaVersion is malformed');
  if (!Number.isSafeInteger(identity.storeSchemaVersion) || identity.storeSchemaVersion < 1) fail('CoordinatorAdmissionIdentity', 'storeSchemaVersion is malformed');
  if (identity.knownClientBuilds.length < 1) fail('CoordinatorAdmissionIdentity', 'knownClientBuilds must be non-empty');
  const known = [...identity.knownClientBuilds];
  if (known.some((build) => !BUILD_IDENTIFIER.test(build))) fail('CoordinatorAdmissionIdentity', 'knownClientBuilds contains a malformed build');
  const sorted = [...new Set(known)].sort();
  if (sorted.length !== known.length) fail('CoordinatorAdmissionIdentity', 'knownClientBuilds must be unique');
  return Object.freeze({ ...identity, knownClientBuilds: Object.freeze(known) });
}

function parseEndpointFacts(value: CoordinatorAdmissionEndpointFacts, label: string): CoordinatorAdmissionEndpointFacts {
  const record: JsonObject = {
    lifecycle_pid: value.lifecycle_pid,
    lifecycle_boot_id: value.lifecycle_boot_id,
    lifecycle_process_start_identity: value.lifecycle_process_start_identity,
    lifecycle_instance_id: value.lifecycle_instance_id,
    legacy_lock_sha256: value.legacy_lock_sha256,
    runtime_identity_sha256: value.runtime_identity_sha256,
    store_generation_id: value.store_generation_id,
  };
  const lifecyclePid = safeInteger(record, 'lifecycle_pid', label, 1);
  const lifecycleBootId = boundedString(record, 'lifecycle_boot_id', label);
  const processStartIdentity = boundedString(record, 'lifecycle_process_start_identity', label);
  const lifecycleInstanceId = boundedString(record, 'lifecycle_instance_id', label);
  const legacyLockSha256 = boundedString(record, 'legacy_lock_sha256', label, 71);
  const runtimeIdentitySha256 = boundedString(record, 'runtime_identity_sha256', label, 71);
  const storeGenerationId = boundedString(record, 'store_generation_id', label, 43);
  if (!SHA256.test(legacyLockSha256)) fail(label, 'legacy_lock_sha256 must be sha256:<64-lowercase-hex>');
  if (!SHA256.test(runtimeIdentitySha256)) fail(label, 'runtime_identity_sha256 must be sha256:<64-lowercase-hex>');
  if (!GENERATION_IDENTIFIER.test(storeGenerationId)) fail(label, 'store_generation_id is malformed');
  return Object.freeze({
    lifecycle_pid: lifecyclePid,
    lifecycle_boot_id: lifecycleBootId,
    lifecycle_process_start_identity: processStartIdentity,
    lifecycle_instance_id: lifecycleInstanceId,
    legacy_lock_sha256: legacyLockSha256,
    runtime_identity_sha256: runtimeIdentitySha256,
    store_generation_id: storeGenerationId,
  });
}

function parseRequestedVocabulary(record: JsonObject, key: string, label: string): readonly string[] {
  return stringArray(record, key, label, false);
}

function parseGrantedVocabulary(record: JsonObject, label: string): readonly CoordinatorAdmissionVocabulary[] {
  const entries = stringArray(record, 'granted_vocabulary', label, true);
  const granted: CoordinatorAdmissionVocabulary[] = [];
  for (const entry of entries) {
    if (!isCoordinatorAdmissionVocabulary(entry)) fail(label, 'granted_vocabulary contains an unknown value');
    granted.push(entry);
  }
  return Object.freeze(granted);
}

export function isCoordinatorAdmissionVocabulary(value: string): value is CoordinatorAdmissionVocabulary {
  return COORDINATOR_ADMISSION_VOCABULARY.some((entry) => entry === value);
}

export function parseCoordinatorAdmissionOffer(value: unknown, expectedWireLineage: string): CoordinatorAdmissionOffer {
  const label = 'CoordinatorAdmissionOffer';
  const record = object(value, label, OFFER_FIELDS);
  return Object.freeze({
    schema_version: exactString(record, 'schema_version', COORDINATOR_ADMISSION_OFFER_SCHEMA, label) as typeof COORDINATOR_ADMISSION_OFFER_SCHEMA,
    action: exactString(record, 'action', COORDINATOR_ADMISSION_ACTION, label) as typeof COORDINATOR_ADMISSION_ACTION,
    algorithm: exactString(record, 'algorithm', COORDINATOR_ADMISSION_ALGORITHM, label) as typeof COORDINATOR_ADMISSION_ALGORITHM,
    wire_lineage: exactString(record, 'wire_lineage', expectedWireLineage, label),
  });
}

export function createCoordinatorAdmissionOffer(identityValue: CoordinatorAdmissionIdentity): CoordinatorAdmissionOffer {
  const identity = parseIdentity(identityValue);
  return Object.freeze({
    schema_version: COORDINATOR_ADMISSION_OFFER_SCHEMA,
    action: COORDINATOR_ADMISSION_ACTION,
    algorithm: COORDINATOR_ADMISSION_ALGORITHM,
    wire_lineage: identity.wireLineage,
  });
}

export function parseCoordinatorAdmissionRequest(value: unknown, identityValue: CoordinatorAdmissionIdentity): CoordinatorAdmissionRequest {
  const identity = parseIdentity(identityValue);
  const label = 'CoordinatorAdmissionRequest';
  const record = object(value, label, REQUEST_FIELDS);
  const clientBuild = boundedString(record, 'client_build', label, 192);
  if (!BUILD_IDENTIFIER.test(clientBuild)) fail(label, 'client_build is malformed');
  const nonce = boundedString(record, 'nonce', label, 64);
  if (!LOWER_HEX_64.test(nonce)) fail(label, 'nonce must be exactly 32 random bytes encoded as 64 lowercase hex');
  return Object.freeze({
    schema_version: exactString(record, 'schema_version', COORDINATOR_ADMISSION_REQUEST_SCHEMA, label) as typeof COORDINATOR_ADMISSION_REQUEST_SCHEMA,
    client_build: clientBuild,
    wire_lineage: exactString(record, 'wire_lineage', identity.wireLineage, label),
    api_schema_version: (() => {
      const version = safeInteger(record, 'api_schema_version', label, 1);
      if (version !== identity.apiSchemaVersion) fail(label, `api_schema_version must equal ${String(identity.apiSchemaVersion)}`);
      return version;
    })(),
    requested_vocabulary: parseRequestedVocabulary(record, 'requested_vocabulary', label),
    nonce,
  });
}

export function parseCoordinatorAdmissionRequestEnvelope(value: unknown, identityValue: CoordinatorAdmissionIdentity): CoordinatorAdmissionRequestEnvelope {
  const label = 'CoordinatorAdmissionRequestEnvelope';
  const record = object(value, label, REQUEST_ENVELOPE_FIELDS);
  const requestId = boundedString(record, 'request_id', label, 192);
  if (!REQUEST_IDENTIFIER.test(requestId)) fail(label, 'request_id is malformed');
  if (record['idempotency_key'] !== null || record['workstream_run'] !== null || record['session_id'] !== null || record['fencing_generation'] !== null || record['expected_version'] !== null) fail(label, 'admission envelope authority fields must be null');
  return Object.freeze({
    schema_version: exactString(record, 'schema_version', 'autopilot.coordinator_request.v1', label) as 'autopilot.coordinator_request.v1',
    protocol_version: exactString(record, 'protocol_version', AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, label) as typeof AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
    request_id: requestId,
    action: exactString(record, 'action', COORDINATOR_ADMISSION_ACTION, label) as typeof COORDINATOR_ADMISSION_ACTION,
    idempotency_key: null,
    repo_id: exactString(record, 'repo_id', 'global', label) as 'global',
    workstream_run: null,
    session_id: null,
    fencing_generation: null,
    expected_version: null,
    payload: parseCoordinatorAdmissionRequest(record['payload'], identityValue),
  });
}

export function createCoordinatorAdmissionRequest(input: {
  readonly requestId: string;
  readonly identity: CoordinatorAdmissionIdentity;
  readonly requestedVocabulary?: readonly CoordinatorAdmissionVocabulary[];
  readonly nonce?: string;
}): CoordinatorAdmissionRequestEnvelope {
  const identity = parseIdentity(input.identity);
  const requested = input.requestedVocabulary === undefined ? COORDINATOR_ADMISSION_VOCABULARY : Object.freeze([...input.requestedVocabulary]);
  const nonce = input.nonce ?? randomBytes(32).toString('hex');
  return parseCoordinatorAdmissionRequestEnvelope({
    schema_version: 'autopilot.coordinator_request.v1',
    protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
    request_id: input.requestId,
    action: COORDINATOR_ADMISSION_ACTION,
    idempotency_key: null,
    repo_id: 'global',
    workstream_run: null,
    session_id: null,
    fencing_generation: null,
    expected_version: null,
    payload: {
      schema_version: COORDINATOR_ADMISSION_REQUEST_SCHEMA,
      client_build: identity.implementationBuild,
      wire_lineage: identity.wireLineage,
      api_schema_version: identity.apiSchemaVersion,
      requested_vocabulary: requested,
      nonce,
    },
  }, identity);
}

function unsignedAdmissionResponse(response: CoordinatorAdmissionResponse): CoordinatorAdmissionUnsignedResponse {
  return Object.freeze({
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
  });
}

function decodeCapability(capability: string): NodeBuffer {
  if (!LOWER_HEX_64.test(capability)) throw new CoordinationRuntimeError('unauthorized-client', 'coordinator capability proof is malformed');
  const key = Buffer.from(capability, 'hex');
  if (key.byteLength !== 32) throw new CoordinationRuntimeError('unauthorized-client', 'coordinator capability proof has an invalid decoded length');
  return key;
}

function admissionHmac(unsigned: CoordinatorAdmissionUnsignedResponse, capability: string): string {
  const key = decodeCapability(capability);
  return createHmac('sha256', key)
    .update(COORDINATOR_ADMISSION_DOMAIN, 'utf8')
    .update(canonicalJson(unsigned), 'utf8')
    .digest('hex');
}

export function createCoordinatorAdmissionResponse(input: {
  readonly request: CoordinatorAdmissionRequest;
  readonly identity: CoordinatorAdmissionIdentity;
  readonly endpoint: CoordinatorAdmissionEndpointFacts;
  readonly capability: string;
}): CoordinatorAdmissionResponse {
  const identity = parseIdentity(input.identity);
  const request = parseCoordinatorAdmissionRequest(input.request, identity);
  const endpoint = parseEndpointFacts(input.endpoint, 'CoordinatorAdmissionEndpointFacts');
  const knownBuild = identity.knownClientBuilds.includes(request.client_build);
  const knownVocabulary = request.requested_vocabulary.every((entry) => isCoordinatorAdmissionVocabulary(entry));
  const admitted = knownBuild && knownVocabulary;
  const granted: readonly CoordinatorAdmissionVocabulary[] = admitted
    ? Object.freeze(request.requested_vocabulary.map((entry) => {
        if (!isCoordinatorAdmissionVocabulary(entry)) throw new CoordinationRuntimeError('system-fatal', 'admitted vocabulary escaped its closed registry');
        return entry;
      }))
    : Object.freeze([]);
  const unsigned: CoordinatorAdmissionUnsignedResponse = Object.freeze({
    schema_version: COORDINATOR_ADMISSION_RESPONSE_SCHEMA,
    admission_mode: 'negotiated-s1',
    admitted,
    actual_client_build: request.client_build,
    actual_coordinator_build: identity.implementationBuild,
    wire_lineage: identity.wireLineage,
    api_schema_version: identity.apiSchemaVersion,
    store_schema_version: identity.storeSchemaVersion,
    requested_vocabulary: request.requested_vocabulary,
    granted_vocabulary: granted,
    nonce: request.nonce,
    ...endpoint,
    result: admitted ? 'admitted' : 'rejected',
    algorithm: COORDINATOR_ADMISSION_ALGORITHM,
  });
  return Object.freeze({ ...unsigned, attestation: admissionHmac(unsigned, input.capability) });
}

export function parseCoordinatorAdmissionResponse(value: unknown, identityValue: CoordinatorAdmissionIdentity): CoordinatorAdmissionResponse {
  const identity = parseIdentity(identityValue);
  const label = 'CoordinatorAdmissionResponse';
  const record = object(value, label, RESPONSE_FIELDS);
  const actualClientBuild = boundedString(record, 'actual_client_build', label, 192);
  if (!BUILD_IDENTIFIER.test(actualClientBuild)) fail(label, 'actual_client_build is malformed');
  const requested = parseRequestedVocabulary(record, 'requested_vocabulary', label);
  const granted = parseGrantedVocabulary(record, label);
  const admitted = record['admitted'];
  if (typeof admitted !== 'boolean') fail(label, 'admitted must be boolean');
  const result = record['result'];
  if (result !== 'admitted' && result !== 'rejected') fail(label, 'result must be admitted or rejected');
  if (admitted !== (result === 'admitted')) fail(label, 'admitted and result disagree');
  if (admitted) {
    if (requested.some((entry) => !isCoordinatorAdmissionVocabulary(entry))) fail(label, 'an admitted response requests unknown vocabulary');
    if (requested.length !== granted.length || requested.some((entry, index) => entry !== granted[index])) fail(label, 'an admitted response must grant exactly the requested vocabulary');
  } else if (granted.length !== 0) fail(label, 'a rejected response must grant an empty vocabulary');
  const nonce = boundedString(record, 'nonce', label, 64);
  const attestation = boundedString(record, 'attestation', label, 64);
  if (!LOWER_HEX_64.test(nonce)) fail(label, 'nonce must be 64 lowercase hex');
  if (!LOWER_HEX_64.test(attestation)) fail(label, 'attestation must be 64 lowercase hex');
  const endpoint = parseEndpointFacts({
    lifecycle_pid: safeInteger(record, 'lifecycle_pid', label, 1),
    lifecycle_boot_id: boundedString(record, 'lifecycle_boot_id', label),
    lifecycle_process_start_identity: boundedString(record, 'lifecycle_process_start_identity', label),
    lifecycle_instance_id: boundedString(record, 'lifecycle_instance_id', label),
    legacy_lock_sha256: boundedString(record, 'legacy_lock_sha256', label, 71),
    runtime_identity_sha256: boundedString(record, 'runtime_identity_sha256', label, 71),
    store_generation_id: boundedString(record, 'store_generation_id', label, 43),
  }, label);
  const apiSchemaVersion = safeInteger(record, 'api_schema_version', label, 1);
  const storeSchemaVersion = safeInteger(record, 'store_schema_version', label, 1);
  if (apiSchemaVersion !== identity.apiSchemaVersion) fail(label, `api_schema_version must equal ${String(identity.apiSchemaVersion)}`);
  if (storeSchemaVersion !== identity.storeSchemaVersion) fail(label, `store_schema_version must equal ${String(identity.storeSchemaVersion)}`);
  return Object.freeze({
    schema_version: exactString(record, 'schema_version', COORDINATOR_ADMISSION_RESPONSE_SCHEMA, label) as typeof COORDINATOR_ADMISSION_RESPONSE_SCHEMA,
    admission_mode: exactString(record, 'admission_mode', 'negotiated-s1', label) as 'negotiated-s1',
    admitted,
    actual_client_build: actualClientBuild,
    actual_coordinator_build: exactString(record, 'actual_coordinator_build', identity.implementationBuild, label),
    wire_lineage: exactString(record, 'wire_lineage', identity.wireLineage, label),
    api_schema_version: apiSchemaVersion,
    store_schema_version: storeSchemaVersion,
    requested_vocabulary: requested,
    granted_vocabulary: granted,
    nonce,
    ...endpoint,
    result,
    algorithm: exactString(record, 'algorithm', COORDINATOR_ADMISSION_ALGORITHM, label) as typeof COORDINATOR_ADMISSION_ALGORITHM,
    attestation,
  });
}

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export function verifyCoordinatorAdmissionResponse(input: {
  readonly response: unknown;
  readonly identity: CoordinatorAdmissionIdentity;
  readonly capability: string;
  readonly expected: CoordinatorAdmissionVerificationExpectation;
}): CoordinatorAdmissionResponse {
  const response = parseCoordinatorAdmissionResponse(input.response, input.identity);
  const actualHmac = Buffer.from(response.attestation, 'hex');
  if (actualHmac.byteLength !== 32) throw new CoordinationRuntimeError('unauthorized-client', 'coordinator admission attestation has an invalid decoded length');
  const expectedHmacHex = admissionHmac(unsignedAdmissionResponse(response), input.capability);
  const expectedHmac = Buffer.from(expectedHmacHex, 'hex');
  if (expectedHmac.byteLength !== 32 || !timingSafeEqual(actualHmac, expectedHmac)) throw new CoordinationRuntimeError('unauthorized-client', 'coordinator admission attestation was rejected');
  const expectedEndpoint = parseEndpointFacts(input.expected, 'CoordinatorAdmissionVerificationExpectation');
  if (response.actual_client_build !== input.expected.actualClientBuild) throw new CoordinationRuntimeError('protocol-mismatch', 'coordinator admission changed the actual client build');
  if (response.nonce !== input.expected.nonce) throw new CoordinationRuntimeError('unauthorized-client', 'coordinator admission nonce does not match this socket');
  if (!equalStringArrays(response.requested_vocabulary, input.expected.requestedVocabulary)) throw new CoordinationRuntimeError('protocol-mismatch', 'coordinator admission changed the requested vocabulary');
  if (response.admitted !== input.expected.admitted) throw new CoordinationRuntimeError('protocol-mismatch', 'coordinator admission result was not the expected policy outcome');
  if (response.lifecycle_pid !== expectedEndpoint.lifecycle_pid
    || response.lifecycle_boot_id !== expectedEndpoint.lifecycle_boot_id
    || response.lifecycle_process_start_identity !== expectedEndpoint.lifecycle_process_start_identity
    || response.lifecycle_instance_id !== expectedEndpoint.lifecycle_instance_id) {
    throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator admission lifecycle identity changed');
  }
  if (response.legacy_lock_sha256 !== expectedEndpoint.legacy_lock_sha256) throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator admission legacy-lock digest changed');
  if (response.runtime_identity_sha256 !== expectedEndpoint.runtime_identity_sha256) throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator admission runtime-identity digest changed');
  if (response.store_generation_id !== expectedEndpoint.store_generation_id) throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator admission store generation changed');
  return response;
}

export function sha256CoordinatorAuthorityBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export const COORDINATOR_ADMISSION_OFFER_JSON_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: OFFER_FIELDS,
  properties: Object.freeze({
    schema_version: Object.freeze({ const: COORDINATOR_ADMISSION_OFFER_SCHEMA }),
    action: Object.freeze({ const: COORDINATOR_ADMISSION_ACTION }),
    algorithm: Object.freeze({ const: COORDINATOR_ADMISSION_ALGORITHM }),
    wire_lineage: Object.freeze({ type: 'string', minLength: 1, maxLength: 192 }),
  }),
});

export const COORDINATOR_ADMISSION_REQUEST_JSON_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: REQUEST_FIELDS,
  properties: Object.freeze({
    schema_version: Object.freeze({ const: COORDINATOR_ADMISSION_REQUEST_SCHEMA }),
    client_build: Object.freeze({ type: 'string', pattern: BUILD_IDENTIFIER.source }),
    wire_lineage: Object.freeze({ type: 'string', minLength: 1, maxLength: 192 }),
    api_schema_version: Object.freeze({ type: 'integer', minimum: 1 }),
    requested_vocabulary: Object.freeze({ type: 'array', minItems: 1, maxItems: COORDINATOR_ADMISSION_VOCABULARY.length + 16, uniqueItems: true, items: Object.freeze({ type: 'string', pattern: VOCABULARY_IDENTIFIER.source }) }),
    nonce: Object.freeze({ type: 'string', pattern: LOWER_HEX_64.source }),
  }),
});

export const COORDINATOR_ADMISSION_RESPONSE_JSON_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: RESPONSE_FIELDS,
  properties: Object.freeze({
    schema_version: Object.freeze({ const: COORDINATOR_ADMISSION_RESPONSE_SCHEMA }),
    admission_mode: Object.freeze({ const: 'negotiated-s1' }),
    admitted: Object.freeze({ type: 'boolean' }),
    actual_client_build: Object.freeze({ type: 'string', pattern: BUILD_IDENTIFIER.source }),
    actual_coordinator_build: Object.freeze({ type: 'string', pattern: BUILD_IDENTIFIER.source }),
    wire_lineage: Object.freeze({ type: 'string', minLength: 1, maxLength: 192 }),
    api_schema_version: Object.freeze({ type: 'integer', minimum: 1 }),
    store_schema_version: Object.freeze({ type: 'integer', minimum: 1 }),
    requested_vocabulary: Object.freeze({ type: 'array', minItems: 1, maxItems: COORDINATOR_ADMISSION_VOCABULARY.length + 16, uniqueItems: true, items: Object.freeze({ type: 'string', pattern: VOCABULARY_IDENTIFIER.source }) }),
    granted_vocabulary: Object.freeze({ type: 'array', minItems: 0, maxItems: COORDINATOR_ADMISSION_VOCABULARY.length, uniqueItems: true, items: Object.freeze({ enum: COORDINATOR_ADMISSION_VOCABULARY }) }),
    nonce: Object.freeze({ type: 'string', pattern: LOWER_HEX_64.source }),
    lifecycle_pid: Object.freeze({ type: 'integer', minimum: 1 }),
    lifecycle_boot_id: Object.freeze({ type: 'string', minLength: 1, maxLength: 512 }),
    lifecycle_process_start_identity: Object.freeze({ type: 'string', minLength: 1, maxLength: 512 }),
    lifecycle_instance_id: Object.freeze({ type: 'string', minLength: 1, maxLength: 512 }),
    legacy_lock_sha256: Object.freeze({ type: 'string', pattern: SHA256.source }),
    runtime_identity_sha256: Object.freeze({ type: 'string', pattern: SHA256.source }),
    store_generation_id: Object.freeze({ type: 'string', pattern: GENERATION_IDENTIFIER.source }),
    result: Object.freeze({ enum: Object.freeze(['admitted', 'rejected']) }),
    algorithm: Object.freeze({ const: COORDINATOR_ADMISSION_ALGORITHM }),
    attestation: Object.freeze({ type: 'string', pattern: LOWER_HEX_64.source }),
  }),
});
