---
doc_id: subsystems/s2-retention
mode: authored
review_policy: behavioral
covers_surfaces: []
covers_sources:
  - src/core/coordination/s2-retention-policy.ts
  - src/core/coordination/s2-retention-archive.ts
  - src/core/coordination/s2-owned-gc.ts
  - src/core/coordination/s2-retention-state-machine.ts
signature_hash: 'sha256:856a8e5895cdd36461466ebd5512461b075bd756ab7e4bf76c9915236c1be5a4'
body_hash: 'sha256:08e81f1d945966d6a994f3fc8736fb86a8a71fe6a1365b26b6a709c61256f969'
stability: evolving
---

# S2 retention archive, owned GC, and per-run pressure state

S2-E is wired into production terminal and pressure seams. Coordinator-backed
close/abort accepts terminal evidence, publishes a deterministic cold terminal proof
with `publishS2ColdTerminalProof()`, verifies hot eligibility with
`verifyS2HotTerminalProofSummary()`, and persists a runtime binding before terminal
cleanup may complete. If the process dies after the coordinator terminal commit but
before that binding is durable, recovery reconstructs the cold/hot publication and
binding from the accepted coordinator evidence; post-commit S2 publication failures
are classified as forward-only terminal cleanup recovery, not as pre-terminal close
failure. The coordinator-owned timer invokes `runCoordinatorOwnedS2RetentionGc()` for
terminal runs with one serialized in-flight sweep; timer ticks that arrive while GC is
still running apply backpressure instead of overlapping. Scheduled GC delegates to
`runScheduledS2OwnedGc()` for package-owned `_trash/` and `transition-backups/`
candidates under each repo retention root. Disk-gate/worktree creation records durable
per-run pressure with `recordS2RetentionDiskPressure()`, writes bounded disk-failure
pressure diagnostics, rechecks capacity on the next production worktree attempt, and
clears only the matching recovered event before continuing. Scheduler dispatch consumes
the paused-run set while leaving evidence and diagnostics publication open.

## Cold terminal proof archive

Cold archive identity is deterministic and content-addressed. The archive bytes bind
exact repo id, workstream run, terminal event sequence, terminal kind, policy id, and
the canonical terminal proof hash. Replay time does not enter the archive or hot
summary identity; `nowIso` is audit input for callers, not a content identity source.

`verifyS2ColdTerminalProof()` must be called with the expected repo/run/event/kind
identity and policy. Verification reads through the immutable no-follow descriptor
reader, enforces byte bounds and single-link identity, validates canonical archive
hashes, and refuses any policy or identity mismatch.

Hot summaries are bounded descriptor-pinned files containing only the cold digest,
canonical cold relpath, terminal proof digest, and identity metadata. Cold and hot
publication paths are created component-by-component and reject symlink roots or
symlink ancestors before writes, renames, reads, or cleanup can follow them outside the
retention tree. Terminal cleanup uses `verifyS2HotTerminalProofSummary()` so the summary
relpath is contained under a non-symlink cold archive root and the exact cold proof is
re-verified before cleanup eligibility.

## Scheduled owned GC

Owned GC only removes candidates discovered in package-owned retention roots. Each
candidate must have a single owner marker binding repo id, owner run, candidate id,
GC kind, policy id, terminal event sequence/kind, cold archive digest, and cold archive
relpath. The marker's `cold_archive_verified` boolean is not authority: immediately
before eligibility/removal, GC descriptor-verifies the actual cold archive under the
configured cold archive root against the exact repo/run/event/kind/policy tuple.

GC refuses escaped ids, invalid ids, missing or malformed markers, foreign owners,
policy mismatches, wrong kinds, active/dirty/quarantined/sole-copy candidates,
unverified cold archives, symlinks, hardlinks, non-directory candidates, ambiguous
nested owner markers, and missing unledgered paths. Category roots, candidate paths,
inflight paths, and cold archive verification paths all reject symlink ancestors before
scanning or deletion. The default policy is `autopilot-s2-e-retention-v1`: 1,048,576-byte
cold proofs, 2,048-byte hot summaries, 64 successfully committed removals per GC kind
per run, and transition-backup GC enabled. Refused candidates do not consume the removal
batch, so persistent low-sorting refusals cannot starve later valid owned candidates.
Containment checks for the operation id and inflight path happen before `mkdir`,
`rename`, or `rm` side effects. The ledger is append-only NDJSON written through a
no-follow single-link descriptor; ledger file and directory durability are fsynced, and
duplicate/replay decisions read the bounded ledger through the immutable descriptor
reader with exact repo/run/kind/policy matches.

The destructive protocol is forward-only: GC validates the candidate, durably records
verification, durably renames into `_gc-inflight/`, durably records the rename, then
records authoritative removal/replay intent before the first `rm`. Directory fsyncs
cover retention, category, inflight, and ledger parents so a hard kill cannot leave bytes
removed without a durable authoritative record. Restart replay removes inflight
candidates that already have an exact `candidate-renamed` or authoritative replay/removal
record and still pass marker, tree, containment, and cold-archive verification.
Unledgered inflight directories are refused and preserved. The coordinator timer is the
production scheduler for this GC; there is no manual deletion path.

## Durable per-run pressure state

The pressure-state file is canonical JSON at `_s2-retention-pressure-state.json` under
the retention root. It is read with descriptor-pinned byte bounds (64 KiB) and written
atomically with fsync/rename through a non-symbolic parent directory. A disk-pressure
event pauses only new worktree creation for the offending run; evidence and diagnostics
lanes remain open so integration can publish terminal evidence and pressure diagnostics
even while creation is paused. Clearing is event-sequence fenced: a stale clear for a
previous pressure event leaves the current pause intact. Production worktree creation
always re-runs the disk gate before honoring a durable pause; if capacity has recovered,
it clears the matching event and proceeds, and if pressure remains it records a fresh
`disk-failure` diagnostic. Unrelated runs continue or restart normally.
