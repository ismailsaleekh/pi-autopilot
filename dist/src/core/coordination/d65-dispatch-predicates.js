import { D65_STOP_REASONS } from "./d65-launch-policy.js";
/** The nine recovery actions that have a frozen cell. */
export const D65_RECOVERY_ACTIONS = [
    'accept-program-heartbeat',
    'register-authoritative-artifact',
    'graph-publication',
    'unit-recovery',
    'register-attempt',
    'planned-handoff',
    'parent-loss',
    'cancel-run-terminal',
    'terminal-tail',
];
/** The six non-clearable blocker reasons (plus the seventh external-credential). */
export const D65_NONCLEARABLE_BLOCKERS = Object.freeze([
    'coordinator-blocked', 'coordinator-terminal', 'graph-cas-conflict',
    'parent-recovery-exhausted', 'unit-retry-exhausted', 'continuation-unclassified',
    'external-credential-blocked',
]);
/** Provider reasons that a cell may additionally tolerate as an "affecting provider reason". */
const PROVIDER_REASONS = Object.freeze(['provider-blocked', 'provider-exhausted']);
/**
 * The exact covered semantic (graph-liveness) reasons a `graph-publication`
 * stage may carry beside `graph-publication-pending` (fresh plan §2.3 line 173:
 * "the covered semantic reason"; §3.2 continuation/liveness reasons). A
 * `covered_semantic_reason` binding outside this set is rejected so a caller can
 * never smuggle a forbidden reason (e.g. policy-invalid) through the binding.
 */
const GRAPH_COVERED_SEMANTIC_REASONS = Object.freeze(['graph-incomplete', 'graph-drift', 'progress-stale']);
/**
 * The exact legal `accepted_continuation_reason` values for the
 * continuation/parent-loss/probe `register-authoritative-artifact` cell (fresh
 * plan §2.3 line 172; §3.2 row-reason column at lines 279-285). It is a
 * non-provider, non-blocker semantic continuation row reason. The six/seven
 * non-clearable blockers (line 181) and provider reasons are EXCLUDED so the
 * required-reason exemption can never be used to smuggle a blocker or a second
 * provider reason. `unit-recovering` is handled as an explicit optional extra,
 * not as the accepted continuation reason itself.
 */
const LEGAL_ACCEPTED_CONTINUATION_REASONS = Object.freeze([
    'parent-recovering', 'handoff-pending', 'terminal-tail', 'graph-incomplete', 'graph-drift', 'progress-stale',
]);
// ---- reason-array validation (fail-closed) ----------------------------------
/** True iff `reasons` is a complete decoded-byte-sorted array of unique known reasons. */
function isSortedUniqueKnownReasons(reasons) {
    for (let index = 0; index < reasons.length; index += 1) {
        const reason = reasons[index];
        if (reason === undefined || !D65_STOP_REASONS.includes(reason))
            return false;
        if (index > 0) {
            const previous = reasons[index - 1];
            if (previous === undefined || !(previous < reason))
                return false; // strictly increasing = sorted + unique
        }
    }
    return true;
}
function includesReason(reasons, reason) {
    return reasons.includes(reason);
}
/** At most one provider reason and nothing else beyond `required` (all `required` present). */
function isRequiredPlusOptionalProvider(reasons, required) {
    return isRequiredPlusOptional(reasons, required, []);
}
/**
 * True iff `reasons` contains every entry of `required`, plus at most one provider
 * reason, plus any subset of the exact `extraAllowed` set (each at most once — the
 * sorted-unique precheck guarantees uniqueness), and NOTHING else. This encodes the
 * frozen "exactly <required> plus only its affecting provider reason and/or <extra>"
 * shapes where a single provider reason is tolerated and no other reason is legal.
 */
function isRequiredPlusOptional(reasons, required, extraAllowed) {
    let providerCount = 0;
    for (const reason of reasons) {
        if (required.includes(reason))
            continue;
        if (extraAllowed.includes(reason))
            continue;
        if (PROVIDER_REASONS.includes(reason)) {
            providerCount += 1;
            continue;
        }
        return false;
    }
    for (const req of required)
        if (!reasons.includes(req))
            return false;
    return providerCount <= 1;
}
/**
 * Total. True iff global/row reasons are empty, run is active, the complete
 * graph is current with no pending publication, policy is current, the governing
 * heartbeat is current with a healthy provider, and session/version/lease/cap are
 * all current. A malformed (unsorted/duplicate/unknown) reason array fails
 * closed. Never throws.
 */
export function ordinaryDispatchAllowed(input) {
    const denied = [];
    if (!isSortedUniqueKnownReasons(input.global_stop_reasons) || !isSortedUniqueKnownReasons(input.row_stop_reasons)) {
        return { allowed: false, denied_by: Object.freeze(['malformed-reasons']) };
    }
    if (input.global_stop_reasons.length !== 0)
        denied.push('global-stop-nonempty');
    if (input.row_stop_reasons.length !== 0)
        denied.push('row-stop-nonempty');
    if (input.run_state !== 'active')
        denied.push('run-not-active');
    if (!input.graph.complete_graph_current)
        denied.push('graph-not-current');
    if (input.graph.graph_publication_pending)
        denied.push('graph-publication-pending');
    if (!input.policy.policy_current)
        denied.push('policy-not-current');
    if (!input.heartbeat.governing_heartbeat_current)
        denied.push('heartbeat-not-governing');
    if (input.heartbeat.provider_state !== 'healthy')
        denied.push('provider-not-healthy');
    if (!input.session.attached_session_current)
        denied.push('session-not-current');
    if (!input.session.expected_version_current)
        denied.push('expected-version-stale');
    if (!input.session.lease_current)
        denied.push('lease-not-current');
    if (!input.session.cap_current)
        denied.push('cap-not-current');
    if (denied.length === 0)
        return { allowed: true };
    return { allowed: false, denied_by: Object.freeze(denied) };
}
const TERMINAL_RUN_STATES = Object.freeze(['closed', 'aborted']);
function deny(reasons) {
    return { allowed: false, denied_by: Object.freeze([...reasons]) };
}
function allow(action) {
    return { allowed: true, action };
}
/**
 * Total. False by default; permits ONLY the exact frozen table cell for `action`.
 * Every reason array must be complete decoded-byte-sorted unique or the verdict
 * is `malformed-reasons`. An impossible `action` (defeating the type) returns
 * `unknown-action` rather than throwing. Never authorizes a model/product/new-work
 * boundary.
 */
export function recoveryTransitionAllowed(input) {
    if (!isSortedUniqueKnownReasons(input.global_stop_reasons) || !isSortedUniqueKnownReasons(input.row_stop_reasons)) {
        return deny(['malformed-reasons']);
    }
    const { action, global_stop_reasons: global, row_stop_reasons: row, run_state, graph, policy, heartbeat, bindings } = input;
    const runNonterminal = !TERMINAL_RUN_STATES.includes(run_state);
    const denials = [];
    switch (action) {
        case 'accept-program-heartbeat': {
            // Liveness-only: global [] or exactly [heartbeat-stale]; nonterminal run;
            // current attached session/capability; current policy/trust; NONE of the
            // five hard blockers in row reasons. Row reasons may otherwise be ANY
            // sorted subset (including the non-clearable blockers) — acceptance never
            // resolves them.
            const globalOk = global.length === 0 || (global.length === 1 && global[0] === 'heartbeat-stale');
            if (!globalOk)
                denials.push('global-reasons-not-permitted');
            const forbiddenRow = ['operator-stop', 'identity-drift', 'policy-invalid', 'cap-violation', 'coordinator-terminal'];
            if (row.some((reason) => forbiddenRow.includes(reason)))
                denials.push('row-reasons-not-permitted');
            if (!runNonterminal)
                denials.push('run-terminal');
            if (!bindings.attached_session_current)
                denials.push('session-not-current');
            if (!bindings.policy_trust_current)
                denials.push('policy-trust-not-current');
            return denials.length === 0 ? allow(action) : deny(denials);
        }
        case 'register-authoritative-artifact': {
            // Continuation/parent-loss/probe recovery registration. global []; row ⊆
            // {accepted continuation reason} ∪ {affecting provider reason} ∪
            // {unit-recovering}; complete graph/policy/session current; no pending
            // publication.
            if (global.length !== 0)
                denials.push('global-reasons-not-permitted');
            // Row is EXACTLY the accepted continuation reason (mandatory) plus only an
            // affecting provider reason and/or `unit-recovering`; nothing else. The
            // continuation reason must be present AND drawn from the legal continuation
            // set (never a non-clearable blocker or provider reason, which would
            // otherwise be smuggled through the required-reason exemption).
            const continuationReason = bindings.accepted_continuation_reason;
            if (continuationReason === null || !LEGAL_ACCEPTED_CONTINUATION_REASONS.includes(continuationReason) || !isRequiredPlusOptional(row, [continuationReason], ['unit-recovering']))
                denials.push('row-reasons-not-permitted');
            if (!graph.complete_graph_current)
                denials.push('graph-not-current');
            if (!policy.policy_current)
                denials.push('policy-trust-not-current');
            if (!bindings.attached_session_current)
                denials.push('session-not-current');
            if (!bindings.no_pending_publication)
                denials.push('pending-publication');
            return denials.length === 0 ? allow(action) : deny(denials);
        }
        case 'graph-publication': {
            // global []; row is exactly graph-publication-pending plus optionally the
            // covered semantic reason and/or a provider reason, and nothing else the
            // frozen list forbids; publication pending; prior graph/policy/session
            // current. Semantic covered reasons are the graph-liveness reasons.
            // Row is EXACTLY graph-publication-pending plus THE (single) covered semantic
            // reason and/or a single provider reason; nothing else, and none of the
            // coordinator-terminal/integrity/cap/policy/lease reasons. The prior graph
            // (as well as policy/session) must be current AND the publication pending.
            if (global.length !== 0)
                denials.push('global-reasons-not-permitted');
            // The covered semantic reason, when present, must be drawn from the exact
            // graph-liveness set; any other value (e.g. policy-invalid) is rejected so
            // it cannot be smuggled in as a "required" reason.
            const coveredSemantic = bindings.covered_semantic_reason;
            const semanticBindingLegal = coveredSemantic === null || GRAPH_COVERED_SEMANTIC_REASONS.includes(coveredSemantic);
            const semanticRequired = coveredSemantic !== null ? [coveredSemantic] : [];
            if (!semanticBindingLegal || !includesReason(row, 'graph-publication-pending') || !isRequiredPlusOptional(row, ['graph-publication-pending', ...semanticRequired], []))
                denials.push('row-reasons-not-permitted');
            if (!graph.complete_graph_current)
                denials.push('graph-not-current');
            if (!graph.graph_publication_pending)
                denials.push('graph-publication-not-pending');
            if (!policy.policy_current)
                denials.push('policy-trust-not-current');
            if (!bindings.attached_session_current)
                denials.push('session-not-current');
            return denials.length === 0 ? allow(action) : deny(denials);
        }
        case 'unit-recovery': {
            // global []; row is unit-recovering plus at most an affecting provider
            // reason and nothing else; session current.
            if (global.length !== 0)
                denials.push('global-reasons-not-permitted');
            if (!isRequiredPlusOptionalProvider(row, ['unit-recovering']))
                denials.push('row-reasons-not-permitted');
            if (!bindings.attached_session_current)
                denials.push('session-not-current');
            return denials.length === 0 ? allow(action) : deny(denials);
        }
        case 'register-attempt': {
            // The singleton probe-consumption exception. global []; row exactly
            // [provider-blocked]; provider retry-authorized; graph/policy/session
            // current; no pending publication. No filesystem/lease/child/model effect.
            if (global.length !== 0)
                denials.push('global-reasons-not-permitted');
            if (!(row.length === 1 && row[0] === 'provider-blocked'))
                denials.push('row-reasons-not-permitted');
            if (heartbeat.provider_state !== 'retry-authorized')
                denials.push('provider-state-not-permitted');
            if (!graph.complete_graph_current)
                denials.push('graph-not-current');
            if (!policy.policy_current)
                denials.push('policy-trust-not-current');
            if (!bindings.attached_session_current)
                denials.push('session-not-current');
            if (!bindings.no_pending_publication)
                denials.push('pending-publication');
            return denials.length === 0 ? allow(action) : deny(denials);
        }
        case 'planned-handoff': {
            // global []; row is handoff-pending plus at most a provider reason and
            // nothing else; graph/policy/heartbeat current; session current.
            if (global.length !== 0)
                denials.push('global-reasons-not-permitted');
            if (!isRequiredPlusOptionalProvider(row, ['handoff-pending']))
                denials.push('row-reasons-not-permitted');
            if (!graph.complete_graph_current)
                denials.push('graph-not-current');
            if (!policy.policy_current)
                denials.push('policy-trust-not-current');
            if (!heartbeat.governing_heartbeat_current)
                denials.push('provider-state-not-permitted');
            if (!bindings.attached_session_current)
                denials.push('session-not-current');
            return denials.length === 0 ? allow(action) : deny(denials);
        }
        case 'parent-loss': {
            // global []; row is parent-recovering plus at most a provider reason and
            // nothing else; graph/policy/heartbeat current; session current.
            if (global.length !== 0)
                denials.push('global-reasons-not-permitted');
            if (!isRequiredPlusOptionalProvider(row, ['parent-recovering']))
                denials.push('row-reasons-not-permitted');
            if (!graph.complete_graph_current)
                denials.push('graph-not-current');
            if (!policy.policy_current)
                denials.push('policy-trust-not-current');
            if (!heartbeat.governing_heartbeat_current)
                denials.push('provider-state-not-permitted');
            if (!bindings.attached_session_current)
                denials.push('session-not-current');
            return denials.length === 0 ? allow(action) : deny(denials);
        }
        case 'cancel-run-terminal': {
            // global []; row [terminal-tail] plus at most one provider reason; run
            // merging; current attempt prepared and cancellable 1-3.
            if (global.length !== 0)
                denials.push('global-reasons-not-permitted');
            if (!isRequiredPlusOptionalProvider(row, ['terminal-tail']))
                denials.push('row-reasons-not-permitted');
            if (run_state !== 'merging')
                denials.push('run-terminal');
            if (!bindings.terminal_prepared_cancellable)
                denials.push('binding-precondition-unmet');
            return denials.length === 0 ? allow(action) : deny(denials);
        }
        case 'terminal-tail': {
            // global []; before commit row is [terminal-tail] plus ≤1 provider reason;
            // after commit row is [row-closed,terminal-tail] plus ≤1 provider reason.
            // attach-terminal-recovery may additionally carry lease-invalid.
            if (global.length !== 0)
                denials.push('global-reasons-not-permitted');
            const required = bindings.terminal_after_commit
                ? ['row-closed', 'terminal-tail']
                : ['terminal-tail'];
            // lease-invalid is tolerated ONLY when the action boundary is
            // attach-terminal-recovery; ordinary terminal-tail commit/cleanup/detach
            // frames may not carry it.
            const extraAllowed = bindings.attach_terminal_recovery ? ['lease-invalid'] : [];
            if (!isRequiredPlusOptional(row, required, extraAllowed))
                denials.push('row-reasons-not-permitted');
            return denials.length === 0 ? allow(action) : deny(denials);
        }
        default: {
            // Total fail-closed default for an impossible action value.
            return deny(['unknown-action']);
        }
    }
}
