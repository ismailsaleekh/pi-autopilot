import { CoordinationRuntimeError } from "./failures.js";
import { canonicalJson } from "./canonical-json.js";
import { D65_AUTHORITY_SHARD_SCHEMA, D65_COLLECTION_KEYS, D65_COMPLETE_GRAPH_SCHEMA, D65_CORE_KEYS, D65_GRAPH_AGGREGATE_MAX_BYTES, D65_GRAPH_AGGREGATE_MAX_ENTRIES, D65_GRAPH_ROOT_MAX_BYTES, D65_PROJECTION_INDEX_KEYS, D65_PROJECTION_SHARD_SCHEMA, D65_QUEUE_KEYS, bytesSha256, canonicalSha256, } from "./d65-semantic-graph.js";
// D65-A2/A5 complete-graph producer/serializer (fresh plan §2.3 "Complete graph
// root" / "Complete-graph queue equations"). This is the exact INVERSE of
// `loadD65CompleteGraph` (d65-graph-loader.ts): given the coordinator authority
// state as structured inputs, it emits the byte-exact `autopilot.semantic_graph.v1`
// root blob plus every authority/projection shard blob, such that the loader
// round-trips them (blob↔descriptor↔shard↔aggregate-digest agreement, contiguous
// identity ranges, closed projection values, aggregate ceilings). Serialization
// uses the same `canonicalJson(...)+'\n'` and `canonicalSha256`/`bytesSha256` the
// loader/parsers use, so producer↔loader can never drift on bytes or digests.
//
// The producer performs NO Git and NO store access: the saga/runtime caller
// supplies the authority entries (each already committed as a blob with a known
// oid) and the projection member values; the producer only serializes and
// digests them. Every malformed input fails loudly.
const encoder = new TextEncoder();
function utf8Bytes(text) {
    return encoder.encode(text).length;
}
/** Canonical JSON + one trailing LF, the exact on-disk byte image of a graph blob. */
export function canonicalBlobText(value) {
    return `${canonicalJson(value)}\n`;
}
/** The frozen graph publication path prefix for a sequence (mirrors d65-graph-publication.ts). */
function graphPrefix(graphSequence) {
    return `semantic-graphs/${String(graphSequence).padStart(20, '0')}/`;
}
function fail(issue, detail = []) {
    throw new CoordinationRuntimeError('invalid-request', `semantic-graph-producer: ${issue}`, detail);
}
/** Assert a member array is strictly sorted by identity with no duplicates. */
function assertSortedUnique(identities, label) {
    for (let i = 1; i < identities.length; i += 1) {
        const previous = identities[i - 1] ?? '';
        const current = identities[i] ?? '';
        if (!(previous < current))
            fail(`${label} members must be strictly identity-sorted with no duplicate`, [previous, current]);
    }
}
/** The empty-index canonical shape shared by authority + projection indexes. */
function emptyIndex() {
    return { entry_count: 0, total_bytes: 0, sha256: canonicalSha256([]), shards: Object.freeze([]) };
}
/**
 * Build one AUTHORITY collection index + its single shard (the producer emits one
 * shard per non-empty collection; the loader accepts any valid sharding). The
 * collection `total_bytes` is Σ member `byte_count`; aggregate `sha256` is over
 * the complete identity-sorted entry array; descriptor `byte_count`/`sha256` bind
 * the actual shard blob bytes.
 */
function buildAuthorityIndex(collection, entries, header) {
    if (entries.length === 0)
        return { index: emptyIndex(), shards: Object.freeze([]), referencedBytes: 0, referencedEntries: 0 };
    const sorted = [...entries].sort((left, right) => (left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0));
    assertSortedUnique(sorted.map((entry) => entry.identity), `authority ${collection}`);
    const memberEntries = sorted.map((entry) => ({
        identity: entry.identity,
        ref: entry.ref,
        git_mode: entry.git_mode,
        git_blob_oid: entry.git_blob_oid,
        sha256: entry.sha256,
        byte_count: entry.byte_count,
        document_schema_version: entry.document_schema_version,
    }));
    const totalBytes = memberEntries.reduce((sum, entry) => sum + entry.byte_count, 0);
    const firstIdentity = memberEntries[0]?.identity ?? '';
    const lastIdentity = memberEntries[memberEntries.length - 1]?.identity ?? '';
    const shardObject = {
        schema_version: D65_AUTHORITY_SHARD_SCHEMA,
        program_id: header.program_id,
        repo_id: header.repo_id,
        workstream_run: header.workstream_run,
        graph_sequence: header.graph_sequence,
        collection,
        entry_count: memberEntries.length,
        total_bytes: totalBytes,
        first_identity: firstIdentity,
        last_identity: lastIdentity,
        entries: memberEntries,
    };
    const shardText = canonicalBlobText(shardObject);
    const shardBytes = encoder.encode(shardText);
    if (shardBytes.length > D65_GRAPH_ROOT_MAX_BYTES)
        fail(`authority ${collection} shard exceeds the 1 MiB shard bound`, [`bytes=${String(shardBytes.length)}`]);
    const ref = `${graphPrefix(header.graph_sequence)}${collection}/00000000000000000000.json`;
    const descriptor = {
        ref,
        sha256: bytesSha256(shardBytes),
        byte_count: shardBytes.length,
        entry_count: memberEntries.length,
        first_identity: firstIdentity,
        last_identity: lastIdentity,
    };
    const aggregateDigest = canonicalSha256(memberEntries);
    const index = { entry_count: memberEntries.length, total_bytes: totalBytes, sha256: aggregateDigest, shards: Object.freeze([descriptor]) };
    return { index, shards: Object.freeze([{ ref, bytes: shardBytes }]), referencedBytes: totalBytes, referencedEntries: memberEntries.length };
}
/**
 * Build one PROJECTION index + its single shard. Projection `total_bytes` is Σ of
 * each member's RFC-8785 entry bytes + LF; aggregate `sha256` is over the complete
 * identity-sorted entry array `{identity,kind,value_sha256,value}`.
 */
function buildProjectionIndex(projectionKind, members, header) {
    if (members.length === 0)
        return { index: emptyIndex(), shards: Object.freeze([]), referencedBytes: 0, referencedEntries: 0 };
    const sorted = [...members].sort((left, right) => (left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0));
    assertSortedUnique(sorted.map((member) => member.identity), `projection ${projectionKind}`);
    const memberEntries = sorted.map((member) => {
        if (member.kind !== projectionKind)
            fail(`projection ${projectionKind} member kind mismatch`, [member.identity, member.kind]);
        return { identity: member.identity, kind: member.kind, value_sha256: canonicalSha256(member.value), value: member.value };
    });
    const totalBytes = memberEntries.reduce((sum, entry) => sum + utf8Bytes(canonicalBlobText(entry)), 0);
    const firstIdentity = memberEntries[0]?.identity ?? '';
    const lastIdentity = memberEntries[memberEntries.length - 1]?.identity ?? '';
    const shardObject = {
        schema_version: D65_PROJECTION_SHARD_SCHEMA,
        program_id: header.program_id,
        repo_id: header.repo_id,
        workstream_run: header.workstream_run,
        graph_sequence: header.graph_sequence,
        projection_kind: projectionKind,
        entry_count: memberEntries.length,
        total_bytes: totalBytes,
        first_identity: firstIdentity,
        last_identity: lastIdentity,
        entries: memberEntries,
    };
    const shardText = canonicalBlobText(shardObject);
    const shardBytes = encoder.encode(shardText);
    if (shardBytes.length > D65_GRAPH_ROOT_MAX_BYTES)
        fail(`projection ${projectionKind} shard exceeds the 1 MiB shard bound`, [`bytes=${String(shardBytes.length)}`]);
    const ref = `${graphPrefix(header.graph_sequence)}projections/${projectionKind}/00000000000000000000.json`;
    const descriptor = {
        ref,
        sha256: bytesSha256(shardBytes),
        byte_count: shardBytes.length,
        entry_count: memberEntries.length,
        first_identity: firstIdentity,
        last_identity: lastIdentity,
    };
    const aggregateDigest = canonicalSha256(memberEntries);
    const index = { entry_count: memberEntries.length, total_bytes: totalBytes, sha256: aggregateDigest, shards: Object.freeze([descriptor]) };
    return { index, shards: Object.freeze([{ ref, bytes: shardBytes }]), referencedBytes: totalBytes, referencedEntries: memberEntries.length };
}
/**
 * Build the complete graph root + every shard from coordinator authority state.
 * Guarantees the loader round-trips the output: the returned `root` parses as
 * `autopilot.semantic_graph.v1` and `loadD65CompleteGraph(root, reader)` accepts
 * every shard when `reader` returns the exact `shards[i].bytes` for each `ref`.
 */
export function buildD65CompleteGraph(header, body) {
    if (!Number.isSafeInteger(header.graph_sequence) || header.graph_sequence < 2)
        fail('graph_sequence must be a safe integer >= 2');
    const producedShards = [];
    let aggregateBytes = 0;
    let aggregateEntries = 0;
    // Authority collections (fixed keys, sorted output object built explicitly).
    const collections = {};
    for (const collection of D65_COLLECTION_KEYS) {
        const built = buildAuthorityIndex(collection, body.collections[collection], header);
        collections[collection] = built.index;
        for (const shard of built.shards)
            producedShards.push(shard);
        aggregateBytes += built.referencedBytes;
        aggregateEntries += built.referencedEntries;
    }
    // The five fixed core blobs each contribute their exact byte_count + 1 entry.
    for (const coreKey of D65_CORE_KEYS) {
        const entry = body.core[coreKey];
        aggregateBytes += entry.byte_count;
        aggregateEntries += 1;
    }
    // Standalone projection indexes.
    const projectionIndexes = {};
    for (const kind of D65_PROJECTION_INDEX_KEYS) {
        const built = buildProjectionIndex(kind, body.projections[kind], header);
        projectionIndexes[kind] = built.index;
        for (const shard of built.shards)
            producedShards.push(shard);
        aggregateBytes += built.referencedBytes;
        aggregateEntries += built.referencedEntries;
    }
    // Queue projections (each member value must be exactly {identity}).
    const queues = {};
    for (const queueKind of D65_QUEUE_KEYS) {
        const members = body.queues[queueKind];
        for (const member of members) {
            const keys = Object.keys(member.value);
            if (keys.length !== 1 || keys[0] !== 'identity' || member.value['identity'] !== member.identity) {
                fail(`queue ${queueKind} member value must be exactly {identity} equal to its enclosing identity`, [member.identity]);
            }
        }
        const built = buildProjectionIndex(queueKind, members, header);
        queues[queueKind] = built.index;
        for (const shard of built.shards)
            producedShards.push(shard);
        aggregateBytes += built.referencedBytes;
        aggregateEntries += built.referencedEntries;
    }
    if (aggregateBytes > D65_GRAPH_AGGREGATE_MAX_BYTES)
        fail('aggregate referenced authority bytes exceed the 512 MiB ceiling', [`bytes=${String(aggregateBytes)}`]);
    if (aggregateEntries > D65_GRAPH_AGGREGATE_MAX_ENTRIES)
        fail('aggregate referenced authority entries exceed the 200000 ceiling', [`entries=${String(aggregateEntries)}`]);
    const root = {
        schema_version: D65_COMPLETE_GRAPH_SCHEMA,
        program_id: header.program_id,
        mode: 'complete',
        graph_sequence: header.graph_sequence,
        prior_graph_sha256: header.prior_graph_sha256,
        prior_event_seq: header.prior_event_seq,
        repo_id: header.repo_id,
        autopilot_id: header.autopilot_id,
        workstream: header.workstream,
        workstream_run: header.workstream_run,
        covered_authority_commit: header.covered_authority_commit,
        covered_authority_tree: header.covered_authority_tree,
        covered_event_seq: header.covered_event_seq,
        bootstrap_charter: header.bootstrap_charter,
        core: Object.freeze({ ...body.core }),
        collections: Object.freeze(collections),
        work_items: projectionIndexes.work_items,
        bughunt: projectionIndexes.bughunt,
        closure: body.closure,
        queue_projection: Object.freeze(queues),
        exceptions: projectionIndexes.exceptions,
        coordinator_projection: projectionIndexes.coordinator_projection,
        created_at: header.created_at,
    };
    const rootText = canonicalBlobText(root);
    const rootBytes = encoder.encode(rootText);
    if (rootBytes.length > D65_GRAPH_ROOT_MAX_BYTES)
        fail('graph root exceeds the 1 MiB root bound', [`bytes=${String(rootBytes.length)}`]);
    const rootRef = `${graphPrefix(header.graph_sequence)}graph.json`;
    return { root, rootBytes, rootRef, shards: Object.freeze(producedShards) };
}
