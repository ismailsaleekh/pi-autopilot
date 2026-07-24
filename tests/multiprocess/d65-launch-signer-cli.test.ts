import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { sign } from 'node:crypto';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { SEED_ROSTERS } from '../../src/core/roster/provider-recipes.ts';
import { canonicalRosterJson } from '../../src/core/roster/canonical.ts';
import { buildCanonicalPreRunSelection } from '../../src/core/roster/run-selection.ts';
import type { RosterSha256 } from '../../src/core/roster/paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { parseD65LaunchPolicy, parseD65ProgramHeartbeat } from '../../src/core/coordination/d65-launch-policy.ts';
import { encodeUnpaddedBase64Url } from '../../src/core/coordination/d65-trust.ts';
import { SpawnedD65LaunchSigner } from '../../src/core/coordination/d65-launch-signer.ts';
import { beginD65LaunchBootstrap } from '../../src/core/coordination/d65-launch-integration.ts';
import { parseD65LaunchManifest, type D65LaunchManifest } from '../../src/core/coordination/d65-launch-manifest.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'autopilot-launch-signer.ts');
const NODE = process.execPath;

function git(cwd: string, args: readonly string[]): string {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.invalid' } });
  if ((r.status ?? -1) !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function sha256(v: string | Uint8Array): `sha256:${string}` { return `sha256:${createHash('sha256').update(v).digest('hex')}`; }

interface Fixture { readonly root: string; readonly manifest: D65LaunchManifest; readonly signerCommand: string; readonly signerArgs: readonly string[]; readonly env: ProcessEnvLike; readonly configPath: string; readonly keyPath: string; readonly close: () => Promise<void> }

async function buildFixture(suffix: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `d65-signer-${suffix}-`));
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

  // The operator private key lives OUTSIDE every clone/state/session/evidence root.
  const keyDir = join(root, 'operator-key'); await mkdir(keyDir, { recursive: true, mode: 0o700 });
  const keyPath = join(keyDir, 'operator-ed25519.pkcs8.pem');
  await writeFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), { mode: 0o600 }); chmodSync(keyPath, 0o600);

  const policyIssuedAt = '2026-07-22T22:00:34.000Z';
  const signerConfig = { schema_version: 'autopilot.launch_signer_config.v1', program_id: programId, repo_id: repoId, workstream, workstream_run: workstreamRun, private_key_path: keyPath, state_root: stateRoot, session_root: sessionRoot, trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256, signer_key_id: trustSha256, program_evidence_root: programEvidenceRoot, policy_id: 'policy-1', policy_ref: 'authority/launch-policies/policy-1.json', package_commit: packageCommit, package_tree: packageTree, b0_commit: b0Commit, b0_tree: b0Tree, roster_sha256: rosterSha256, roster_provider: rosterProvider, policy_issued_at: policyIssuedAt, program_rows: [{ workstream, workstream_run: workstreamRun, state_root: stateRoot, repo_id: repoId }] };
  const configPath = join(keyDir, 'signer-config.json');
  await writeFile(configPath, `${JSON.stringify(signerConfig, null, 2)}\n`, { mode: 0o600 }); chmodSync(configPath, 0o600);

  // Deterministically compute the exact policy digest the CLI will produce so the
  // manifest can seal `policy_sha256` (the CLI binds the live bootstrap digest =
  // sha256(bootstrapBytes), receipt event seq = 1).
  const policyFields = { schema_version: 'autopilot.launch_policy.v1', program_id: programId, policy_id: 'policy-1', policy_version: 1, repo_id: repoId, workstream_run: workstreamRun, package_commit: packageCommit, package_tree: packageTree, base_commit: b0Commit, base_tree: b0Tree, bootstrap_graph_sha256: sha256(bootstrapBytes), bootstrap_receipt_event_seq: 1, roster_sha256: rosterSha256, parallel_cap: 1, maximum_parallel_cap: 1, expected_checkout_units: 1, program_evidence_root: programEvidenceRoot, trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256, prior_policy_sha256: null, capacity_decision_ref: null, capacity_decision_sha256: null, issued_at: policyIssuedAt, signer_key_id: trustSha256 };
  const policySignature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, Buffer.concat([Buffer.from('AUTOPILOT-D65-LAUNCH-POLICY\u0000', 'utf8'), Buffer.from(canonicalJson(policyFields), 'utf8')]), privateKey)));
  const policyBytes = `${canonicalJson({ ...policyFields, signature: policySignature })}\n`;
  const sealedPolicySha256 = sha256(policyBytes);
  const launchAuditRef = join(programEvidenceRoot, 'launch-audit', `${workstreamRun}.json`);
  const launchAuditBytes = Buffer.from(`${JSON.stringify({ schema_version: 'autopilot.launch_audit.v1', workstream_run: workstreamRun })}\n`, 'utf8');
  await mkdir(dirname(launchAuditRef), { recursive: true, mode: 0o700 }); await writeFile(launchAuditRef, launchAuditBytes, { mode: 0o600 }); chmodSync(launchAuditRef, 0o600);
  const projectionRef = join(programEvidenceRoot, 'bootstrap-projections', workstreamRun, '00000000000000000001.json');
  const projectionBytes = Buffer.from(`${JSON.stringify({ schema_version: 'autopilot.bootstrap_projection.v1', workstream_run: workstreamRun })}\n`, 'utf8');
  await mkdir(dirname(projectionRef), { recursive: true, mode: 0o700 }); await writeFile(projectionRef, projectionBytes, { mode: 0o600 }); chmodSync(projectionRef, 0o600);
  const launchSealRef = join(programEvidenceRoot, 'launch-seal.json');
  const launchSealBytes = Buffer.from(`${JSON.stringify({ schema_version: 'autopilot.kbg_launch_seal.v1', workstream_run: workstreamRun })}\n`, 'utf8');
  await writeFile(launchSealRef, launchSealBytes, { mode: 0o600 }); chmodSync(launchSealRef, 0o600);
  // The fixed subscription roster + pre-run selection authority bytes (sealed).
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

  // Pre-sign the policy candidate digest via the CLI so the manifest can seal it.
  const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const signerCommand = NODE;
  const signerArgs = ['--experimental-strip-types', CLI, '--config', configPath];
  // Attach the bootstrap first so the signer can read the live bootstrap digest.
  const manifestDraft = {
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
    policy_candidate: { policy_id: 'policy-1', policy_ref: 'authority/launch-policies/policy-1.json', policy_sha256: sealedPolicySha256, registration_idempotency_key: `register-launch-policy:${workstreamRun}:policy-1` },
    program_evidence_root: programEvidenceRoot,
    launch_seal: { launch_commit: overlayCommit, launch_tree: overlayTree, launch_audit_ref: launchAuditRef, launch_audit_sha256: sha256(launchAuditBytes), launch_seal_ref: launchSealRef, launch_seal_sha256: sha256(launchSealBytes), bootstrap_projection_ref: projectionRef, bootstrap_projection_sha256: sha256(projectionBytes) },
    attach_run_idempotency_key: `attach-run:${repoId}:${workstreamRun}`, attach_session_idempotency_key: `attach-session:${repoId}:${workstreamRun}`, created_at: '2026-07-22T22:00:33.000Z',
  };
  // We cannot fully seal policy_sha256 until the run is bootstrap-attached and
  // the CLI signs a policy (it binds the live bootstrap digest). This fixture
  // returns the draft; the test seals the policy digest after bootstrap attach.
  // Parse BEFORE starting the coordinator so a manifest rejection cannot leave a
  // live server holding the event loop open (fail fast, never hang).
  const manifest = parseD65LaunchManifest(manifestDraft);
  const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
  return { root, manifest, signerCommand, signerArgs, env, configPath, keyPath, close: async () => { await server.close(); await rm(root, { recursive: true, force: true }); } };
}

void describe('D65 external launch signer CLI (out-of-process operator boundary)', () => {
  void it('signs a valid launch policy and heartbeat through the spawned CLI; runtime holds no key', async () => {
    const fixture = await buildFixture('a');
    try {
      const { manifest, env } = fixture;
      // Bootstrap-attach so the live bootstrap digest exists for the signer.
      const bootstrap = await beginD65LaunchBootstrap({ manifest, rawSessionId: 'signer-a', env });
      const signer = new SpawnedD65LaunchSigner({ command: fixture.signerCommand, baseArgs: fixture.signerArgs, env });

      const policyResult = await signer.signLaunchPolicy({ kind: 'launch-policy', state_root: manifest.state_root, repo_id: manifest.repo_id, workstream_run: manifest.workstream_run, policy_id: 'policy-1', policy_ref: manifest.policy_candidate.policy_ref, expected_policy_sha256: manifest.policy_candidate.policy_sha256 });
      // The signer wrote genuinely operator-signed policy bytes.
      const policyBytes = readFileSync(policyResult.absolute_path);
      const policy = parseD65LaunchPolicy(JSON.parse(new TextDecoder().decode(policyBytes)));
      assert.equal(policy.parallel_cap, 1);
      assert.equal(policy.maximum_parallel_cap, 1);
      assert.equal(policy.expected_checkout_units, 1);
      assert.equal(policy.program_id, manifest.program_id);
      assert.equal(policyResult.sha256, sha256(policyBytes));

      // The heartbeat CLI produces a valid signed heartbeat bound to graph 1.
      const bootstrapDigest = manifest.bootstrap_overlay.bootstrap_sha256;
      // Commit + register the signed policy so the heartbeat signer sees it.
      const { registerD65LaunchPolicyAndInitialHeartbeat } = await import('../../src/core/coordination/d65-launch-integration.ts');
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env });
      const client = new CoordinatorClient({ env });
      const status = await client.query('status', manifest.repo_id, manifest.workstream_run);
      const head = status.payload['accepted_program_heartbeat'] as Record<string, unknown>;
      assert.equal(head['sequence'], 1);
      assert.equal(head['acceptance_kind'], 'governing');
      // The accepted heartbeat bytes parse as a valid signed heartbeat.
      const hbBytes = readFileSync(join(manifest.program_evidence_root, 'program-heartbeats', '00000000000000000001.json'));
      const hb = parseD65ProgramHeartbeat(JSON.parse(new TextDecoder().decode(hbBytes)));
      assert.equal(hb.sequence, 1);
      assert.equal(hb.rows[0]?.accepted_graph_sequence, 1);
      assert.equal(hb.rows[0]?.accepted_graph_sha256, bootstrapDigest);

      // The runtime process environment never carried the operator key path.
      assert.equal(env['AUTOPILOT_LAUNCH_SIGNER_CONFIG'], undefined);
      assert.notEqual(fixture.keyPath, '');
    } finally {
      await fixture.close();
    }
  });
});
