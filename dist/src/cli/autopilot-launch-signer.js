#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { sign, createPrivateKey } from 'node:crypto';
import { canonicalJson } from "../core/coordination/canonical-json.js";
import { CoordinatorClient } from "../core/coordination/client.js";
import { parseCoordinationAuthoritativeArtifact, parseCoordinationRun, parseCoordinationRunResource, parseCoordinationSessionLease } from "../core/coordination/contracts.js";
import { CoordinationRuntimeError } from "../core/coordination/failures.js";
import { parseD65LaunchPolicy } from "../core/coordination/d65-launch-policy.js";
import { encodeUnpaddedBase64Url } from "../core/coordination/d65-trust.js";
import { runGitQuery } from "../core/git-process.js";
import { AUTOPILOT_STATE_ROOT_ENV } from "../core/parallel-runtime.js";
const CONFIG_FIELDS = [
    'schema_version', 'program_id', 'repo_id', 'workstream', 'workstream_run', 'private_key_path',
    'trust_anchor_ref', 'trust_anchor_sha256', 'signer_key_id', 'program_evidence_root', 'policy_id',
    'policy_ref', 'package_commit', 'package_tree', 'b0_commit', 'b0_tree', 'roster_sha256', 'roster_provider',
    'policy_issued_at', 'program_rows',
];
function fail(message, detail = []) {
    throw new CoordinationRuntimeError('invalid-request', `launch-signer: ${message}`, [...detail]);
}
function bytesSha256(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function readMode0600(path, label) {
    if (!isAbsolute(path))
        fail(`${label} path must be absolute`, [path]);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > 1_048_576)
        fail(`${label} must be a one-link no-follow regular mode-0600 file <=1 MiB`, [path]);
    const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const opened = fstatSync(descriptor);
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
            fail(`${label} descriptor identity changed while opening`, [path]);
        return readFileSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
}
function requireObject(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        fail(`${label} must be an object`);
    return value;
}
function requireString(record, field, label) {
    const value = record[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096)
        fail(`${label}.${field} must be a bounded string`);
    return value;
}
function requireSha256(record, field, label) {
    const value = requireString(record, field, label);
    if (!/^sha256:[a-f0-9]{64}$/u.test(value))
        fail(`${label}.${field} must be sha256:<64 lowercase hex>`);
    return value;
}
function requireInteger(record, field, label) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
        fail(`${label}.${field} must be a positive safe integer`);
    return value;
}
function parseConfig(bytes) {
    let value;
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch (error) {
        fail('config is not UTF-8 JSON', [error instanceof Error ? error.message : String(error)]);
    }
    const record = requireObject(value, 'config');
    const keys = Object.keys(record).sort();
    const expected = [...CONFIG_FIELDS].sort();
    if (keys.length !== expected.length || expected.some((field, index) => keys[index] !== field))
        fail('config has unexpected/missing fields', keys);
    if (record['schema_version'] !== 'autopilot.launch_signer_config.v1')
        fail('config schema is wrong');
    return Object.freeze({
        schema_version: 'autopilot.launch_signer_config.v1',
        program_id: requireString(record, 'program_id', 'config'),
        repo_id: requireString(record, 'repo_id', 'config'),
        workstream: requireString(record, 'workstream', 'config'),
        workstream_run: requireString(record, 'workstream_run', 'config'),
        private_key_path: requireString(record, 'private_key_path', 'config'),
        trust_anchor_ref: requireString(record, 'trust_anchor_ref', 'config'),
        trust_anchor_sha256: requireSha256(record, 'trust_anchor_sha256', 'config'),
        signer_key_id: requireSha256(record, 'signer_key_id', 'config'),
        program_evidence_root: requireString(record, 'program_evidence_root', 'config'),
        policy_id: requireString(record, 'policy_id', 'config'),
        policy_ref: requireString(record, 'policy_ref', 'config'),
        package_commit: requireString(record, 'package_commit', 'config'),
        package_tree: requireString(record, 'package_tree', 'config'),
        b0_commit: requireString(record, 'b0_commit', 'config'),
        b0_tree: requireString(record, 'b0_tree', 'config'),
        roster_sha256: requireSha256(record, 'roster_sha256', 'config'),
        roster_provider: requireString(record, 'roster_provider', 'config'),
        policy_issued_at: requireString(record, 'policy_issued_at', 'config'),
        program_rows: parseProgramRows(record['program_rows']),
    });
}
function parseProgramRows(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 64)
        fail('config.program_rows must be a non-empty bounded array');
    const rows = value.map((entry, index) => {
        const record = requireObject(entry, `config.program_rows[${String(index)}]`);
        const keys = Object.keys(record).sort();
        if (keys.length !== 2 || keys[0] !== 'workstream' || keys[1] !== 'workstream_run')
            fail(`config.program_rows[${String(index)}] must have exactly workstream and workstream_run`);
        return Object.freeze({ workstream: requireString(record, 'workstream', 'config.program_rows'), workstream_run: requireString(record, 'workstream_run', 'config.program_rows') });
    });
    const sorted = [...rows].sort((left, right) => (left.workstream < right.workstream ? -1 : left.workstream > right.workstream ? 1 : 0));
    for (let index = 1; index < sorted.length; index += 1)
        if ((sorted[index - 1]?.workstream ?? '') === (sorted[index]?.workstream ?? ''))
            fail('config.program_rows workstream identities must be unique');
    return Object.freeze(sorted);
}
function parseRequest(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch (error) {
        fail('request is not JSON', [error instanceof Error ? error.message : String(error)]);
    }
    const record = requireObject(value, 'request');
    if (record['kind'] === 'launch-policy') {
        return Object.freeze({
            kind: 'launch-policy', state_root: requireString(record, 'state_root', 'request'), repo_id: requireString(record, 'repo_id', 'request'),
            workstream_run: requireString(record, 'workstream_run', 'request'), policy_id: requireString(record, 'policy_id', 'request'),
            policy_ref: requireString(record, 'policy_ref', 'request'), expected_policy_sha256: requireSha256(record, 'expected_policy_sha256', 'request'),
        });
    }
    if (record['kind'] === 'program-heartbeat') {
        return Object.freeze({
            kind: 'program-heartbeat', state_root: requireString(record, 'state_root', 'request'), repo_id: requireString(record, 'repo_id', 'request'),
            workstream_run: requireString(record, 'workstream_run', 'request'), graph_sequence: requireInteger(record, 'graph_sequence', 'request'),
            graph_sha256: requireSha256(record, 'graph_sha256', 'request'), heartbeat_sequence: requireInteger(record, 'heartbeat_sequence', 'request'),
        });
    }
    return fail('request kind must be launch-policy or program-heartbeat');
}
function gitBlob(repoRoot, commit, ref) {
    return runGitQuery({ cwd: repoRoot, descriptor: { kind: 'show-file', revision: commit, path: ref } }).stdout;
}
/**
 * Read the operator private key, proving its realpath is OUTSIDE every protected
 * root (source clone, Git common dir, state root, session root, worktree/runtime
 * roots, and the program evidence root). The external-key boundary is meaningless
 * if the key can live inside runtime-controlled or packaged authority.
 */
/** The complete set of protected roots the operator key must live outside of. */
function protectedRootsFromResource(config, resource) {
    return [resource.source_repo, resource.git_common_dir, resource.worktree_root, resource.main_worktree_path, resource.runtime_root, config.program_evidence_root];
}
function readOperatorPrivateKey(config, protectedRoots) {
    const keyReal = realpathSync(config.private_key_path);
    for (const root of protectedRoots) {
        let rootReal;
        try {
            rootReal = realpathSync(root);
        }
        catch {
            continue;
        }
        const withSep = rootReal.endsWith('/') ? rootReal : `${rootReal}/`;
        if (keyReal === rootReal || keyReal.startsWith(withSep))
            fail('operator private key must live outside every clone/state/session/worktree/runtime/evidence root', [keyReal, rootReal]);
    }
    return new TextDecoder('utf-8').decode(readMode0600(config.private_key_path, 'operator private key'));
}
function requireOne(values, label) {
    if (values.length !== 1 || values[0] === undefined)
        fail(`${label} cardinality is not exactly one`, [`count=${String(values.length)}`]);
    return values[0];
}
async function persistSignedCandidate(absolutePath, bytes) {
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    await writeFile(absolutePath, bytes, { mode: 0o600 });
    chmodSync(absolutePath, 0o600);
}
/** Build and sign the launch policy from live coordinator + config authority. */
async function signPolicy(config, request, env) {
    const client = new CoordinatorClient({ env: { ...env, [AUTOPILOT_STATE_ROOT_ENV]: request.state_root } });
    const status = await client.query('status', request.repo_id, request.workstream_run);
    const artifacts = status.payload['authoritative_artifacts'].map(parseCoordinationAuthoritativeArtifact);
    const bootstrap = requireOne(artifacts.filter((a) => a.artifact_id === `semantic-graph-bootstrap:${request.workstream_run}` && a.document_schema_version === 'autopilot.semantic_graph_bootstrap.v1'), 'bootstrap artifact');
    const resources = status.payload['run_resources'].map(parseCoordinationRunResource);
    const resource = requireOne(resources, 'run resource');
    const fields = {
        schema_version: 'autopilot.launch_policy.v1', program_id: config.program_id, policy_id: request.policy_id, policy_version: 1,
        repo_id: request.repo_id, workstream_run: request.workstream_run, package_commit: config.package_commit, package_tree: config.package_tree,
        base_commit: config.b0_commit, base_tree: config.b0_tree, bootstrap_graph_sha256: bootstrap.evidence.sha256, bootstrap_receipt_event_seq: bootstrap.registered_event_seq,
        roster_sha256: config.roster_sha256, parallel_cap: 1, maximum_parallel_cap: 1, expected_checkout_units: 1,
        program_evidence_root: config.program_evidence_root, trust_anchor_ref: config.trust_anchor_ref, trust_anchor_sha256: config.trust_anchor_sha256,
        prior_policy_sha256: null, capacity_decision_ref: null, capacity_decision_sha256: null, issued_at: config.policy_issued_at, signer_key_id: config.signer_key_id,
    };
    const privateKeyPem = readOperatorPrivateKey(config, protectedRootsFromResource(config, resource));
    const signature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, concatDomain('AUTOPILOT-D65-LAUNCH-POLICY\u0000', canonicalJson(fields)), createPrivateKey(privateKeyPem))));
    const bytes = new TextEncoder().encode(`${canonicalJson({ ...fields, signature })}\n`);
    // Parse-validate our own output before writing (fail closed).
    parseD65LaunchPolicy(JSON.parse(new TextDecoder().decode(bytes)));
    if (bytesSha256(bytes) !== request.expected_policy_sha256)
        fail('signed policy digest differs from the sealed expected policy digest', [bytesSha256(bytes), request.expected_policy_sha256]);
    const absolutePath = join(config.program_evidence_root, 'signed-launch-policies', `${request.policy_id}.json`);
    await persistSignedCandidate(absolutePath, bytes);
    return { ref: request.policy_ref, absolutePath, bytes };
}
/** Build and sign the program heartbeat from live coordinator + config authority. */
async function signHeartbeat(config, request, env) {
    const client = new CoordinatorClient({ env: { ...env, [AUTOPILOT_STATE_ROOT_ENV]: request.state_root } });
    const status = await client.query('status', request.repo_id, request.workstream_run);
    const doctor = await client.query('doctor', request.repo_id, request.workstream_run);
    const artifacts = status.payload['authoritative_artifacts'].map(parseCoordinationAuthoritativeArtifact);
    const policyArtifact = requireOne(artifacts.filter((a) => a.document_schema_version === 'autopilot.launch_policy.v1'), 'accepted launch policy artifact');
    const resources = status.payload['run_resources'].map(parseCoordinationRunResource);
    const resource = requireOne(resources, 'run resource');
    const policy = parseD65LaunchPolicy(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(gitBlob(resource.main_worktree_path, policyArtifact.git_commit, policyArtifact.evidence.ref))));
    const sessions = status.payload['session_leases'].map(parseCoordinationSessionLease);
    const run = requireOne(status.payload['runs'].map(parseCoordinationRun), 'run');
    const attached = requireOne(sessions.filter((s) => (s.status === 'attached' || s.status === 'handoff-pending') && s.attachment_kind === 'dispatch' && s.session_generation === run.active_session_generation), 'attached dispatch session');
    const head = status.payload['accepted_program_heartbeat'];
    const priorSha = head === null ? null : head['heartbeat_sha256'];
    const priorSeq = head === null ? 0 : Number(head['sequence']);
    if (request.heartbeat_sequence !== priorSeq + 1)
        fail('requested heartbeat sequence is not the exact next chain sequence', [String(request.heartbeat_sequence), String(priorSeq + 1)]);
    const issued = new Date();
    issued.setMilliseconds(Math.max(0, issued.getMilliseconds() - 50));
    const dispatchRow = request.graph_sequence >= 2;
    const fields = {
        schema_version: 'autopilot.program_heartbeat.v1', program_id: config.program_id, sequence: request.heartbeat_sequence, prior_sha256: priorSha,
        issued_at: issued.toISOString(), valid_until: new Date(issued.getTime() + 15 * 60 * 1000).toISOString(),
        package_commit: config.package_commit, package_tree: config.package_tree, base_commit: config.b0_commit, base_tree: config.b0_tree,
        rows: heartbeatRows(config, request, attached, policyArtifact, status, doctor, dispatchRow),
        provider_health: [{ provider: config.roster_provider, state: 'healthy', observation_ref: policyArtifact.evidence.ref, observation_sha256: policyArtifact.evidence.sha256, cooldown_until: null, probe_workstream_run: null, probe_ref: null, probe_sha256: null, consumption_event_seq: null }],
        dispatch_allowed: true, stop_reasons: [], trust_anchor_ref: config.trust_anchor_ref, trust_anchor_sha256: config.trust_anchor_sha256, signer_key_id: config.signer_key_id,
    };
    const privateKeyPem = readOperatorPrivateKey(config, protectedRootsFromResource(config, resource));
    const signature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, concatDomain('AUTOPILOT-D65-PROGRAM-HEARTBEAT\u0000', canonicalJson(fields)), createPrivateKey(privateKeyPem))));
    const bytes = new TextEncoder().encode(`${canonicalJson({ ...fields, signature })}\n`);
    const ref = `program-heartbeats/${String(request.heartbeat_sequence).padStart(20, '0')}.json`;
    const absolutePath = join(config.program_evidence_root, ref);
    await persistSignedCandidate(absolutePath, bytes);
    return { ref, absolutePath, bytes };
}
function heartbeatRows(config, request, attached, policyArtifact, status, doctor, dispatchRow) {
    const stopReasons = dispatchRow ? [] : ['graph-publication-pending'];
    // Emit one identity-sorted row per declared program row (§3.2): THIS run's row
    // is bound to live coordinator authority; every other declared row is emitted
    // as planned/unlaunched. The parser requires the exact per-row dispatch/reason
    // coherence, so a planned row carries `row-not-launched` and dispatch false.
    return config.program_rows.map((row) => {
        if (row.workstream === config.workstream) {
            return {
                workstream: row.workstream, workstream_run: row.workstream_run, parent_session_file_sha256: null,
                coordinator_session_lease_id: attached.session_lease_id, accepted_graph_sequence: request.graph_sequence, accepted_graph_sha256: request.graph_sha256,
                status_sha256: status.payload['semantic_snapshot_sha256'], doctor_sha256: doctor.payload['semantic_snapshot_sha256'], session_lease_state: 'attached',
                child_lease_ids: [], launch_policy_sha256: policyArtifact.evidence.sha256, last_progress_event_seq: attached.attached_event_seq,
                last_handoff_sha256: null, row_state: 'active', dispatch_allowed: stopReasons.length === 0, stop_reasons: stopReasons,
            };
        }
        // A declared-but-unlaunched program row: exactly row-local `row-not-launched`,
        // all launch/session/graph facts null.
        return {
            workstream: row.workstream, workstream_run: row.workstream_run, parent_session_file_sha256: null,
            coordinator_session_lease_id: null, accepted_graph_sequence: null, accepted_graph_sha256: null,
            status_sha256: null, doctor_sha256: null, session_lease_state: null,
            child_lease_ids: [], launch_policy_sha256: null, last_progress_event_seq: null,
            last_handoff_sha256: null, row_state: 'planned', dispatch_allowed: false, stop_reasons: ['row-not-launched'],
        };
    });
}
function concatDomain(domain, message) {
    const domainBytes = new TextEncoder().encode(domain);
    const messageBytes = new TextEncoder().encode(message);
    const out = new Uint8Array(domainBytes.length + messageBytes.length);
    out.set(domainBytes, 0);
    out.set(messageBytes, domainBytes.length);
    return out;
}
function argValue(argv, flag) {
    const index = argv.indexOf(flag);
    if (index < 0)
        return null;
    const value = argv[index + 1];
    return value === undefined ? null : value;
}
export async function runLaunchSignerCli(argv, env, emit) {
    const configPath = argValue(argv, '--config') ?? env['AUTOPILOT_LAUNCH_SIGNER_CONFIG'] ?? null;
    const requestRaw = argValue(argv, '--request');
    if (configPath === null) {
        emit(JSON.stringify({ error: 'launch-signer requires --config <absolute-path> or AUTOPILOT_LAUNCH_SIGNER_CONFIG' }));
        return 2;
    }
    if (requestRaw === null) {
        emit(JSON.stringify({ error: 'launch-signer requires --request <json>' }));
        return 2;
    }
    const config = parseConfig(readMode0600(configPath, 'launch signer config'));
    const request = parseRequest(requestRaw);
    if (request.repo_id !== config.repo_id || request.workstream_run !== config.workstream_run)
        fail('request identity does not match the signer config');
    const produced = request.kind === 'launch-policy'
        ? await signPolicy(config, request, env)
        : await signHeartbeat(config, request, env);
    emit(JSON.stringify({ schema_version: 'autopilot.launch_signer_result.v1', ref: produced.ref, absolute_path: produced.absolutePath, sha256: bytesSha256(produced.bytes), byte_count: produced.bytes.byteLength }));
    return 0;
}
async function main() {
    try {
        const code = await runLaunchSignerCli(process.argv.slice(2), process.env, (line) => process.stdout.write(`${line}\n`));
        process.exitCode = code;
    }
    catch (error) {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = 1;
    }
}
const isDirectRun = process.argv[1] !== undefined && (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith('/autopilot-launch-signer.ts') || import.meta.url.endsWith('/autopilot-launch-signer.js'));
if (isDirectRun)
    void main();
