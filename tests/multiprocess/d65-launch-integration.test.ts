import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { SEED_ROSTERS } from '../../src/core/roster/provider-recipes.ts';
import { canonicalRosterJson } from '../../src/core/roster/canonical.ts';
import { buildCanonicalPreRunSelection } from '../../src/core/roster/run-selection.ts';
import type { RosterSha256 } from '../../src/core/roster/paths.ts';
import { parseCoordinationAuthoritativeArtifact, parseCoordinationRun, parseCoordinationRunResource, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { encodeUnpaddedBase64Url } from '../../src/core/coordination/d65-trust.ts';
import { parseD65LaunchPolicy } from '../../src/core/coordination/d65-launch-policy.ts';
import { beginD65LaunchBootstrap, detectD65CharterComplete, publishD65FirstGraphAndSuccessorHeartbeat, registerD65LaunchPolicyAndInitialHeartbeat, writeD65ContextBudgetReceipt } from '../../src/core/coordination/d65-launch-integration.ts';
import { BUG_180_PROVIDER_TOOL_CALL_ID } from '../helpers/d65-context-budget-receipt.ts';
import { parseD65LaunchManifest, type D65LaunchManifest } from '../../src/core/coordination/d65-launch-manifest.ts';
import type { D65LaunchSigner, D65LaunchSignerHeartbeatRequest, D65LaunchSignerPolicyRequest, D65LaunchSignerResult } from '../../src/core/coordination/d65-launch-signer.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.invalid' } });
  if ((result.status ?? -1) !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/**
 * An in-test operator signer that behaves exactly like the external CLI: it
 * holds the private key, reads live coordinator status/doctor, builds canonical
 * signed policy/heartbeat bytes, and writes signed candidates to the evidence
 * path. It is NOT runtime production code — it stands in for the separate
 * operator/control-plane signer whose contract the runtime consumes.
 */
interface TestOperatorSignerInput {
  readonly privateKeyPem: string; readonly programId: string; readonly workstream: string;
  readonly trustRef: string; readonly trustSha256: `sha256:${string}`; readonly programEvidenceRoot: string;
  readonly packageCommit: string; readonly packageTree: string; readonly b0Commit: string; readonly b0Tree: string;
  readonly rosterSha256: `sha256:${string}`; readonly rosterProvider: string; readonly stateRoot: string;
}

class TestOperatorSigner implements D65LaunchSigner {
  private readonly input: TestOperatorSignerInput;
  constructor(input: TestOperatorSignerInput) { this.input = input; }

  async signLaunchPolicy(request: D65LaunchSignerPolicyRequest): Promise<D65LaunchSignerResult> {
    const client = new CoordinatorClient({ env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: request.state_root } });
    const status = await client.query('status', request.repo_id, request.workstream_run);
    const artifacts = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
    const bootstrap = artifacts.find((a) => a.artifact_id === `semantic-graph-bootstrap:${request.workstream_run}`);
    if (bootstrap === undefined) throw new Error('signer: no bootstrap artifact');
    const { createPrivateKey } = await import('node:crypto');
    const fields = {
      schema_version: 'autopilot.launch_policy.v1', program_id: this.input.programId, policy_id: request.policy_id, policy_version: 1,
      repo_id: request.repo_id, workstream_run: request.workstream_run, package_commit: this.input.packageCommit, package_tree: this.input.packageTree,
      base_commit: this.input.b0Commit, base_tree: this.input.b0Tree, bootstrap_graph_sha256: bootstrap.evidence.sha256, bootstrap_receipt_event_seq: bootstrap.registered_event_seq,
      roster_sha256: this.input.rosterSha256, parallel_cap: 1, maximum_parallel_cap: 1, expected_checkout_units: 1,
      program_evidence_root: this.input.programEvidenceRoot, trust_anchor_ref: this.input.trustRef, trust_anchor_sha256: this.input.trustSha256,
      prior_policy_sha256: null, capacity_decision_ref: null, capacity_decision_sha256: null, issued_at: '2026-07-22T22:00:34.000Z', signer_key_id: this.input.trustSha256,
    };
    const signature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, concatDomain('AUTOPILOT-D65-LAUNCH-POLICY\u0000', canonicalJson(fields)), createPrivateKey(this.input.privateKeyPem))));
    const bytes = new TextEncoder().encode(`${canonicalJson({ ...fields, signature })}\n`);
    parseD65LaunchPolicy(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    const absolutePath = join(this.input.programEvidenceRoot, 'signed-launch-policies', `${request.policy_id}.json`);
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    await writeFile(absolutePath, bytes, { mode: 0o600 });
    chmodSync(absolutePath, 0o600);
    return { ref: request.policy_ref, absolute_path: absolutePath, sha256: sha256(bytes), byte_count: bytes.byteLength };
  }

  async signProgramHeartbeat(request: D65LaunchSignerHeartbeatRequest): Promise<D65LaunchSignerResult> {
    const client = new CoordinatorClient({ env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: request.state_root } });
    const status = await client.query('status', request.repo_id, request.workstream_run);
    const doctor = await client.query('doctor', request.repo_id, request.workstream_run);
    const artifacts = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
    const policyArtifact = artifacts.find((a) => a.document_schema_version === 'autopilot.launch_policy.v1');
    if (policyArtifact === undefined) throw new Error('signer: no policy artifact');
    const run = parseCoordinationRun((status.payload['runs'] as unknown[])[0]);
    const sessions = (status.payload['session_leases'] as unknown[]).map(parseCoordinationSessionLease);
    const attached = sessions.find((s) => (s.status === 'attached' || s.status === 'handoff-pending') && s.attachment_kind === 'dispatch' && s.session_generation === run.active_session_generation);
    if (attached === undefined) throw new Error('signer: no attached session');
    const head = status.payload['accepted_program_heartbeat'];
    const priorSha = head === null ? null : (head as Record<string, unknown>)['heartbeat_sha256'] as `sha256:${string}`;
    const { createPrivateKey } = await import('node:crypto');
    const issued = new Date(); issued.setMilliseconds(Math.max(0, issued.getMilliseconds() - 50));
    const dispatchRow = request.graph_sequence >= 2;
    const fields = {
      schema_version: 'autopilot.program_heartbeat.v1', program_id: this.input.programId, sequence: request.heartbeat_sequence, prior_sha256: priorSha,
      issued_at: issued.toISOString(), valid_until: new Date(issued.getTime() + 15 * 60 * 1000).toISOString(),
      package_commit: this.input.packageCommit, package_tree: this.input.packageTree, base_commit: this.input.b0Commit, base_tree: this.input.b0Tree,
      rows: [{ workstream: this.input.workstream, workstream_run: request.workstream_run, parent_session_file_sha256: null, coordinator_session_lease_id: attached.session_lease_id, accepted_graph_sequence: request.graph_sequence, accepted_graph_sha256: request.graph_sha256, status_sha256: status.payload['semantic_snapshot_sha256'], doctor_sha256: doctor.payload['semantic_snapshot_sha256'], session_lease_state: 'attached', child_lease_ids: [], launch_policy_sha256: policyArtifact.evidence.sha256, last_progress_event_seq: attached.attached_event_seq, last_handoff_sha256: null, row_state: 'active', dispatch_allowed: dispatchRow, stop_reasons: dispatchRow ? [] : ['graph-publication-pending'] }],
      provider_health: [{ provider: this.input.rosterProvider, state: 'healthy', observation_ref: policyArtifact.evidence.ref, observation_sha256: policyArtifact.evidence.sha256, cooldown_until: null, probe_workstream_run: null, probe_ref: null, probe_sha256: null, consumption_event_seq: null }],
      dispatch_allowed: true, stop_reasons: [], trust_anchor_ref: this.input.trustRef, trust_anchor_sha256: this.input.trustSha256, signer_key_id: this.input.trustSha256,
    };
    const signature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, concatDomain('AUTOPILOT-D65-PROGRAM-HEARTBEAT\u0000', canonicalJson(fields)), createPrivateKey(this.input.privateKeyPem))));
    const bytes = new TextEncoder().encode(`${canonicalJson({ ...fields, signature })}\n`);
    const ref = `program-heartbeats/${String(request.heartbeat_sequence).padStart(20, '0')}.json`;
    const absolutePath = join(this.input.programEvidenceRoot, ref);
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    await writeFile(absolutePath, bytes, { mode: 0o600 });
    chmodSync(absolutePath, 0o600);
    return { ref, absolute_path: absolutePath, sha256: sha256(bytes), byte_count: bytes.byteLength };
  }
}

function concatDomain(domain: string, message: string): Uint8Array {
  const d = new TextEncoder().encode(domain); const m = new TextEncoder().encode(message);
  const out = new Uint8Array(d.length + m.length); out.set(d, 0); out.set(m, d.length); return out;
}

/** Round-trip a parsed manifest back to a plain JSON object for tampering. */
function manifestObject(manifest: D65LaunchManifest): Record<string, unknown> {
  return JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
}

interface LaunchFixture {
  readonly root: string;
  readonly manifest: D65LaunchManifest;
  readonly signer: TestOperatorSigner;
  readonly env: ProcessEnvLike;
  readonly close: () => Promise<void>;
}

async function buildLaunchFixture(suffix: string): Promise<LaunchFixture> {
  const root = await mkdtemp(join(tmpdir(), `d65-launch-${suffix}-`));
  const clone = join(root, 'clone');
  await mkdir(clone, { recursive: true });
  git(clone, ['init', '-b', 'main']);
  await writeFile(join(clone, 'README.md'), 'B0\n', 'utf8');
  git(clone, ['add', 'README.md']); git(clone, ['commit', '-m', 'B0']);
  const b0Commit = git(clone, ['rev-parse', 'HEAD']); const b0Tree = git(clone, ['rev-parse', 'HEAD^{tree}']);
  await writeFile(join(clone, 'content-result.txt'), 'sealed content result\n', 'utf8');
  git(clone, ['add', '.']); git(clone, ['commit', '-m', 'content result']);
  const contentCommit = git(clone, ['rev-parse', 'HEAD']); const contentTree = git(clone, ['rev-parse', 'HEAD^{tree}']);

  const programId = `program-${suffix}`; const workstream = `wk${suffix}`; const workstreamRun = `run-${suffix}`;
  const autopilotId = `ap-${suffix}`; const repoId = `repo-${suffix}`;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const exported = publicKey.export({ format: 'der', type: 'spki' });
  if (!(exported instanceof Uint8Array)) throw new Error('spki export not binary');
  const spki = Buffer.from(exported);
  const trustRef = `.pi/autopilot-trust/d65/${programId}/operator-ed25519.spki`;
  const trustSha256 = sha256(spki);
  const bootstrapRef = `.pi/autopilot-bootstrap/${workstreamRun}/bootstrap.json`;

  const stateRoot = join(root, 'state'); const sessionRoot = join(root, 'sessions');
  const worktreeRoot = join(stateRoot, 'worktrees', repoId);
  const mainWorktreePath = join(worktreeRoot, 'active', workstreamRun, 'main');
  const runtimeRoot = join(mainWorktreePath, '.pi', 'autopilot', workstream);
  const packageCommit = 'a'.repeat(40); const packageTree = 'b'.repeat(40);
  const rosterProvider = 'openai-codex';

  const prospectiveRun = { schema_version: 'autopilot.coordination_run.v1', repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: workstreamRun, coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 0, created_event_seq: 1, version: 1 };
  const prospectiveResource = { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: workstreamRun, source_repo: clone, git_common_dir: join(clone, '.git'), worktree_root: worktreeRoot, main_worktree_path: mainWorktreePath, runtime_root: runtimeRoot, branch: `autopilot/${workstreamRun}`, target_branch: 'main', target_base_sha: contentCommit, origin_url: null, started_at: '2026-07-22T22:00:32.000Z', version: 1 };

  const bootstrap = {
    schema_version: 'autopilot.semantic_graph_bootstrap.v1', program_id: programId, graph_sequence: 1, prior_graph_sha256: null,
    repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: workstreamRun,
    run_timestamp: '2026-07-22T22:00:32.000Z', run_nonce: 'abc123', content_commit: contentCommit, content_tree: contentTree,
    package_commit: packageCommit, package_tree: packageTree, prospective_run: prospectiveRun, prospective_resource: prospectiveResource,
    covered_event_seq: 0, trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256,
    allowed_bootstrap_operations: ['attach-run', 'attach-session', 'prepare-main-worktree', 'transition-main-worktree', 'register-launch-policy', 'accept-program-heartbeat', 'parent-planning', 'publish-complete-graph'],
    created_at: '2026-07-22T22:00:33.000Z',
  };
  const bootstrapBytes = `${JSON.stringify(bootstrap, null, 2)}\n`;
  // Build the launch/bootstrap overlay as a sibling commit off content result.
  git(clone, ['checkout', '-b', `autopilot/bootstrap/${workstreamRun}`, contentCommit]);
  await mkdir(join(clone, dirname(trustRef)), { recursive: true });
  await writeFile(join(clone, trustRef), spki);
  await mkdir(join(clone, dirname(bootstrapRef)), { recursive: true });
  await writeFile(join(clone, bootstrapRef), bootstrapBytes, 'utf8');
  git(clone, ['add', '.']); git(clone, ['commit', '-m', 'launch overlay']);
  const overlayCommit = git(clone, ['rev-parse', 'HEAD']); const overlayTree = git(clone, ['rev-parse', 'HEAD^{tree}']);
  const trustBlobOid = git(clone, ['rev-parse', `${overlayCommit}:${trustRef}`]);
  git(clone, ['checkout', 'main']);

  const rawEvidence = join(root, 'evidence');
  await mkdir(rawEvidence, { recursive: true, mode: 0o700 }); chmodSync(rawEvidence, 0o700);
  const programEvidenceRoot = realpathSync(rawEvidence);

  // Build the fixed subscription roster + pre-run selection authority bytes.
  const seedRoster = SEED_ROSTERS.find((entry) => entry.roster_id === 'cruise-codex-subscription-bdb4f15f0ff9');
  if (seedRoster === undefined) throw new Error('fixed subscription seed roster not found');
  const rosterBytes = Buffer.from(`${canonicalRosterJson(seedRoster)}\n`, 'utf8');
  const rosterAuthoritySha256 = seedRoster.roster_sha256 as `sha256:${string}`;
  const selectionPublication = buildCanonicalPreRunSelection({
    stateRoot, repo_id: repoId, workstream_run: workstreamRun,
    selected: { scope: seedRoster.scope, roster_id: seedRoster.roster_id, roster_revision: seedRoster.roster_revision, roster_sha256: rosterAuthoritySha256 as RosterSha256, assignment_set_sha256: seedRoster.assignment_set_sha256 as RosterSha256, config_sha256: 'sha256:7777777777777777777777777777777777777777777777777777777777777777' as RosterSha256 },
    selected_at: '2026-07-22T22:00:33.000Z',
  });
  const selectionBytes = Buffer.from(selectionPublication.selection_bytes);
  const rosterRef = join(programEvidenceRoot, 'roster', `${workstreamRun}.roster.json`);
  const selectionRef = join(programEvidenceRoot, 'roster', `${workstreamRun}.selection.json`);
  await mkdir(dirname(rosterRef), { recursive: true, mode: 0o700 });
  await writeFile(rosterRef, rosterBytes, { mode: 0o600 }); chmodSync(rosterRef, 0o600);
  await writeFile(selectionRef, selectionBytes, { mode: 0o600 }); chmodSync(selectionRef, 0o600);

  // Pre-sign the policy candidate to seal its digest in the manifest.
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const policyFields = { schema_version: 'autopilot.launch_policy.v1', program_id: programId, policy_id: 'policy-1', policy_version: 1, repo_id: repoId, workstream_run: workstreamRun, package_commit: packageCommit, package_tree: packageTree, base_commit: b0Commit, base_tree: b0Tree, bootstrap_graph_sha256: sha256(bootstrapBytes), bootstrap_receipt_event_seq: 1, roster_sha256: rosterAuthoritySha256, parallel_cap: 1, maximum_parallel_cap: 1, expected_checkout_units: 1, program_evidence_root: programEvidenceRoot, trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256, prior_policy_sha256: null, capacity_decision_ref: null, capacity_decision_sha256: null, issued_at: '2026-07-22T22:00:34.000Z', signer_key_id: trustSha256 };
  const policySignature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, concatDomain('AUTOPILOT-D65-LAUNCH-POLICY\u0000', canonicalJson(policyFields)), privateKey)));
  const policyBytes = `${canonicalJson({ ...policyFields, signature: policySignature })}\n`;
  const policySha256 = sha256(policyBytes);

  // Seal the external launch-audit + bootstrap-projection evidence files.
  const launchAuditRef = join(programEvidenceRoot, 'launch-audit', `${workstreamRun}.json`);
  const launchAuditBytes = Buffer.from(`${JSON.stringify({ schema_version: 'autopilot.launch_audit.v1', workstream_run: workstreamRun, overlay_commit: overlayCommit })}\n`, 'utf8');
  await mkdir(dirname(launchAuditRef), { recursive: true, mode: 0o700 }); await writeFile(launchAuditRef, launchAuditBytes, { mode: 0o600 }); chmodSync(launchAuditRef, 0o600);
  const projectionRef = join(programEvidenceRoot, 'bootstrap-projections', workstreamRun, '00000000000000000001.json');
  const projectionBytes = Buffer.from(`${JSON.stringify({ schema_version: 'autopilot.bootstrap_projection.v1', workstream_run: workstreamRun })}\n`, 'utf8');
  await mkdir(dirname(projectionRef), { recursive: true, mode: 0o700 }); await writeFile(projectionRef, projectionBytes, { mode: 0o600 }); chmodSync(projectionRef, 0o600);
  const launchSealRef = join(programEvidenceRoot, 'launch-seal.json');
  const launchSealBytes = Buffer.from(`${JSON.stringify({ schema_version: 'autopilot.kbg_launch_seal.v1', workstream_run: workstreamRun, overlay_commit: overlayCommit })}\n`, 'utf8');
  await writeFile(launchSealRef, launchSealBytes, { mode: 0o600 }); chmodSync(launchSealRef, 0o600);

  const manifest = parseD65LaunchManifest({
    schema_version: 'autopilot.launch_manifest.v1', manifest_id: `launch-${suffix}`, program_id: programId, workstream, workstream_run: workstreamRun, autopilot_id: autopilotId,
    run_timestamp: '2026-07-22T22:00:32.000Z', run_nonce: 'abc123', source_clone: clone, canonical_root: clone, git_common_dir: join(clone, '.git'), repo_id: repoId, repo_key: repoId,
    b0_commit: b0Commit, b0_tree: b0Tree, content_result_commit: contentCommit, content_result_tree: contentTree, package_commit: packageCommit, package_tree: packageTree,
    run_branch: `autopilot/${workstreamRun}`, target_branch: 'main', state_root: stateRoot, session_root: sessionRoot, worktree_root: worktreeRoot, main_worktree_path: mainWorktreePath, runtime_root: runtimeRoot,
    bootstrap_overlay: { overlay_commit: overlayCommit, overlay_tree: overlayTree, overlay_ref: `refs/heads/autopilot/bootstrap/${workstreamRun}`, bootstrap_ref: bootstrapRef, bootstrap_sha256: sha256(bootstrapBytes), bootstrap_byte_count: Buffer.byteLength(bootstrapBytes, 'utf8') },
    trust_anchor: { trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256, trust_anchor_blob_oid: trustBlobOid, byte_count: 44 },
    prospective_run: prospectiveRun, prospective_resource: prospectiveResource, coordination_authority: 'coordinator-edit-leases-v1',
    roster_authority: 'user-default', roster_selection_ref: `roster-selections/${repoId}/${workstreamRun}.json`, roster_sha256: rosterAuthoritySha256,
    roster_selection: { roster_ref: rosterRef, roster_bytes_sha256: sha256(rosterBytes), selection_ref: selectionRef, selection_bytes_sha256: sha256(selectionBytes), selection_sha256: selectionPublication.selection.selection_sha256 as `sha256:${string}`, provider: 'openai-codex' },
    parent_model: 'openai-codex/gpt-5.6-sol', parent_thinking: 'xhigh',
    policy_candidate: { policy_id: 'policy-1', policy_ref: 'authority/launch-policies/policy-1.json', policy_sha256: policySha256, registration_idempotency_key: `register-launch-policy:${workstreamRun}:policy-1` },
    program_evidence_root: programEvidenceRoot,
    launch_seal: { launch_commit: overlayCommit, launch_tree: overlayTree, launch_audit_ref: launchAuditRef, launch_audit_sha256: sha256(launchAuditBytes), launch_seal_ref: launchSealRef, launch_seal_sha256: sha256(launchSealBytes), bootstrap_projection_ref: projectionRef, bootstrap_projection_sha256: sha256(projectionBytes) },
    attach_run_idempotency_key: `attach-run:${repoId}:${workstreamRun}`, attach_session_idempotency_key: `attach-session:${repoId}:${workstreamRun}`,
    created_at: '2026-07-22T22:00:33.000Z',
  });
  void policyBytes;

  const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
  const signer = new TestOperatorSigner({ privateKeyPem, programId, workstream, trustRef, trustSha256, programEvidenceRoot, packageCommit, packageTree, b0Commit, b0Tree, rosterSha256: rosterAuthoritySha256, rosterProvider, stateRoot });
  return { root, manifest, signer, env, close: async () => { await server.close(); await rm(root, { recursive: true, force: true }); } };
}

/** Write exactly the five charter roots into the runtime root (the model turn). */
function emptyMap(): Record<string, unknown> { return {}; }

async function writeCharterRoots(manifest: D65LaunchManifest, sessionId: string): Promise<void> {
  const runtimeRoot = manifest.runtime_root;
  const state = { schema_version: 'autopilot.state.v1', workstream: manifest.workstream, updated_at: '2026-07-22T22:00:36.000Z', status: 'running', context_gate: { gate: 'ok', percent: 10 }, last_event_id: 1, ready_queue: [], running: [], blocked: [], completed: [], units: emptyMap(), operator_questions: [], next_actions: ['plan'] };
  const masterPlan = { schema_version: 'autopilot.master_plan.v1', workstream: manifest.workstream, mission_ref: 'mission.md', goal_summary: 'launch integration mission', non_goals: [], definition_of_done: ['charter accepted'], risk_level: 'low', lanes: [{ lane_id: 'main', summary: 'main', unit_ids: [] }], units: emptyMap(), ownership_matrix: { owned_paths: [], read_only_paths: [], untouchable_paths: [], held_paths: [] }, verification_matrix: { positive_witnesses: [], negative_witnesses: [], regression_witnesses: [], real_boundary_witnesses: [], blast_radius_checks: [], docs_schema_prompt_checks: [], dirty_tree_checks: [] }, closure_criteria: ['charter accepted'], current_focus: 'plan', last_decision_id: 1, last_event_id: 1, updated_at: '2026-07-22T22:00:36.000Z' };
  const decision = { schema_version: 'autopilot.decision.v1', id: 1, ts: '2026-07-22T22:00:36.000Z', event: 'master_plan_created', workstream: manifest.workstream, summary: 'plan created', decision: 'bootstrap plan only' };
  const event = { schema_version: 'autopilot.event.v1', id: 1, ts: '2026-07-22T22:00:36.000Z', event: 'state_created', workstream: manifest.workstream, summary: 'state created' };
  const files: readonly [string, string][] = [
    ['mission.md', '# Mission\n'],
    ['master-plan.json', `${JSON.stringify(masterPlan)}\n`],
    ['state.json', `${JSON.stringify(state)}\n`],
    ['decision-log.jsonl', `${JSON.stringify(decision)}\n`],
    ['events.jsonl', `${JSON.stringify(event)}\n`],
  ];
  for (const [name, body] of files) {
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, name), body, 'utf8');
  }
  // The bootstrap-plan turn calls context_budget first: seal its durable receipt.
  writeD65ContextBudgetReceipt(manifest, { gate: 'ok', percent: 10, tool_call_id: BUG_180_PROVIDER_TOOL_CALL_ID, session_id: sessionId });
}

void describe('D65 launch integration (production path)', () => {
  void it('drives the full sealed-manifest launch to ordinary-dispatch eligibility on one session', async () => {
    const fixture = await buildLaunchFixture('a');
    try {
      const { manifest, signer, env } = fixture;
      // Stage 1-3: attach-run(bootstrap_graph) + one session + main worktree.
      const bootstrap = await beginD65LaunchBootstrap({ manifest, rawSessionId: 'launch-a', env });
      assert.equal(bootstrap.attachment.session.session_generation, 1);
      assert.ok(existsSync(manifest.main_worktree_path));

      // Exactly one session lease exists.
      const client = new CoordinatorClient({ env });
      let status = await client.query('status', manifest.repo_id, manifest.workstream_run);
      let sessions = (status.payload['session_leases'] as unknown[]).map(parseCoordinationSessionLease);
      assert.equal(sessions.length, 1);
      // attach-run carried bootstrap: the deterministic bootstrap artifact exists.
      const artifacts0 = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
      assert.ok(artifacts0.some((a) => a.artifact_id === `semantic-graph-bootstrap:${manifest.workstream_run}`));

      // Stage 4-5: policy + initial heartbeat consumed from the external signer.
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env });
      status = await client.query('status', manifest.repo_id, manifest.workstream_run);
      const artifacts1 = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
      assert.equal(artifacts1.filter((a) => a.document_schema_version === 'autopilot.launch_policy.v1').length, 1);
      assert.ok(status.payload['accepted_program_heartbeat'] !== null);

      // Stage 6: the bootstrap parent-planning turn writes exactly five roots.
      await writeCharterRoots(manifest, bootstrap.attachment.context.session_id);
      assert.equal(detectD65CharterComplete(manifest), true);

      // Stage 7-8: first complete graph + successor heartbeat.
      const graph = await publishD65FirstGraphAndSuccessorHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env, createdAt: '2026-07-22T22:00:37.000Z' });
      assert.equal(graph.graphSequence, 2);
      status = await client.query('status', manifest.repo_id, manifest.workstream_run);
      const artifacts2 = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
      assert.equal(artifacts2.filter((a) => a.document_schema_version === 'autopilot.semantic_graph.v1').length, 1);
      const head = status.payload['accepted_program_heartbeat'] as Record<string, unknown>;
      assert.equal(head['sequence'], 2);
      assert.equal(head['acceptance_kind'], 'governing');

      // Still exactly one session — no duplicate generation/lease/context.
      sessions = (status.payload['session_leases'] as unknown[]).map(parseCoordinationSessionLease);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.session_generation, 1);
      const resources = (status.payload['run_resources'] as unknown[]).map(parseCoordinationRunResource);
      assert.equal(resources[0]?.target_base_sha, manifest.content_result_commit);
    } finally {
      await fixture.close();
    }
  });

  void it('idempotently replays the whole launch after a mid-flight restart', async () => {
    const fixture = await buildLaunchFixture('b');
    try {
      const { manifest, signer, env } = fixture;
      // First pass: attach + policy + heartbeat, then simulate a crash.
      const bootstrap1 = await beginD65LaunchBootstrap({ manifest, rawSessionId: 'launch-b', env });
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest, attachment: bootstrap1.attachment, signer, env });
      // Recovery: begin again with the SAME sealed manifest/idempotency keys.
      const bootstrap2 = await beginD65LaunchBootstrap({ manifest, rawSessionId: 'launch-b', env });
      assert.equal(bootstrap2.attachment.session.session_generation, 1);
      assert.equal(bootstrap2.attachment.session.session_lease_id, bootstrap1.attachment.session.session_lease_id);
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest, attachment: bootstrap2.attachment, signer, env });
      // Still exactly one policy, one session.
      const client = new CoordinatorClient({ env });
      const status = await client.query('status', manifest.repo_id, manifest.workstream_run);
      const artifacts = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
      assert.equal(artifacts.filter((a) => a.document_schema_version === 'autopilot.launch_policy.v1').length, 1);
      assert.equal((status.payload['session_leases'] as unknown[]).length, 1);

      await writeCharterRoots(manifest, bootstrap2.attachment.context.session_id);
      const graph1 = await publishD65FirstGraphAndSuccessorHeartbeat({ manifest, attachment: bootstrap2.attachment, signer, env, createdAt: '2026-07-22T22:00:37.000Z' });
      // Re-publish is idempotent (recognizes the already-accepted graph 2).
      const graph2 = await publishD65FirstGraphAndSuccessorHeartbeat({ manifest, attachment: bootstrap2.attachment, signer, env, createdAt: '2026-07-22T22:00:37.000Z' });
      assert.equal(graph1.graphSha256, graph2.graphSha256);
      const status2 = await client.query('status', manifest.repo_id, manifest.workstream_run);
      const graphs = (status2.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact).filter((a) => a.document_schema_version === 'autopilot.semantic_graph.v1');
      assert.equal(graphs.length, 1);
    } finally {
      await fixture.close();
    }
  });

  void it('fences the launch when parent planning writes a path outside the five charter roots', async () => {
    const fixture = await buildLaunchFixture('c');
    try {
      const { manifest, signer, env } = fixture;
      const bootstrap = await beginD65LaunchBootstrap({ manifest, rawSessionId: 'launch-c', env });
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env });
      await writeCharterRoots(manifest, bootstrap.attachment.context.session_id);
      // Parent also touches a product path — must fail closed before first graph.
      await writeFile(join(manifest.main_worktree_path, 'PRODUCT.md'), 'unauthorized\n', 'utf8');
      assert.throws(() => detectD65CharterComplete(manifest), /outside the package-owned runtime charter scope/u);
    } finally {
      await fixture.close();
    }
  });

  void it('rejects a tampered bootstrap digest before any coordinator mutation', async () => {
    const fixture = await buildLaunchFixture('d');
    try {
      const base = manifestObject(fixture.manifest);
      const overlay = base['bootstrap_overlay'] as Record<string, unknown>;
      const tampered = parseD65LaunchManifest({ ...base, bootstrap_overlay: { ...overlay, bootstrap_sha256: `sha256:${'0'.repeat(64)}` } });
      await assert.rejects(() => beginD65LaunchBootstrap({ manifest: tampered, rawSessionId: 'launch-d', env: fixture.env }), /sealed bootstrap digest diverges|bootstrap graph sha256|content-result/u);
      // Nothing was attached: the coordinator has no run.
      const client = new CoordinatorClient({ env: fixture.env });
      const catalog = await client.query('run-catalog', fixture.manifest.repo_id, fixture.manifest.workstream_run);
      assert.equal((catalog.payload['runs'] as unknown[]).length, 0);
    } finally {
      await fixture.close();
    }
  });

  void it('rejects a D65 bootstrap attach in a nonempty coordinator repository', async () => {
    const fixture = await buildLaunchFixture('e');
    try {
      // Pre-create a legacy (non-bootstrap) run in the SAME repo so the D65
      // bootstrap attach-run finds a pre-existing repository row and rejects.
      const client = new CoordinatorClient({ env: fixture.env });
      await client.mutate('attach-run', { repoId: fixture.manifest.repo_id, workstreamRun: 'legacy-pre', sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-legacy-pre' }, {
        repo_key: fixture.manifest.repo_key, canonical_root: fixture.manifest.canonical_root, git_common_dir: fixture.manifest.git_common_dir,
        autopilot_id: 'ap-legacy', workstream: 'legacy', coordination_authority: 'coordinator-edit-leases-v1',
        run_resource: { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: fixture.manifest.repo_id, workstream_run: 'legacy-pre', source_repo: fixture.manifest.canonical_root, git_common_dir: fixture.manifest.git_common_dir, worktree_root: fixture.manifest.worktree_root, main_worktree_path: join(fixture.manifest.worktree_root, 'active', 'legacy-pre', 'main'), runtime_root: join(fixture.manifest.worktree_root, 'active', 'legacy-pre', 'main', '.pi', 'autopilot', 'legacy'), branch: 'autopilot/legacy-pre', target_branch: 'main', target_base_sha: fixture.manifest.content_result_commit, origin_url: null, started_at: '2026-07-22T22:00:32.000Z', version: 1 },
      });
      await assert.rejects(() => beginD65LaunchBootstrap({ manifest: fixture.manifest, rawSessionId: 'launch-e', env: fixture.env }), /fresh empty coordinator repository/u);
    } finally {
      await fixture.close();
    }
  });
});
