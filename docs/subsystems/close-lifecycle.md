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
body_hash: 'sha256:ffdff05ff0c9cafe113c644d7a9fcd604c5a11e49f10eae452bf1ee5196b62fa'
semantic_attestation: 'sha256:ffdff05ff0c9cafe113c644d7a9fcd604c5a11e49f10eae452bf1ee5196b62fa'
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
3. The semantic closure gate passes: schema-valid state/master-plan/status/audit
   evidence and `evaluateAutopilotClosureGate` blockers are all cleared
   (`semanticClosureBlockers`). For Phase 2 work, `phaseTwoCloseBlockers` additionally
   requires each unit's `autopilot.unit_merge.v1` evidence (which carries its
   independent validation); the universal closure gate itself enforces the audit /
   plan / status / decision blockers rather than a separate per-item validation check.
4. The final integrated diff equals the union of accepted `autopilot.unit_merge.v1`
   changed paths for Phase 2 work.
5. No remaining validation-staleness artifacts, unresolved reservation repair,
   foreign/manual target-path intersections, or dirty/running/quarantined unit
   worktrees.

D65 runs additionally guard the prepared-terminal boundary at runtime through the D65
dispatch gate and `publishAndAuthenticateD65PreparedTerminalSuccessor` (an accepted
complete graph, launch policy, governing heartbeat, and no pending graph publication);
that is a runtime dispatch requirement enforced at the boundary, not a
`validateCloseReadiness` blocker.

## Close effects (in order)

Integrate landed clean/disjoint reservation predecessors → merge each unit (mergeback
records validation staleness in its finalize step) → merge the target branch into the
workstream branch → fast-forward the target branch → record coordinator
terminal/reservation evidence → publish and verify S2 cold terminal retention/hot
summary binding for coordinator-backed runs → release retained
authority → archive runtime evidence under
`~/.pi/agent/autopilot/worktrees/<repo-key>/_archive/<workstream-run>/` → remove only
run-owned paths (`active/<workstream-run>/main/` + terminal unit `worktree/`) → remove
the active task directory after archive → reconcile only exact run-owned stale
`git worktree` metadata (never a global prune) → verify no run-owned path remains →
retire the branch to `autopilot/archive/<workstream-run>/main`.

D65 close/abort first appends `autopilot.run_terminal_intent.v2`, publishes its
successor graph, and then enters a contiguous no-reentry terminal tail. The runtime
replays that tail against the prepared graph and precomputed effect partition; after
main-worktree removal, only the exact scoped terminal recovery is permitted. It never
fabricates a post-removal graph registration or re-enters ordinary dispatch.

## Abort

`/autopilot-abort` uses the same archival/claim-release/cleanup machinery **without
merging**, refuses dirty source paths, and retires the branch to
`autopilot/archive/<workstream-run>/aborted`.

## Invariants that must not regress

- Worktree-local git freedom does not bypass close: final changed paths still require
  unit-merge and execution-commit/execution-audit evidence, and each Phase 2 unit
  merge carries its own independent validation before mergeback.
- Cleanup refuses dirty, unregistered, common-dir-mismatched, branch-moved,
  recreated, or foreign-run paths; a parallel Autopilot in the same repo key is never
  touched.
- Mergeback selects the immutable `execution_commit.commit_sha`; clean branch drift
  blocks before integration mutation or any terminal side effect.

## Related

- Commands: [`../commands/autopilot-close.md`](../commands/autopilot-close.md), [`../commands/autopilot-abort.md`](../commands/autopilot-abort.md)
- Concepts: [`../concepts/reservations.md`](../concepts/reservations.md), [`../concepts/terminal-evidence.md`](../concepts/terminal-evidence.md), [`../concepts/d65-terminal-tail.md`](../concepts/d65-terminal-tail.md)
- Operations: [`../operations/close-workstream.md`](../operations/close-workstream.md)
