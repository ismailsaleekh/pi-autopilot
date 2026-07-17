# S1 Git process and worktree saga design

This file is the implementation inventory for frozen D58/D59. It is not an
alternative contract; `s1-contract-freeze.md` and decisions D57–D64 remain
authoritative.

## Production Git call-site inventory

All non-persistence production Git calls route through
`src/core/git-process.ts`. The mechanically enforced temporary exceptions are
Lane-1-owned `src/core/coordination/store.ts` and `migration.ts`; the exception
set must become empty when their owner lands the migration.

| Consumer area | Closed descriptors used |
|---|---|
| authority, checkout profile, observations, audit | bounded read-only queries |
| sparse creation and materialization | worktree/sparse/checkout mutations plus canonical create/materialize probes |
| execution commit and failed-unit capture | stage/commit/reset/archive mutations plus canonical commit/quarantine/reset/archive probes |
| unit/reservation/terminal integration | merge/abort mutations plus the canonical merge probe before compensation |
| terminal and rollback cleanup | worktree/remove/update-ref mutations plus canonical archive/remove probes |
| metadata reconciliation | exact worktree-list/ref queries and one exact-set `worktree-prune` mutation |
| saga recovery | the same descriptors and registry handlers as live execution |

`tests/unit/git-process-production-guard.test.ts` rejects new raw Git processes
and caller-owned saga inspect/verify functions.

## Canonical postcondition registry

`src/core/coordination/worktree-postconditions.ts` is the only effect truth.
Every result distinguishes complete satisfaction, safe incompleteness, unsafe
state, and whether the Git effect itself is already applied (for metadata-only
finalization without repeating the effect).

| Operation | Required repository proof |
|---|---|
| create | canonical owner/path/common-dir/branch registration, exact initial head (or a committed historical descendant), checkout mode, declared metadata |
| materialize | canonical physical authority, sparse mode, tracked files present and non-LFS, or bounded future-owned parent, declared metadata |
| commit | clean source, descendant of base, exact NUL diff-path set, optional exact target, declared metadata |
| merge | canonical target authority, no unresolved merge, exact base/source ancestry or exact fast-forward target, declared metadata |
| reset | canonical authority, exact target head, clean including ignored files, declared metadata |
| quarantine | clean including ignored files; exact one-parent base and exact NUL diff paths; when absent, the same proof from the exact owned branch/ref; capture SHA/source are evidence-bound |
| archive | exact owned archive ref at the intended commit plus declared metadata |
| remove | exact branch SHA before mutation; then physical path, registration, branch, approved residue and declared metadata reach their exact terminal state |
| metadata-reconcile | target physically absent, preserved refs exact, and complete registration set equals approved before or expected after |

Live execution, response-loss replay, coordinator recovery, and merge
compensation all call this registry. Mutation process reports are diagnostics,
never effect truth.

## Failure-state model

1. A query has a closed descriptor, explicit accepted/negative exits, timeout,
   raw bytes, NUL-safe typed parsing, and a 64 MiB combined retained-output
   ceiling. Overflow, signal, timeout, spawn failure, and unexpected exit are
   loud query failures and cannot imply an effect.
2. A mutation continuously drains output and retains one bounded redacted
   diagnostic. Timeout, signal, stream/stdin/spawn/report loss, or truncation is
   `effect-unknown`.
3. After every attempted effect, the canonical probe classifies current facts.
   `effect_applied=true` prevents a duplicate effect while allowing declared
   metadata finalization. Unsafe facts enter owned recovery without destructive
   compensation.
4. A stage becomes verified/committed only after immutable operation-bound
   evidence records the canonical proof. Quarantine evidence additionally
   records `capture_sha` and `proof_source` before authority release.
5. Operation identity is v2 canonical-worktree ID + operation type + complete
   immutable intent. Caller-invented IDs are rejected; an old ID is accepted
   only when resuming an already-existing historical operation.

## Incident closure witnesses

- I2: the sanitized `operation-5df1…` regression proves an absent physical
  worktree terminalizes the exact branch capture with one parent/exact paths,
  persists owned-ref capture evidence, and creates no second commit. The real
  `8725cf1…` proof and historical exact 42-lease release remain corpus-rehearsal
  gates and require Lane 1's absent-worktree store verification path.
- I5: a real 34-registration corpus proves exact-set metadata-only pruning,
  immutable before/after evidence, branch/object survival, replay, foreign-repo
  isolation, dangling-path refusal, and registration/ref proof-action drift
  refusal.
