import { canonicalJson } from "./canonical-json.js";
import { parseD65HeartbeatAcceptanceResult, } from "./d65-launch-policy.js";
import { CoordinationRuntimeError } from "./failures.js";
export const D65_PAIRED_QUERY_MAX_ELAPSED_MS = 5_000;
function fail(issue, evidence = []) {
    throw new CoordinationRuntimeError('invalid-state', `D65 paired heartbeat gate fenced: ${issue}`, [...evidence]);
}
function exactHead(value) {
    try {
        return parseD65HeartbeatAcceptanceResult(value);
    }
    catch (error) {
        fail('endpoint accepted_program_heartbeat is malformed', [error instanceof Error ? error.message : String(error)]);
    }
}
/**
 * Verify fresh paired status then doctor. Doctor time is the sole governing
 * coordinator time. No local wall clock is read in this module.
 */
export function verifyD65PairedHeartbeatGate(input) {
    const statusTime = Date.parse(input.status.coordinator_time);
    const doctorTime = Date.parse(input.doctor.coordinator_time);
    if (!Number.isFinite(statusTime) || !Number.isFinite(doctorTime))
        fail('endpoint coordinator_time is invalid');
    if (statusTime > doctorTime)
        fail('status coordinator_time is after doctor coordinator_time');
    if (doctorTime - statusTime > D65_PAIRED_QUERY_MAX_ELAPSED_MS)
        fail('status/doctor pair exceeds five coordinator seconds', [String(doctorTime - statusTime)]);
    if (canonicalJson(input.status.boundary) !== canonicalJson(input.doctor.boundary))
        fail('graph/policy/head/session semantic boundary changed between status and doctor');
    const statusHead = exactHead(input.status.accepted_program_heartbeat);
    const doctorHead = exactHead(input.doctor.accepted_program_heartbeat);
    if (canonicalJson(statusHead) !== canonicalJson(doctorHead))
        fail('durable accepted heartbeat head changed between status and doctor');
    if (statusHead.acceptance_kind !== 'governing')
        fail('accepted heartbeat head is catch-up and cannot govern');
    if (input.governingRow.status_sha256 !== input.status.semantic_snapshot_sha256 || input.governingRow.doctor_sha256 !== input.doctor.semantic_snapshot_sha256)
        fail('status/doctor semantic digests do not equal the governing signed row');
    if (input.status.boundary.heartbeat_sequence !== statusHead.sequence || input.status.boundary.heartbeat_sha256 !== statusHead.heartbeat_sha256)
        fail('paired boundary does not name the durable heartbeat head');
    if (input.governingRow.accepted_graph_sequence !== input.status.boundary.graph_sequence || input.governingRow.accepted_graph_sha256 !== input.status.boundary.graph_sha256 || input.governingRow.launch_policy_sha256 !== input.status.boundary.policy_sha256 || input.governingRow.coordinator_session_lease_id !== input.status.boundary.session_lease_id)
        fail('signed heartbeat row does not equal paired graph/policy/session authority');
    if (Date.parse(statusHead.issued_at) > doctorTime || doctorTime >= Date.parse(statusHead.valid_until))
        fail('governing heartbeat is future or expired at doctor coordinator_time');
    if (input.highWater.program_id !== statusHead.program_id || input.highWater.repo_id !== statusHead.repo_id || input.highWater.workstream_run !== statusHead.workstream_run || input.highWater.sequence !== statusHead.sequence || input.highWater.heartbeat_sha256 !== statusHead.heartbeat_sha256 || input.highWater.updated_at !== statusHead.coordinator_time)
        fail('high-water cache is older, newer, or divergent from durable coordinator authority');
    return Object.freeze({ coordinator_time: input.doctor.coordinator_time, head: statusHead });
}
