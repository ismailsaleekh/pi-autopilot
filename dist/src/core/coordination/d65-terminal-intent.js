import { canonicalJson } from "./canonical-json.js";
import { D65_TERMINAL_INTENT_V2_SCHEMA, TERMINAL_INTENT_CANCELLATION_MAX, parseD65RunTerminalIntentV2, parseD65TerminalEffectSets, } from "./d65-semantic-graph.js";
import { CoordinationRuntimeError } from "./failures.js";
// D65-A3 append-only terminal-intent v2 (freeze §9.1/§9.4, fresh plan terminal
// tail + transition matrix). These are the pure, store-independent computations:
// the append-only attempt chain (3-cancel bound + mandatory 4th abort), the
// deterministic v2 id, and the exact repository-wide obligation partition
// byte-matched against the request's sealed terminal_effect_sets.
/** The deterministic v2 intent id `terminal-intent:<run>:<20-digit-attempt>`. */
export function d65TerminalIntentId(workstreamRun, intentAttempt) {
    if (!Number.isSafeInteger(intentAttempt) || intentAttempt < 1)
        throw new CoordinationRuntimeError('invalid-request', 'terminal intent attempt must be a positive integer');
    return `terminal-intent:${workstreamRun}:${String(intentAttempt).padStart(20, '0')}`;
}
/**
 * Validate the requested append-only v2 attempt against the prior chain. The
 * next attempt is +1 of the latest, names its exact RFC-8785-plus-LF digest,
 * may only follow a cancelled latest (never a prepared/committed one), and the
 * 3-cancel bound forces attempt 4 to be a noncancellable abort.
 */
export function assertD65AppendOnlyAttempt(input) {
    const { attempts } = input.priorChain;
    const latest = attempts[attempts.length - 1];
    if (input.intentAttempt === 1) {
        if (latest !== undefined)
            throw new CoordinationRuntimeError('invalid-request', 'a first terminal intent attempt cannot follow an existing chain');
        if (input.priorTerminalIntentId !== null || input.priorTerminalIntentSha256 !== null)
            throw new CoordinationRuntimeError('invalid-request', 'attempt 1 must carry null prior chain fields');
        return;
    }
    if (latest === undefined)
        throw new CoordinationRuntimeError('invalid-request', 'a non-first terminal intent attempt requires a prior chain');
    // Contiguous +1 of the latest attempt.
    if (input.intentAttempt !== latest.intent_attempt + 1)
        throw new CoordinationRuntimeError('invalid-request', `terminal intent attempt must be exactly ${String(latest.intent_attempt + 1)}`);
    // The latest attempt must be cancelled; no new attempt after prepared/committed.
    if (latest.state !== 'cancelled')
        throw new CoordinationRuntimeError('invalid-state', `cannot append a new terminal intent after a ${latest.state} attempt`);
    // Prior id/digest bind the exact latest row bytes.
    const expectedId = d65TerminalIntentId(input.workstreamRun, latest.intent_attempt);
    if (input.priorTerminalIntentId !== expectedId)
        throw new CoordinationRuntimeError('invalid-request', 'prior_terminal_intent_id does not name the latest attempt');
    const expectedDigest = `sha256:${canonicalDigestHex(latest)}`;
    if (input.priorTerminalIntentSha256 !== expectedDigest)
        throw new CoordinationRuntimeError('invalid-request', 'prior_terminal_intent_sha256 does not bind the exact latest attempt bytes');
    // 3-cancel bound: after the third cancellation only attempt 4 abort may follow.
    const cancelledCount = attempts.filter((attempt) => attempt.state === 'cancelled').length;
    if (cancelledCount >= TERMINAL_INTENT_CANCELLATION_MAX) {
        if (input.intentAttempt !== TERMINAL_INTENT_CANCELLATION_MAX + 1)
            throw new CoordinationRuntimeError('invalid-state', 'no terminal intent attempt may follow the third cancellation except the mandatory fourth abort');
        if (input.outcome !== 'aborted')
            throw new CoordinationRuntimeError('invalid-state', 'the mandatory fourth terminal intent attempt must be a noncancellable abort');
    }
}
function canonicalDigestHex(value) {
    // RFC-8785-plus-LF SHA-256 over the complete prior row, computed by the caller
    // via canonicalJson; here we recompute deterministically from the parsed row.
    // Note: the store passes the exact stored row so the digest is byte-exact.
    return sha256HexOfCanonical(value);
}
// Lazily import crypto through a small helper so this module stays pure/testable.
import { createHash } from 'node:crypto';
function sha256HexOfCanonical(value) {
    return createHash('sha256').update(`${canonicalJson(value)}\n`, 'utf8').digest('hex');
}
/**
 * Compute the exact D65 obligation partition for a terminating run, keyed by the
 * intent's reservation set. Close permits only a nonempty foreign-dependent set;
 * abort permits foreign-dependent plus abort-owned sets. The result must
 * byte-equal the request's sealed terminal_effect_sets.
 */
export function computeD65ObligationPartition(input) {
    const reservationSet = new Set(input.intentReservationIds);
    const blocking = [];
    const foreignDependent = [];
    const abortOwned = [];
    const other = [];
    for (const obligation of input.nonterminalObligations) {
        const ownedByRun = obligation.workstream_run === input.workstreamRun;
        const dependsOnIntent = reservationSet.has(obligation.predecessor_reservation_id);
        if (ownedByRun) {
            if (input.outcome === 'aborted')
                abortOwned.push(obligation);
            else
                blocking.push(obligation);
        }
        else if (dependsOnIntent) {
            foreignDependent.push(obligation);
        }
        else {
            other.push(obligation);
        }
    }
    const sortById = (rows) => [...rows].sort((left, right) => (left.obligation_id < right.obligation_id ? -1 : left.obligation_id > right.obligation_id ? 1 : 0));
    // Every foreign-dependent row must be exactly waiting-for-predecessor.
    for (const obligation of foreignDependent)
        if (obligation.state !== 'waiting-for-predecessor')
            throw new CoordinationRuntimeError('invalid-state', `foreign-dependent obligation ${obligation.obligation_id} must be waiting-for-predecessor`);
    return {
        blocking_owned_obligations: Object.freeze(sortById(blocking).map((row) => Object.freeze({ ...row }))),
        foreign_dependent_obligations: Object.freeze(sortById(foreignDependent).map((row) => Object.freeze({ ...row }))),
        abort_owned_obligations: Object.freeze(sortById(abortOwned).map((row) => Object.freeze({ ...row }))),
        other_nonterminal_obligations: Object.freeze(sortById(other).map((row) => Object.freeze({ ...row }))),
    };
}
/**
 * Recompute the partition and require byte-equality against the request's sealed
 * sets. On close both blocking/other must be empty and abort-owned empty; on
 * abort blocking/other must be empty. Extra/missing/moved/wrong-owner/version
 * rows reject.
 */
export function assertD65TerminalEffectSetsExact(input) {
    const requested = parseD65TerminalEffectSets(input.requested, 'prepare-run-terminal.terminal_effect_sets');
    // Partition emptiness rules.
    if (requested.blocking_owned_obligations.length !== 0)
        throw new CoordinationRuntimeError('invalid-state', 'blocking_owned_obligations must be empty at terminal preparation');
    if (requested.other_nonterminal_obligations.length !== 0)
        throw new CoordinationRuntimeError('invalid-state', 'other_nonterminal_obligations must be empty at terminal preparation');
    if (input.outcome === 'closed' && requested.abort_owned_obligations.length !== 0)
        throw new CoordinationRuntimeError('invalid-state', 'close terminal preparation cannot carry abort-owned obligations');
    // Byte-equality against the recomputed partition.
    for (const key of ['blocking_owned_obligations', 'foreign_dependent_obligations', 'abort_owned_obligations', 'other_nonterminal_obligations']) {
        if (canonicalJson(requested[key]) !== canonicalJson(input.computed[key]))
            throw new CoordinationRuntimeError('invalid-state', `terminal_effect_sets.${key} does not byte-equal the recomputed repository-wide partition`);
    }
    return requested;
}
/** Build a fresh prepared v2 intent row (version 1) from validated inputs. */
export function buildD65PreparedTerminalIntentV2(input) {
    return parseD65RunTerminalIntentV2({
        schema_version: D65_TERMINAL_INTENT_V2_SCHEMA,
        terminal_intent_id: d65TerminalIntentId(input.workstreamRun, input.intentAttempt),
        repo_id: input.repoId,
        workstream_run: input.workstreamRun,
        intent_attempt: input.intentAttempt,
        prior_terminal_intent_id: input.priorTerminalIntentId,
        prior_terminal_intent_sha256: input.priorTerminalIntentSha256,
        outcome: input.outcome,
        state: 'prepared',
        reservation_ids: [...input.reservationIds],
        terminal_effect_sets: input.terminalEffectSets,
        prepared_event_seq: input.preparedEventSeq,
        terminal_event_seq: null,
        version: 1,
    });
}
