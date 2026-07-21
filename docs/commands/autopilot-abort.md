---
doc_id: commands/autopilot-abort
mode: authored
review_policy: contract
covers_surfaces:
  - /autopilot-abort
covers_sources: []
stability: stable
---

# `/autopilot-abort`

Archive an abandoned clean workstream without merging.

## Synopsis

`/autopilot-abort <workstream> [--run <workstream_run>] [--dry-run]`

## Behavior

Uses the same runtime-owned archival/claim-release/cleanup machinery as
`/autopilot-close` but does **not** land changes. It refuses dirty source paths,
releases retained claims, archives runtime artifacts, performs run-owned
worktree/task-directory/Git-metadata cleanup, and retires the branch to
`autopilot/archive/<workstream-run>/aborted` so stale runs do not keep path ownership
forever.

## State written

Archived runtime artifacts + an aborted archive ref; no target-branch merge.

## Failure classes

Dirty source paths and any unmet cleanup precondition are reported as blockers.

## Related

- [`autopilot-close.md`](autopilot-close.md)
