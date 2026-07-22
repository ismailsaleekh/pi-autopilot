import { D65_STOP_REASONS } from "./d65-launch-policy.js";
import { COORDINATION_RUN_STATUSES } from "./types.js";
import { CoordinationRuntimeError } from "./failures.js";
/** One transactionally consistent committed frame for one immediate boundary. */
export const D65_DISPATCH_AUTHORITY_ENVELOPE_SCHEMA = 'autopilot.d65_dispatch_authority_envelope.v1';
function fail(issue) {
    throw new CoordinationRuntimeError('invalid-state', `D65 dispatch authority envelope is malformed: ${issue}`);
}
function record(value, label, keys) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        fail(`${label} must be an object`);
    const item = value;
    const actual = Object.keys(item).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
        fail(`${label} fields are not exact`);
    return item;
}
function bool(item, key, label) {
    const value = item[key];
    if (typeof value !== 'boolean')
        fail(`${label}.${key} must be boolean`);
    return value;
}
export function parseD65DispatchAuthorityRequestContext(value) {
    const item = record(value, 'request_context', ['expected_version', 'session_generation', 'session_id', 'session_lease_id']);
    const expected = item['expected_version'];
    const generation = item['session_generation'];
    const sessionId = item['session_id'];
    const leaseId = item['session_lease_id'];
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1 || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1)
        fail('request_context version/generation must be positive safe integers');
    if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 192 || typeof leaseId !== 'string' || leaseId.length < 1 || leaseId.length > 192)
        fail('request_context session identities must be bounded strings');
    return Object.freeze({ expected_version: expected, session_generation: generation, session_id: sessionId, session_lease_id: leaseId });
}
function reasons(value, label) {
    if (!Array.isArray(value))
        fail(`${label} must be an array`);
    const out = [];
    for (const entry of value) {
        if (typeof entry !== 'string' || !D65_STOP_REASONS.includes(entry))
            fail(`${label} contains an unknown reason`);
        out.push(entry);
    }
    for (let index = 1; index < out.length; index += 1)
        if (!((out[index - 1] ?? '') < (out[index] ?? '')))
            fail(`${label} must be decoded-byte-sorted unique`);
    return Object.freeze(out);
}
export function parseD65DispatchAuthorityEnvelope(value) {
    const envelope = record(value, 'envelope', ['dispatch_authority_frame', 'schema_version']);
    if (envelope['schema_version'] !== D65_DISPATCH_AUTHORITY_ENVELOPE_SCHEMA)
        fail('schema_version is invalid');
    const frame = record(envelope['dispatch_authority_frame'], 'frame', ['global_stop_reasons', 'graph', 'heartbeat', 'policy', 'row_stop_reasons', 'run_state', 'session']);
    const graph = record(frame['graph'], 'frame.graph', ['complete_graph_current', 'graph_publication_pending']);
    const policy = record(frame['policy'], 'frame.policy', ['policy_current']);
    const heartbeat = record(frame['heartbeat'], 'frame.heartbeat', ['governing_heartbeat_current', 'provider_state']);
    const session = record(frame['session'], 'frame.session', ['attached_session_current', 'cap_current', 'expected_version_current', 'lease_current']);
    const runState = frame['run_state'];
    if (typeof runState !== 'string' || !COORDINATION_RUN_STATUSES.includes(runState))
        fail('frame.run_state is invalid');
    const provider = heartbeat['provider_state'];
    if (provider !== 'healthy' && provider !== 'blocked' && provider !== 'retry-authorized' && provider !== 'exhausted')
        fail('frame.heartbeat.provider_state is invalid');
    return Object.freeze({
        global_stop_reasons: reasons(frame['global_stop_reasons'], 'frame.global_stop_reasons'),
        row_stop_reasons: reasons(frame['row_stop_reasons'], 'frame.row_stop_reasons'),
        run_state: runState,
        graph: Object.freeze({ complete_graph_current: bool(graph, 'complete_graph_current', 'frame.graph'), graph_publication_pending: bool(graph, 'graph_publication_pending', 'frame.graph') }),
        policy: Object.freeze({ policy_current: bool(policy, 'policy_current', 'frame.policy') }),
        heartbeat: Object.freeze({ governing_heartbeat_current: bool(heartbeat, 'governing_heartbeat_current', 'frame.heartbeat'), provider_state: provider }),
        session: Object.freeze({ attached_session_current: bool(session, 'attached_session_current', 'frame.session'), expected_version_current: bool(session, 'expected_version_current', 'frame.session'), lease_current: bool(session, 'lease_current', 'frame.session'), cap_current: bool(session, 'cap_current', 'frame.session') }),
    });
}
