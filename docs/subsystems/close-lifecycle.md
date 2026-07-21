---
doc_id: subsystems/close-lifecycle
mode: authored
review_policy: behavioral
covers_surfaces:
  - /autopilot-close
  - /autopilot-abort
covers_sources:
  - src/core/close-runtime.ts
  - src/core/unit-merge.ts
  - src/core/execution-commit.ts
  - src/core/validation-staleness.ts
  - src/core/worktree-cleanup.ts
signature_hash: 'sha256:008aa231a2414d2bcb29cc62696f7587634857ea043568428bd1f286fbc446b9'
body_hash: 'sha256:4d8335f54b7af16e0cb7758ec3c4ca3bf247eeb91ed6697e1bb44ac60da6a929'
stability: stable
---

# Close / Merge / Abort Lifecycle

Deterministic runtime code (not a model prompt) that lands or archives a workstream.
Both `/autopilot-close` and `/autopilot-abort` are **local-only**: no fetch, push,
network, or PR creation, and the parent/model may never mutate the operator source
checkout or remotes.

## Key files

| Concern | Source |
|---|---|
| Close/merge/abort runtime | `src/core/close-runtime.ts` |
| Phase 2 unit mergeback + `autopilot.unit_merge.v1` | `src/core/unit-merge.ts` |
| Execution-commit evidence boundary | `src/core/execution-commit.ts` |
| Post-merge validation freshness | `src/core/validation-staleness.ts` |
| Run-owned worktree removal/prune/reconcile | `src/core/worktree-cleanup.ts` |

## Close preconditions (all must hold)

1. Operator source checkout is clean and on the captured target branch.
2. Child launches are blocked (run moves to `merging`).
3. Every source-changing work item has schema-valid state/master-plan/status/audit
   evidence **plus** an independent validation PASS.
4. The final integrated diff equals the union of accepted `autopilot.unit_merge.v1`
   changed paths for Phase 2 work.
5. No remaining validation-staleness artifacts, unresolved reservation repair,
   foreign/manual target-path intersections, or dirty/running/quarantined unit
   worktrees.

## Close effects (in order)

Integrate landed clean/disjoint reservation predecessors → record validation
staleness → merge the target branch into the workstream branch → fast-forward the
target branch → record coordinator terminal/reservation evidence → release retained
authority → archive runtime evidence under
`~/.pi/agent/autopilot/worktrees/<repo-key>/_archive/<workstream-run>/` → remove only
run-owned paths (`active/<workstream-run>/main/` + terminal unit `worktree/`) → remove
the active task directory after archive → reconcile only exact run-owned stale
`git worktree` metadata (never a global prune) → verify no run-owned path remains →
retire the branch to `autopilot/archive/<workstream-run>/main`.

## Abort

`/autopilot-abort` uses the same archival/claim-release/cleanup machinery **without
merging**, refuses dirty source paths, and retires the branch to
`autopilot/archive/<workstream-run>/aborted`.

## Invariants that must not regress

- Worktree-local git freedom does not bypass close: final changed paths still require
  unit-merge, execution-audit, execution-commit evidence, and independent validation.
- Cleanup refuses dirty, unregistered, common-dir-mismatched, branch-moved,
  recreated, or foreign-run paths; a parallel Autopilot in the same repo key is never
  touched.
- Mergeback selects the immutable `execution_commit.commit_sha`; clean branch drift
  blocks before integration mutation or any terminal side effect.

## Related

- Commands: [`../commands/autopilot-close.md`](../commands/autopilot-close.md), [`../commands/autopilot-abort.md`](../commands/autopilot-abort.md)
- Concepts: [`../concepts/reservations.md`](../concepts/reservations.md), [`../concepts/terminal-evidence.md`](../concepts/terminal-evidence.md)
- Operations: [`../operations/close-workstream.md`](../operations/close-workstream.md)
