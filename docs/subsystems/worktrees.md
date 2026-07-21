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
signature_hash: 'sha256:0eeff457993c215861207651e76cdbb50fde38538a0d897d2ea49ef9640ea902'
body_hash: 'sha256:fa7fe6840faf0f28c169675fa484fff8cbaba839561ca9edd89b51be3c352c19'
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
`_checkout-profile.json` snapshot. The package refuses loudly instead of silently
falling back to a full checkout.

- Tracked-tree sizing streams and incrementally parses NUL-delimited `git ls-tree`
  records (independent of Node's fixed child-output buffer), pinned to the resolved
  HEAD commit so profile evidence cannot mix two revisions.
- The default profile is claim-minimal: baseline package/project files plus the
  source paths a unit declares or safely materializes.
- Projects may opt into `.autopilot/checkout-profile.json` or
  `AUTOPILOT_CHECKOUT_PROFILE=/absolute/path`; explicit `full` mode is opt-in only and
  still passes the disk gate.

## The git guard

Parent and child sessions may use local git inside registered Autopilot worktrees
(staging, commits, resets, restores, checkouts, cleanups, rebases), but the guard
rejects git whose effective cwd/work-tree is outside the active worktree, plus explicit
git remapping, remote/external subcommands, and shared branch/tag mutation. The
`git-process.ts` boundary is a single closed process with bounded raw-byte queries,
NUL-safe parsing, drained mutations, process-tree timeout termination, and redacted
diagnostics — no raw production Git exceptions escape.

## Related

- Concept: [`../concepts/leases-and-observations.md`](../concepts/leases-and-observations.md)
- Tool: [`../tools/autopilot_materialize_context.md`](../tools/autopilot_materialize_context.md)
- Subsystem: [`close-lifecycle.md`](close-lifecycle.md)
