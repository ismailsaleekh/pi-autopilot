export const COORDINATOR_IMPLEMENTATION_BUILD = '1.2.0-s1';
/** Physical npm package identity; never derive this from the legacy wire façade. */
export const COORDINATOR_PACKAGE_VERSION = '1.3.0';
export const COORDINATOR_LEGACY_FACADE_BUILD = '1.1.8-cf50';
export const COORDINATOR_WIRE_LINEAGE = 'protocol-1.6-api-schema-12';
export const COORDINATOR_API_SCHEMA_VERSION = 12;
export const COORDINATOR_STORE_SCHEMA_VERSION = 13;
/** Legacy cf50 grammar only. Private physical persistence uses store schema 13. */
export const COORDINATOR_DATABASE_SCHEMA_VERSION = 12;
/** Legacy façade value retained independently from truthful implementation identity. */
export const COORDINATOR_PACKAGE_BUILD = '1.1.8-cf50';
export const COORDINATOR_MAX_FRAME_BYTES = 1_048_576;
export const COORDINATOR_BUSY_TIMEOUT_MS = 5_000;
export const COORDINATOR_SESSION_LEASE_MS = 30_000;
export const COORDINATOR_HEARTBEAT_MS = 10_000;
/**
 * The bootstrap-safe session lease for the D65 launch window. The single
 * bootstrap session drives attach → policy → heartbeat → the multi-minute
 * bootstrap-plan model turn → first complete graph, and it deliberately runs NO
 * periodic session heartbeat until graph sequence 2 is accepted (a `session-
 * heartbeat` event would break the frozen 9-event B→E charter and the R=E+1
 * publication rule). A longer bootstrap lease therefore keeps `lease_current`
 * true across the planning turn so first-graph registration's session gate holds;
 * the lease is only classification evidence (age never authorizes release), and
 * the ordinary 30s heartbeat cadence resumes after the bridge adopts the session.
 */
export const COORDINATOR_BOOTSTRAP_SESSION_LEASE_MS = 45 * 60_000;
export const COORDINATOR_GRANT_OFFER_TTL_MS = 30_000;
export const COORDINATOR_GRANT_OFFER_SWEEP_MS = 1_000;
