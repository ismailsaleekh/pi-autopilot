import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import autopilotExtension, {
  type ExtensionCommandContextLike,
  type ExtensionCommandDefinitionLike,
  type ExtensionHostLike,
  type ExtensionLifecycleHandler,
  type ExtensionModelLike,
  type ExtensionToolCallHandler,
  type NotificationKind,
  type AutopilotParentToolDefinition,
  type AutopilotRosterActivationStore,
} from '../../src/extension.ts';
import { AUTOPILOT_COMMAND } from '../../src/core/names.ts';
import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationAuthoritativeArtifact, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { encodeUnpaddedBase64Url } from '../../src/core/coordination/d65-trust.ts';
import { parseD65LaunchPolicy } from '../../src/core/coordination/d65-launch-policy.ts';
import { parseD65LaunchManifest, type D65LaunchManifest } from '../../src/core/coordination/d65-launch-manifest.ts';
import type { D65LaunchSigner, D65LaunchSignerHeartbeatRequest, D65LaunchSignerPolicyRequest, D65LaunchSignerResult } from '../../src/core/coordination/d65-launch-signer.ts';
import { d65ContextBudgetReceiptPath } from '../../src/core/coordination/d65-launch-integration.ts';
import { createContextBudgetTool } from '../../src/core/context-budget.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import { SEED_ROSTERS } from '../../src/core/roster/provider-recipes.ts';
import { canonicalRosterJson } from '../../src/core/roster/canonical.ts';
import { buildCanonicalPreRunSelection } from '../../src/core/roster/run-selection.ts';
import type { RosterSha256 } from '../../src/core/roster/paths.ts';
import { sdkReadyRosterActivationStore } from '../helpers/sdk-ready-roster.ts';

function git(cwd: string, args: readonly string[]): string {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.invalid' } });
  if ((r.status ?? -1) !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function sha256(v: string | Uint8Array): `sha256:${string}` { return `sha256:${createHash('sha256').update(v).digest('hex')}`; }
function concatDomain(domain: string, message: string): Uint8Array {
  const d = new TextEncoder().encode(domain); const m = new TextEncoder().encode(message);
  const out = new Uint8Array(d.length + m.length); out.set(d, 0); out.set(m, d.length); return out;
}

interface HarnessLike {
  readonly commands: Map<string, ExtensionCommandDefinitionLike>;
  readonly messages: string[];
  readonly tools: Map<string, AutopilotParentToolDefinition>;
  readonly toolRegistrations: AutopilotParentToolDefinition[];
  readonly notifications: { message: string; kind: NotificationKind | undefined }[];
  readonly settledHandlers: ExtensionLifecycleHandler[];
  readonly shutdownHandlers: ExtensionLifecycleHandler[];
  readonly toolCallHandlers: ExtensionToolCallHandler[];
  readonly ctx: ExtensionCommandContextLike;
}

class TestSigner implements D65LaunchSigner {
  private readonly input: { privateKeyPem: string; programId: string; workstream: string; trustRef: string; trustSha256: `sha256:${string}`; programEvidenceRoot: string; packageCommit: string; packageTree: string; b0Commit: string; b0Tree: string; rosterSha256: `sha256:${string}`; rosterProvider: string };
  constructor(input: TestSigner['input']) { this.input = input; }
  async signLaunchPolicy(request: D65LaunchSignerPolicyRequest): Promise<D65LaunchSignerResult> {
    const client = new CoordinatorClient({ env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: request.state_root } });
    const status = await client.query('status', request.repo_id, request.workstream_run);
    const artifacts = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
    const bootstrap = artifacts.find((a) => a.artifact_id === `semantic-graph-bootstrap:${request.workstream_run}`);
    if (bootstrap === undefined) throw new Error('signer: no bootstrap');
    const { createPrivateKey } = await import('node:crypto');
    const fields = { schema_version: 'autopilot.launch_policy.v1', program_id: this.input.programId, policy_id: request.policy_id, policy_version: 1, repo_id: request.repo_id, workstream_run: request.workstream_run, package_commit: this.input.packageCommit, package_tree: this.input.packageTree, base_commit: this.input.b0Commit, base_tree: this.input.b0Tree, bootstrap_graph_sha256: bootstrap.evidence.sha256, bootstrap_receipt_event_seq: bootstrap.registered_event_seq, roster_sha256: this.input.rosterSha256, parallel_cap: 1, maximum_parallel_cap: 1, expected_checkout_units: 1, program_evidence_root: this.input.programEvidenceRoot, trust_anchor_ref: this.input.trustRef, trust_anchor_sha256: this.input.trustSha256, prior_policy_sha256: null, capacity_decision_ref: null, capacity_decision_sha256: null, issued_at: '2026-07-22T22:00:34.000Z', signer_key_id: this.input.trustSha256 };
    const signature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, concatDomain('AUTOPILOT-D65-LAUNCH-POLICY\u0000', canonicalJson(fields)), createPrivateKey(this.input.privateKeyPem))));
    const bytes = new TextEncoder().encode(`${canonicalJson({ ...fields, signature })}\n`);
    parseD65LaunchPolicy(JSON.parse(new TextDecoder().decode(bytes)));
    const absolutePath = join(this.input.programEvidenceRoot, 'signed-launch-policies', `${request.policy_id}.json`);
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 }); await writeFile(absolutePath, bytes, { mode: 0o600 }); chmodSync(absolutePath, 0o600);
    return { ref: request.policy_ref, absolute_path: absolutePath, sha256: sha256(bytes), byte_count: bytes.byteLength };
  }
  async signProgramHeartbeat(request: D65LaunchSignerHeartbeatRequest): Promise<D65LaunchSignerResult> {
    const client = new CoordinatorClient({ env: { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: request.state_root } });
    const status = await client.query('status', request.repo_id, request.workstream_run);
    const doctor = await client.query('doctor', request.repo_id, request.workstream_run);
    const artifacts = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
    const policyArtifact = artifacts.find((a) => a.document_schema_version === 'autopilot.launch_policy.v1');
    if (policyArtifact === undefined) throw new Error('signer: no policy');
    const sessions = (status.payload['session_leases'] as unknown[]).map(parseCoordinationSessionLease);
    const attached = sessions.find((s) => (s.status === 'attached' || s.status === 'handoff-pending') && s.attachment_kind === 'dispatch');
    if (attached === undefined) throw new Error('signer: no session');
    const head = status.payload['accepted_program_heartbeat'];
    const priorSha = head === null ? null : (head as Record<string, unknown>)['heartbeat_sha256'] as `sha256:${string}`;
    const { createPrivateKey } = await import('node:crypto');
    const issued = new Date(); issued.setMilliseconds(Math.max(0, issued.getMilliseconds() - 50));
    const dispatchRow = request.graph_sequence >= 2;
    const fields = { schema_version: 'autopilot.program_heartbeat.v1', program_id: this.input.programId, sequence: request.heartbeat_sequence, prior_sha256: priorSha, issued_at: issued.toISOString(), valid_until: new Date(issued.getTime() + 15 * 60 * 1000).toISOString(), package_commit: this.input.packageCommit, package_tree: this.input.packageTree, base_commit: this.input.b0Commit, base_tree: this.input.b0Tree, rows: [{ workstream: this.input.workstream, workstream_run: request.workstream_run, parent_session_file_sha256: null, coordinator_session_lease_id: attached.session_lease_id, accepted_graph_sequence: request.graph_sequence, accepted_graph_sha256: request.graph_sha256, status_sha256: status.payload['semantic_snapshot_sha256'], doctor_sha256: doctor.payload['semantic_snapshot_sha256'], session_lease_state: 'attached', child_lease_ids: [], launch_policy_sha256: policyArtifact.evidence.sha256, last_progress_event_seq: attached.attached_event_seq, last_handoff_sha256: null, row_state: 'active', dispatch_allowed: dispatchRow, stop_reasons: dispatchRow ? [] : ['graph-publication-pending'] }], provider_health: [{ provider: this.input.rosterProvider, state: 'healthy', observation_ref: policyArtifact.evidence.ref, observation_sha256: policyArtifact.evidence.sha256, cooldown_until: null, probe_workstream_run: null, probe_ref: null, probe_sha256: null, consumption_event_seq: null }], dispatch_allowed: true, stop_reasons: [], trust_anchor_ref: this.input.trustRef, trust_anchor_sha256: this.input.trustSha256, signer_key_id: this.input.trustSha256 };
    const signature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, concatDomain('AUTOPILOT-D65-PROGRAM-HEARTBEAT\u0000', canonicalJson(fields)), createPrivateKey(this.input.privateKeyPem))));
    const bytes = new TextEncoder().encode(`${canonicalJson({ ...fields, signature })}\n`);
    const ref = `program-heartbeats/${String(request.heartbeat_sequence).padStart(20, '0')}.json`;
    const absolutePath = join(this.input.programEvidenceRoot, ref);
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 }); await writeFile(absolutePath, bytes, { mode: 0o600 }); chmodSync(absolutePath, 0o600);
    return { ref, absolute_path: absolutePath, sha256: sha256(bytes), byte_count: bytes.byteLength };
  }
}

function createLaunchHarness(signer: D65LaunchSigner, options: { readonly preRegisteredContextBudget?: boolean; readonly rosterActivationStore?: AutopilotRosterActivationStore; readonly resolveLaunchSigner?: (manifest: D65LaunchManifest) => D65LaunchSigner; readonly sendUserMessageFailures?: number } = {}): HarnessLike {
  const commands = new Map<string, ExtensionCommandDefinitionLike>();
  const messages: string[] = [];
  const tools = new Map<string, AutopilotParentToolDefinition>();
  const toolRegistrations: AutopilotParentToolDefinition[] = [];
  if (options.preRegisteredContextBudget === true) {
    const base = createContextBudgetTool(85);
    tools.set(base.name, base);
  }
  const notifications: { message: string; kind: NotificationKind | undefined }[] = [];
  const settledHandlers: ExtensionLifecycleHandler[] = [];
  const shutdownHandlers: ExtensionLifecycleHandler[] = [];
  const toolCallHandlers: ExtensionToolCallHandler[] = [];
  const selectedModels: ExtensionModelLike[] = [];
  let thinking = 'high';
  let remainingSendFailures = options.sendUserMessageFailures ?? 0;
  const host: ExtensionHostLike = {
    registerCommand: (name, definition) => { commands.set(name, definition); },
    registerTool: (tool) => { tools.set(tool.name, tool); toolRegistrations.push(tool); },
    getActiveTools: () => [],
    setActiveTools: () => undefined,
    setModel: (model) => { selectedModels.push(model); return Promise.resolve(true); },
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level) => { thinking = level; },
    sendUserMessage: (content) => { if (remainingSendFailures > 0) { remainingSendFailures -= 1; throw new Error('injected send failure'); } messages.push(content); },
    sendMessage: () => undefined,
    on: (eventName, handler) => {
      if (eventName === 'agent_settled') settledHandlers.push(handler as ExtensionLifecycleHandler);
      else if (eventName === 'session_shutdown') shutdownHandlers.push(handler as ExtensionLifecycleHandler);
      else if (eventName === 'tool_call') toolCallHandlers.push(handler as ExtensionToolCallHandler);
    },
  };
  const ctx: ExtensionCommandContextLike = {
    ui: { notify: (message, kind) => { notifications.push({ message, kind }); } },
    modelRegistry: { find: (provider, modelId) => ({ provider, id: modelId }) },
    sessionManager: { getSessionId: () => 'launch-extension-session' },
    isIdle: () => true,
  };
  autopilotExtension(host, { rosterActivationStore: options.rosterActivationStore ?? sdkReadyRosterActivationStore(), resolveLaunchSigner: options.resolveLaunchSigner ?? (() => signer) });
  return { commands, messages, tools, toolRegistrations, notifications, settledHandlers, shutdownHandlers, toolCallHandlers, ctx };
}

interface Fixture { readonly root: string; readonly manifest: D65LaunchManifest; readonly manifestPath: string; readonly signer: D65LaunchSigner; readonly env: ProcessEnvLike; readonly close: () => Promise<void> }

async function buildFixture(suffix: string): Promise<Fixture> {
  // Canonicalize the temp root so every derived authority path is symlink-free
  // (matching production, where roots are already canonical real paths). The
  // roster private-authority publisher rejects any symlinked ancestor (e.g. the
  // macOS `/var -> /private/var` alias under the system tmpdir).
  const root = realpathSync(await mkdtemp(join(tmpdir(), `d65-ext-${suffix}-`)));
  const clone = join(root, 'clone'); await mkdir(clone, { recursive: true });
  git(clone, ['init', '-b', 'main']);
  await writeFile(join(clone, 'README.md'), 'B0\n'); git(clone, ['add', '.']); git(clone, ['commit', '-m', 'B0']);
  const b0Commit = git(clone, ['rev-parse', 'HEAD']); const b0Tree = git(clone, ['rev-parse', 'HEAD^{tree}']);
  await writeFile(join(clone, 'content.txt'), 'content\n'); git(clone, ['add', '.']); git(clone, ['commit', '-m', 'content']);
  const contentCommit = git(clone, ['rev-parse', 'HEAD']); const contentTree = git(clone, ['rev-parse', 'HEAD^{tree}']);
  const programId = `program-${suffix}`; const workstream = `wk${suffix}`; const workstreamRun = `run-${suffix}`; const autopilotId = `ap-${suffix}`; const repoId = `repo-${suffix}`;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }) as Uint8Array);
  const trustRef = `.pi/autopilot-trust/d65/${programId}/operator-ed25519.spki`; const trustSha256 = sha256(spki);
  const bootstrapRef = `.pi/autopilot-bootstrap/${workstreamRun}/bootstrap.json`;
  const stateRoot = join(root, 'state');
  const sessionRoot = join(root, 'sessions');
  const worktreeRoot = join(stateRoot, 'worktrees', repoId);
  const mainWorktreePath = join(worktreeRoot, 'active', workstreamRun, 'main');
  const runtimeRoot = join(mainWorktreePath, '.pi', 'autopilot', workstream);
  const packageCommit = 'a'.repeat(40); const packageTree = 'b'.repeat(40);
  const seedRoster = SEED_ROSTERS.find((entry) => entry.roster_id === 'cruise-codex-subscription-bdb4f15f0ff9');
  if (seedRoster === undefined) throw new Error('fixed subscription seed roster not found');
  const rosterSha256 = seedRoster.roster_sha256 as `sha256:${string}`; const rosterProvider = 'openai-codex';
  const prospectiveRun = { schema_version: 'autopilot.coordination_run.v1', repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: workstreamRun, coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 0, created_event_seq: 1, version: 1 };
  const prospectiveResource = { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: workstreamRun, source_repo: clone, git_common_dir: join(clone, '.git'), worktree_root: worktreeRoot, main_worktree_path: mainWorktreePath, runtime_root: runtimeRoot, branch: `autopilot/${workstreamRun}`, target_branch: 'main', target_base_sha: contentCommit, origin_url: null, started_at: '2026-07-22T22:00:32.000Z', version: 1 };
  const bootstrap = { schema_version: 'autopilot.semantic_graph_bootstrap.v1', program_id: programId, graph_sequence: 1, prior_graph_sha256: null, repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: workstreamRun, run_timestamp: '2026-07-22T22:00:32.000Z', run_nonce: 'abc123', content_commit: contentCommit, content_tree: contentTree, package_commit: packageCommit, package_tree: packageTree, prospective_run: prospectiveRun, prospective_resource: prospectiveResource, covered_event_seq: 0, trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256, allowed_bootstrap_operations: ['attach-run', 'attach-session', 'prepare-main-worktree', 'transition-main-worktree', 'register-launch-policy', 'accept-program-heartbeat', 'parent-planning', 'publish-complete-graph'], created_at: '2026-07-22T22:00:33.000Z' };
  const bootstrapBytes = `${JSON.stringify(bootstrap, null, 2)}\n`;
  git(clone, ['checkout', '-b', `autopilot/bootstrap/${workstreamRun}`, contentCommit]);
  await mkdir(join(clone, dirname(trustRef)), { recursive: true }); await writeFile(join(clone, trustRef), spki);
  await mkdir(join(clone, dirname(bootstrapRef)), { recursive: true }); await writeFile(join(clone, bootstrapRef), bootstrapBytes);
  git(clone, ['add', '.']); git(clone, ['commit', '-m', 'overlay']);
  const overlayCommit = git(clone, ['rev-parse', 'HEAD']); const overlayTree = git(clone, ['rev-parse', 'HEAD^{tree}']);
  const trustBlobOid = git(clone, ['rev-parse', `${overlayCommit}:${trustRef}`]);
  git(clone, ['checkout', 'main']);
  const rawEvidence = join(root, 'evidence'); await mkdir(rawEvidence, { recursive: true, mode: 0o700 }); chmodSync(rawEvidence, 0o700);
  const programEvidenceRoot = realpathSync(rawEvidence);
  const policyFieldsSeed = { schema_version: 'autopilot.launch_policy.v1', program_id: programId, policy_id: 'policy-1', policy_version: 1, repo_id: repoId, workstream_run: workstreamRun, package_commit: packageCommit, package_tree: packageTree, base_commit: b0Commit, base_tree: b0Tree, bootstrap_graph_sha256: sha256(bootstrapBytes), bootstrap_receipt_event_seq: 1, roster_sha256: rosterSha256, parallel_cap: 1, maximum_parallel_cap: 1, expected_checkout_units: 1, program_evidence_root: programEvidenceRoot, trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256, prior_policy_sha256: null, capacity_decision_ref: null, capacity_decision_sha256: null, issued_at: '2026-07-22T22:00:34.000Z', signer_key_id: trustSha256 };
  const policySignature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, concatDomain('AUTOPILOT-D65-LAUNCH-POLICY\u0000', canonicalJson(policyFieldsSeed)), privateKey)));
  const policySha256 = sha256(`${canonicalJson({ ...policyFieldsSeed, signature: policySignature })}\n`);
  const launchAuditRef = join(programEvidenceRoot, 'launch-audit', `${workstreamRun}.json`);
  const launchAuditBytes = Buffer.from(`${JSON.stringify({ schema_version: 'autopilot.launch_audit.v1', workstream_run: workstreamRun, overlay_commit: overlayCommit })}\n`, 'utf8');
  await mkdir(dirname(launchAuditRef), { recursive: true, mode: 0o700 }); await writeFile(launchAuditRef, launchAuditBytes, { mode: 0o600 }); chmodSync(launchAuditRef, 0o600);
  const projectionRef = join(programEvidenceRoot, 'bootstrap-projections', workstreamRun, '00000000000000000001.json');
  const projectionBytes = Buffer.from(`${JSON.stringify({ schema_version: 'autopilot.bootstrap_projection.v1', workstream_run: workstreamRun })}\n`, 'utf8');
  await mkdir(dirname(projectionRef), { recursive: true, mode: 0o700 }); await writeFile(projectionRef, projectionBytes, { mode: 0o600 }); chmodSync(projectionRef, 0o600);
  const launchSealRef = join(programEvidenceRoot, 'launch-seal.json');
  const launchSealBytes = Buffer.from(`${JSON.stringify({ schema_version: 'autopilot.kbg_launch_seal.v1', workstream_run: workstreamRun })}\n`, 'utf8');
  await writeFile(launchSealRef, launchSealBytes, { mode: 0o600 }); chmodSync(launchSealRef, 0o600);
  const rosterBytes = Buffer.from(`${canonicalRosterJson(seedRoster)}\n`, 'utf8');
  const selectionPublication = buildCanonicalPreRunSelection({
    stateRoot, repo_id: repoId, workstream_run: workstreamRun,
    selected: { scope: seedRoster.scope, roster_id: seedRoster.roster_id, roster_revision: seedRoster.roster_revision, roster_sha256: rosterSha256 as RosterSha256, assignment_set_sha256: seedRoster.assignment_set_sha256 as RosterSha256, config_sha256: 'sha256:7777777777777777777777777777777777777777777777777777777777777777' as RosterSha256 },
    selected_at: '2026-07-22T22:00:33.000Z',
  });
  const selectionBytes = Buffer.from(selectionPublication.selection_bytes);
  const rosterRef = join(programEvidenceRoot, 'roster', `${workstreamRun}.roster.json`);
  const selectionRef = join(programEvidenceRoot, 'roster', `${workstreamRun}.selection.json`);
  await mkdir(dirname(rosterRef), { recursive: true, mode: 0o700 });
  await writeFile(rosterRef, rosterBytes, { mode: 0o600 }); chmodSync(rosterRef, 0o600);
  await writeFile(selectionRef, selectionBytes, { mode: 0o600 }); chmodSync(selectionRef, 0o600);
  const manifestDoc = {
    schema_version: 'autopilot.launch_manifest.v1', manifest_id: `launch-${suffix}`, program_id: programId, workstream, workstream_run: workstreamRun, autopilot_id: autopilotId,
    run_timestamp: '2026-07-22T22:00:32.000Z', run_nonce: 'abc123', source_clone: clone, canonical_root: clone, git_common_dir: join(clone, '.git'), repo_id: repoId, repo_key: repoId,
    b0_commit: b0Commit, b0_tree: b0Tree, content_result_commit: contentCommit, content_result_tree: contentTree, package_commit: packageCommit, package_tree: packageTree,
    run_branch: `autopilot/${workstreamRun}`, target_branch: 'main', state_root: stateRoot, session_root: sessionRoot, worktree_root: worktreeRoot, main_worktree_path: mainWorktreePath, runtime_root: runtimeRoot,
    bootstrap_overlay: { overlay_commit: overlayCommit, overlay_tree: overlayTree, overlay_ref: `refs/heads/autopilot/bootstrap/${workstreamRun}`, bootstrap_ref: bootstrapRef, bootstrap_sha256: sha256(bootstrapBytes), bootstrap_byte_count: Buffer.byteLength(bootstrapBytes, 'utf8') },
    trust_anchor: { trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256, trust_anchor_blob_oid: trustBlobOid, byte_count: 44 },
    prospective_run: prospectiveRun, prospective_resource: prospectiveResource, coordination_authority: 'coordinator-edit-leases-v1',
    roster_authority: 'user-default', roster_selection_ref: `roster-selections/${repoId}/${workstreamRun}.json`, roster_sha256: rosterSha256,
    roster_selection: { roster_ref: rosterRef, roster_bytes_sha256: sha256(rosterBytes), selection_ref: selectionRef, selection_bytes_sha256: sha256(selectionBytes), selection_sha256: selectionPublication.selection.selection_sha256 as `sha256:${string}`, provider: 'openai-codex' },
    parent_model: 'openai-codex/gpt-5.6-sol', parent_thinking: 'xhigh',
    policy_candidate: { policy_id: 'policy-1', policy_ref: 'authority/launch-policies/policy-1.json', policy_sha256: policySha256, registration_idempotency_key: `register-launch-policy:${workstreamRun}:policy-1` },
    program_evidence_root: programEvidenceRoot,
    launch_seal: { launch_commit: overlayCommit, launch_tree: overlayTree, launch_audit_ref: launchAuditRef, launch_audit_sha256: sha256(launchAuditBytes), launch_seal_ref: launchSealRef, launch_seal_sha256: sha256(launchSealBytes), bootstrap_projection_ref: projectionRef, bootstrap_projection_sha256: sha256(projectionBytes) },
    attach_run_idempotency_key: `attach-run:${repoId}:${workstreamRun}`, attach_session_idempotency_key: `attach-session:${repoId}:${workstreamRun}`, created_at: '2026-07-22T22:00:33.000Z',
  };
  const manifest = parseD65LaunchManifest(manifestDoc);
  // The manifest is external private authority: mode-0600 one-link outside clone.
  const manifestPath = join(root, 'launch-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestDoc)}\n`, { mode: 0o600 }); chmodSync(manifestPath, 0o600);
  const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  // Start the coordinator only after the manifest parses (never leave a live
  // server holding the event loop open on a fixture rejection).
  const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
  const signer = new TestSigner({ privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), programId, workstream, trustRef, trustSha256, programEvidenceRoot, packageCommit, packageTree, b0Commit, b0Tree, rosterSha256, rosterProvider });
  return { root, manifest, manifestPath, signer, env, close: async () => { await server.close(); await rm(root, { recursive: true, force: true }); } };
}

function emptyMap(): Record<string, unknown> { return {}; }

async function writeCharterRoots(manifest: D65LaunchManifest): Promise<void> {
  const runtimeRoot = manifest.runtime_root;
  const state = { schema_version: 'autopilot.state.v1', workstream: manifest.workstream, updated_at: '2026-07-22T22:00:36.000Z', status: 'running', context_gate: { gate: 'ok', percent: 10 }, last_event_id: 1, ready_queue: [], running: [], blocked: [], completed: [], units: emptyMap(), operator_questions: [], next_actions: ['plan'] };
  const masterPlan = { schema_version: 'autopilot.master_plan.v1', workstream: manifest.workstream, mission_ref: 'mission.md', goal_summary: 'mission', non_goals: [], definition_of_done: ['done'], risk_level: 'low', lanes: [{ lane_id: 'main', summary: 'main', unit_ids: [] }], units: emptyMap(), ownership_matrix: { owned_paths: [], read_only_paths: [], untouchable_paths: [], held_paths: [] }, verification_matrix: { positive_witnesses: [], negative_witnesses: [], regression_witnesses: [], real_boundary_witnesses: [], blast_radius_checks: [], docs_schema_prompt_checks: [], dirty_tree_checks: [] }, closure_criteria: ['done'], current_focus: 'plan', last_decision_id: 1, last_event_id: 1, updated_at: '2026-07-22T22:00:36.000Z' };
  const decision = { schema_version: 'autopilot.decision.v1', id: 1, ts: '2026-07-22T22:00:36.000Z', event: 'master_plan_created', workstream: manifest.workstream, summary: 's', decision: 'd' };
  const event = { schema_version: 'autopilot.event.v1', id: 1, ts: '2026-07-22T22:00:36.000Z', event: 'state_created', workstream: manifest.workstream, summary: 's' };
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(join(runtimeRoot, 'mission.md'), '# Mission\n');
  await writeFile(join(runtimeRoot, 'master-plan.json'), `${JSON.stringify(masterPlan)}\n`);
  await writeFile(join(runtimeRoot, 'state.json'), `${JSON.stringify(state)}\n`);
  await writeFile(join(runtimeRoot, 'decision-log.jsonl'), `${JSON.stringify(decision)}\n`);
  await writeFile(join(runtimeRoot, 'events.jsonl'), `${JSON.stringify(event)}\n`);
}

void describe('D65 launch via /autopilot --launch-manifest (extension)', () => {
  void it('bootstraps, plans, publishes graph 2 on agent_settled, and reaches ordinary dispatch on one session', async () => {
    const fixture = await buildFixture('a');
    const originalStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
    process.env[AUTOPILOT_STATE_ROOT_ENV] = String(fixture.env[AUTOPILOT_STATE_ROOT_ENV]);
    const harness = createLaunchHarness(fixture.signer, { preRegisteredContextBudget: true });
    try {
      const preexistingContextTool = harness.tools.get('context_budget');
      if (preexistingContextTool === undefined) throw new Error('pre-registered context_budget missing');
      const command = harness.commands.get(AUTOPILOT_COMMAND);
      if (command === undefined) throw new Error('missing /autopilot command');
      // Stage 1-6: the command dispatches the bootstrap-plan-only prompt.
      await command.handler(`${fixture.manifest.workstream} --launch-manifest ${fixture.manifestPath} finalize the mission`, harness.ctx);
      const bootstrapPrompt = harness.messages[0];
      if (bootstrapPrompt === undefined) throw new Error('bootstrap-plan prompt was not delivered');
      assert.match(bootstrapPrompt, /bootstrap-plan-only/u);
      assert.match(bootstrapPrompt, /five previously-absent charter roots/u);
      assert.ok(existsSync(fixture.manifest.main_worktree_path), 'main worktree created');
      const bashDecisions = await Promise.all(harness.toolCallHandlers.map(async (handler) => await handler(
        { toolName: 'bash', input: { command: 'printf pwn > PRODUCT.md' } },
        { cwd: fixture.manifest.main_worktree_path },
      )));
      assert.ok(bashDecisions.some((decision) => decision !== undefined && decision.block === true && /bash is disabled during the D65 bootstrap-only/u.test(decision.reason)), 'extension bootstrap guard must block bash');
      const d65ContextTool = harness.tools.get('context_budget') as ReturnType<typeof createContextBudgetTool> | undefined;
      if (d65ContextTool === undefined) throw new Error('manifest-bound context_budget missing');
      assert.notEqual(d65ContextTool, preexistingContextTool, 'D65 must replace an already-registered base tool');
      await d65ContextTool.execute('call-d65-context', {}, undefined, undefined, { getContextUsage: () => ({ tokens: 20_000, contextWindow: 200_000, percent: 10 }) });
      assert.equal(existsSync(d65ContextBudgetReceiptPath(fixture.manifest)), true);

      // Exactly one session and an accepted policy + initial heartbeat exist.
      const client = new CoordinatorClient({ env: fixture.env });
      let status = await client.query('status', fixture.manifest.repo_id, fixture.manifest.workstream_run);
      assert.equal((status.payload['session_leases'] as unknown[]).length, 1);
      assert.equal((status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact).filter((a) => a.document_schema_version === 'autopilot.launch_policy.v1').length, 1);
      assert.ok(status.payload['accepted_program_heartbeat'] !== null);

      // The bootstrap-plan turn writes the five charter roots, then settles.
      await writeCharterRoots(fixture.manifest);
      for (const handler of harness.settledHandlers) await handler({}, harness.ctx);
      assert.notEqual(harness.tools.get('context_budget'), d65ContextTool, 'ordinary dispatch must restore the unwrapped base context_budget tool');

      // Stage 7-9: graph 2 accepted, successor heartbeat accepted, continuation delivered.
      status = await client.query('status', fixture.manifest.repo_id, fixture.manifest.workstream_run);
      const artifacts = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
      assert.equal(artifacts.filter((a) => a.document_schema_version === 'autopilot.semantic_graph.v1').length, 1);
      assert.equal((status.payload['accepted_program_heartbeat'] as Record<string, unknown>)['sequence'], 2);
      // Still exactly one session — the bridge ADOPTED the launch attachment.
      const sessions = (status.payload['session_leases'] as unknown[]).map(parseCoordinationSessionLease);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.session_generation, 1);
      // The ordinary continuation prompt was delivered (child work now possible).
      const continuation = harness.messages[harness.messages.length - 1];
      if (continuation === undefined) throw new Error('continuation prompt missing');
      assert.match(continuation, /Autopilot parent orchestrator/u);
      assert.ok(harness.notifications.some((n) => /ordinary child dispatch is now permitted/u.test(n.message)));
    } finally {
      for (const handler of harness.shutdownHandlers) await handler({ reason: 'test-complete' }, harness.ctx);
      await fixture.close();
      if (originalStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
      else process.env[AUTOPILOT_STATE_ROOT_ENV] = originalStateRoot;
    }
  });

  void it('keeps a failed D65 attempt from contaminating the following legacy command state authority', async () => {
    const fixture = await buildFixture('env');
    const originalStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
    const ambientStateRoot = join(fixture.root, 'ambient-legacy-state');
    process.env[AUTOPILOT_STATE_ROOT_ENV] = ambientStateRoot;
    let legacyObservedStateRoot: string | undefined;
    const rosterActivationStore: AutopilotRosterActivationStore = {
      resolve: async (input) => {
        legacyObservedStateRoot = input.env[AUTOPILOT_STATE_ROOT_ENV];
        return { status: 'blocked', source: 'user-default', diagnostics: [] };
      },
    };
    const harness = createLaunchHarness(fixture.signer, { rosterActivationStore, resolveLaunchSigner: () => { throw new Error('injected signer resolution failure'); } });
    try {
      const command = harness.commands.get(AUTOPILOT_COMMAND);
      if (command === undefined) throw new Error('missing command');
      await command.handler(`${fixture.manifest.workstream} --launch-manifest ${fixture.manifestPath}`, harness.ctx);
      assert.equal(process.env[AUTOPILOT_STATE_ROOT_ENV], ambientStateRoot);
      await command.handler('legacy-after-failed-launch', harness.ctx);
      assert.equal(legacyObservedStateRoot, ambientStateRoot);
      assert.notEqual(legacyObservedStateRoot, fixture.manifest.state_root);
    } finally {
      for (const handler of harness.shutdownHandlers) await handler({ reason: 'test-complete' }, harness.ctx);
      await fixture.close();
      if (originalStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
      else process.env[AUTOPILOT_STATE_ROOT_ENV] = originalStateRoot;
    }
  });

  void it('restores after a failed bootstrap delivery and binds a later manifest to its own context receipt', async () => {
    const first = await buildFixture('first');
    const second = await buildFixture('second');
    const originalStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
    const ambientStateRoot = join(first.root, 'ambient-state');
    process.env[AUTOPILOT_STATE_ROOT_ENV] = ambientStateRoot;
    const harness = createLaunchHarness(first.signer, {
      preRegisteredContextBudget: true,
      sendUserMessageFailures: 1,
      resolveLaunchSigner: (manifest) => manifest.workstream_run === first.manifest.workstream_run ? first.signer : second.signer,
    });
    try {
      const command = harness.commands.get(AUTOPILOT_COMMAND);
      if (command === undefined) throw new Error('missing command');
      await command.handler(`${first.manifest.workstream} --launch-manifest ${first.manifestPath}`, harness.ctx);
      const baseAfterFailure = harness.tools.get('context_budget');
      if (baseAfterFailure === undefined) throw new Error('base context tool was not restored');
      assert.equal(existsSync(d65ContextBudgetReceiptPath(first.manifest)), false);
      assert.equal(process.env[AUTOPILOT_STATE_ROOT_ENV], ambientStateRoot);

      await command.handler(`${second.manifest.workstream} --launch-manifest ${second.manifestPath}`, harness.ctx);
      const secondWrapper = harness.tools.get('context_budget') as ReturnType<typeof createContextBudgetTool> | undefined;
      if (secondWrapper === undefined) throw new Error('second manifest wrapper missing');
      assert.notEqual(secondWrapper, baseAfterFailure);
      await secondWrapper.execute('call-second-manifest', {}, undefined, undefined, { getContextUsage: () => ({ tokens: 20_000, contextWindow: 200_000, percent: 10 }) });
      assert.equal(existsSync(d65ContextBudgetReceiptPath(first.manifest)), false);
      assert.equal(existsSync(d65ContextBudgetReceiptPath(second.manifest)), true);
      assert.ok(harness.toolRegistrations.filter((tool) => tool.name === 'context_budget').length >= 3, 'wrapper/base/wrapper registrations must all occur');
    } finally {
      for (const handler of harness.shutdownHandlers) await handler({ reason: 'test-complete' }, harness.ctx);
      await first.close();
      await second.close();
      if (originalStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
      else process.env[AUTOPILOT_STATE_ROOT_ENV] = originalStateRoot;
    }
  });

  void it('rejects a misplaced manifest flag before roster resolution or legacy activation', async () => {
    const fixture = await buildFixture('misplaced');
    let rosterCalls = 0;
    let signerCalls = 0;
    const rosterActivationStore: AutopilotRosterActivationStore = {
      resolve: async () => { rosterCalls += 1; return { status: 'blocked', source: 'user-default', diagnostics: [] }; },
    };
    const harness = createLaunchHarness(fixture.signer, { rosterActivationStore, resolveLaunchSigner: () => { signerCalls += 1; return fixture.signer; } });
    try {
      const command = harness.commands.get(AUTOPILOT_COMMAND);
      if (command === undefined) throw new Error('missing command');
      await command.handler(`${fixture.manifest.workstream} task --launch-manifest ${fixture.manifestPath}`, harness.ctx);
      assert.equal(rosterCalls, 0);
      assert.equal(signerCalls, 0);
      assert.equal(harness.messages.length, 0);
      assert.ok(harness.notifications.some((notification) => /must appear before task text/u.test(notification.message)));
    } finally {
      for (const handler of harness.shutdownHandlers) await handler({ reason: 'test-complete' }, harness.ctx);
      await fixture.close();
    }
  });

  void it('rejects a relative --launch-manifest path with no run state', async () => {
    const fixture = await buildFixture('b');
    const originalStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
    process.env[AUTOPILOT_STATE_ROOT_ENV] = String(fixture.env[AUTOPILOT_STATE_ROOT_ENV]);
    const harness = createLaunchHarness(fixture.signer);
    try {
      const command = harness.commands.get(AUTOPILOT_COMMAND);
      if (command === undefined) throw new Error('missing command');
      await command.handler(`${fixture.manifest.workstream} --launch-manifest relative/path.json`, harness.ctx);
      assert.equal(harness.messages.length, 0);
      assert.ok(harness.notifications.some((n) => /absolute path/u.test(n.message)));
    } finally {
      for (const handler of harness.shutdownHandlers) await handler({ reason: 'test-complete' }, harness.ctx);
      await fixture.close();
      if (originalStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
      else process.env[AUTOPILOT_STATE_ROOT_ENV] = originalStateRoot;
    }
  });
});
