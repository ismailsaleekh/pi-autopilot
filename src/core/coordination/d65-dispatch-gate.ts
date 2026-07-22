import { CoordinationRuntimeError } from './failures.ts';
import {
  ordinaryDispatchAllowed,
  recoveryTransitionAllowed,
  type D65OrdinaryDispatchInput,
  type D65OrdinaryDispatchVerdict,
  type D65RecoveryAction,
  type D65RecoveryBindings,
  type D65RecoveryTransitionInput,
  type D65RecoveryTransitionVerdict,
  type D65GraphTuple,
  type D65PolicyTuple,
  type D65HeartbeatTuple,
  type D65SessionAuthorityFrame,
} from './d65-dispatch-predicates.ts';
import type { CoordinationRunStatus } from './types.ts';
import type { D65StopReason } from './d65-launch-policy.ts';

// D65-I5 runtime all-boundary dispatch gate (fresh plan §2.3 "Recovery actions
// call only the table predicate at their coordinator transaction boundary";
// implementation-plan D65-I5: "Put complete graph/policy/heartbeat validation
// before preflightSpec and missing-worktree preparation, recheck after
// acquisition before every side effect/registration ... Wire all state writers,
// terminal acceptance, merge/reset/quarantine, handoff/parent-loss, close/abort,
// and recovery through the exact ordinary-dispatch or default-deny
// recovery-transition predicate").
//
// This module is the RUNTIME side of that contract. The pure predicate module
// (d65-dispatch-predicates.ts, Lane B / D65-I4) decides allow/deny from a closed
// input frame; THIS module is the runtime consumer that, at every non-store side
// effect boundary, re-fetches a FRESH committed authority frame and evaluates the
// exact predicate for that boundary, failing loudly (never silently) on deny.
//
// FRESHNESS INVARIANT (fresh plan §3.2 "no authority witness is cached across a
// boundary; every semantic event requires an accepted successor graph before
// re-entry"): the caller MUST pass a frame captured immediately before the
// guarded effect. This gate never stores, memoizes, or reuses a frame; each call
// is a point-in-time re-evaluation. A gate instance holds only the pure predicate
// functions, so it can never leak a stale witness.
//
// This module performs NO I/O, Date, Git, or store access itself: the authority
// frame is supplied by the caller (built by the coordinator authority-frame read
// — Lane B's committed-state query — closed over the run context). Keeping the
// gate pure means the boundary-by-boundary wiring is deterministically testable
// with an injected frame, exactly like the predicate it wraps.

/**
 * The closed committed authority frame the coordinator read supplies for one
 * point-in-time gate evaluation. It is the union of the predicate's graph/policy/
 * heartbeat/session tuples plus the current global/row stop reasons and run
 * state. The runtime NEVER derives these booleans itself (that would be an
 * alternate authority); they come verbatim from the coordinator's committed
 * state read.
 */
export interface D65DispatchAuthorityFrame {
  readonly global_stop_reasons: readonly D65StopReason[];
  readonly row_stop_reasons: readonly D65StopReason[];
  readonly run_state: CoordinationRunStatus;
  readonly graph: D65GraphTuple;
  readonly policy: D65PolicyTuple;
  readonly heartbeat: D65HeartbeatTuple;
  readonly session: D65SessionAuthorityFrame;
}

/**
 * Every ordinary (model/product/new-work) side-effect boundary D65-I5 enumerates.
 * Each is an ORDINARY dispatch boundary: it requires a fully-current authority
 * frame (empty stop reasons, active run, current complete graph with no pending
 * publication, current policy, governing heartbeat with a healthy provider, and
 * current session/version/lease/cap). Naming each boundary makes the deny error
 * name the exact site fenced.
 */
export type D65OrdinaryBoundary =
  | 'activation-bootstrap'            // prepareAutopilotWorkstream, before attach
  | 'main-worktree-preparation'       // main worktree creation
  | 'parent-planning'                 // parent planning dispatch
  | 'config-write'                    // config writes
  | 'scheduler-dispatch'              // scheduler selecting the next unit
  | 'checkout-disk-estimate'          // checkout/disk projection before creation
  | 'runner-preflight'                // agent-runner before preflightSpec
  | 'missing-worktree-creation'       // runner before missing-worktree creation
  | 'post-acquisition-output'         // post-claim-acquisition, before output/materialization
  | 'parent-model-spawn'              // every parent model dispatch
  | 'child-model-spawn'               // every child model dispatch
  | 'ordinary-state-advance'          // ordinary state writer / advancement
  | 'unit-merge'                      // merge into main
  | 'unit-reset'                      // reset a source-changing worktree
  | 'unit-quarantine'                 // quarantine untrusted output
  | 'unit-release';                   // ordinary claim/worktree release

/**
 * The recovery boundaries. Each maps to exactly one frozen recovery cell in the
 * default-deny `recoveryTransitionAllowed` predicate. A recovery boundary is NOT
 * an ordinary dispatch: it must never authorize a model call, product/source
 * mutation, new-work claim/acquisition, or ordinary child registration.
 */
export type D65RecoveryBoundary =
  | 'accept-program-heartbeat'
  | 'register-authoritative-artifact'
  | 'graph-publication'
  | 'unit-recovery'
  | 'register-attempt'
  | 'planned-handoff'
  | 'parent-loss'
  | 'cancel-run-terminal'
  | 'terminal-tail';

const RECOVERY_BOUNDARY_TO_ACTION: Readonly<Record<D65RecoveryBoundary, D65RecoveryAction>> = Object.freeze({
  'accept-program-heartbeat': 'accept-program-heartbeat',
  'register-authoritative-artifact': 'register-authoritative-artifact',
  'graph-publication': 'graph-publication',
  'unit-recovery': 'unit-recovery',
  'register-attempt': 'register-attempt',
  'planned-handoff': 'planned-handoff',
  'parent-loss': 'parent-loss',
  'cancel-run-terminal': 'cancel-run-terminal',
  'terminal-tail': 'terminal-tail',
});

/** A loud, authority-critical failure raised when a boundary is fenced. */
export class D65DispatchFencedError extends CoordinationRuntimeError {
  readonly boundary: string;
  readonly kind: 'ordinary' | 'recovery';
  readonly deniedBy: readonly string[];

  constructor(kind: 'ordinary' | 'recovery', boundary: string, deniedBy: readonly string[], detail: readonly string[]) {
    super('invalid-state', `d65-dispatch-gate: ${kind} boundary '${boundary}' is fenced by the D65 dispatch predicate`, [
      `denied_by=${deniedBy.join(',')}`,
      ...detail,
    ]);
    this.boundary = boundary;
    this.kind = kind;
    this.deniedBy = Object.freeze([...deniedBy]);
  }
}

/**
 * Evaluate the ORDINARY dispatch predicate for `boundary` against a FRESH
 * committed authority frame. Returns the closed verdict; use `assertOrdinary…`
 * to fail loud. Never caches the frame.
 */
export function evaluateOrdinaryBoundary(boundary: D65OrdinaryBoundary, frame: D65DispatchAuthorityFrame): D65OrdinaryDispatchVerdict {
  void boundary; // the boundary names the site; the predicate is boundary-agnostic for ordinary dispatch
  const input: D65OrdinaryDispatchInput = {
    global_stop_reasons: frame.global_stop_reasons,
    row_stop_reasons: frame.row_stop_reasons,
    run_state: frame.run_state,
    graph: frame.graph,
    policy: frame.policy,
    heartbeat: frame.heartbeat,
    session: frame.session,
  };
  return ordinaryDispatchAllowed(input);
}

/**
 * Fail-closed ordinary gate: throw `D65DispatchFencedError` unless the boundary
 * is allowed. Call this FRESHLY immediately before the guarded side effect; do
 * not hoist it or reuse a prior result across a boundary.
 */
export function assertOrdinaryBoundaryAllowed(boundary: D65OrdinaryBoundary, frame: D65DispatchAuthorityFrame): void {
  const verdict = evaluateOrdinaryBoundary(boundary, frame);
  if (!verdict.allowed) {
    throw new D65DispatchFencedError('ordinary', boundary, verdict.denied_by, [`run_state=${frame.run_state}`]);
  }
}

/**
 * Evaluate the default-deny RECOVERY predicate for `boundary` against a FRESH
 * committed authority frame + the recovery bindings for that cell. Returns the
 * closed verdict.
 */
export function evaluateRecoveryBoundary(boundary: D65RecoveryBoundary, frame: D65DispatchAuthorityFrame, bindings: D65RecoveryBindings): D65RecoveryTransitionVerdict {
  const input: D65RecoveryTransitionInput = {
    action: RECOVERY_BOUNDARY_TO_ACTION[boundary],
    global_stop_reasons: frame.global_stop_reasons,
    row_stop_reasons: frame.row_stop_reasons,
    run_state: frame.run_state,
    graph: frame.graph,
    policy: frame.policy,
    heartbeat: frame.heartbeat,
    bindings,
  };
  return recoveryTransitionAllowed(input);
}

/**
 * Fail-closed recovery gate: throw `D65DispatchFencedError` unless the exact
 * frozen recovery cell for `boundary` permits the transition. Call this FRESHLY
 * at the recovery action's boundary; the default is deny.
 */
export function assertRecoveryBoundaryAllowed(boundary: D65RecoveryBoundary, frame: D65DispatchAuthorityFrame, bindings: D65RecoveryBindings): void {
  const verdict = evaluateRecoveryBoundary(boundary, frame, bindings);
  if (!verdict.allowed) {
    throw new D65DispatchFencedError('recovery', boundary, verdict.denied_by, [`run_state=${frame.run_state}`]);
  }
}
