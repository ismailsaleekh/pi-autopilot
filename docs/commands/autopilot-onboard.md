---
doc_id: commands/autopilot-onboard
mode: authored
review_policy: contract
covers_surfaces:
  - /autopilot-onboard
covers_sources: []
stability: stable
---

# `/autopilot-onboard`

Generate a paste-ready `/autopilot <workstream>` onboarding block from supplied
handoff refs or notes.

## Synopsis

`/autopilot-onboard <workstream> [handoff refs/notes]`

## Behavior

Read-only. It renders an onboarding prompt only; it must not launch children, mutate
files, run tests, or call providers.

## State written

None.

## Failure classes

Malformed arguments produce a usage warning.

## Related

- [`autopilot.md`](autopilot.md), [`autopilot-handoff.md`](autopilot-handoff.md)
