# SimWorld behavior and reality gaps

This artifact is an input to D3. A green simulation is not evidence that a
platform adapter implements the same behavior; the real adapter must replay the
central law vectors and pass the independent reality suites.

## Explicitly modelled

| Surface | Modelled behavior |
|---|---|
| Filesystem | exact binary bytes; separate visible/durable inode bytes and names; write visibility; file fsync; atomic same-model rename visibility; directory fsync; crash restore |
| Store | immutable content roots; object-first install; append → fsync → rename → dirsync → ack; duplicate install; exact ranges; sorted cursor-bound pages |
| Git | immutable trees and commits; deterministic root comparison/integration; one canonical head per run; atomic expected→desired CAS; moved-head hooks; crash windows before/after read and CAS |
| Workspace | private mutable files; base-root binding; isolation digest; occupied/ready/absent inspection; epoch-fenced disposal |
| Child | deterministic workspace writes; seal; exit/hang/kill; fence; late inspection; restart reconstruction of durable seals |
| Clock | monotonic integer ticks; explicit advancement only |
| Locks | exclusive owner; generation-derived epoch; takeover hooks; stale lease/epoch rejection; active-lock loss on crash |
| Secrets | external handle registry; child/epoch authorization; opaque lease; idempotent revocation; no bytes in observations/traces |

## Deliberately not modelled: D3 owners must certify

- Filesystem/device writeback reordering, sector tearing, hard links,
  permissions, quotas, ENOSPC, mount behavior, network filesystems, and platform
  rename/fsync differences.
- Git's physical object encoding, index, config/hooks, executable modes,
  symlinks, renames, binaries, Unicode edge cases, merge machinery, multiple
  refs, and multiple repositories in one run.
- OS process groups, signal delivery timing, orphan adoption, process-ID reuse,
  editor exit, real Pi compaction/resume, and model-route availability.
- Kernel sandbox/mount/network isolation and credential leakage through process
  environment, command lines, logs, crash dumps, or OS keyrings.
- Scheduler fairness, CPU starvation, real timer drift, wall-clock jumps, and
  distributed/cross-host execution.
- Cryptographic collision resistance as an implementation proof. The model
  stores exact bytes and rejects a simulated root collision, but does not prove
  SHA-256 itself.

## Frozen-contract defects / halt items

These were not patched with hidden production channels:

1. **No lock intent/observation pair exists.** The frozen contracts carry
   `LeaseId`/`ChildEpoch` preconditions but provide no acquisition, renewal,
   release, or takeover intent. `SimLockManager` is therefore testkit
   infrastructure, not a seventh production port. A production engine cannot
   drive the same lock transitions through the six frozen dispatch contracts.
2. **Git publication has no repository or ref target.**
   `publish-if-expected-head` supplies expected/desired revisions but neither a
   repository identity nor a ref name. The fake uses the single repository
   previously bound to the run. Multiple repositories/refs are not faithfully
   expressible without a frozen contract amendment.
3. **Store read/list observations return only another `ArtifactRef`.** The
   contract does not say how a caller obtains the referenced bytes without
   recursively issuing the same intent. `LawDriver.readArtifact` and
   `SimStorePort.readBytes` are test inspection capabilities only and must not
   be wired into production authority as an undeclared transport.
4. **Durability-point reporting is not part of the port algebra.** Crash-point
   hooks are test instrumentation which can kill the fake at an internal
   operation but cannot alter a successful observation. Real adapters need an
   equivalent protected fault-injection build; semantic law replay alone cannot
   prove their fsync/rename windows align with the fake registry.
5. **Child exit detail is normalized away.** Scripts model exit code, hang, and
   kill, but `ChildSessionInspected` exposes only running/quiescent/absent plus a
   sealed root. The engine cannot distinguish clean versus nonzero quiescence
   through the frozen child observation.

Until the owning architecture lane rules items 1–4, SimWorld can run engines
that stay within the one-repository/one-ref and harness-inspection assumptions,
but it must not be represented as complete D3 parity. No fake result silently
fills these missing contract fields.
