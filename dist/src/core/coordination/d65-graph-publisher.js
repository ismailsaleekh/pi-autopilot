import { CoordinationRuntimeError } from "./failures.js";
import { advanceD65GraphPublicationResidue, createD65GraphPublicationResidue, cleanupD65GraphPublicationResidue, readD65GraphPublicationResidue, } from "./d65-graph-publication-residue.js";
import { d65SemanticGraphArtifactId } from "./d65-graph-publication.js";
import { bytesSha256 } from "./d65-semantic-graph.js";
const ZERO_OID = '0'.repeat(40);
const GRAPH_G_MESSAGE = 'autopilot: graph authority commit G\n';
const GRAPH_H_MESSAGE = 'autopilot: graph publication commit H\n';
function fail(issue, detail = []) {
    throw new CoordinationRuntimeError('invalid-state', `semantic-graph-publisher: ${issue}`, detail);
}
/** The exact graph paths (root + shards) that G must introduce, decoded-byte-sorted. */
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
export function publishD65CompleteGraph(input) {
    const { mainWorktreePath, produced, plan, git, store } = input;
    const graphSequence = produced.root.graph_sequence;
    const artifactId = d65SemanticGraphArtifactId(graphSequence);
    const graphSha256 = bytesSha256(produced.rootBytes);
    const graphRef = produced.rootRef;
    const prefix = `semantic-graphs/${String(graphSequence).padStart(20, '0')}/`;
    if (!graphRef.startsWith(prefix))
        fail('produced root ref is not under its sequence prefix', [graphRef, prefix]);
    // Resume from any existing residue (crash/response-loss safe); else create it.
    let residue = readD65GraphPublicationResidue(mainWorktreePath);
    if (residue === null) {
        residue = createD65GraphPublicationResidue(mainWorktreePath, preparedResidue(artifactId, graphSequence, graphSha256, graphRef, produced, plan));
    }
    else {
        assertResidueBindsThisGraph(residue, artifactId, graphSequence, plan);
    }
    // Stage: prepared -> authority-committed (build G).
    if (residue.stage === 'prepared') {
        const g = buildAuthorityCommitG(produced, plan, git);
        residue = advanceD65GraphPublicationResidue(mainWorktreePath, {
            ...residue, stage: 'authority-committed', authority_commit: g.commit, authority_tree: g.tree, updated_at: plan.now(),
        });
    }
    // Stage: authority-committed -> publication-committed (build + publish H).
    if (residue.stage === 'authority-committed') {
        const authorityCommit = residue.authority_commit;
        if (authorityCommit === null)
            fail('authority-committed residue is missing authority_commit');
        const h = buildAndPublishGraphOnlyH(produced, authorityCommit, graphRef, prefix, git);
        residue = advanceD65GraphPublicationResidue(mainWorktreePath, {
            ...residue, stage: 'publication-committed', publication_commit: h.commit, publication_tree: h.tree,
            graph_ref: graphRef, graph_sha256: graphSha256, graph_byte_count: produced.rootBytes.length, updated_at: plan.now(),
        });
    }
    // Stage: publication-committed -> registered (store register, then advance
    // ONLY after a committed response or exact response-loss recovery).
    if (residue.stage === 'publication-committed') {
        const publicationCommit = residue.publication_commit;
        if (publicationCommit === null)
            fail('publication-committed residue is missing publication_commit');
        const r = registerWithResponseLossRecovery(store, { artifactId, publicationCommit, graphRef, graphSha256, coveredEventSeq: plan.coveredEventSeq });
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
    // Descriptor-safe cleanup removes only this residue and proves its absence.
    cleanupD65GraphPublicationResidue(mainWorktreePath);
    return { graphSha256, publicationCommit, registrationEventSeq };
}
function preparedResidue(artifactId, graphSequence, graphSha256, graphRef, produced, plan) {
    void graphSha256;
    void graphRef;
    void produced;
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
    if (residue.authority_base_commit !== plan.authorityBaseCommit)
        fail('existing residue binds a different authority base commit');
    if (residue.authority_path_manifest_sha256 !== plan.authorityPathManifestSha256)
        fail('existing residue path manifest digest drifted');
    if (residue.covered_event_seq !== plan.coveredEventSeq)
        fail('existing residue covered_event_seq drifted');
}
function buildAuthorityCommitG(produced, plan, git) {
    // Hash every graph blob, then build G with base tree + exactly those blobs.
    const entries = graphBlobEntries(produced).map((entry) => ({ oid: git.hashObject(entry.bytes), path: entry.path }));
    const g = git.commitTreeWithBlobs({ baseTree: plan.authorityBaseTree, parent: plan.authorityBaseCommit, entries, message: GRAPH_G_MESSAGE });
    // Deterministic one-parent G: verify sole parent = authority base commit.
    const parents = git.revListParents(g.commit);
    if (parents.length !== 2 || parents[0] !== g.commit || parents[1] !== plan.authorityBaseCommit) {
        fail('constructed G does not have exactly the authority base commit as sole parent', [`parents=${parents.join(',')}`]);
    }
    // G..base authority extension: the base..G diff must be exactly the graph paths.
    const diff = new Set(git.diffPaths(plan.authorityBaseCommit, g.commit).filter((path) => path.length > 0));
    const expected = new Set(entries.map((entry) => entry.path));
    if (diff.size !== expected.size || [...expected].some((path) => !diff.has(path))) {
        fail('constructed G diff is not exactly the produced graph paths', [`diff=${[...diff].join(',')}`]);
    }
    return g;
}
function buildAndPublishGraphOnlyH(produced, authorityCommit, graphRef, prefix, git) {
    void produced;
    void graphRef;
    // H is graph-only: sole parent G, tree identical to G's tree (no new authority
    // change beyond the graph blobs already introduced in G). The publication
    // commit "may change only those graph paths" - here its tree equals G's, so the
    // G..H diff is empty and the publication is graph-only by construction.
    const gTree = git.resolveTree(authorityCommit);
    const hCommit = git.commitTree({ tree: gTree, parent: authorityCommit, message: GRAPH_H_MESSAGE });
    const parents = git.revListParents(hCommit);
    if (parents.length !== 2 || parents[0] !== hCommit || parents[1] !== authorityCommit) {
        fail('constructed H does not have exactly G as sole parent', [`parents=${parents.join(',')}`]);
    }
    // Graph-only diff: G..H changes only paths under the graph prefix (empty here).
    for (const path of git.diffPaths(authorityCommit, hCommit)) {
        if (path.length > 0 && !path.startsWith(prefix))
            fail('constructed H changes a non-graph path', [path]);
    }
    // Publish H to the graph ref by CAS (create from the zero oid).
    git.updateRefCas({ ref: `refs/heads/autopilot/graph/${prefix.replace(/\/$/u, '')}`, target: hCommit, expectedOld: ZERO_OID });
    return { commit: hCommit, tree: gTree };
}
function registerWithResponseLossRecovery(store, input) {
    try {
        return store.registerGraph(input);
    }
    catch (error) {
        // On any failure, attempt exact response-loss recovery: query the immutable
        // artifact/event/result. Present => complete with the proven R; absent =>
        // the register did not commit, rethrow the original loud failure (the caller
        // stays fenced under graph-publication-pending; NO auto-retry/rewrite here).
        const recovered = store.lookupCommittedRegistration({ artifactId: input.artifactId, publicationCommit: input.publicationCommit, graphSha256: input.graphSha256, coveredEventSeq: input.coveredEventSeq });
        if (recovered !== null)
            return recovered;
        throw error;
    }
}
