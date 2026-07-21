---
doc_id: commands/autopilot-handoff
mode: authored
review_policy: contract
covers_surfaces:
  - /autopilot-handoff
covers_sources: []
stability: stable
---

# `/autopilot-handoff`

Create an Autopilot context handoff for the current active workstream and ask the
active parent to stop launching new work.

## Synopsis

`/autopilot-handoff [comments]`

## Behavior

Renders the handoff prompt: the active parent stops launching new work, writes/updates
compact handoff artifacts under the current workstream runtime root, and finishes with
a full `/autopilot <workstream>` resume block. The workstream is taken from the active
`/autopilot` or `/autopilot-inject` session; operators do not pass it.

Durable fencing is deferred until the handoff artifacts are written and the session
shuts down. The old generation then becomes `handoff-pending` and the replacement
attachment consumes that transition while preserving run/unit ownership.

## State written

`handoff.json`, `handoff.md`, and `handoff-event-tail.jsonl` in the active workstream
runtime root. The strict `autopilot.handoff.v1` shape carries mission, master-plan,
decision tail, state/event tail, status, and execution-audit refs.

## Failure classes

No active workstream in the session → usage warning naming `/autopilot` and
`/autopilot-inject`. Context-budget activation failure is loud.

## Related

- [`autopilot.md`](autopilot.md), [`autopilot-inject.md`](autopilot-inject.md)
