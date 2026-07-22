import { CoordinationRuntimeError } from "./failures.js";
import { advanceD65GraphPublicationResidue, createD65GraphPublicationResidue, cleanupD65GraphPublicationResidue, readD65GraphPublicationResidue, } from "./d65-graph-publication-residue.js";
import { d65SemanticGraphArtifactId } from "./d65-graph-publication.js";
import { bytesSha256, canonicalSha256 } from "./d65-semantic-graph.js";
import { decodeUnpaddedBase64Url, encodeUnpaddedBase64Url } from "./d65-trust.js";
const ZERO_OID = '0'.repeat(40);
const GRAPH_G_MESSAGE = 'autopilot: graph authority commit G\n';
const GRAPH_H_MESSAGE = 'autopilot: graph publication commit H\n';
function fail(issue, detail = []) {
    throw new CoordinationRuntimeError('invalid-state', `semantic-graph-publisher: ${issue}`, detail);
}
/** The exact graph paths (root + shards) that H must introduce, decoded-byte-sorted. */
function graphBlobEntries(produced) {
    const entries = [
        { path: produced.rootRef, bytes: produced.rootBytes },
        ...produced.shards.map((shard) => ({ path: shard.ref, bytes: shard.bytes })),
    ];
    const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i - 1]?.path === sorted[i]?.path)
            fail('duplicate graph blob path in the produced graph', [sorted[i]?.path ?? '']);
    }
    return sorted.map((entry) => ({ oid: '', path: entry.path, bytes: entry.bytes }));
}
/**
 * Drive the four-stage publication saga to completion for a produced complete
 * graph. Idempotent-forward: if a residue already exists it RESUMES from its
 * recorded stage (revalidating the recorded Git/store postcondition), performing
 * only the next edge. Returns the accepted `(graph_sha256, publication_commit=H,
 * registration_event_seq=R)` tuple.
 */
export async function publishD65CompleteGraph(input) {
    const { mainWorktreePath, buildGraph, plan, git, store } = input;
    const graphSequence = plan.graphSequence;
    const artifactId = d65SemanticGraphArtifactId(graphSequence);
    const prefix = `semantic-graphs/${String(graphSequence).padStart(20, '0')}/`;
    validateAuthorityManifest(plan);
    // Resume from an existing residue (crash/response-loss safe), or durably seal
    // the pre-G base + exact proposed path manifest before constructing G.
    let residue = readD65GraphPublicationResidue(mainWorktreePath);
    if (residue === null)
        residue = createD65GraphPublicationResidue(mainWorktreePath, preparedResidue(artifactId, graphSequence, plan));
    else
        assertResidueBindsThisGraph(residue, artifactId, graphSequence, plan);
    // prepared -> authority-committed creates G with sole parent pre-G base.
    let authorityWorktreeSynchronized = false;
    if (residue.stage === 'prepared') {
        const g = await git.commitAuthorityManifest({ baseTree: plan.authorityBaseTree, parent: plan.authorityBaseCommit, manifest: plan.authorityPathManifest, message: GRAPH_G_MESSAGE });
        await verifyAuthorityG(g, plan, git);
        await git.updateRefCas({ ref: plan.authorityRef, target: g.commit, expectedOld: plan.authorityBaseCommit });
        if (git.resolveRevision(plan.authorityRef) !== g.commit || git.resolveRevision('HEAD') !== g.commit)
            fail('authority G CAS did not make G the exact run-main HEAD', [plan.authorityRef, g.commit]);
        await git.synchronizeAuthorityWorktree(g.commit);
        authorityWorktreeSynchronized = true;
        residue = advanceD65GraphPublicationResidue(mainWorktreePath, {
            ...residue, stage: 'authority-committed', authority_commit: g.commit, authority_tree: g.tree, updated_at: plan.now(),
        });
    }
    const authorityCommit = residue.authority_commit;
    const authorityTree = residue.authority_tree;
    if (authorityCommit === null || authorityTree === null)
        fail('post-prepared residue is missing authority G/tree');
    await verifyAuthorityG({ commit: authorityCommit, tree: authorityTree }, plan, git);
    const recordedPublicationCommit = residue.publication_commit;
    const resumedAfterHeadFinalization = residue.stage === 'registered' && recordedPublicationCommit !== null && git.resolveRevision(plan.authorityRef) === recordedPublicationCommit && git.resolveRevision('HEAD') === recordedPublicationCommit;
    if (!resumedAfterHeadFinalization) {
        if (git.resolveRevision(plan.authorityRef) !== authorityCommit || git.resolveRevision('HEAD') !== authorityCommit)
            fail('recorded authority G is no longer the exact run-main HEAD', [plan.authorityRef, authorityCommit]);
        if (!authorityWorktreeSynchronized)
            await git.synchronizeAuthorityWorktree(authorityCommit);
    }
    const produced = await buildGraph({ commit: authorityCommit, tree: authorityTree });
    assertProducedGraphBindsAuthority(produced, graphSequence, authorityCommit, authorityTree, prefix);
    const graphSha256 = bytesSha256(produced.rootBytes);
    const graphRef = produced.rootRef;
    // authority-committed -> publication-committed creates graph-only H.
    if (residue.stage === 'authority-committed') {
        const h = await buildAndPublishGraphOnlyH(produced, authorityCommit, authorityTree, graphRef, prefix, git);
        residue = advanceD65GraphPublicationResidue(mainWorktreePath, {
            ...residue, stage: 'publication-committed', publication_commit: h.commit, publication_tree: h.tree,
            graph_ref: graphRef, graph_sha256: graphSha256, graph_byte_count: produced.rootBytes.length, updated_at: plan.now(),
        });
    }
    const publicationCommitForVerification = residue.publication_commit;
    const publicationTree = residue.publication_tree;
    if (publicationCommitForVerification === null || publicationTree === null)
        fail('post-authority residue is missing publication H/tree');
    await verifyGraphOnlyH(produced, authorityCommit, publicationCommitForVerification, publicationTree, prefix, git);
    if (residue.graph_ref !== graphRef || residue.graph_sha256 !== graphSha256 || residue.graph_byte_count !== produced.rootBytes.length)
        fail('publication residue graph identity differs from rebuilt graph bytes');
    // publication-committed -> registered commits R only after response or proof.
    if (residue.stage === 'publication-committed') {
        const r = await registerWithResponseLossRecovery(store, { artifactId, publicationCommit: publicationCommitForVerification, graphRef, graphSha256, coveredEventSeq: plan.coveredEventSeq });
        residue = advanceD65GraphPublicationResidue(mainWorktreePath, {
            ...residue, stage: 'registered', registration_event_seq: r.registrationEventSeq, updated_at: plan.now(),
        });
    }
    if (residue.stage !== 'registered')
        fail('publication did not reach the registered stage', [residue.stage]);
    const registrationEventSeq = residue.registration_event_seq;
    const publicationCommit = residue.publication_commit;
    if (registrationEventSeq === null || publicationCommit === null)
        fail('registered residue is missing R or H');
    // Once R is durable, H becomes the next run-authority base. Materialize only
    // its graph paths, CAS run-main G→H, align the index, and prove a clean HEAD.
    await git.finalizePublicationHead({ authorityRef: plan.authorityRef, authorityCommit, publicationCommit, graphPaths: graphBlobEntries(produced).map((entry) => entry.path) });
    if (git.resolveRevision(plan.authorityRef) !== publicationCommit || git.resolveRevision('HEAD') !== publicationCommit)
        fail('registered publication H did not become the exact run-main HEAD');
    // Descriptor-safe cleanup removes only this residue and proves its absence.
    cleanupD65GraphPublicationResidue(mainWorktreePath);
    return { graphSha256, publicationCommit, registrationEventSeq };
}
function preparedResidue(artifactId, graphSequence, plan) {
    const nowIso = plan.now();
    // Prior-tuple null discipline is enforced by the parser; we build the exact
    // shape for the two authority kinds.
    return {
        schema_version: 'autopilot.graph_publication.v1',
        publication_id: plan.publicationId,
        program_id: plan.programId,
        repo_id: plan.repoId,
        autopilot_id: plan.autopilotId,
        workstream_run: plan.workstreamRun,
        graph_sequence: graphSequence,
        artifact_id: artifactId,
        stage: 'prepared',
        prior_authority_kind: plan.priorAuthorityKind,
        prior_graph_sha256: plan.priorGraphSha256,
        prior_publication_commit: plan.priorPublicationCommit,
        prior_registration_event_seq: plan.priorRegistrationEventSeq,
        authority_base_commit: plan.authorityBaseCommit,
        authority_path_count: plan.authorityPathManifest.length,
        authority_path_manifest_sha256: plan.authorityPathManifestSha256,
        authority_commit: null,
        authority_tree: null,
        covered_event_seq: plan.coveredEventSeq,
        publication_commit: null,
        publication_tree: null,
        graph_ref: null,
        graph_sha256: null,
        graph_byte_count: null,
        registration_event_seq: null,
        created_at: nowIso,
        updated_at: nowIso,
    };
}
function assertResidueBindsThisGraph(residue, artifactId, graphSequence, plan) {
    if (residue.artifact_id !== artifactId)
        fail('existing residue binds a different artifact id', [residue.artifact_id, artifactId]);
    if (residue.graph_sequence !== graphSequence)
        fail('existing residue binds a different graph sequence');
    if (residue.publication_id !== plan.publicationId || residue.program_id !== plan.programId || residue.repo_id !== plan.repoId || residue.autopilot_id !== plan.autopilotId || residue.workstream_run !== plan.workstreamRun)
        fail('existing residue identity tuple differs from the publication plan');
    if (residue.prior_authority_kind !== plan.priorAuthorityKind || residue.prior_graph_sha256 !== plan.priorGraphSha256 || residue.prior_publication_commit !== plan.priorPublicationCommit || residue.prior_registration_event_seq !== plan.priorRegistrationEventSeq)
        fail('existing residue prior accepted tuple differs from the publication plan');
    if (residue.authority_base_commit !== plan.authorityBaseCommit)
        fail('existing residue binds a different authority base commit');
    if (residue.authority_path_count !== plan.authorityPathManifest.length || residue.authority_path_manifest_sha256 !== plan.authorityPathManifestSha256)
        fail('existing residue path manifest identity drifted');
    if (residue.covered_event_seq !== plan.coveredEventSeq)
        fail('existing residue covered_event_seq drifted');
}
function decodeManifestPath(pathB64) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}|[A-Za-z0-9+/]{3})?$/u.test(pathB64))
        fail('authority manifest path_b64 is not unpadded RFC 4648 base64', [pathB64]);
    const bytes = decodeUnpaddedBase64Url(pathB64.replace(/\+/gu, '-').replace(/\//gu, '_'));
    if (bytes === null)
        fail('authority manifest path_b64 is not decodable canonical base64', [pathB64]);
    const encoded = encodeUnpaddedBase64Url(bytes).replace(/-/gu, '+').replace(/_/gu, '/');
    if (bytes.length === 0 || encoded !== pathB64)
        fail('authority manifest path_b64 is not canonical base64', [pathB64]);
    return bytes;
}
function manifestMetadata(row, side) {
    return side === 'pre'
        ? { exists: row.pre_exists, mode: row.pre_mode, type: row.pre_type, oid: row.pre_oid }
        : { exists: row.post_exists, mode: row.post_mode, type: row.post_type, oid: row.post_oid };
}
function validateManifestMetadata(metadata, label) {
    if (!metadata.exists) {
        if (metadata.mode !== null || metadata.type !== null || metadata.oid !== null)
            fail(`${label} false existence requires null mode/type/oid`);
        return;
    }
    const validPair = (metadata.type === 'blob' && (metadata.mode === '100644' || metadata.mode === '100755' || metadata.mode === '120000'))
        || (metadata.type === 'commit' && metadata.mode === '160000');
    if (!validPair || metadata.oid === null || !/^[0-9a-f]{40}$/u.test(metadata.oid))
        fail(`${label} has an invalid Git mode/type/object-id tuple`);
}
function compareRaw(left, right) {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0)
            return difference;
    }
    return left.length - right.length;
}
function validateAuthorityManifest(plan) {
    if (!Number.isSafeInteger(plan.graphSequence) || plan.graphSequence < 2)
        fail('graph sequence must be a safe integer >= 2');
    if (canonicalSha256(plan.authorityPathManifest) !== plan.authorityPathManifestSha256)
        fail('authority path manifest digest does not match its canonical bytes');
    let prior = null;
    const aliases = new Set();
    for (const row of plan.authorityPathManifest) {
        const path = decodeManifestPath(row.path_b64);
        if (prior !== null && compareRaw(prior, path) >= 0)
            fail('authority path manifest is not strictly decoded-byte sorted');
        prior = path;
        let decoded;
        try {
            decoded = new TextDecoder('utf-8', { fatal: true }).decode(path);
        }
        catch {
            fail('authority path manifest path is not valid UTF-8 and cannot satisfy NFC/case alias checks', [row.path_b64]);
        }
        if (decoded.startsWith('semantic-graphs/'))
            fail('authority G manifest may not change graph publication paths', [decoded]);
        const alias = decoded.normalize('NFC').toLowerCase();
        if (aliases.has(alias))
            fail('authority path manifest contains an NFC/case-fold alias', [decoded]);
        aliases.add(alias);
        const pre = manifestMetadata(row, 'pre');
        const post = manifestMetadata(row, 'post');
        validateManifestMetadata(pre, `authority manifest preimage ${row.path_b64}`);
        validateManifestMetadata(post, `authority manifest postimage ${row.path_b64}`);
        if (pre.exists === post.exists && pre.mode === post.mode && pre.type === post.type && pre.oid === post.oid)
            fail('authority path manifest contains a no-op row', [row.path_b64]);
    }
}
function treeEntryMap(entries, label) {
    const output = new Map();
    for (const entry of entries) {
        decodeManifestPath(entry.path_b64);
        validateManifestMetadata({ exists: true, mode: entry.mode, type: entry.type, oid: entry.oid }, `${label} ${entry.path_b64}`);
        if (output.has(entry.path_b64))
            fail(`${label} contains duplicate path identity`, [entry.path_b64]);
        output.set(entry.path_b64, entry);
    }
    return output;
}
function treeEntryMatches(entry, expected) {
    if (!expected.exists)
        return entry === undefined;
    return entry !== undefined && entry.mode === expected.mode && entry.type === expected.type && entry.oid === expected.oid;
}
async function verifyAuthorityG(g, plan, git) {
    const baseTree = git.resolveTree(plan.authorityBaseCommit);
    if (baseTree !== plan.authorityBaseTree)
        fail('pre-G authority base no longer resolves to its sealed tree', [baseTree, plan.authorityBaseTree]);
    if (git.resolveTree(g.commit) !== g.tree)
        fail('authority G does not resolve to its recorded tree');
    const parents = git.revListParents(g.commit);
    if (parents.length !== 2 || parents[0] !== g.commit || parents[1] !== plan.authorityBaseCommit)
        fail('authority G does not have the sealed base as its sole parent', [`parents=${parents.join(',')}`]);
    const base = treeEntryMap(await git.readTreeEntries(plan.authorityBaseCommit), 'pre-G tree');
    const post = treeEntryMap(await git.readTreeEntries(g.commit), 'authority G tree');
    const manifest = new Map(plan.authorityPathManifest.map((row) => [row.path_b64, row]));
    const identities = new Set([...base.keys(), ...post.keys()]);
    for (const identity of identities) {
        const before = base.get(identity);
        const after = post.get(identity);
        const changed = before?.mode !== after?.mode || before?.type !== after?.type || before?.oid !== after?.oid;
        if (changed !== manifest.has(identity))
            fail('authority G changed a path outside the sealed manifest or omitted a sealed change', [identity]);
    }
    for (const row of plan.authorityPathManifest) {
        if (!treeEntryMatches(base.get(row.path_b64), manifestMetadata(row, 'pre')))
            fail('authority G manifest preimage differs from the sealed base tree', [row.path_b64]);
        if (!treeEntryMatches(post.get(row.path_b64), manifestMetadata(row, 'post')))
            fail('authority G manifest postimage differs from the constructed tree', [row.path_b64]);
    }
}
function assertProducedGraphBindsAuthority(produced, graphSequence, authorityCommit, authorityTree, prefix) {
    if (produced.root.graph_sequence !== graphSequence)
        fail('produced graph sequence differs from the sealed publication sequence');
    if (produced.root.covered_authority_commit !== authorityCommit || produced.root.covered_authority_tree !== authorityTree)
        fail('produced graph does not cover the constructed authority G/tree');
    if (!produced.rootRef.startsWith(prefix))
        fail('produced root ref is not under its sequence prefix', [produced.rootRef, prefix]);
}
async function verifyGraphOnlyH(produced, authorityCommit, publicationCommit, publicationTree, prefix, git) {
    if (git.resolveTree(publicationCommit) !== publicationTree)
        fail('publication H does not resolve to its recorded tree');
    const parents = git.revListParents(publicationCommit);
    if (parents.length !== 2 || parents[0] !== publicationCommit || parents[1] !== authorityCommit)
        fail('publication H does not have G as its sole parent', [`parents=${parents.join(',')}`]);
    const expectedEntries = graphBlobEntries(produced).map((entry) => ({ path: entry.path, oid: git.hashObject(entry.bytes) }));
    const diff = new Set(git.diffPaths(authorityCommit, publicationCommit).filter((path) => path.length > 0));
    const expectedPaths = new Set(expectedEntries.map((entry) => entry.path));
    if (diff.size !== expectedPaths.size || [...expectedPaths].some((path) => !diff.has(path)))
        fail('publication H diff is not exactly the produced graph paths');
    for (const path of diff)
        if (!path.startsWith(prefix))
            fail('publication H changes a non-graph path', [path]);
    const tree = treeEntryMap(await git.readTreeEntries(publicationCommit), 'publication H tree');
    for (const expected of expectedEntries) {
        const identity = encodeUnpaddedBase64Url(new TextEncoder().encode(expected.path)).replace(/-/gu, '+').replace(/_/gu, '/');
        const actual = tree.get(identity);
        if (actual === undefined || actual.mode !== '100644' || actual.type !== 'blob' || actual.oid !== expected.oid)
            fail('publication H graph blob postimage differs from produced bytes', [expected.path]);
    }
    const ref = `refs/heads/autopilot/graph/${prefix.replace(/\/$/u, '')}`;
    if (git.resolveRevision(ref) !== publicationCommit)
        fail('publication graph ref does not name H', [ref, publicationCommit]);
}
async function buildAndPublishGraphOnlyH(produced, authorityCommit, authorityTree, graphRef, prefix, git) {
    void graphRef;
    const entries = graphBlobEntries(produced).map((entry) => ({ oid: git.hashObject(entry.bytes), path: entry.path }));
    // H alone introduces the root/shards; its sole parent is the already-covered G.
    const h = git.commitTreeWithBlobs({ baseTree: authorityTree, parent: authorityCommit, entries, message: GRAPH_H_MESSAGE });
    const parents = git.revListParents(h.commit);
    if (parents.length !== 2 || parents[0] !== h.commit || parents[1] !== authorityCommit)
        fail('constructed H does not have exactly G as sole parent', [`parents=${parents.join(',')}`]);
    const diff = new Set(git.diffPaths(authorityCommit, h.commit).filter((path) => path.length > 0));
    const expected = new Set(entries.map((entry) => entry.path));
    if (diff.size !== expected.size || [...expected].some((path) => !diff.has(path)))
        fail('constructed H diff is not exactly the produced graph root/shard paths', [`diff=${[...diff].join(',')}`]);
    for (const path of diff)
        if (!path.startsWith(prefix))
            fail('constructed H changes a non-graph path', [path]);
    const publicationRef = `refs/heads/autopilot/graph/${prefix.replace(/\/$/u, '')}`;
    const existing = git.resolveRevision(publicationRef);
    if (existing === null) {
        try {
            await git.updateRefCas({ ref: publicationRef, target: h.commit, expectedOld: ZERO_OID });
        }
        catch (error) {
            // Effect-unknown CAS: a crash/response loss may have created this exact
            // deterministic ref while the residue still says authority-committed.
            // Recover only the byte-identical H; any other ref remains terminal.
            if (git.resolveRevision(publicationRef) !== h.commit)
                throw error;
        }
    }
    else if (existing !== h.commit) {
        fail('publication graph ref already names a different commit', [publicationRef, existing, h.commit]);
    }
    await verifyGraphOnlyH(produced, authorityCommit, h.commit, h.tree, prefix, git);
    return h;
}
async function registerWithResponseLossRecovery(store, input) {
    try {
        return await store.registerGraph(input);
    }
    catch (firstError) {
        // A typed definitive coordinator rejection cannot have committed and is
        // terminal. Transport/effect-unknown failures require immutable lookup.
        if (firstError instanceof CoordinationRuntimeError && firstError.retry_policy === 'never')
            throw firstError;
        const lookup = { artifactId: input.artifactId, publicationCommit: input.publicationCommit, graphRef: input.graphRef, graphSha256: input.graphSha256, coveredEventSeq: input.coveredEventSeq };
        const recovered = await store.lookupCommittedRegistration(lookup);
        if (recovered !== null)
            return recovered;
        try {
            return await store.registerGraph(input);
        }
        catch (retryError) {
            const recoveredRetry = await store.lookupCommittedRegistration(lookup);
            if (recoveredRetry !== null)
                return recoveredRetry;
            throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-publisher: byte-identical registration retry failed without a committed result', [firstError instanceof Error ? firstError.message : String(firstError), retryError instanceof Error ? retryError.message : String(retryError)]);
        }
    }
}
