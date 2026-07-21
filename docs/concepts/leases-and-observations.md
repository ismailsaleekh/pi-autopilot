---
doc_id: concepts/leases-and-observations
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Concept: Observations, Edit Leases, and EXCLUSIVE

Autopilot separates three kinds of claim so that file-disjoint work parallelizes freely
while genuinely shared critical sections serialize.

## The three authority kinds

| Kind | Meaning | Blocks peers? |
|---|---|---|
| **READ observation** | A non-blocking record of an exact Git commit + blob/tree identity for a tracked read path. | No |
| **WRITE edit lease** | A speculative edit intention in an isolated worktree. Overlapping WRITE leases are legal. | No |
| **EXCLUSIVE** | A bounded, package-declared critical section (one tracked owned file, closed operation kind/id, ≤5-minute expected interval, paired WRITE layer, non-preemptible attempt checkpoint). | Yes |

## Why the split matters

READ entries become observations only after their exact Git commit plus blob/tree
identity is revalidated — so a "read" can never silently authorize a write. WRITE
intentions overlap because each unit edits in its own worktree; conflicts are resolved
at integration time (see [reservations](reservations.md)), not by blocking launch. Only
bounded EXCLUSIVE critical sections create blocking-owner requests and participate in the
[deadlock](deadlock.md) wait-for graph.

## Rules that must not regress

- **WRITE scope never expands silently.** A child needing a new edit path must emit a
  blocker so the parent/spec amends scope or creates a new attempt.
- **Age never authorizes release.** Expired heartbeats are classification evidence only;
  they never release ambiguous WRITE/EXCLUSIVE authority.
- **EXCLUSIVE auto-releases** at critical-section exit or trusted terminal recovery;
  ordinary WRITE remains until merge/reset/quarantine.
- **Routine unit specs cannot create EXCLUSIVE authority**; malformed or broad runtime
  locks fail closed rather than being reclaimed from age.

## Enforced in

- `src/core/authority.ts` (derivation), `src/core/coordination/reservations.ts`,
  `src/core/coordination/exclusive-policy.ts`, `src/core/coordination/observations.ts`.

## Related

- [reservations.md](reservations.md), [deadlock.md](deadlock.md)
- Subsystem: [`../subsystems/coordination.md`](../subsystems/coordination.md)
