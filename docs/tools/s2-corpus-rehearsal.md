---
doc_id: tools/s2-corpus-rehearsal
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources:
  - bin/autopilot-s2-corpus-rehearsal.mjs
  - tools/s2-corpus-rehearsal/cli.ts
  - tools/s2-corpus-rehearsal/contracts.ts
  - tools/s2-corpus-rehearsal/release-gate.ts
  - tools/s2-corpus-rehearsal/candidate-worker.ts
signature_hash: 'sha256:f7b6666a7b28d36bc08b51ced39179e15caef80980fbcc704453e436a50c843e'
body_hash: 'sha256:08e9fcf3aae2dcf615efadf80096a623e14c1994035a9be392e75c482a05087b'
stability: evolving
---

# Tool: autopilot-s2-corpus-rehearsal

The packaged `autopilot-s2-corpus-rehearsal` bin is the generic S2-D mutable-corpus
release harness. The bin imports the contained compiled CLI from `dist/tools/` directly;
it does not spawn a raw production child process. It ships harness code only: no private
corpus, request, result, fixture tarball, or live evidence is included in the npm
payload.

## Commands

| Command | Behavior |
|---|---|
| `status` | Without `S2_D_REHEARSAL_RESULT`, exits `2` with `private_rehearsal_result_unavailable`. With that environment variable, validates the private result file and reports `certified`. |
| `request <private-request.json>` | Parses and preflights an `autopilot.s2_d_corpus_clone_request.v1` request without cloning. |
| `clone <private-request.json>` | Builds the mutable clone, writes the private manifest, and reports manifest digest/isolation summary. |
| `rehearse <private-request.json>` | Builds the clone, runs candidate subprocesses for every discovered durable run, writes the private result, and validates release status. |
| `manifest <private-manifest.json>` | Validates an `autopilot.s2_d_corpus_clone_manifest.v1` manifest. |
| `result <private-result.json>` | Validates an `autopilot.s2_d_corpus_rehearsal_result.v1` result. |

Private request/result inputs must be bounded single-link regular JSON files; on
non-Windows platforms the request/result modes must be `0600` or stricter.

## Clone and isolation contract

`clone`/`rehearse` require canonical physical source roots for state, repository,
coordinator database, capability, and retained snapshots. The destination root must be
absent, under a physical parent, and disjoint from every source root. The harness:

- copies state through no-follow regular-file/tree helpers and creates a coherent SQLite
  backup from a private scratch copy;
- removes copied coordinator sockets/locks and rotates the capability to a fresh 64-hex
  secret;
- builds a writable self-contained Git mirror with remotes, alternates, hooks, and
  includes neutralized;
- rebases JSON, JSONL, SQLite-cell, and Git-registration paths into the clone;
- proves roots are disjoint, no regular file identity is shared, no symlink/hardlink/
  socket route remains, writes are confined to the sandbox, and live before/after source
  witnesses are equal.

## Phase36 durable-run operations

The manifest discovers durable runs directly from the cloned coordinator store and
requires the exact action sequence `attach`, `doctor`, `reconcile`, `dispatch-dry-run`
for each run. Phase36 disposition is computed from current tables, not operator prose:

- pending migration recovery, incomplete owned worktree operations, or retained terminal
  attempt edit leases select `owned-recovery`; otherwise the run uses `safe-attachment`;
- terminal attempt leases are classified as absent or `retained-terminal-attempt-recovery-required`;
- owned-operation authority-version drift is classified as blocked, recovered, or absent.

The candidate subprocess attaches through the durable supervisor, uses recovery-only
attachments when ordinary dispatch is fenced, drains pending migration recovery by
retaining authority, runs owned worktree-saga recovery when allowed, and records expected
blocks as passed action evidence only for the explicit mismatch contract. A release result
must contain all required actions for every run, zero `new_blockers`, passing live
before/after witnesses, and all isolation proofs.

## Default and release usage

`npm run test:s2-corpus` is synthetic/offline and never reads a live corpus. Release
certification of a mutable real corpus is opt-in: create a private request, run
`request → clone → rehearse → result`, then point `S2_D_REHEARSAL_RESULT` at the reviewed
private result before invoking `status`. The package status command never discovers or
reads live corpus paths by default.
