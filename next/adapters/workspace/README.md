# adapters/workspace

The sole adapter permitted durable attempt-workspace writes.

- `allocate-attempt-directory` performs one exclusive `mkdir` below a real,
  run-owned workspace root. A workspace ID is one safe basename; a fresh attempt
  directory is never reused.
- `inspect-attempt-directory` reports `ready` or `absent`. `occupied` and child
  epoch truth require the W3 supervisor/child-lifecycle authority; this stateless
  filesystem leaf does not invent them.
- `apply-attempt-isolation` validates that the directory and policy digest
  precondition exist. It does not claim an OS sandbox.
- `dispose-attempt-directory` proves the target is strictly below the run root,
  rejects symlink targets/escape ancestry, then performs one recursive removal.
- `readWorkspace` is the deterministic seal-support seam: sorted binary file
  reads with `O_NOFOLLOW`, modes, directories, and symlink targets. It never
  follows a workspace symlink.

## W3 isolation assumptions

W3 must supply kernel-enforced writable-root/mount/network restrictions, child
process-group ownership, lease acquisition, child-epoch fencing, occupied-state
observation, and termination-before-disposal. The frozen workspace contract does
not provide a lease/epoch acquisition port, so this adapter cannot enforce those
facts without forbidden hidden state.
