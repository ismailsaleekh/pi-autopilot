import { canonicalSha256 } from "./d65-semantic-graph.js";
import { CoordinationRuntimeError } from "./failures.js";
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
]);
const PAGE_SCHEMAS = new Set([
    'autopilot.coordinator_status_page.v1',
    'autopilot.coordinator_doctor_page.v1',
]);
const EXCLUDED = new Set(D65_SEMANTIC_SNAPSHOT_EXCLUSIONS);
function fail(issue) {
    throw new CoordinationRuntimeError('invalid-state', `D65 semantic snapshot input is invalid: ${issue}`);
}
/**
 * Accept only a complete unpaginated endpoint projection. A page envelope is
 * necessarily partial (even a summary page), so unwrapping it would create a
 * fake authenticated digest and is rejected fail-closed.
 */
function endpointObject(endpoint, value) {
    const schema = value['schema_version'];
    if (typeof schema === 'string' && PAGE_SCHEMAS.has(schema))
        fail(`${endpoint} page envelope is partial and cannot be semantic digest authority`);
    const expectedSchema = endpoint === 'status' ? 'autopilot.coordinator_status.v1' : 'autopilot.coordinator_doctor.v1';
    if (schema !== expectedSchema)
        fail(`${endpoint} endpoint schema_version must be retained and equal ${expectedSchema}`);
    return value;
}
/**
 * Return the exact RFC-8785 input. Only top-level request/response/page/A4 fields
 * and doctor's query-only observed_at are removed; every other endpoint byte,
 * including endpoint schema_version and negotiated observability, is retained.
 */
export function d65SemanticSnapshotInput(endpoint, value) {
    const projection = endpointObject(endpoint, value);
    const retained = {};
    for (const [key, fieldValue] of Object.entries(projection)) {
        if (EXCLUDED.has(key))
            continue;
        if (endpoint === 'doctor' && key === 'observed_at')
            continue;
        retained[key] = fieldValue;
    }
    if (retained['schema_version'] !== (endpoint === 'status' ? 'autopilot.coordinator_status.v1' : 'autopilot.coordinator_doctor.v1'))
        fail(`${endpoint} endpoint schema_version was lost or changed during normalization`);
    return Object.freeze(retained);
}
/** RFC-8785 canonical JSON plus LF SHA-256 of one complete semantic endpoint. */
export function computeD65SemanticSnapshotSha256(endpoint, value) {
    return canonicalSha256(d65SemanticSnapshotInput(endpoint, value));
}
