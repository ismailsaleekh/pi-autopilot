---
doc_id: concepts/dispatch-and-recovery-authority
mode: authored
review_policy: behavioral
covers_surfaces: []
covers_sources:
  - src/core/coordination/d65-launch-policy.ts
  - src/core/coordination/d65-dispatch-authority.ts
  - src/core/coordination/d65-dispatch-predicates.ts
  - src/core/coordination/d65-dispatch-gate.ts
  - src/core/coordination/d65-runtime-dispatch.ts
  - src/core/coordination/d65-heartbeat-gate.ts
  - src/core/coordination/d65-heartbeat-high-water.ts
  - src/core/coordination/unavailable-recovery.ts
signature_hash: 'sha256:a6fdd31a6ee98c213ebaf99a0ccb460670df6c4437997d511a53d1d685653310'
body_hash: 'sha256:4dc4e263dceb34f37aa422369377a044ef76ac88e3d06d79dcaf30a87ee00a95'
semantic_attestation: 'sha256:4dc4e263dceb34f37aa422369377a044ef76ac88e3d06d79dcaf30a87ee00a95'
stability: evolving
---

# Concept: D65 Dispatch and Recovery Authority

Under D65, every boundary that could start work, mutate product source, or advance a
recovery is gated by **two non-conflated, total, side-effect-free predicates**. The
coordinator builds a closed input frame from committed run / session / policy / graph /
heartbeat state; the predicates perform no I/O, `Date`, Git, or store access and always
return a closed verdict.

## Launch policy and trust

The launch policy is an immutable, versioned, size-bounded contract owned by the
**cap-one consumer**. Under version 1 the limits are exactly one: `parallel_cap` is
`1`, `expected_checkout_units` is `1`, and `maximum_parallel_cap` is `1`. The **only**
path to raise the maximum in these contracts is a superseding signed policy, which
must cite an `autopilot.capacity_decision.v1` ref and digest. The covered runtime
signature checks authenticate launch policy and program heartbeat against the frozen
operator trust anchor with mandatory domain separation. Capacity-decision and
subscription-probe parsers enforce closed shape and the shared repo/run identities;
this covered source set does not claim to authenticate their signatures.

## Cap-one authority

The cap-one authority means at most one accepted program may run at a time unless a
superseding signed policy raises the maximum while citing capacity-decision evidence.
The signed **program heartbeat** proves an
accepted program is live; its durable acceptance result and a reconstructable
high-water cache record the accepted sequence so a stale or replayed heartbeat cannot
resurrect authority.

## Accepted-program heartbeat

A program becomes dispatch-eligible only once its heartbeat is accepted through the
heartbeat gate. The gate parses the signed heartbeat, checks it against the durable
acceptance result and the high-water record, and rejects any heartbeat that is not a
strict forward step. Heartbeat acceptance is itself a recovery boundary — it never
authorizes a model call or product mutation.

## Ordinary dispatch predicate

`ordinaryDispatchAllowed` is the single predicate that permits **ordinary** work:
product / source worktree preparation, new-work claim / acquisition, ordinary attempt
and child registration, model calls, and ordinary state advancement. It returns true
only when the committed frame shows a complete graph, an accepted live heartbeat, no
global or row stop reason, and a healthy session authority frame.

## Closed recovery predicate cells

`recoveryTransitionAllowed` is **default-deny**. It permits only the exact frozen
recovery cells, one per recovery boundary: `accept-program-heartbeat`,
`register-authoritative-artifact`, `graph-publication`, `unit-recovery`,
`register-attempt`, `planned-handoff`, `parent-loss`, `cancel-run-terminal`, and
`terminal-tail`. **No recovery cell authorizes a model call, product/source mutation,
new-work claim/acquisition, or ordinary child registration.** A boundary that is not
permitted by its exact cell raises a loud `D65DispatchFencedError`.

## Planned handoff

A planned handoff is a recovery-boundary transition that transfers ownership of a live
run to a successor holder through committed continuation authority — not by killing a
process or rewriting coordinator rows. It moves authority without launching new work.

## Signed parent-loss recovery

The dispatch gate exposes one default-deny `parent-loss` recovery cell. It accepts only
the closed parent-loss reason shape and never authorizes model, product, or new-work
effects. Evidence/ref/artifact-root validation and any authority reconstruction belong
to producers/consumers outside this covered predicate set and are not claimed here.

## Subscription-failure / probe recovery

The subscription-probe parser closes retry ordinal, successor attempt, timestamps,
repo/run identity, and evidence-reference shape; heartbeat provider-health rows close
the probe tuple by provider state. The `register-attempt` recovery cell permits only
its exact retry-authorized reason shape and no ordinary effects. Exact-once probe
registration/consumption and signature authentication are outside this covered source
set and are not claimed here.

## Unavailable-coordinator recovery

When the coordinator endpoint is unavailable, `unavailable-recovery` attests the owner
lock, probes the endpoint, and either recovers the endpoint, records the owner absent,
or retires the exact predecessor process by verified process-start identity. It reports
one of `endpoint-recovered`, `owner-absent`, or `owner-retired`; it never fabricates a
new owner or bypasses the serialized process guard.

## Non-clearable blockers

Recovery cannot clear a global or row stop reason that is not itself recoverable
through an exact cell. A non-clearable blocker stays raised until its real cause is
resolved; there is no recovery path that silently erases it.

## Invariants

- Recovery has **no** model, product, or new-work effects — only the exact frozen cells.
- The covered runtime never self-signs launch policy or heartbeat authority; it verifies
  those externally signed inputs. Closed capacity/probe parsing alone is not signature
  authentication.
- Never forge a heartbeat, hand-edit coordinator rows, or substitute provider authority
  to force dispatch. The dispatch gate is frozen; bypassing it is a contract violation.

## Enforced in

- `src/core/coordination/d65-launch-policy.ts`,
  `src/core/coordination/d65-dispatch-authority.ts`,
  `src/core/coordination/d65-dispatch-predicates.ts`,
  `src/core/coordination/d65-dispatch-gate.ts`,
  `src/core/coordination/d65-runtime-dispatch.ts`,
  `src/core/coordination/d65-heartbeat-gate.ts`,
  `src/core/coordination/d65-heartbeat-high-water.ts`,
  `src/core/coordination/unavailable-recovery.ts`.

## Related

- [semantic-graph-authority.md](semantic-graph-authority.md),
  [d65-terminal-tail.md](d65-terminal-tail.md)
- Subsystem: [`../subsystems/coordination.md`](../subsystems/coordination.md)
- Operations: [`../operations/crash-recovery.md`](../operations/crash-recovery.md)
