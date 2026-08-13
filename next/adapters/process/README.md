# adapters/process

This adapter performs process mechanics only:

- one direct, shell-free spawn per `start` call;
- a detached POSIX process group (or an explicitly reported Win32 limitation);
- an exact caller-supplied environment, never `process.env` inheritance;
- independent bounded stdout/stderr streams that continue draining after their
  byte bounds are reached;
- running/exited/signalled and process-group observations with no completion
  meaning;
- process-group signals and TERM-then-KILL termination;
- bounded head/tail reads with explicit source/read truncation facts.

There is no queue, restart, retry, scheduler, watchdog, or status-to-outcome
mapping. `ProcessHandle` is an ephemeral OS handle, not durable workflow state.

The adapter never opens a path for write. Its constructor requires a structural
`ProcessCaptureSink` capability implemented by the durable-write owner
(`storage/` or `adapters/workspace/`) and a one-shot grace waiter supplied by the
runtime clock owner. The L7 real suite supplies test-only Node capabilities. A
capture sink must atomically acquire the exact `<captureId>.stdout/.stderr`
targets, reject symlinks, enforce `0600`, safely truncate a completed replay's
prior bytes, and reject concurrent ownership. W3 production composition is
blocked until the approved owner supplies that capability (CAR-L7-7).
