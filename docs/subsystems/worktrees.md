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
signature_hash: 'sha256:82853603ad9b97c2a62ec6f2374efb085e1db7f7ae15d7af9a3d4cae2abde577'
body_hash: 'sha256:2e92362af85b23cb5d955444effc2e51200b92a15d9942ce67473531c0164944'
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
| Bounded, NUL-safe git process boundary | `src/core/git-process.ts` |
| D65 graph publication + worktree cadence | `src/core/coordination/d65-graph-publisher.ts`, `src/core/coordination/worktree-saga.ts` |

## Worktree layout

Activation creates an isolated package-owned main worktree per workstream at
`~/.pi/agent/autopilot/worktrees/<repo-key>/active/<workstream-run>/main/`, with
per-workstream runtime files under `.pi/autopilot/<workstream>/` inside it.
Source-changing implement/fix units run in
`…/active/<workstream-run>/units/<unit-id>/attempt-<n>/worktree/`, but their
authoritative status/receipt/evidence/audit/merge/scheduler artifacts still live under
the main runtime root. See [`../runtime-state/paths.md`](../runtime-state/paths.md).

## Sparse by default

New worktrees are sparse: `git worktree add --no-checkout`, package-owned non-cone
sparse patterns, a disk gate before runtime/index mutation, and a
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

For D65 runs, the signed launch policy also binds `expected_checkout_units=1` and
`maximum_parallel_cap=1`. In complete mode, ordinary create/materialize,
missing-worktree creation, and disk boundaries validate the current complete semantic
graph, policy, and heartbeat. The bootstrap main-worktree create and unit-removal
(terminal-tail) effects instead use closed charter/recovery paths (the bootstrap
charter for main create before policy/heartbeat exist; the `unit-recovery` and terminal
tail cells for reset/quarantine/remove), which bind row/session conditions but do not
re-require the full graph/policy/heartbeat tuple. Semantic worktree transitions in the
ordinary path require a successor graph before ordinary dispatch can resume.

## The git guard

Parent and child sessions may use local git inside registered Autopilot worktrees
(staging, commits, resets, restores, checkouts, cleanups, rebases), but the guard
rejects git whose effective cwd/work-tree is outside the active worktree, plus explicit
git remapping, remote/external subcommands, and shared branch/tag mutation. The
`git-process.ts` boundary is a single closed process with bounded raw-byte queries,
NUL-safe parsing, drained mutations, process-tree timeout termination, and redacted
diagnostics — no raw production Git exceptions escape. Recursive tracked-tree sizing
uses the streaming `ls-tree-recursive-stream` descriptor with separate entry-count,
cumulative-path-byte, per-record, and total lifecycle bounds; it never raises the
64 MiB retained-output ceiling or truncates authority into a false success.

## Related

- Concept: [`../concepts/leases-and-observations.md`](../concepts/leases-and-observations.md)
- Tool: [`../tools/autopilot_materialize_context.md`](../tools/autopilot_materialize_context.md)
- Subsystem: [`close-lifecycle.md`](close-lifecycle.md)
