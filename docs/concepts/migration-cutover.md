---
doc_id: concepts/migration-cutover
mode: mixed
review_policy: contract
covers_surfaces: []
covers_sources:
  - src/cli/migration-recovery.ts
signature_hash: 'sha256:572bf897cd91ce0e6023ae60cd84c52c8d4a3abe9c84155412e9cacc9717a473'
body_hash: 'sha256:e20d279d91ba379c5799bcc5a67e8ddd0be67ee0236e2bb5292d6b137efc9c06'
stability: stable
---

# Concept: One-Way Migration and Cutover

Legacy JSON/JSONL coordination migrates into the transactional coordinator store through
a durable, resumable, **one-way** lifecycle: `migrate → verify → cutover` (with a
pre-cutover `rollback`). There are no permanent dual writes.

## migrate --dry-run

Strictly parses and hashes bounded legacy active rows, claims, JSONL audit inputs,
worktree indexes, run/unit metadata, and exact Git HEAD/branch state **without mutation**.
Coordinator inspection never opens the live source SQLite database: it copies a bounded
db/WAL/SHM generation to a disposable directory outside the state root, verifies source
inode/metadata/byte hashes before and after copy and query, inspects only that copy, and
removes it. Schema 6/7/8/9 are accepted only with exact package migration checksums.

## migrate --apply

Writes a globally enforced freeze token, refuses reachable undrained legacy or coordinator
processes, snapshots every input, verifies a database backup, cross-checks and merges
matching coordinator state, and rebinds legitimate old-session claims to durable
run/unit/attempt ownership. Historical READ claims are excluded from active import only
when a bounded no-follow snapshot proves either a later canonical attempt or an exact
completed state/status/receipt/execution-audit chain. WRITE/EXCLUSIVE release remains
limited to stronger Git-backed terminal evidence; ambiguous authority is imported and
queued as typed supervisor recovery work. The recovery CLI constructs a typed release
resolution only after source, target identity, and evidence bytes are all present, then
reuses that immutable input for each fenced recovery mutation; partial release authority
fails before the supervisor operation.

## verify / rollback / cutover

- `verify` rechecks every source/Git hash, database invariant, filesystem path,
  Git root/common-dir/branch, immutable run resource, and import record; drift restores
  the exact pre-import boundary and requires a fresh snapshot.
- `rollback` (pre-cutover only) restores that boundary, preserves a history generation,
  and permits a fresh migration.
- `cutover` rechecks hashes, commits one client-visible marker, promotes non-authoritative
  runtime projections, archives legacy mutable files with a read-only manifest, verifies
  coordinator/client health over IPC, and only then removes the freeze. **Rollback is
  forbidden after the marker; repair is forward-only.**

## After cutover

Activation, runner preflight, materialization, worktree sagas, close, and abort
reconstruct runtime identity from coordinator-owned immutable run resources;
`_task-info.json` is a rebuildable local projection, not coordination authority. Every
legacy writer has a freeze/cutover fence and fails loudly instead of falling back.

## Enforced in

- `src/core/coordination/migration.ts`, `src/core/coordination/migration-paths.ts`,
  `src/cli/migration-recovery.ts`.

## Related

- [admission.md](admission.md), [sagas.md](sagas.md)
- CLI: [`../cli/autopilot-coordinator.md`](../cli/autopilot-coordinator.md)
