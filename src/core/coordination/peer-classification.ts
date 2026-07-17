import { parseCoordinatorAdmissionOffer, type CoordinatorAdmissionIdentity, type CoordinatorAdmissionOffer } from './admission.ts';
import { CoordinationContractError } from './contracts.ts';
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION } from './types.ts';

export interface CoordinatorLegacyFacadeIdentity {
  readonly legacyFacadeBuild: string;
  readonly apiSchemaVersion: number;
  readonly admissionIdentity: CoordinatorAdmissionIdentity;
}

export interface CoordinatorLegacyHandshake {
  readonly schema_version: 'autopilot.coordinator_handshake.v1';
  readonly package_build: string;
  readonly protocol_version: typeof AUTOPILOT_COORDINATOR_PROTOCOL_VERSION;
  readonly database_schema_version: number;
  readonly lifecycle_lock_schema: 'autopilot.coordinator_lock.v2';
  readonly lifecycle_pid: number;
  readonly lifecycle_boot_id: string;
  readonly lifecycle_process_start_identity: string;
  readonly lifecycle_instance_id: string;
  readonly lifecycle_started_at: string;
  readonly admission_upgrade?: CoordinatorAdmissionOffer;
}

export type CoordinatorInitialPeerClassification =
  | { readonly kind: 'known-cf50-predecessor'; readonly handshake: CoordinatorLegacyHandshake }
  | { readonly kind: 's1-admission-offered'; readonly handshake: CoordinatorLegacyHandshake; readonly offer: CoordinatorAdmissionOffer };

interface JsonObject { readonly [key: string]: unknown }

const BASE_FIELDS = Object.freeze([
  'database_schema_version', 'lifecycle_boot_id', 'lifecycle_instance_id', 'lifecycle_lock_schema', 'lifecycle_pid',
  'lifecycle_process_start_identity', 'lifecycle_started_at', 'package_build', 'protocol_version', 'schema_version',
]);

function fail(issue: string): never {
  throw new CoordinationContractError('CoordinatorLegacyHandshake', [issue]);
}

function bounded(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length < 1 || [...value].length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${field} must be a bounded non-control string`);
  return value;
}

export function parseCoordinatorLegacyFacadeHandshake(value: unknown, identity: CoordinatorLegacyFacadeIdentity): CoordinatorLegacyHandshake {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('payload must be an object');
  const record = value as JsonObject;
  const actual = Object.keys(record).sort();
  const expected = record['admission_upgrade'] === undefined ? [...BASE_FIELDS].sort() : [...BASE_FIELDS, 'admission_upgrade'].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail(`field set must be exactly ${expected.join(',')}`);
  if (record['schema_version'] !== 'autopilot.coordinator_handshake.v1') fail('schema_version is not the frozen legacy handshake schema');
  if (record['package_build'] !== identity.legacyFacadeBuild) fail('package_build is not the frozen cf50 façade');
  if (record['protocol_version'] !== AUTOPILOT_COORDINATOR_PROTOCOL_VERSION) fail('protocol_version is not 1.6');
  if (record['database_schema_version'] !== identity.apiSchemaVersion) fail('database_schema_version is not the frozen API schema');
  if (record['lifecycle_lock_schema'] !== 'autopilot.coordinator_lock.v2') fail('lifecycle_lock_schema is not the frozen cf50 shape');
  const pid = record['lifecycle_pid'];
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) fail('lifecycle_pid must be a positive safe integer');
  const admission = record['admission_upgrade'] === undefined
    ? undefined
    : parseCoordinatorAdmissionOffer(record['admission_upgrade'], identity.admissionIdentity.wireLineage);
  const result = {
    schema_version: 'autopilot.coordinator_handshake.v1',
    package_build: identity.legacyFacadeBuild,
    protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
    database_schema_version: identity.apiSchemaVersion,
    lifecycle_lock_schema: 'autopilot.coordinator_lock.v2',
    lifecycle_pid: pid,
    lifecycle_boot_id: bounded(record['lifecycle_boot_id'], 'lifecycle_boot_id'),
    lifecycle_process_start_identity: bounded(record['lifecycle_process_start_identity'], 'lifecycle_process_start_identity'),
    lifecycle_instance_id: bounded(record['lifecycle_instance_id'], 'lifecycle_instance_id'),
    lifecycle_started_at: bounded(record['lifecycle_started_at'], 'lifecycle_started_at'),
  } as const;
  return admission === undefined ? Object.freeze(result) : Object.freeze({ ...result, admission_upgrade: admission });
}

/** Absence means only the single digest-pinned cf50 predecessor, never semver. */
export function classifyCoordinatorInitialPeer(value: unknown, identity: CoordinatorLegacyFacadeIdentity): CoordinatorInitialPeerClassification {
  const handshake = parseCoordinatorLegacyFacadeHandshake(value, identity);
  if (handshake.admission_upgrade === undefined) return Object.freeze({ kind: 'known-cf50-predecessor', handshake });
  return Object.freeze({ kind: 's1-admission-offered', handshake, offer: handshake.admission_upgrade });
}
