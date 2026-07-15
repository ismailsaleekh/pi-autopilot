import { COORDINATOR_DATABASE_SCHEMA_VERSION, COORDINATOR_PACKAGE_BUILD } from "./runtime-constants.js";
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION } from "./types.js";
export const CURRENT_COORDINATOR_LIFECYCLE_LOCK_SCHEMA = 'autopilot.coordinator_lock.v2';
/**
 * Closed, audited build lineage for the protocol-1.6/schema-12 byte-bounded
 * reconciliation and mailbox contract. Entries are admitted only after the request/response contracts,
 * transport, mutation vocabulary, and persisted entity projections have been
 * compared byte-for-byte or behaviorally certified against the target. cf46
 * adds endpoint-first startup attestation, exact socketless-owner recovery,
 * phase-accurate owned-saga recovery, transactional semantic worktree-projection
 * reconciliation, and one opaque tool-call-id runtime/schema contract. The additive
 * lifecycle handshake evidence does not change mutation vocabulary or persisted
 * entity contracts. cf45 is admitted only after the explicit predecessor,
 * response-loss, migration, and packed-payload certification for this release.
 *
 * This is deliberately not semver inference: an unlisted build remains
 * incompatible even when it claims the same protocol and database schema.
 */
export const COORDINATOR_WIRE_COMPATIBILITY_MATRIX = Object.freeze([
    Object.freeze({ package_build: '1.1.4-cf46', protocol_version: '1.6', database_schema_version: 12, lifecycle_lock_schema: CURRENT_COORDINATOR_LIFECYCLE_LOCK_SCHEMA }),
    Object.freeze({ package_build: '1.1.3-cf45', protocol_version: '1.6', database_schema_version: 12, lifecycle_lock_schema: CURRENT_COORDINATOR_LIFECYCLE_LOCK_SCHEMA }),
    Object.freeze({ package_build: '1.1.2-cf44', protocol_version: '1.6', database_schema_version: 12, lifecycle_lock_schema: CURRENT_COORDINATOR_LIFECYCLE_LOCK_SCHEMA }),
    Object.freeze({ package_build: '1.1.1-cf43', protocol_version: '1.6', database_schema_version: 12, lifecycle_lock_schema: CURRENT_COORDINATOR_LIFECYCLE_LOCK_SCHEMA }),
]);
export function classifyCoordinatorRuntimeIdentity(input) {
    const packageBuild = typeof input.package_build === 'string' && input.package_build.length > 0 ? input.package_build : null;
    if (packageBuild === null || typeof input.protocol_version !== 'string' || typeof input.database_schema_version !== 'number' || !Number.isSafeInteger(input.database_schema_version)) {
        return { kind: 'incompatible', reason: 'malformed-identity', package_build: packageBuild };
    }
    const descriptor = COORDINATOR_WIRE_COMPATIBILITY_MATRIX.find((candidate) => candidate.package_build === packageBuild);
    if (descriptor === undefined)
        return { kind: 'incompatible', reason: 'unknown-build', package_build: packageBuild };
    if (input.protocol_version !== descriptor.protocol_version)
        return { kind: 'incompatible', reason: 'protocol-mismatch', package_build: descriptor.package_build };
    if (input.database_schema_version !== descriptor.database_schema_version)
        return { kind: 'incompatible', reason: 'schema-mismatch', package_build: descriptor.package_build };
    return {
        kind: descriptor.package_build === COORDINATOR_PACKAGE_BUILD ? 'exact-target' : 'wire-compatible-known',
        package_build: descriptor.package_build,
        protocol_version: descriptor.protocol_version,
        database_schema_version: descriptor.database_schema_version,
        lifecycle_lock_schema: descriptor.lifecycle_lock_schema,
    };
}
// Module-load assertions make an accidental target/matrix divergence fail at
// startup rather than silently demoting the package's own broker identity.
const target = classifyCoordinatorRuntimeIdentity({
    package_build: COORDINATOR_PACKAGE_BUILD,
    protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
    database_schema_version: COORDINATOR_DATABASE_SCHEMA_VERSION,
});
if (target.kind !== 'exact-target')
    throw new Error(`current coordinator build ${COORDINATOR_PACKAGE_BUILD} is absent from its closed compatibility matrix`);
