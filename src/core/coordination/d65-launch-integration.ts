import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../names.ts';
import { AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE, checkoutProfileSnapshotFromResolved, resolveAutopilotFullCheckoutProfile } from '../checkout-profile.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../parallel-runtime.ts';
import { runGitQuery } from '../git-process.ts';
import { createAutopilotGitWorktree } from '../sparse-worktree.ts';
import {
  AUTOPILOT_RUNTIME_ENV,
  AUTOPILOT_RUNTIME_VALUE,
  BRANCHES_FILE,
  TASK_INFO_FILE,
  UNIT_INDEX_FILE,
  writeJsonAtomic,
  type ActiveAutopilotRow,
  type AutopilotBranchesInfo,
  type AutopilotRepoIdentity,
  type AutopilotTaskInfo,
  type ProcessEnvLike,
} from '../parallel-runtime.ts';
import { CoordinatorClient } from './client.ts';
import { coordinatorRuntimePaths } from './runtime-paths.ts';
import { parseCoordinationAuthoritativeArtifact, parseCoordinationRun, parseCoordinationSessionLease } from './contracts.ts';
import { CoordinationRuntimeError } from './failures.ts';
import { readImmutableFileBytes } from './immutable-file.ts';
import {
  DurableRunSupervisorClient,
  readCoordinatorSessionContext,
  type RunSupervisorAttachment,
} from './supervisor.ts';
import { executeOwnedWorktreeSaga } from './worktree-saga.ts';
import { canonicalJson } from './canonical-json.ts';
import { parseD65SemanticGraphBootstrap } from './d65-semantic-graph.ts';
import { publishD65FirstCompleteGraphFromEnvironment } from './d65-graph-successor-runtime.ts';
import { ensureD65ProgramHeartbeatForGraphFromEnvironment } from './d65-runtime-dispatch.ts';
import type { D65LaunchManifest } from './d65-launch-manifest.ts';
import type { D65LaunchSigner } from './d65-launch-signer.ts';
import { authenticateD65LaunchRoster } from './d65-launch-roster.ts';
import { publishRuntimeRosterSnapshot } from '../roster/snapshot.ts';
import { preRunSelectionPath, resolveRosterScopePaths, rosterRevisionPath, type RosterSha256 } from '../roster/paths.ts';
import { ensurePrivateDirectory, publishCreateOnlyAtomic } from '../roster/transaction.ts';
import { parseAutopilotRoster } from '../roster/contracts.ts';
import { parseRosterJsonWithDuplicateKeyRejection } from '../roster/canonical.ts';
import { parseCanonicalPreRunSelectionBytes } from '../roster/run-selection.ts';

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

function json(bytes: Uint8Array, label: string): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch (error) { throw new CoordinationRuntimeError('invalid-state', `${label} is not valid UTF-8 JSON`, [error instanceof Error ? error.message : String(error)]); }
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
export function verifyLaunchManifestAgainstClone(manifest: D65LaunchManifest, options: { readonly loadedManifestSha256?: `sha256:${string}` | undefined; readonly env?: ProcessEnvLike | undefined } = {}): void {
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
  // The overlay commit/tree must equal the sealed values and the launch seal.
  const overlayTree = gitText(repoRoot, { kind: 'resolve-tree', revision: manifest.bootstrap_overlay.overlay_commit }, 'overlay tree');
  if (overlayTree !== manifest.bootstrap_overlay.overlay_tree) throw new CoordinationRuntimeError('invalid-state', 'sealed bootstrap overlay tree diverges from the committed overlay commit', [overlayTree, manifest.bootstrap_overlay.overlay_tree]);
  // The overlay's complete diff from the content result must be EXACTLY the two
  // authority paths (bootstrap.json + trust SPKI) — no other product/source path.
  const overlayDiff = new TextDecoder('utf-8', { fatal: true }).decode(runGitQuery({ cwd: repoRoot, descriptor: { kind: 'diff-paths', from: manifest.content_result_commit, to: manifest.bootstrap_overlay.overlay_commit, noRenames: true } }).stdout).split('\0').filter((entry) => entry.length > 0).sort();
  const expectedOverlayPaths = [manifest.bootstrap_overlay.bootstrap_ref, manifest.trust_anchor.trust_anchor_ref].sort();
  if (overlayDiff.length !== 2 || overlayDiff[0] !== expectedOverlayPaths[0] || overlayDiff[1] !== expectedOverlayPaths[1]) throw new CoordinationRuntimeError('invalid-state', 'sealed overlay must change exactly the bootstrap and trust authority paths', [overlayDiff.join(','), expectedOverlayPaths.join(',')]);
  // The overlay must carry EXACTLY the bootstrap + trust blobs and byte/digest/OID.
  // The sealed overlay branch ref must resolve to the exact overlay commit.
  const overlayRefCommit = gitText(repoRoot, { kind: 'resolve-commit', revision: manifest.bootstrap_overlay.overlay_ref }, 'overlay ref commit');
  if (overlayRefCommit !== manifest.bootstrap_overlay.overlay_commit) throw new CoordinationRuntimeError('invalid-state', 'sealed overlay ref does not resolve to the sealed overlay commit', [overlayRefCommit, manifest.bootstrap_overlay.overlay_commit]);
  const bootstrapBlob = readD65OverlayBlob(repoRoot, manifest.bootstrap_overlay.overlay_commit, manifest.bootstrap_overlay.bootstrap_ref);
  if (bootstrapBlob.bytes.byteLength !== manifest.bootstrap_overlay.bootstrap_byte_count) throw new CoordinationRuntimeError('invalid-state', 'sealed bootstrap byte_count diverges from the committed overlay blob');
  if (bytesSha256(bootstrapBlob.bytes) !== manifest.bootstrap_overlay.bootstrap_sha256) throw new CoordinationRuntimeError('invalid-state', 'sealed bootstrap digest diverges from the committed overlay blob');
  // The committed bootstrap envelope's own identity must byte-match the manifest
  // (nonce, timestamp, content/package facts, run/resource, trust binding).
  const bootstrapEnvelope = parseD65SemanticGraphBootstrap(json(bootstrapBlob.bytes, 'committed bootstrap envelope'));
  if (bootstrapEnvelope.program_id !== manifest.program_id || bootstrapEnvelope.repo_id !== manifest.repo_id || bootstrapEnvelope.workstream !== manifest.workstream || bootstrapEnvelope.workstream_run !== manifest.workstream_run || bootstrapEnvelope.autopilot_id !== manifest.autopilot_id) throw new CoordinationRuntimeError('invalid-state', 'committed bootstrap envelope identity diverges from the sealed manifest');
  if (bootstrapEnvelope.run_timestamp !== manifest.run_timestamp || bootstrapEnvelope.run_nonce !== manifest.run_nonce) throw new CoordinationRuntimeError('invalid-state', 'committed bootstrap envelope run timestamp/nonce diverges from the sealed manifest', [bootstrapEnvelope.run_timestamp, manifest.run_timestamp, bootstrapEnvelope.run_nonce, manifest.run_nonce]);
  if (bootstrapEnvelope.content_commit !== manifest.content_result_commit || bootstrapEnvelope.content_tree !== manifest.content_result_tree || bootstrapEnvelope.package_commit !== manifest.package_commit || bootstrapEnvelope.package_tree !== manifest.package_tree) throw new CoordinationRuntimeError('invalid-state', 'committed bootstrap envelope content/package facts diverge from the sealed manifest');
  if (bootstrapEnvelope.trust_anchor_ref !== manifest.trust_anchor.trust_anchor_ref || bootstrapEnvelope.trust_anchor_sha256 !== manifest.trust_anchor.trust_anchor_sha256) throw new CoordinationRuntimeError('invalid-state', 'committed bootstrap envelope trust binding diverges from the sealed manifest');
  if (canonicalJson(bootstrapEnvelope.prospective_run) !== canonicalJson(manifest.prospective_run) || canonicalJson(bootstrapEnvelope.prospective_resource) !== canonicalJson(manifest.prospective_resource)) throw new CoordinationRuntimeError('invalid-state', 'committed bootstrap envelope prospective rows diverge from the sealed manifest');
  const trustBlob = readD65OverlayBlob(repoRoot, manifest.bootstrap_overlay.overlay_commit, manifest.trust_anchor.trust_anchor_ref);
  if (trustBlob.bytes.byteLength !== 44) throw new CoordinationRuntimeError('invalid-state', 'sealed trust anchor must be exactly 44 SPKI bytes in the committed overlay');
  if (bytesSha256(trustBlob.bytes) !== manifest.trust_anchor.trust_anchor_sha256) throw new CoordinationRuntimeError('invalid-state', 'sealed trust anchor digest diverges from the committed overlay blob');
  if (trustBlob.oid !== manifest.trust_anchor.trust_anchor_blob_oid) throw new CoordinationRuntimeError('invalid-state', 'sealed trust anchor blob OID diverges from the committed overlay blob', [trustBlob.oid, manifest.trust_anchor.trust_anchor_blob_oid]);
  // Cross-bind the sealed idempotency keys to the exact frozen forms so a
  // divergent manifest cannot silently reuse another run's attach/registration.
  if (manifest.attach_run_idempotency_key !== `attach-run:${manifest.repo_id}:${manifest.workstream_run}`) throw new CoordinationRuntimeError('invalid-state', 'sealed attach-run idempotency key is not the exact frozen form');
  if (manifest.attach_session_idempotency_key !== `attach-session:${manifest.repo_id}:${manifest.workstream_run}`) throw new CoordinationRuntimeError('invalid-state', 'sealed attach-session idempotency key is not the exact frozen form');
  if (manifest.policy_candidate.registration_idempotency_key !== `register-launch-policy:${manifest.workstream_run}:${manifest.policy_candidate.policy_id}`) throw new CoordinationRuntimeError('invalid-state', 'sealed policy registration idempotency key is not the exact frozen form');
  // Note: there is deliberately NO sealed heartbeat-acceptance idempotency key.
  // The store's accept-program-heartbeat key is a content-bound RFC-8785 identity
  // digest derived from the exact signed heartbeat bytes (see
  // acceptInitialGoverningHeartbeat); a sealed logical key could never equal it.
  // The sealed launch-audit, launch-seal, and bootstrap-projection evidence must
  // exist with the exact sealed digests (immutable external launch-audit
  // authority). The launch seal is consumed/verified against its real immutable
  // bytes rather than left decorative.
  requireSealedEvidence(manifest.launch_seal.launch_audit_ref, manifest.launch_seal.launch_audit_sha256, 'launch audit');
  requireSealedEvidence(manifest.launch_seal.launch_seal_ref, manifest.launch_seal.launch_seal_sha256, 'launch seal');
  requireSealedEvidence(manifest.launch_seal.bootstrap_projection_ref, manifest.launch_seal.bootstrap_projection_sha256, 'bootstrap projection');
  // The program evidence root must be a real mode-0700 directory whose canonical
  // realpath equals the sealed path (no alias/symlink authority substitution).
  const evidenceStat = lstatSync(manifest.program_evidence_root);
  if (!evidenceStat.isDirectory() || (evidenceStat.mode & 0o777) !== 0o700) throw new CoordinationRuntimeError('invalid-state', 'sealed program_evidence_root must be a mode-0700 directory', [manifest.program_evidence_root]);
  if (realpathSync(manifest.program_evidence_root) !== manifest.program_evidence_root) throw new CoordinationRuntimeError('invalid-state', 'sealed program_evidence_root is not its own canonical real path', [manifest.program_evidence_root]);
  // Bind the declared state/session/runtime roots to the ACTUAL coordinator/Pi
  // paths: the coordinator that this launch env reaches must resolve to the
  // sealed state root, its sessions root must live under it, and the session
  // root, state root, and main-worktree runtime root must be alias-distinct.
  requireCoordinatorPathBinding(manifest, options.env ?? process.env);
  // Bind the exact loaded manifest bytes digest into private launch evidence so
  // a restart proves the same manifest (never a decorative discarded digest).
  if (options.loadedManifestSha256 !== undefined) persistD65LaunchManifestReceipt(manifest, options.loadedManifestSha256);
}

/**
 * Prove the sealed state/session/runtime paths equal the ACTUAL coordinator/Pi
 * runtime paths this launch env reaches, and that the roots are alias-distinct.
 * A launch whose declared state root does not equal the coordinator's resolved
 * state root could mutate a different coordinator than the sealed one.
 */
function requireCoordinatorPathBinding(manifest: D65LaunchManifest, env: ProcessEnvLike): void {
  const paths = coordinatorRuntimePaths({ ...env, [AUTOPILOT_STATE_ROOT_ENV]: manifest.state_root });
  if (paths.stateRoot !== manifest.state_root) throw new CoordinationRuntimeError('invalid-state', 'coordinator state root does not equal the sealed manifest state_root', [paths.stateRoot, manifest.state_root]);
  const withSep = (root: string): string => (root.endsWith('/') ? root : `${root}/`);
  const isInside = (child: string, parent: string): boolean => child === parent || child.startsWith(withSep(parent));
  // The coordinator sessions root lives under the sealed state root (the state
  // root owns coordinator/session authority; the runtime root is the main
  // worktree's `.pi/autopilot/<workstream>` which is also under the state root by
  // design). The SEPARATE Pi session root, however, must be authority-distinct
  // from the coordinator state root (per the plan's authority-distinct roots).
  if (!isInside(paths.sessionsRoot, manifest.state_root)) throw new CoordinationRuntimeError('invalid-state', 'coordinator sessions root is not inside the sealed state root', [paths.sessionsRoot, manifest.state_root]);
  if (isInside(manifest.state_root, manifest.session_root) || isInside(manifest.session_root, manifest.state_root)) throw new CoordinationRuntimeError('invalid-state', 'sealed Pi session root must be authority-distinct from the coordinator state root', [manifest.state_root, manifest.session_root]);
}

const D65_LAUNCH_MANIFEST_RECEIPT_SCHEMA = 'autopilot.d65_launch_manifest_receipt.v1' as const;

/**
 * Persist (create-only, idempotent) the exact loaded manifest bytes digest into
 * private launch evidence so a restart proves it consumed the SAME manifest. A
 * divergent digest for the same run rejects loudly — a launch cannot silently
 * swap the sealed manifest between attempts.
 */
function persistD65LaunchManifestReceipt(manifest: D65LaunchManifest, loadedManifestSha256: `sha256:${string}`): void {
  const receiptPath = join(manifest.program_evidence_root, 'launch-manifest-receipts', `${manifest.workstream_run}.json`);
  const record = {
    schema_version: D65_LAUNCH_MANIFEST_RECEIPT_SCHEMA,
    program_id: manifest.program_id,
    workstream_run: manifest.workstream_run,
    manifest_id: manifest.manifest_id,
    manifest_sha256: loadedManifestSha256,
    launch_seal_sha256: manifest.launch_seal.launch_seal_sha256,
    roster_sha256: manifest.roster_sha256,
  };
  const bytes = new TextEncoder().encode(`${canonicalJson(record)}\n`);
  if (existsSync(receiptPath)) {
    const existing = readImmutableFileBytes({ path: receiptPath, maximumBytes: 65_536, label: 'D65 launch manifest receipt', errorCode: 'invalid-state' });
    if (bytesSha256(existing) !== bytesSha256(bytes)) throw new CoordinationRuntimeError('invalid-state', 'a divergent launch-manifest receipt already exists for this run; the sealed manifest cannot be swapped between attempts', [receiptPath]);
    return;
  }
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  const temporary = `${receiptPath}.tmp-${String(process.pid)}-${randomBytes(6).toString('hex')}`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, receiptPath);
}

/** Verify a sealed external evidence file exists as a bounded regular file with the exact digest. */
function requireSealedEvidence(absolutePath: string, expectedSha256: `sha256:${string}`, label: string): void {
  const bytes = readImmutableFileBytes({ path: absolutePath, maximumBytes: 8_388_608, label: `sealed ${label}`, errorCode: 'invalid-state' });
  if (bytesSha256(bytes) !== expectedSha256) throw new CoordinationRuntimeError('invalid-state', `sealed ${label} bytes diverge from the sealed digest`, [absolutePath]);
}

function readD65OverlayBlob(repoRoot: string, commit: string, path: string): { readonly bytes: Uint8Array; readonly oid: string } {
  const listing = new TextDecoder('utf-8', { fatal: true }).decode(runGitQuery({ cwd: repoRoot, descriptor: { kind: 'ls-tree-path', revision: commit, path } }).stdout).split('\0').filter((entry) => entry.length > 0);
  if (listing.length !== 1) throw new CoordinationRuntimeError('invalid-state', 'sealed overlay path did not resolve to exactly one tracked blob', [path]);
  const match = /^([0-7]{6}) (blob) ([a-f0-9]{40})\t/u.exec(listing[0] ?? '');
  if (match === null || match[1] !== '100644' || match[3] === undefined) throw new CoordinationRuntimeError('invalid-state', 'sealed overlay entry must be a mode-100644 blob', [path, listing[0] ?? '']);
  return { bytes: runGitQuery({ cwd: repoRoot, descriptor: { kind: 'show-file', revision: commit, path } }).stdout, oid: match[3] };
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
  readonly loadedManifestSha256?: `sha256:${string}` | undefined;
}): Promise<D65LaunchBootstrapResult> {
  const { manifest } = input;
  verifyLaunchManifestAgainstClone(manifest, { loadedManifestSha256: input.loadedManifestSha256, env: input.env });
  const env = launchEnv(manifest, input.env);
  const repo = repoIdentityFromLaunchManifest(manifest);
  const active = activeRowFromLaunchManifest(manifest);
  const supervisor = new DurableRunSupervisorClient(env);
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
  const sagaEnv: ProcessEnvLike = { ...env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
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

/**
 * Bind the sealed isolated state root into the environment so every coordinator
 * interaction targets the manifest's exact private state root, never an ambient
 * `AUTOPILOT_STATE_ROOT`. This makes the launch reproducible regardless of the
 * operator's shell environment.
 */
export function launchEnv(manifest: D65LaunchManifest, env: ProcessEnvLike): ProcessEnvLike {
  return { ...env, [AUTOPILOT_STATE_ROOT_ENV]: manifest.state_root };
}

/**
 * Authenticate the sealed roster/selection bytes and derive the EXACT parent
 * model/thinking from those authenticated bytes (fresh plan §2.4). This is the
 * single authority for the parent model: the launcher must select this exact
 * model before any parent-model call so the bootstrap-plan turn cannot run on an
 * ambient (possibly paid) model. Fails closed on any divergence.
 */
export function activateD65RuntimeRosterFromManifest(input: {
  readonly manifest: D65LaunchManifest;
  readonly env: ProcessEnvLike;
}): { readonly model: string; readonly thinking: 'high' | 'xhigh' } {
  const authenticated = authenticateD65LaunchRoster(input.manifest);
  return authenticated.parent;
}

/**
 * Publish the authenticated runtime roster authority before graph 2 so the
 * ordinary unit-spec-v2 child path can author authenticated specs from it. Two
 * publications, both create-only atomic and idempotent:
 *   1. the external `autopilot.pre_run_selection.v1` bytes into the isolated
 *      state root at `roster-selections/<repo_id>/<workstream_run>.json`, plus
 *      the `autopilot.roster.v1` authority at `rosters/<id>/revision-N.json`;
 *   2. the runtime mirror snapshot at
 *      `<main_worktree>/.pi/autopilot/<workstream>/roster-snapshot.json`.
 * The runtime mirror is inside the runtime prefix but is NOT one of the five
 * charter files and is not staged by the policy or first-graph commits, so it
 * cannot dirty either commit. Proven by a real first-child preflight recovery.
 */
export async function publishD65RuntimeRosterSnapshot(input: {
  readonly manifest: D65LaunchManifest;
  readonly env: ProcessEnvLike;
}): Promise<void> {
  const { manifest } = input;
  const authenticated = authenticateD65LaunchRoster(manifest);
  // 1a. Publish the external pre-run selection into the isolated state root.
  const paths = resolveRosterScopePaths({ scope: 'user', stateRoot: manifest.state_root });
  const selection = parseCanonicalPreRunSelectionBytes(authenticated.selectionBytes);
  const selectionPath = preRunSelectionPath(paths, { repo_id: manifest.repo_id, workstream_run: manifest.workstream_run });
  await ensurePrivateDirectory(dirname(selectionPath), paths.userStateRoot);
  const selectionPublish = await publishCreateOnlyAtomic({ path: selectionPath, authorityRoot: paths.userStateRoot, bytes: authenticated.selectionBytes });
  if (selectionPublish.status === 'conflict') throw new CoordinationRuntimeError('invalid-state', 'a divergent external pre-run selection already exists for the sealed run', [selectionPath]);
  // 1b. Publish the roster authority revision bytes.
  const roster = parseAutopilotRoster(parseRosterJsonWithDuplicateKeyRejection(new TextDecoder('utf-8', { fatal: true }).decode(authenticated.rosterBytes)));
  const rosterPath = rosterRevisionPath(paths, { roster_id: roster.roster_id, roster_revision: roster.roster_revision });
  await ensurePrivateDirectory(dirname(rosterPath), paths.authorityRoot);
  const rosterPublish = await publishCreateOnlyAtomic({ path: rosterPath, authorityRoot: paths.authorityRoot, bytes: authenticated.rosterBytes });
  if (rosterPublish.status === 'conflict') throw new CoordinationRuntimeError('invalid-state', 'a divergent roster authority revision already exists for the sealed run', [rosterPath]);
  // 2. Publish the runtime mirror snapshot (from the exact selection bytes).
  const snapshot = await publishRuntimeRosterSnapshot({
    mainWorktreeRoot: manifest.main_worktree_path,
    workstream: manifest.workstream,
    selection_bytes: authenticated.selectionBytes,
    expected_selection_sha256: selection.selection_sha256 as RosterSha256,
  });
  if (!snapshot.ok) throw new CoordinationRuntimeError('invalid-state', 'D65 runtime roster snapshot publication failed closed', snapshot.diagnostics.map((diagnostic) => diagnostic.code));
}

/**
 * Stage 3: the full-tree main worktree created from content_result_commit. The
 * checkout profile snapshot and task-info tuple are produced by the EXACT same
 * production resolver `createNewWorkstream` uses (`resolveAutopilotCheckoutProfile`
 * + `checkoutProfileSnapshotFromResolved`), forced to a full checkout, so the
 * frozen `readCheckoutProfileSnapshot`/task-info contracts accept them and the
 * ordinary child materialization/disk-gate paths are viable.
 */
async function createD65MainWorktree(input: { readonly manifest: D65LaunchManifest; readonly active: ActiveAutopilotRow; readonly repo: AutopilotRepoIdentity; readonly env: ProcessEnvLike }): Promise<void> {
  const { manifest } = input;
  const mainWorktreePath = manifest.main_worktree_path;
  const taskRoot = dirname(mainWorktreePath);
  const runtimeRoot = manifest.runtime_root;
  const branch = manifest.run_branch;
  const now = new Date(manifest.run_timestamp);
  const checkoutProfile = await resolveAutopilotFullCheckoutProfile({ repoRoot: manifest.canonical_root, env: input.env, now });
  const profileSnapshot = checkoutProfileSnapshotFromResolved({ resolved: checkoutProfile, now });
  const taskInfo: AutopilotTaskInfo = {
    schema_version: 'autopilot.task_info.v2', coordination_authority: 'coordinator-edit-leases-v1',
    workstream: manifest.workstream, workstream_run: manifest.workstream_run, autopilot_id: manifest.autopilot_id,
    source_repo: manifest.canonical_root, git_common_dir: manifest.git_common_dir, repo_key: manifest.repo_key,
    base_sha: manifest.content_result_commit, branch, worktree_path: mainWorktreePath, runtime_root: runtimeRoot,
    target_branch: manifest.target_branch, target_base_sha: manifest.content_result_commit,
    started_at: manifest.run_timestamp, closed_at: null, status: 'active', checkout_mode: 'full',
    checkout_profile_ref: AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE,
    checkout_profile_sha256: checkoutProfile.profile_sha256, checkout_profile_origin: checkoutProfile.origin,
  };
  const branches: AutopilotBranchesInfo = { schema_version: 'autopilot.branches.v1', active_branch: branch, base_sha: manifest.content_result_commit, current_sha: manifest.content_result_commit, archive_ref: null, unit_branches: [] };
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
      await writeJsonAtomic(join(taskRoot, AUTOPILOT_CHECKOUT_PROFILE_SNAPSHOT_FILE), profileSnapshot);
      await writeJsonAtomic(join(taskRoot, TASK_INFO_FILE), taskInfo);
      await writeJsonAtomic(join(taskRoot, BRANCHES_FILE), branches);
      await writeJsonAtomic(join(taskRoot, UNIT_INDEX_FILE), { schema_version: 'autopilot.unit_index.v1', units: [] });
      // Mark the untracked-neutral runtime roster-snapshot mirror as excluded so
      // it never dirties the policy or first-graph commits (design §4): the
      // roster snapshot is a mirror of the sealed selection, not committed
      // authority, and the first-graph validator requires an exactly-clean
      // worktree postimage. The five charter roots remain tracked/committed.
      excludeD65RuntimeRosterSnapshot(manifest, input.env);
    },
  }, input.env);
  await mkdir(runtimeRoot, { recursive: true });
}

/**
 * Add the untracked-neutral runtime roster-snapshot mirror to the worktree's
 * worktree-local `info/exclude` so it never appears as an untracked change. This
 * is a per-worktree, non-committed exclusion (never a tracked `.gitignore`), so
 * it cannot alter the committed tree. Idempotent: the exact line is added once.
 */
function excludeD65RuntimeRosterSnapshot(manifest: D65LaunchManifest, env: ProcessEnvLike): void {
  const mainRoot = manifest.main_worktree_path;
  const runtimePrefix = manifest.runtime_root.startsWith(`${mainRoot}/`) ? manifest.runtime_root.slice(mainRoot.length + 1) : null;
  if (runtimePrefix === null) throw new CoordinationRuntimeError('invalid-state', 'runtime root is not a descendant of the main worktree');
  const excludePattern = `/${runtimePrefix}/roster-snapshot.json`;
  const excludeRelative = new TextDecoder('utf-8', { fatal: true }).decode(runGitQuery({ cwd: mainRoot, descriptor: { kind: 'git-path', name: 'info/exclude' } }).stdout).trim();
  if (excludeRelative.length === 0) throw new CoordinationRuntimeError('invalid-state', 'could not resolve the worktree-local git exclude path');
  const excludePath = isAbsolute(excludeRelative) ? excludeRelative : join(mainRoot, excludeRelative);
  const existing = existsSync(excludePath) ? new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(excludePath)) : '';
  const lines = existing.split('\n');
  if (lines.includes(excludePattern)) return;
  mkdirSync(dirname(excludePath), { recursive: true });
  const next = existing.length === 0 || existing.endsWith('\n') ? `${existing}${excludePattern}\n` : `${existing}\n${excludePattern}\n`;
  writeFileSync(excludePath, next);
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
  const env: ProcessEnvLike = { ...launchEnv(manifest, input.env), [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
  const client = new CoordinatorClient({ env });
  const session = await readCoordinatorSessionContext(attachment.contextPath);

  const policyArtifactId = `launch-policy:${manifest.workstream_run}:${manifest.policy_candidate.policy_id}`;
  const status = await client.query('status', session.repo_id, session.workstream_run);
  const artifacts = requireArtifacts(status.payload);
  const acceptedPolicy = artifacts.find((artifact) => artifact.document_schema_version === 'autopilot.launch_policy.v1');
  if (acceptedPolicy !== undefined) {
    // Idempotent replay: an already-accepted policy MUST be the exact sealed
    // identity/ref/digest — a divergent accepted policy is never silently adopted.
    if (acceptedPolicy.artifact_id !== policyArtifactId || acceptedPolicy.evidence.ref !== manifest.policy_candidate.policy_ref || acceptedPolicy.evidence.sha256 !== manifest.policy_candidate.policy_sha256) throw new CoordinationRuntimeError('invalid-state', 'accepted launch policy differs from the sealed manifest policy identity/ref/digest', [acceptedPolicy.artifact_id, acceptedPolicy.evidence.ref, acceptedPolicy.evidence.sha256]);
  } else {
    // Discover the durable stage: the policy may already be COMMITTED at run-main
    // HEAD (crash after commit, before registration). Reuse that exact one-parent
    // commit byte-for-byte instead of re-committing (which would be a no-change
    // `git commit` failure). Otherwise sign + commit the sealed policy.
    const head = gitText(manifest.main_worktree_path, { kind: 'head' }, 'policy stage HEAD');
    const committed = runGitQuery({ cwd: manifest.main_worktree_path, descriptor: { kind: 'show-file', revision: head, path: manifest.policy_candidate.policy_ref, allowAbsent: true } });
    const alreadyCommitted = !committed.negative && bytesSha256(committed.stdout) === manifest.policy_candidate.policy_sha256;
    if (!alreadyCommitted) {
      // Ask the external signer to produce the exact signed policy candidate.
      const signed = await input.signer.signLaunchPolicy({
        kind: 'launch-policy', state_root: manifest.state_root, repo_id: manifest.repo_id, workstream_run: manifest.workstream_run,
        policy_id: manifest.policy_candidate.policy_id, policy_ref: manifest.policy_candidate.policy_ref, expected_policy_sha256: manifest.policy_candidate.policy_sha256,
      });
      if (signed.sha256 !== manifest.policy_candidate.policy_sha256) throw new CoordinationRuntimeError('invalid-state', 'signed launch policy digest differs from the sealed manifest policy digest', [signed.sha256, manifest.policy_candidate.policy_sha256]);
      // Commit the signed policy at the exact previously-absent policy path with a
      // sole parent = content_result_commit (run-main HEAD is content result at
      // this stage). The store re-verifies sole-parent/one-path at registration.
      await commitD65PolicyBlob({ manifest, signedAbsolutePath: signed.absolute_path, env });
    }
    const policyHead = gitText(manifest.main_worktree_path, { kind: 'head' }, 'policy commit HEAD');
    const run = requireOneRun(status.payload);
    const response = await client.mutate('register-authoritative-artifact', {
      repoId: session.repo_id, workstreamRun: session.workstream_run, sessionId: session.session_id,
      fencingGeneration: session.session_generation, expectedVersion: run.version, idempotencyKey: manifest.policy_candidate.registration_idempotency_key,
    }, {
      artifact_id: policyArtifactId, source_type: 'task', source_scope: 'run-main',
      document_schema_version: 'autopilot.launch_policy.v1', git_commit: policyHead, ref: manifest.policy_candidate.policy_ref, sha256: manifest.policy_candidate.policy_sha256,
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
  const signedBytes = readImmutableFileBytes({ path: input.signedAbsolutePath, maximumBytes: 1_048_576, label: 'signed launch policy candidate', errorCode: 'invalid-state' });
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
  const env: ProcessEnvLike = { ...launchEnv(input.manifest, input.env), [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: input.attachment.contextPath };
  // Idempotency: the heartbeat chain is strictly monotonic. If the accepted head
  // sequence is already >= the requested sequence, that sequence was already
  // accepted — skip producing/accepting a new candidate. This is the exact fix
  // for "an accepted later heartbeat must never cause a request for sequence 1":
  // a restart after graph+heartbeat 2 (head sequence 2) must NOT re-request the
  // sealed sequence-1 candidate, which the signer would correctly reject.
  const client = new CoordinatorClient({ env });
  const session = await readCoordinatorSessionContext(input.attachment.contextPath);
  const status = await client.query('status', session.repo_id, session.workstream_run);
  const head = status.payload['accepted_program_heartbeat'];
  const acceptedSequenceRaw = typeof head === 'object' && head !== null ? (head as Record<string, unknown>)['sequence'] : null;
  const acceptedSequence = typeof acceptedSequenceRaw === 'number' && Number.isSafeInteger(acceptedSequenceRaw) ? acceptedSequenceRaw : null;
  const alreadyAccepted = acceptedSequence !== null && acceptedSequence >= input.heartbeatSequence;
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
  // The store's accept-program-heartbeat idempotency key is a CONTENT-BOUND
  // RFC-8785 identity digest over (repo/run/sequence/heartbeat-digest/kind) — NOT
  // a sealed logical key (a sealed key could never equal it because the heartbeat
  // digest is only known after signing). The store re-derives and re-checks this
  // exact key inside the mutation, so a replay with the same signed bytes is
  // idempotent and a different attempt/digest is rejected.
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
  if ((before.mode & 0o777) !== 0o600) throw new CoordinationRuntimeError('invalid-state', 'initial heartbeat candidate must be mode 0600', [path]);
  // Descriptor-safe no-follow read with inode-size-link identity checks.
  return readImmutableFileBytes({ path, maximumBytes: 1_048_576, label: 'initial heartbeat candidate', errorCode: 'invalid-state' });
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
  const env: ProcessEnvLike = { ...launchEnv(input.manifest, input.env), [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: input.attachment.contextPath };
  const client = new CoordinatorClient({ env });
  const session = await readCoordinatorSessionContext(input.attachment.contextPath);
  const status = await client.query('status', session.repo_id, session.workstream_run);
  const artifacts = requireArtifacts(status.payload);
  const existingGraph = artifacts.find((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1');
  // Bind the successful context_budget call receipt into graph authority: a
  // bootstrap turn that never called context_budget cannot advance to graph 2.
  if (existingGraph === undefined) requireD65ContextBudgetReceipt(input.manifest, session.session_id);
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

/**
 * The exact durable launch phase, derived from coordinator + Git authority
 * BEFORE any signature request or parent-model call. This is the single
 * authority that decides what the launcher must do next after a crash/response-
 * loss at any boundary. Every value is computed from exact durable state, never
 * from in-memory `pendingD65Launch` (which is cleared on shutdown).
 *
 *   - `attach-required`        : no run yet; attach-run(bootstrap_graph) + one
 *                                session + full-tree main worktree.
 *   - `policy-required`        : run+session+worktree exist, but the launch
 *                                policy is not yet accepted (may be committed).
 *   - `initial-heartbeat-required`: policy accepted, initial governing heartbeat
 *                                (sequence 1) not yet accepted.
 *   - `bootstrap-plan-required`: policy + initial heartbeat accepted, charter
 *                                roots not yet written — deliver the bootstrap-
 *                                plan-only turn (no graph exists yet).
 *   - `first-graph-required`   : charter roots complete, first complete graph
 *                                (sequence 2) not yet published/registered.
 *   - `successor-heartbeat-required`: graph 2 registered, governing heartbeat 2
 *                                not yet accepted — accept only the missing
 *                                heartbeat.
 *   - `ordinary`               : graph 2 + heartbeat 2 accepted — adopt the one
 *                                session and dispatch only ordinary work.
 */
export type D65LaunchPhaseKind =
  | 'attach-required'
  | 'policy-required'
  | 'initial-heartbeat-required'
  | 'bootstrap-plan-required'
  | 'first-graph-required'
  | 'successor-heartbeat-required'
  | 'ordinary';

export interface D65LaunchPhase {
  readonly kind: D65LaunchPhaseKind;
  /** The accepted first-complete-graph (sequence 2) digest, when it exists. */
  readonly graphSha256: `sha256:${string}` | null;
  /** The accepted governing heartbeat head sequence (null when none). */
  readonly acceptedHeartbeatSequence: number | null;
}

/**
 * Resolve the exact durable launch phase from coordinator + Git authority. It
 * validates that the observed authority is internally coherent (exactly one
 * run/session/worktree/bootstrap artifact, exact graph identity/schema/sequence/
 * digest), and fails closed on any divergent or ambiguous authority. It NEVER
 * mutates and NEVER calls a model/signer; the caller uses the returned phase to
 * drive exactly the next missing boundary.
 */
export async function resolveD65LaunchPhase(input: {
  readonly manifest: D65LaunchManifest;
  readonly env: ProcessEnvLike;
}): Promise<D65LaunchPhase> {
  const { manifest } = input;
  const env = launchEnv(manifest, input.env);
  const client = new CoordinatorClient({ env });
  // Before any run exists, the coordinator repository is absent — attach.
  const catalog = await client.query('run-catalog', manifest.repo_id, manifest.workstream_run);
  const catalogRuns = catalog.payload['runs'];
  if (!Array.isArray(catalogRuns) || catalogRuns.length === 0) {
    return Object.freeze({ kind: 'attach-required', graphSha256: null, acceptedHeartbeatSequence: null });
  }
  if (catalogRuns.length !== 1) throw new CoordinationRuntimeError('invalid-state', 'D65 launch phase resolution found more than one durable run for the sealed identity');
  const status = await client.query('status', manifest.repo_id, manifest.workstream_run);
  const run = requireOneRun(status.payload);
  if (run.autopilot_id !== manifest.autopilot_id || run.workstream !== manifest.workstream || run.workstream_run !== manifest.workstream_run || run.coordination_authority !== manifest.coordination_authority) {
    throw new CoordinationRuntimeError('invalid-state', 'durable run identity diverges from the sealed manifest', [run.autopilot_id, run.workstream_run]);
  }
  const artifacts = requireArtifacts(status.payload);
  // The deterministic bootstrap artifact must exist and be unambiguous.
  const bootstrapId = `semantic-graph-bootstrap:${manifest.workstream_run}`;
  const bootstraps = artifacts.filter((artifact) => artifact.artifact_id === bootstrapId && artifact.document_schema_version === 'autopilot.semantic_graph_bootstrap.v1');
  if (bootstraps.length !== 1) throw new CoordinationRuntimeError('invalid-state', 'D65 launch phase requires exactly one accepted bootstrap artifact', [String(bootstraps.length)]);

  // Exactly one attached generation-1 dispatch session must exist (the single
  // bootstrap session). Zero/many is ambiguous authority — fail closed.
  const sessions = requireSessionLeases(status.payload);
  const attached = sessions.filter((session) => session.status === 'attached' && session.attachment_kind === 'dispatch' && session.session_generation === run.active_session_generation);
  if (run.active_session_generation !== 1 || attached.length !== 1) {
    // The attach-run receipt exists but the single generation-1 session is not
    // yet present/coherent — the attach stage must (idempotently) complete it.
    return Object.freeze({ kind: 'attach-required', graphSha256: null, acceptedHeartbeatSequence: null });
  }

  // The policy artifact: an accepted policy must be the EXACT sealed identity.
  const policyArtifactId = `launch-policy:${manifest.workstream_run}:${manifest.policy_candidate.policy_id}`;
  const policies = artifacts.filter((artifact) => artifact.document_schema_version === 'autopilot.launch_policy.v1');
  if (policies.length > 1) throw new CoordinationRuntimeError('invalid-state', 'D65 launch phase found more than one accepted launch policy');
  const policy = policies[0];
  if (policy !== undefined && (policy.artifact_id !== policyArtifactId || policy.evidence.ref !== manifest.policy_candidate.policy_ref || policy.evidence.sha256 !== manifest.policy_candidate.policy_sha256)) {
    throw new CoordinationRuntimeError('invalid-state', 'accepted launch policy diverges from the sealed manifest identity/ref/digest', [policy.artifact_id, policy.evidence.ref, policy.evidence.sha256]);
  }

  // The first complete graph (sequence 2): validate exact artifact identity,
  // schema, sequence, and digest — not merely "some semantic graph exists".
  const graphs = artifacts.filter((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1');
  if (graphs.length > 1) throw new CoordinationRuntimeError('invalid-state', 'D65 launch phase found more than one accepted complete graph before ordinary dispatch');
  const graph = graphs[0];
  let graphSha256: `sha256:${string}` | null = null;
  if (graph !== undefined) {
    if (graph.artifact_id !== `semantic-graph:${String(2).padStart(20, '0')}`) throw new CoordinationRuntimeError('invalid-state', 'the first accepted complete graph is not exact sequence-2 artifact identity', [graph.artifact_id]);
    graphSha256 = graph.evidence.sha256;
  }

  // The accepted governing heartbeat head sequence.
  const acceptedHeartbeatSequence = acceptedHeartbeatSequenceOf(status.payload);

  if (policy === undefined) {
    return Object.freeze({ kind: 'policy-required', graphSha256: null, acceptedHeartbeatSequence });
  }
  if (acceptedHeartbeatSequence === null || acceptedHeartbeatSequence < 1) {
    return Object.freeze({ kind: 'initial-heartbeat-required', graphSha256, acceptedHeartbeatSequence });
  }
  // Charter completeness is a Git fact (the five previously-absent roots). It is
  // consulted only after the initial heartbeat exists: a restart after charter
  // creation must mechanically continue to first-graph without another planning
  // call.
  if (graph === undefined) {
    const charterComplete = detectD65CharterCompleteQuiet(manifest);
    if (!charterComplete) return Object.freeze({ kind: 'bootstrap-plan-required', graphSha256: null, acceptedHeartbeatSequence });
    return Object.freeze({ kind: 'first-graph-required', graphSha256: null, acceptedHeartbeatSequence });
  }
  if (acceptedHeartbeatSequence < 2) {
    return Object.freeze({ kind: 'successor-heartbeat-required', graphSha256, acceptedHeartbeatSequence });
  }
  return Object.freeze({ kind: 'ordinary', graphSha256, acceptedHeartbeatSequence });
}

/** The accepted governing heartbeat head sequence, or null when none exists. */
function acceptedHeartbeatSequenceOf(statusPayload: Readonly<Record<string, unknown>>): number | null {
  const head = statusPayload['accepted_program_heartbeat'];
  if (typeof head !== 'object' || head === null) return null;
  const sequence = (head as Record<string, unknown>)['sequence'];
  return typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 1 ? sequence : null;
}

function requireSessionLeases(statusPayload: Readonly<Record<string, unknown>>): ReturnType<typeof parseCoordinationSessionLease>[] {
  const value = statusPayload['session_leases'];
  if (!Array.isArray(value)) throw new CoordinationRuntimeError('invalid-state', 'D65 launch status lacks the session-lease projection');
  return value.map(parseCoordinationSessionLease);
}

/**
 * Charter-completeness probe that does NOT throw a scope violation: it returns
 * false when the five roots are absent and re-uses the exact scope-fence
 * detector once they are present (which DOES throw on an out-of-scope effect).
 * Used by the phase resolver, where a not-yet-written charter is a normal
 * intermediate state rather than an error.
 */
function detectD65CharterCompleteQuiet(manifest: D65LaunchManifest): boolean {
  for (const root of D65_CHARTER_ROOTS) {
    if (!existsSync(join(manifest.runtime_root, root))) return false;
  }
  return detectD65CharterComplete(manifest);
}

/** The exact five previously-absent charter roots the bootstrap turn writes. */
export const D65_CHARTER_ROOTS = Object.freeze(['mission.md', 'master-plan.json', 'state.json', 'decision-log.jsonl', 'events.jsonl'] as const);

const D65_CONTEXT_BUDGET_RECEIPT_SCHEMA = 'autopilot.d65_context_budget_receipt.v1' as const;

/** The durable path of the bootstrap-turn context_budget call receipt. */
export function d65ContextBudgetReceiptPath(manifest: D65LaunchManifest): string {
  return join(manifest.program_evidence_root, 'context-budget-receipts', `${manifest.workstream_run}.json`);
}

/** Exact successful tool-call evidence sealed before graph-2 publication. */
export interface D65ContextBudgetReceiptInput {
  readonly gate: string;
  readonly percent: number | null;
  readonly tool_call_id: string;
  readonly session_id: string;
}

const D65_CONTEXT_BUDGET_RECEIPT_FIELDS = Object.freeze([
  'schema_version', 'program_id', 'workstream_run', 'gate', 'percent', 'tool_call_id', 'session_id',
] as const);
const D65_CONTEXT_BUDGET_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const D65_CONTEXT_BUDGET_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

/**
 * Persist a durable receipt proving the bootstrap parent successfully CALLED
 * `context_budget` and received `gate:"ok"` in the exact durable D65 session.
 * Halt/unknown/unbounded reports reject before any create-only replay check, so
 * they can never be converted into positive launch authority by a stale file.
 */
export function writeD65ContextBudgetReceipt(manifest: D65LaunchManifest, report: D65ContextBudgetReceiptInput): void {
  if (report.gate !== 'ok') throw new CoordinationRuntimeError('invalid-state', 'D65 bootstrap context_budget gate is not ok; first-graph publication remains fenced', [report.gate]);
  if (report.percent === null || !Number.isFinite(report.percent) || report.percent < 0 || report.percent > 100) throw new CoordinationRuntimeError('invalid-state', 'D65 bootstrap context_budget percent must be a finite number in [0,100]');
  if (!D65_CONTEXT_BUDGET_CALL_ID.test(report.tool_call_id)) throw new CoordinationRuntimeError('invalid-state', 'D65 bootstrap context_budget tool_call_id is not a bounded closed identifier');
  if (!D65_CONTEXT_BUDGET_SESSION_ID.test(report.session_id)) throw new CoordinationRuntimeError('invalid-state', 'D65 bootstrap context_budget session_id is not a bounded closed identifier');
  const receiptPath = d65ContextBudgetReceiptPath(manifest);
  if (existsSync(receiptPath)) return;
  const record = { schema_version: D65_CONTEXT_BUDGET_RECEIPT_SCHEMA, program_id: manifest.program_id, workstream_run: manifest.workstream_run, gate: 'ok', percent: report.percent, tool_call_id: report.tool_call_id, session_id: report.session_id };
  const bytes = new TextEncoder().encode(`${canonicalJson(record)}\n`);
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  const temporary = `${receiptPath}.tmp-${String(process.pid)}-${randomBytes(6).toString('hex')}`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, receiptPath);
}

/**
 * Require the exact successful context_budget receipt for the attached D65
 * session before the first complete graph may be published. Closed-field parsing
 * prevents a malformed or cross-session receipt from becoming launch authority.
 */
export function requireD65ContextBudgetReceipt(manifest: D65LaunchManifest, expectedSessionId: string): void {
  const receiptPath = d65ContextBudgetReceiptPath(manifest);
  if (!existsSync(receiptPath)) throw new CoordinationRuntimeError('invalid-state', 'D65 bootstrap turn did not produce a durable context_budget call receipt; first-graph publication is fenced', [receiptPath]);
  const bytes = readImmutableFileBytes({ path: receiptPath, maximumBytes: 65_536, label: 'D65 context_budget receipt', errorCode: 'invalid-state' });
  const parsed = json(bytes, 'D65 context_budget receipt');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CoordinationRuntimeError('invalid-state', 'D65 context_budget receipt is malformed or belongs to another run/session', [receiptPath]);
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...D65_CONTEXT_BUDGET_RECEIPT_FIELDS].sort();
  const exactFields = keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
  const percent = record['percent'];
  if (!exactFields || record['schema_version'] !== D65_CONTEXT_BUDGET_RECEIPT_SCHEMA || record['program_id'] !== manifest.program_id || record['workstream_run'] !== manifest.workstream_run || record['gate'] !== 'ok' || typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100 || typeof record['tool_call_id'] !== 'string' || !D65_CONTEXT_BUDGET_CALL_ID.test(record['tool_call_id']) || record['session_id'] !== expectedSessionId || !D65_CONTEXT_BUDGET_SESSION_ID.test(expectedSessionId)) throw new CoordinationRuntimeError('invalid-state', 'D65 context_budget receipt is malformed or belongs to another run/session', [receiptPath]);
}

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
  // Require the run-main worktree to have NO change (tracked, untracked, OR
  // ignored) outside the package-owned runtime prefix. The bootstrap parent may
  // only touch the ignored runtime directory (where the five charter roots and
  // its own auxiliary state live); any product/source path change — including
  // one hidden behind a .gitignore rule — is terminal scope evidence. The
  // NUL-terminated porcelain output is `XY <path>\0` per record; a rename record
  // carries an extra `\0<orig>` which we treat as its own path. `--ignored`
  // reports ignored directories with a trailing slash.
  const mainRoot = manifest.main_worktree_path;
  const records = new TextDecoder('utf-8', { fatal: true }).decode(runGitQuery({ cwd: mainRoot, descriptor: { kind: 'status-porcelain', includeIgnored: true } }).stdout).split('\0').filter((entry) => entry.length > 0);
  const runtimePrefix = manifest.runtime_root.startsWith(`${mainRoot}/`) ? manifest.runtime_root.slice(mainRoot.length + 1) : null;
  if (runtimePrefix === null) throw new CoordinationRuntimeError('invalid-state', 'runtime root is not a descendant of the main worktree');
  const runtimeDir = `${runtimePrefix}/`;
  const STATUS_CODES = new Set([' ', 'M', 'A', 'D', 'R', 'C', 'U', '?', String.fromCharCode(33)]);
  const hasStatusPrefix = (record: string): boolean => record.length >= 4 && STATUS_CODES.has(record.charAt(0)) && STATUS_CODES.has(record.charAt(1)) && record.charAt(2) === ' ';
  const withinRuntime = (path: string): boolean => path === runtimePrefix || path === runtimeDir || path.startsWith(runtimeDir);
  for (const record of records) {
    const path = hasStatusPrefix(record) ? record.slice(3) : record;
    if (!withinRuntime(path)) throw new CoordinationRuntimeError('invalid-state', 'semantic-graph-bootstrap-operation-denied: parent planning touched a path outside the package-owned runtime charter scope', [path]);
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
