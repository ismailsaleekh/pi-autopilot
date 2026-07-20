import { canonicalJson } from './canonical-json.ts';
import {
  D65_ATTACH_RUN_RESULT_V2_SCHEMA,
  bytesSha256,
  parseD65AttachRunBootstrapGraphPayload,
  parseD65SemanticGraphBootstrap,
  type D65AttachRunBootstrapGraphPayload,
  type D65AttachRunResultV2,
  type D65BootstrapGraphRef,
  type D65SemanticGraphBootstrap,
  type D65TrustAnchorResult,
} from './d65-semantic-graph.ts';
import { D65_ED25519_SPKI_BYTE_COUNT, parseD65TrustAnchorSpki } from './d65-trust.ts';
import { CoordinationRuntimeError } from './failures.ts';

// D65-A1 bootstrap vertical slice: validate the committed bootstrap + trust Git
// blobs at the exact current 40-hex `git_commit`, prove the prospective
// run/resource byte-equal the rows the same transaction will create, and derive
// the sole B-event `autopilot.attach_run_result.v2` effect and the exact rows.
// Any mismatch throws loudly; the caller rolls back every row/event/result.

/** A tracked Git blob at an exact commit: mode/type/oid + raw bytes. */
export interface D65GitBlobObserver {
  /** Resolve the exact 40-hex commit for a revision, or throw. */
  readonly resolveCommit: (revision: string) => string;
  /** Read a tracked blob's `{mode,type,oid,bytes}` at commit:path, or throw. */
  readonly readBlob: (commit: string, path: string) => { readonly mode: string; readonly type: 'blob'; readonly oid: string; readonly bytes: Uint8Array };
}

export interface D65BootstrapRows {
  readonly repository: Readonly<Record<string, unknown>>;
  readonly run: Readonly<Record<string, unknown>>;
  readonly runResource: Readonly<Record<string, unknown>>;
  readonly mailboxCursor: Readonly<Record<string, unknown>>;
  readonly bootstrapArtifact: Readonly<Record<string, unknown>>;
  readonly trustAnchor: D65TrustAnchorResult;
  readonly bootstrapGraphRef: D65BootstrapGraphRef;
  readonly attachResult: D65AttachRunResultV2;
  readonly bootstrapBytes: Uint8Array;
  readonly trustBytes: Uint8Array;
  readonly bootstrap: D65SemanticGraphBootstrap;
}

export interface D65BootstrapTransactionInput {
  readonly payload: unknown;
  readonly repoId: string;
  readonly workstreamRun: string;
  readonly attachEventSeq: number;
  /** The canonical repository row the transaction will create at B. */
  readonly repository: Readonly<Record<string, unknown>>;
  /** The canonical run row the transaction will create at B. */
  readonly run: Readonly<Record<string, unknown>>;
  /** The canonical run resource row the transaction will create at B. */
  readonly runResource: Readonly<Record<string, unknown>>;
  /** The canonical mailbox cursor row the transaction will create at B. */
  readonly mailboxCursor: Readonly<Record<string, unknown>>;
  /** Reads committed Git blobs from the run resource's canonical root. */
  readonly git: D65GitBlobObserver;
}

const TRUST_ANCHOR_MODE = '100644' as const;

/**
 * Validate a D65 attach-run.bootstrap_graph request and derive its exact B
 * rows/effect. `attachEventSeq` is the sole `run-attached` receipt B (event
 * sequence 1 for a fresh empty repository).
 */
export function deriveD65BootstrapTransaction(input: D65BootstrapTransactionInput): D65BootstrapRows {
  const payload: D65AttachRunBootstrapGraphPayload = parseD65AttachRunBootstrapGraphPayload(input.payload);

  // The blob and trust anchor must exist at the exact current 40-hex git_commit.
  const verified = input.git.resolveCommit(payload.git_commit);
  if (verified !== payload.git_commit) throw new CoordinationRuntimeError('invalid-request', 'bootstrap_graph git_commit is not the exact resolved commit', [payload.git_commit, verified]);

  // Read the bootstrap envelope blob and verify count/digest.
  const bootstrapBlob = input.git.readBlob(payload.git_commit, payload.ref);
  if (bootstrapBlob.type !== 'blob' || bootstrapBlob.mode !== TRUST_ANCHOR_MODE) throw new CoordinationRuntimeError('invalid-request', 'bootstrap graph ref must be a mode-100644 regular blob', [payload.ref, bootstrapBlob.mode]);
  if (bootstrapBlob.bytes.byteLength !== payload.byte_count) throw new CoordinationRuntimeError('invalid-request', 'bootstrap graph byte_count does not match the committed blob', [payload.ref, `bytes=${String(bootstrapBlob.bytes.byteLength)}`]);
  if (bytesSha256(bootstrapBlob.bytes) !== payload.sha256) throw new CoordinationRuntimeError('invalid-request', 'bootstrap graph sha256 does not match the committed blob');

  // Parse the bootstrap envelope strictly and bind identities to the request.
  const bootstrap = parseD65SemanticGraphBootstrap(parseJsonObject(bootstrapBlob.bytes, 'semantic graph bootstrap'));
  if (bootstrap.repo_id !== input.repoId || bootstrap.workstream_run !== input.workstreamRun) throw new CoordinationRuntimeError('invalid-request', 'bootstrap envelope repo/run identity disagrees with the attach request');
  if (bootstrap.trust_anchor_ref !== payload.trust_anchor_ref || bootstrap.trust_anchor_sha256 !== payload.trust_anchor_sha256) throw new CoordinationRuntimeError('invalid-request', 'bootstrap envelope trust anchor binding disagrees with the request');

  // Read the trust anchor blob and verify the frozen 44-byte SPKI + digest.
  const trustBlob = input.git.readBlob(payload.git_commit, payload.trust_anchor_ref);
  if (trustBlob.type !== 'blob' || trustBlob.mode !== TRUST_ANCHOR_MODE) throw new CoordinationRuntimeError('invalid-request', 'trust anchor ref must be a mode-100644 regular blob', [payload.trust_anchor_ref, trustBlob.mode]);
  if (trustBlob.bytes.byteLength !== D65_ED25519_SPKI_BYTE_COUNT) throw new CoordinationRuntimeError('invalid-request', 'trust anchor blob must be exactly 44 SPKI bytes', [`bytes=${String(trustBlob.bytes.byteLength)}`]);
  const anchor = parseD65TrustAnchorSpki(trustBlob.bytes);
  if (anchor.sha256 !== payload.trust_anchor_sha256) throw new CoordinationRuntimeError('invalid-request', 'trust anchor sha256 does not match the committed 44-byte SPKI blob', [payload.trust_anchor_sha256, anchor.sha256]);

  // Prospective run/resource must byte-equal the rows the transaction creates.
  requireByteEqual(bootstrap.prospective_run, input.run, 'bootstrap prospective_run');
  requireByteEqual(bootstrap.prospective_resource, input.runResource, 'bootstrap prospective_resource');
  requireByteEqual(payload.prospective_run, input.run, 'attach-run bootstrap_graph prospective_run');
  requireByteEqual(payload.prospective_resource, input.runResource, 'attach-run bootstrap_graph prospective_resource');

  const bootstrapArtifactId = `semantic-graph-bootstrap:${input.workstreamRun}`;
  const bootstrapArtifact = Object.freeze({
    schema_version: 'autopilot.authoritative_artifact.v1',
    artifact_id: bootstrapArtifactId,
    repo_id: input.repoId,
    source_run: input.workstreamRun,
    source_type: 'task',
    source_scope: 'repository',
    document_schema_version: 'autopilot.semantic_graph_bootstrap.v1',
    git_commit: payload.git_commit,
    evidence: { ref: payload.ref, sha256: payload.sha256 },
    registered_event_seq: input.attachEventSeq,
    version: 1,
  });

  const trustAnchorResult: D65TrustAnchorResult = {
    trust_anchor_ref: payload.trust_anchor_ref,
    trust_anchor_sha256: payload.trust_anchor_sha256,
    git_commit: payload.git_commit,
    git_mode: '100644',
    git_type: 'blob',
    git_blob_oid: trustBlob.oid,
    byte_count: 44,
  };

  const bootstrapGraphRef: D65BootstrapGraphRef = {
    ref: payload.ref,
    sha256: payload.sha256,
    byte_count: payload.byte_count,
    git_commit: payload.git_commit,
    covered_event_seq: 0,
  };

  const attachResult: D65AttachRunResultV2 = {
    schema_version: D65_ATTACH_RUN_RESULT_V2_SCHEMA,
    repository: input.repository,
    run: input.run,
    run_resource: input.runResource,
    mailbox_cursor: input.mailboxCursor,
    bootstrap_graph: bootstrapGraphRef,
    bootstrap_artifact: bootstrapArtifact,
    trust_anchor: trustAnchorResult,
  };

  return {
    repository: input.repository,
    run: input.run,
    runResource: input.runResource,
    mailboxCursor: input.mailboxCursor,
    bootstrapArtifact,
    trustAnchor: trustAnchorResult,
    bootstrapGraphRef,
    attachResult,
    bootstrapBytes: bootstrapBlob.bytes,
    trustBytes: trustBlob.bytes,
    bootstrap,
  };
}

function requireByteEqual(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new CoordinationRuntimeError('invalid-request', `${label} does not byte-equal the row the transaction creates`);
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
