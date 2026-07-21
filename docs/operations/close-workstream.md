---
doc_id: operations/close-workstream
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Operation: Close (Land) a Workstream

## Preflight

1. Ensure the operator source checkout is clean and on the captured target branch.
2. Confirm every source-changing work item has an independent validation PASS and clean
   execution audit (the closure gate will otherwise block).

## Recipe

1. Dry-run first: `/autopilot-close <workstream> --dry-run` (or add `--run <workstream_run>`
   to disambiguate). Read the reported blockers.
2. Resolve blockers (validation staleness, reservation repair, dirty/running/quarantined
   units, foreign target intersections).
3. Run `/autopilot-close <workstream>` to land: it locally fast-forwards the target
   branch, records terminal/reservation evidence, archives runtime evidence, removes only
   run-owned worktrees + the active task directory, and retires the branch to
   `autopilot/archive/<workstream-run>/main`.

## Guarantees

- Local-only: no fetch, push, network, or PR creation.
- The final integrated diff equals the union of accepted `autopilot.unit_merge.v1`
  changed paths for Phase 2 work.
- Never performs a global `git worktree` prune; a parallel run in the same repo key is
  untouched.

## Related

- Command: [`../commands/autopilot-close.md`](../commands/autopilot-close.md)
- Subsystem: [`../subsystems/close-lifecycle.md`](../subsystems/close-lifecycle.md)
- Abort instead: [`abort-workstream.md`](abort-workstream.md)
