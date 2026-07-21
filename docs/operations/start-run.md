---
doc_id: operations/start-run
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Operation: Start or Resume a Run

## Recipe

1. In a Pi session, run `/autopilot <workstream> [task intro]`.
2. Autopilot selects the parent roster model, activates `context_budget`, prepares an
   isolated sparse main worktree, attaches the durable run supervisor at a new
   generation, drains the mailbox, and queues the parent prompt.
3. The parent calls `context_budget` first, then plans and launches dependency-cleared,
   file-disjoint child units up to `parallel_cap`.

## Resuming after a Pi session restart

- If you only need to restore the binding (no new parent prompt), run
  `/autopilot-inject <workstream>`. Then `/autopilot-handoff` and `/autopilot-config`
  will target the restored workstream.
- If you want a fresh parent turn, run `/autopilot <workstream>` again — it reconciles
  owned durable state and replays pending evidence before dispatch.

## Preconditions

- The parent roster model + subscription auth + exact thinking level must be available;
  otherwise activation fails loudly (no fallback).
- Post-cutover activation requires a durable coordinator session before worktree mutation.

## Verify

- `/autopilot-coordination status` shows the durable run and session leases.
- Runtime files appear under `.pi/autopilot/<workstream>/`.

## Related

- Commands: [`../commands/autopilot.md`](../commands/autopilot.md), [`../commands/autopilot-inject.md`](../commands/autopilot-inject.md)
- Concept: [`../concepts/generations-and-fencing.md`](../concepts/generations-and-fencing.md)
