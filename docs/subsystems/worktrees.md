---
doc_id: subsystems/worktrees
mode: authored
review_policy: behavioral
covers_surfaces: []
covers_sources:
  - src/core/parallel-runtime.ts
  - src/core/sparse-worktree.ts
  - src/core/checkout-profile.ts
  - src/core/disk-gate.ts
  - src/core/materialization.ts
  - src/core/git-guard.ts
  - src/core/git-process.ts
signature_hash: 'sha256:455e4ba7b28348eef1e8d0d09e097ad5160c10e6278edbb3c6badae59bba6673'
body_hash: 'sha256:26553af7caa451a173e018dafad5c4e96456963709a871712bb7ed1d5d0b2dd4'
semantic_attestation: 'sha256:da4a2afdfcb3fd0de2162311dca2a45409aeee5b781837124eac5e8b37282f8c'
stability: stable
---

# Worktrees, Sparse Checkout, and the Git Guard

Autopilot isolates every run and every source-changing unit in its own git worktree.
This subsystem prepares, sizes, materializes, and guards those worktrees.

## Key files

| Concern | Source |
|---|---|
| Activation + per-unit worktree preparation | `src/core/parallel-runtime.ts` |
| Non-cone sparse checkout patterns | `src/core/sparse-worktree.ts` |
| Checkout profile resolution + snapshot | `src/core/checkout-profile.ts` |
| Disk gate before runtime/index mutation | `src/core/disk-gate.ts` |
| Authority materialization into worktrees | `src/core/materialization.ts` |
| Worktree-scoped parent/child git guard | `src/core/git-guard.ts` |
| Complete-output, NUL-safe git process boundary | `src/core/git-process.ts` |
| D65 graph publication + worktree cadence (related; reviewed in the D65 concept docs, not covered here) | `src/core/coordination/d65-graph-publisher.ts`, `src/core/coordination/worktree-saga.ts` |

## Worktree layout

Activation creates an isolated package-owned main worktree per workstream at
`~/.pi/agent/autopilot/worktrees/<repo-key>/active/<workstream-run>/main/`, with
per-workstream runtime files under `.pi/autopilot/<workstream>/` inside it.
Source-changing implement/fix units run in
`…/active/<workstream-run>/units/<unit-id>/attempt-<n>/worktree/`, but their
authoritative status/receipt/evidence/audit/merge/scheduler artifacts still live under
the main runtime root. See [`../runtime-state/paths.md`](../runtime-state/paths.md).

## Sparse by default

New worktrees are sparse: `git worktree add --no-checkout`, then a package-owned
`sparse-checkout set --no-cone` (later `sparse-checkout add` operations inherit the
non-cone mode), a disk gate before runtime/index mutation, and a
`_checkout-profile.json` snapshot. The disk gate records S2 per-run pressure for the
offending run only; missing-worktree creation refuses that run while unrelated runs
can continue or restart. The package refuses loudly instead of silently falling back
to a full checkout.

- Tracked-tree sizing streams and incrementally parses NUL-delimited `git ls-tree`
  records (independent of Node's fixed child-output buffer), pinned to the resolved
  HEAD commit so profile evidence cannot mix two revisions.
- The default profile is claim-minimal: baseline package/project files plus the
  source paths a unit declares or safely materializes.
- Projects may opt into `.autopilot/checkout-profile.json` or
  `AUTOPILOT_CHECKOUT_PROFILE=/absolute/path`; explicit `full` mode is opt-in only and
  still passes the disk gate.
- `resolveAutopilotFullCheckoutProfile` resolves the same profile forced to a full
  checkout with a correctly recomputed `profile_sha256`; the D65 sealed-launch main
  worktree uses it so the frozen checkout-profile/task-info contracts accept the exact
  bytes and the ordinary child materialization/disk-gate paths stay viable.

For D65 runs, the signed launch policy always binds `parallel_cap=1` and
`expected_checkout_units=1`; `maximum_parallel_cap` is required to be `1` for the
initial policy version 1 (a later signed capacity decision may raise the maximum in a
superseding policy). `parallel-runtime.ts` gates the D65 **unit-worktree** preparation path before
`unit-release`, before each `checkout-disk-estimate` surrounding its disk-gate call,
and before `missing-worktree-creation`. `updateUnitBranchStatus` gates its normal
branch projection as `ordinary-state-advance`, or uses the explicit
`unit-recovery` boundary when invoked in recovery mode. The generic main-worktree
creation, `disk-gate.ts`, and `materialization.ts` do not themselves claim those D65
boundary calls; sealed-launch main-worktree cadence is owned by the related D65
worktree-saga/graph-publication layer. The exact predicate semantics — which committed
graph/policy/heartbeat tuple each declared boundary requires, and why recovery cells
do not re-require the full tuple — are documented and independently reviewed in
[`../concepts/dispatch-and-recovery-authority.md`](../concepts/dispatch-and-recovery-authority.md)
and [`../concepts/semantic-graph-authority.md`](../concepts/semantic-graph-authority.md).

## The git guard

Parent and child sessions may use local git inside registered Autopilot worktrees
(staging, commits, resets, restores, checkouts, cleanups, rebases), but the guard
rejects git whose effective cwd/work-tree is outside the active worktree, plus explicit
git remapping, remote/external subcommands, and shared branch/tag mutation. The
`git-process.ts` boundary is a single closed process with complete retained output for
ordinary typed queries, NUL-safe parsing, drained mutations, process-tree timeout
termination, and bounded redacted error diagnostics — no raw production Git
exceptions escape. BUG-181 removed the fixed 64 MiB successful-output ceiling after a
legitimate D65 recursive tree exceeded it before first-graph publication. Recursive
tracked-tree sizing continues to use the incremental
`ls-tree-recursive-stream` descriptor with separate entry-count,
cumulative-path-byte, per-record, and total lifecycle bounds; neither path truncates
authority into a false success.

### D65 bootstrap-only effect fence

During the D65 launch bootstrap-plan turn the guard runs in a stricter mode set by
`AutopilotGitGuardPolicy.bootstrapCharterPaths`. The launch integration supplies the
five previously-absent runtime charter roots; the guard independently requires an
in-worktree, one-parent, duplicate-free set with the exact basenames `mission.md`,
`master-plan.json`, `state.json`, `decision-log.jsonl`, and `events.jsonl`. Every
explicit `bootstrapAllowedAuxiliaryRoots` entry must also remain inside the worktree.
A malformed policy blocks every tool call. With that capability installed, a
write/edit call may affect **exactly** a named charter path or a declared auxiliary
subtree — and nothing else, not even another file inside the runtime directory or an
out-of-worktree absolute path. The launch phase resolver owns absence/presence and
restart-state meaning; the per-call guard owns capability shape, containment, and
target membership. Tool admission is a
positive allowlist: dedicated read-only `read`, `grep`, `find`, and `ls`; exact-path
`write`/`edit`; and the manifest/session-bound `context_budget`. General `bash`, every
command/process/background alias, unnamed calls, and unknown tools are disabled: they
could mutate product, runtime-extra, Git, or external paths or spawn child/coordinator
processes outside any statically provable exact-path capability. The fence is
exact-path, not runtime-wide. This is enforced independently of, and in addition
to, the charter-completeness detector in `d65-launch-integration.ts`, which
inspects the full `git status --ignored` porcelain so that even an *ignored*
out-of-scope effect fences first-graph publication rather than passing silently.

## Related

- Concept: [`../concepts/leases-and-observations.md`](../concepts/leases-and-observations.md), [`../concepts/semantic-graph-authority.md`](../concepts/semantic-graph-authority.md)
- Tool: [`../tools/autopilot_materialize_context.md`](../tools/autopilot_materialize_context.md)
- Subsystem: [`close-lifecycle.md`](close-lifecycle.md)
