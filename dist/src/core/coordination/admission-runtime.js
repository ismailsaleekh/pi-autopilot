import { readFile } from 'node:fs/promises';
import { sha256CoordinatorAuthorityBytes } from "./admission.js";
import { CoordinationRuntimeError } from "./failures.js";
import { isExactProcessAlive } from "./process-identity.js";
import { readAndVerifyCoordinatorRuntimeIdentity } from "./runtime-identity.js";
import { COORDINATOR_API_SCHEMA_VERSION, COORDINATOR_IMPLEMENTATION_BUILD, COORDINATOR_LEGACY_FACADE_BUILD, COORDINATOR_STORE_SCHEMA_VERSION, COORDINATOR_WIRE_LINEAGE, } from "./runtime-paths.js";
import { assertCurrentStoreGenerationAuthority, readCurrentStoreAdmissionGeneration, readCurrentStoreGeneration } from "./store-generation.js";
import { assertPrivatePathNoAliases } from "../private-path.js";
import { parseCurrentCoordinatorLock } from "./upgrade-contracts.js";
export const COORDINATOR_S1_ADMISSION_IDENTITY = Object.freeze({
    implementationBuild: COORDINATOR_IMPLEMENTATION_BUILD,
    wireLineage: COORDINATOR_WIRE_LINEAGE,
    apiSchemaVersion: COORDINATOR_API_SCHEMA_VERSION,
    storeSchemaVersion: COORDINATOR_STORE_SCHEMA_VERSION,
    knownClientBuilds: Object.freeze([COORDINATOR_IMPLEMENTATION_BUILD]),
});
function sameRuntimeLifecycle(left, right) {
    return left.pid === right.pid
        && left.boot_id === right.boot_id
        && left.process_start_identity === right.process_start_identity
        && left.instance_id === right.instance_id;
}
function sameExactLifecycle(left, right) {
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
function parseLegacyLockBytes(bytes) {
    let value;
    try {
        value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    }
    catch {
        throw new CoordinationRuntimeError('protocol-mismatch', 'legacy façade lifecycle lock is not valid JSON');
    }
    const lock = parseCurrentCoordinatorLock(value);
    if (lock === null)
        throw new CoordinationRuntimeError('protocol-mismatch', 'legacy façade lifecycle lock is not the exact closed cf50 shape');
    if (lock.package_build !== COORDINATOR_LEGACY_FACADE_BUILD
        || lock.protocol_version !== '1.6'
        || lock.database_schema_version !== COORDINATOR_API_SCHEMA_VERSION) {
        throw new CoordinationRuntimeError('protocol-mismatch', 'legacy façade lifecycle lock identity drifted');
    }
    return lock;
}
function assertRuntimeIdentity(runtime, lifecycle, generation) {
    if (!sameRuntimeLifecycle(lifecycle, {
        pid: runtime.identity.lifecycle_pid,
        boot_id: runtime.identity.lifecycle_boot_id,
        process_start_identity: runtime.identity.lifecycle_process_start_identity,
        instance_id: runtime.identity.lifecycle_instance_id,
    }))
        throw new CoordinationRuntimeError('coordinator-unavailable', 'runtime identity lifecycle disagrees with the legacy façade lock');
    if (runtime.identity.implementation_build !== COORDINATOR_IMPLEMENTATION_BUILD
        || runtime.identity.wire_lineage !== COORDINATOR_WIRE_LINEAGE
        || runtime.identity.api_schema_version !== COORDINATOR_API_SCHEMA_VERSION
        || runtime.identity.store_schema_version !== COORDINATOR_STORE_SCHEMA_VERSION
        || runtime.identity.legacy_facade_build !== COORDINATOR_LEGACY_FACADE_BUILD
        || runtime.identity.store_generation_id !== generation.pointer.generation_id) {
        throw new CoordinationRuntimeError('protocol-mismatch', 'runtime identity does not match the frozen S1 identity split');
    }
}
async function readVerifiedS1Authority(input) {
    assertPrivatePathNoAliases(input.paths.lockPath);
    const legacyLockBytes = await readFile(input.paths.lockPath);
    const lifecycle = parseLegacyLockBytes(legacyLockBytes);
    if (!sameExactLifecycle(lifecycle, input.expectedLifecycle))
        throw new CoordinationRuntimeError('coordinator-unavailable', 'legacy façade lock changed from the serving lifecycle');
    const generation = input.verifyPhysicalStore
        ? readCurrentStoreGeneration(input.paths)
        : input.expectedGeneration === undefined
            ? readCurrentStoreAdmissionGeneration(input.paths)
            : assertCurrentStoreGenerationAuthority(input.paths, input.expectedGeneration);
    if (generation === null)
        throw new CoordinationRuntimeError('store-corrupt', 'S1 authority has no current store generation');
    const runtime = readAndVerifyCoordinatorRuntimeIdentity(input.paths, generation, lifecycle);
    assertRuntimeIdentity(runtime, lifecycle, generation);
    return Object.freeze({ lifecycle, legacyLockBytes, generation, runtime });
}
/** Verifies dead-or-live S1 disk identity without granting socket admission authority. */
export async function verifyCoordinatorS1RecoveryAuthority(input) {
    await readVerifiedS1Authority({ ...input, verifyPhysicalStore: true });
}
function admissionAuthoritySnapshot(verified) {
    const { lifecycle, legacyLockBytes, generation, runtime } = verified;
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
/** Initial client-side capture verifies the exact OS process-birth identity. */
export async function captureCoordinatorAdmissionAuthority(input) {
    const verified = await readVerifiedS1Authority({ ...input, verifyPhysicalStore: false });
    if (!isExactProcessAlive(verified.lifecycle.pid, verified.lifecycle.process_start_identity))
        throw new CoordinationRuntimeError('coordinator-unavailable', 'legacy façade lifecycle does not identify the exact live process', [`pid=${String(verified.lifecycle.pid)}`]);
    return admissionAuthoritySnapshot(verified);
}
/** Same-socket recapture: the kernel-bound socket already proved liveness. */
export async function recaptureCoordinatorAdmissionAuthority(input) {
    return admissionAuthoritySnapshot(await readVerifiedS1Authority({ ...input, verifyPhysicalStore: false }));
}
/** Server-side capture proves the serving lifecycle is this executing process. */
export async function captureServingCoordinatorAdmissionAuthority(input) {
    if (input.expectedLifecycle.pid !== process.pid)
        throw new CoordinationRuntimeError('system-fatal', 'serving admission lifecycle does not belong to this coordinator process');
    return admissionAuthoritySnapshot(await readVerifiedS1Authority({ ...input, verifyPhysicalStore: false }));
}
export function assertCoordinatorAdmissionAuthorityUnchanged(expected, observed) {
    if (expected.legacyLockSha256 !== observed.legacyLockSha256
        || expected.runtimeIdentitySha256 !== observed.runtimeIdentitySha256
        || expected.generation.pointer.generation_id !== observed.generation.pointer.generation_id
        || expected.generation.pointer_sha256 !== observed.generation.pointer_sha256
        || expected.generation.database_file_identity.device !== observed.generation.database_file_identity.device
        || expected.generation.database_file_identity.inode !== observed.generation.database_file_identity.inode
        || !sameExactLifecycle(expected.lifecycle, observed.lifecycle)) {
        throw new CoordinationRuntimeError('coordinator-unavailable', 'coordinator admission authority changed between socket phases');
    }
}
