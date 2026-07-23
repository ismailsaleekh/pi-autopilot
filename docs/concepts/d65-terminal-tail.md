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
signature_hash: 'sha256:e739fe96e4adda1e466f01c9c993d956ab1fdb90536654a4b6297a59d967942a'
body_hash: 'sha256:b19dfa6600e367b80341e523d8a71038e22fd610d2fbac1f871209d51c7bfc28'
semantic_attestation: 'sha256:b19dfa6600e367b80341e523d8a71038e22fd610d2fbac1f871209d51c7bfc28'
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
`prepared` or `committed` attempt.

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

On close, foreign-dependent obligations remain as honest `waiting-for-predecessor`
records handed to their successors — closing a run does not silently discharge another
run's dependency. On abort, abort-owned obligations are released as part of the sealed
abort set. Both outcomes are byte-checked against the recomputed partition.

## Post-main-removal terminal recovery

If the run-main worktree is removed while a terminal intent is outstanding, terminal
recovery resumes from the committed append-only chain and the sealed effect sets — not
from a rescan of the (now absent) worktree. The recovery drivers in
`d65-graph-successor-runtime.ts` load exclusively from committed artifacts and sealed
candidates (never a worktree scan), so authority comes from the committed chain and a
missing worktree is a recovery input, never a reason to invent successor state — there
is **no fabricated graph after worktree removal**.

## Invariants

- No attempt follows the third cancellation except the mandatory fourth abort.
- No fabricated graph or successor is produced after worktree removal.
- The tail is contiguous and non-reentrant; the terminal-tail cell has no ordinary
  dispatch effects.
- Never hand-edit the terminal-intent chain, forge a prior digest, or rewrite
  coordinator rows to force a close/abort.

## Enforced in

- `src/core/coordination/d65-terminal-intent.ts`,
  `src/core/coordination/d65-graph-successor.ts`,
  `src/core/coordination/d65-graph-successor-runtime.ts`,
  `src/core/coordination/terminal-attempt-proof.ts`.

## Related

- [terminal-evidence.md](terminal-evidence.md),
  [semantic-graph-authority.md](semantic-graph-authority.md),
  [dispatch-and-recovery-authority.md](dispatch-and-recovery-authority.md)
- Subsystem: [`../subsystems/close-lifecycle.md`](../subsystems/close-lifecycle.md)
