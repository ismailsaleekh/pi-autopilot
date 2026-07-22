import { D65_STOP_REASONS } from './d65-launch-policy.ts';
import { COORDINATION_RUN_STATUSES } from './types.ts';
import { CoordinationRuntimeError } from './failures.ts';
import type {
  D65GraphTuple,
  D65HeartbeatTuple,
  D65PolicyTuple,
  D65SessionAuthorityFrame,
} from './d65-dispatch-predicates.ts';
import type { D65StopReason } from './d65-launch-policy.ts';
import type { CoordinationRunStatus } from './types.ts';

/** Caller authority that cannot be synthesized by the store or pure predicate. */
export interface D65DispatchAuthorityRequestContext {
  readonly expected_version: number;
  readonly session_lease_id: string;
  readonly session_id: string;
  readonly session_generation: number;
}

/** One transactionally consistent committed frame for one immediate boundary. */
export const D65_DISPATCH_AUTHORITY_ENVELOPE_SCHEMA = 'autopilot.d65_dispatch_authority_envelope.v1' as const;

export interface D65DispatchAuthorityFrame {
  readonly global_stop_reasons: readonly D65StopReason[];
  readonly row_stop_reasons: readonly D65StopReason[];
  readonly run_state: CoordinationRunStatus;
  readonly graph: D65GraphTuple;
  readonly policy: D65PolicyTuple;
  readonly heartbeat: D65HeartbeatTuple;
  readonly session: D65SessionAuthorityFrame;
}

function fail(issue: string): never {
  throw new CoordinationRuntimeError('invalid-state', `D65 dispatch authority envelope is malformed: ${issue}`);
}

function record(value: unknown, label: string, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  const item = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(item).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} fields are not exact`);
  return item;
}

function bool(item: Readonly<Record<string, unknown>>, key: string, label: string): boolean {
  const value = item[key];
  if (typeof value !== 'boolean') fail(`${label}.${key} must be boolean`);
  return value;
}

export function parseD65DispatchAuthorityRequestContext(value: unknown): D65DispatchAuthorityRequestContext {
  const item = record(value, 'request_context', ['expected_version', 'session_generation', 'session_id', 'session_lease_id']);
  const expected = item['expected_version'];
  const generation = item['session_generation'];
  const sessionId = item['session_id'];
  const leaseId = item['session_lease_id'];
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1 || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) fail('request_context version/generation must be positive safe integers');
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 192 || typeof leaseId !== 'string' || leaseId.length < 1 || leaseId.length > 192) fail('request_context session identities must be bounded strings');
  return Object.freeze({ expected_version: expected, session_generation: generation, session_id: sessionId, session_lease_id: leaseId });
}

function reasons(value: unknown, label: string): readonly D65StopReason[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const out: D65StopReason[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !D65_STOP_REASONS.includes(entry as D65StopReason)) fail(`${label} contains an unknown reason`);
    out.push(entry as D65StopReason);
  }
  for (let index = 1; index < out.length; index += 1) if (!((out[index - 1] ?? '') < (out[index] ?? ''))) fail(`${label} must be decoded-byte-sorted unique`);
  return Object.freeze(out);
}

export function parseD65DispatchAuthorityEnvelope(value: unknown): D65DispatchAuthorityFrame {
  const envelope = record(value, 'envelope', ['dispatch_authority_frame', 'schema_version']);
  if (envelope['schema_version'] !== D65_DISPATCH_AUTHORITY_ENVELOPE_SCHEMA) fail('schema_version is invalid');
  const frame = record(envelope['dispatch_authority_frame'], 'frame', ['global_stop_reasons', 'graph', 'heartbeat', 'policy', 'row_stop_reasons', 'run_state', 'session']);
  const graph = record(frame['graph'], 'frame.graph', ['complete_graph_current', 'graph_publication_pending']);
  const policy = record(frame['policy'], 'frame.policy', ['policy_current']);
  const heartbeat = record(frame['heartbeat'], 'frame.heartbeat', ['governing_heartbeat_current', 'provider_state']);
  const session = record(frame['session'], 'frame.session', ['attached_session_current', 'cap_current', 'expected_version_current', 'lease_current']);
  const runState = frame['run_state'];
  if (typeof runState !== 'string' || !COORDINATION_RUN_STATUSES.includes(runState as never)) fail('frame.run_state is invalid');
  const provider = heartbeat['provider_state'];
  if (provider !== 'healthy' && provider !== 'blocked' && provider !== 'retry-authorized' && provider !== 'exhausted') fail('frame.heartbeat.provider_state is invalid');
  return Object.freeze({
    global_stop_reasons: reasons(frame['global_stop_reasons'], 'frame.global_stop_reasons'),
    row_stop_reasons: reasons(frame['row_stop_reasons'], 'frame.row_stop_reasons'),
    run_state: runState as CoordinationRunStatus,
    graph: Object.freeze({ complete_graph_current: bool(graph, 'complete_graph_current', 'frame.graph'), graph_publication_pending: bool(graph, 'graph_publication_pending', 'frame.graph') }),
    policy: Object.freeze({ policy_current: bool(policy, 'policy_current', 'frame.policy') }),
    heartbeat: Object.freeze({ governing_heartbeat_current: bool(heartbeat, 'governing_heartbeat_current', 'frame.heartbeat'), provider_state: provider }),
    session: Object.freeze({ attached_session_current: bool(session, 'attached_session_current', 'frame.session'), expected_version_current: bool(session, 'expected_version_current', 'frame.session'), lease_current: bool(session, 'lease_current', 'frame.session'), cap_current: bool(session, 'cap_current', 'frame.session') }),
  });
}
