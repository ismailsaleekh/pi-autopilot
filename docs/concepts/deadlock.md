---
doc_id: concepts/deadlock
mode: mixed
review_policy: behavioral
covers_surfaces: []
covers_sources:
  - src/core/coordination/deadlock.ts
signature_hash: 'sha256:9766db34befae19994853481579db521d05a6e2155c560cecdbedef60e654c3c'
body_hash: 'sha256:e2d9297fef650edd3aa669a5cb9968faa882e2e1678b7c504873c9ef3d05b5a9'
fact_pins:
  - text: `MAX_GRANT_BYPASSES` is 8
    symbol: 'src/core/coordination/deadlock.ts#MAX_GRANT_BYPASSES'
    expect: 8
stability: stable
---

# Concept: Wait-For Graph and Deadlock Resolution

The fabric persists a transactional wait-for edge for every live blocking request and
resolves strongly connected cycles to a same-transaction fixed point. No routine
deadlock ever becomes an operator question.

## What participates

- Each attempt has one immutable initial acquisition group; later WRITE/EXCLUSIVE
  expansion is rejected, while materialization expansion is explicitly typed and
  observation-only.
- READ creates no ordinary edit wait edge; it participates only when an overlapping
  bounded EXCLUSIVE critical section is active.

## Safe-victim selection

Safe victims are selected mechanically by victim class, durable child checkpoint,
starvation protection, live-cycle grant order, and stable identity. Never cancelled as
clean victims: merge/reset/quarantine/archive/remove critical sections, dirty preflight
worktrees, and non-preemptible running work. Child registration/checkpoint transitions
make running preemption reachable; heartbeat delivers a durable stop request; edit
authority remains until reset or immutable quarantine evidence.

## No-safe-victim cycles

Cycles with no safe victim remain explicitly `deferred-no-safe-victim` at the earliest
declared release condition — never an operator question.

## Starvation bound

Scheduling snapshots increment `bypass_count` exactly once per otherwise-eligible losing
decision. `MAX_GRANT_BYPASSES` is 8: at that bound, a group takes priority over newer
groups whenever its complete set is free.

## Enforced in

- `src/core/coordination/deadlock.ts` (`buildCoordinationWaitForEdges`,
  `detectCoordinationWaitCycles`, `selectCoordinationDeadlockVictim`).

## Related

- [leases-and-observations.md](leases-and-observations.md)
- Subsystem: [`../subsystems/coordination.md`](../subsystems/coordination.md)
