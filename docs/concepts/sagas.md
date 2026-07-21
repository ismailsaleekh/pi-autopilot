---
doc_id: concepts/sagas
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Concept: Owner-Scoped Worktree Sagas

Package-owned worktree and Git lifecycle mutations run behind owner-scoped durable
**sagas** so a lost response can never duplicate an already-satisfied effect.

## What a saga is

The coordinator stores immutable v2 worktree resources and operation intents and enforces:

- exact run/unit/path/branch/common-dir ownership,
- one incomplete operation per worktree,
- monotonic `probe → action → verification` steps,
- optimistic resource versions,
- immutable verification evidence,
- terminal state rules.

Main/unit registration, sparse materialization, execution commits, unit mergeback,
reset/abort, dirty quarantine capture, archive refs, branch retirement, worktree removal,
exact metadata reconciliation, and close/abort cleanup all run through the saga runtime.

## Response loss is safe

A per-worktree process lock prevents old/new session executors from acting concurrently,
and **every retry probes before acting**, so response loss cannot duplicate an
already-satisfied effect. An unacknowledged applied effect is never described as an
external-action failure.

## Recovery

Coordinator restart durably queues owner recovery messages; activation, supervisor
heartbeat, and runner preflight advance incomplete owned operations before dispatch.
Dirty destructive transitions first create an immutable capture commit/ref; cleanup
refuses dirty, unregistered, common-dir-mismatched, branch-moved, recreated, or
foreign-run paths. Close and abort reject pre-existing incomplete sagas.

## Enforced in

- `src/core/coordination/worktree-saga.ts`,
  `src/core/coordination/metadata-reconcile-runtime.ts`,
  `src/core/coordination/transition-model.ts`.

## Related

- [generations-and-fencing.md](generations-and-fencing.md), [terminal-evidence.md](terminal-evidence.md)
- Subsystem: [`../subsystems/worktrees.md`](../subsystems/worktrees.md)
