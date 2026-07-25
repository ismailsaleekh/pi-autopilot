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
signature_hash: 'sha256:9a5e60a3ba8f59128b16556cc1fe4af77d4d23a810f53e081e0bd219d0e33e42'
body_hash: 'sha256:203bcdbaa6ea2f9618ec0b2471f849462ece973733bb20240951a621edeb9e79'
semantic_attestation: 'sha256:9015e1a8a1d88ca10e68671acebbe23c88fd4397837331b58f135f49aa2c568e'
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
replaying the exact bootstrap event chain — run/session attach, worktree-operation
stages `prepared → in-progress → in-progress → verified → committed`,
authoritative-artifact registration, and program-heartbeat acceptance — each joined to
its exact committed idempotency result.
A bootstrap transition whose event lacks its sealed idempotency result is rejected as
`semantic-graph-bootstrap-transition-invalid`.

## Complete-graph contents and bounds

A complete graph is a **graph root** plus its authority and projection shards. The
contract is size-bounded: the root is at most `D65_GRAPH_ROOT_MAX_BYTES`
(1,048,576 bytes), the aggregate is at most `D65_GRAPH_AGGREGATE_MAX_BYTES`
(536,870,912 bytes) across at most `D65_GRAPH_AGGREGATE_MAX_ENTRIES` (200,000)
entries. Identifiers, git OIDs, `sha256:` digests, ISO timestamps, and run nonces are
each matched against exact frozen patterns; repo ids and workstream-run ids use the
shared closed lowercase-repo / ASCII alphanumeric-or-hyphen run grammars. The graph aggregates the run's
authoritative artifacts, leases, worktrees, reservations, and terminal state as a
single closed projection.

## Authority discovery

A consumer discovers current authority by loading the registered complete graph, not
by scanning the worktree. The graph loader reconstructs the authority and projection
shards and asserts the coordinator projection equals the graph's registration
baseline; a mismatch is a loud error, never a silent re-scan.

Runtime-local document references have two semantically identical spellings:
runtime-root-relative (`mission.md`) and canonical repository-relative
(`.pi/autopilot/<workstream>/mission.md`). BUG-182 centralizes their resolution to one
exact repository target without rewriting stored bytes. Cross-workstream prefixes,
absolute paths, traversal segments, backslashes, and path aliases remain invalid.

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

After the first complete graph, authority advances by **successor graphs** from
committed coordinator state. A generic successor requires a contiguous repository
event suffix containing exactly one non-pure semantic event for this run (with only
normalized liveness around it), and is validated against its predecessor baseline
before it can become current authority. There is **no fabricated no-event successor**
and no successor invented to paper over a missing event.

## Shared-sequence foreign events

The repository event sequence remains contiguous across runs. While selecting the one
semantic successor event for this run, `d65-graph-successor.ts` explicitly skips events
whose semantic workstream identity belongs only to another run; it neither treats them
as this run's authority nor claims to project their content into this graph.

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
