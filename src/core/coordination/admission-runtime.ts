import { readFile } from 'node:fs/promises';

import { type CoordinatorAdmissionEndpointFacts, type CoordinatorAdmissionIdentity, sha256CoordinatorAuthorityBytes } from './admission.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { isExactProcessAlive } from './process-identity.ts';
import { readAndVerifyCoordinatorRuntimeIdentity, type CoordinatorRuntimeIdentity, type PublishedRuntimeIdentity, type RuntimeLifecycleIdentity } from './runtime-identity.ts';
import {
  COORDINATOR_API_SCHEMA_VERSION,
  COORDINATOR_IMPLEMENTATION_BUILD,
  COORDINATOR_LEGACY_FACADE_BUILD,
  COORDINATOR_STORE_SCHEMA_VERSION,
  COORDINATOR_WIRE_LINEAGE,
  type CoordinatorRuntimePaths,
} from './runtime-paths.ts';
import { readCurrentStoreGeneration, type CurrentStoreGeneration } from './store-generation.ts';
import { assertPrivatePathNoAliases } from '../private-path.ts';
import { parseCurrentCoordinatorLock, type CurrentCoordinatorLock } from './upgrade-contracts.ts';

export const COORDINATOR_S1_ADMISSION_IDENTITY: CoordinatorAdmissionIdentity = Object.freeze({
  implementationBuild: COORDINATOR_IMPLEMENTATION_BUILD,
  wireLineage: COORDINATOR_WIRE_LINEAGE,
  apiSchemaVersion: COORDINATOR_API_SCHEMA_VERSION,
  storeSchemaVersion: COORDINATOR_STORE_SCHEMA_VERSION,
  knownClientBuilds: Object.freeze([COORDINATOR_IMPLEMENTATION_BUILD]),
});

export interface CoordinatorAdmissionAuthoritySnapshot {
  readonly lifecycle: CurrentCoordinatorLock;
  readonly runtimeIdentity: CoordinatorRuntimeIdentity;
  readonly runtimeIdentityBytes: Uint8Array;
  readonly runtimeIdentitySha256: `sha256:${string}`;
  readonly legacyLockBytes: Uint8Array;
  readonly legacyLockSha256: `sha256:${string}`;
  readonly generation: CurrentStoreGeneration;
  readonly endpoint: CoordinatorAdmissionEndpointFacts;
}

function sameRuntimeLifecycle(left: CurrentCoordinatorLock, right: RuntimeLifecycleIdentity): boolean {
  return left.pid === right.pid
    && left.boot_id === right.boot_id
    && left.process_start_identity === right.process_start_identity
    && left.instance_id === right.instance_id;
}

function sameExactLifecycle(left: CurrentCoordinatorLock, right: CurrentCoordinatorLock): boolean {
  return left.schema_version === right.schema_version
    && left.pid === right.pid
    && left.boot_id === right.boot_id
    && left.process_start_identity === right.process_start_identity
    && left.token === right.token
    && left.instance_id === right.instance_id
    && left.package_build === right.package_build
    && left.protocol_version === right.protocol_version
    && left.database_schema_version === right.database_schema_version
    && left.started_at === right.started_at;
}

function parseLegacyLockBytes(bytes: Uint8Array): CurrentCoordinatorLock {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown; }
  catch { throw new CoordinationRuntimeError('protocol-mismatch', 'legacy façade lifecycle lock is not valid JSON'); }
  const lock = parseCurrentCoordinatorLock(value);
  if (lock === null) throw new CoordinationRuntimeError('protocol-mismatch', 'legacy façade lifecycle lock is not the exact closed cf50 shape');
  if (lock.package_build !== COORDINATOR_LEGACY_FACADE_BUILD
    || lock.protocol_version !== '1.6'
    || lock.database_schema_version !== COORDINATOR_API_SCHEMA_VERSION) {
    throw new CoordinationRuntimeError('protocol-mismatch', 'legacy façade lifecycle lock identity drifted');
  }
  return lock;
}

function assertRuntimeIdentity(runtime: PublishedRuntimeIdentity, lifecycle: CurrentCoordinatorLock, generation: CurrentStoreGeneration): void {
  if (!sameRuntimeLifecycle(lifecycle, {
    pid: runtime.identity.lifecycle_pid,
    boot_id: runtime.identity.lifecycle_boot_id,
    process_start_identity: runtime.identity.lifecycle_process_start_identity,
    instance_id: runtime.identity.lifecycle_instance_id,
  })) throw new CoordinationRuntimeError('coordinator-unavailable', 'runtime identity lifecycle disagrees with the legacy façade lock');
  if (runtime.identity.implementation_build !== COORDINATOR_IMPLEMENTATION_BUILD
    || runtime.identity.wire_lineage !== COORDINATOR_WIRE_LINEAGE
    || runtime.identity.api_schema_version !== COORDINATOR_API_SCHEMA_VERSION
    || runtime.identity.store_schema_version !== COORDINATOR_STORE_SCHEMA_VERSION
    || runtime.identity.legacy_facade_build !== COORDINATOR_LEGACY_FACADE_BUILD
    || runtime.identity.store_generation_id !== generation.pointer.generation_id) {
    throw new CoordinationRuntimeError('protocol-mismatch', 'runtime identity does not match the frozen S1 identity split');
  }
}

async function readVerifiedS1Authority(input: {
  readonly paths: CoordinatorRuntimePaths;
  readonly expectedLifecycle: CurrentCoordinatorLock;
  readonly expectedGeneration?: CurrentStoreGeneration;
}): Promise<{
  readonly lifecycle: CurrentCoordinatorLock;
  readonly legacyLockBytes: Uint8Array;
  readonly generation: CurrentStoreGeneration;
  readonly runtime: PublishedRuntimeIdentity;
}> {
  assertPrivatePathNoAliases(input.paths.lockPath);
  const legacyLockBytes = await readFile(input.paths.lockPath);
  const lifecycle = parseLegacyLockBytes(legacyLockBytes);
  if (!sameExactLifecycle(lifecycle, input.expectedLifecycle)) throw new CoordinationRuntimeError('coordinator-unavailable', 'legacy façade lock changed from the serving lifecycle');
  const generation = readCurrentStoreGeneration(input.paths);
  if (generation === null) throw new CoordinationRuntimeError('store-corrupt', 'S1 authority has no current store generation');
  if (input.expectedGeneration !== undefined
    && (generation.pointer.generation_id !== input.expectedGeneration.pointer.generation_id
      || generation.pointer_sha256 !== input.expectedGeneration.pointer_sha256)) {
    throw new CoordinationRuntimeError('store-corrupt', 'S1 authority store generation changed from the serving store');
  }
  const runtime = readAndVerifyCoordinatorRuntimeIdentity(input.paths, generation, lifecycle);
  assertRuntimeIdentity(runtime, lifecycle, generation);
  return Object.freeze({ lifecycle, legacyLockBytes, generation, runtime });
}

/** Verifies dead-or-live S1 disk identity without granting socket admission authority. */
export async function verifyCoordinatorS1RecoveryAuthority(input: {
  readonly paths: CoordinatorRuntimePaths;
  readonly expectedLifecycle: CurrentCoordinatorLock;
}): Promise<void> {
  await readVerifiedS1Authority(input);
}

export async function captureCoordinatorAdmissionAuthority(input: {
  readonly paths: CoordinatorRuntimePaths;
  readonly expectedLifecycle: CurrentCoordinatorLock;
  readonly expectedGeneration?: CurrentStoreGeneration;
}): Promise<CoordinatorAdmissionAuthoritySnapshot> {
  const verified = await readVerifiedS1Authority(input);
  const { lifecycle, legacyLockBytes, generation, runtime } = verified;
  if (!isExactProcessAlive(lifecycle.pid, lifecycle.process_start_identity)) throw new CoordinationRuntimeError('coordinator-unavailable', 'legacy façade lifecycle does not identify the exact live process', [`pid=${String(lifecycle.pid)}`]);
  const legacyLockSha256 = sha256CoordinatorAuthorityBytes(legacyLockBytes);
  return Object.freeze({
    lifecycle,
    runtimeIdentity: runtime.identity,
    runtimeIdentityBytes: runtime.bytes,
    runtimeIdentitySha256: runtime.sha256,
    legacyLockBytes,
    legacyLockSha256,
    generation,
    endpoint: Object.freeze({
      lifecycle_pid: lifecycle.pid,
      lifecycle_boot_id: lifecycle.boot_id,
      lifecycle_process_start_identity: lifecycle.process_start_identity,
      lifecycle_instance_id: lifecycle.instance_id,
      legacy_lock_sha256: legacyLockSha256,
      runtime_identity_sha256: runtime.sha256,
      store_generation_id: generation.pointer.generation_id,
    }),
  });
}

export function assertCoordinatorAdmissionAuthorityUnchanged(
  expected: CoordinatorAdmissionAuthoritySnapshot,
  observed: CoordinatorAdmissionAuthoritySnapshot,
): void {
  if (expected.legacyLockSha256 !== observed.legacyLockSha256
    || expected.runtimeIdentitySha256 !== observed.runtimeIdentitySha256
    || expected.generation.pointer.generation_id !== observed.generation.pointer.generation_id
    || expected.generation.pointer_sha256 !== observed.generation.pointer_sha256
    || !sameExactLifecycle(expected.lifecycle, observed.lifecycle)) {
    throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator admission authority changed between socket phases');
  }
}
