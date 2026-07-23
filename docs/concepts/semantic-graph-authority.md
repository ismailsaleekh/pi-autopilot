---
doc_id: concepts/semantic-graph-authority
mode: authored
review_policy: behavioral
covers_surfaces: []
covers_sources:
  - src/core/coordination/d65-semantic-graph.ts
  - src/core/coordination/d65-first-complete-graph.ts
  - src/core/coordination/d65-graph-authority.ts
  - src/core/coordination/d65-graph-producer.ts
  - src/core/coordination/d65-graph-publisher.ts
  - src/core/coordination/d65-graph-successor.ts
  - src/core/coordination/d65-graph-publication-residue.ts
signature_hash: 'sha256:bc115b1298592020a7c25422a3de843eedb58469735b7df203f9f7471be6acdf'
body_hash: 'sha256:945f3beee556fcb0b225e2cfb0a7601acf8e70c8fda301020f6ef8a222cb0a4a'
semantic_attestation: 'sha256:945f3beee556fcb0b225e2cfb0a7601acf8e70c8fda301020f6ef8a222cb0a4a'
stability: evolving
---

# Concept: D65 Semantic Graph Authority

D65 is the coordination mode in which the run's authority is a **closed, versioned,
size-bounded semantic graph** published as Git objects and registered through the
coordinator store, not an ambient scan of loose files. A run operating under D65 is
explicitly in **D65 mode**; a run without a D65 bootstrap envelope is
[legacy / non-D65](../subsystems/coordination.md) and is classified as such — the two
are never conflated.

## Bootstrap authority

A D65 run begins from a **pre-run bootstrap envelope** whose charter is parsed by a
closed, no-fallback parser. Unknown fields, wrong types, or out-of-range values fail
loudly (there is no tolerant parser). The bootstrap charter and its trust anchor are
externally signed; production code **consumes** this signed authority and never
creates or self-signs it.

## The first complete graph

Before ordinary dispatch, the coordinator must reach a **first complete graph** by
replaying the exact bootstrap event chain — run/session attach, worktree operation
prepare → in-progress → verified → committed, authoritative-artifact registration, and
program-heartbeat acceptance — each joined to its exact committed idempotency result.
A bootstrap transition whose event lacks its sealed idempotency result is rejected as
`semantic-graph-bootstrap-transition-invalid`.

## Complete-graph contents and bounds

A complete graph is a **graph root** plus its authority and projection shards. The
contract is size-bounded: the root is at most `D65_GRAPH_ROOT_MAX_BYTES`
(1,048,576 bytes), the aggregate is at most `D65_GRAPH_AGGREGATE_MAX_BYTES`
(536,870,912 bytes) across at most `D65_GRAPH_AGGREGATE_MAX_ENTRIES` (200,000)
entries. Identifiers, git OIDs, `sha256:` digests, ISO timestamps, and run nonces are
each matched against exact frozen patterns. The graph aggregates the run's
authoritative artifacts, leases, worktrees, reservations, and terminal state as a
single closed projection.

## Authority discovery

A consumer discovers current authority by loading the registered complete graph, not
by scanning the worktree. The graph loader reconstructs the authority and projection
shards and asserts the coordinator projection equals the graph's registration
baseline; a mismatch is a loud error, never a silent re-scan.

## Exact G / H / R publication

Publication is a **non-self-referential** three-object commitment driven by the graph
consumer:

- **G** — the already-sealed authority commit whose covered commit/tree the graph
  describes.
- **H** — a graph-only commit whose sole parent is G and whose tree is G's tree plus
  exactly the root and shard blobs. H is published by compare-and-swap.
- **R** — the store-side registration event. The store transaction commits the
  artifact, the R event, and the idempotency result **without any residue filesystem
  write** (SR-1); the residue advances only after a committed response or an exact
  response-loss recovery.

## Successor cadence

After the first complete graph, authority advances by **successor graphs** produced at
a bounded cadence from committed coordinator state. Each successor is validated against
its predecessor baseline before it can become the current authority. A successor is
produced from real committed events only — there is **no fabricated no-event
successor** and no successor invented to paper over a missing event.

## Foreign-event transparency

Events the current build did not originate (foreign events) are surfaced transparently
in the projection rather than being dropped or silently absorbed. The graph records
them so a later authority holder sees the complete, honest event history.

## Crash-resumable publication residue

The publication saga is backed by a **mutable residue file** at
`_graph-publication.json` beside the run's main worktree (outside the Git worktree and
the runtime discovery corpus, mode 0600, no-follow, link-count-one, at most 1 MiB).
Each rewrite is canonical JSON + LF, transition-specific-field CAS checked, file- and
directory-fsynced, descriptor-identity checked, atomic-renamed, and serialized by one
package-owned per-run publication lock. The residue lets an interrupted publication
resume at its exact stage after a crash; it is never a place an operator edits by hand.

## Invariants

- No fabricated no-event successor graph is ever produced.
- Production consumes externally signed bootstrap/graph authority and never signs it.
- Graph residue is package-owned crash-recovery state — never delete it, hand-edit it,
  or rewrite coordinator rows to force a graph.

## Enforced in

- `src/core/coordination/d65-semantic-graph.ts`,
  `src/core/coordination/d65-first-complete-graph.ts`,
  `src/core/coordination/d65-graph-authority.ts`,
  `src/core/coordination/d65-graph-producer.ts`,
  `src/core/coordination/d65-graph-publisher.ts`,
  `src/core/coordination/d65-graph-successor.ts`,
  `src/core/coordination/d65-graph-publication-residue.ts`.

## Related

- [dispatch-and-recovery-authority.md](dispatch-and-recovery-authority.md),
  [d65-terminal-tail.md](d65-terminal-tail.md)
- Subsystem: [`../subsystems/coordination.md`](../subsystems/coordination.md)
- Operations: [`../operations/release-certification.md`](../operations/release-certification.md),
  [`../operations/crash-recovery.md`](../operations/crash-recovery.md)
