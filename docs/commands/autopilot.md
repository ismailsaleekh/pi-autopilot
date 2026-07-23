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

`/autopilot <workstream> [--roster <id>] [task intro/current focus]`

## Behavior

- Resolves roster authority before preparing a worktree: explicit `--roster <id>`,
  existing-run terminal transition authority, trusted-project default, user default,
  then agent-first setup when no selectable authority exists. A corrupt, untrusted, or
  stale higher-precedence authority blocks the run; lower precedence is not consulted.
- If setup is required, stays pre-run, activates the packaged `autopilot-roster-setup`
  lane for this session only, and writes no run/worktree state. If an existing run needs
  a roster change, presents exact transition approval and waits for a retry rather than
  replacing the pinned selection.
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

Roster resolution/setup requirement, roster model/profile mismatch, worktree
preparation failure, and durable-supervisor attachment failure each produce a loud
notification and abort activation (no silent fallback). Current W4 provider packs and
custom trust pins are blocked, so setup cannot save launch authority from offline or
uncertified custom evidence.

## Related

- [`autopilot-inject.md`](autopilot-inject.md), [`autopilot-handoff.md`](autopilot-handoff.md)
- Roster subsystem: [`../subsystems/roster-onboarding.md`](../subsystems/roster-onboarding.md)
- Tool: [`../tools/context_budget.md`](../tools/context_budget.md)
