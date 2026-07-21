---
doc_id: commands/autopilot-close
mode: authored
review_policy: contract
covers_surfaces:
  - /autopilot-close
covers_sources: []
stability: stable
---

# `/autopilot-close`

Run the package-owned close/merge lifecycle for a workstream. Deterministic runtime
code, not a model prompt. **Local-only**: no fetch, push, network, or PR creation.

## Synopsis

`/autopilot-close <workstream> [--run <workstream_run>] [--dry-run]`

## Behavior

Requires the operator source checkout clean and on the captured target branch, then
blocks child launches and verifies: closure evidence, Phase 2 unit-merge evidence,
execution-commit evidence, target-branch cleanliness, foreign/manual target changes,
validation staleness, and source/worktree cleanliness. It then locally fast-forwards
the captured target branch, releases retained claims, writes merge/ack/close evidence,
archives runtime artifacts, removes only run-owned terminal worktrees and the active
task directory, verifies no run-owned path remains, and retires the branch to
`autopilot/archive/<workstream-run>/main` — only after a successful local merge.

The final integrated diff must equal the union of accepted `autopilot.unit_merge.v1`
changed paths for Phase 2 work.

## State written

Merge/ack/close evidence + archived runtime artifacts under
`~/.pi/agent/autopilot/worktrees/<repo-key>/_archive/<workstream-run>/`.

## Failure classes

Any unmet precondition is reported as a blocker; the close does not proceed and no
partial merge is left behind.

## Related

- [`autopilot-abort.md`](autopilot-abort.md)
- Subsystem: [`../subsystems/coordination.md`](../subsystems/coordination.md)
