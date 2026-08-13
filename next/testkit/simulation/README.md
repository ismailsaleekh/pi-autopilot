# Deterministic SimWorld

`SimWorld` is the W1 whole-system test boundary. A production engine binds its
six frozen intent ports to `world.dispatch(port, intent)` and otherwise runs
unchanged. No fake imports a real adapter, storage implementation, authority
internal, ambient clock, or ambient random source.

## Core API

```ts
import {
  SimWorld,
  enumerateSchedules,
  runUntil,
} from "./index.js";

const world = new SimWorld(0x5eed);
world.registerChildScript(script);
const observation = world.dispatch("child", launchIntent);
world.advance(10); // the only operation that advances virtual time
const result = runUntil(world, (candidate) => candidate.clock.now() >= 20);
```

The public boundaries accept `unknown` where host input can enter. Malformed,
cyclic, throwing-getter, and revoked-proxy values return a deterministic
`invalid`, `rejected`, or `retry` result rather than escaping an exception.

The world composes:

- `SimFileSystem`: exact bytes, visible versus durable inode contents, atomic
  rename visibility, file-fsync and directory-fsync boundaries.
- `SimStorePort`: content-addressed immutable objects and paged/range reads.
- `SimGitPort`: refs, trees, commits, deterministic integration, atomic CAS,
  and declarative head-move race hooks.
- `SimWorkspacePort`: attempt-private trees, isolation state, lease ownership,
  inspection, and epoch-fenced disposal.
- `SimChildPort`: `ChildScript` events keyed by action or work item; writes,
  optional seal, and exactly one exit/hang/kill event at explicit ticks.
- `VirtualClock`: monotonic integer ticks with no ambient timer.
- `SimLockManager`: exclusive ownership, durable generations, takeover events,
  and stale-epoch rejection.
- `SimSecretsPort`: opaque handles and revocable child/epoch-bound leases; secret
  bytes never enter a port observation or trace.

`world.restart()` constructs a new world instance from durable/external images;
in-memory observation caches, active locks, and process state are not reused.

## Determinism

The only pseudo-random stream is hand-rolled **xoshiro128\*\*** seeded by a
SplitMix32 expansion. Both use specified 32-bit integer operations. The same
seed, fixtures, scripts, and schedule therefore produce byte-identical
canonical traces. CI proves this twice in-process and in separate Node processes
under different locales and timezones.

## Trace semantics

Every full `TraceEvent` has canonical JSON fields:

`{sequence, tick, category, source, name, key, data}`.

Categories are `contract`, `durability`, `operational`, and `semantic`.
`SimTrace.canonicalBytes()` retains all events and is the strict determinism
oracle.

`assertTraceEquivalent(a, b)` compares the ordered **semantic projection**:

1. retain only `semantic` events;
2. remove `sequence` and `tick` plus crash/restart/poll/durability details;
3. project exact canonical `{source,name,key,data}` bytes;
4. fold a repeated key only when its projected bytes are identical;
5. retain a repeated key with different bytes, which makes traces differ.

This treats replay of an already-durable idempotent effect as equivalent while
still detecting changed bytes, changed ordering, missing effects, or conflicting
reuse of an idempotency key. The function is total and returns `equivalent`,
`different`, or `invalid`; it does not hide a malformed trace behind a throw.

## Schedule exploration bound

`enumerateSchedules` exhaustively enumerates actor-order-preserving
interleavings for at most **10 total steps**, with a hard maximum of **10,000
schedules**. It never samples. A scenario beyond the step bound, or one whose
combinatorics hit the schedule bound, returns `complete: false`. This is framework
capability, not D2.4 completion: the production-authority third-outcome hunt stays
pending until a later wave supplies its reachable-state model. W3 model-check
volume can decompose larger scenarios into bounded dependency windows while
preserving this explicit completeness signal.

`runUntil` has a default 1,000-advance bound (configurable up to 1,000,000). It
calls only `world.advance`; it neither sleeps nor reads wall time.

## Script shape

A script contains a key and tick offsets from launch:

```ts
{
  key: { kind: "work-item-id", workItemId },
  events: [
    { kind: "write", atTick: 1, path: "src/result.ts", bytes },
    { kind: "seal", atTick: 2 },
    { kind: "exit", atTick: 3, code: 0 },
  ],
}
```

Events are stable-sorted by tick. A script has exactly one terminal event, at
most one seal, and no write after seal. A missing or malformed script is loud
retry feedback, never an implicit successful child.

## D2 enablement suites

The protected suite manifest owns runnable commands for the registered D2
families; no lane-local package script owns default-gate wiring:

- **D2.3**: store/journal and Git-CAS toy crash matrices;
- **D2.4 framework only (pending registration)**: complete bounded
  interleaving enumeration plus a two-label toy schedule example; it makes no
  production-authority third-outcome claim;
- **D2.6**: malformed contract vectors, arbitrary bytes, cyclic values,
  throwing getters, revoked proxies, and deterministic mutation smoke over all
  public simulation surfaces.

W2/W3 retain responsibility for production-engine scenario volume. Registered
D2.3/D2.6 mean their framework commands are real; D2.4 stays explicitly pending
until its production-authority state model exists.

See [`BEHAVIOR-GAPS.md`](BEHAVIOR-GAPS.md) for the exact simulation/reality
boundary and contract-level halt items.
