import { canonicalJson } from "./canonical-json.js";
import { D65_ATTACH_RUN_RESULT_V2_SCHEMA, bytesSha256, parseD65AttachRunBootstrapGraphPayload, parseD65SemanticGraphBootstrap, } from "./d65-semantic-graph.js";
import { D65_ED25519_SPKI_BYTE_COUNT, parseD65TrustAnchorSpki } from "./d65-trust.js";
import { CoordinationRuntimeError } from "./failures.js";
const TRUST_ANCHOR_MODE = '100644';
/**
 * Validate a D65 attach-run.bootstrap_graph request and derive its exact B
 * rows/effect. `attachEventSeq` is the sole `run-attached` receipt B (event
 * sequence 1 for a fresh empty repository).
 */
export function deriveD65BootstrapTransaction(input) {
    const payload = parseD65AttachRunBootstrapGraphPayload(input.payload);
    // The blob and trust anchor must exist at the exact current 40-hex git_commit.
    const verified = input.git.resolveCommit(payload.git_commit);
    if (verified !== payload.git_commit)
        throw new CoordinationRuntimeError('invalid-request', 'bootstrap_graph git_commit is not the exact resolved commit', [payload.git_commit, verified]);
    // Read the bootstrap envelope blob and verify count/digest.
    const bootstrapBlob = input.git.readBlob(payload.git_commit, payload.ref);
    if (bootstrapBlob.type !== 'blob' || bootstrapBlob.mode !== TRUST_ANCHOR_MODE)
        throw new CoordinationRuntimeError('invalid-request', 'bootstrap graph ref must be a mode-100644 regular blob', [payload.ref, bootstrapBlob.mode]);
    if (bootstrapBlob.bytes.byteLength !== payload.byte_count)
        throw new CoordinationRuntimeError('invalid-request', 'bootstrap graph byte_count does not match the committed blob', [payload.ref, `bytes=${String(bootstrapBlob.bytes.byteLength)}`]);
    if (bytesSha256(bootstrapBlob.bytes) !== payload.sha256)
        throw new CoordinationRuntimeError('invalid-request', 'bootstrap graph sha256 does not match the committed blob');
    // Parse the bootstrap envelope strictly and bind identities to the request.
    const bootstrap = parseD65SemanticGraphBootstrap(parseJsonObject(bootstrapBlob.bytes, 'semantic graph bootstrap'));
    if (bootstrap.repo_id !== input.repoId || bootstrap.workstream_run !== input.workstreamRun)
        throw new CoordinationRuntimeError('invalid-request', 'bootstrap envelope repo/run identity disagrees with the attach request');
    if (bootstrap.trust_anchor_ref !== payload.trust_anchor_ref || bootstrap.trust_anchor_sha256 !== payload.trust_anchor_sha256)
        throw new CoordinationRuntimeError('invalid-request', 'bootstrap envelope trust anchor binding disagrees with the request');
    // Read the trust anchor blob and verify the frozen 44-byte SPKI + digest.
    const trustBlob = input.git.readBlob(payload.git_commit, payload.trust_anchor_ref);
    if (trustBlob.type !== 'blob' || trustBlob.mode !== TRUST_ANCHOR_MODE)
        throw new CoordinationRuntimeError('invalid-request', 'trust anchor ref must be a mode-100644 regular blob', [payload.trust_anchor_ref, trustBlob.mode]);
    if (trustBlob.bytes.byteLength !== D65_ED25519_SPKI_BYTE_COUNT)
        throw new CoordinationRuntimeError('invalid-request', 'trust anchor blob must be exactly 44 SPKI bytes', [`bytes=${String(trustBlob.bytes.byteLength)}`]);
    const anchor = parseD65TrustAnchorSpki(trustBlob.bytes);
    if (anchor.sha256 !== payload.trust_anchor_sha256)
        throw new CoordinationRuntimeError('invalid-request', 'trust anchor sha256 does not match the committed 44-byte SPKI blob', [payload.trust_anchor_sha256, anchor.sha256]);
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
    const trustAnchorResult = {
        trust_anchor_ref: payload.trust_anchor_ref,
        trust_anchor_sha256: payload.trust_anchor_sha256,
        git_commit: payload.git_commit,
        git_mode: '100644',
        git_type: 'blob',
        git_blob_oid: trustBlob.oid,
        byte_count: 44,
    };
    const bootstrapGraphRef = {
        ref: payload.ref,
        sha256: payload.sha256,
        byte_count: payload.byte_count,
        git_commit: payload.git_commit,
        covered_event_seq: 0,
    };
    const attachResult = {
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
function requireByteEqual(actual, expected, label) {
    if (canonicalJson(actual) !== canonicalJson(expected))
        throw new CoordinationRuntimeError('invalid-request', `${label} does not byte-equal the row the transaction creates`);
}
function parseJsonObject(bytes, label) {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-request', `${label} is not valid UTF-8`, [error instanceof Error ? error.message : String(error)]);
    }
    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-request', `${label} is not valid JSON`, [error instanceof Error ? error.message : String(error)]);
    }
}
