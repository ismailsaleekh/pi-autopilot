import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { symlink as symlinkAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { parseD65LaunchManifest } from '../../src/core/coordination/d65-launch-manifest.ts';
import { ensurePrivateDirectory, publishCreateOnlyAtomic } from '../../src/core/roster/transaction.ts';

// Item H: the closed manifest contract must reject prospective run/resource
// unknown/nested drift, since those are the lowest-layer parsers.

const OID = (c: string): string => c.repeat(40);
const DIGEST = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}` as const;
const CLONE = '/private/tmp/kbg2/clone';
const STATE_ROOT = '/private/tmp/kbg2/state';
const SESSION_ROOT = '/private/tmp/kbg2/sessions';
const WORKTREE_ROOT = '/private/tmp/kbg2/state/worktrees/repo-kbg';
const MAIN = '/private/tmp/kbg2/state/worktrees/repo-kbg/active/kbg-run/main';
const RUNTIME = `${MAIN}/.pi/autopilot/kbg`;
const EVIDENCE = '/private/tmp/kbg2-evidence';

function prospectiveRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema_version: 'autopilot.coordination_run.v1', repo_id: 'repo-kbg', autopilot_id: 'ap-kbg', workstream: 'kbg', workstream_run: 'kbg-run', coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 0, created_event_seq: 1, version: 1, ...overrides };
}
function prospectiveResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema_version: 'autopilot.coordination_run_resource.v1', repo_id: 'repo-kbg', workstream_run: 'kbg-run', source_repo: CLONE, git_common_dir: `${CLONE}/.git`, worktree_root: WORKTREE_ROOT, main_worktree_path: MAIN, runtime_root: RUNTIME, branch: 'autopilot/kbg-run', target_branch: 'main', target_base_sha: OID('c'), origin_url: null, started_at: '2026-07-22T22:00:32.000Z', version: 1, ...overrides };
}
function manifestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'autopilot.launch_manifest.v1', manifest_id: 'launch-kbg-1', program_id: 'program-kbg', workstream: 'kbg', workstream_run: 'kbg-run', autopilot_id: 'ap-kbg',
    run_timestamp: '2026-07-22T22:00:32.000Z', run_nonce: 'abc123', source_clone: CLONE, canonical_root: CLONE, git_common_dir: `${CLONE}/.git`, repo_id: 'repo-kbg', repo_key: 'repo-kbg',
    b0_commit: OID('b'), b0_tree: OID('e'), content_result_commit: OID('c'), content_result_tree: OID('d'), package_commit: OID('a'), package_tree: OID('f'), run_branch: 'autopilot/kbg-run', target_branch: 'main',
    state_root: STATE_ROOT, session_root: SESSION_ROOT, worktree_root: WORKTREE_ROOT, main_worktree_path: MAIN, runtime_root: RUNTIME,
    bootstrap_overlay: { overlay_commit: OID('1'), overlay_tree: OID('2'), overlay_ref: 'refs/heads/autopilot/bootstrap/kbg-run', bootstrap_ref: '.pi/autopilot-bootstrap/kbg-run/bootstrap.json', bootstrap_sha256: DIGEST('9'), bootstrap_byte_count: 812 },
    trust_anchor: { trust_anchor_ref: '.pi/autopilot-trust/d65/program-kbg/operator-ed25519.spki', trust_anchor_sha256: DIGEST('8'), trust_anchor_blob_oid: OID('7'), byte_count: 44 },
    prospective_run: prospectiveRun(), prospective_resource: prospectiveResource(), coordination_authority: 'coordinator-edit-leases-v1',
    roster_authority: 'user-default', roster_selection_ref: 'roster-selections/repo-kbg/kbg-run.json', roster_sha256: DIGEST('6'),
    roster_selection: { roster_ref: '/private/tmp/kbg2-evidence/roster/kbg-run.roster.json', roster_bytes_sha256: DIGEST('a'), selection_ref: '/private/tmp/kbg2-evidence/roster/kbg-run.selection.json', selection_bytes_sha256: DIGEST('b'), selection_sha256: DIGEST('c'), provider: 'openai-codex' },
    parent_model: 'openai-codex/gpt-5.6-sol', parent_thinking: 'xhigh',
    policy_candidate: { policy_id: 'policy-1', policy_ref: 'authority/launch-policies/policy-1.json', policy_sha256: DIGEST('5'), registration_idempotency_key: 'register-launch-policy:kbg-run:policy-1', heartbeat_acceptance_idempotency_key: 'accept-program-heartbeat:kbg-run:1' },
    program_evidence_root: EVIDENCE,
    launch_seal: { launch_commit: OID('1'), launch_tree: OID('2'), launch_audit_ref: '/private/tmp/kbg2-evidence/launch-audit/kbg-run.json', launch_audit_sha256: DIGEST('4'), launch_seal_ref: '/private/tmp/kbg2-evidence/launch-seal.json', launch_seal_sha256: DIGEST('3'), bootstrap_projection_ref: '/private/tmp/kbg2-evidence/bootstrap-projections/kbg-run/00000000000000000001.json', bootstrap_projection_sha256: DIGEST('0') },
    attach_run_idempotency_key: 'attach-run:repo-kbg:kbg-run', attach_session_idempotency_key: 'attach-session:repo-kbg:kbg-run', created_at: '2026-07-22T22:00:33.000Z', ...overrides,
  };
}

void describe('D65 manifest closed prospective contract (item H)', () => {
  void it('rejects an unknown field nested in the prospective run', () => {
    assert.throws(() => parseD65LaunchManifest(manifestFixture({ prospective_run: prospectiveRun({ extra_field: 'nope' }) })), /prospective run must be an exact autopilot.coordination_run.v1 row/u);
  });
  void it('rejects an unknown field nested in the prospective resource', () => {
    assert.throws(() => parseD65LaunchManifest(manifestFixture({ prospective_resource: prospectiveResource({ extra_field: 'nope' }) })), /prospective resource must be an exact autopilot.coordination_run_resource.v1 row/u);
  });
  void it('accepts the exact closed prospective run/resource rows', () => {
    const manifest = parseD65LaunchManifest(manifestFixture());
    assert.equal(manifest.prospective_run['workstream_run'], 'kbg-run');
    assert.equal(manifest.prospective_resource['target_base_sha'], OID('c'));
  });
});

// Item F: the external signer's private-key admission must reject a key that
// lives inside any protected root (including the state and session roots) and
// its candidate publication must be atomic/no-alias/conflict-rejecting. These
// exercise the signer CLI's protected-root boundary via a direct spawn with an
// intentionally-misplaced key.

import { runLaunchSignerCli, assertPrivateKeyOutsideProtectedRoots } from '../../src/cli/autopilot-launch-signer.ts';

function writeMode0600(path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
}

void describe('D65 signer key protected-root boundary (item F)', () => {
  void it('rejects a private key that lives inside the coordinator state root', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'd65-signerkey-')));
    const stateRoot = join(root, 'state'); mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const sessionRoot = join(root, 'sessions'); mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyPath = join(stateRoot, 'operator-ed25519.pkcs8.pem');
    writeMode0600(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
    // The exact external-key boundary: a key inside the state root rejects.
    assert.throws(() => assertPrivateKeyOutsideProtectedRoots(keyPath, [stateRoot, sessionRoot]), /must live outside every clone\/state\/session\/worktree\/runtime\/evidence root/u);
  });

  void it('rejects a private key that lives inside the Pi session root', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'd65-signerkey2-')));
    const stateRoot = join(root, 'state'); mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const sessionRoot = join(root, 'sessions'); mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyPath = join(sessionRoot, 'nested', 'operator-ed25519.pkcs8.pem');
    writeMode0600(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
    assert.throws(() => assertPrivateKeyOutsideProtectedRoots(keyPath, [stateRoot, sessionRoot]), /must live outside/u);
  });

  void it('accepts a private key that lives outside every protected root', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'd65-signerkey3-')));
    const stateRoot = join(root, 'state'); mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const sessionRoot = join(root, 'sessions'); mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
    const keyDir = join(root, 'operator-key'); mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyPath = join(keyDir, 'operator-ed25519.pkcs8.pem');
    writeMode0600(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
    assert.doesNotThrow(() => assertPrivateKeyOutsideProtectedRoots(keyPath, [stateRoot, sessionRoot]));
  });

  void it('rejects a signer config with unexpected/missing fields', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'd65-signercfg-')));
    const configPath = join(root, 'bad-config.json');
    writeMode0600(configPath, `${JSON.stringify({ schema_version: 'autopilot.launch_signer_config.v1', extra: 'x' }, null, 2)}\n`);
    const request = JSON.stringify({ kind: 'launch-policy', state_root: root, repo_id: 'r', workstream_run: 'w', policy_id: 'p', policy_ref: 'a/b.json', expected_policy_sha256: DIGEST('5') });
    await assert.rejects(() => runLaunchSignerCli(['--config', configPath, '--request', request], { ...process.env }, () => undefined), /unexpected\/missing fields/u);
  });

  void it('rejects a launch-policy request carrying an unknown field (exact closed request set)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'd65-signerreq-')));
    const stateRoot = join(root, 'state'); mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const sessionRoot = join(root, 'sessions'); mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
    const evidenceRoot = realpathSync((() => { const p = join(root, 'evidence'); mkdirSync(p, { recursive: true, mode: 0o700 }); return p; })());
    const keyDir = join(root, 'key'); mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyPath = join(keyDir, 'k.pem'); writeMode0600(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
    const config = { schema_version: 'autopilot.launch_signer_config.v1', program_id: 'program-x', repo_id: 'repo-x', workstream: 'wkx', workstream_run: 'run-x', private_key_path: keyPath, state_root: stateRoot, session_root: sessionRoot, trust_anchor_ref: '.pi/x.spki', trust_anchor_sha256: DIGEST('8'), signer_key_id: DIGEST('8'), program_evidence_root: evidenceRoot, policy_id: 'policy-1', policy_ref: 'authority/launch-policies/policy-1.json', package_commit: OID('a'), package_tree: OID('f'), b0_commit: OID('b'), b0_tree: OID('e'), roster_sha256: DIGEST('6'), roster_provider: 'openai-codex', policy_issued_at: '2026-07-22T22:00:34.000Z', program_rows: [{ workstream: 'wkx', workstream_run: 'run-x', state_root: stateRoot, repo_id: 'repo-x' }] };
    const configPath = join(root, 'signer-config.json'); writeMode0600(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const request = JSON.stringify({ kind: 'launch-policy', state_root: stateRoot, repo_id: 'repo-x', workstream_run: 'run-x', policy_id: 'policy-1', policy_ref: 'authority/launch-policies/policy-1.json', expected_policy_sha256: DIGEST('5'), sneaky: 'x' });
    await assert.rejects(() => runLaunchSignerCli(['--config', configPath, '--request', request], { ...process.env }, () => undefined), /has unexpected\/missing fields/u);
  });

  void it('rejects a signer config program row missing state_root/repo_id', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'd65-signerrow-')));
    const configPath = join(root, 'bad-config.json');
    const config = { schema_version: 'autopilot.launch_signer_config.v1', program_id: 'program-x', repo_id: 'repo-x', workstream: 'wkx', workstream_run: 'run-x', private_key_path: '/abs/k.pem', state_root: '/abs/state', session_root: '/abs/sessions', trust_anchor_ref: '.pi/x.spki', trust_anchor_sha256: DIGEST('8'), signer_key_id: DIGEST('8'), program_evidence_root: '/abs/evidence', policy_id: 'policy-1', policy_ref: 'authority/launch-policies/policy-1.json', package_commit: OID('a'), package_tree: OID('f'), b0_commit: OID('b'), b0_tree: OID('e'), roster_sha256: DIGEST('6'), roster_provider: 'openai-codex', policy_issued_at: '2026-07-22T22:00:34.000Z', program_rows: [{ workstream: 'wkx', workstream_run: 'run-x' }] };
    writeMode0600(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const request = JSON.stringify({ kind: 'launch-policy', state_root: '/abs/state', repo_id: 'repo-x', workstream_run: 'run-x', policy_id: 'policy-1', policy_ref: 'authority/launch-policies/policy-1.json', expected_policy_sha256: DIGEST('5') });
    await assert.rejects(() => runLaunchSignerCli(['--config', configPath, '--request', request], { ...process.env }, () => undefined), /must have exactly workstream, workstream_run, state_root, and repo_id/u);
  });

});

void describe('D65 signed-candidate atomic publication (item F)', () => {
  void it('publishes create-only, accepts byte-identical replay, and rejects conflicting existing bytes', async () => {
    const evidenceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'd65-atomic-')));
    chmodSync(evidenceRoot, 0o700);
    const target = join(evidenceRoot, 'program-heartbeats', '00000000000000000001.json');
    const bytes = new TextEncoder().encode('{"a":1}\n');
    await ensurePrivateDirectory(dirname(target), evidenceRoot);
    const first = await publishCreateOnlyAtomic({ path: target, authorityRoot: evidenceRoot, bytes });
    assert.equal(first.status, 'created');
    // Byte-identical replay is idempotent (atomic replay).
    const replay = await publishCreateOnlyAtomic({ path: target, authorityRoot: evidenceRoot, bytes });
    assert.equal(replay.status, 'idempotent');
    // Conflicting bytes at the exact sealed sequence path reject loudly.
    const conflict = await publishCreateOnlyAtomic({ path: target, authorityRoot: evidenceRoot, bytes: new TextEncoder().encode('{"a":2}\n') });
    assert.equal(conflict.status, 'conflict');
  });

  void it('rejects a symlinked parent segment in the authority root (no-alias)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'd65-atomicsym-')));
    const realRoot = join(root, 'real'); mkdirSync(realRoot, { recursive: true, mode: 0o700 });
    const linkRoot = join(root, 'link'); await symlinkAsync(realRoot, linkRoot);
    // Publishing through a symlinked authority root path must reject.
    await assert.rejects(() => publishCreateOnlyAtomic({ path: join(linkRoot, 'sub', 'x.json'), authorityRoot: linkRoot, bytes: new TextEncoder().encode('{}\n') }), /symlink|unsafe|escapes/u);
  });
});
