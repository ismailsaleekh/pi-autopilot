---
doc_id: commands/autopilot-coordination
mode: authored
review_policy: contract
covers_surfaces:
  - /autopilot-coordination
covers_sources: []
stability: stable
---

# `/autopilot-coordination`

Inspect the authenticated local Autopilot coordinator without starting an LLM turn.

## Synopsis

`/autopilot-coordination status|doctor`

## Behavior

- `status` reports durable runs, session/child leases, acquisition groups,
  commit/blob/tree-bound observations, edit leases, change reservations, reservation
  obligations, fenced terminal intents, claim requests, mailbox cursors/counts, and
  accepted reconciliation evidence.
- `doctor` additionally reports pending integration obligations and prepared terminal
  intents, and records that age never authorizes release of WRITE authority.

Both are read-only: they query the coordinator over authenticated IPC and never start
a model turn, mutate state, or release authority.

## Side-effects

None. No state is written; no authority is granted, transferred, or revoked.

## Failure classes

- Coordinator unavailable / IPC error → loud notification (no silent fallback).
- Malformed argument → usage warning.

## Related

- Subsystem: [`../subsystems/coordination.md`](../subsystems/coordination.md)
- CLI equivalent: [`../cli/autopilot-coordinator.md`](../cli/autopilot-coordinator.md)
