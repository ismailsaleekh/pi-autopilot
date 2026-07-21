---
doc_id: commands/autopilot
mode: authored
review_policy: contract
covers_surfaces:
  - /autopilot
covers_sources: []
stability: stable
---

# `/autopilot`

Start or resume an Autopilot parent orchestration session for a workstream.

## Synopsis

`/autopilot <workstream> [task intro/current focus]`

## Behavior

- Selects the fixed parent roster model before preparing a worktree and fails loudly
  if the model, subscription authentication, or exact thinking level is unavailable.
- Activates the parent `context_budget` tool; the rendered parent prompt requires
  `context_budget` before reading project files, runtime state, or launching child
  work.
- Prepares an isolated, sparse package-owned main worktree, attaches a durable run
  supervisor at a new fencing generation, reconciles owned durable state, and drains
  the durable mailbox before dispatching the parent prompt.
- Records the active workstream for a later `/autopilot-handoff` in the same session.

## State written

Per-workstream runtime under `.pi/autopilot/<workstream>/` inside the isolated main
worktree; shared run/session authority under `~/.pi/agent/autopilot/`. See
[`../INDEX.md`](../INDEX.md#runtime-state-paths).

## Failure classes

Model/roster unavailable, worktree preparation failure, and durable-supervisor
attachment failure each produce a loud notification and abort activation (no silent
fallback).

## Related

- [`autopilot-inject.md`](autopilot-inject.md), [`autopilot-handoff.md`](autopilot-handoff.md)
- Tool: [`../tools/context_budget.md`](../tools/context_budget.md)
