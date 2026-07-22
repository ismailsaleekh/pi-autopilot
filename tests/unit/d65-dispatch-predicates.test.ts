import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  D65_NONCLEARABLE_BLOCKERS,
  D65_RECOVERY_ACTIONS,
  ordinaryDispatchAllowed,
  recoveryTransitionAllowed,
  type D65OrdinaryDispatchInput,
  type D65RecoveryAction,
  type D65RecoveryBindings,
  type D65RecoveryTransitionInput,
} from '../../src/core/coordination/d65-dispatch-predicates.ts';
import { D65_STOP_REASONS, type D65StopReason } from '../../src/core/coordination/d65-launch-policy.ts';

// ---- ordinary_dispatch_allowed ----------------------------------------------

function allCurrentOrdinary(): D65OrdinaryDispatchInput {
  return {
    global_stop_reasons: [],
    row_stop_reasons: [],
    run_state: 'active',
    graph: { complete_graph_current: true, graph_publication_pending: false },
    policy: { policy_current: true },
    heartbeat: { governing_heartbeat_current: true, provider_state: 'healthy' },
    session: { attached_session_current: true, expected_version_current: true, lease_current: true, cap_current: true },
  };
}

void describe('D65-I4 ordinaryDispatchAllowed', () => {
  void it('is true only when every current condition holds', () => {
    assert.deepEqual(ordinaryDispatchAllowed(allCurrentOrdinary()), { allowed: true });
  });

  const singleFieldNegatives: ReadonlyArray<{ readonly name: string; readonly mutate: (base: D65OrdinaryDispatchInput) => D65OrdinaryDispatchInput; readonly reason: string }> = [
    { name: 'global stop nonempty', mutate: (b) => ({ ...b, global_stop_reasons: ['heartbeat-stale'] }), reason: 'global-stop-nonempty' },
    { name: 'row stop nonempty', mutate: (b) => ({ ...b, row_stop_reasons: ['provider-blocked'] }), reason: 'row-stop-nonempty' },
    { name: 'run not active', mutate: (b) => ({ ...b, run_state: 'merging' }), reason: 'run-not-active' },
    { name: 'graph not current', mutate: (b) => ({ ...b, graph: { complete_graph_current: false, graph_publication_pending: false } }), reason: 'graph-not-current' },
    { name: 'graph publication pending', mutate: (b) => ({ ...b, graph: { complete_graph_current: true, graph_publication_pending: true } }), reason: 'graph-publication-pending' },
    { name: 'policy not current', mutate: (b) => ({ ...b, policy: { policy_current: false } }), reason: 'policy-not-current' },
    { name: 'heartbeat not governing', mutate: (b) => ({ ...b, heartbeat: { governing_heartbeat_current: false, provider_state: 'healthy' } }), reason: 'heartbeat-not-governing' },
    { name: 'provider not healthy', mutate: (b) => ({ ...b, heartbeat: { governing_heartbeat_current: true, provider_state: 'blocked' } }), reason: 'provider-not-healthy' },
    { name: 'session not current', mutate: (b) => ({ ...b, session: { ...b.session, attached_session_current: false } }), reason: 'session-not-current' },
    { name: 'expected version stale', mutate: (b) => ({ ...b, session: { ...b.session, expected_version_current: false } }), reason: 'expected-version-stale' },
    { name: 'lease not current', mutate: (b) => ({ ...b, session: { ...b.session, lease_current: false } }), reason: 'lease-not-current' },
    { name: 'cap not current', mutate: (b) => ({ ...b, session: { ...b.session, cap_current: false } }), reason: 'cap-not-current' },
  ];

  for (const negative of singleFieldNegatives) {
    void it(`is false and cites ${negative.reason} when ${negative.name}`, () => {
      const verdict = ordinaryDispatchAllowed(negative.mutate(allCurrentOrdinary()));
      assert.equal(verdict.allowed, false);
      if (!verdict.allowed) assert.ok(verdict.denied_by.includes(negative.reason as never), `expected ${negative.reason} in ${verdict.denied_by.join(',')}`);
    });
  }

  void it('fails closed with malformed-reasons on an unsorted global array', () => {
    const verdict = ordinaryDispatchAllowed({ ...allCurrentOrdinary(), global_stop_reasons: ['row-closed', 'heartbeat-stale'] });
    assert.deepEqual(verdict, { allowed: false, denied_by: ['malformed-reasons'] });
  });

  void it('fails closed with malformed-reasons on a duplicate row reason', () => {
    const verdict = ordinaryDispatchAllowed({ ...allCurrentOrdinary(), row_stop_reasons: ['provider-blocked', 'provider-blocked'] });
    assert.deepEqual(verdict, { allowed: false, denied_by: ['malformed-reasons'] });
  });

  void it('accumulates every denial reason when nothing is current', () => {
    const verdict = ordinaryDispatchAllowed({
      global_stop_reasons: ['heartbeat-stale'],
      row_stop_reasons: ['provider-blocked'],
      run_state: 'blocked',
      graph: { complete_graph_current: false, graph_publication_pending: true },
      policy: { policy_current: false },
      heartbeat: { governing_heartbeat_current: false, provider_state: 'exhausted' },
      session: { attached_session_current: false, expected_version_current: false, lease_current: false, cap_current: false },
    });
    assert.equal(verdict.allowed, false);
    if (!verdict.allowed) assert.equal(verdict.denied_by.length, 12);
  });
});

// ---- recovery_transition_allowed --------------------------------------------

function bindings(overrides: Partial<D65RecoveryBindings> = {}): D65RecoveryBindings {
  return {
    attached_session_current: true, policy_trust_current: true, no_pending_publication: true,
    terminal_prepared_cancellable: true, terminal_after_commit: false, accepted_continuation_reason: null,
    covered_semantic_reason: null, attach_terminal_recovery: false, ...overrides,
  };
}

function baseRecovery(action: D65RecoveryAction, overrides: Partial<D65RecoveryTransitionInput> = {}): D65RecoveryTransitionInput {
  return {
    action,
    global_stop_reasons: [],
    row_stop_reasons: [],
    run_state: 'recovering',
    graph: { complete_graph_current: true, graph_publication_pending: false },
    policy: { policy_current: true },
    heartbeat: { governing_heartbeat_current: true, provider_state: 'healthy' },
    bindings: bindings(),
    ...overrides,
  };
}

function assertAllowed(input: D65RecoveryTransitionInput): void {
  const verdict = recoveryTransitionAllowed(input);
  assert.equal(verdict.allowed, true, `expected allowed for ${input.action}, got ${verdict.allowed ? 'allowed' : verdict.denied_by.join(',')}`);
  if (verdict.allowed) assert.equal(verdict.action, input.action);
}

function assertDenied(input: D65RecoveryTransitionInput, reason?: string): void {
  const verdict = recoveryTransitionAllowed(input);
  assert.equal(verdict.allowed, false);
  if (!verdict.allowed && reason !== undefined) assert.ok(verdict.denied_by.includes(reason as never), `expected ${reason} in ${verdict.denied_by.join(',')}`);
}

void describe('D65-I4 recoveryTransitionAllowed — per-cell positives', () => {
  void it('accept-program-heartbeat: liveness-only, tolerates any row incl. blockers', () => {
    assertAllowed(baseRecovery('accept-program-heartbeat', { row_stop_reasons: [] }));
    assertAllowed(baseRecovery('accept-program-heartbeat', { global_stop_reasons: ['heartbeat-stale'] }));
    // Row may carry the non-clearable blockers (acceptance never resolves them),
    // EXCEPT coordinator-terminal, which the cell explicitly forbids alongside
    // operator-stop/identity-drift/policy-invalid/cap-violation.
    const tolerableBlockers = [...D65_NONCLEARABLE_BLOCKERS].filter((reason) => reason !== 'coordinator-terminal').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assertAllowed(baseRecovery('accept-program-heartbeat', { row_stop_reasons: tolerableBlockers }));
    // The explicitly-forbidden coordinator-terminal rejects even though it is a blocker.
    assertDenied(baseRecovery('accept-program-heartbeat', { row_stop_reasons: ['coordinator-terminal'] }), 'row-reasons-not-permitted');
  });
  void it('register-authoritative-artifact: exactly the accepted continuation reason (+ unit-recovering / one provider)', () => {
    // The accepted continuation reason must be PRESENT; here it is progress-stale.
    assertAllowed(baseRecovery('register-authoritative-artifact', { row_stop_reasons: ['progress-stale'], bindings: bindings({ accepted_continuation_reason: 'progress-stale' }) }));
    assertAllowed(baseRecovery('register-authoritative-artifact', { row_stop_reasons: ['progress-stale', 'provider-blocked', 'unit-recovering'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[], bindings: bindings({ accepted_continuation_reason: 'progress-stale' }) }));
    assertAllowed(baseRecovery('register-authoritative-artifact', { row_stop_reasons: ['provider-blocked', 'unit-recovering'], bindings: bindings({ accepted_continuation_reason: 'unit-recovering' }) }));
  });
  void it('graph-publication: exactly graph-publication-pending (+ one covered semantic / one provider), prior graph current', () => {
    // Prior graph tuple must be CURRENT (complete_graph_current true) with a pending publication.
    assertAllowed(baseRecovery('graph-publication', { row_stop_reasons: ['graph-publication-pending'], graph: { complete_graph_current: true, graph_publication_pending: true } }));
    assertAllowed(baseRecovery('graph-publication', { row_stop_reasons: ['graph-incomplete', 'graph-publication-pending'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[], graph: { complete_graph_current: true, graph_publication_pending: true }, bindings: bindings({ covered_semantic_reason: 'graph-incomplete' }) }));
    assertAllowed(baseRecovery('graph-publication', { row_stop_reasons: ['graph-publication-pending', 'handoff-pending'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[], graph: { complete_graph_current: true, graph_publication_pending: true }, bindings: bindings({ covered_semantic_reason: 'handoff-pending' }) }));
  });
  void it('unit-recovery: unit-recovering + at most one provider', () => {
    assertAllowed(baseRecovery('unit-recovery', { row_stop_reasons: ['unit-recovering'] }));
    assertAllowed(baseRecovery('unit-recovery', { row_stop_reasons: ['provider-blocked', 'unit-recovering'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[] }));
  });
  void it('register-attempt: singleton exception exactly [provider-blocked] + retry-authorized', () => {
    assertAllowed(baseRecovery('register-attempt', { row_stop_reasons: ['provider-blocked'], heartbeat: { governing_heartbeat_current: true, provider_state: 'retry-authorized' } }));
  });
  void it('planned-handoff: handoff-pending + at most one provider', () => {
    assertAllowed(baseRecovery('planned-handoff', { row_stop_reasons: ['handoff-pending'] }));
  });
  void it('parent-loss: parent-recovering + at most one provider', () => {
    assertAllowed(baseRecovery('parent-loss', { row_stop_reasons: ['parent-recovering'] }));
  });
  void it('cancel-run-terminal: [terminal-tail] + merging + cancellable', () => {
    assertAllowed(baseRecovery('cancel-run-terminal', { row_stop_reasons: ['terminal-tail'], run_state: 'merging' }));
    assertAllowed(baseRecovery('cancel-run-terminal', { row_stop_reasons: ['provider-blocked', 'terminal-tail'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[], run_state: 'merging' }));
  });
  void it('terminal-tail: pre-commit [terminal-tail]; post-commit [row-closed,terminal-tail]; lease-invalid ONLY for attach-terminal-recovery', () => {
    assertAllowed(baseRecovery('terminal-tail', { row_stop_reasons: ['terminal-tail'] }));
    assertAllowed(baseRecovery('terminal-tail', { row_stop_reasons: ['row-closed', 'terminal-tail'], bindings: bindings({ terminal_after_commit: true }) }));
    // lease-invalid tolerated only when attach_terminal_recovery is set.
    assertAllowed(baseRecovery('terminal-tail', { row_stop_reasons: ['lease-invalid', 'terminal-tail'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[], bindings: bindings({ attach_terminal_recovery: true }) }));
  });
});

void describe('D65-I4 recoveryTransitionAllowed — negatives', () => {
  void it('rejects a nonempty global for every non-liveness cell', () => {
    for (const action of D65_RECOVERY_ACTIONS) {
      if (action === 'accept-program-heartbeat') continue;
      assertDenied(baseRecovery(action, { global_stop_reasons: ['operator-stop'] }), 'global-reasons-not-permitted');
    }
  });
  void it('accept-program-heartbeat rejects a forbidden row reason and a terminal run', () => {
    assertDenied(baseRecovery('accept-program-heartbeat', { row_stop_reasons: ['policy-invalid'] }), 'row-reasons-not-permitted');
    assertDenied(baseRecovery('accept-program-heartbeat', { row_stop_reasons: ['coordinator-terminal'] }), 'row-reasons-not-permitted');
    assertDenied(baseRecovery('accept-program-heartbeat', { run_state: 'closed' }), 'run-terminal');
    assertDenied(baseRecovery('accept-program-heartbeat', { global_stop_reasons: ['progress-stale'] }), 'global-reasons-not-permitted');
  });
  void it('graph-publication requires the pending flag and exactly the pending reason', () => {
    assertDenied(baseRecovery('graph-publication', { row_stop_reasons: ['graph-publication-pending'], graph: { complete_graph_current: true, graph_publication_pending: false } }), 'graph-publication-not-pending');
    assertDenied(baseRecovery('graph-publication', { row_stop_reasons: [], graph: { complete_graph_current: true, graph_publication_pending: true } }), 'row-reasons-not-permitted');
    assertDenied(baseRecovery('graph-publication', { row_stop_reasons: ['graph-publication-pending', 'policy-invalid'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[], graph: { complete_graph_current: true, graph_publication_pending: true } }), 'row-reasons-not-permitted');
  });
  void it('graph-publication requires the prior graph to be current (not stale)', () => {
    assertDenied(baseRecovery('graph-publication', { row_stop_reasons: ['graph-publication-pending'], graph: { complete_graph_current: false, graph_publication_pending: true } }), 'graph-not-current');
  });
  void it('graph-publication rejects two semantic reasons or two provider reasons', () => {
    assertDenied(baseRecovery('graph-publication', { row_stop_reasons: ['graph-drift', 'graph-incomplete', 'graph-publication-pending'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[], graph: { complete_graph_current: true, graph_publication_pending: true }, bindings: bindings({ covered_semantic_reason: 'graph-incomplete' }) }), 'row-reasons-not-permitted');
    assertDenied(baseRecovery('graph-publication', { row_stop_reasons: ['graph-publication-pending', 'provider-blocked', 'provider-exhausted'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[], graph: { complete_graph_current: true, graph_publication_pending: true } }), 'row-reasons-not-permitted');
  });
  void it('graph-publication cannot smuggle a forbidden reason via covered_semantic_reason', () => {
    // policy-invalid is explicitly forbidden by the frozen row; passing it as the
    // covered_semantic_reason binding must still reject.
    assertDenied(baseRecovery('graph-publication', { row_stop_reasons: ['graph-publication-pending', 'policy-invalid'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[], graph: { complete_graph_current: true, graph_publication_pending: true }, bindings: bindings({ covered_semantic_reason: 'policy-invalid' }) }), 'row-reasons-not-permitted');
    assertDenied(baseRecovery('graph-publication', { row_stop_reasons: ['coordinator-terminal', 'graph-publication-pending'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[], graph: { complete_graph_current: true, graph_publication_pending: true }, bindings: bindings({ covered_semantic_reason: 'coordinator-terminal' }) }), 'row-reasons-not-permitted');
  });
  void it('register-authoritative-artifact requires the accepted continuation reason to be present and ≤1 provider', () => {
    // Missing the continuation reason (empty row) is NOT permitted.
    assertDenied(baseRecovery('register-authoritative-artifact', { row_stop_reasons: [], bindings: bindings({ accepted_continuation_reason: 'progress-stale' }) }), 'row-reasons-not-permitted');
    // No accepted continuation reason at all → cannot form a legal row.
    assertDenied(baseRecovery('register-authoritative-artifact', { row_stop_reasons: ['unit-recovering'], bindings: bindings({ accepted_continuation_reason: null }) }), 'row-reasons-not-permitted');
    // Two provider reasons rejected.
    assertDenied(baseRecovery('register-authoritative-artifact', { row_stop_reasons: ['progress-stale', 'provider-blocked', 'provider-exhausted'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[], bindings: bindings({ accepted_continuation_reason: 'progress-stale' }) }), 'row-reasons-not-permitted');
  });
  void it('register-authoritative-artifact cannot smuggle a blocker or a second provider via accepted_continuation_reason', () => {
    // A non-clearable blocker as the accepted continuation reason must reject
    // (only the liveness-only accept-program-heartbeat may carry blockers).
    assertDenied(baseRecovery('register-authoritative-artifact', { row_stop_reasons: ['coordinator-blocked'], bindings: bindings({ accepted_continuation_reason: 'coordinator-blocked' }) }), 'row-reasons-not-permitted');
    // A provider reason as the accepted continuation reason (to hide a second provider) must reject.
    assertDenied(baseRecovery('register-authoritative-artifact', { row_stop_reasons: ['provider-blocked', 'provider-exhausted'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[], bindings: bindings({ accepted_continuation_reason: 'provider-blocked' }) }), 'row-reasons-not-permitted');
  });
  void it('terminal-tail rejects lease-invalid unless attach_terminal_recovery is set', () => {
    assertDenied(baseRecovery('terminal-tail', { row_stop_reasons: ['lease-invalid', 'terminal-tail'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[], bindings: bindings({ attach_terminal_recovery: false }) }), 'row-reasons-not-permitted');
  });
  void it('unit-recovery rejects a wrong reason, stale session, and a second provider reason', () => {
    assertDenied(baseRecovery('unit-recovery', { row_stop_reasons: ['provider-blocked'] }), 'row-reasons-not-permitted');
    assertDenied(baseRecovery('unit-recovery', { row_stop_reasons: ['unit-recovering'], bindings: bindings({ attached_session_current: false }) }), 'session-not-current');
    assertDenied(baseRecovery('unit-recovery', { row_stop_reasons: ['provider-blocked', 'provider-exhausted', 'unit-recovering'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[] }), 'row-reasons-not-permitted');
  });
  void it('register-attempt rejects a non-retry provider state or extra row reason', () => {
    assertDenied(baseRecovery('register-attempt', { row_stop_reasons: ['provider-blocked'], heartbeat: { governing_heartbeat_current: true, provider_state: 'healthy' } }), 'provider-state-not-permitted');
    assertDenied(baseRecovery('register-attempt', { row_stop_reasons: ['provider-blocked', 'unit-recovering'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[], heartbeat: { governing_heartbeat_current: true, provider_state: 'retry-authorized' } }), 'row-reasons-not-permitted');
  });
  void it('cancel-run-terminal rejects a non-merging run and a non-cancellable intent', () => {
    assertDenied(baseRecovery('cancel-run-terminal', { row_stop_reasons: ['terminal-tail'], run_state: 'active' }), 'run-terminal');
    assertDenied(baseRecovery('cancel-run-terminal', { row_stop_reasons: ['terminal-tail'], run_state: 'merging', bindings: bindings({ terminal_prepared_cancellable: false }) }), 'binding-precondition-unmet');
  });
  void it('terminal-tail rejects two provider reasons and a wrong required set', () => {
    assertDenied(baseRecovery('terminal-tail', { row_stop_reasons: ['provider-blocked', 'provider-exhausted', 'terminal-tail'].sort((a, b) => (a < b ? -1 : 1)) as D65StopReason[] }), 'row-reasons-not-permitted');
    assertDenied(baseRecovery('terminal-tail', { row_stop_reasons: ['row-closed', 'terminal-tail'], bindings: bindings({ terminal_after_commit: false }) }), 'row-reasons-not-permitted');
  });
  void it('every non-heartbeat cell rejects a non-clearable blocker in the row reasons', () => {
    for (const action of D65_RECOVERY_ACTIONS) {
      if (action === 'accept-program-heartbeat') continue;
      const graph = action === 'graph-publication' ? { complete_graph_current: true, graph_publication_pending: true } : { complete_graph_current: true, graph_publication_pending: false };
      const heartbeat = action === 'register-attempt' ? { governing_heartbeat_current: true, provider_state: 'retry-authorized' as const } : { governing_heartbeat_current: true, provider_state: 'healthy' as const };
      const run_state = action === 'cancel-run-terminal' ? 'merging' as const : 'recovering' as const;
      // A non-clearable blocker is never a legal recovery row reason for any of these cells.
      assertDenied(baseRecovery(action, { row_stop_reasons: ['coordinator-blocked'], graph, heartbeat, run_state, bindings: bindings({ accepted_continuation_reason: 'unit-recovering' }) }), 'row-reasons-not-permitted');
    }
  });
  void it('fails closed with malformed-reasons on an unsorted array for any action', () => {
    assertDenied(baseRecovery('terminal-tail', { row_stop_reasons: ['terminal-tail', 'row-closed'] }), 'malformed-reasons');
  });
});

void describe('D65-I4 totality guarantee', () => {
  void it('returns a closed verdict for every recovery action with an all-empty frame (never throws)', () => {
    for (const action of D65_RECOVERY_ACTIONS) {
      const verdict = recoveryTransitionAllowed(baseRecovery(action, { row_stop_reasons: [], graph: { complete_graph_current: false, graph_publication_pending: false }, heartbeat: { governing_heartbeat_current: false, provider_state: 'blocked' } }));
      assert.equal(typeof verdict.allowed, 'boolean');
      if (!verdict.allowed) assert.ok(Array.isArray(verdict.denied_by));
    }
  });
  void it('every known stop reason is accepted structurally (no throw) by the ordinary predicate', () => {
    for (const reason of D65_STOP_REASONS) {
      const verdict = ordinaryDispatchAllowed({ ...allCurrentOrdinary(), row_stop_reasons: [reason] });
      assert.equal(verdict.allowed, false);
    }
  });
  void it('an impossible action value returns unknown-action rather than throwing', () => {
    const malformed = baseRecovery('accept-program-heartbeat');
    Object.defineProperty(malformed, 'action', { value: 'not-a-real-action', enumerable: true });
    const verdict = recoveryTransitionAllowed(malformed);
    assert.equal(verdict.allowed, false);
    if (!verdict.allowed) assert.ok(verdict.denied_by.includes('unknown-action'));
  });
});
