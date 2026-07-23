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
signature_hash: 'sha256:99bf9934a571ea880c691bc98db9a98cc7932f034eb0fd27fe3eb6bb1267461c'
body_hash: 'sha256:19018a5bce37ec356a130434d323953bf26a4cbbd20e29dfcb7f3f4910677a70'
semantic_attestation: 'sha256:19018a5bce37ec356a130434d323953bf26a4cbbd20e29dfcb7f3f4910677a70'
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
   requires accepted `autopilot.unit_merge.v1` evidence for the integrated paths. The
   merge record does not carry independent validation: validation is separate,
   post-merge evidence bound to the resulting integration head, while the universal
   closure gate enforces the audit / plan / status / decision blockers and close refuses
   any validation-staleness records.
4. The final integrated diff equals the union of accepted `autopilot.unit_merge.v1`
   changed paths for Phase 2 work.
5. No remaining validation-staleness artifacts, unresolved reservation repair,
   foreign/manual target-path intersections, or dirty/running/quarantined unit
   worktrees.
6. If an existing-run roster transition committed, at least one independent validation
   PASS must be fresher than the terminal transition; validation from the FROM roster is
   stale by construction. Close authenticates the committed external transition chain
   before accepting that fresh terminal-roster validation.
7. For D65 runs, the prepared-terminal boundary is also guarded at runtime through the
   D65 dispatch gate and `publishAndAuthenticateD65PreparedTerminalSuccessor` (an
   accepted complete graph, launch policy, governing heartbeat, and no pending graph
   publication). That D65 boundary requirement composes with the transition freshness
   blocker instead of replacing it.

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
  unit-merge and execution-commit/execution-audit evidence. Independent validation is
  performed against the post-merge integration head and remains separate from the unit
  merge record; later overlapping merges mark older validation stale and block close.
- Cleanup refuses dirty, unregistered, common-dir-mismatched, branch-moved,
  recreated, or foreign-run paths; a parallel Autopilot in the same repo key is never
  touched.
- Mergeback selects the immutable `execution_commit.commit_sha`; clean branch drift
  blocks before integration mutation or any terminal side effect. Active mergeback
  accepts only `autopilot.receipt.v2`, authenticated through the parent-issued terminal
  acceptance that binds exact unit-spec, status, receipt, and audit bytes; strict v2
  compatibility then binds roster, assignment, pre-run selection, request profile,
  role, output path, and status hash. Receipt v1 is rejected at this mutation boundary.
  Already-recorded historical merge evidence remains parseable as its original contract
  without relabeling, enrichment, or rewriting of historical bytes.
- A committed roster transition is terminal-run authority, not closure evidence; close
  keeps the transition behavior but still requires fresh validation under the terminal
  roster before landing.

## Related

- Commands: [`../commands/autopilot-close.md`](../commands/autopilot-close.md), [`../commands/autopilot-abort.md`](../commands/autopilot-abort.md)
- Concepts: [`../concepts/reservations.md`](../concepts/reservations.md), [`../concepts/terminal-evidence.md`](../concepts/terminal-evidence.md), [`../concepts/d65-terminal-tail.md`](../concepts/d65-terminal-tail.md)
- Operations: [`../operations/close-workstream.md`](../operations/close-workstream.md)
