import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CoordinatorClient } from "./client.js";
import { canonicalJson } from "./canonical-json.js";
import { parseCoordinationAuthoritativeArtifact, parseCoordinationRun, parseCoordinationRunResource, parseCoordinationSessionLease, parseCoordinationWorktree, parseCoordinationWorktreeOperation } from "./contracts.js";
import { CoordinationRuntimeError } from "./failures.js";
import { readCoordinatorSessionContext } from "./supervisor.js";
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from "../names.js";
import { runGitQuery } from "../git-process.js";
import { reconcileD65HeartbeatHighWater } from "./d65-heartbeat-high-water.js";
import { verifyD65PairedHeartbeatGate } from "./d65-heartbeat-gate.js";
import { parseD65HeartbeatAcceptanceResult, parseD65LaunchPolicy, parseD65ProgramHeartbeat } from "./d65-launch-policy.js";
import { d65SemanticGraphSequenceFromArtifactId } from "./d65-graph-publication.js";
import { readD65CoordinatorExport } from "./d65-graph-runtime.js";
import { parseD65SemanticGraphBootstrap } from "./d65-semantic-graph.js";
import { parseD65TrustAnchorSpki, verifyD65Signature } from "./d65-trust.js";
import { assertOrdinaryBoundaryAllowed, assertRecoveryBoundaryAllowed, } from "./d65-dispatch-gate.js";
/**
 * Production SR-5 adapter. Every assertion performs a new coordinator query and
 * immediately evaluates it; this object stores scope/client only and never an
 * authority frame or verdict.
 */
export class D65RuntimeDispatchAuthority {
    #client;
    #repoId;
    #workstreamRun;
    constructor(input) {
        this.#client = input.client;
        this.#repoId = input.repoId;
        this.#workstreamRun = input.workstreamRun;
    }
    async assertOrdinary(boundary, context) {
        const fresh = await this.#client.readD65DispatchAuthority(this.#repoId, this.#workstreamRun, context);
        assertOrdinaryBoundaryAllowed(boundary, fresh);
    }
    async assertRecovery(boundary, context, bindings) {
        const fresh = await this.#client.readD65DispatchAuthority(this.#repoId, this.#workstreamRun, context);
        // Caller-context currentness is never synthesized: bind session/policy/
        // publication booleans directly to this same fresh committed frame.
        const bound = { ...bindings, attached_session_current: fresh.session.attached_session_current && fresh.session.lease_current && fresh.session.expected_version_current, policy_trust_current: fresh.policy.policy_current, no_pending_publication: !fresh.graph.graph_publication_pending };
        assertRecoveryBoundaryAllowed(boundary, fresh, bound);
    }
}
function array(value, label) {
    if (!Array.isArray(value))
        throw new CoordinationRuntimeError('invalid-state', `${label} is not an array`);
    return value;
}
function sha(value, label) {
    if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value))
        throw new CoordinationRuntimeError('invalid-state', `${label} is not a canonical SHA-256 digest`);
    return value;
}
function time(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value)))
        throw new CoordinationRuntimeError('invalid-state', `${label} is not a canonical UTC-millisecond timestamp`);
    return value;
}
function gitBlob(repoRoot, commit, path) {
    return runGitQuery({ cwd: repoRoot, descriptor: { kind: 'show-file', revision: commit, path } }).stdout;
}
function json(bytes, label) {
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-state', `${label} is not valid UTF-8 JSON`, [error instanceof Error ? error.message : String(error)]);
    }
}
function stablePrivateHeartbeat(root, ref) {
    const path = join(root, ref);
    const rel = relative(root, path);
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new CoordinationRuntimeError('unauthorized-client', 'accepted heartbeat path escapes program_evidence_root');
    let before;
    try {
        before = lstatSync(path);
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            throw new CoordinationRuntimeError('recovery-required', 'next external program heartbeat is not yet available', ['d65-heartbeat-authority-pending', ref]);
        throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > 1_048_576)
        throw new CoordinationRuntimeError('invalid-state', 'accepted heartbeat must be one-link, no-follow, regular mode 0600 and <=1 MiB', [path]);
    const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const opened = fstatSync(descriptor);
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
            throw new CoordinationRuntimeError('invalid-state', 'accepted heartbeat descriptor identity changed while opening', [path]);
        const bytes = readFileSync(descriptor);
        const after = fstatSync(descriptor);
        const pathAfter = lstatSync(path);
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino || pathAfter.nlink !== 1 || pathAfter.isSymbolicLink())
            throw new CoordinationRuntimeError('invalid-state', 'accepted heartbeat changed during stable read', [path]);
        return bytes;
    }
    finally {
        closeSync(descriptor);
    }
}
function boundaryFromStatus(payload, repoId, workstreamRun, head) {
    const runs = array(payload['runs'], 'status.runs').map(parseCoordinationRun);
    const resources = array(payload['run_resources'], 'status.run_resources').map(parseCoordinationRunResource);
    const sessions = array(payload['session_leases'], 'status.session_leases').map(parseCoordinationSessionLease);
    const artifacts = array(payload['authoritative_artifacts'], 'status.authoritative_artifacts').map(parseCoordinationAuthoritativeArtifact);
    const run = runs[0];
    if (runs.length !== 1 || run === undefined || run.repo_id !== repoId || run.workstream_run !== workstreamRun || resources.length !== 1)
        throw new CoordinationRuntimeError('invalid-state', 'paired D65 status lacks one exact run/resource authority');
    const attached = sessions.filter((session) => (session.status === 'attached' || session.status === 'handoff-pending') && session.attachment_kind === 'dispatch' && session.session_generation === run.active_session_generation);
    const attachedSession = attached[0];
    if (attached.length !== 1 || attachedSession === undefined)
        throw new CoordinationRuntimeError('invalid-state', 'paired D65 status lacks one exact current dispatch session');
    const policies = artifacts.filter((artifact) => artifact.document_schema_version === 'autopilot.launch_policy.v1');
    const policy = policies[0];
    const graphs = artifacts.filter((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1').sort((left, right) => d65SemanticGraphSequenceFromArtifactId(left.artifact_id) - d65SemanticGraphSequenceFromArtifactId(right.artifact_id));
    const graph = graphs[graphs.length - 1];
    if (policies.length !== 1 || policy === undefined || graph === undefined)
        throw new CoordinationRuntimeError('invalid-state', 'paired D65 status lacks exact policy/graph authority');
    return Object.freeze({ graph_sequence: d65SemanticGraphSequenceFromArtifactId(graph.artifact_id), graph_sha256: graph.evidence.sha256, policy_sha256: policy.evidence.sha256, heartbeat_sequence: head.sequence, heartbeat_sha256: head.heartbeat_sha256, session_lease_id: attachedSession.session_lease_id, session_generation: attachedSession.session_generation, run_version: run.version });
}
function authenticateRuntimeHeartbeatAuthority(status, doctor, repoId, workstreamRun) {
    const statusHead = parseD65HeartbeatAcceptanceResult(status['accepted_program_heartbeat']);
    const doctorHead = parseD65HeartbeatAcceptanceResult(doctor['accepted_program_heartbeat']);
    if (canonicalJson(statusHead) !== canonicalJson(doctorHead))
        throw new CoordinationRuntimeError('invalid-state', 'status/doctor accepted heartbeat heads differ');
    const boundary = boundaryFromStatus(status, repoId, workstreamRun, statusHead);
    const resources = array(status['run_resources'], 'status.run_resources').map(parseCoordinationRunResource);
    const artifacts = array(status['authoritative_artifacts'], 'status.authoritative_artifacts').map(parseCoordinationAuthoritativeArtifact);
    const policyArtifact = artifacts.find((artifact) => artifact.document_schema_version === 'autopilot.launch_policy.v1');
    const bootstrapArtifact = artifacts.find((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph_bootstrap.v1');
    const resource = resources[0];
    if (resources.length !== 1 || resource === undefined || policyArtifact === undefined || bootstrapArtifact === undefined)
        throw new CoordinationRuntimeError('invalid-state', 'D65 heartbeat authentication lacks resource/policy/bootstrap authority');
    const repoRoot = resource.main_worktree_path;
    const policy = parseD65LaunchPolicy(json(gitBlob(repoRoot, policyArtifact.git_commit, policyArtifact.evidence.ref), 'accepted launch policy'));
    const trustBytes = gitBlob(repoRoot, bootstrapArtifact.git_commit, policy.trust_anchor_ref);
    const trustDigest = `sha256:${createHash('sha256').update(trustBytes).digest('hex')}`;
    if (trustDigest !== policy.trust_anchor_sha256)
        throw new CoordinationRuntimeError('invalid-state', 'accepted launch policy trust anchor bytes diverge');
    const trust = parseD65TrustAnchorSpki(trustBytes);
    const { signature: _policySignature, ...unsignedPolicy } = policy;
    void _policySignature;
    if (!verifyD65Signature({ trustAnchor: trust, purpose: 'launch-policy', message: new TextEncoder().encode(canonicalJson(unsignedPolicy)), signature: policy.signature }))
        throw new CoordinationRuntimeError('invalid-state', 'accepted launch policy signature no longer authenticates');
    const authenticateExternal = () => {
        const bytes = stablePrivateHeartbeat(policy.program_evidence_root, statusHead.heartbeat_ref);
        const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        if (digest !== statusHead.heartbeat_sha256)
            throw new CoordinationRuntimeError('invalid-state', 'accepted heartbeat external bytes diverge from durable head');
        const parsed = parseD65ProgramHeartbeat(json(bytes, 'accepted program heartbeat'));
        const { signature: _heartbeatSignature, ...unsignedHeartbeat } = parsed;
        void _heartbeatSignature;
        if (!verifyD65Signature({ trustAnchor: trust, purpose: 'program-heartbeat', message: new TextEncoder().encode(canonicalJson(unsignedHeartbeat)), signature: parsed.signature }))
            throw new CoordinationRuntimeError('invalid-state', 'accepted program heartbeat signature no longer authenticates');
        if (parsed.program_id !== statusHead.program_id || parsed.sequence !== statusHead.sequence || parsed.prior_sha256 !== statusHead.prior_sha256 || parsed.issued_at !== statusHead.issued_at || parsed.valid_until !== statusHead.valid_until)
            throw new CoordinationRuntimeError('invalid-state', 'accepted program heartbeat fields diverge from durable head');
        return parsed;
    };
    const heartbeat = authenticateExternal();
    const highWater = reconcileD65HeartbeatHighWater({ programEvidenceRoot: policy.program_evidence_root, head: statusHead, verifyExternal: () => { if (canonicalJson(authenticateExternal()) !== canonicalJson(heartbeat))
            throw new CoordinationRuntimeError('invalid-state', 'accepted heartbeat changed between authentication and cache reconciliation'); } });
    const rows = heartbeat.rows.filter((row) => row.workstream_run === workstreamRun);
    const governingRow = rows[0];
    if (rows.length !== 1 || governingRow === undefined)
        throw new CoordinationRuntimeError('invalid-state', 'accepted heartbeat has no unique governing run row');
    const statusObservation = { coordinator_time: time(status['coordinator_time'], 'status.coordinator_time'), semantic_snapshot_sha256: sha(status['semantic_snapshot_sha256'], 'status.semantic_snapshot_sha256'), accepted_program_heartbeat: statusHead, boundary };
    const doctorObservation = { coordinator_time: time(doctor['coordinator_time'], 'doctor.coordinator_time'), semantic_snapshot_sha256: sha(doctor['semantic_snapshot_sha256'], 'doctor.semantic_snapshot_sha256'), accepted_program_heartbeat: doctorHead, boundary };
    return Object.freeze({ statusHead, boundary, governingRow, statusObservation, doctorObservation, highWater });
}
export function authenticateAndReconcileRuntimeHeartbeat(status, doctor, repoId, workstreamRun) {
    const authority = authenticateRuntimeHeartbeatAuthority(status, doctor, repoId, workstreamRun);
    verifyD65PairedHeartbeatGate({ status: authority.statusObservation, doctor: authority.doctorObservation, governingRow: authority.governingRow, highWater: authority.highWater });
}
/**
 * Accept the exact next externally signed heartbeat and immediately authenticate
 * status+doctor plus reconcile the local high-water cache. This function never
 * creates or signs heartbeat bytes; an absent next record fails loudly.
 */
export async function acceptNextD65ProgramHeartbeatFromEnvironment(input = {}) {
    const env = input.env ?? process.env;
    const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    if (contextPath === undefined)
        throw new CoordinationRuntimeError('invalid-state', 'D65 heartbeat acceptance requires a durable coordinator session context');
    const session = await readCoordinatorSessionContext(contextPath);
    const client = new CoordinatorClient({ env });
    const status = await client.query('status', session.repo_id, session.workstream_run);
    const runs = array(status.payload['runs'], 'heartbeat acceptance status.runs').map(parseCoordinationRun);
    const resources = array(status.payload['run_resources'], 'heartbeat acceptance status.run_resources').map(parseCoordinationRunResource);
    const artifacts = array(status.payload['authoritative_artifacts'], 'heartbeat acceptance status.authoritative_artifacts').map(parseCoordinationAuthoritativeArtifact);
    const run = runs[0];
    const resource = resources[0];
    const policies = artifacts.filter((artifact) => artifact.document_schema_version === 'autopilot.launch_policy.v1');
    const policyArtifact = policies[0];
    if (runs.length !== 1 || run === undefined || resources.length !== 1 || resource === undefined || policies.length !== 1 || policyArtifact === undefined)
        throw new CoordinationRuntimeError('invalid-state', 'D65 heartbeat acceptance lacks one exact run/resource/policy authority');
    const policy = parseD65LaunchPolicy(json(gitBlob(resource.main_worktree_path, policyArtifact.git_commit, policyArtifact.evidence.ref), 'accepted launch policy'));
    const headValue = status.payload['accepted_program_heartbeat'];
    const head = headValue === null ? null : parseD65HeartbeatAcceptanceResult(headValue);
    const nextSequence = (head?.sequence ?? 0) + 1;
    const heartbeatRef = `program-heartbeats/${String(nextSequence).padStart(20, '0')}.json`;
    const heartbeatBytes = stablePrivateHeartbeat(policy.program_evidence_root, heartbeatRef);
    const heartbeatSha256 = `sha256:${createHash('sha256').update(heartbeatBytes).digest('hex')}`;
    const heartbeat = parseD65ProgramHeartbeat(json(heartbeatBytes, 'next external program heartbeat'));
    if (heartbeat.sequence !== nextSequence || heartbeat.prior_sha256 !== (head?.heartbeat_sha256 ?? null))
        throw new CoordinationRuntimeError('stale-version', 'next external heartbeat does not extend the exact durable accepted chain', [String(heartbeat.sequence), String(nextSequence)]);
    const acceptanceKind = input.acceptanceKind ?? 'governing';
    const identity = { repo_id: run.repo_id, workstream_run: run.workstream_run, sequence: heartbeat.sequence, heartbeat_sha256: heartbeatSha256, acceptance_kind: acceptanceKind };
    const idempotencyKey = `accept-program-heartbeat:sha256:${createHash('sha256').update(`${canonicalJson(identity)}\n`, 'utf8').digest('hex')}`;
    const response = await client.mutate('accept-program-heartbeat', {
        repoId: run.repo_id, workstreamRun: run.workstream_run, sessionId: session.session_id,
        fencingGeneration: session.session_generation, expectedVersion: run.version, idempotencyKey,
    }, {
        acceptance_kind: acceptanceKind,
        expected_prior_sequence: head?.sequence ?? null,
        expected_prior_sha256: head?.heartbeat_sha256 ?? null,
        heartbeat_ref: heartbeatRef,
        heartbeat_sha256: heartbeatSha256,
        program_id: policy.program_id,
        workstream_run: run.workstream_run,
        session_lease_id: session.session_lease_id,
        session_token: session.session_token,
    });
    const accepted = parseD65HeartbeatAcceptanceResult(response.payload);
    if (response.committed_event_seq === null || accepted.sequence !== heartbeat.sequence || accepted.heartbeat_sha256 !== heartbeatSha256 || accepted.acceptance_kind !== acceptanceKind)
        throw new CoordinationRuntimeError('invalid-state', 'program heartbeat acceptance response differs from the submitted external record');
    const afterStatus = await client.query('status', session.repo_id, session.workstream_run);
    const afterDoctor = await client.query('doctor', session.repo_id, session.workstream_run);
    authenticateAndReconcileRuntimeHeartbeat(afterStatus.payload, afterDoctor.payload, session.repo_id, session.workstream_run);
    return accepted;
}
/** Return an already-governing authenticated head, or accept exactly one external successor for the expected graph. */
export async function ensureD65ProgramHeartbeatForGraphFromEnvironment(input) {
    const env = input.env ?? process.env;
    const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    if (contextPath === undefined)
        throw new CoordinationRuntimeError('invalid-state', 'D65 graph heartbeat binding requires a durable coordinator session context');
    const session = await readCoordinatorSessionContext(contextPath);
    const client = new CoordinatorClient({ env });
    const status = await client.query('status', session.repo_id, session.workstream_run);
    const doctor = await client.query('doctor', session.repo_id, session.workstream_run);
    const authority = authenticateRuntimeHeartbeatAuthority(status.payload, doctor.payload, session.repo_id, session.workstream_run);
    if (authority.boundary.graph_sequence !== input.graphSequence || authority.boundary.graph_sha256 !== input.graphSha256)
        throw new CoordinationRuntimeError('invalid-state', 'accepted coordinator graph boundary differs from the graph requiring heartbeat authority', [String(authority.boundary.graph_sequence), authority.boundary.graph_sha256, String(input.graphSequence), input.graphSha256]);
    if (authority.governingRow.accepted_graph_sequence === input.graphSequence && authority.governingRow.accepted_graph_sha256 === input.graphSha256) {
        verifyD65PairedHeartbeatGate({ status: authority.statusObservation, doctor: authority.doctorObservation, governingRow: authority.governingRow, highWater: authority.highWater });
        return authority.statusHead;
    }
    return await acceptNextD65ProgramHeartbeatFromEnvironment({ env, acceptanceKind: 'governing' });
}
async function currentD65Runtime(env, requirePairedHeartbeat) {
    const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    if (contextPath === undefined)
        return null; // Explicit legacy/non-coordinator runtime classification.
    const session = await readCoordinatorSessionContext(contextPath);
    const client = new CoordinatorClient({ env });
    const status = await client.query('status', session.repo_id, session.workstream_run);
    const rawArtifacts = status.payload['authoritative_artifacts'];
    if (!Array.isArray(rawArtifacts))
        throw new CoordinationRuntimeError('invalid-state', 'D65 runtime classification lacks committed artifact projection');
    const artifacts = rawArtifacts.map(parseCoordinationAuthoritativeArtifact);
    const bootstrapId = `semantic-graph-bootstrap:${session.workstream_run}`;
    const bootstrap = artifacts.filter((artifact) => artifact.artifact_id === bootstrapId && artifact.document_schema_version === 'autopilot.semantic_graph_bootstrap.v1');
    const d65Surface = artifacts.some((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1' || artifact.document_schema_version === 'autopilot.launch_policy.v1');
    if (bootstrap.length === 0) {
        if (d65Surface)
            throw new CoordinationRuntimeError('invalid-state', 'D65 authority artifacts exist without the deterministic bootstrap artifact');
        return null;
    }
    if (bootstrap.length !== 1)
        throw new CoordinationRuntimeError('invalid-state', 'D65 runtime has ambiguous bootstrap authority');
    if (requirePairedHeartbeat) {
        const doctor = await client.query('doctor', session.repo_id, session.workstream_run);
        authenticateAndReconcileRuntimeHeartbeat(status.payload, doctor.payload, session.repo_id, session.workstream_run);
    }
    return Object.freeze({ authority: new D65RuntimeDispatchAuthority({ client, repoId: session.repo_id, workstreamRun: session.workstream_run }), context: Object.freeze({ expected_version: session.run_version, session_lease_id: session.session_lease_id, session_id: session.session_id, session_generation: session.session_generation }) });
}
/** Gate a production boundary; legacy non-D65 runs are explicitly classified. */
export async function assertD65OrdinaryBoundaryFromEnvironment(boundary, env = process.env) {
    const runtime = await currentD65Runtime(env, true);
    if (runtime === null)
        return false;
    await runtime.authority.assertOrdinary(boundary, runtime.context);
    return true;
}
export async function assertD65RecoveryBoundaryFromEnvironment(boundary, bindings, env = process.env) {
    const runtime = await currentD65Runtime(env, false);
    if (runtime === null)
        return false;
    await runtime.authority.assertRecovery(boundary, runtime.context, bindings);
    return true;
}
function bootstrapDenied(issue, evidence = []) {
    throw new CoordinationRuntimeError('invalid-state', `semantic-graph-bootstrap-operation-denied: ${issue}`, [...evidence]);
}
function exportText(row, field, label) {
    const value = row[field];
    if (typeof value !== 'string')
        bootstrapDenied(`${label}.${field} is not text`);
    return value;
}
function exportInteger(row, field, label) {
    const value = row[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        bootstrapDenied(`${label}.${field} is not a nonnegative safe integer`);
    return value;
}
/**
 * The one narrow, fail-closed bootstrap main-worktree effect authority path
 * (fresh plan bootstrap matrix; freeze §9.5). The frozen bootstrap charter
 * itself authorizes exactly one external worktree mutation — the sole canonical
 * main/create — before the launch policy and initial heartbeat exist. This
 * function returns:
 *
 *  - `true`  : the run is inside the exact pre-first-graph bootstrap window AND
 *              the proposed effect is the exact authorized main/create at its
 *              exact expected in-progress stage over the exact charter event
 *              prefix. External mutation may proceed under bootstrap authority.
 *  - `false` : the run is not in the bootstrap window (non-D65 run, or an
 *              accepted launch policy / complete graph already exists). The
 *              caller must apply its ordinary/legacy dispatch gate unchanged.
 *  - throws  : the run IS in the bootstrap window but the proposed effect is
 *              not the exact authorized operation (unit worktree, materialize,
 *              wrong intent/session/generation/stage, extra or reordered event,
 *              or any child/model/product authority). No effect may occur.
 *
 * It never weakens `ordinaryDispatchAllowed`, never forges a heartbeat, and
 * never broadly skips D65 gating: once a policy or complete graph is accepted
 * this path permanently steps aside and every later effect uses the ordinary
 * or recovery predicates.
 */
export async function assertD65BootstrapMainWorktreeEffectBoundaryFromEnvironment(spec, env = process.env) {
    const contextPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    if (contextPath === undefined)
        return false; // Explicit legacy/non-coordinator runtime classification.
    const session = await readCoordinatorSessionContext(contextPath);
    const client = new CoordinatorClient({ env });
    const status = await client.query('status', session.repo_id, session.workstream_run);
    const artifacts = array(status.payload['authoritative_artifacts'], 'D65 bootstrap boundary artifacts').map(parseCoordinationAuthoritativeArtifact);
    const bootstrapId = `semantic-graph-bootstrap:${session.workstream_run}`;
    const bootstrapArtifacts = artifacts.filter((artifact) => artifact.artifact_id === bootstrapId && artifact.document_schema_version === 'autopilot.semantic_graph_bootstrap.v1');
    if (bootstrapArtifacts.length === 0) {
        if (artifacts.some((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1' || artifact.document_schema_version === 'autopilot.launch_policy.v1'))
            throw new CoordinationRuntimeError('invalid-state', 'D65 authority artifacts exist without the deterministic bootstrap artifact');
        return false;
    }
    const bootstrapArtifact = bootstrapArtifacts[0];
    if (bootstrapArtifacts.length !== 1 || bootstrapArtifact === undefined)
        throw new CoordinationRuntimeError('invalid-state', 'D65 runtime has ambiguous bootstrap authority');
    if (artifacts.some((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1') || artifacts.some((artifact) => artifact.document_schema_version === 'autopilot.launch_policy.v1')) {
        // The bootstrap window is over: an accepted policy/complete graph owns every
        // later worktree effect through the ordinary/recovery predicates unchanged.
        return false;
    }
    // Inside the exact pre-policy bootstrap window: the ONLY authorized external
    // worktree mutation is the sole canonical main/create. Everything else must
    // reject without effect.
    if (spec.operationType !== 'create' || spec.kind !== 'main' || spec.unitId !== 'main' || spec.attempt !== 1)
        bootstrapDenied('bootstrap authorizes only the sole canonical main/create worktree operation', [spec.operationType, spec.kind, spec.unitId, String(spec.attempt)]);
    const runs = array(status.payload['runs'], 'D65 bootstrap boundary runs').map(parseCoordinationRun);
    const resources = array(status.payload['run_resources'], 'D65 bootstrap boundary run_resources').map(parseCoordinationRunResource);
    const run = runs[0];
    const resource = resources[0];
    if (runs.length !== 1 || run === undefined || resources.length !== 1 || resource === undefined)
        bootstrapDenied('bootstrap window lacks one exact run/resource authority');
    if (run.status !== 'active')
        bootstrapDenied('bootstrap main/create requires an active run', [run.status]);
    if (run.active_session_generation !== 1 || session.session_generation !== 1)
        bootstrapDenied('bootstrap main/create requires the exact first dispatch session generation', [String(run.active_session_generation), String(session.session_generation)]);
    const sessions = array(status.payload['session_leases'], 'D65 bootstrap boundary session_leases').map(parseCoordinationSessionLease);
    const attached = sessions.filter((lease) => lease.status === 'attached' && lease.attachment_kind === 'dispatch' && lease.session_generation === 1);
    const attachedSession = attached[0];
    if (sessions.length !== 1 || attached.length !== 1 || attachedSession === undefined || attachedSession.session_lease_id !== session.session_lease_id || attachedSession.session_id !== session.session_id)
        bootstrapDenied('bootstrap main/create requires the exact attached generation-1 dispatch session matching the durable session context');
    if (array(status.payload['child_leases'], 'D65 bootstrap boundary child_leases').length !== 0 || array(status.payload['unit_attempts'], 'D65 bootstrap boundary unit_attempts').length !== 0 || array(status.payload['edit_leases'], 'D65 bootstrap boundary edit_leases').length !== 0 || array(status.payload['acquisition_groups'], 'D65 bootstrap boundary acquisition_groups').length !== 0)
        bootstrapDenied('bootstrap window forbids any child/attempt/lease/acquisition authority');
    // The accepted bootstrap envelope itself must byte-verify and bind this run.
    const bootstrapBytes = gitBlob(resource.source_repo, bootstrapArtifact.git_commit, bootstrapArtifact.evidence.ref);
    const bootstrapDigest = `sha256:${createHash('sha256').update(bootstrapBytes).digest('hex')}`;
    if (bootstrapDigest !== bootstrapArtifact.evidence.sha256)
        bootstrapDenied('bootstrap artifact bytes do not match their accepted digest', [bootstrapArtifact.evidence.sha256, bootstrapDigest]);
    const bootstrap = parseD65SemanticGraphBootstrap(json(bootstrapBytes, 'accepted bootstrap envelope'));
    if (bootstrap.repo_id !== session.repo_id || bootstrap.workstream_run !== session.workstream_run || bootstrap.autopilot_id !== run.autopilot_id || bootstrap.workstream !== run.workstream)
        bootstrapDenied('bootstrap envelope identity differs from the durable run');
    if (canonicalJson(bootstrap.prospective_resource) !== canonicalJson(resource))
        bootstrapDenied('bootstrap prospective resource does not byte-equal the durable run resource');
    if (!bootstrap.allowed_bootstrap_operations.includes('prepare-main-worktree') || !bootstrap.allowed_bootstrap_operations.includes('transition-main-worktree'))
        bootstrapDenied('bootstrap allowed operations do not authorize main-worktree creation');
    // The immutable intent must bind the exact bootstrap/run-resource identities.
    if (resolve(spec.intent.repo_root) !== resolve(resource.source_repo) || resolve(spec.intent.git_common_dir) !== resolve(resource.git_common_dir) || resolve(spec.intent.worktree_path) !== resolve(resource.main_worktree_path) || spec.intent.branch !== resource.branch)
        bootstrapDenied('bootstrap main/create intent does not bind the exact run-resource identity', [spec.intent.worktree_path, resource.main_worktree_path, spec.intent.branch, resource.branch]);
    if (spec.intent.base_sha !== bootstrap.content_commit || bootstrap.content_commit !== resource.target_base_sha)
        bootstrapDenied('bootstrap main/create base is not the exact content-result commit', [String(spec.intent.base_sha), bootstrap.content_commit, resource.target_base_sha]);
    if (spec.intent.target_sha !== null || spec.intent.archive_ref !== null)
        bootstrapDenied('bootstrap main/create intent carries unauthorized target/archive authority');
    // The durable operation must be the sole main/create at its exact expected
    // in-progress stage with the byte-identical immutable intent.
    const operations = array(status.payload['worktree_operations'], 'D65 bootstrap boundary worktree_operations').map(parseCoordinationWorktreeOperation);
    const operation = operations[0];
    if (operations.length !== 1 || operation === undefined)
        bootstrapDenied('bootstrap window must contain exactly one worktree operation', [String(operations.length)]);
    if (operation.operation_type !== 'create' || operation.owner.unit_id !== 'main' || operation.owner.attempt !== 1 || operation.owner.workstream_run !== session.workstream_run || operation.owner.repo_id !== session.repo_id)
        bootstrapDenied('durable bootstrap operation is not the sole canonical main/create', [operation.operation_id, operation.operation_type]);
    if (operation.stage !== 'in-progress' || canonicalJson([...operation.completed_steps]) !== canonicalJson(['preflight-probe']) || operation.current_step !== 'external-action')
        bootstrapDenied('bootstrap main/create is not at the exact expected in-progress external-action stage', [operation.stage, operation.completed_steps.join(','), String(operation.current_step)]);
    if (canonicalJson(operation.intent) !== canonicalJson(spec.intent))
        bootstrapDenied('bootstrap main/create durable immutable intent does not equal the requested effect intent');
    const worktrees = array(status.payload['worktrees'], 'D65 bootstrap boundary worktrees').map(parseCoordinationWorktree);
    const worktree = worktrees[0];
    if (worktrees.length !== 1 || worktree === undefined || worktree.worktree_id !== operation.worktree_id || worktree.kind !== 'main' || worktree.state !== 'planned')
        bootstrapDenied('bootstrap window must contain exactly one planned main worktree bound to the operation');
    // The complete accepted event history must be the exact charter prefix:
    // B run attach; first session attach; main/create prepare; the start
    // in-progress transition — and nothing else (no extra, reordered, or
    // complete-mode event).
    const exported = await readD65CoordinatorExport(client, session);
    const rawEvents = exported['events'];
    if (!Array.isArray(rawEvents))
        bootstrapDenied('coordinator export lacks the events table');
    const events = rawEvents
        .map((row) => {
        if (typeof row !== 'object' || row === null || Array.isArray(row))
            bootstrapDenied('coordinator export event row is not an object');
        return row;
    })
        .filter((row) => exportText(row, 'repo_id', 'export event') === session.repo_id)
        .sort((left, right) => exportInteger(left, 'event_seq', 'export event') - exportInteger(right, 'event_seq', 'export event'));
    const fixedPrefix = [
        { type: 'run-attached', entityType: 'run', entityId: session.workstream_run },
        { type: 'session-attached', entityType: 'session-lease', entityId: session.session_lease_id },
        { type: 'worktree-operation-prepared', entityType: 'worktree-operation', entityId: operation.operation_id },
    ];
    if (events.length < fixedPrefix.length + 1)
        bootstrapDenied('bootstrap event history is shorter than the exact charter prefix', [`events=${String(events.length)}`]);
    for (let index = 0; index < events.length; index += 1) {
        const actual = events[index];
        if (actual === undefined)
            bootstrapDenied('bootstrap event prefix comparison lost a row');
        const seq = exportInteger(actual, 'event_seq', 'export event');
        const type = exportText(actual, 'event_type', 'export event');
        const entityType = exportText(actual, 'entity_type', 'export event');
        const entityId = exportText(actual, 'entity_id', 'export event');
        if (seq !== index + 1)
            bootstrapDenied('bootstrap event history is gapped or reordered', [`seq=${String(seq)}`, `expected=${String(index + 1)}`]);
        const fixed = fixedPrefix[index];
        if (fixed !== undefined) {
            if (type !== fixed.type || entityType !== fixed.entityType || entityId !== fixed.entityId)
                bootstrapDenied('bootstrap event history has an extra, missing, reordered, or complete-mode event', [`seq=${String(seq)}`, `type=${type}`, `expected_type=${fixed.type}`, `entity=${entityType}/${entityId}`]);
            continue;
        }
        // After prepare, the only legal events are this operation's own frozen
        // in-progress/reconciling recovery transitions ("advanced only by the same
        // frozen intent/postcondition"); anything else — policy registration,
        // heartbeat acceptance, a second operation, any complete-mode event — is an
        // extra event and rejects.
        if (entityType !== 'worktree-operation' || entityId !== operation.operation_id || (type !== 'worktree-operation-in-progress' && type !== 'worktree-operation-reconciling'))
            bootstrapDenied('bootstrap event history has an extra or complete-mode event beyond the main/create transition prefix', [`seq=${String(seq)}`, `type=${type}`, `entity=${entityType}/${entityId}`]);
    }
    const lastEvent = events[events.length - 1];
    if (lastEvent === undefined || exportText(lastEvent, 'event_type', 'export event') !== 'worktree-operation-in-progress')
        bootstrapDenied('bootstrap main/create transition prefix does not currently end at in-progress');
    const reconcilingCount = events.filter((row) => exportText(row, 'event_type', 'export event') === 'worktree-operation-reconciling').length;
    if (reconcilingCount !== operation.recovery_attempts)
        bootstrapDenied('bootstrap main/create reconciling event count does not equal the durable recovery_attempts', [`events=${String(reconcilingCount)}`, `durable=${String(operation.recovery_attempts)}`]);
    return true;
}
