import { CoordinationRuntimeError } from "./failures.js";
import { ordinaryDispatchAllowed, recoveryTransitionAllowed, } from "./d65-dispatch-predicates.js";
const RECOVERY_BOUNDARY_TO_ACTION = Object.freeze({
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
    boundary;
    kind;
    deniedBy;
    constructor(kind, boundary, deniedBy, detail) {
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
export function evaluateOrdinaryBoundary(boundary, frame) {
    void boundary; // the boundary names the site; the predicate is boundary-agnostic for ordinary dispatch
    const input = {
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
export function assertOrdinaryBoundaryAllowed(boundary, frame) {
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
export function evaluateRecoveryBoundary(boundary, frame, bindings) {
    const input = {
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
export function assertRecoveryBoundaryAllowed(boundary, frame, bindings) {
    const verdict = evaluateRecoveryBoundary(boundary, frame, bindings);
    if (!verdict.allowed) {
        throw new D65DispatchFencedError('recovery', boundary, verdict.denied_by, [`run_state=${frame.run_state}`]);
    }
}
