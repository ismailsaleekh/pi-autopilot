#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sign, createPrivateKey } from 'node:crypto';
import { canonicalJson } from "../core/coordination/canonical-json.js";
import { CoordinatorClient } from "../core/coordination/client.js";
import { parseCoordinationAuthoritativeArtifact, parseCoordinationRun, parseCoordinationRunResource, parseCoordinationSessionLease } from "../core/coordination/contracts.js";
import { CoordinationRuntimeError } from "../core/coordination/failures.js";
import { parseD65HeartbeatAcceptanceResult, parseD65LaunchPolicy, parseD65ProgramHeartbeat } from "../core/coordination/d65-launch-policy.js";
import { encodeUnpaddedBase64Url } from "../core/coordination/d65-trust.js";
import { runGitQuery } from "../core/git-process.js";
import { ensurePrivateDirectory, publishCreateOnlyAtomic } from "../core/roster/transaction.js";
import { AUTOPILOT_STATE_ROOT_ENV } from "../core/parallel-runtime.js";
const CONFIG_FIELDS = [
    'schema_version', 'program_id', 'repo_id', 'workstream', 'workstream_run', 'private_key_path',
    'state_root', 'session_root',
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
function readOneLinkRegular(path, label, requiredMode) {
    if (!isAbsolute(path))
        fail(`${label} path must be absolute`, [path]);
    const before = lstatSync(path);
    const modeInvalid = requiredMode !== null && (before.mode & 0o777) !== requiredMode;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || modeInvalid || before.size > 1_048_576)
        fail(`${label} must be a one-link no-follow regular${requiredMode === null ? '' : ` mode-${requiredMode.toString(8)}`} file <=1 MiB`, [path]);
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
function readMode0600(path, label) {
    return readOneLinkRegular(path, label, 0o600);
}
function parseJsonBytes(bytes, label) {
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch (error) {
        fail(`${label} is not valid UTF-8 JSON`, [error instanceof Error ? error.message : String(error)]);
    }
}
function authorityPath(root, ref, label) {
    const canonicalRoot = realpathSync(root);
    if (canonicalRoot !== root)
        fail(`${label} root must be a canonical real path`, [root, canonicalRoot]);
    const target = resolve(canonicalRoot, ref);
    const rel = relative(canonicalRoot, target);
    if (rel.length === 0 || rel === '..' || rel.startsWith('../') || isAbsolute(rel))
        fail(`${label} ref escapes its authority root`, [root, ref]);
    return target;
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
        state_root: requireString(record, 'state_root', 'config'),
        session_root: requireString(record, 'session_root', 'config'),
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
        if (keys.length !== 4 || keys[0] !== 'repo_id' || keys[1] !== 'state_root' || keys[2] !== 'workstream' || keys[3] !== 'workstream_run')
            fail(`config.program_rows[${String(index)}] must have exactly workstream, workstream_run, state_root, and repo_id`);
        const stateRootRaw = record['state_root'];
        const stateRoot = stateRootRaw === null ? null : requireString(record, 'state_root', `config.program_rows[${String(index)}]`);
        if (stateRoot !== null && !isAbsolute(stateRoot))
            fail(`config.program_rows[${String(index)}].state_root must be an absolute path or null`);
        const repoIdRaw = record['repo_id'];
        const repoId = repoIdRaw === null ? null : requireString(record, 'repo_id', `config.program_rows[${String(index)}]`);
        if ((stateRoot === null) !== (repoId === null))
            fail(`config.program_rows[${String(index)}] state_root and repo_id must be both null or both present`);
        return Object.freeze({ workstream: requireString(record, 'workstream', 'config.program_rows'), workstream_run: requireString(record, 'workstream_run', 'config.program_rows'), state_root: stateRoot, repo_id: repoId });
    });
    const sorted = [...rows].sort((left, right) => (left.workstream < right.workstream ? -1 : left.workstream > right.workstream ? 1 : 0));
    for (let index = 1; index < sorted.length; index += 1)
        if ((sorted[index - 1]?.workstream ?? '') === (sorted[index]?.workstream ?? ''))
            fail('config.program_rows workstream identities must be unique');
    return Object.freeze(sorted);
}
const POLICY_REQUEST_FIELDS = ['kind', 'state_root', 'repo_id', 'workstream_run', 'policy_id', 'policy_ref', 'expected_policy_sha256'];
const HEARTBEAT_REQUEST_FIELDS = ['kind', 'state_root', 'repo_id', 'workstream_run', 'graph_sequence', 'graph_sha256', 'heartbeat_sequence'];
/** Enforce an exact closed field set (no unknown/missing request fields). */
function requireExactFields(record, fields, label) {
    const actual = Object.keys(record).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || expected.some((field, index) => actual[index] !== field))
        fail(`${label} has unexpected/missing fields`, actual);
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
        requireExactFields(record, POLICY_REQUEST_FIELDS, 'launch-policy request');
        return Object.freeze({
            kind: 'launch-policy', state_root: requireString(record, 'state_root', 'request'), repo_id: requireString(record, 'repo_id', 'request'),
            workstream_run: requireString(record, 'workstream_run', 'request'), policy_id: requireString(record, 'policy_id', 'request'),
            policy_ref: requireString(record, 'policy_ref', 'request'), expected_policy_sha256: requireSha256(record, 'expected_policy_sha256', 'request'),
        });
    }
    if (record['kind'] === 'program-heartbeat') {
        requireExactFields(record, HEARTBEAT_REQUEST_FIELDS, 'program-heartbeat request');
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
    return [resource.source_repo, resource.git_common_dir, resource.worktree_root, resource.main_worktree_path, resource.runtime_root, config.program_evidence_root, config.state_root, config.session_root];
}
/**
 * Prove the operator private key's canonical realpath is OUTSIDE every protected
 * root. Exported for direct regression coverage of the external-key boundary
 * (audit item F): a key inside any clone/state/session/worktree/runtime/evidence
 * root rejects loudly.
 */
export function assertPrivateKeyOutsideProtectedRoots(privateKeyPath, protectedRoots) {
    const keyReal = realpathSync(privateKeyPath);
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
}
function readOperatorPrivateKey(config, protectedRoots) {
    assertPrivateKeyOutsideProtectedRoots(config.private_key_path, protectedRoots);
    return new TextDecoder('utf-8').decode(readMode0600(config.private_key_path, 'operator private key'));
}
function requireOne(values, label) {
    if (values.length !== 1 || values[0] === undefined)
        fail(`${label} cardinality is not exactly one`, [`count=${String(values.length)}`]);
    return values[0];
}
/**
 * Publish a signed candidate through a canonical-root-contained, no-alias,
 * temp+fsync+link/rename create-only atomic protocol (audit item F). If the
 * exact bytes already exist, only byte-identical content is accepted; a
 * conflicting/partial-residue/symlinked/hardlinked/wrong-mode candidate rejects
 * loudly. Reuses the proven Phase 37 atomic publication primitive rather than a
 * weaker copy.
 */
async function persistSignedCandidate(absolutePath, bytes, authorityRoot) {
    await ensurePrivateDirectory(dirname(absolutePath), authorityRoot);
    const result = await publishCreateOnlyAtomic({ path: absolutePath, authorityRoot, bytes });
    if (result.status === 'conflict')
        fail('signed candidate publication found conflicting existing bytes at the sealed sequence path', [absolutePath]);
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
    await persistSignedCandidate(absolutePath, bytes, realpathSync(config.program_evidence_root));
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
        rows: await heartbeatRows(config, request, attached, policyArtifact, status, doctor, dispatchRow, env),
        provider_health: [{ provider: config.roster_provider, state: 'healthy', observation_ref: policyArtifact.evidence.ref, observation_sha256: policyArtifact.evidence.sha256, cooldown_until: null, probe_workstream_run: null, probe_ref: null, probe_sha256: null, consumption_event_seq: null }],
        dispatch_allowed: true, stop_reasons: [], trust_anchor_ref: config.trust_anchor_ref, trust_anchor_sha256: config.trust_anchor_sha256, signer_key_id: config.signer_key_id,
    };
    const privateKeyPem = readOperatorPrivateKey(config, protectedRootsFromResource(config, resource));
    const signature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, concatDomain('AUTOPILOT-D65-PROGRAM-HEARTBEAT\u0000', canonicalJson(fields)), createPrivateKey(privateKeyPem))));
    const bytes = new TextEncoder().encode(`${canonicalJson({ ...fields, signature })}\n`);
    const ref = `program-heartbeats/${String(request.heartbeat_sequence).padStart(20, '0')}.json`;
    const absolutePath = join(config.program_evidence_root, ref);
    await persistSignedCandidate(absolutePath, bytes, realpathSync(config.program_evidence_root));
    return { ref, absolutePath, bytes };
}
async function heartbeatRows(config, request, attached, policyArtifact, status, doctor, dispatchRow, env) {
    const thisRowStopReasons = dispatchRow ? [] : ['graph-publication-pending'];
    // Emit one identity-sorted row per declared program row (§3.2). THIS run's row
    // is bound to live coordinator authority. Every OTHER declared row is read from
    // its own live coordinator authority when launched (never regressed to
    // planned), or emitted as planned/unlaunched when its coordinator has no run.
    const rows = [];
    for (const row of config.program_rows) {
        if (row.workstream === config.workstream) {
            rows.push({
                workstream: row.workstream, workstream_run: row.workstream_run, parent_session_file_sha256: null,
                coordinator_session_lease_id: attached.session_lease_id, accepted_graph_sequence: request.graph_sequence, accepted_graph_sha256: request.graph_sha256,
                status_sha256: status.payload['semantic_snapshot_sha256'], doctor_sha256: doctor.payload['semantic_snapshot_sha256'], session_lease_state: 'attached',
                child_lease_ids: [], launch_policy_sha256: policyArtifact.evidence.sha256, last_progress_event_seq: attached.attached_event_seq,
                last_handoff_sha256: null, row_state: 'active', dispatch_allowed: thisRowStopReasons.length === 0, stop_reasons: thisRowStopReasons,
            });
            continue;
        }
        rows.push(await foreignRowFromLiveAuthority(row, env));
    }
    return rows;
}
/**
 * Bind a foreign row's graph sequence and digest to one accepted signed
 * heartbeat row. If the coordinator has registered a newer graph artifact, the
 * accepted tuple remains intact but dispatch is fenced with graph-drift; sequence
 * from one authority is never paired with a digest guessed from another.
 */
export function foreignAcceptedGraphAuthority(row, highestGraphSha256) {
    if (row.accepted_graph_sequence === null || row.accepted_graph_sha256 === null)
        fail('foreign accepted heartbeat row lacks a complete graph tuple', [row.workstream_run]);
    const stopReasons = new Set(row.stop_reasons);
    if (row.accepted_graph_sha256 !== highestGraphSha256)
        stopReasons.add('graph-drift');
    const ordered = [...stopReasons].sort();
    return Object.freeze({ acceptedGraphSequence: row.accepted_graph_sequence, acceptedGraphSha256: row.accepted_graph_sha256, dispatchAllowed: row.dispatch_allowed && ordered.length === 0, stopReasons: Object.freeze(ordered) });
}
/**
 * Read an already-launched foreign program row's own live status/doctor/session/
 * policy/graph authority from ITS isolated coordinator, or emit a planned/
 * unlaunched row when its coordinator has no launched run. A launched foreign
 * row is never regressed to planned merely because a different row is signing.
 */
async function foreignRowFromLiveAuthority(row, env) {
    const plannedRow = {
        workstream: row.workstream, workstream_run: row.workstream_run, parent_session_file_sha256: null,
        coordinator_session_lease_id: null, accepted_graph_sequence: null, accepted_graph_sha256: null,
        status_sha256: null, doctor_sha256: null, session_lease_state: null,
        child_lease_ids: [], launch_policy_sha256: null, last_progress_event_seq: null,
        last_handoff_sha256: null, row_state: 'planned', dispatch_allowed: false, stop_reasons: ['row-not-launched'],
    };
    if (row.state_root === null || row.repo_id === null)
        return plannedRow;
    const client = new CoordinatorClient({ env: { ...env, [AUTOPILOT_STATE_ROOT_ENV]: row.state_root } });
    // Query the foreign coordinator's own live authority. A THROWN error (socket
    // down, contention, timeout, protocol/schema drift) is NOT "not launched": it
    // is a signing-time authority failure and MUST fail closed. Silently emitting
    // a `planned` row here would let a transient error regress a genuinely launched
    // foreign row to planned in the operator-signed governing heartbeat — the exact
    // fail-open the contract forbids. Producing no heartbeat is strictly safer than
    // producing one that misstates live program launch state.
    const status = await client.query('status', row.repo_id, row.workstream_run);
    const runs = status.payload['runs'];
    if (!Array.isArray(runs))
        fail('foreign program row status is missing the runs projection', [row.workstream_run]);
    // Zero runs = the coordinator is reachable and genuinely has no run for this
    // identity (an unlaunched peer). This is distinguished from a query failure
    // (which threw above) purely by a SUCCESSFUL query returning an empty set.
    if (runs.length === 0)
        return plannedRow;
    if (runs.length !== 1)
        fail('foreign program row coordinator returned more than one run for the sealed identity', [row.workstream_run, String(runs.length)]);
    const artifacts = status.payload['authoritative_artifacts'];
    if (!Array.isArray(artifacts))
        fail('foreign program row status is missing the authoritative-artifacts projection', [row.workstream_run]);
    const parsedArtifacts = artifacts.map(parseCoordinationAuthoritativeArtifact);
    const foreignPolicy = parsedArtifacts.find((a) => a.document_schema_version === 'autopilot.launch_policy.v1');
    const foreignGraphs = parsedArtifacts.filter((a) => a.document_schema_version === 'autopilot.semantic_graph.v1');
    // A run with neither an accepted policy nor a complete graph is still in its
    // bootstrap window: a peer that has attached but not yet reached ordinary
    // dispatch. It is emitted as planned/unlaunched from THIS authority's steady-
    // state perspective (it carries no dispatch-relevant graph tuple yet).
    if (foreignPolicy === undefined || foreignGraphs.length === 0)
        return plannedRow;
    const run = parseCoordinationRun(runs[0]);
    const resourcesValue = status.payload['run_resources'];
    if (!Array.isArray(resourcesValue))
        fail('foreign program row status is missing the run-resources projection', [row.workstream_run]);
    const matchingResources = resourcesValue.map(parseCoordinationRunResource).filter((resource) => resource.repo_id === row.repo_id && resource.workstream_run === row.workstream_run);
    const resource = matchingResources[0];
    if (matchingResources.length !== 1 || resource === undefined)
        fail('foreign program row must have exactly one live run resource', [row.workstream_run, String(matchingResources.length)]);
    // The accepted policy is Git-tracked run-main evidence, so its checkout mode
    // follows Git/umask (normally 0644), unlike external private heartbeat bytes.
    // No-follow/one-link/descriptor identity + the coordinator-sealed digest are
    // the authority checks here; requiring mode 0600 would reject every real clone.
    const policyBytes = readOneLinkRegular(authorityPath(resource.main_worktree_path, foreignPolicy.evidence.ref, 'foreign launch policy'), 'foreign launch policy', null);
    if (bytesSha256(policyBytes) !== foreignPolicy.evidence.sha256)
        fail('foreign launch policy bytes do not match coordinator artifact authority', [row.workstream_run]);
    const policy = parseD65LaunchPolicy(parseJsonBytes(policyBytes, 'foreign launch policy'));
    if (policy.repo_id !== row.repo_id || policy.workstream_run !== row.workstream_run)
        fail('foreign launch policy identity does not match its configured row', [row.workstream_run]);
    const sessionsValue = status.payload['session_leases'];
    if (!Array.isArray(sessionsValue))
        fail('foreign program row status is missing the session-leases projection', [row.workstream_run]);
    const sessions = sessionsValue.map(parseCoordinationSessionLease);
    const attached = sessions.find((session) => (session.status === 'attached' || session.status === 'handoff-pending') && session.attachment_kind === 'dispatch' && session.session_generation === run.active_session_generation);
    const doctor = await client.query('doctor', row.repo_id, row.workstream_run);
    const headValue = status.payload['accepted_program_heartbeat'];
    if (headValue === null)
        fail('foreign program row has a complete graph but no accepted governing heartbeat head; refusing to fabricate its graph tuple', [row.workstream_run]);
    const head = parseD65HeartbeatAcceptanceResult(headValue);
    if (head.repo_id !== row.repo_id || head.workstream_run !== row.workstream_run || head.program_id !== policy.program_id)
        fail('foreign accepted heartbeat head identity does not match its configured row/policy', [row.workstream_run]);
    const heartbeatBytes = readMode0600(authorityPath(policy.program_evidence_root, head.heartbeat_ref, 'foreign accepted heartbeat'), 'foreign accepted heartbeat');
    if (bytesSha256(heartbeatBytes) !== head.heartbeat_sha256)
        fail('foreign accepted heartbeat bytes do not match the durable coordinator head', [row.workstream_run]);
    const heartbeat = parseD65ProgramHeartbeat(parseJsonBytes(heartbeatBytes, 'foreign accepted heartbeat'));
    if (heartbeat.program_id !== head.program_id || heartbeat.sequence !== head.sequence || heartbeat.prior_sha256 !== head.prior_sha256 || heartbeat.issued_at !== head.issued_at || heartbeat.valid_until !== head.valid_until)
        fail('foreign accepted heartbeat bytes do not bind the durable coordinator head', [row.workstream_run]);
    const acceptedRows = heartbeat.rows.filter((candidate) => candidate.workstream === row.workstream && candidate.workstream_run === row.workstream_run);
    const acceptedRow = acceptedRows[0];
    if (acceptedRows.length !== 1 || acceptedRow === undefined)
        fail('foreign accepted heartbeat does not contain exactly one configured row', [row.workstream_run]);
    const firstGraph = foreignGraphs[0];
    if (firstGraph === undefined)
        fail('foreign program row graph projection became empty after validation', [row.workstream_run]);
    const highestGraph = foreignGraphs.reduce((max, graph) => (graph.registered_event_seq > max.registered_event_seq ? graph : max), firstGraph);
    const graph = foreignAcceptedGraphAuthority(acceptedRow, highestGraph.evidence.sha256);
    const stopReasons = new Set(graph.stopReasons);
    if (acceptedRow.launch_policy_sha256 !== foreignPolicy.evidence.sha256)
        stopReasons.add('policy-invalid');
    if (attached === undefined || acceptedRow.coordinator_session_lease_id !== attached.session_lease_id)
        stopReasons.add('lease-invalid');
    const coordinatorTime = status.payload['coordinator_time'];
    const coordinatorMs = typeof coordinatorTime === 'string' ? Date.parse(coordinatorTime) : Number.NaN;
    const issuedMs = Date.parse(head.issued_at);
    const validUntilMs = Date.parse(head.valid_until);
    if (!Number.isFinite(coordinatorMs) || !Number.isFinite(issuedMs) || !Number.isFinite(validUntilMs) || head.acceptance_kind !== 'governing' || issuedMs > coordinatorMs || coordinatorMs >= validUntilMs)
        stopReasons.add('heartbeat-stale');
    const orderedStopReasons = [...stopReasons].sort();
    return {
        workstream: row.workstream, workstream_run: row.workstream_run, parent_session_file_sha256: acceptedRow.parent_session_file_sha256,
        coordinator_session_lease_id: acceptedRow.coordinator_session_lease_id, accepted_graph_sequence: graph.acceptedGraphSequence, accepted_graph_sha256: graph.acceptedGraphSha256,
        status_sha256: status.payload['semantic_snapshot_sha256'] ?? null, doctor_sha256: doctor.payload['semantic_snapshot_sha256'] ?? null, session_lease_state: acceptedRow.session_lease_state,
        child_lease_ids: acceptedRow.child_lease_ids, launch_policy_sha256: acceptedRow.launch_policy_sha256, last_progress_event_seq: acceptedRow.last_progress_event_seq,
        last_handoff_sha256: acceptedRow.last_handoff_sha256, row_state: acceptedRow.row_state, dispatch_allowed: graph.dispatchAllowed && orderedStopReasons.length === 0, stop_reasons: orderedStopReasons,
    };
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
// Run `main()` only when this module is the invoked entrypoint: either it is
// argv[1] itself (`node .../autopilot-launch-signer.{js,ts}`) or it is loaded by
// the packaged bin wrapper (`node .../bin/autopilot-launch-signer.mjs`, which
// dynamic-imports the compiled entrypoint). Keying off `import.meta.url` alone
// is wrong: the module URL always ends with the entrypoint suffix, so a plain
// suffix check fires on every ordinary import (including tests) and poisons the
// importer's exit code. Detection must therefore be driven by `process.argv[1]`.
const invokedPath = process.argv[1];
const isDirectRun = invokedPath !== undefined && (pathToFileURL(resolve(invokedPath)).href === import.meta.url ||
    /[\\/]bin[\\/]autopilot-launch-signer\.mjs$/u.test(invokedPath));
if (isDirectRun)
    void main();
