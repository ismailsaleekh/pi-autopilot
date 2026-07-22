import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  D65_STOP_REASONS,
  HEARTBEAT_ADVANCE_MAX_RECORDS,
  parseD65CapacityDecision,
  parseD65HeartbeatAcceptanceResult,
  parseD65HeartbeatHighWater,
  parseD65LaunchPolicy,
  parseD65ProgramHeartbeat,
  parseD65SubscriptionProbe,
} from '../../src/core/coordination/d65-launch-policy.ts';

const OID = (c: string): string => c.repeat(40);
const DIGEST = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}` as const;

function policyFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'autopilot.launch_policy.v1', program_id: 'program-1', policy_id: 'policy-1', policy_version: 1,
    repo_id: 'repo-1', workstream_run: 'run-1', package_commit: OID('a'), package_tree: OID('b'), base_commit: OID('c'), base_tree: OID('d'),
    bootstrap_graph_sha256: DIGEST('e'), bootstrap_receipt_event_seq: 1, roster_sha256: DIGEST('f'),
    parallel_cap: 1, maximum_parallel_cap: 1, expected_checkout_units: 1,
    program_evidence_root: '/var/evidence/program-1', trust_anchor_ref: '.pi/autopilot-trust/d65/program-1/operator-ed25519.spki', trust_anchor_sha256: DIGEST('0'),
    prior_policy_sha256: null, capacity_decision_ref: null, capacity_decision_sha256: null, issued_at: '2026-07-19T00:00:00.000Z', signer_key_id: DIGEST('1'), signature: 'abcABC_-', ...overrides,
  };
}

void describe('D65 launch policy contract', () => {
  void it('parses the immutable cap-one initial policy', () => {
    const policy = parseD65LaunchPolicy(policyFixture());
    assert.equal(policy.parallel_cap, 1);
    assert.equal(policy.maximum_parallel_cap, 1);
    assert.equal(policy.expected_checkout_units, 1);
    assert.equal(policy.policy_version, 1);
  });

  void it('rejects any cap that is not exactly 1 and unknown fields', () => {
    assert.throws(() => parseD65LaunchPolicy(policyFixture({ parallel_cap: 2 })), /parallel_cap must be exactly 1/u);
    assert.throws(() => parseD65LaunchPolicy(policyFixture({ maximum_parallel_cap: 2 })), /initial policy maximum_parallel_cap must be exactly 1/u);
    assert.throws(() => parseD65LaunchPolicy(policyFixture({ expected_checkout_units: 0 })), /expected_checkout_units must be exactly 1/u);
    assert.throws(() => parseD65LaunchPolicy(policyFixture({ extra: 1 })), /unknown fields/u);
  });

  void it('requires initial version 1 to carry null prior/decision fields', () => {
    assert.throws(() => parseD65LaunchPolicy(policyFixture({ prior_policy_sha256: DIGEST('2') })), /initial policy version 1 must have null prior\/decision fields/u);
    // A superseding version needs prior + decision refs.
    assert.throws(() => parseD65LaunchPolicy(policyFixture({ policy_version: 2, maximum_parallel_cap: 2, prior_policy_sha256: null })), /must name the prior policy digest/u);
    const superseding = parseD65LaunchPolicy(policyFixture({ policy_version: 2, maximum_parallel_cap: 2, prior_policy_sha256: DIGEST('2'), capacity_decision_ref: 'authority/capacity-decisions/decision-1.json', capacity_decision_sha256: DIGEST('3') }));
    assert.equal(superseding.maximum_parallel_cap, 2);
  });
});

void describe('D65 capacity decision contract', () => {
  function decisionFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema_version: 'autopilot.capacity_decision.v1', program_id: 'program-1', decision_id: 'decision-1', policy_id: 'policy-1',
      from_version: 1, to_version: 2, repo_id: 'repo-1', workstream_run: 'run-1', prior_policy_sha256: DIGEST('a'),
      requested_parallel_cap: 2, requested_maximum_parallel_cap: 2, requested_expected_checkout_units: 2, reason: 'operator capacity increase',
      audit_ref: 'authority/capacity-audits/audit-1.json', audit_sha256: DIGEST('b'), issued_at: '2026-07-19T00:00:00.000Z',
      trust_anchor_ref: '.pi/autopilot-trust/d65/program-1/operator-ed25519.spki', trust_anchor_sha256: DIGEST('0'), signer_key_id: DIGEST('1'), signature: 'sigSIG_-', ...overrides,
    };
  }
  void it('parses a contiguous version bump and rejects non-contiguous versions', () => {
    assert.equal(parseD65CapacityDecision(decisionFixture()).to_version, 2);
    assert.throws(() => parseD65CapacityDecision(decisionFixture({ from_version: 1, to_version: 3 })), /versions must be contiguous/u);
  });
});

void describe('D65 subscription probe contract', () => {
  function probeFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema_version: 'autopilot.subscription_probe.v1', probe_id: 'probe-1', program_id: 'program-1', probe_sequence: 1, prior_probe_sha256: null,
      provider: 'openai-codex', trigger_continuation_ref: 'authority/continuation/00000000000000000001-x.json', trigger_continuation_sha256: DIGEST('a'),
      repo_id: 'repo-1', workstream_run: 'run-1', unit_id: 'unit-1', failed_attempt: 1, retry_ordinal: 1, successor_attempt: 2,
      observed_at: '2026-07-19T00:15:00.000Z', cooldown_until: '2026-07-19T00:15:00.000Z', issued_at: '2026-07-19T00:16:00.000Z',
      not_before: '2026-07-19T00:15:00.000Z', expires_at: '2026-07-19T00:21:00.000Z', healthy: true, cooldown_completed: true, evidence_refs: [],
      trust_anchor_ref: '.pi/autopilot-trust/d65/program-1/operator-ed25519.spki', trust_anchor_sha256: DIGEST('0'), signer_key_id: DIGEST('1'), signature: 'sigSIG_-', ...overrides,
    };
  }
  void it('parses a one-use retry probe with the exact 5-minute acceptance window', () => {
    const probe = parseD65SubscriptionProbe(probeFixture());
    assert.equal(probe.retry_ordinal, 1);
    assert.equal(probe.successor_attempt, 2);
  });
  void it('enforces successor=failed+1, retry_ordinal 1, and expires_at = issued_at + 5m', () => {
    assert.throws(() => parseD65SubscriptionProbe(probeFixture({ successor_attempt: 3 })), /successor_attempt must equal failed_attempt \+ 1/u);
    assert.throws(() => parseD65SubscriptionProbe(probeFixture({ retry_ordinal: 2 })), /retry_ordinal must be exactly 1/u);
    assert.throws(() => parseD65SubscriptionProbe(probeFixture({ expires_at: '2026-07-19T00:20:00.000Z' })), /expires_at must be exactly issued_at \+ 5 minutes/u);
    assert.throws(() => parseD65SubscriptionProbe(probeFixture({ not_before: '2026-07-19T00:14:00.000Z' })), /not_before must equal cooldown_until/u);
  });
});

void describe('D65 program heartbeat contract', () => {
  function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      workstream: 'kbg-finalize-fresh', workstream_run: 'run-1', parent_session_file_sha256: null, coordinator_session_lease_id: null,
      accepted_graph_sequence: null, accepted_graph_sha256: null, status_sha256: null, doctor_sha256: null, session_lease_state: null,
      child_lease_ids: [], launch_policy_sha256: null, last_progress_event_seq: null, last_handoff_sha256: null,
      row_state: 'planned', dispatch_allowed: false, stop_reasons: ['row-not-launched'], ...overrides,
    };
  }
  function heartbeatFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema_version: 'autopilot.program_heartbeat.v1', program_id: 'program-1', sequence: 1, prior_sha256: null,
      issued_at: '2026-07-19T00:00:00.000Z', valid_until: '2026-07-19T00:15:00.000Z', package_commit: OID('a'), package_tree: OID('b'),
      base_commit: OID('c'), base_tree: OID('d'), rows: [row()], provider_health: [{ provider: 'openai-codex', state: 'healthy', observation_ref: 'authority/provider-launch/openai-codex.json', observation_sha256: DIGEST('6'), cooldown_until: null, probe_workstream_run: null, probe_ref: null, probe_sha256: null, consumption_event_seq: null }],
      dispatch_allowed: false, stop_reasons: ['operator-stop'], trust_anchor_ref: '.pi/autopilot-trust/d65/program-1/operator-ed25519.spki', trust_anchor_sha256: DIGEST('0'), signer_key_id: DIGEST('1'), signature: 'sigSIG_-', ...overrides,
    };
  }
  void it('parses a valid heartbeat and binds dispatch to reasons', () => {
    const heartbeat = parseD65ProgramHeartbeat(heartbeatFixture());
    assert.equal(heartbeat.sequence, 1);
    assert.equal(heartbeat.rows.length, 1);
    assert.equal(heartbeat.provider_health[0]?.state, 'healthy');
  });
  void it('enforces valid_until = issued_at + 15m and dispatch/reason coherence', () => {
    assert.throws(() => parseD65ProgramHeartbeat(heartbeatFixture({ valid_until: '2026-07-19T00:10:00.000Z' })), /valid_until must be exactly issued_at \+ 15 minutes/u);
    assert.throws(() => parseD65ProgramHeartbeat(heartbeatFixture({ dispatch_allowed: true })), /global dispatch_allowed requires empty global stop_reasons/u);
    assert.throws(() => parseD65ProgramHeartbeat(heartbeatFixture({ dispatch_allowed: false, stop_reasons: [] })), /a false global dispatch value requires at least one global reason/u);
  });
  void it('enforces exact provider probe nullability for blocked, retry, consumed-healthy, and exhausted states', () => {
    const base = { provider: 'openai-codex', observation_ref: 'authority/provider.json', observation_sha256: DIGEST('a') };
    const retry = { ...base, state: 'retry-authorized', cooldown_until: '2026-07-19T00:00:00.000Z', probe_workstream_run: 'run-1', probe_ref: 'authority/subscription-probes/00000000000000000001-probe-1.json', probe_sha256: DIGEST('b'), consumption_event_seq: null };
    assert.equal(parseD65ProgramHeartbeat(heartbeatFixture({ provider_health: [retry] })).provider_health[0]?.state, 'retry-authorized');
    const consumed = { ...retry, state: 'healthy', cooldown_until: null, consumption_event_seq: 9 };
    assert.equal(parseD65ProgramHeartbeat(heartbeatFixture({ provider_health: [consumed] })).provider_health[0]?.consumption_event_seq, 9);
    assert.throws(() => parseD65ProgramHeartbeat(heartbeatFixture({ provider_health: [{ ...base, state: 'healthy', observation_ref: null, observation_sha256: null, cooldown_until: null, probe_workstream_run: null, probe_ref: null, probe_sha256: null, consumption_event_seq: null }] })), /must cite one exact/u);
    assert.throws(() => parseD65ProgramHeartbeat(heartbeatFixture({ provider_health: [{ ...retry, probe_sha256: null }] })), /retry-authorized provider must carry cooldown plus one unconsumed probe triple/u);
    assert.throws(() => parseD65ProgramHeartbeat(heartbeatFixture({ provider_health: [{ ...base, state: 'blocked', cooldown_until: null, probe_workstream_run: null, probe_ref: null, probe_sha256: null, consumption_event_seq: null }] })), /blocked provider must carry cooldown/u);
    assert.throws(() => parseD65ProgramHeartbeat(heartbeatFixture({ provider_health: [{ ...base, state: 'exhausted', cooldown_until: null, probe_workstream_run: 'run-1', probe_ref: retry.probe_ref, probe_sha256: DIGEST('b'), consumption_event_seq: null }] })), /exhausted provider must have null cooldown\/probe\/consumption tuple/u);
  });
  void it('requires row/provider identity sorting and known stop reasons', () => {
    const two = heartbeatFixture({ rows: [row({ workstream: 'zzz-later', workstream_run: 'run-2' }), row({ workstream: 'aaa-earlier', workstream_run: 'run-3' })] });
    assert.throws(() => parseD65ProgramHeartbeat(two), /rows must be identity-sorted/u);
    assert.throws(() => parseD65ProgramHeartbeat(heartbeatFixture({ rows: [row({ stop_reasons: ['not-a-reason'] })] })), /is not a known stop reason/u);
    // Every stop reason in the closed enum is accepted.
    assert.equal(D65_STOP_REASONS.length, 26);
  });
});

void describe('D65 heartbeat acceptance result and cache contracts', () => {
  void it('parses a governing acceptance result and a reconstructable high-water cache', () => {
    const result = parseD65HeartbeatAcceptanceResult({
      schema_version: 'autopilot.program_heartbeat_acceptance_result.v1', program_id: 'program-1', repo_id: 'repo-1', workstream_run: 'run-1',
      sequence: 1, heartbeat_ref: 'program-heartbeats/00000000000000000001.json', heartbeat_sha256: DIGEST('a'), acceptance_kind: 'governing',
      prior_sha256: null, issued_at: '2026-07-19T00:00:00.000Z', valid_until: '2026-07-19T00:15:00.000Z', coordinator_time: '2026-07-19T00:00:01.000Z',
    });
    assert.equal(result.acceptance_kind, 'governing');
    const cache = parseD65HeartbeatHighWater({
      schema_version: 'autopilot.heartbeat_high_water.v1', program_id: 'program-1', repo_id: 'repo-1', workstream_run: 'run-1',
      sequence: 1, heartbeat_sha256: DIGEST('a'), issued_at: '2026-07-19T00:00:00.000Z', valid_until: '2026-07-19T00:15:00.000Z', updated_at: '2026-07-19T00:00:01.000Z',
    });
    assert.equal(cache.sequence, 1);
    assert.equal(HEARTBEAT_ADVANCE_MAX_RECORDS, 1024);
  });
});
