---
doc_id: concepts/deadlock
mode: mixed
review_policy: behavioral
covers_surfaces: []
covers_sources:
  - src/core/coordination/deadlock.ts
signature_hash: 'sha256:9766db34befae19994853481579db521d05a6e2155c560cecdbedef60e654c3c'
body_hash: 'sha256:e2d9297fef650edd3aa669a5cb9968faa882e2e1678b7c504873c9ef3d05b5a9'
semantic_attestation: 'sha256:e2d9297fef650edd3aa669a5cb9968faa882e2e1678b7c504873c9ef3d05b5a9'
fact_pins:
  - text: `MAX_GRANT_BYPASSES` is 8
    symbol: 'src/core/coordination/deadlock.ts#MAX_GRANT_BYPASSES'
    expect: 8
stability: stable
---

# Concept: Wait-For Graph and Deadlock Resolution

This module (`deadlock.ts`) **builds** a transactional wait-for edge for every live
blocking request (`buildCoordinationWaitForEdges`), **detects** strongly connected
cycles (`detectCoordinationWaitCycles`), and **selects** a safe victim
(`selectCoordinationDeadlockVictim`). The surrounding coordinator persists the edges and
applies the recommended action in one transaction; those caller behaviors are noted here
as context but are enforced outside this module. The design goal is that no routine
deadlock becomes an operator question.

## What participates

`buildCoordinationWaitForEdges` creates a wait-for edge for every non-terminal blocking
request whose claim mode conflicts with a held lease over overlapping paths
(`claimModesConflict` + `coordinationPathsOverlap`). The precise per-mode conflict rules
(WRITE / EXCLUSIVE / READ) and acquisition-group expansion policy live in the
coordination [contracts and reservations](leases-and-observations.md); this module
consumes them to build the graph.

## Safe-victim selection

Safe victims are selected mechanically by victim class, durable child checkpoint
(`checkpoint_ordinal`), starvation protection (`bypass_count`), live-cycle grant order
(`newest_grant_event_seq`, descending), and stable owner identity. An attempt is
excluded from victim selection when it holds **any** active critical section
(`critical_section !== null`) or an active Git critical operation. The Git critical
operations are `merge`, `reset`, `quarantine`, `archive`, `remove`, and
`metadata-reconcile`. Dirty preflight worktrees (victim class 2 requires no unit
worktree) and non-preemptible running work (victim class 3 requires `preemptible`) are
likewise never clean victims. Victim class 1 covers attempts with a `recovery-required`
child lease or an attempt in the `failed` state; class 2 covers queued/preflight
attempts without a running child or unit worktree; class 3 covers running, preemptible,
checkpointed attempts with a running child.

## No-safe-victim cycles

When no attempt in a cycle qualifies, `selectCoordinationDeadlockVictim` returns no
victim (`null`). This module does not escalate; the surrounding coordinator (outside
this doc's covered source) is what keeps the cycle deferred at its earliest declared
release condition rather than turning it into an operator question.

## Starvation bound

Victim ranking reads each live acquisition group's `bypass_count`. `MAX_GRANT_BYPASSES` is 8:
in `compareCoordinationGrantPriority`, once `bypass_count >= MAX_GRANT_BYPASSES` a group's
starvation key collapses to zero so it sorts ahead of non-starved groups in the
grant-priority comparison. The comparator ranks priority only; complete-set availability
and the `bypass_count` increment happen in the caller's grant-decision path, not in this
module (there is no increment operation in `deadlock.ts`).

## Enforced in

- `src/core/coordination/deadlock.ts` (`buildCoordinationWaitForEdges`,
  `detectCoordinationWaitCycles`, `selectCoordinationDeadlockVictim`).

## Related

- [leases-and-observations.md](leases-and-observations.md)
- Subsystem: [`../subsystems/coordination.md`](../subsystems/coordination.md)
