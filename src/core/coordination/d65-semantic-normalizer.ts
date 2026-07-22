import { canonicalSha256, type JsonObject } from './d65-semantic-graph.ts';
import { CoordinationRuntimeError } from './failures.ts';

// D65-A4 shared semantic normalizer. Status, doctor, graph liveness, and the
// terminal-tail verifier all hash semantic endpoint projections through this
// module. Callers must first replace raw session/child lease rows with the exact
// semantic projections and rewind pure liveness event-sequence contribution.
// This module performs no I/O, time sampling, Git, or store reads.

export type D65SemanticEndpoint = 'status' | 'doctor';

/** Exact fields that are not part of a complete endpoint semantic projection. */
export const D65_SEMANTIC_SNAPSHOT_EXCLUSIONS = Object.freeze([
  // response/request identities
  'request_id',
  'response_id',
  // page envelope fields (never endpoint fields)
  'projection_schema_version',
  'section',
  'scan_token',
  'section_counts',
  'cursor',
  'next_cursor',
  'count',
  'items',
  // the three A4 fields
  'coordinator_time',
  'semantic_snapshot_sha256',
  'accepted_program_heartbeat',
] as const);

const PAGE_SCHEMAS = new Set([
  'autopilot.coordinator_status_page.v1',
  'autopilot.coordinator_doctor_page.v1',
]);
const EXCLUDED = new Set<string>(D65_SEMANTIC_SNAPSHOT_EXCLUSIONS);

function fail(issue: string): never {
  throw new CoordinationRuntimeError('invalid-state', `D65 semantic snapshot input is invalid: ${issue}`);
}

/**
 * Accept only a complete unpaginated endpoint projection. A page envelope is
 * necessarily partial (even a summary page), so unwrapping it would create a
 * fake authenticated digest and is rejected fail-closed.
 */
function endpointObject(endpoint: D65SemanticEndpoint, value: Readonly<Record<string, unknown>>): JsonObject {
  const schema = value['schema_version'];
  if (typeof schema === 'string' && PAGE_SCHEMAS.has(schema)) fail(`${endpoint} page envelope is partial and cannot be semantic digest authority`);
  const expectedSchema = endpoint === 'status' ? 'autopilot.coordinator_status.v1' : 'autopilot.coordinator_doctor.v1';
  if (schema !== expectedSchema) fail(`${endpoint} endpoint schema_version must be retained and equal ${expectedSchema}`);
  return value;
}

/**
 * Return the exact RFC-8785 input. Only top-level request/response/page/A4 fields
 * and doctor's query-only observed_at are removed; every other endpoint byte,
 * including endpoint schema_version and negotiated observability, is retained.
 */
export function d65SemanticSnapshotInput(endpoint: D65SemanticEndpoint, value: Readonly<Record<string, unknown>>): JsonObject {
  const projection = endpointObject(endpoint, value);
  const retained: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(projection)) {
    if (EXCLUDED.has(key)) continue;
    if (endpoint === 'doctor' && key === 'observed_at') continue;
    retained[key] = fieldValue;
  }
  if (retained['schema_version'] !== (endpoint === 'status' ? 'autopilot.coordinator_status.v1' : 'autopilot.coordinator_doctor.v1')) fail(`${endpoint} endpoint schema_version was lost or changed during normalization`);
  return Object.freeze(retained);
}

/** RFC-8785 canonical JSON plus LF SHA-256 of one complete semantic endpoint. */
export function computeD65SemanticSnapshotSha256(endpoint: D65SemanticEndpoint, value: Readonly<Record<string, unknown>>): `sha256:${string}` {
  return canonicalSha256(d65SemanticSnapshotInput(endpoint, value));
}
