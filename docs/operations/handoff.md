---
doc_id: operations/handoff
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Operation: Hand Off a Run

Hand off when `context_budget` returns `halt`/`unknown`, or when you intend to end the
session while preserving run ownership.

## Recipe

1. In the active Autopilot session, run `/autopilot-handoff [comments]`.
2. The parent stops launching new work, drains running work, and writes/updates compact
   handoff artifacts under the current workstream runtime root.
3. End the Pi session. Durable fencing commits at shutdown after the artifacts are
   written; the old generation becomes `handoff-pending`.
4. In a new session, run `/autopilot <workstream>` (or `/autopilot-inject <workstream>`
   then continue) — the replacement attachment consumes the `handoff-pending` transition
   while preserving run/unit ownership.

## Artifacts written

`handoff.json`, `handoff.md`, `handoff-event-tail.jsonl` (schema `autopilot.handoff.v1`)
carrying mission, master-plan, decision tail, state/event tail, status, and
execution-audit refs — so the next session recovers purpose before queues.

## Notes

- The workstream is taken from the active session; do not pass it to the handoff command.
- Running children keep their process-bound authority across the handoff and can still
  commit terminal/recovery state.

## Related

- Command: [`../commands/autopilot-handoff.md`](../commands/autopilot-handoff.md)
- Concept: [`../concepts/generations-and-fencing.md`](../concepts/generations-and-fencing.md)
