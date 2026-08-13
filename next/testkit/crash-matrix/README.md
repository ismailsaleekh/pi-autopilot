# Crash-matrix framework

The registry in [`registry.ts`](registry.ts) names every durability operation
currently exposed by SimWorld:

- generic filesystem append, file fsync, rename, and directory fsync;
- store install/list append → fsync → rename → dirsync → ack;
- toy journal append → fsync → ack;
- Git seal/integration append → fsync → rename → dirsync → ack;
- Git publication windows before/after ref read and before/after CAS plus ack;
- child seal append → fsync → rename → dirsync → ack.

A target is `{id, occurrence}`. A bare ID means occurrence 1.

```ts
const armed = injectCrashAt(world, {
  id: "git.publish.after-cas",
  occurrence: 1,
});
```

When the selected point is reached, the world records the point, kills the
simulated process, restores filesystem durable state, drops active locks and
scheduled process memory, and returns a `crashed` result. `world.restart()` then
constructs fresh fake-port instances from durable/external images.

`verifyCrashResume(scenario, point)` performs four checks:

1. run the scenario uninterrupted to completion;
2. recreate it and inject the exact point occurrence;
3. require that the point is reached, restart, and drive to completion;
4. require resumed semantic trace equivalence with the uninterrupted trace.

`verifyCrashMatrix` repeats that algorithm for a point list and reports
`verified`, `not-reached`, and `invalid` counts. It never treats an unreachable
point as green.

The demonstration suite contains two state machines:

- object-first installation followed by a framed durable journal record, cut at
  every store and journal point;
- deterministic Git candidate publication, cut at every CAS window.

These are framework proofs, not production-engine crash coverage. W2 binds the
real engine to SimWorld. W3 adds all production transaction rows, every point
occurrence required by those rows, child lifecycle permutations, and schedule
volume.
