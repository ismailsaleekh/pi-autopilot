# adapters/git

Stateless Git CLI leaf for the five frozen `GitIntent` variants.

## Physical operations

- `materialize-workspace` — `git clone --no-local --no-hardlinks --no-checkout
  --no-tags -- <source> <attempt-dir>`, then `git checkout --detach --force
  <exact-base>`. The destination must already be reserved by the workspace
  adapter. The source checkout is read as a local object/ref source only; its
  index and worktree are never inspected or changed.
- `seal-workspace` — `git add -A -- .` into the attempt clone's private index,
  `git write-tree`, then deterministic `ls-tree`/`cat-file` reading. **Split:**
  this adapter produces exact tree entries + manifest bytes; `runtime/seal` and
  `storage/CAS` own durable object capture and installation. Git never imports
  storage and never claims CAS durability.
- `compare-roots` — `git diff-tree --raw -z -r -M --no-ext-diff`, normalized to
  additions/deletions/modifications/renames, modes, type changes, symlinks,
  binary-safe paths, and Unicode paths.
- `integrate-candidate` — clone into the already-reserved run integration
  directory, detached checkout of the exact base, then serial `git merge --no-ff
  --no-edit <candidate>`. Merge conflicts become a retry observation with a
  normalized conflict artifact reference; raw stderr is never semantic output.
- `publish-if-expected-head` — `git update-ref <frozen-ref> <desired> <expected>`;
  the adapter rereads the ref and reports `published`, `already-published`, or
  `head-moved`.

Every subprocess uses an argv array with no shell, pinned `cwd`, C locale,
system/global config disabled, terminal prompts disabled, credential helper
cleared, `core.hooksPath=/dev/null`, fsmonitor/untracked cache disabled, and
file-only protocol. Stderr is consumed but never surfaced. All subprocess output is bounded; an
oversized tree/diff produces deterministic retry feedback. Streaming/paged Git
plumbing is required before D3.6 can certify arbitrary-size trees.

## Frozen-contract composition binding

`GitIntent` does not carry a repository locator or publication ref. Therefore the
composition root must construct one adapter per run with one immutable repository
path and one immutable publication ref. This is a known CAR, not adapter state.

Git tree OIDs are represented reversibly inside `ArtifactRoot`: the adapter pins
`git rev-parse --show-object-format`; SHA-1 OIDs are right-padded with 24 zero hex
digits, while SHA-256 OIDs use all 64 digits. The mapping is mechanical and
collision-free within that pinned repository object format.
