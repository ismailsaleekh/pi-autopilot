---
doc_id: concepts/d65-terminal-tail
mode: authored
review_policy: behavioral
covers_surfaces: []
covers_sources:
  - src/core/coordination/d65-terminal-intent.ts
  - src/core/coordination/d65-graph-successor.ts
  - src/core/coordination/d65-graph-successor-runtime.ts
  - src/core/coordination/terminal-attempt-proof.ts
  - src/core/coordination/d65-semantic-graph.ts
  - src/core/coordination/d65-dispatch-gate.ts
signature_hash: 'sha256:06405c9702acc763c5a0da285e9ebc2b81817116df945f1e2e6933d9925882d4'
body_hash: 'sha256:c28c649cdf388c31a73f689f888835778eb5fa686be25637b988e5b13be5a84a'
semantic_attestation: 'sha256:c28c649cdf388c31a73f689f888835778eb5fa686be25637b988e5b13be5a84a'
stability: evolving
---

# Concept: D65 Terminal Tail

The **terminal tail** is the closed sequence by which a D65 run reaches a committed
close or abort. It is append-only, bounded, non-reentrant, and byte-exact against the
run's sealed terminal effect sets.

## Append-only terminal intent v2

Terminal intent under D65 is the append-only `autopilot.run_terminal_intent.v2` chain.
Each attempt has a deterministic id `terminal-intent:<run>:<20-digit-attempt>` and is
contiguous `+1` of the latest attempt. A non-first attempt must name the exact prior
attempt's id and bind the exact prior row bytes by `sha256:` digest
(`prior_terminal_intent_sha256`); a first attempt must carry null prior fields. A new
attempt may only follow a **cancelled** latest attempt — nothing may follow a
`prepared` or `committed` attempt. Every terminal-intent row also uses the shared
closed lowercase repo-id and ASCII alphanumeric-or-hyphen workstream-run grammars.

## Cancellation attempts 1–3 and the mandatory abort

The chain is bounded by the `TERMINAL_INTENT_CANCELLATION_MAX` rule
(`d65-semantic-graph.ts` defines the value `3`). After the third cancellation, the only
attempt that may follow is attempt 4, and that fourth attempt **must** be a
noncancellable `aborted` outcome (`d65-terminal-intent.ts` `assertD65AppendOnlyAttempt`).
There is no attempt 5 and no fourth cancellation: the tail terminates deterministically.

## Exact obligation partition

At terminal preparation the run's nonterminal obligations are partitioned, keyed by the
intent's reservation set, into blocking-owned, foreign-dependent, abort-owned, and
other sets. The recomputed partition must **byte-equal** the request's sealed
`terminal_effect_sets`:

- Every foreign-dependent obligation must be exactly `waiting-for-predecessor`.
- `blocking_owned` and `other_nonterminal` must be empty at preparation.
- A **close** may carry only a (possibly empty) foreign-dependent set and no
  abort-owned obligations; an **abort** may carry foreign-dependent plus abort-owned.
- Extra, missing, moved, wrong-owner, or wrong-version rows reject loudly.

## Successor graph before terminal entry

The terminal transition operates on current committed authority: the D65 close/abort
runtime produces and registers a successor graph before entering the terminal tail (the
ordering is driven by the close-lifecycle runtime; see the enforcement pointer below).
Within the covered sources, `d65-graph-successor.ts` enforces that there is at most one
current terminal intent (`prepared` or `committed`): a coordinator export carrying more
than one current terminal intent is rejected (`fail('coordinator export has more than
one current terminal intent')`).

## Contiguous no-reentry tail

Once the run enters the terminal tail the sequence is **contiguous and
non-reentrant**: attempts advance by exact `+1` steps against the sealed prior row
(`d65-terminal-intent.ts`), and the run cannot re-enter ordinary dispatch. `terminal-tail`
is one of the default-deny recovery boundaries in `d65-dispatch-gate.ts`
(`D65RecoveryBoundary`); like every recovery cell it authorizes no model, product, or
new-work effect (see
[dispatch-and-recovery-authority.md](dispatch-and-recovery-authority.md)).

## Close / abort foreign obligation effects

The pure terminal-intent contract preserves foreign-dependent rows as exact
`waiting-for-predecessor` entries and classifies run-owned abort obligations into the
sealed abort set. It byte-checks both outcomes against the recomputed partition; the
covered pure sources do not themselves claim to apply successor handoff or obligation
release side effects.

## Separate terminal attempt evidence

`terminal-attempt-proof.ts` validates the structured terminal attempt package — spec,
status, receipt, audit, and terminal-acceptance evidence — before it can serve as
terminal proof. That evidence proof is separate from the append-only intent-chain and
obligation-partition computations above.

## Invariants

- No attempt follows the third cancellation except the mandatory fourth abort.
- The tail is contiguous and non-reentrant; the terminal-tail cell has no ordinary
  dispatch effects.
- Never hand-edit the terminal-intent chain, forge a prior digest, or rewrite
  coordinator rows to force a close/abort.

## Enforced in

- `src/core/coordination/d65-terminal-intent.ts`,
  `src/core/coordination/d65-graph-successor.ts`,
  `src/core/coordination/d65-graph-successor-runtime.ts`,
  `src/core/coordination/terminal-attempt-proof.ts` (structured attempt evidence).

## Related

- [terminal-evidence.md](terminal-evidence.md),
  [semantic-graph-authority.md](semantic-graph-authority.md),
  [dispatch-and-recovery-authority.md](dispatch-and-recovery-authority.md)
- Subsystem: [`../subsystems/close-lifecycle.md`](../subsystems/close-lifecycle.md)
