import { COORDINATOR_DATABASE_SCHEMA_VERSION, COORDINATOR_PACKAGE_BUILD } from './runtime-constants.ts';
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION } from './types.ts';

export const CURRENT_COORDINATOR_LIFECYCLE_LOCK_SCHEMA = 'autopilot.coordinator_lock.v2' as const;

/**
 * Closed, audited build lineage for the protocol-1.4/schema-10 observation/edit
 * contract. Entries are admitted only after the request/response contracts,
 * transport, mutation vocabulary, and persisted entity projections have been
 * compared byte-for-byte or behaviorally certified against the target.
 *
 * This is deliberately not semver inference: an unlisted build remains
 * incompatible even when it claims the same protocol and database schema.
 */
export const COORDINATOR_WIRE_COMPATIBILITY_MATRIX = Object.freeze([
  Object.freeze({ package_build: '1.1.0-cf41', protocol_version: '1.4', database_schema_version: 10, lifecycle_lock_schema: CURRENT_COORDINATOR_LIFECYCLE_LOCK_SCHEMA }),
] as const);

export type KnownCoordinatorPackageBuild = (typeof COORDINATOR_WIRE_COMPATIBILITY_MATRIX)[number]['package_build'];
export type CoordinatorCompatibilityKind = 'exact-target' | 'wire-compatible-known' | 'incompatible';

export type CoordinatorRuntimeCompatibility =
  | {
      readonly kind: 'exact-target' | 'wire-compatible-known';
      readonly package_build: KnownCoordinatorPackageBuild;
      readonly protocol_version: typeof AUTOPILOT_COORDINATOR_PROTOCOL_VERSION;
      readonly database_schema_version: typeof COORDINATOR_DATABASE_SCHEMA_VERSION;
      readonly lifecycle_lock_schema: typeof CURRENT_COORDINATOR_LIFECYCLE_LOCK_SCHEMA;
    }
  | {
      readonly kind: 'incompatible';
      readonly reason: 'malformed-identity' | 'unknown-build' | 'protocol-mismatch' | 'schema-mismatch';
      readonly package_build: string | null;
    };

export interface CoordinatorRuntimeIdentityInput {
  readonly package_build: unknown;
  readonly protocol_version: unknown;
  readonly database_schema_version: unknown;
}

export function classifyCoordinatorRuntimeIdentity(input: CoordinatorRuntimeIdentityInput): CoordinatorRuntimeCompatibility {
  const packageBuild = typeof input.package_build === 'string' && input.package_build.length > 0 ? input.package_build : null;
  if (packageBuild === null || typeof input.protocol_version !== 'string' || typeof input.database_schema_version !== 'number' || !Number.isSafeInteger(input.database_schema_version)) {
    return { kind: 'incompatible', reason: 'malformed-identity', package_build: packageBuild };
  }
  const descriptor = COORDINATOR_WIRE_COMPATIBILITY_MATRIX.find((candidate) => candidate.package_build === packageBuild);
  if (descriptor === undefined) return { kind: 'incompatible', reason: 'unknown-build', package_build: packageBuild };
  if (input.protocol_version !== descriptor.protocol_version) return { kind: 'incompatible', reason: 'protocol-mismatch', package_build: descriptor.package_build };
  if (input.database_schema_version !== descriptor.database_schema_version) return { kind: 'incompatible', reason: 'schema-mismatch', package_build: descriptor.package_build };
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
if (target.kind !== 'exact-target') throw new Error(`current coordinator build ${COORDINATOR_PACKAGE_BUILD} is absent from its closed compatibility matrix`);
