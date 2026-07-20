import {
  D65_ATTACH_RUN_RESULT_V2_SCHEMA,
  D65_AUTHORITY_SHARD_SCHEMA,
  D65_BOOTSTRAP_SCHEMA,
  D65_COMPLETE_GRAPH_SCHEMA,
  D65_GRAPH_PUBLICATION_SCHEMA,
  D65_PROJECTION_SHARD_SCHEMA,
  D65_TERMINAL_INTENT_V2_SCHEMA,
  parseD65AttachRunResultV2,
  parseD65AuthorityShard,
  parseD65CompleteGraph,
  parseD65GraphPublication,
  parseD65ProjectionShard,
  parseD65RunTerminalIntentV2,
  parseD65SemanticGraphBootstrap,
} from './d65-semantic-graph.ts';
import {
  D65_CAPACITY_DECISION_SCHEMA,
  D65_HEARTBEAT_ACCEPTANCE_RESULT_SCHEMA,
  D65_HEARTBEAT_HIGH_WATER_SCHEMA,
  D65_LAUNCH_POLICY_SCHEMA,
  D65_PROGRAM_HEARTBEAT_SCHEMA,
  D65_SUBSCRIPTION_PROBE_SCHEMA,
  parseD65CapacityDecision,
  parseD65HeartbeatAcceptanceResult,
  parseD65HeartbeatHighWater,
  parseD65LaunchPolicy,
  parseD65ProgramHeartbeat,
  parseD65SubscriptionProbe,
} from './d65-launch-policy.ts';

// D65-A1/A2/A3/A4 source/dist contract manifest (freeze §9.2/§9.5). Every D65
// package schema is closed, versioned, size-bounded, parsed at the lowest
// layer, and MUST appear identically in source and dist. This manifest is the
// single authoritative enumeration; the parity test proves the compiled dist
// module exposes exactly the same closed set so no contract silently drifts.

/** The two ownership classes for D65 package schemas (freeze §9.2). */
export type D65SchemaOwner = 'graph-store-consumer' | 'cap-one-consumer';

export interface D65ContractManifestEntry {
  readonly schema_version: string;
  readonly owner: D65SchemaOwner;
  readonly parse: (value: unknown) => unknown;
}

/**
 * The closed, schema-version-sorted set of D65 package contracts. The binary
 * `autopilot.operator_trust_anchor.v1` trust anchor is the one explicitly
 * frozen binary contract (parsed by d65-trust) and is intentionally not a JSON
 * schema in this manifest. `autopilot.reservation_obligation.v1` remains the
 * existing coordination schema embedded by run_terminal_intent.v2.
 */
export const D65_CONTRACT_MANIFEST: readonly D65ContractManifestEntry[] = Object.freeze(
  ([
    { schema_version: D65_ATTACH_RUN_RESULT_V2_SCHEMA, owner: 'graph-store-consumer', parse: parseD65AttachRunResultV2 },
    { schema_version: D65_BOOTSTRAP_SCHEMA, owner: 'graph-store-consumer', parse: parseD65SemanticGraphBootstrap },
    { schema_version: D65_COMPLETE_GRAPH_SCHEMA, owner: 'graph-store-consumer', parse: parseD65CompleteGraph },
    { schema_version: D65_AUTHORITY_SHARD_SCHEMA, owner: 'graph-store-consumer', parse: parseD65AuthorityShard },
    { schema_version: D65_PROJECTION_SHARD_SCHEMA, owner: 'graph-store-consumer', parse: parseD65ProjectionShard },
    { schema_version: D65_TERMINAL_INTENT_V2_SCHEMA, owner: 'graph-store-consumer', parse: parseD65RunTerminalIntentV2 },
    { schema_version: D65_GRAPH_PUBLICATION_SCHEMA, owner: 'graph-store-consumer', parse: parseD65GraphPublication },
    { schema_version: D65_LAUNCH_POLICY_SCHEMA, owner: 'cap-one-consumer', parse: parseD65LaunchPolicy },
    { schema_version: D65_CAPACITY_DECISION_SCHEMA, owner: 'cap-one-consumer', parse: parseD65CapacityDecision },
    { schema_version: D65_SUBSCRIPTION_PROBE_SCHEMA, owner: 'cap-one-consumer', parse: parseD65SubscriptionProbe },
    { schema_version: D65_PROGRAM_HEARTBEAT_SCHEMA, owner: 'cap-one-consumer', parse: parseD65ProgramHeartbeat },
    { schema_version: D65_HEARTBEAT_ACCEPTANCE_RESULT_SCHEMA, owner: 'cap-one-consumer', parse: parseD65HeartbeatAcceptanceResult },
    { schema_version: D65_HEARTBEAT_HIGH_WATER_SCHEMA, owner: 'cap-one-consumer', parse: parseD65HeartbeatHighWater },
  ] as const)
    .map((entry) => Object.freeze(entry))
    .sort((left, right) => (left.schema_version < right.schema_version ? -1 : left.schema_version > right.schema_version ? 1 : 0)),
);

/** The one explicitly frozen binary contract (parsed by d65-trust). */
export const D65_BINARY_TRUST_ANCHOR_SCHEMA = 'autopilot.operator_trust_anchor.v1' as const;

/** The closed, sorted list of D65 JSON schema versions for parity checks. */
export const D65_CONTRACT_SCHEMA_VERSIONS: readonly string[] = Object.freeze(
  D65_CONTRACT_MANIFEST.map((entry) => entry.schema_version),
);

/** Resolve the lowest-layer parser for a D65 schema version, or throw. */
export function d65ParserFor(schemaVersion: string): (value: unknown) => unknown {
  const entry = D65_CONTRACT_MANIFEST.find((candidate) => candidate.schema_version === schemaVersion);
  if (entry === undefined) throw new Error(`no D65 contract parser is registered for ${schemaVersion}`);
  return entry.parse;
}
