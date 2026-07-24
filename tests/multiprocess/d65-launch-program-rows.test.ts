import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { SEED_ROSTERS } from '../../src/core/roster/provider-recipes.ts';
import { canonicalRosterJson } from '../../src/core/roster/canonical.ts';
import { buildCanonicalPreRunSelection } from '../../src/core/roster/run-selection.ts';
import type { RosterSha256 } from '../../src/core/roster/paths.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { encodeUnpaddedBase64Url } from '../../src/core/coordination/d65-trust.ts';
import { parseD65ProgramHeartbeat } from '../../src/core/coordination/d65-launch-policy.ts';
import { SpawnedD65LaunchSigner } from '../../src/core/coordination/d65-launch-signer.ts';
import { beginD65LaunchBootstrap, detectD65CharterComplete, publishD65FirstGraphAndSuccessorHeartbeat, registerD65LaunchPolicyAndInitialHeartbeat, writeD65ContextBudgetReceipt } from '../../src/core/coordination/d65-launch-integration.ts';
import { parseD65LaunchManifest, type D65LaunchManifest } from '../../src/core/coordination/d65-launch-manifest.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

// D65 launch item-I regressions for the shared six-row governing heartbeat and
// its foreign-row live-authority preservation. These exercise the LOWEST
// responsible layer — the external `autopilot-launch-signer` CLI's `heartbeatRows`
// / `foreignRowFromLiveAuthority` — through a real spawned CLI (the production
// consumer), never an in-process signer double, so the emitted heartbeat bytes
// are exactly what a separately launched coordinator would sign. The heartbeat
// bytes are re-parsed by the frozen `parseD65ProgramHeartbeat` and accepted by
// the store's `accept-program-heartbeat` gate.

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'autopilot-launch-signer.ts');
const NODE = process.execPath;

interface SignerProgramRow { readonly workstream: string; readonly workstream_run: string; readonly state_root: string | null; readonly repo_id: string | null }

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

interface CliFixture {
  readonly root: string;
  readonly manifest: D65LaunchManifest;
  readonly signer: SpawnedD65LaunchSigner;
  readonly env: ProcessEnvLike;
  readonly stateRoot: string;
  readonly repoId: string;
  readonly workstream: string;
  readonly workstreamRun: string;
  readonly programEvidenceRoot: string;
  readonly close: () => Promise<void>;
}

/**
 * Build a complete sealed prelaunch package + isolated coordinator whose signer
 * is the real spawned CLI. `programRows` declares the complete generic program
 * row set the CLI must emit one heartbeat row per (identity-sorted). Passing more
 * than this run's row proves the six-row shared record and the foreign-row live
 * authority path.
 */
async function buildCliFixture(suffix: string, programRows?: readonly SignerProgramRow[]): Promise<CliFixture> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), `d65-progrow-${suffix}-`)));
  const clone = join(root, 'clone');
  await mkdir(clone, { recursive: true });
  git(clone, ['init', '-b', 'main']);
  await writeFile(join(clone, 'README.md'), 'B0\n'); git(clone, ['add', '.']); git(clone, ['commit', '-m', 'B0']);
  const b0Commit = git(clone, ['rev-parse', 'HEAD']); const b0Tree = git(clone, ['rev-parse', 'HEAD^{tree}']);
  await writeFile(join(clone, 'content.txt'), 'content\n'); git(clone, ['add', '.']); git(clone, ['commit', '-m', 'content']);
  const contentCommit = git(clone, ['rev-parse', 'HEAD']); const contentTree = git(clone, ['rev-parse', 'HEAD^{tree}']);

  const programId = `program-${suffix}`; const workstream = `wk${suffix}`; const workstreamRun = `run-${suffix}`;
  const autopilotId = `ap-${suffix}`; const repoId = `repo-${suffix}`;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }) as Uint8Array);
  const trustRef = `.pi/autopilot-trust/d65/${programId}/operator-ed25519.spki`;
  const trustSha256 = sha256(spki);
  const bootstrapRef = `.pi/autopilot-bootstrap/${workstreamRun}/bootstrap.json`;
  const stateRoot = join(root, 'state'); const sessionRoot = join(root, 'sessions');
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
  const keyDir = join(root, 'operator-key'); await mkdir(keyDir, { recursive: true, mode: 0o700 });
  const keyPath = join(keyDir, 'operator-ed25519.pkcs8.pem');
  await writeFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), { mode: 0o600 }); chmodSync(keyPath, 0o600);

  const rows: readonly SignerProgramRow[] = programRows ?? [{ workstream, workstream_run: workstreamRun, state_root: stateRoot, repo_id: repoId }];
  const policyIssuedAt = '2026-07-22T22:00:34.000Z';
  const signerConfig = { schema_version: 'autopilot.launch_signer_config.v1', program_id: programId, repo_id: repoId, workstream, workstream_run: workstreamRun, private_key_path: keyPath, state_root: stateRoot, session_root: sessionRoot, trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256, signer_key_id: trustSha256, program_evidence_root: programEvidenceRoot, policy_id: 'policy-1', policy_ref: 'authority/launch-policies/policy-1.json', package_commit: packageCommit, package_tree: packageTree, b0_commit: b0Commit, b0_tree: b0Tree, roster_sha256: rosterSha256, roster_provider: rosterProvider, policy_issued_at: policyIssuedAt, program_rows: rows };
  const configPath = join(keyDir, 'signer-config.json');
  await writeFile(configPath, `${JSON.stringify(signerConfig, null, 2)}\n`, { mode: 0o600 }); chmodSync(configPath, 0o600);

  const policyFields = { schema_version: 'autopilot.launch_policy.v1', program_id: programId, policy_id: 'policy-1', policy_version: 1, repo_id: repoId, workstream_run: workstreamRun, package_commit: packageCommit, package_tree: packageTree, base_commit: b0Commit, base_tree: b0Tree, bootstrap_graph_sha256: sha256(bootstrapBytes), bootstrap_receipt_event_seq: 1, roster_sha256: rosterSha256, parallel_cap: 1, maximum_parallel_cap: 1, expected_checkout_units: 1, program_evidence_root: programEvidenceRoot, trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256, prior_policy_sha256: null, capacity_decision_ref: null, capacity_decision_sha256: null, issued_at: policyIssuedAt, signer_key_id: trustSha256 };
  const policySignature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, concatDomain('AUTOPILOT-D65-LAUNCH-POLICY\u0000', canonicalJson(policyFields)), privateKey)));
  const policySha256 = sha256(`${canonicalJson({ ...policyFields, signature: policySignature })}\n`);

  const launchAuditRef = join(programEvidenceRoot, 'launch-audit', `${workstreamRun}.json`);
  const launchAuditBytes = Buffer.from(`${JSON.stringify({ schema_version: 'autopilot.launch_audit.v1', workstream_run: workstreamRun })}\n`, 'utf8');
  await mkdir(dirname(launchAuditRef), { recursive: true, mode: 0o700 }); await writeFile(launchAuditRef, launchAuditBytes, { mode: 0o600 }); chmodSync(launchAuditRef, 0o600);
  const projectionRef = join(programEvidenceRoot, 'bootstrap-projections', workstreamRun, '00000000000000000001.json');
  const projectionBytes = Buffer.from(`${JSON.stringify({ schema_version: 'autopilot.bootstrap_projection.v1', workstream_run: workstreamRun })}\n`, 'utf8');
  await mkdir(dirname(projectionRef), { recursive: true, mode: 0o700 }); await writeFile(projectionRef, projectionBytes, { mode: 0o600 }); chmodSync(projectionRef, 0o600);
  const launchSealRef = join(programEvidenceRoot, 'launch-seal.json');
  const launchSealBytes = Buffer.from(`${JSON.stringify({ schema_version: 'autopilot.kbg_launch_seal.v1', workstream_run: workstreamRun })}\n`, 'utf8');
  await writeFile(launchSealRef, launchSealBytes, { mode: 0o600 }); chmodSync(launchSealRef, 0o600);

  const rosterBytes = Buffer.from(`${canonicalRosterJson(seedRoster)}\n`, 'utf8');
  const selectionPublication = buildCanonicalPreRunSelection({ stateRoot, repo_id: repoId, workstream_run: workstreamRun, selected: { scope: seedRoster.scope, roster_id: seedRoster.roster_id, roster_revision: seedRoster.roster_revision, roster_sha256: rosterSha256 as RosterSha256, assignment_set_sha256: seedRoster.assignment_set_sha256 as RosterSha256, config_sha256: 'sha256:7777777777777777777777777777777777777777777777777777777777777777' as RosterSha256 }, selected_at: '2026-07-22T22:00:33.000Z' });
  const selectionBytes = Buffer.from(selectionPublication.selection_bytes);
  const rosterRef = join(programEvidenceRoot, 'roster', `${workstreamRun}.roster.json`);
  const selectionRef = join(programEvidenceRoot, 'roster', `${workstreamRun}.selection.json`);
  await mkdir(dirname(rosterRef), { recursive: true, mode: 0o700 });
  await writeFile(rosterRef, rosterBytes, { mode: 0o600 }); chmodSync(rosterRef, 0o600);
  await writeFile(selectionRef, selectionBytes, { mode: 0o600 }); chmodSync(selectionRef, 0o600);

  const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const manifest = parseD65LaunchManifest({
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
  });
  const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
  const signer = new SpawnedD65LaunchSigner({ command: NODE, baseArgs: ['--experimental-strip-types', CLI, '--config', configPath], env });
  return { root, manifest, signer, env, stateRoot, repoId, workstream, workstreamRun, programEvidenceRoot, close: async () => { await server.close(); await rm(root, { recursive: true, force: true }); } };
}

function emptyMap(): Record<string, unknown> { return {}; }

async function writeCharterRoots(manifest: D65LaunchManifest): Promise<void> {
  const runtimeRoot = manifest.runtime_root;
  const state = { schema_version: 'autopilot.state.v1', workstream: manifest.workstream, updated_at: '2026-07-22T22:00:36.000Z', status: 'running', context_gate: { gate: 'ok', percent: 10 }, last_event_id: 1, ready_queue: [], running: [], blocked: [], completed: [], units: emptyMap(), operator_questions: [], next_actions: ['plan'] };
  const masterPlan = { schema_version: 'autopilot.master_plan.v1', workstream: manifest.workstream, mission_ref: 'mission.md', goal_summary: 'launch integration mission', non_goals: [], definition_of_done: ['charter accepted'], risk_level: 'low', lanes: [{ lane_id: 'main', summary: 'main', unit_ids: [] }], units: emptyMap(), ownership_matrix: { owned_paths: [], read_only_paths: [], untouchable_paths: [], held_paths: [] }, verification_matrix: { positive_witnesses: [], negative_witnesses: [], regression_witnesses: [], real_boundary_witnesses: [], blast_radius_checks: [], docs_schema_prompt_checks: [], dirty_tree_checks: [] }, closure_criteria: ['charter accepted'], current_focus: 'plan', last_decision_id: 1, last_event_id: 1, updated_at: '2026-07-22T22:00:36.000Z' };
  const decision = { schema_version: 'autopilot.decision.v1', id: 1, ts: '2026-07-22T22:00:36.000Z', event: 'master_plan_created', workstream: manifest.workstream, summary: 'plan created', decision: 'bootstrap plan only' };
  const event = { schema_version: 'autopilot.event.v1', id: 1, ts: '2026-07-22T22:00:36.000Z', event: 'state_created', workstream: manifest.workstream, summary: 'state created' };
  const files: readonly [string, string][] = [['mission.md', '# Mission\n'], ['master-plan.json', `${JSON.stringify(masterPlan)}\n`], ['state.json', `${JSON.stringify(state)}\n`], ['decision-log.jsonl', `${JSON.stringify(decision)}\n`], ['events.jsonl', `${JSON.stringify(event)}\n`]];
  const { mkdir: mkdirp, writeFile: writeFilep } = await import('node:fs/promises');
  for (const [name, body] of files) { await mkdirp(runtimeRoot, { recursive: true }); await writeFilep(join(runtimeRoot, name), body, 'utf8'); }
  writeD65ContextBudgetReceipt(manifest, { gate: 'ok', percent: 10 });
}

/** Drive one CLI fixture fully to ordinary dispatch (graph 2 + heartbeat 2). */
async function driveToOrdinary(fixture: CliFixture): Promise<void> {
  const bootstrap = await beginD65LaunchBootstrap({ manifest: fixture.manifest, rawSessionId: fixture.workstream, env: fixture.env });
  await registerD65LaunchPolicyAndInitialHeartbeat({ manifest: fixture.manifest, attachment: bootstrap.attachment, signer: fixture.signer, env: fixture.env });
  await writeCharterRoots(fixture.manifest);
  assert.equal(detectD65CharterComplete(fixture.manifest), true);
  await publishD65FirstGraphAndSuccessorHeartbeat({ manifest: fixture.manifest, attachment: bootstrap.attachment, signer: fixture.signer, env: fixture.env, createdAt: '2026-07-22T22:00:37.000Z' });
}

void describe('D65 launch item-I: shared six-row governing heartbeat (external CLI)', () => {
  void it('emits exactly the sorted six-row program record: this row live, five planned/unlaunched', async () => {
    // The complete generic program declares all six rows; only this workstream is
    // launched, so its five peers are emitted planned/row-not-launched.
    const suffix = 'six';
    const workstream = `wk${suffix}`; const workstreamRun = `run-${suffix}`; const repoId = `repo-${suffix}`;
    const planned: SignerProgramRow[] = ['pcg', 'fun', 'ref', 'harness', 'ui'].map((w) => ({ workstream: `zz-${w}`, workstream_run: `run-${w}`, state_root: null, repo_id: null }));
    const rows: SignerProgramRow[] = [{ workstream, workstream_run: workstreamRun, state_root: `__THIS__`, repo_id: repoId }, ...planned];
    // buildCliFixture computes the real state_root; patch the placeholder in.
    const fixture = await buildCliFixture(suffix, rows.map((r) => (r.state_root === '__THIS__' ? { ...r, state_root: null } : r)));
    try {
      // Re-seal the config with this row's real state_root (the fixture knows it now).
      const realRows: SignerProgramRow[] = [{ workstream: fixture.workstream, workstream_run: fixture.workstreamRun, state_root: fixture.stateRoot, repo_id: fixture.repoId }, ...planned];
      await resealSignerConfig(fixture, realRows);
      const bootstrap = await beginD65LaunchBootstrap({ manifest: fixture.manifest, rawSessionId: fixture.workstream, env: fixture.env });
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest: fixture.manifest, attachment: bootstrap.attachment, signer: fixture.signer, env: fixture.env });

      // The store accepted the shared six-row heartbeat (production consumer).
      const client = new CoordinatorClient({ env: fixture.env });
      const status = await client.query('status', fixture.repoId, fixture.workstreamRun);
      assert.ok(status.payload['accepted_program_heartbeat'] !== null);

      // The signed bytes carry exactly six identity-sorted rows.
      const hbBytes = readFileSync(join(fixture.programEvidenceRoot, 'program-heartbeats', '00000000000000000001.json'));
      const hb = parseD65ProgramHeartbeat(JSON.parse(new TextDecoder().decode(hbBytes)));
      assert.equal(hb.rows.length, 6);
      for (let i = 1; i < hb.rows.length; i += 1) assert.ok((hb.rows[i - 1]?.workstream ?? '') < (hb.rows[i]?.workstream ?? ''), 'rows must be strictly identity-sorted');
      const thisRow = hb.rows.find((r) => r.workstream_run === fixture.workstreamRun);
      assert.ok(thisRow !== undefined);
      assert.equal(thisRow?.row_state, 'active');
      assert.equal(thisRow?.session_lease_state, 'attached');
      assert.notEqual(thisRow?.launch_policy_sha256, null);
      // Initial heartbeat is graph-1 (pre-complete-graph): its one row is fenced
      // by graph-publication-pending, never dispatch-allowed.
      assert.deepEqual([...(thisRow?.stop_reasons ?? [])], ['graph-publication-pending']);
      const peers = hb.rows.filter((r) => r.workstream_run !== fixture.workstreamRun);
      assert.equal(peers.length, 5);
      for (const peer of peers) {
        assert.equal(peer.row_state, 'planned');
        assert.equal(peer.dispatch_allowed, false);
        assert.deepEqual([...peer.stop_reasons], ['row-not-launched']);
        assert.equal(peer.coordinator_session_lease_id, null);
        assert.equal(peer.launch_policy_sha256, null);
        assert.equal(peer.accepted_graph_sequence, null);
      }
    } finally {
      await fixture.close();
    }
  });
});

void describe('D65 launch item-I: a second launched row preserves the first row live authority', () => {
  void it('the later coordinator signs the earlier launched row from its own live authority (never regressed to planned)', async () => {
    // Row A is fully launched to ordinary dispatch first. When row B later signs
    // its governing heartbeat with the complete two-row program set, A must be
    // read from ITS live coordinator authority (active, naming its policy/graph),
    // never collapsed back to planned merely because a different row is signing.
    const fixtureA = await buildCliFixture('a');
    try {
      await driveToOrdinary(fixtureA);
      const aRow: SignerProgramRow = { workstream: fixtureA.workstream, workstream_run: fixtureA.workstreamRun, state_root: fixtureA.stateRoot, repo_id: fixtureA.repoId };
      const fixtureB = await buildCliFixture('b', [aRow, { workstream: 'wkb', workstream_run: 'run-b', state_root: null, repo_id: null }]);
      try {
        // Re-seal B's config with B's own real state_root plus A's launched row.
        await resealSignerConfig(fixtureB, [aRow, { workstream: fixtureB.workstream, workstream_run: fixtureB.workstreamRun, state_root: fixtureB.stateRoot, repo_id: fixtureB.repoId }]);
        const bootstrapB = await beginD65LaunchBootstrap({ manifest: fixtureB.manifest, rawSessionId: fixtureB.workstream, env: fixtureB.env });
        await registerD65LaunchPolicyAndInitialHeartbeat({ manifest: fixtureB.manifest, attachment: bootstrapB.attachment, signer: fixtureB.signer, env: fixtureB.env });

        const hbBytes = readFileSync(join(fixtureB.programEvidenceRoot, 'program-heartbeats', '00000000000000000001.json'));
        const hb = parseD65ProgramHeartbeat(JSON.parse(new TextDecoder().decode(hbBytes)));
        assert.equal(hb.rows.length, 2);
        const rowForA = hb.rows.find((r) => r.workstream_run === fixtureA.workstreamRun);
        assert.ok(rowForA !== undefined, 'the emitted heartbeat must contain A row');
        // A launched (and reached graph 2): its foreign row is ACTIVE, dispatch-
        // allowed, and names its OWN live launch policy + accepted graph 2.
        assert.equal(rowForA?.row_state, 'active');
        assert.equal(rowForA?.dispatch_allowed, true);
        assert.deepEqual([...(rowForA?.stop_reasons ?? [])], []);
        assert.equal(rowForA?.accepted_graph_sequence, 2);
        assert.notEqual(rowForA?.launch_policy_sha256, null);
        assert.equal(rowForA?.session_lease_state, 'attached');
        // A's foreign policy digest equals A's own accepted launch policy digest.
        const clientA = new CoordinatorClient({ env: fixtureA.env });
        const statusA = await clientA.query('status', fixtureA.repoId, fixtureA.workstreamRun);
        const artifactsA = statusA.payload['authoritative_artifacts'] as { document_schema_version: string; evidence: { sha256: string } }[];
        const policyA = artifactsA.find((a) => a.document_schema_version === 'autopilot.launch_policy.v1');
        assert.equal(rowForA?.launch_policy_sha256, policyA?.evidence.sha256);
      } finally {
        await fixtureB.close();
      }
    } finally {
      await fixtureA.close();
    }
  });
});

void describe('D65 launch item-I: a foreign-row authority failure fails closed (no fail-open planned row)', () => {
  void it('a launched foreign row whose coordinator is unreachable makes the signer fail, never silently emit planned', async () => {
    // Declare a foreign program row that is NOT null (it names a launched state
    // root + repo id) but whose coordinator is unreachable at signing time (its
    // state root points at a coordinator that was shut down / never served this
    // identity's socket). A transient/unreachable authority query MUST fail
    // closed: the signer must NOT silently regress the launched row to planned.
    const fixture = await buildCliFixture('failclosed');
    try {
      // Point a non-null foreign row at a state root that is a REGULAR FILE, so
      // the coordinator cannot be created there and `client.query('status', ...)`
      // throws a non-connection error (ENOTDIR) rather than autostarting an empty
      // coordinator. This deterministically models an authority query failure that
      // must NOT be silently converted into a planned row.
      const deadStateRoot = join(fixture.root, 'dead-foreign-state-file');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(deadStateRoot, 'not a directory\n');
      const unreachableForeign: SignerProgramRow = { workstream: 'zz-unreachable', workstream_run: 'run-unreachable', state_root: deadStateRoot, repo_id: 'repo-unreachable' };
      const thisRow: SignerProgramRow = { workstream: fixture.workstream, workstream_run: fixture.workstreamRun, state_root: fixture.stateRoot, repo_id: fixture.repoId };
      await resealSignerConfig(fixture, [thisRow, unreachableForeign]);
      const bootstrap = await beginD65LaunchBootstrap({ manifest: fixture.manifest, rawSessionId: fixture.workstream, env: fixture.env });
      // registerD65LaunchPolicyAndInitialHeartbeat drives the signer's heartbeat
      // production, which reads every non-null foreign row's live authority. The
      // unreachable foreign row must throw inside the spawned CLI, failing the
      // whole heartbeat signing loudly rather than producing a false planned row.
      await assert.rejects(
        () => registerD65LaunchPolicyAndInitialHeartbeat({ manifest: fixture.manifest, attachment: bootstrap.attachment, signer: fixture.signer, env: fixture.env }),
        /external launch signer failed|foreign program row/u,
      );
      // No heartbeat sequence-1 candidate was produced (the signer failed closed).
      const { existsSync } = await import('node:fs');
      assert.equal(existsSync(join(fixture.programEvidenceRoot, 'program-heartbeats', '00000000000000000001.json')), false);
    } finally {
      await fixture.close();
    }
  });
});

/** Re-seal the mode-0600 signer config with a new complete program-row set. */
async function resealSignerConfig(fixture: CliFixture, rows: readonly SignerProgramRow[]): Promise<void> {
  const configPath = join(fixture.root, 'operator-key', 'signer-config.json');
  const existing = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  const next = { ...existing, program_rows: rows };
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
}
