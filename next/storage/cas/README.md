# storage/cas

W1 owns the streaming content-addressed store.

## Public surface

```ts
openCas(casRoot, options?)
putBlob(store, byteStream)
captureTree(store, sourceDirectory)
readBlob(store, blobRef, byteRange)
walkTree(store, artifactRoot, cursor, pageSize?)
materializeTree(store, artifactRoot, destination)
```

There is deliberately no unbounded whole-object read and no deletion API.
Blob reads require an explicit range; tree reads require a bounded page.
Presence is not workflow authority: journal reachability is authoritative, and
CAS reads independently verify bytes against their digest path.

`putBlob` copies each yielded chunk before asynchronous use, hashes and writes
that owned snapshot into a same-filesystem temp, fsyncs the complete temp,
atomically renames it to the digest path, fsyncs the parent directory, and only
then acknowledges. Duplicate content is independently verified and parent-dir
fsynced. A crash can leave an unreachable temp, but never a partial object under
a digest name.

Tree manifest v1 is documented in `manifest.ts`. It is a deterministic stream of
path-sorted, canonically encoded framed entries. Modes are retained; symlinks
are recorded and never followed. `walkTree` and materialization consume bounded
entries rather than requiring a whole manifest payload. Digest objects are
opened `O_NOFOLLOW`, verified and consumed through the same handle; ranged
streams expose explicit `close()` when a caller chooses not to iterate.

Node does not expose macOS `F_FULLFSYNC`; certification covers process
crash/SIGKILL under local-filesystem fsync semantics, not every device's
sudden-power-loss cache policy.
