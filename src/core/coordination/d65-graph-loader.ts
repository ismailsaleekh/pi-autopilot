import { CoordinationRuntimeError } from './failures.ts';
import { assertD65BootstrapCharterIdentity, parseD65BootstrapCharter } from './d65-bootstrap-charter.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  reconstructD65CoordinatorProjection,
  type D65CoordinatorProjectionSnapshot,
} from './d65-coordinator-projection.ts';
import {
  assertD65ProjectionMembersClosed,
  parseD65ClosureProjection,
} from './d65-graph-projections.ts';
import {
  D65_GRAPH_AGGREGATE_MAX_BYTES,
  D65_GRAPH_AGGREGATE_MAX_ENTRIES,
  D65_GRAPH_ROOT_MAX_BYTES,
  bytesSha256,
  canonicalSha256,
  parseD65AuthorityShard,
  parseD65ProjectionShard,
  type D65AuthorityShardEntry,
  type D65CompleteGraph,
  type D65ProjectionIndex,
  type D65ProjectionShardEntry,
} from './d65-semantic-graph.ts';

// D65-A2/A5 complete-graph loader/replayer (fresh plan "One complete
// loader/replayer is shared by registration and gates and must load every
// root/shard, verify aggregate bounds/digests/ranges and closed projection
// values, compare the coordinator snapshot, recompute semantic versions, apply
// `B(N)`, and enforce every legal transition"). This module owns the pure,
// store-independent loading of a parsed complete-graph root: it reads every
// fixed core authority blob plus every authority/projection shard through a
// caller-supplied blob reader (so the exact same code is used by the store's
// Git-backed registration and by any in-memory gate/test), then proves aggregate
// byte/entry bounds, descriptor ↔
// shard-blob ↔ aggregate-digest agreement, contiguous non-overlapping identity
// ranges, and the closed shard membership. Higher-level equation checks (queue
// identities, coordinator projection, B(N), R=E+1, transitions) consume the
// loaded members this module returns. Every failure is authority-critical.
//
// The loader never spawns Git and never reads a store; the blob reader is the
// only I/O boundary and its bytes are treated as untrusted authority input.

/**
 * Reads the exact bytes of a repository-relative regular blob at the graph's
 * publication commit. Implementations must enforce their own no-follow / size /
 * identity guarantees and fail loudly; returning bytes asserts the blob exists
 * and is a regular file at the exact commit.
 */
export type D65GraphBlobReader = (ref: string) => Uint8Array;

export interface D65ProjectionMember {
  readonly identity: string;
  readonly kind: string;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface D65LoadedProjection {
  /** The projection members in decoded-identity-byte order across all shards. */
  readonly members: readonly D65ProjectionMember[];
  /** The exact referenced-byte total contributed by this projection's entries. */
  readonly referencedBytes: number;
  /** The exact entry count contributed by this projection. */
  readonly referencedEntries: number;
}

export interface D65LoadedAuthorityCollection {
  readonly entries: readonly D65AuthorityShardEntry[];
  readonly referencedBytes: number;
  readonly referencedEntries: number;
}

export interface D65LoadedGraph {
  readonly graph: D65CompleteGraph;
  /** Every projection index keyed by its graph field name. */
  readonly projections: Readonly<Record<string, D65LoadedProjection>>;
  /** Every authority collection keyed by its collection name. */
  readonly authorities: Readonly<Record<string, D65LoadedAuthorityCollection>>;
  /** Aggregate referenced authority bytes across every shard entry + core blob. */
  readonly aggregateReferencedBytes: number;
  /** Aggregate referenced authority entries across every shard entry + core blob. */
  readonly aggregateReferencedEntries: number;
  /** The exact closed coordinator projection reconstructed through the additive freeze. */
  readonly coordinatorProjection: D65CoordinatorProjectionSnapshot;
}

function fail(issue: string, detail: readonly string[] = []): never {
  throw new CoordinationRuntimeError('invalid-request', `semantic-graph-discovery-mismatch: ${issue}`, detail);
}

/**
 * Load one projection index: read every declared shard blob, prove the blob's
 * bytes match the descriptor `byte_count`/`sha256`, parse the shard, prove the
 * shard's projection_kind/identity range/counts equal the descriptor, and
 * accumulate members. The aggregate digest over the complete identity-sorted
 * member value array (independent of shard boundaries) must equal the index
 * `sha256`, and the summed entry RFC-8785+LF bytes must equal `total_bytes`.
 */
function loadProjectionIndex(
  index: D65ProjectionIndex,
  projectionKind: string,
  read: D65GraphBlobReader,
  expected: Readonly<{ program_id: string; repo_id: string; workstream_run: string; graph_sequence: number }>,
): D65LoadedProjection {
  if (index.entry_count === 0) {
    // Empty index: no shards, zero bytes. The parser already checked the empty
    // digest; there is nothing to read.
    return { members: Object.freeze([]), referencedBytes: 0, referencedEntries: 0 };
  }
  const members: D65ProjectionMember[] = [];
  let summedEntryBytes = 0;
  for (const descriptor of index.shards) {
    const expectedPrefix = `semantic-graphs/${String(expected.graph_sequence).padStart(20, '0')}/`;
    if (!descriptor.ref.startsWith(expectedPrefix)) fail('projection shard ref is outside its graph sequence prefix', [descriptor.ref, expectedPrefix]);
    const bytes = read(descriptor.ref);
    if (bytes.byteLength !== descriptor.byte_count) fail('projection shard blob byte_count does not match its descriptor', [descriptor.ref, `blob=${String(bytes.byteLength)}`, `descriptor=${String(descriptor.byte_count)}`]);
    if (bytes.byteLength > D65_GRAPH_ROOT_MAX_BYTES) fail('projection shard blob exceeds the 1 MiB shard bound', [descriptor.ref]);
    if (bytesSha256(bytes) !== descriptor.sha256) fail('projection shard blob sha256 does not match its descriptor', [descriptor.ref]);
    const shard = parseD65ProjectionShard(parseJson(bytes, descriptor.ref));
    assertCanonicalGraphBlob(bytes, shard, descriptor.ref);
    if (shard.program_id !== expected.program_id || shard.repo_id !== expected.repo_id || shard.workstream_run !== expected.workstream_run || shard.graph_sequence !== expected.graph_sequence) fail('projection shard header identity does not equal its graph root', [descriptor.ref]);
    if (shard.projection_kind !== projectionKind) fail('projection shard projection_kind does not match the index', [descriptor.ref, shard.projection_kind, projectionKind]);
    if (shard.entry_count !== descriptor.entry_count) fail('projection shard entry_count does not match its descriptor', [descriptor.ref]);
    if (shard.first_identity !== descriptor.first_identity || shard.last_identity !== descriptor.last_identity) fail('projection shard identity range does not match its descriptor', [descriptor.ref]);
    for (const entry of shard.entries) {
      summedEntryBytes += rfc8785EntryBytes(entry);
      members.push({ identity: entry.identity, kind: entry.kind, value: entry.value });
    }
  }
  // Cross-shard: the complete member array is globally identity-sorted with no
  // duplicate across shard boundaries.
  for (let i = 1; i < members.length; i += 1) {
    const previous = members[i - 1]?.identity ?? '';
    const current = members[i]?.identity ?? '';
    if (!(previous < current)) fail('projection members are not globally identity-sorted with no cross-shard duplicate', [projectionKind, previous, current]);
  }
  if (members.length !== index.entry_count) fail('projection loaded member count does not equal the index entry_count', [projectionKind, `loaded=${String(members.length)}`, `index=${String(index.entry_count)}`]);
  // Aggregate digest over the complete identity-sorted entry array plus LF,
  // independent of shard boundaries (the exact identity/kind/value_sha256/value
  // entry shape).
  const aggregateEntries = members.map((member) => ({ identity: member.identity, kind: member.kind, value_sha256: canonicalSha256(member.value), value: member.value }));
  const aggregateDigest = canonicalSha256(aggregateEntries);
  if (aggregateDigest !== index.sha256) fail('projection aggregate sha256 does not equal the digest of the complete identity-sorted entries', [projectionKind]);
  if (summedEntryBytes !== index.total_bytes) fail('projection total_bytes does not equal the checked sum of RFC-8785 entry bytes plus LF', [projectionKind, `summed=${String(summedEntryBytes)}`, `index=${String(index.total_bytes)}`]);
  return { members: Object.freeze(members), referencedBytes: summedEntryBytes, referencedEntries: members.length };
}

function loadAuthorityCollection(
  index: D65ProjectionIndex,
  collection: string,
  read: D65GraphBlobReader,
  expected: Readonly<{ program_id: string; repo_id: string; workstream_run: string; graph_sequence: number }>,
): D65LoadedAuthorityCollection {
  if (index.entry_count === 0) return { entries: Object.freeze([]), referencedBytes: 0, referencedEntries: 0 };
  const entries: D65AuthorityShardEntry[] = [];
  // For authority collections the plan defines shard/collection total_bytes as
  // the checked sum of member artifact byte_count (the referenced blob sizes),
  // NOT the RFC-8785 entry bytes (that rule is for projections). The aggregate
  // referenced authority bytes toward the 512 MiB ceiling likewise use the
  // member byte_count.
  let summedMemberBytes = 0;
  for (const descriptor of index.shards) {
    const expectedPrefix = `semantic-graphs/${String(expected.graph_sequence).padStart(20, '0')}/`;
    if (!descriptor.ref.startsWith(expectedPrefix)) fail('authority shard ref is outside its graph sequence prefix', [descriptor.ref, expectedPrefix]);
    const bytes = read(descriptor.ref);
    if (bytes.byteLength !== descriptor.byte_count) fail('authority shard blob byte_count does not match its descriptor', [descriptor.ref, `blob=${String(bytes.byteLength)}`, `descriptor=${String(descriptor.byte_count)}`]);
    if (bytes.byteLength > D65_GRAPH_ROOT_MAX_BYTES) fail('authority shard blob exceeds the 1 MiB shard bound', [descriptor.ref]);
    if (bytesSha256(bytes) !== descriptor.sha256) fail('authority shard blob sha256 does not match its descriptor', [descriptor.ref]);
    const shard = parseD65AuthorityShard(parseJson(bytes, descriptor.ref));
    assertCanonicalGraphBlob(bytes, shard, descriptor.ref);
    if (shard.program_id !== expected.program_id || shard.repo_id !== expected.repo_id || shard.workstream_run !== expected.workstream_run || shard.graph_sequence !== expected.graph_sequence) fail('authority shard header identity does not equal its graph root', [descriptor.ref]);
    if (shard.collection !== collection) fail('authority shard collection does not match the index', [descriptor.ref, shard.collection, collection]);
    if (shard.entry_count !== descriptor.entry_count) fail('authority shard entry_count does not match its descriptor', [descriptor.ref]);
    if (shard.first_identity !== descriptor.first_identity || shard.last_identity !== descriptor.last_identity) fail('authority shard identity range does not match its descriptor', [descriptor.ref]);
    for (const entry of shard.entries) {
      summedMemberBytes += entry.byte_count;
      entries.push(entry);
    }
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1]?.identity ?? '';
    const current = entries[i]?.identity ?? '';
    if (!(previous < current)) fail('authority entries are not globally identity-sorted with no cross-shard duplicate', [collection, previous, current]);
  }
  if (entries.length !== index.entry_count) fail('authority loaded entry count does not equal the index entry_count', [collection]);
  const aggregateEntries = entries.map((entry) => ({ identity: entry.identity, ref: entry.ref, git_mode: entry.git_mode, git_blob_oid: entry.git_blob_oid, sha256: entry.sha256, byte_count: entry.byte_count, document_schema_version: entry.document_schema_version }));
  if (canonicalSha256(aggregateEntries) !== index.sha256) fail('authority aggregate sha256 does not equal the digest of the complete identity-sorted entries', [collection]);
  if (summedMemberBytes !== index.total_bytes) fail('authority total_bytes does not equal the checked sum of member byte_count', [collection]);
  return { entries: Object.freeze(entries), referencedBytes: summedMemberBytes, referencedEntries: entries.length };
}

/**
 * Load and prove every authority + projection shard of a parsed complete graph
 * through `read`. This performs the discovery-level proofs only (blob ↔
 * descriptor ↔ shard ↔ aggregate agreement, identity ranges, membership, and the
 * 512 MiB / 200,000-entry aggregate ceilings). It intentionally does NOT run the
 * queue equations, coordinator projection reconstruction, B(N) replay, R=E+1, or
 * transition legality — those consume the returned members and are enforced by
 * the caller so this stays a single shared loader with no store dependency.
 */
export function loadD65CompleteGraph(graph: D65CompleteGraph, read: D65GraphBlobReader): D65LoadedGraph {
  const bootstrapCharter = parseD65BootstrapCharter(graph.bootstrap_charter);
  assertD65BootstrapCharterIdentity(bootstrapCharter, { repo_id: graph.repo_id, autopilot_id: graph.autopilot_id, workstream: graph.workstream, workstream_run: graph.workstream_run });
  const projections: Record<string, D65LoadedProjection> = {};
  const authorities: Record<string, D65LoadedAuthorityCollection> = {};
  const projectionIndexes: Readonly<Record<string, D65ProjectionIndex>> = {
    work_items: graph.work_items,
    bughunt: graph.bughunt,
    exceptions: graph.exceptions,
    coordinator_projection: graph.coordinator_projection,
    ...graph.queue_projection,
  };

  // Preflight every declared aggregate contribution before crossing the
  // caller-supplied read boundary. A malicious oversized descriptor must not
  // force a gate/replayer to materialize bytes that the aggregate contract
  // already forbids. The loaders below independently prove each declaration
  // equals the exact loaded members/bytes.
  let aggregateBytes = 0;
  let aggregateEntries = 0;
  const account = (bytes: number, entries: number, label: string): void => {
    const nextBytes = aggregateBytes + bytes;
    const nextEntries = aggregateEntries + entries;
    if (!Number.isSafeInteger(nextBytes) || !Number.isSafeInteger(nextEntries)) fail('aggregate referenced authority accounting overflowed', [label]);
    aggregateBytes = nextBytes;
    aggregateEntries = nextEntries;
    if (aggregateBytes > D65_GRAPH_AGGREGATE_MAX_BYTES) fail('aggregate referenced authority bytes exceed the 512 MiB ceiling', [label, `bytes=${String(aggregateBytes)}`, `ceiling=${String(D65_GRAPH_AGGREGATE_MAX_BYTES)}`]);
    if (aggregateEntries > D65_GRAPH_AGGREGATE_MAX_ENTRIES) fail('aggregate referenced authority entries exceed the 200000 ceiling', [label, `entries=${String(aggregateEntries)}`, `ceiling=${String(D65_GRAPH_AGGREGATE_MAX_ENTRIES)}`]);
  };
  for (const [collection, index] of Object.entries(graph.collections)) account(index.total_bytes, index.entry_count, `collection:${collection}`);
  for (const [name, entry] of Object.entries(graph.core)) account(entry.byte_count, 1, `core:${name}`);
  for (const [kind, index] of Object.entries(projectionIndexes)) account(index.total_bytes, index.entry_count, `projection:${kind}`);

  const expectedHeader = { program_id: graph.program_id, repo_id: graph.repo_id, workstream_run: graph.workstream_run, graph_sequence: graph.graph_sequence };
  for (const [collection, index] of Object.entries(graph.collections)) authorities[collection] = loadAuthorityCollection(index, collection, read, expectedHeader);

  // The five fixed core authority blobs are loaded through the same untrusted
  // reader boundary as shards. A descriptor alone is not presence/content
  // authority: prove exact bytes and digest after bounded preflight.
  const coreRefs = new Set<string>();
  for (const [name, entry] of Object.entries(graph.core)) {
    if (coreRefs.has(entry.ref)) fail('core authority refs must be unique', [name, entry.ref]);
    coreRefs.add(entry.ref);
    const bytes = read(entry.ref);
    if (bytes.byteLength !== entry.byte_count) fail('core authority blob byte_count does not match its descriptor', [name, entry.ref, `blob=${String(bytes.byteLength)}`, `descriptor=${String(entry.byte_count)}`]);
    if (bytesSha256(bytes) !== entry.sha256) fail('core authority blob sha256 does not match its descriptor', [name, entry.ref]);
  }

  for (const [kind, index] of Object.entries(projectionIndexes)) {
    const loaded = loadProjectionIndex(index, kind, read, expectedHeader);
    assertD65ProjectionMembersClosed(kind, loaded.members);
    projections[kind] = loaded;
  }

  parseD65ClosureProjection(graph.closure);
  const coordinatorProjection = projections['coordinator_projection'];
  if (coordinatorProjection === undefined) fail('coordinator_projection index was not loaded');
  const reconstructed = reconstructD65CoordinatorProjection(coordinatorProjection.members, {
    repoId: graph.repo_id,
    workstreamRun: graph.workstream_run,
    coveredEventSeq: graph.covered_event_seq,
  });

  return {
    graph,
    projections: Object.freeze(projections),
    authorities: Object.freeze(authorities),
    aggregateReferencedBytes: aggregateBytes,
    aggregateReferencedEntries: aggregateEntries,
    coordinatorProjection: reconstructed,
  };
}

/** The exact decoded-identity-byte-sorted member identities of one projection. */
export function d65ProjectionIdentities(loaded: D65LoadedGraph, projectionKind: string): readonly string[] {
  const projection = loaded.projections[projectionKind];
  if (projection === undefined) fail('requested projection was not loaded', [projectionKind]);
  return projection.members.map((member) => member.identity);
}

/** True when a queue projection member value is exactly `{identity}` equal to its enclosing identity. */
export function assertD65QueueMemberValues(loaded: D65LoadedGraph, queueKind: string): void {
  const projection = loaded.projections[queueKind];
  if (projection === undefined) fail('requested queue projection was not loaded', [queueKind]);
  for (const member of projection.members) {
    const keys = Object.keys(member.value);
    if (keys.length !== 1 || keys[0] !== 'identity' || member.value['identity'] !== member.identity) {
      throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-projection-mismatch: a queue projection value must be exactly {identity} equal to its enclosing identity', [queueKind, member.identity]);
    }
  }
}

function rfc8785EntryBytes(entry: D65ProjectionShardEntry): number {
  return textBytes(`${canonicalJson({ identity: entry.identity, kind: entry.kind, value_sha256: entry.value_sha256, value: entry.value })}\n`);
}

function textBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function assertCanonicalGraphBlob(bytes: Uint8Array, value: unknown, label: string): void {
  const canonical = new TextEncoder().encode(`${canonicalJson(value)}\n`);
  if (canonical.byteLength !== bytes.byteLength || canonical.some((byte, index) => byte !== bytes[index])) fail(`${label} is not RFC-8785 canonical JSON plus exactly one LF`);
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    fail(`${label} is not valid UTF-8`, [error instanceof Error ? error.message : String(error)]);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail(`${label} is not valid JSON`, [error instanceof Error ? error.message : String(error)]);
  }
}
