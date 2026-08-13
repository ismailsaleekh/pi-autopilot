# storage/journal

W1 owns the crash-safe epoch-segmented journal.

## Public surface

```ts
openJournal(journalDir, options?)
openJournalReadOnly(journalDir)
appendCommittedBatch(handle, journalRecord)
closeJournal(handle)
replayJournal(journalDir)
```

All operations return closed typed results. `JournalReplay` is a bounded-memory,
single-consumer `AsyncIterable<JournalRecord>`; consumers must inspect its typed
`completion` after iteration.

## Fencing

A writer exclusively creates one zero-padded u64 epoch claim and thereafter
writes only `segments/journal.<epoch>.log`. Every non-first segment starts with
a durable takeover control frame containing the observed valid-prefix cut for
every earlier epoch. The earliest valid successor fixes each cut permanently.
A superseded writer can therefore append only beyond its own fixed cut: those
bytes form an unselected chain fork and replay never observes them. Its
post-fdatasync claim scan returns typed `superseded`, so dead bytes are never
acknowledged as accepted work. No lock,
PID, liveness probe, age heuristic, or stealing protocol participates.

Wire v1 and the exact genesis seed are frozen in `wire.ts`. Record payloads use
the W0 canonical `JournalRecord` capsule; takeover payloads use the local closed
canonical schema documented there.

## Durability boundary

Claims and segment names use exclusive create plus file and parent-directory
fsync. A record is acknowledged only after `fdatasync`. Node does not expose
macOS `F_FULLFSYNC`; certification covers process crash/SIGKILL under the local
filesystem's fsync contract, not every device's sudden-power-loss cache policy.
