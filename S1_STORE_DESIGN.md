# S1 F3/F4 Store Implementation Map

Status: implementation design for `s1-lane1-f3f4-store`; authority is
`s1-contract-freeze.md` C2–C5 and decisions D59–D64.

## Identity boundaries

- Implementation build: `1.2.0-s1`.
- Wire protocol: `1.6`.
- API schema and cf50-facing `database_schema_version`: `12`.
- Private physical store schema: `13`.
- Legacy façade build: `1.1.8-cf50`.
- No comparison or constant aliases implementation, API, and store identities.

## Ordered implementation

1. Freeze C3 seam in small pure modules: semantic identity, deterministic ID,
   immutable one-hop alias contract, canonical resolver, metadata-reconcile
   intent/evidence contract, canonical JSON, and operation-key v2.
2. Add schema 13 normalized projections, immutable alias/fault/audit tables,
   trigger-enforced alias immutability, direct-target checks, canonical operation
   index, and partial semantic uniqueness.
3. Replace shape-specific duplicate retirement with migration classification.
   Derivable rows resolve directly. Incomplete/contradictory rows produce a
   typed run-scoped identity fault and cannot authorize a destructive operation.
4. Add a registry for physical/logical invariants. Run-scoped logical detector
   failures are persisted from indexed ownership. Non-derivable physical or
   ambiguous faults stay global fatal. Counter-behind repair advances the
   repository counter, allocates the next event, and writes immutable evidence
   in one transaction.
5. Add package-private `writer-guard.db` with a process-lifetime `BEGIN
   EXCLUSIVE` transaction. No writable generation opens without its exact guard
   handle.
6. Add generation publication: private staging, source snapshot/checkpoint,
   migration, integrity/invariant verification, fsync, atomic generation rename,
   atomic pointer replacement, directory fsync, immutable runtime sidecar, then
   lifecycle/socket. Restore always creates a new generation.
7. Wire server lifecycle in exact reverse on shutdown: stop listener, drain or
   reject in-flight requests, checkpoint, close store, verify WAL/SHM teardown,
   retire lifecycle, release guard.
8. Install the fixed-path schema-12 mutation barrier only after verified source
   capture and before S1 authority publication.

## Invariant registry map

| ID | Scope | Criticality | Repair |
|---|---|---|---|
| `F4-PHYSICAL-INTEGRITY` | global | authority | none: unreadable/corrupt pages are non-derivable |
| `F4-STORE-GENERATION` | global | authority | none: ambiguous pointer/publication/ownership is non-derivable |
| `F4-WRITER-GUARD` | global | authority | none: writer authority cannot be inferred |
| `F4-MIGRATION-BOUNDARY` | global | authority | none: unknown source generation is non-derivable |
| `F4-EVENT-COUNTER-BEHIND` | repository | progress | transactional MAX(events) repair plus next immutable audit event |
| `F4-EVENT-COUNTER-AHEAD` | global | authority | none: missing event history cannot be invented |
| `F4-PAYLOAD-INDEX-AMBIGUITY` | global or indexed run | authority | none: payload truth is never guessed |
| `F3-CANONICAL-IDENTITY` | entity/run | authority | deterministic tuple projection only |
| `F3-ALIAS-ONE-HOP` | global | authority | none: chains/repoint/delete are corruption |
| `F3-SEMANTIC-UNIQUENESS` | run | authority | mechanically select only with complete committed facts; otherwise scoped fault |
| `F3-OPERATION-CANONICAL-INDEX` | run | authority | deterministic alias resolution only |
| `F3-IDENTITY-RECOVERY` | run | authority | explicit pending fault; no destructive authority |

## Conservation proof strategy

Before schema-13 migration, record the primary key and byte-level authority
cells of every existing `events`, `worktree_operations`, `idempotency_results`,
and `evidence_artifacts` row. After migration, recompute that exact preexisting
key set and require identical bytes with no missing row. Migration may append
immutable audit events/evidence required to bind new aliases, scoped faults, and
counter repair, and may add projection/index/alias/fault rows; appended audit
rows are distinguished from the frozen historical key set. Existing historical
payload/content bytes are never updated.

## Path/publication authority

- Every coordinator/stores path is contained under the canonical coordinator
  root and checked component-by-component without following symlink aliases.
- Existing generation/database/publication files must be private regular files;
  no live generation file may have an external hardlink alias.
- Generation IDs are random addresses only.
- Pointer, publication, and sidecar parsers have exact closed fields and digest
  binding.
- A pointer is accepted only when the generation directory, publication digest,
  generation ID, relative path, schema, and checkpointed database hash agree.
- WAL/SHM files are never copied or overlaid between generations and must be
  absent after ordered close.
