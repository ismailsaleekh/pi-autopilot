export const COORDINATOR_IMPLEMENTATION_BUILD = '1.2.0-s1' as const;
/** Physical npm package identity; never derive this from the legacy wire façade. */
export const COORDINATOR_PACKAGE_VERSION = '1.2.0' as const;
export const COORDINATOR_LEGACY_FACADE_BUILD = '1.1.8-cf50' as const;
export const COORDINATOR_WIRE_LINEAGE = 'protocol-1.6-api-schema-12' as const;
export const COORDINATOR_API_SCHEMA_VERSION = 12 as const;
export const COORDINATOR_STORE_SCHEMA_VERSION = 13 as const;
/** Legacy cf50 grammar only. Private physical persistence uses store schema 13. */
export const COORDINATOR_DATABASE_SCHEMA_VERSION = 12 as const;
/** Legacy façade value retained independently from truthful implementation identity. */
export const COORDINATOR_PACKAGE_BUILD = '1.1.8-cf50' as const;
export const COORDINATOR_MAX_FRAME_BYTES = 1_048_576;
export const COORDINATOR_BUSY_TIMEOUT_MS = 5_000;
export const COORDINATOR_SESSION_LEASE_MS = 30_000;
export const COORDINATOR_HEARTBEAT_MS = 10_000;
export const COORDINATOR_GRANT_OFFER_TTL_MS = 30_000;
export const COORDINATOR_GRANT_OFFER_SWEEP_MS = 1_000;
