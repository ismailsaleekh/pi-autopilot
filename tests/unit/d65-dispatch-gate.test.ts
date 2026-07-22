import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertOrdinaryBoundaryAllowed,
  assertRecoveryBoundaryAllowed,
  evaluateOrdinaryBoundary,
  evaluateRecoveryBoundary,
  D65DispatchFencedError,
  type D65DispatchAuthorityFrame,
  type D65OrdinaryBoundary,
  type D65RecoveryBoundary,
} from '../../src/core/coordination/d65-dispatch-gate.ts';
import type { D65RecoveryBindings } from '../../src/core/coordination/d65-dispatch-predicates.ts';

// A fully-current authority frame: ordinary dispatch is allowed.
function currentFrame(): D65DispatchAuthorityFrame {
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

const ALL_ORDINARY_BOUNDARIES: readonly D65OrdinaryBoundary[] = [
  'activation-bootstrap', 'main-worktree-preparation', 'parent-planning', 'config-write',
  'scheduler-dispatch', 'checkout-disk-estimate', 'runner-preflight', 'missing-worktree-creation',
  'post-acquisition-output', 'parent-model-spawn', 'child-model-spawn', 'ordinary-state-advance',
  'unit-merge', 'unit-reset', 'unit-quarantine', 'unit-release',
];

const RECOVERY_BINDINGS_CURRENT: D65RecoveryBindings = {
  attached_session_current: true, policy_trust_current: true, no_pending_publication: true,
  terminal_prepared_cancellable: true, terminal_after_commit: false,
  accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false,
};

void describe('D65 dispatch gate — ordinary boundaries', () => {
  void it('ALLOWS every ordinary boundary on a fully-current authority frame', () => {
    for (const boundary of ALL_ORDINARY_BOUNDARIES) {
      const verdict = evaluateOrdinaryBoundary(boundary, currentFrame());
      assert.equal(verdict.allowed, true, `boundary ${boundary} must be allowed on a current frame`);
      assert.doesNotThrow(() => assertOrdinaryBoundaryAllowed(boundary, currentFrame()));
    }
  });

  // One negative per authority dimension: each must FENCE ordinary dispatch loudly
  // with the exact denial reason. Proves no ordinary boundary can proceed under a
  // stale/blocked/nonlive/pending authority frame.
  const ORDINARY_NEGATIVES: readonly { readonly name: string; readonly mutate: (f: D65DispatchAuthorityFrame) => D65DispatchAuthorityFrame; readonly deniedBy: string }[] = [
    { name: 'global stop nonempty', mutate: (f) => ({ ...f, global_stop_reasons: ['operator-stop'] }), deniedBy: 'global-stop-nonempty' },
    { name: 'row stop nonempty', mutate: (f) => ({ ...f, row_stop_reasons: ['unit-recovering'] }), deniedBy: 'row-stop-nonempty' },
    { name: 'run not active (merging)', mutate: (f) => ({ ...f, run_state: 'merging' }), deniedBy: 'run-not-active' },
    { name: 'run not active (closed)', mutate: (f) => ({ ...f, run_state: 'closed' }), deniedBy: 'run-not-active' },
    { name: 'graph not current', mutate: (f) => ({ ...f, graph: { ...f.graph, complete_graph_current: false } }), deniedBy: 'graph-not-current' },
    { name: 'graph publication pending', mutate: (f) => ({ ...f, graph: { ...f.graph, graph_publication_pending: true } }), deniedBy: 'graph-publication-pending' },
    { name: 'policy not current', mutate: (f) => ({ ...f, policy: { policy_current: false } }), deniedBy: 'policy-not-current' },
    { name: 'heartbeat not governing', mutate: (f) => ({ ...f, heartbeat: { ...f.heartbeat, governing_heartbeat_current: false } }), deniedBy: 'heartbeat-not-governing' },
    { name: 'provider not healthy', mutate: (f) => ({ ...f, heartbeat: { ...f.heartbeat, provider_state: 'blocked' } }), deniedBy: 'provider-not-healthy' },
    { name: 'session not current', mutate: (f) => ({ ...f, session: { ...f.session, attached_session_current: false } }), deniedBy: 'session-not-current' },
    { name: 'expected version stale', mutate: (f) => ({ ...f, session: { ...f.session, expected_version_current: false } }), deniedBy: 'expected-version-stale' },
    { name: 'lease not current', mutate: (f) => ({ ...f, session: { ...f.session, lease_current: false } }), deniedBy: 'lease-not-current' },
    { name: 'cap not current', mutate: (f) => ({ ...f, session: { ...f.session, cap_current: false } }), deniedBy: 'cap-not-current' },
    { name: 'malformed reasons (unsorted)', mutate: (f) => ({ ...f, global_stop_reasons: ['row-closed', 'operator-stop'] }), deniedBy: 'malformed-reasons' },
  ];

  for (const negative of ORDINARY_NEGATIVES) {
    void it(`FENCES 'parent-model-spawn' when ${negative.name}`, () => {
      const frame = negative.mutate(currentFrame());
      const verdict = evaluateOrdinaryBoundary('parent-model-spawn', frame);
      assert.equal(verdict.allowed, false);
      if (!verdict.allowed) assert.ok(verdict.denied_by.includes(negative.deniedBy as never), `expected ${negative.deniedBy} in ${verdict.denied_by.join(',')}`);
      const error = assertThrows(() => assertOrdinaryBoundaryAllowed('parent-model-spawn', frame));
      assert.ok(error instanceof D65DispatchFencedError);
      assert.equal((error as D65DispatchFencedError).kind, 'ordinary');
      assert.equal((error as D65DispatchFencedError).boundary, 'parent-model-spawn');
      assert.ok((error as D65DispatchFencedError).deniedBy.includes(negative.deniedBy));
    });
  }
});

void describe('D65 dispatch gate — recovery boundaries (default-deny)', () => {
  // accept-program-heartbeat positive: global [], nonterminal run, current
  // session + policy trust, no forbidden row reason.
  void it('ALLOWS accept-program-heartbeat on its exact frozen cell', () => {
    const frame: D65DispatchAuthorityFrame = { ...currentFrame(), run_state: 'blocked', global_stop_reasons: ['heartbeat-stale'], row_stop_reasons: ['unit-recovering'] };
    assert.doesNotThrow(() => assertRecoveryBoundaryAllowed('accept-program-heartbeat', frame, RECOVERY_BINDINGS_CURRENT));
  });

  // graph-publication positive: row exactly [graph-publication-pending], pending true, graph/policy/session current.
  void it('ALLOWS graph-publication on its exact frozen cell', () => {
    const frame: D65DispatchAuthorityFrame = {
      ...currentFrame(),
      row_stop_reasons: ['graph-publication-pending'],
      graph: { complete_graph_current: true, graph_publication_pending: true },
    };
    assert.doesNotThrow(() => assertRecoveryBoundaryAllowed('graph-publication', frame, RECOVERY_BINDINGS_CURRENT));
  });

  // cancel-run-terminal positive: run merging, row [terminal-tail], cancellable.
  void it('ALLOWS cancel-run-terminal on its exact frozen cell (cancellable prepared intent)', () => {
    const frame: D65DispatchAuthorityFrame = { ...currentFrame(), run_state: 'merging', row_stop_reasons: ['terminal-tail'] };
    assert.doesNotThrow(() => assertRecoveryBoundaryAllowed('cancel-run-terminal', frame, RECOVERY_BINDINGS_CURRENT));
  });

  // Wrong-reason negative: a recovery cell rejects an extra forbidden row reason.
  void it('FENCES cancel-run-terminal when the row carries a forbidden extra reason', () => {
    const frame: D65DispatchAuthorityFrame = { ...currentFrame(), run_state: 'merging', row_stop_reasons: ['operator-stop', 'terminal-tail'] };
    const error = assertThrows(() => assertRecoveryBoundaryAllowed('cancel-run-terminal', frame, RECOVERY_BINDINGS_CURRENT));
    assert.ok(error instanceof D65DispatchFencedError);
    assert.equal((error as D65DispatchFencedError).kind, 'recovery');
    assert.ok((error as D65DispatchFencedError).deniedBy.includes('row-reasons-not-permitted'));
  });

  // Wrong-state negative: cancel-run-terminal requires run merging.
  void it('FENCES cancel-run-terminal when the run is not merging', () => {
    const frame: D65DispatchAuthorityFrame = { ...currentFrame(), run_state: 'active', row_stop_reasons: ['terminal-tail'] };
    const error = assertThrows(() => assertRecoveryBoundaryAllowed('cancel-run-terminal', frame, RECOVERY_BINDINGS_CURRENT));
    assert.ok((error as D65DispatchFencedError).deniedBy.includes('run-terminal'));
  });

  // Wrong-binding (effect) negative: the mandatory fourth abort is non-cancellable.
  void it('FENCES cancel-run-terminal when the prepared intent is non-cancellable (fourth abort)', () => {
    const frame: D65DispatchAuthorityFrame = { ...currentFrame(), run_state: 'merging', row_stop_reasons: ['terminal-tail'] };
    const bindings: D65RecoveryBindings = { ...RECOVERY_BINDINGS_CURRENT, terminal_prepared_cancellable: false };
    const error = assertThrows(() => assertRecoveryBoundaryAllowed('cancel-run-terminal', frame, bindings));
    assert.ok((error as D65DispatchFencedError).deniedBy.includes('binding-precondition-unmet'));
  });

  // Wrong-tuple negative: graph-publication requires the publication actually pending.
  void it('FENCES graph-publication when no publication is pending', () => {
    const frame: D65DispatchAuthorityFrame = {
      ...currentFrame(),
      row_stop_reasons: ['graph-publication-pending'],
      graph: { complete_graph_current: true, graph_publication_pending: false },
    };
    const error = assertThrows(() => assertRecoveryBoundaryAllowed('graph-publication', frame, RECOVERY_BINDINGS_CURRENT));
    assert.ok((error as D65DispatchFencedError).deniedBy.includes('graph-publication-not-pending'));
  });

  // Cross-boundary separation proof: no recovery boundary that performs a
  // model/product/new-work/artifact/Git effect may fire on a fully-current
  // ORDINARY frame (empty row reasons, active run). Each effect-bearing cell
  // requires its own specific row reason (unit-recovering / handoff-pending /
  // parent-recovering / graph-publication-pending / terminal-tail / an accepted
  // continuation reason) or a non-active run state, so none may fire under
  // ordinary-current conditions. `accept-program-heartbeat` is DELIBERATELY
  // excluded: it is liveness-only (no model/product/Git/artifact effect) and the
  // frozen cell legitimately permits accepting a governing heartbeat while a run
  // is live and current — that is not a dispatch of ordinary work.
  const EFFECT_BEARING_RECOVERY_BOUNDARIES: readonly D65RecoveryBoundary[] = [
    'register-authoritative-artifact', 'graph-publication', 'unit-recovery',
    'register-attempt', 'planned-handoff', 'parent-loss', 'cancel-run-terminal', 'terminal-tail',
  ];
  void it('never allows an effect-bearing recovery boundary on a fully-current ordinary frame (default-deny separation)', () => {
    for (const boundary of EFFECT_BEARING_RECOVERY_BOUNDARIES) {
      const verdict = evaluateRecoveryBoundary(boundary, currentFrame(), RECOVERY_BINDINGS_CURRENT);
      assert.equal(verdict.allowed, false, `effect-bearing recovery boundary ${boundary} must NOT fire on an ordinary-current frame`);
    }
  });

  // The paired positive: on that same ordinary-current frame, the liveness-only
  // `accept-program-heartbeat` cell IS permitted (it dispatches no ordinary work).
  void it('permits the liveness-only accept-program-heartbeat on an ordinary-current frame (no work dispatched)', () => {
    const verdict = evaluateRecoveryBoundary('accept-program-heartbeat', currentFrame(), RECOVERY_BINDINGS_CURRENT);
    assert.equal(verdict.allowed, true);
  });
});

function assertThrows(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the gate to throw, but it did not');
}
