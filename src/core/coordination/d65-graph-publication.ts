import { CoordinationRuntimeError } from './failures.ts';
import { bytesSha256, parseD65CompleteGraph, type D65CompleteGraph } from './d65-semantic-graph.ts';

// D65-A2 non-self-referential publication validation (fresh plan "Non-self-
// referential publication"). Graph N covers authority commit/tree G and
// coordinator snapshot through event E, and EXCLUDES its own root/shards/
// artifact row. A graph-only publication commit H has sole parent G. This is
// the pure validation of the Git-observed facts at registration time; the store
// supplies the observations and performs the R=E+1 CAS. Failures are
// authority-critical `semantic-graph-artifact-invalid` / `-discovery-mismatch`.

/** The deterministic graph artifact id `semantic-graph:<20-digit-sequence>`. */
export function d65SemanticGraphArtifactId(graphSequence: number): string {
  if (!Number.isSafeInteger(graphSequence) || graphSequence < 2) throw new CoordinationRuntimeError('invalid-request', 'complete graph sequence must be >= 2');
  return `semantic-graph:${String(graphSequence).padStart(20, '0')}`;
}

/** The frozen graph publication path prefix for a sequence. */
export function d65GraphPathPrefix(graphSequence: number): string {
  return `semantic-graphs/${String(graphSequence).padStart(20, '0')}/`;
}

export interface D65GraphPublicationObservation {
  /** The publication commit H (40-hex). */
  readonly publicationCommit: string;
  /** The exact space-separated parents of H from `rev-list --parents -n 1 H`. */
  readonly publicationParents: readonly string[];
  /** The decoded NUL-separated changed paths of the G..H diff. */
  readonly diffPaths: readonly string[];
  /** The exact graph root blob bytes read at H:graph_ref. */
  readonly graphRootBytes: Uint8Array;
  /** The sealed graph digest recorded in the registration request. */
  readonly sealedGraphSha256: `sha256:${string}`;
  /** The graph root ref (repository-relative) recorded in the request. */
  readonly graphRef: string;
}

export interface D65GraphPublicationFacts {
  readonly graph: D65CompleteGraph;
  readonly artifactId: string;
  readonly authorityCommit: string;
  readonly publicationCommit: string;
  readonly coveredEventSeq: number;
}

/**
 * Validate the non-self-referential publication of a complete graph registered
 * at publication commit H. Requires:
 *  - the graph root blob bytes hash to the sealed digest;
 *  - the parsed graph's `covered_authority_commit` (G) equals the request's
 *    authority commit and the graph's `graph_sequence` matches the artifact id;
 *  - H has EXACTLY one parent and it is G (sole-parent-G);
 *  - the G..H diff touches ONLY paths under `semantic-graphs/<seq>/`
 *    (graph-only diff, self-exclusion of authority/product/source);
 *  - the graph root ref is itself under that prefix.
 */
export function validateD65GraphPublication(input: {
  readonly observation: D65GraphPublicationObservation;
  readonly expectedAuthorityCommit: string;
  readonly expectedCoveredEventSeq: number;
}): D65GraphPublicationFacts {
  const { observation } = input;
  // 1. Graph root blob integrity.
  if (bytesSha256(observation.graphRootBytes) !== observation.sealedGraphSha256) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: graph root blob does not match the sealed graph_sha256');
  const graph = parseD65CompleteGraph(parseJsonObject(observation.graphRootBytes, 'semantic graph root'));

  // 2. Authority binding.
  if (graph.covered_authority_commit !== input.expectedAuthorityCommit) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: graph covered_authority_commit disagrees with the registration authority commit', [graph.covered_authority_commit, input.expectedAuthorityCommit]);
  if (graph.covered_event_seq !== input.expectedCoveredEventSeq) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: graph covered_event_seq disagrees with the registration snapshot E', [String(graph.covered_event_seq), String(input.expectedCoveredEventSeq)]);
  const artifactId = d65SemanticGraphArtifactId(graph.graph_sequence);
  const prefix = d65GraphPathPrefix(graph.graph_sequence);

  // 3. Sole-parent-G: H has exactly one parent and it is G.
  // rev-list --parents -n 1 H => [H, parent1, parent2, ...]
  if (observation.publicationParents.length < 1 || observation.publicationParents[0] !== observation.publicationCommit) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: publication parent listing does not lead with the publication commit');
  const parents = observation.publicationParents.slice(1);
  if (parents.length !== 1) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: publication commit H must have exactly one parent', [`parents=${String(parents.length)}`]);
  if (parents[0] !== graph.covered_authority_commit) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: publication commit H sole parent is not the covered authority commit G', [String(parents[0]), graph.covered_authority_commit]);

  // 4. Graph-only diff: G..H changes only paths under the graph prefix.
  for (const path of observation.diffPaths) {
    if (path.length === 0) continue;
    if (!path.startsWith(prefix)) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-discovery-mismatch: publication commit H changes a non-graph path', [path]);
  }
  // The graph must actually publish at least its own root path change.
  if (observation.diffPaths.filter((path) => path.length > 0).length === 0) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-discovery-mismatch: publication commit H has no graph-path changes');

  // 5. The graph root ref lives under the graph prefix (self-exclusion domain).
  if (!observation.graphRef.startsWith(prefix)) throw new CoordinationRuntimeError('invalid-request', 'semantic-graph-artifact-invalid: graph root ref is not under its sequence prefix', [observation.graphRef, prefix]);

  return {
    graph,
    artifactId,
    authorityCommit: graph.covered_authority_commit,
    publicationCommit: observation.publicationCommit,
    coveredEventSeq: graph.covered_event_seq,
  };
}

function parseJsonObject(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new CoordinationRuntimeError('invalid-request', `${label} is not valid UTF-8`, [error instanceof Error ? error.message : String(error)]);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CoordinationRuntimeError('invalid-request', `${label} is not valid JSON`, [error instanceof Error ? error.message : String(error)]);
  }
}
