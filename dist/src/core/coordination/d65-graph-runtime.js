import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { rm, mkdtemp } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';
import { runGitMutation, runGitPlumbing, runGitQuery, runGitStreamingLsTree } from "../git-process.js";
import { canonicalJson } from "./canonical-json.js";
import { parseCoordinationAuthoritativeArtifact, parseCoordinationRun } from "./contracts.js";
import { d65GraphRegistrationIdempotencyKey } from "./d65-graph-publication.js";
import { decodeUnpaddedBase64Url, encodeUnpaddedBase64Url } from "./d65-trust.js";
import { CoordinationRuntimeError } from "./failures.js";
import { readImmutableFileBytes } from "./immutable-file.js";
const GRAPH_COMMIT_IDENTITY = Object.freeze({ name: 'autopilot', email: 'autopilot@invalid', date: '1700000000 +0000' });
const GRAPH_LOOKUP_EXPORT_MAX_BYTES = 536_870_912;
function jsonMap(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-state', `${label} is not a JSON object`);
    return value;
}
function jsonArray(value, label) {
    if (!Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-state', `${label} is not an array`);
    return value;
}
function textField(value, field, label) {
    const candidate = value[field];
    if (typeof candidate !== 'string')
        throw new CoordinationRuntimeError('invalid-state', `${label}.${field} is not text`);
    return candidate;
}
function integerField(value, field, label) {
    const candidate = value[field];
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0)
        throw new CoordinationRuntimeError('invalid-state', `${label}.${field} is not a nonnegative safe integer`);
    return candidate;
}
function oid(result, label) {
    if (result.oid === null || !/^[a-f0-9]{40}$/u.test(result.oid))
        throw new CoordinationRuntimeError('invalid-state', `${label} did not return one 40-hex object id`);
    return result.oid;
}
function queryText(repoRoot, descriptor) {
    const result = runGitQuery({ cwd: repoRoot, descriptor });
    if (result.negative)
        throw new CoordinationRuntimeError('invalid-state', `Git query ${descriptor.kind} returned an absent result`);
    return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).trim();
}
function resolveRevision(repoRoot, revision) {
    const result = runGitQuery({ cwd: repoRoot, descriptor: { kind: 'resolve-revision', revision, verify: true } });
    if (result.negative)
        return null;
    const value = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).trim();
    if (!/^[0-9a-f]{40}$/u.test(value))
        throw new CoordinationRuntimeError('invalid-state', 'Git revision did not resolve to one 40-hex object id', [revision, value]);
    return value;
}
/** Production G reader for pure complete-graph authority/body discovery. */
export function readD65GraphAuthorityAtCommit(repoRoot, commit) {
    const result = runGitQuery({ cwd: repoRoot, descriptor: { kind: 'ls-tree-recursive', revision: commit, includeSize: false } });
    let decoded;
    try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-discovery-mismatch: G contains a non-UTF-8 path', [error instanceof Error ? error.message : String(error)]);
    }
    const entries = decoded.split('\0').filter((record) => record.length > 0).map((record) => {
        const tab = record.indexOf('\t');
        const metadata = tab < 0 ? [] : record.slice(0, tab).split(/\s+/u);
        const ref = tab < 0 ? '' : record.slice(tab + 1);
        const mode = metadata[0];
        const type = metadata[1];
        const objectId = metadata[2];
        if ((mode !== '100644' && mode !== '100755' && mode !== '120000' && mode !== '160000') || (type !== 'blob' && type !== 'commit') || objectId === undefined || !/^[a-f0-9]{40}$/u.test(objectId) || ref.length === 0)
            throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-discovery-mismatch: recursive G tree row is malformed', [record]);
        return Object.freeze({ ref, mode, type, oid: objectId });
    });
    const byRef = new Map(entries.map((entry) => [entry.ref, entry]));
    return Object.freeze({
        entries: Object.freeze(entries),
        readBlob(ref) {
            const entry = byRef.get(ref);
            if (entry === undefined || entry.type !== 'blob')
                throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-discovery-mismatch: G authority ref is not one listed blob', [ref]);
            return runGitQuery({ cwd: repoRoot, descriptor: { kind: 'show-file', revision: commit, path: ref } }).stdout;
        },
    });
}
function manifestEntry(row) {
    const pathBytes = decodeUnpaddedBase64Url(row.path_b64.replace(/\+/gu, '-').replace(/\//gu, '_'));
    if (pathBytes === null)
        throw new CoordinationRuntimeError('invalid-state', 'authority manifest path_b64 is not canonical base64', [row.path_b64]);
    if (!row.post_exists)
        return { mode: '0', oid: null, pathBytes };
    if (row.post_oid === null)
        throw new CoordinationRuntimeError('invalid-state', 'authority manifest postimage is missing its object id', [row.path_b64]);
    if (row.post_mode !== '100644' && row.post_mode !== '100755' && row.post_mode !== '120000' && row.post_mode !== '160000')
        throw new CoordinationRuntimeError('invalid-state', 'authority manifest postimage has an unsupported leaf mode', [row.path_b64, row.post_mode ?? '<null>']);
    return { mode: row.post_mode, oid: row.post_oid, pathBytes };
}
/** Production graph Git adapter. Every Git subprocess goes through git-process.ts. */
export function createD65GraphGitOps(input) {
    const { repoRoot, isolatedIndexPath } = input;
    const casRef = async (update) => {
        const result = await runGitMutation({ cwd: repoRoot, descriptor: { kind: 'update-ref-create', ref: update.ref, target: update.target, expectedOld: update.expectedOld } });
        if (result.kind === 'reported' && result.exitCode === 0)
            return;
        const current = resolveRevision(repoRoot, update.ref);
        if (current === update.target)
            return;
        if (result.kind === 'reported')
            throw new CoordinationRuntimeError('invalid-state', 'graph ref CAS was rejected and its exact postcondition is absent', [update.ref, update.target, current ?? '<absent>', result.diagnostic]);
        throw new CoordinationRuntimeError('git-partial-effect', 'graph ref CAS effect is unknown and its exact postcondition is absent', [update.ref, update.target, current ?? '<absent>', result.reason, result.diagnostic]);
    };
    return Object.freeze({
        hashObject(bytes) {
            return oid(runGitPlumbing({ cwd: repoRoot, indexFile: isolatedIndexPath, descriptor: { kind: 'hash-object-write', bytes } }), 'graph hash-object');
        },
        commitAuthorityManifest(commit) {
            runGitPlumbing({ cwd: repoRoot, indexFile: isolatedIndexPath, descriptor: { kind: 'read-tree', tree: commit.baseTree } });
            if (commit.manifest.length > 0)
                runGitPlumbing({ cwd: repoRoot, indexFile: isolatedIndexPath, descriptor: { kind: 'update-index-manifest', entries: commit.manifest.map(manifestEntry) } });
            const tree = oid(runGitPlumbing({ cwd: repoRoot, indexFile: isolatedIndexPath, descriptor: { kind: 'write-tree' } }), 'authority G write-tree');
            const committed = oid(runGitPlumbing({ cwd: repoRoot, indexFile: isolatedIndexPath, descriptor: { kind: 'commit-tree', tree, parents: [commit.parent], message: commit.message, identity: GRAPH_COMMIT_IDENTITY } }), 'authority G commit-tree');
            return Object.freeze({ commit: committed, tree });
        },
        async readTreeEntries(commit) {
            const entries = [];
            await runGitStreamingLsTree({ cwd: repoRoot, commit, onRecord: (record) => {
                    if (record.object_type === 'tree' || record.mode === '040000')
                        throw new CoordinationRuntimeError('invalid-state', 'recursive graph authority scan unexpectedly returned a tree row');
                    entries.push(Object.freeze({
                        path_b64: encodeUnpaddedBase64Url(record.path_bytes).replace(/-/gu, '+').replace(/_/gu, '/'),
                        mode: record.mode, type: record.object_type, oid: record.oid,
                    }));
                } });
            return Object.freeze(entries);
        },
        async synchronizeAuthorityWorktree(commit) {
            const mutation = await runGitMutation({ cwd: repoRoot, descriptor: { kind: 'reset-mixed', target: commit } });
            const status = runGitQuery({ cwd: repoRoot, descriptor: { kind: 'status-porcelain', includeIgnored: false } });
            if (status.stdout.byteLength === 0 && resolveRevision(repoRoot, 'HEAD') === commit)
                return;
            if (mutation.kind === 'effect-unknown')
                throw new CoordinationRuntimeError('git-partial-effect', 'authority G index synchronization effect is unknown and the exact clean postcondition is absent', [mutation.reason, mutation.diagnostic]);
            throw new CoordinationRuntimeError('invalid-state', 'authority G does not match the complete owned run worktree postimage after index synchronization', [mutation.diagnostic]);
        },
        async finalizePublicationHead(finalize) {
            const current = resolveRevision(repoRoot, finalize.authorityRef);
            if (current === finalize.publicationCommit) {
                const status = runGitQuery({ cwd: repoRoot, descriptor: { kind: 'status-porcelain', includeIgnored: false } });
                if (status.stdout.byteLength !== 0 || resolveRevision(repoRoot, 'HEAD') !== finalize.publicationCommit)
                    throw new CoordinationRuntimeError('invalid-state', 'registered publication H is current but the owned worktree is not its exact clean postimage');
                return;
            }
            if (current !== finalize.authorityCommit || resolveRevision(repoRoot, 'HEAD') !== finalize.authorityCommit)
                throw new CoordinationRuntimeError('invalid-state', 'publication H finalization did not start from exact authority G HEAD', [current ?? '<absent>', finalize.authorityCommit]);
            let checkout = await runGitMutation({ cwd: repoRoot, descriptor: { kind: 'checkout-paths-from-tree', treeish: finalize.publicationCommit, paths: finalize.graphPaths } });
            if (checkout.kind === 'effect-unknown')
                checkout = await runGitMutation({ cwd: repoRoot, descriptor: { kind: 'checkout-paths-from-tree', treeish: finalize.publicationCommit, paths: finalize.graphPaths } });
            if (checkout.kind !== 'reported' || checkout.exitCode !== 0)
                throw new CoordinationRuntimeError('git-partial-effect', 'graph path materialization did not produce a reported successful effect', [checkout.kind === 'reported' ? checkout.diagnostic : checkout.reason]);
            await casRef({ ref: finalize.authorityRef, target: finalize.publicationCommit, expectedOld: finalize.authorityCommit });
            const status = runGitQuery({ cwd: repoRoot, descriptor: { kind: 'status-porcelain', includeIgnored: false } });
            if (status.stdout.byteLength !== 0 || resolveRevision(repoRoot, 'HEAD') !== finalize.publicationCommit)
                throw new CoordinationRuntimeError('git-partial-effect', 'publication H was accepted but its exact clean run-main postcondition is absent');
        },
        commitTreeWithBlobs(commit) {
            runGitPlumbing({ cwd: repoRoot, indexFile: isolatedIndexPath, descriptor: { kind: 'read-tree', tree: commit.baseTree } });
            runGitPlumbing({ cwd: repoRoot, indexFile: isolatedIndexPath, descriptor: { kind: 'update-index-cacheinfo', entries: commit.entries } });
            const tree = oid(runGitPlumbing({ cwd: repoRoot, indexFile: isolatedIndexPath, descriptor: { kind: 'write-tree' } }), 'graph write-tree');
            const committed = oid(runGitPlumbing({ cwd: repoRoot, indexFile: isolatedIndexPath, descriptor: { kind: 'commit-tree', tree, parents: [commit.parent], message: commit.message, identity: GRAPH_COMMIT_IDENTITY } }), 'graph commit-tree');
            return Object.freeze({ commit: committed, tree });
        },
        commitTree(commit) {
            return oid(runGitPlumbing({ cwd: repoRoot, indexFile: isolatedIndexPath, descriptor: { kind: 'commit-tree', tree: commit.tree, parents: [commit.parent], message: commit.message, identity: GRAPH_COMMIT_IDENTITY } }), 'graph-only commit-tree');
        },
        resolveTree(commit) {
            const tree = queryText(repoRoot, { kind: 'resolve-tree', revision: commit });
            if (!/^[0-9a-f]{40}$/u.test(tree))
                throw new CoordinationRuntimeError('invalid-state', 'Git tree did not resolve to one 40-hex object id', [commit, tree]);
            return tree;
        },
        resolveRevision(revision) {
            return resolveRevision(repoRoot, revision);
        },
        revListParents(commit) {
            return Object.freeze(queryText(repoRoot, { kind: 'rev-list-parents', revision: commit }).split(/\s+/u).filter((entry) => entry.length > 0));
        },
        diffPaths(from, to) {
            return Object.freeze(new TextDecoder('utf-8', { fatal: true }).decode(runGitQuery({ cwd: repoRoot, descriptor: { kind: 'diff-paths', from, to, noRenames: true } }).stdout).split('\0').filter((entry) => entry.length > 0));
        },
        async updateRefCas(update) {
            await casRef(update);
        },
    });
}
export async function readD65CoordinatorExport(client, session) {
    const directory = await mkdtemp(join(client.paths.exportsRoot, 'd65-graph-lookup-'));
    const path = join(directory, 'coordinator-export.json');
    try {
        const directoryStat = lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (platform() !== 'win32' && (directoryStat.mode & 0o777) !== 0o700))
            throw new CoordinationRuntimeError('permission-denied', 'graph response-loss export directory is not a private no-follow mode-0700 directory', [directory]);
        const response = await client.query('export', session.repo_id, session.workstream_run, { output_path: path });
        const responsePayload = jsonMap(response.payload, 'coordinator export response');
        if (textField(responsePayload, 'schema_version', 'coordinator export response') !== 'autopilot.coordinator_export_result.v1' || textField(responsePayload, 'output_path', 'coordinator export response') !== path)
            throw new CoordinationRuntimeError('invalid-state', 'coordinator export response does not bind the requested private output path');
        const expectedDigest = textField(responsePayload, 'sha256', 'coordinator export response');
        const bytes = readImmutableFileBytes({ path, maximumBytes: GRAPH_LOOKUP_EXPORT_MAX_BYTES, label: 'graph response-loss coordinator export', errorCode: 'invalid-state' });
        const actualDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        if (actualDigest !== expectedDigest)
            throw new CoordinationRuntimeError('invalid-state', 'coordinator export bytes do not match the committed export digest', [expectedDigest, actualDigest]);
        let parsed;
        try {
            parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        }
        catch (error) {
            throw new CoordinationRuntimeError('invalid-state', 'coordinator export is not valid UTF-8 JSON', [error instanceof Error ? error.message : String(error)]);
        }
        return jsonMap(parsed, 'coordinator export');
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
}
/** Production SR-1/SR-2 graph-registration gateway over existing coordinator actions. */
export function createD65GraphPublicationStoreGateway(input) {
    const { client, session } = input;
    return Object.freeze({
        async registerGraph(graph) {
            const status = await client.query('status', session.repo_id, session.workstream_run);
            const runs = jsonArray(status.payload['runs'], 'graph registration status.runs').map(parseCoordinationRun);
            const run = runs[0];
            if (runs.length !== 1 || run === undefined || run.repo_id !== session.repo_id || run.workstream_run !== session.workstream_run)
                throw new CoordinationRuntimeError('invalid-state', 'graph registration lacks one exact coordinator run');
            const response = await client.mutate('register-authoritative-artifact', {
                repoId: session.repo_id, workstreamRun: session.workstream_run, sessionId: session.session_id,
                fencingGeneration: session.session_generation, expectedVersion: run.version,
                idempotencyKey: d65GraphRegistrationIdempotencyKey(graph.artifactId, graph.graphSha256),
            }, {
                artifact_id: graph.artifactId, source_type: 'task', source_scope: 'run-main', document_schema_version: 'autopilot.semantic_graph.v1',
                git_commit: graph.publicationCommit, ref: graph.graphRef, sha256: graph.graphSha256,
                session_lease_id: session.session_lease_id, session_token: session.session_token,
            });
            const artifact = parseCoordinationAuthoritativeArtifact(response.payload['authoritative_artifact']);
            const expectedR = graph.coveredEventSeq + 1;
            if (response.committed_event_seq !== expectedR || artifact.artifact_id !== graph.artifactId || artifact.repo_id !== session.repo_id || artifact.source_run !== session.workstream_run || artifact.source_type !== 'task' || artifact.source_scope !== 'run-main' || artifact.document_schema_version !== 'autopilot.semantic_graph.v1' || artifact.git_commit !== graph.publicationCommit || artifact.evidence.ref !== graph.graphRef || artifact.evidence.sha256 !== graph.graphSha256 || artifact.registered_event_seq !== expectedR || artifact.version !== 1)
                throw new CoordinationRuntimeError('invalid-state', 'graph registration response does not equal its sealed G/H/E tuple');
            return Object.freeze({ registrationEventSeq: expectedR });
        },
        async lookupCommittedRegistration(graph) {
            const exported = await readD65CoordinatorExport(client, session);
            const artifactRows = jsonArray(exported['authoritative_artifacts'], 'export.authoritative_artifacts').map((row) => jsonMap(row, 'export authoritative artifact row')).filter((row) => textField(row, 'repo_id', 'export authoritative artifact row') === session.repo_id && textField(row, 'entity_id', 'export authoritative artifact row') === graph.artifactId);
            const eventRows = jsonArray(exported['events'], 'export.events').map((row) => jsonMap(row, 'export event row')).filter((row) => textField(row, 'repo_id', 'export event row') === session.repo_id && textField(row, 'event_type', 'export event row') === 'authoritative-artifact-registered' && textField(row, 'entity_id', 'export event row') === graph.artifactId);
            const key = d65GraphRegistrationIdempotencyKey(graph.artifactId, graph.graphSha256);
            const resultRows = jsonArray(exported['idempotency_results'], 'export.idempotency_results').map((row) => jsonMap(row, 'export idempotency row')).filter((row) => textField(row, 'repo_id', 'export idempotency row') === session.repo_id && textField(row, 'idempotency_key', 'export idempotency row') === key);
            if (artifactRows.length === 0 && eventRows.length === 0 && resultRows.length === 0)
                return null;
            const artifactRow = artifactRows[0];
            const eventRow = eventRows[0];
            const resultRow = resultRows[0];
            if (artifactRows.length !== 1 || eventRows.length !== 1 || resultRows.length !== 1 || artifactRow === undefined || eventRow === undefined || resultRow === undefined)
                throw new CoordinationRuntimeError('invalid-state', 'graph response-loss lookup found partial or duplicate registration authority');
            let artifactValue;
            let resultValue;
            try {
                artifactValue = JSON.parse(textField(artifactRow, 'payload_json', 'export authoritative artifact row'));
                resultValue = JSON.parse(textField(resultRow, 'payload_json', 'export idempotency row'));
            }
            catch (error) {
                throw new CoordinationRuntimeError('invalid-state', 'graph response-loss export contains invalid JSON authority', [error instanceof Error ? error.message : String(error)]);
            }
            const artifact = parseCoordinationAuthoritativeArtifact(artifactValue);
            const resultPayload = jsonMap(resultValue, 'export graph idempotency payload');
            const resultArtifact = parseCoordinationAuthoritativeArtifact(resultPayload['authoritative_artifact']);
            const expectedR = graph.coveredEventSeq + 1;
            const eventSeq = integerField(eventRow, 'event_seq', 'export graph event');
            const resultSeq = integerField(resultRow, 'committed_event_seq', 'export graph result');
            const exactResultKeys = Object.keys(resultPayload).sort().join(',') === 'authoritative_artifact,entity_id,entity_type,event_type';
            if (artifact.artifact_id !== graph.artifactId || artifact.repo_id !== session.repo_id || artifact.source_run !== session.workstream_run || artifact.source_type !== 'task' || artifact.source_scope !== 'run-main' || artifact.document_schema_version !== 'autopilot.semantic_graph.v1' || artifact.git_commit !== graph.publicationCommit || artifact.evidence.ref !== graph.graphRef || artifact.evidence.sha256 !== graph.graphSha256 || artifact.registered_event_seq !== expectedR || artifact.version !== 1 || canonicalJson(resultArtifact) !== canonicalJson(artifact) || !exactResultKeys || resultPayload['event_type'] !== 'authoritative-artifact-registered' || resultPayload['entity_type'] !== 'authoritative-artifact' || resultPayload['entity_id'] !== graph.artifactId || eventSeq !== expectedR || resultSeq !== expectedR || textField(eventRow, 'event_type', 'export graph event') !== 'authoritative-artifact-registered' || textField(eventRow, 'entity_type', 'export graph event') !== 'authoritative-artifact' || textField(eventRow, 'entity_id', 'export graph event') !== graph.artifactId || textField(eventRow, 'idempotency_key', 'export graph event') !== key || textField(resultRow, 'request_sha256', 'export graph result') !== textField(eventRow, 'request_sha256', 'export graph event'))
                throw new CoordinationRuntimeError('invalid-state', 'graph response-loss lookup tuple differs from the sealed registration authority');
            return Object.freeze({ registrationEventSeq: expectedR });
        },
    });
}
