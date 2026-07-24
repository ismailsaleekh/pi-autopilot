import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../names.ts';
import { AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE } from '../checkout-profile.ts';
import { runGitQuery } from '../git-process.ts';
import { createAutopilotGitWorktree } from '../sparse-worktree.ts';
import {
  AUTOPILOT_RUNTIME_ENV,
  AUTOPILOT_RUNTIME_VALUE,
  BRANCHES_FILE,
  TASK_INFO_FILE,
  UNIT_INDEX_FILE,
  type ActiveAutopilotRow,
  type AutopilotRepoIdentity,
  type ProcessEnvLike,
} from '../parallel-runtime.ts';
import { CoordinatorClient } from './client.ts';
import { parseCoordinationAuthoritativeArtifact, parseCoordinationRun } from './contracts.ts';
import { CoordinationRuntimeError } from './failures.ts';
import {
  DurableRunSupervisorClient,
  readCoordinatorSessionContext,
  type RunSupervisorAttachment,
} from './supervisor.ts';
import { executeOwnedWorktreeSaga } from './worktree-saga.ts';
import { canonicalJson } from './canonical-json.ts';
import { publishD65FirstCompleteGraphFromEnvironment } from './d65-graph-successor-runtime.ts';
import { ensureD65ProgramHeartbeatForGraphFromEnvironment } from './d65-runtime-dispatch.ts';
import type { D65LaunchManifest } from './d65-launch-manifest.ts';
import type { D65LaunchSigner } from './d65-launch-signer.ts';

// D65 production launch integration (freeze §9.5; fresh plan §§2.3/2.4/3.1/3.2).
//
// This is the ONE production consumer that drives the human `/autopilot`
// startup path from a sealed D65 prelaunch package to a live, ordinary-dispatch-
// eligible run. It is fail-closed at every boundary and every durable step is
// idempotently recoverable after a crash/response loss. Nothing here signs
// operator authority: the launch policy and program heartbeat are produced by
// the external operator signer and only VERIFIED/CONSUMED here.
//
// Exact ordering (fresh plan §9.5):
//   1. attach-run WITH the sealed bootstrap_graph (single session).
//   2. attach exactly one initial dispatch session (generation 1).
//   3. create the full-tree main worktree through the frozen bootstrap saga.
//   4. register the operator-signed launch policy (one previously-absent path).
//   5. accept the operator-signed initial governing heartbeat (graph seq 1).
//   6. permit ONLY the bootstrap parent-planning turn (five charter roots).
//   7. publish + register the first complete graph (sequence 2).
//   8. accept the successor governing heartbeat bound to graph sequence 2.
//   9. allow ordinary child dispatch only afterward.
//
// The periodic session heartbeat is NOT started during the bootstrap window: the
// frozen first-graph validator requires the accepted history through E to be
// EXACTLY the 9-event B->E charter prefix, so any interleaved session heartbeat
// would fence the first graph. The launcher therefore drives the charter
// synchronously on one session; the session bridge starts its periodic heartbeat
// only after graph sequence 2 + its successor heartbeat are accepted (see the
// extension adopting the returned attachment).

function bytesSha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function gitText(cwd: string, descriptor: Parameters<typeof runGitQuery>[0]['descriptor'], label: string): string {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(runGitQuery({ cwd, descriptor }).stdout).trim();
  if (!/^[a-f0-9]{40}$/u.test(value)) throw new CoordinationRuntimeError('invalid-state', `${label} did not resolve to one full 40-hex Git object id`, [value]);
  return value;
}

/** The exact active row derived from the sealed manifest (never regenerated). */
export function activeRowFromLaunchManifest(manifest: D65LaunchManifest): ActiveAutopilotRow {
  return {
    schema_version: 'autopilot.active_parent.v2',
    coordination_authority: 'coordinator-edit-leases-v1',
    autopilot_id: manifest.autopilot_id,
    workstream: manifest.workstream,
    workstream_run: manifest.workstream_run,
    repo_key: manifest.repo_key,
    source_repo: manifest.canonical_root,
    git_common_dir: manifest.git_common_dir,
    worktree_root: manifest.worktree_root,
    main_worktree_path: manifest.main_worktree_path,
    branch: manifest.run_branch,
    runtime_root: manifest.runtime_root,
    target_branch: manifest.target_branch,
    target_base_sha: manifest.content_result_commit,
    origin_url: null,
    pid: process.pid,
    boot_id: '<launch-boot>',
    status: 'active',
    started_at: manifest.run_timestamp,
    active_run_epoch: 1,
    active_epoch_started_at: manifest.run_timestamp,
    active_run_receipt_id: `launch-${manifest.workstream_run}`,
  };
}

/** The exact repo identity derived from the sealed manifest. */
export function repoIdentityFromLaunchManifest(manifest: D65LaunchManifest): AutopilotRepoIdentity {
  return {
    repoRoot: manifest.canonical_root,
    gitCommonDir: manifest.git_common_dir,
    repoKey: manifest.repo_key,
    headSha: manifest.content_result_commit,
    targetBranch: manifest.target_branch,
    originUrl: null,
  };
}

/** The exact attach-run.bootstrap_graph payload derived from the sealed manifest. */
function bootstrapGraphPayload(manifest: D65LaunchManifest): Readonly<Record<string, unknown>> {
  return {
    schema_version: 'autopilot.semantic_graph_bootstrap.v1',
    ref: manifest.bootstrap_overlay.bootstrap_ref,
    sha256: manifest.bootstrap_overlay.bootstrap_sha256,
    byte_count: manifest.bootstrap_overlay.bootstrap_byte_count,
    git_commit: manifest.bootstrap_overlay.overlay_commit,
    covered_event_seq: 0,
    prospective_run: manifest.prospective_run,
    prospective_resource: manifest.prospective_resource,
    trust_anchor_ref: manifest.trust_anchor.trust_anchor_ref,
    trust_anchor_sha256: manifest.trust_anchor.trust_anchor_sha256,
  };
}

export interface D65LaunchBootstrapResult {
  readonly attachment: RunSupervisorAttachment;
  readonly contextPath: string;
  readonly mainWorktreePath: string;
  readonly runtimeRoot: string;
  readonly active: ActiveAutopilotRow;
  readonly repo: AutopilotRepoIdentity;
}

/**
 * Prove the physical clone/overlay bytes agree with the sealed manifest before
 * any coordinator mutation (fail-closed load-time binding).
 */
export function verifyLaunchManifestAgainstClone(manifest: D65LaunchManifest): void {
  const repoRoot = manifest.canonical_root;
  // The B0 -> content-result ancestry must be exactly one-parent B0.
  const resolvedContent = gitText(repoRoot, { kind: 'resolve-commit', revision: manifest.content_result_commit }, 'content-result commit');
  if (resolvedContent !== manifest.content_result_commit) throw new CoordinationRuntimeError('invalid-state', 'sealed content-result commit is not resolvable in the source clone');
  const parentLine = new TextDecoder('utf-8', { fatal: true }).decode(runGitQuery({ cwd: repoRoot, descriptor: { kind: 'rev-list-parents', revision: manifest.content_result_commit } }).stdout).trim();
  const parents = parentLine.split(/\s+/u).filter((entry) => entry.length > 0);
  if (parents.length !== 2 || parents[1] !== manifest.b0_commit) throw new CoordinationRuntimeError('invalid-state', 'sealed content-result commit must have exactly one parent equal to B0', parents.slice(1));
  const contentTree = gitText(repoRoot, { kind: 'resolve-tree', revision: manifest.content_result_commit }, 'content-result tree');
  if (contentTree !== manifest.content_result_tree) throw new CoordinationRuntimeError('invalid-state', 'sealed content-result tree diverges from the source clone');
  const b0Tree = gitText(repoRoot, { kind: 'resolve-tree', revision: manifest.b0_commit }, 'B0 tree');
  if (b0Tree !== manifest.b0_tree) throw new CoordinationRuntimeError('invalid-state', 'sealed B0 tree diverges from the source clone');
  // The launch/bootstrap overlay commit must be a sibling of the content result
  // whose sole parent is the content result (fresh plan §2.2 launch preparation).
  const overlayParentLine = new TextDecoder('utf-8', { fatal: true }).decode(runGitQuery({ cwd: repoRoot, descriptor: { kind: 'rev-list-parents', revision: manifest.bootstrap_overlay.overlay_commit } }).stdout).trim();
  const overlayParents = overlayParentLine.split(/\s+/u).filter((entry) => entry.length > 0);
  if (overlayParents.length !== 2 || overlayParents[1] !== manifest.content_result_commit) throw new CoordinationRuntimeError('invalid-state', 'sealed bootstrap overlay commit must have exactly one parent equal to the content-result commit', overlayParents.slice(1));
  // The overlay must carry EXACTLY the bootstrap + trust blobs and byte/digest.
  const bootstrapBlob = readD65OverlayBlob(repoRoot, manifest.bootstrap_overlay.overlay_commit, manifest.bootstrap_overlay.bootstrap_ref);
  if (bootstrapBlob.byteLength !== manifest.bootstrap_overlay.bootstrap_byte_count) throw new CoordinationRuntimeError('invalid-state', 'sealed bootstrap byte_count diverges from the committed overlay blob');
  if (bytesSha256(bootstrapBlob) !== manifest.bootstrap_overlay.bootstrap_sha256) throw new CoordinationRuntimeError('invalid-state', 'sealed bootstrap digest diverges from the committed overlay blob');
  const trustBlob = readD65OverlayBlob(repoRoot, manifest.bootstrap_overlay.overlay_commit, manifest.trust_anchor.trust_anchor_ref);
  if (trustBlob.byteLength !== 44) throw new CoordinationRuntimeError('invalid-state', 'sealed trust anchor must be exactly 44 SPKI bytes in the committed overlay');
  if (bytesSha256(trustBlob) !== manifest.trust_anchor.trust_anchor_sha256) throw new CoordinationRuntimeError('invalid-state', 'sealed trust anchor digest diverges from the committed overlay blob');
  // The program evidence root must be a real mode-0700 directory.
  const evidenceStat = lstatSync(manifest.program_evidence_root);
  if (!evidenceStat.isDirectory() || (evidenceStat.mode & 0o777) !== 0o700) throw new CoordinationRuntimeError('invalid-state', 'sealed program_evidence_root must be a mode-0700 directory', [manifest.program_evidence_root]);
}

function readD65OverlayBlob(repoRoot: string, commit: string, path: string): Uint8Array {
  const listing = new TextDecoder('utf-8', { fatal: true }).decode(runGitQuery({ cwd: repoRoot, descriptor: { kind: 'ls-tree-path', revision: commit, path } }).stdout).split('\0').filter((entry) => entry.length > 0);
  if (listing.length !== 1) throw new CoordinationRuntimeError('invalid-state', 'sealed overlay path did not resolve to exactly one tracked blob', [path]);
  const match = /^([0-7]{6}) (blob) ([a-f0-9]{40})\t/u.exec(listing[0] ?? '');
  if (match === null || match[1] !== '100644') throw new CoordinationRuntimeError('invalid-state', 'sealed overlay entry must be a mode-100644 blob', [path, listing[0] ?? '']);
  return runGitQuery({ cwd: repoRoot, descriptor: { kind: 'show-file', revision: commit, path } }).stdout;
}

/**
 * Stage 1-3: attach-run with the sealed bootstrap_graph via a single session and
 * create the full-tree main worktree through the frozen bootstrap saga. Every
 * step is idempotent; a crash before/after any boundary re-runs the exact effect
 * or is safely fenced.
 */
export async function beginD65LaunchBootstrap(input: {
  readonly manifest: D65LaunchManifest;
  readonly rawSessionId: string;
  readonly env: ProcessEnvLike;
}): Promise<D65LaunchBootstrapResult> {
  const { manifest } = input;
  verifyLaunchManifestAgainstClone(manifest);
  const repo = repoIdentityFromLaunchManifest(manifest);
  const active = activeRowFromLaunchManifest(manifest);
  const supervisor = new DurableRunSupervisorClient(input.env);
  const attachment = await supervisor.attachD65Bootstrap({
    repo,
    active,
    rawSessionId: input.rawSessionId,
    bootstrapGraph: bootstrapGraphPayload(manifest),
    prospectiveRun: manifest.prospective_run,
    prospectiveResource: manifest.prospective_resource,
    attachRunIdempotencyKey: manifest.attach_run_idempotency_key,
    attachSessionIdempotencyKey: manifest.attach_session_idempotency_key,
    sessionLeaseId: prospectiveSessionLeaseId(manifest),
  });
  const sagaEnv: ProcessEnvLike = { ...input.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
  await createD65MainWorktree({ manifest, active, repo, env: sagaEnv });
  return {
    attachment,
    contextPath: attachment.contextPath,
    mainWorktreePath: manifest.main_worktree_path,
    runtimeRoot: manifest.runtime_root,
    active,
    repo,
  };
}

/** The deterministic session lease id sealed for the initial bootstrap session. */
function prospectiveSessionLeaseId(manifest: D65LaunchManifest): string {
  return `session-lease-${manifest.workstream_run}`;
}

/** Stage 3: the full-tree main worktree created from content_result_commit. */
async function createD65MainWorktree(input: { readonly manifest: D65LaunchManifest; readonly active: ActiveAutopilotRow; readonly repo: AutopilotRepoIdentity; readonly env: ProcessEnvLike }): Promise<void> {
  const { manifest } = input;
  const mainWorktreePath = manifest.main_worktree_path;
  const taskRoot = dirname(mainWorktreePath);
  const runtimeRoot = manifest.runtime_root;
  const branch = manifest.run_branch;
  const taskInfo = {
    schema_version: 'autopilot.task_info.v2', coordination_authority: 'coordinator-edit-leases-v1',
    workstream: manifest.workstream, workstream_run: manifest.workstream_run, autopilot_id: manifest.autopilot_id,
    source_repo: manifest.canonical_root, git_common_dir: manifest.git_common_dir, repo_key: manifest.repo_key,
    base_sha: manifest.content_result_commit, branch, worktree_path: mainWorktreePath, runtime_root: runtimeRoot,
    target_branch: manifest.target_branch, target_base_sha: manifest.content_result_commit,
    started_at: manifest.run_timestamp, closed_at: null, status: 'active', checkout_mode: 'full',
    checkout_profile_ref: AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE,
    checkout_profile_sha256: bytesSha256(new TextEncoder().encode('d65-launch-full-tree-profile')),
    checkout_profile_origin: 'default',
  };
  const branches = { schema_version: 'autopilot.branches.v1', active_branch: branch, base_sha: manifest.content_result_commit, current_sha: manifest.content_result_commit, archive_ref: null, unit_branches: [] };
  const profileSnapshot = { schema_version: 'autopilot.checkout_profile_snapshot.v1', profile: { mode: 'full', disk_gate: { expected_parallel_units: 1 } }, profile_sha256: taskInfo.checkout_profile_sha256, origin: 'default', captured_at: manifest.run_timestamp };
  await executeOwnedWorktreeSaga({
    active: input.active, unitId: 'main', attempt: 1, kind: 'main', operationType: 'create',
    initialWorktreeState: 'planned', committedWorktreeState: 'active',
    intent: {
      repo_root: manifest.canonical_root, worktree_path: mainWorktreePath, git_common_dir: manifest.git_common_dir, branch,
      reason: 'create isolated D65 launch main worktree', base_sha: manifest.content_result_commit, target_sha: null, archive_ref: null,
      checkout_mode: 'full', sparse_patterns: [], paths: [],
      metadata_refs: [AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE, TASK_INFO_FILE, BRANCHES_FILE, UNIT_INDEX_FILE],
    },
  }, {
    action: async () => {
      if (!existsSync(mainWorktreePath)) {
        await createAutopilotGitWorktree({
          repoRoot: manifest.canonical_root, worktreePath: mainWorktreePath, branch, startPoint: manifest.content_result_commit,
          mode: 'full', sparsePatterns: [], env: { ...input.env, [AUTOPILOT_RUNTIME_ENV]: AUTOPILOT_RUNTIME_VALUE },
        });
      }
    },
    finalize: async () => {
      await mkdir(runtimeRoot, { recursive: true });
      await writeJson(join(taskRoot, AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE), profileSnapshot);
      await writeJson(join(taskRoot, TASK_INFO_FILE), taskInfo);
      await writeJson(join(taskRoot, BRANCHES_FILE), branches);
      await writeJson(join(taskRoot, UNIT_INDEX_FILE), { schema_version: 'autopilot.unit_index.v1', units: [] });
    },
  }, input.env);
  await mkdir(runtimeRoot, { recursive: true });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Stage 4-5: register the operator-signed launch policy (one previously-absent
 * policy path, sole-parent = content_result_commit), then accept the operator-
 * signed initial governing heartbeat (graph sequence 1). Both steps consume
 * externally signed bytes; neither is signed by runtime code. Idempotent on
 * response loss.
 */
export async function registerD65LaunchPolicyAndInitialHeartbeat(input: {
  readonly manifest: D65LaunchManifest;
  readonly attachment: RunSupervisorAttachment;
  readonly signer: D65LaunchSigner;
  readonly env: ProcessEnvLike;
}): Promise<void> {
  const { manifest, attachment } = input;
  const env: ProcessEnvLike = { ...input.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
  const client = new CoordinatorClient({ env });
  const session = await readCoordinatorSessionContext(attachment.contextPath);

  // Idempotency: if a launch policy is already accepted, skip signing/register.
  const status = await client.query('status', session.repo_id, session.workstream_run);
  const artifacts = requireArtifacts(status.payload);
  const acceptedPolicy = artifacts.find((artifact) => artifact.document_schema_version === 'autopilot.launch_policy.v1');
  if (acceptedPolicy === undefined) {
    // Ask the external signer to produce the exact signed policy candidate.
    const signed = await input.signer.signLaunchPolicy({
      kind: 'launch-policy', state_root: manifest.state_root, repo_id: manifest.repo_id, workstream_run: manifest.workstream_run,
      policy_id: manifest.policy_candidate.policy_id, policy_ref: manifest.policy_candidate.policy_ref, expected_policy_sha256: manifest.policy_candidate.policy_sha256,
    });
    if (signed.sha256 !== manifest.policy_candidate.policy_sha256) throw new CoordinationRuntimeError('invalid-state', 'signed launch policy digest differs from the sealed manifest policy digest', [signed.sha256, manifest.policy_candidate.policy_sha256]);
    // Commit the signed policy at the exact previously-absent policy path with a
    // sole parent = content_result_commit (run-main HEAD is content result at
    // this stage). Then register it through the existing frozen store surface.
    await commitD65PolicyBlob({ manifest, signedAbsolutePath: signed.absolute_path, env });
    const head = gitText(manifest.main_worktree_path, { kind: 'head' }, 'policy commit HEAD');
    const run = requireOneRun(status.payload);
    const response = await client.mutate('register-authoritative-artifact', {
      repoId: session.repo_id, workstreamRun: session.workstream_run, sessionId: session.session_id,
      fencingGeneration: session.session_generation, expectedVersion: run.version, idempotencyKey: manifest.policy_candidate.registration_idempotency_key,
    }, {
      artifact_id: `launch-policy:${manifest.workstream_run}:${manifest.policy_candidate.policy_id}`, source_type: 'task', source_scope: 'run-main',
      document_schema_version: 'autopilot.launch_policy.v1', git_commit: head, ref: manifest.policy_candidate.policy_ref, sha256: manifest.policy_candidate.policy_sha256,
      session_lease_id: session.session_lease_id, session_token: session.session_token,
    });
    const registered = parseCoordinationAuthoritativeArtifact(response.payload['authoritative_artifact']);
    if (registered.evidence.sha256 !== manifest.policy_candidate.policy_sha256) throw new CoordinationRuntimeError('invalid-state', 'accepted launch policy digest differs from the signed policy');
  }

  // Accept the operator-signed initial governing heartbeat bound to graph seq 1.
  await acceptSignedGraphHeartbeat({ manifest, attachment, signer: input.signer, graphSequence: 1, graphSha256: bootstrapDigest(status.payload, session.workstream_run), heartbeatSequence: 1, env });
}

/** The accepted bootstrap graph digest (graph 1) = the bootstrap artifact digest. */
function bootstrapDigest(statusPayload: Readonly<Record<string, unknown>>, workstreamRun: string): `sha256:${string}` {
  const artifacts = requireArtifacts(statusPayload);
  const bootstrap = artifacts.find((artifact) => artifact.artifact_id === `semantic-graph-bootstrap:${workstreamRun}` && artifact.document_schema_version === 'autopilot.semantic_graph_bootstrap.v1');
  if (bootstrap === undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 launch policy stage lacks the accepted bootstrap artifact');
  return bootstrap.evidence.sha256;
}

/** Commit the operator-signed policy blob at run-main from content-result HEAD. */
async function commitD65PolicyBlob(input: { readonly manifest: D65LaunchManifest; readonly signedAbsolutePath: string; readonly env: ProcessEnvLike }): Promise<void> {
  const mainRoot = input.manifest.main_worktree_path;
  const policyPath = join(mainRoot, ...input.manifest.policy_candidate.policy_ref.split('/'));
  // The signer wrote the canonical signed policy bytes to its absolute evidence
  // path; copy those exact bytes into the run-main worktree at the sealed policy
  // path, then commit. The store re-verifies signature/identity/one-path/sole-
  // parent at registration time.
  const signedBytes = await readFile(input.signedAbsolutePath);
  if (bytesSha256(signedBytes) !== input.manifest.policy_candidate.policy_sha256) throw new CoordinationRuntimeError('invalid-state', 'signed policy candidate bytes diverge from the sealed digest before commit');
  await mkdir(dirname(policyPath), { recursive: true });
  await writeFile(policyPath, signedBytes);
  const gitEnv: ProcessEnvLike = { ...input.env, GIT_AUTHOR_NAME: 'autopilot-launch', GIT_AUTHOR_EMAIL: 'autopilot-launch@example.invalid', GIT_COMMITTER_NAME: 'autopilot-launch', GIT_COMMITTER_EMAIL: 'autopilot-launch@example.invalid', GIT_AUTHOR_DATE: input.manifest.run_timestamp, GIT_COMMITTER_DATE: input.manifest.run_timestamp };
  const { runGitMutation } = await import('../git-process.ts');
  const staged = await runGitMutation({ cwd: mainRoot, descriptor: { kind: 'stage-paths', paths: [input.manifest.policy_candidate.policy_ref], sparse: true }, env: gitEnv });
  if (staged.kind !== 'reported' || staged.exitCode !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 launch policy staging failed', [staged.kind === 'reported' ? staged.diagnostic : staged.reason]);
  const committed = await runGitMutation({ cwd: mainRoot, descriptor: { kind: 'commit', message: 'autopilot: register D65 launch policy' }, env: gitEnv });
  if (committed.kind !== 'reported' || committed.exitCode !== 0) throw new CoordinationRuntimeError('invalid-state', 'D65 launch policy commit failed', [committed.kind === 'reported' ? committed.diagnostic : committed.reason]);
}

/**
 * Accept one operator-signed governing heartbeat bound to an exact graph
 * sequence/digest. The signer produces the signed bytes (reading live status/
 * doctor identity itself); the runtime only accepts via the frozen
 * `ensureD65ProgramHeartbeatForGraphFromEnvironment` gate.
 */
async function acceptSignedGraphHeartbeat(input: {
  readonly manifest: D65LaunchManifest;
  readonly attachment: RunSupervisorAttachment;
  readonly signer: D65LaunchSigner;
  readonly graphSequence: number;
  readonly graphSha256: `sha256:${string}`;
  readonly heartbeatSequence: number;
  readonly env: ProcessEnvLike;
}): Promise<void> {
  const env: ProcessEnvLike = { ...input.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: input.attachment.contextPath };
  // Idempotency: if the governing heartbeat for this sequence is already the
  // accepted head, skip producing a new candidate.
  const client = new CoordinatorClient({ env });
  const session = await readCoordinatorSessionContext(input.attachment.contextPath);
  const status = await client.query('status', session.repo_id, session.workstream_run);
  const head = status.payload['accepted_program_heartbeat'];
  const acceptedSequence = typeof head === 'object' && head !== null ? (head as Record<string, unknown>)['sequence'] : null;
  const alreadyAccepted = acceptedSequence === input.heartbeatSequence;
  if (!alreadyAccepted) {
    await input.signer.signProgramHeartbeat({
      kind: 'program-heartbeat', state_root: input.manifest.state_root, repo_id: input.manifest.repo_id, workstream_run: input.manifest.workstream_run,
      graph_sequence: input.graphSequence, graph_sha256: input.graphSha256, heartbeat_sequence: input.heartbeatSequence,
    });
  }
  // The initial heartbeat (sequence 1) is accepted BEFORE any complete graph
  // exists, so the runtime status/doctor paired authentication (which requires
  // an accepted complete graph) cannot yet run. Accept it through the raw
  // `accept-program-heartbeat` mutation over the externally signed bytes; the
  // store verifies signature/trust/status/policy identity inside the mutation.
  // Later sequences (graph 2+) authenticate the prior governing head then accept
  // the exact successor via the frozen paired gate.
  if (input.heartbeatSequence === 1) {
    if (!alreadyAccepted) await acceptInitialGoverningHeartbeat({ client, session, manifest: input.manifest });
  } else {
    await ensureD65ProgramHeartbeatForGraphFromEnvironment({ graphSequence: input.graphSequence, graphSha256: input.graphSha256, env });
  }
}

/**
 * Accept the operator-signed initial governing heartbeat (sequence 1) through
 * the raw `accept-program-heartbeat` mutation. This runs in the bootstrap window
 * where no complete graph exists yet, so it cannot use the paired status/doctor
 * gate. The store still verifies the full signed record, trust anchor, current
 * status/doctor digests, and CAS chain inside the mutation. Idempotent on replay.
 */
async function acceptInitialGoverningHeartbeat(input: { readonly client: CoordinatorClient; readonly session: Awaited<ReturnType<typeof readCoordinatorSessionContext>>; readonly manifest: D65LaunchManifest }): Promise<void> {
  const { client, session, manifest } = input;
  const status = await client.query('status', session.repo_id, session.workstream_run);
  const run = requireOneRun(status.payload);
  const heartbeatRef = 'program-heartbeats/00000000000000000001.json';
  const heartbeatBytes = readEvidenceHeartbeat(manifest.program_evidence_root, heartbeatRef);
  const heartbeatSha256 = bytesSha256(heartbeatBytes);
  const identity = { repo_id: session.repo_id, workstream_run: session.workstream_run, sequence: 1, heartbeat_sha256: heartbeatSha256, acceptance_kind: 'governing' };
  const idempotencyKey = `accept-program-heartbeat:${bytesSha256(new TextEncoder().encode(`${canonicalJson(identity)}\n`))}`;
  const response = await client.mutate('accept-program-heartbeat', {
    repoId: session.repo_id, workstreamRun: session.workstream_run, sessionId: session.session_id,
    fencingGeneration: session.session_generation, expectedVersion: run.version, idempotencyKey,
  }, {
    program_id: manifest.program_id, workstream_run: session.workstream_run, heartbeat_ref: heartbeatRef, heartbeat_sha256: heartbeatSha256,
    acceptance_kind: 'governing', expected_prior_sequence: null, expected_prior_sha256: null,
    session_lease_id: session.session_lease_id, session_token: session.session_token,
  });
  if (response.committed_event_seq === null) throw new CoordinationRuntimeError('invalid-state', 'initial governing heartbeat acceptance did not commit');
}

function readEvidenceHeartbeat(programEvidenceRoot: string, ref: string): Uint8Array {
  const path = join(programEvidenceRoot, ...ref.split('/'));
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > 1_048_576) throw new CoordinationRuntimeError('invalid-state', 'initial heartbeat candidate must be a one-link no-follow regular mode-0600 file', [path]);
  return readFileSync(path);
}

/**
 * Stage 7-8: after the bootstrap parent-planning turn wrote exactly the five
 * charter roots, publish + register the first complete graph (sequence 2)
 * through the existing production publisher, then accept the successor governing
 * heartbeat bound to graph sequence 2. Only after this may ordinary child
 * dispatch proceed. Idempotent: an already-accepted graph 2 is recognized.
 */
export async function publishD65FirstGraphAndSuccessorHeartbeat(input: {
  readonly manifest: D65LaunchManifest;
  readonly attachment: RunSupervisorAttachment;
  readonly signer: D65LaunchSigner;
  readonly env: ProcessEnvLike;
  readonly createdAt?: string;
}): Promise<Readonly<{ graphSequence: number; graphSha256: `sha256:${string}` }>> {
  const env: ProcessEnvLike = { ...input.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: input.attachment.contextPath };
  const client = new CoordinatorClient({ env });
  const session = await readCoordinatorSessionContext(input.attachment.contextPath);
  const status = await client.query('status', session.repo_id, session.workstream_run);
  const artifacts = requireArtifacts(status.payload);
  const existingGraph = artifacts.find((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1');
  let graphSha256: `sha256:${string}`;
  if (existingGraph === undefined) {
    const published = await publishD65FirstCompleteGraphFromEnvironment({ env, ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }) });
    if (published.graphSequence !== 2) throw new CoordinationRuntimeError('invalid-state', 'first complete graph publication did not produce graph sequence 2', [String(published.graphSequence)]);
    graphSha256 = published.graphSha256;
  } else {
    graphSha256 = existingGraph.evidence.sha256;
  }
  await acceptSignedGraphHeartbeat({ manifest: input.manifest, attachment: input.attachment, signer: input.signer, graphSequence: 2, graphSha256, heartbeatSequence: 2, env });
  return Object.freeze({ graphSequence: 2, graphSha256 });
}

/** The exact five previously-absent charter roots the bootstrap turn writes. */
export const D65_CHARTER_ROOTS = Object.freeze(['mission.md', 'master-plan.json', 'state.json', 'decision-log.jsonl', 'events.jsonl'] as const);

/**
 * Detect whether the bootstrap parent-planning turn has produced exactly the
 * five charter roots inside the runtime root, and nothing outside the exact
 * charter scope (no product/source path, extra root, child, or claim). Returns
 * a closed verdict; a scope violation fails loud.
 */
export function detectD65CharterComplete(manifest: D65LaunchManifest): boolean {
  const runtimeRoot = manifest.runtime_root;
  for (const root of D65_CHARTER_ROOTS) {
    if (!existsSync(join(runtimeRoot, root))) return false;
  }
  // Require the run-main worktree to have no staged or product changes beyond the
  // exact five charter roots relative to the accepted policy commit. The
  // NUL-terminated porcelain v1 output is `XY <path>\0` per record (rename
  // records carry an extra `\0<orig>` which we treat as an out-of-scope path).
  const mainRoot = manifest.main_worktree_path;
  const records = new TextDecoder('utf-8', { fatal: true }).decode(runGitQuery({ cwd: mainRoot, descriptor: { kind: 'status-porcelain', includeIgnored: false } }).stdout).split('\0').filter((entry) => entry.length > 0);
  const runtimePrefix = manifest.runtime_root.startsWith(`${mainRoot}/`) ? manifest.runtime_root.slice(mainRoot.length + 1) : null;
  if (runtimePrefix === null) throw new CoordinationRuntimeError('invalid-state', 'runtime root is not a descendant of the main worktree');
  const allowed = new Set(D65_CHARTER_ROOTS.map((root) => `${runtimePrefix}/${root}`));
  const STATUS_CODES = new Set([' ', 'M', 'A', 'D', 'R', 'C', 'U', '?', String.fromCharCode(33)]);
  const hasStatusPrefix = (record: string): boolean => record.length >= 4 && STATUS_CODES.has(record.charAt(0)) && STATUS_CODES.has(record.charAt(1)) && record.charAt(2) === ' ';
  for (const record of records) {
    // A record shorter than 4 chars is a rename origin path (no `XY ` prefix).
    const path = hasStatusPrefix(record) ? record.slice(3) : record;
    if (!allowed.has(path)) throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-bootstrap-operation-denied: parent planning touched a path outside the exact five charter roots', [path]);
  }
  return true;
}

function requireArtifacts(statusPayload: Readonly<Record<string, unknown>>): ReturnType<typeof parseCoordinationAuthoritativeArtifact>[] {
  const value = statusPayload['authoritative_artifacts'];
  if (!Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', 'D65 launch status lacks committed artifact projection');
  return value.map(parseCoordinationAuthoritativeArtifact);
}

function requireOneRun(statusPayload: Readonly<Record<string, unknown>>): ReturnType<typeof parseCoordinationRun> {
  const value = statusPayload['runs'];
  if (!Array.isArray(value) || value.length !== 1 || value[0] === undefined) throw new CoordinationRuntimeError('invalid-state', 'D65 launch status lacks exactly one run');
  return parseCoordinationRun(value[0]);
}
