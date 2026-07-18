# S1 C5 private-corpus rehearsal

This directory is a **source-only release-certification tool**. It is excluded
from the npm package payload and must never be copied into a published release.

## Authority boundary

- `cli.ts run <private-request.json>` requires an operator-provided, mode-0600
  `C5_PRIVATE_REQUEST` describing the private retained corpus.
- The source corpus is read-only. The controller never opens its SQLite database;
  SQLite inspection and every I1–I5 mutation run only against coherent,
  disjoint, generation-owned copies.
- Live state is witnessed independently before and after rehearsal. Database
  components, evidence, authority objects (including locks and sockets), Git
  refs, registrations, worktrees, and complete root inventories must all remain
  byte/identity equivalent.
- The retained corpus must expose the package's current 64-hex capability
  format and one durable `run_resources` projection for every durable run.
  Missing or historical alternative layouts are blockers, never guessed.
- Synthetic fixtures prove harness structure only. One packed-candidate
  scenario-worker test exercises durable attach/reconcile, the production
  scheduler, prior-acquisition admission, missing-runtime recovery, and exact
  lock/socket teardown. It emits no I1–I5 row and cannot write an actual-corpus
  result or satisfy C5.
- Without `C5_PRIVATE_REQUEST`, `cli.ts status` remains `not_run` and exits 2.
- The private destination must be outside the operator home and every declared
  source/retained root; those trees are explicit sandbox read-deny authority.
- On Unix, the destination must be short enough for either the preferred or
  clone-contained fallback coordinator socket. Construction rejects longer
  roots before any rehearsal starts.
- Actual private-corpus C5 execution is currently authorized on the empirically
  verified macOS seatbelt lane. Its read policy is limited to the clone,
  system/toolchain roots, exact path ancestors, and root-directory metadata;
  declared sources and operator home remain explicit read/write denies. The Linux bubblewrap backend remains fail-closed
  until its provisioned non-root host runs the same confinement and coordinator
  round-trip gate; root execution is never accepted as confinement evidence.
- Windows execution requires the separately provisioned Windows Sandbox or
  ephemeral-VM backend used by the Node 22/24 release matrix. The local tool
  refuses Windows execution rather than weakening confinement.

## Private clone retention

Clone construction failures are removed atomically. Once construction succeeds,
`run` intentionally retains a failed or completed mode-0700 clone for private
forensics; it never guesses that destructive cleanup is safe. The operator must
archive or securely delete the exact `destination_root` from the private request
after reviewing the result. Re-runs require a new, absent destination root.

A successful result is valid only when all measured I1–I5 assertions pass,
`new_blockers` is empty, sandbox confinement passes, and the independent live
before/after witnesses are exactly equal. No result file is published earlier.
