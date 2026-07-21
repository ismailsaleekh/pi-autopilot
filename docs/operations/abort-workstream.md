---
doc_id: operations/abort-workstream
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Operation: Abort (Archive Without Merging)

Use abort to abandon a clean workstream without landing any changes.

## Recipe

1. Ensure no source paths are dirty (abort refuses dirty source paths).
2. Dry-run: `/autopilot-abort <workstream> --dry-run [--run <workstream_run>]`.
3. Run `/autopilot-abort <workstream>`: it releases retained claims, archives runtime
   artifacts, performs the same run-owned worktree/task-directory/Git-metadata cleanup as
   close (without landing), and retires the branch to
   `autopilot/archive/<workstream-run>/aborted`.

## When to abort vs close

| Situation | Use |
|---|---|
| Work is complete + validated and should land | [close](close-workstream.md) |
| Work is abandoned; nothing should merge | abort |
| Run crashed mid-operation | see [crash-recovery](crash-recovery.md) first |

## Related

- Command: [`../commands/autopilot-abort.md`](../commands/autopilot-abort.md)
- Subsystem: [`../subsystems/close-lifecycle.md`](../subsystems/close-lifecycle.md)
