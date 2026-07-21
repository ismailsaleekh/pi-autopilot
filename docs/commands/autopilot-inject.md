---
doc_id: commands/autopilot-inject
mode: authored
review_policy: contract
covers_surfaces:
  - /autopilot-inject
covers_sources: []
stability: stable
---

# `/autopilot-inject`

Refresh the current Pi session's Autopilot binding for an existing or newly prepared
workstream **without** queueing the parent prompt.

## Synopsis

`/autopilot-inject <workstream>`

## Behavior

Use it after resuming a Pi session when `/autopilot-handoff` needs the active
workstream restored. It activates `context_budget`, attaches the durable run
supervisor, and records the active workstream/run — but does **not** launch children,
mutate source files, run tests, call providers, or write handoff artifacts.

## State written

Same durable run/session attachment as `/autopilot`; no handoff artifacts.

## Failure classes

Model/roster unavailable, worktree preparation failure, and supervisor attachment
failure are loud and abort the inject.

## Related

- [`autopilot.md`](autopilot.md), [`autopilot-handoff.md`](autopilot-handoff.md)
