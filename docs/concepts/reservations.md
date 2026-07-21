---
doc_id: concepts/reservations
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Concept: Change Reservations and Integration Risk

When a unit's work lands (its `autopilot.unit_merge.v1` evidence is accepted), its WRITE
edit leases become **change reservations** over the exact changed paths — the durable
record of "this run has landed these paths". Reservations model unlanded integration
risk between concurrent runs.

## From edit lease to reservation

Accepted `autopilot.unit_merge.v1` evidence is hash/identity checked and, in one
transaction, converted into exact changed-path reservations while all attempt
observations and WRITE/EXCLUSIVE edit leases are released and waiting peers are notified.
Reset, quarantine, abort, and prelaunch cancellation release authority **without**
inventing reservations.

## Overlap is legal; obligations are deterministic

Overlapping foreign reservations do not block speculative launch. Instead they create:

- deterministic **predecessor obligations**, and
- durable overlap/landing messages classified from actual changed paths, merge-tree,
  base-relative hunks, delete/modify facts, protected surfaces, and JSON semantic keys.

Same-file **disjoint** hunks are integrated automatically in predecessor order and
invalidate overlapping prior validation. Mechanically **major** conflicts create bounded
repair-routing evidence. A dependent run must supply hash-bound integration evidence plus
a current independent validation PASS before close.

## Close proves the union

Close proves the exact reservation-to-unit-merge path union, refuses active unit leases
or unresolved obligations, prepares a reservation-set terminal intent that fences new
dispatch, and atomically marks reservations landed or aborted with run terminal evidence.

## Enforced in

- `src/core/coordination/reservations.ts`,
  `src/core/coordination/integration-conflicts.ts`, `src/core/unit-merge.ts`,
  `src/core/close-runtime.ts`.

## Related

- [leases-and-observations.md](leases-and-observations.md), [terminal-evidence.md](terminal-evidence.md)
- Subsystem: [`../subsystems/close-lifecycle.md`](../subsystems/close-lifecycle.md)
