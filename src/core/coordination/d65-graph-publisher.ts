import { CoordinationRuntimeError } from './failures.ts';
import {
  advanceD65GraphPublicationResidue,
  createD65GraphPublicationResidue,
  cleanupD65GraphPublicationResidue,
  readD65GraphPublicationResidue,
} from './d65-graph-publication-residue.ts';
import { d65SemanticGraphArtifactId } from './d65-graph-publication.ts';
import { bytesSha256, type D65GraphPublication } from './d65-semantic-graph.ts';
import type { D65ProducedGraph } from './d65-graph-producer.ts';

// D65-A2/A5 runtime graph-publication saga consumer (fresh plan "Graph
// publication is owned by the graph consumer through the closed mutable saga
// residue" + "Non-self-referential publication"). This is the RUNTIME driver
// that composes slice 1 (isolated-index Git plumbing) and slice 2 (complete-
// graph producer) with the residue lifecycle module to publish a complete graph:
//
//   createResidue(prepared)
//     -> authority-committed  : commit G (sole parent authority_base_commit,
//                               tree = base tree + exactly the produced graph
//                               blobs), branch-CAS-free object build
//     -> publication-committed: commit graph-only H (sole parent G), publish it
//                               to the graph ref by branch CAS
//     -> submit store register (Lane B gateway; the store transaction commits the
//                               artifact/R event/idempotency result WITHOUT any
//                               residue filesystem write - SR-1)
//     -> registered            : advance the residue ONLY after a committed
//                               response, or after exact response-loss recovery
//                               proving the immutable artifact/event/result
//   cleanup(registered residue).
//
// The Git and store operations are injected seams so the saga is fully testable
// in isolation; the real coordinator/runtime caller passes the actual
// runGitPlumbing/runGitQuery/runGitMutation-backed executor and Lane B's store
// gateway. A failed publication preserves G/H and the residue: NO reset, rewrite,
// alternate artifact id, or auto-replacement graph is ever produced.

/** A single sealed G path-manifest row (raw-byte-sorted by decoded path). */
export interface D65GraphPathManifestRow {
  readonly path_b64: string;
  readonly pre_exists: boolean;
  readonly pre_mode: string | null;
  readonly pre_type: string | null;
  readonly pre_oid: string | null;
  readonly post_exists: boolean;
  readonly post_mode: string | null;
  readonly post_type: string | null;
  readonly post_oid: string | null;
}

/** The Git object-construction seam (slice-1 plumbing, bound to a repo + isolated index). */
export interface D65GraphGitOps {
  /** Write a blob object from bytes; returns its 40-hex oid. */
  hashObject(bytes: Uint8Array): string;
  /**
   * Build a commit whose tree is `baseTree` plus exactly `entries`
   * (mode-100644 blobs at their repo-relative paths), with the given single
   * parent, under the fixed publication identity. Uses an isolated index only.
   * Returns `{ commit, tree }` (both 40-hex).
   */
  commitTreeWithBlobs(input: {
    readonly baseTree: string;
    readonly parent: string;
    readonly entries: readonly { readonly oid: string; readonly path: string }[];
    readonly message: string;
  }): { readonly commit: string; readonly tree: string };
  /** Build a commit over an existing `tree` with a single `parent` (graph-only H). */
  commitTree(input: { readonly tree: string; readonly parent: string; readonly message: string }): string;
  /** Resolve a commit's tree oid (40-hex). */
  resolveTree(commit: string): string;
  /** The parents of `commit` as returned by `rev-list --parents -n 1` (leading commit + parents). */
  revListParents(commit: string): readonly string[];
  /** The decoded changed paths of the `from..to` diff. */
  diffPaths(from: string, to: string): readonly string[];
  /** Publish `commit` to `ref` by CAS from `expectedOld` (or the zero oid for create). */
  updateRefCas(input: { readonly ref: string; readonly target: string; readonly expectedOld: string }): void;
}

/** The store operations Lane B owns (SR-1 register without residue write; SR-2 response-loss lookup). */
export interface D65GraphPublicationStoreGateway {
  /**
   * Submit `register-authoritative-artifact` for the graph at publication commit
   * H. The store validates (non-self-referential publication + loader) and commits
   * the artifact, the R=E+1 event, and the idempotency result in ONE SQLite
   * transaction with NO residue filesystem mutation. Returns the committed R.
   * Throws loudly on validation/CAS failure. On a lost response the caller uses
   * `lookupCommittedRegistration` instead of assuming success.
   */
  registerGraph(input: {
    readonly artifactId: string;
    readonly publicationCommit: string;
    readonly graphRef: string;
    readonly graphSha256: `sha256:${string}`;
    readonly coveredEventSeq: number;
  }): { readonly registrationEventSeq: number };
  /**
   * Response-loss recovery lookup: prove the exact immutable artifact/event/result
   * for this graph exists (returns its R), or that it is absent (null) so the
   * caller retries the byte-identical register. Any partial/mismatched row/event/
   * result is terminal (throws), never a soft "assume committed".
   */
  lookupCommittedRegistration(input: {
    readonly artifactId: string;
    readonly publicationCommit: string;
    readonly graphSha256: `sha256:${string}`;
    readonly coveredEventSeq: number;
  }): { readonly registrationEventSeq: number } | null;
}

/** The immutable header/prior-tuple fields the residue records for this publication. */
export interface D65GraphPublicationPlan {
  readonly publicationId: string;
  readonly programId: string;
  readonly repoId: string;
  readonly autopilotId: string;
  readonly workstreamRun: string;
  readonly priorAuthorityKind: 'bootstrap' | 'complete';
  readonly priorGraphSha256: `sha256:${string}`;
  readonly priorPublicationCommit: string | null;
  readonly priorRegistrationEventSeq: number;
  /** The exact current run-authority HEAD G is parented onto. */
  readonly authorityBaseCommit: string;
  /** The base tree G's tree extends (authority-base HEAD tree). */
  readonly authorityBaseTree: string;
  /** The sealed, raw-byte-sorted G path manifest and its digest/count. */
  readonly authorityPathManifest: readonly D65GraphPathManifestRow[];
  readonly authorityPathManifestSha256: `sha256:${string}`;
  readonly coveredEventSeq: number;
  /** ISO timestamp for created_at/updated_at seeding. */
  readonly now: () => string;
}

const ZERO_OID = '0'.repeat(40);
const GRAPH_G_MESSAGE = 'autopilot: graph authority commit G\n';
const GRAPH_H_MESSAGE = 'autopilot: graph publication commit H\n';

function fail(issue: string, detail: readonly string[] = []): never {
  throw new CoordinationRuntimeError('invalid-state', `semantic-graph-publisher: ${issue}`, detail);
}

/** The exact graph paths (root + shards) that G must introduce, decoded-byte-sorted. */
function graphBlobEntries(produced: D65ProducedGraph): readonly { readonly oid: string; readonly path: string; readonly bytes: Uint8Array }[] {
  const entries = [
    { path: produced.rootRef, bytes: produced.rootBytes },
    ...produced.shards.map((shard) => ({ path: shard.ref, bytes: shard.bytes })),
  ];
  const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i - 1]?.path === sorted[i]?.path) fail('duplicate graph blob path in the produced graph', [sorted[i]?.path ?? '']);
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
export function publishD65CompleteGraph(input: {
  readonly mainWorktreePath: string;
  readonly produced: D65ProducedGraph;
  readonly plan: D65GraphPublicationPlan;
  readonly git: D65GraphGitOps;
  readonly store: D65GraphPublicationStoreGateway;
}): { readonly graphSha256: `sha256:${string}`; readonly publicationCommit: string; readonly registrationEventSeq: number } {
  const { mainWorktreePath, produced, plan, git, store } = input;
  const graphSequence = produced.root.graph_sequence;
  const artifactId = d65SemanticGraphArtifactId(graphSequence);
  const graphSha256 = bytesSha256(produced.rootBytes);
  const graphRef = produced.rootRef;
  const prefix = `semantic-graphs/${String(graphSequence).padStart(20, '0')}/`;
  if (!graphRef.startsWith(prefix)) fail('produced root ref is not under its sequence prefix', [graphRef, prefix]);

  // Resume from any existing residue (crash/response-loss safe); else create it.
  let residue = readD65GraphPublicationResidue(mainWorktreePath);
  if (residue === null) {
    residue = createD65GraphPublicationResidue(mainWorktreePath, preparedResidue(artifactId, graphSequence, graphSha256, graphRef, produced, plan));
  } else {
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
    if (authorityCommit === null) fail('authority-committed residue is missing authority_commit');
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
    if (publicationCommit === null) fail('publication-committed residue is missing publication_commit');
    const r = registerWithResponseLossRecovery(store, { artifactId, publicationCommit, graphRef, graphSha256, coveredEventSeq: plan.coveredEventSeq });
    residue = advanceD65GraphPublicationResidue(mainWorktreePath, {
      ...residue, stage: 'registered', registration_event_seq: r.registrationEventSeq, updated_at: plan.now(),
    });
  }

  if (residue.stage !== 'registered') fail('publication did not reach the registered stage', [residue.stage]);
  const registrationEventSeq = residue.registration_event_seq;
  const publicationCommit = residue.publication_commit;
  if (registrationEventSeq === null || publicationCommit === null) fail('registered residue is missing R or H');

  // Descriptor-safe cleanup removes only this residue and proves its absence.
  cleanupD65GraphPublicationResidue(mainWorktreePath);
  return { graphSha256, publicationCommit, registrationEventSeq };
}

function preparedResidue(
  artifactId: string,
  graphSequence: number,
  graphSha256: `sha256:${string}`,
  graphRef: string,
  produced: D65ProducedGraph,
  plan: D65GraphPublicationPlan,
): D65GraphPublication {
  void graphSha256; void graphRef; void produced;
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

function assertResidueBindsThisGraph(residue: D65GraphPublication, artifactId: string, graphSequence: number, plan: D65GraphPublicationPlan): void {
  if (residue.artifact_id !== artifactId) fail('existing residue binds a different artifact id', [residue.artifact_id, artifactId]);
  if (residue.graph_sequence !== graphSequence) fail('existing residue binds a different graph sequence');
  if (residue.authority_base_commit !== plan.authorityBaseCommit) fail('existing residue binds a different authority base commit');
  if (residue.authority_path_manifest_sha256 !== plan.authorityPathManifestSha256) fail('existing residue path manifest digest drifted');
  if (residue.covered_event_seq !== plan.coveredEventSeq) fail('existing residue covered_event_seq drifted');
}

function buildAuthorityCommitG(produced: D65ProducedGraph, plan: D65GraphPublicationPlan, git: D65GraphGitOps): { readonly commit: string; readonly tree: string } {
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

function buildAndPublishGraphOnlyH(produced: D65ProducedGraph, authorityCommit: string, graphRef: string, prefix: string, git: D65GraphGitOps): { readonly commit: string; readonly tree: string } {
  void produced; void graphRef;
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
    if (path.length > 0 && !path.startsWith(prefix)) fail('constructed H changes a non-graph path', [path]);
  }
  // Publish H to the graph ref by CAS (create from the zero oid).
  git.updateRefCas({ ref: `refs/heads/autopilot/graph/${prefix.replace(/\/$/u, '')}`, target: hCommit, expectedOld: ZERO_OID });
  return { commit: hCommit, tree: gTree };
}

function registerWithResponseLossRecovery(
  store: D65GraphPublicationStoreGateway,
  input: { readonly artifactId: string; readonly publicationCommit: string; readonly graphRef: string; readonly graphSha256: `sha256:${string}`; readonly coveredEventSeq: number },
): { readonly registrationEventSeq: number } {
  try {
    return store.registerGraph(input);
  } catch (error) {
    // On any failure, attempt exact response-loss recovery: query the immutable
    // artifact/event/result. Present => complete with the proven R; absent =>
    // the register did not commit, rethrow the original loud failure (the caller
    // stays fenced under graph-publication-pending; NO auto-retry/rewrite here).
    const recovered = store.lookupCommittedRegistration({ artifactId: input.artifactId, publicationCommit: input.publicationCommit, graphSha256: input.graphSha256, coveredEventSeq: input.coveredEventSeq });
    if (recovered !== null) return recovered;
    throw error;
  }
}


