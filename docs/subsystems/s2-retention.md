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
signature_hash: 'sha256:6da8b9ce219aecd3f9731d08178a7816a374c07eb594f700c5085df479d89b0b'
body_hash: 'sha256:eb54e61fe6d4546da08714f801d54e7a6e7ad87c1056f479d1bba761bdf76504'
stability: evolving
---

# S2 retention archive, owned GC, and per-run pressure state

S2-E is wired into production terminal and pressure seams. Coordinator-backed
close/abort accepts terminal evidence, publishes a deterministic cold terminal proof
with `publishS2ColdTerminalProof()`, verifies hot eligibility with
`verifyS2HotTerminalProofSummary()`, and persists a runtime binding before terminal
cleanup may complete. The coordinator-owned timer invokes
`runCoordinatorOwnedS2RetentionGc()` for terminal runs, which delegates to
`runScheduledS2OwnedGc()` for package-owned `_trash/` and `transition-backups/`
candidates under each repo retention root. Disk-gate/worktree creation records
durable per-run pressure with `recordS2RetentionDiskPressure()`, writes bounded
pressure diagnostics, and scheduler dispatch consumes the paused-run set while leaving
evidence and diagnostics publication open.

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
canonical cold relpath, terminal proof digest, and identity metadata. Terminal cleanup
uses `verifyS2HotTerminalProofSummary()` so the summary relpath is contained under the
configured cold archive root and the exact cold proof is re-verified before cleanup
eligibility.

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
nested owner markers, and missing unledgered paths. The default policy is
`autopilot-s2-e-retention-v1`: 1,048,576-byte cold proofs, 2,048-byte hot summaries,
64 candidates per GC kind per run, and transition-backup GC enabled. Containment checks
for the operation id and inflight path happen before `mkdir`, `rename`, or `rm` side
effects. The ledger is append-only NDJSON written through a no-follow single-link
descriptor; duplicate and replay decisions read the bounded ledger through the immutable
descriptor reader and require exact repo/run/kind/policy matches.

The only supported restart replay removes inflight candidates that already have an
exact `candidate-renamed` ledger event and still pass marker, tree, containment, and
cold-archive verification. Unledgered inflight directories are refused and preserved.
The coordinator timer is the production scheduler for this GC; there is no manual
deletion path.

## Durable per-run pressure state

The pressure-state file is canonical JSON at `_s2-retention-pressure-state.json` under
the retention root. It is read with descriptor-pinned byte bounds (64 KiB) and written
atomically with fsync/rename through a non-symbolic parent directory. A disk-pressure
event pauses only new worktree creation for the offending run; evidence and diagnostics
lanes remain open so integration can publish terminal evidence and pressure diagnostics
even while creation is paused. Clearing is event-sequence fenced: a stale clear for a
previous pressure event leaves the current pause intact. Disk-gate failures record the
offending run in this file, missing-worktree creation refuses only that run while the
event is current, and unrelated runs continue or restart normally.
