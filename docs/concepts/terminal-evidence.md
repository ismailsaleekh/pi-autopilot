---
doc_id: concepts/terminal-evidence
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Concept: Terminal Evidence and Automatic Reconciliation

Authority is released by **evidence**, never by age, PID, or timestamp. A release-condition
watcher reconciles accepted terminal evidence into lease releases automatically.

## Accepted terminal evidence

Accepted child-terminal, unit-merge, attempt-reset, quarantine-capture, run-close, and
run-abort evidence is source-specifically parsed, identity-checked, hash-verified, and
stored transactionally. New child terminal evidence is a parent-owned
`autopilot.child_terminal_acceptance.v1` artifact that binds the exact spec, status,
receipt, execution audit, forced-output carrier, verdict, and child lease. `DONE`, `PASS`,
`NEEDS_FIX`, and `BLOCKED` are transport-terminal once that chain is accepted.

## Atomic release

Lease release, request transition, requester notification, complete-group re-evaluation,
and bounded offer creation occur in the same coordinator transaction. Child completion
remains authorized by its process-bound capability while both parents are offline.

## At-least-once, exactly-once effects

Durable per-run delivery and contiguous acknowledgement cursors provide at-least-once
mailbox replay across owner/requester shutdown, handoff, and coordinator restart.
Duplicate delivery is identified by stable message IDs and cannot duplicate coordinator
effects; acknowledgement cursors survive session replacement. Coordinator startup replays
durable terminal facts to repair a transition interrupted by an older process.

## Quarantine capture

Dirty quarantine/preserve transitions first inspect tracked, untracked, ignored,
nested-repository, and submodule state, then commit an immutable run-owned capture and
archive ref with exact branch/common-dir proof; only that capture may satisfy
`quarantine-captured`.

## The core invariant

Expired heartbeats remain classification evidence only and never satisfy a terminal
condition or release ambiguous WRITE/EXCLUSIVE authority. **Age never authorizes release.**

## Enforced in

- `src/core/coordination/reconciliation.ts`, `src/core/coordination/store.ts`,
  `src/core/unit-failure.ts`.

## Related

- [generations-and-fencing.md](generations-and-fencing.md), [reservations.md](reservations.md), [d65-terminal-tail.md](d65-terminal-tail.md)
- Subsystem: [`../subsystems/coordination.md`](../subsystems/coordination.md)
