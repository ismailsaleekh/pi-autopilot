import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseD65LaunchManifest } from '../../src/core/coordination/d65-launch-manifest.ts';

const OID = (c: string): string => c.repeat(40);
const DIGEST = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}` as const;

const CLONE = '/private/tmp/kbg/clone';
const STATE_ROOT = '/private/tmp/kbg/state';
const SESSION_ROOT = '/private/tmp/kbg/sessions';
const WORKTREE_ROOT = '/private/tmp/kbg/state/worktrees/repo-kbg';
const MAIN = '/private/tmp/kbg/state/worktrees/repo-kbg/active/kbg-run/main';
const RUNTIME = `${MAIN}/.pi/autopilot/kbg`;
const EVIDENCE = '/private/tmp/kbg-evidence';

function prospectiveRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'autopilot.coordination_run.v1', repo_id: 'repo-kbg', autopilot_id: 'ap-kbg',
    workstream: 'kbg', workstream_run: 'kbg-run', coordination_authority: 'coordinator-edit-leases-v1',
    status: 'active', active_session_generation: 0, created_event_seq: 1, version: 1, ...overrides,
  };
}

function prospectiveResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'autopilot.coordination_run_resource.v1', repo_id: 'repo-kbg', workstream_run: 'kbg-run',
    source_repo: CLONE, git_common_dir: `${CLONE}/.git`, worktree_root: WORKTREE_ROOT,
    main_worktree_path: MAIN, runtime_root: RUNTIME, branch: 'autopilot/kbg-run', target_branch: 'main',
    target_base_sha: OID('c'), origin_url: null, started_at: '2026-07-22T22:00:32.000Z', version: 1, ...overrides,
  };
}

function manifestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'autopilot.launch_manifest.v1', manifest_id: 'launch-kbg-1', program_id: 'program-kbg',
    workstream: 'kbg', workstream_run: 'kbg-run', autopilot_id: 'ap-kbg',
    run_timestamp: '2026-07-22T22:00:32.000Z', run_nonce: 'abc123',
    source_clone: CLONE, canonical_root: CLONE, git_common_dir: `${CLONE}/.git`, repo_id: 'repo-kbg', repo_key: 'repo-kbg',
    b0_commit: OID('b'), b0_tree: OID('e'), content_result_commit: OID('c'), content_result_tree: OID('d'),
    package_commit: OID('a'), package_tree: OID('f'), run_branch: 'autopilot/kbg-run', target_branch: 'main',
    state_root: STATE_ROOT, session_root: SESSION_ROOT, worktree_root: WORKTREE_ROOT, main_worktree_path: MAIN, runtime_root: RUNTIME,
    bootstrap_overlay: { overlay_commit: OID('1'), overlay_tree: OID('2'), overlay_ref: 'refs/heads/autopilot/bootstrap/kbg-run', bootstrap_ref: '.pi/autopilot-bootstrap/kbg-run/bootstrap.json', bootstrap_sha256: DIGEST('9'), bootstrap_byte_count: 812 },
    trust_anchor: { trust_anchor_ref: '.pi/autopilot-trust/d65/program-kbg/operator-ed25519.spki', trust_anchor_sha256: DIGEST('8'), trust_anchor_blob_oid: OID('7'), byte_count: 44 },
    prospective_run: prospectiveRun(), prospective_resource: prospectiveResource(),
    coordination_authority: 'coordinator-edit-leases-v1',
    roster_authority: 'user-default', roster_selection_ref: 'roster-selections/repo-kbg/kbg-run.json', roster_sha256: DIGEST('6'),
    policy_candidate: { policy_id: 'policy-1', policy_ref: 'authority/launch-policies/policy-1.json', policy_sha256: DIGEST('5'), registration_idempotency_key: 'register-launch-policy:kbg-run:policy-1', heartbeat_acceptance_idempotency_key: 'accept-program-heartbeat:kbg-run:1' },
    program_evidence_root: EVIDENCE,
    launch_seal: { launch_commit: OID('1'), launch_tree: OID('2'), launch_audit_ref: '/private/tmp/kbg-evidence/launch-audit/kbg-run.json', launch_audit_sha256: DIGEST('4'), launch_seal_sha256: DIGEST('3'), bootstrap_projection_ref: '/private/tmp/kbg-evidence/bootstrap-projections/kbg-run/00000000000000000001.json', bootstrap_projection_sha256: DIGEST('0') },
    attach_run_idempotency_key: 'attach-run:repo-kbg:kbg-run', attach_session_idempotency_key: 'attach-session:repo-kbg:kbg-run',
    created_at: '2026-07-22T22:00:33.000Z', ...overrides,
  };
}

void describe('autopilot.launch_manifest.v1 closed parser', () => {
  void it('accepts a fully sealed, internally consistent manifest', () => {
    const manifest = parseD65LaunchManifest(manifestFixture());
    assert.equal(manifest.workstream_run, 'kbg-run');
    assert.equal(manifest.run_nonce, 'abc123');
    assert.equal(manifest.prospective_resource['target_base_sha'], OID('c'));
    assert.equal(manifest.bootstrap_overlay.overlay_commit, OID('1'));
  });

  void it('rejects unknown fields with no tolerance', () => {
    assert.throws(() => parseD65LaunchManifest(manifestFixture({ extra_field: 'nope' })), /unknown fields/u);
  });

  void it('rejects a missing required field', () => {
    const fixture = manifestFixture();
    delete (fixture as Record<string, unknown>)['run_nonce'];
    assert.throws(() => parseD65LaunchManifest(fixture), /missing required fields/u);
  });

  void it('rejects a run_nonce that is not exactly six lowercase hex characters', () => {
    assert.throws(() => parseD65LaunchManifest(manifestFixture({ run_nonce: 'ABC123' })), /run_nonce/u);
    assert.throws(() => parseD65LaunchManifest(manifestFixture({ run_nonce: 'abc12' })), /run_nonce/u);
  });

  void it('rejects target_base_sha that is B0 instead of the content result', () => {
    assert.throws(() => parseD65LaunchManifest(manifestFixture({ prospective_resource: prospectiveResource({ target_base_sha: OID('b') }) })), /target_base_sha/u);
  });

  void it('rejects an overlay commit equal to B0 or the content result', () => {
    assert.throws(() => parseD65LaunchManifest(manifestFixture({ bootstrap_overlay: { overlay_commit: OID('b'), overlay_tree: OID('2'), overlay_ref: 'refs/heads/autopilot/bootstrap/kbg-run', bootstrap_ref: '.pi/autopilot-bootstrap/kbg-run/bootstrap.json', bootstrap_sha256: DIGEST('9'), bootstrap_byte_count: 812 }, launch_seal: { launch_commit: OID('b'), launch_tree: OID('2'), launch_audit_ref: '/private/tmp/kbg-evidence/launch-audit/kbg-run.json', launch_audit_sha256: DIGEST('4'), launch_seal_sha256: DIGEST('3'), bootstrap_projection_ref: '/private/tmp/kbg-evidence/bootstrap-projections/kbg-run/00000000000000000001.json', bootstrap_projection_sha256: DIGEST('0') } })), /sibling/u);
  });

  void it('rejects a program evidence root inside the source clone', () => {
    assert.throws(() => parseD65LaunchManifest(manifestFixture({ program_evidence_root: `${CLONE}/evidence` })), /authority-distinct|outside the source clone/u);
  });

  void it('rejects a state root inside the source clone', () => {
    assert.throws(() => parseD65LaunchManifest(manifestFixture({ state_root: `${CLONE}/state` })), /outside the source clone/u);
  });

  void it('rejects a prospective run whose workstream_run diverges from the sealed identity', () => {
    assert.throws(() => parseD65LaunchManifest(manifestFixture({ prospective_run: prospectiveRun({ workstream_run: 'other-run' }) })), /workstream_run/u);
  });

  void it('rejects a non-canonical digest', () => {
    assert.throws(() => parseD65LaunchManifest(manifestFixture({ roster_sha256: 'deadbeef' })), /roster_sha256/u);
  });

  void it('rejects a launch_commit that is not the bootstrap overlay commit', () => {
    assert.throws(() => parseD65LaunchManifest(manifestFixture({ launch_seal: { launch_commit: OID('3'), launch_tree: OID('2'), launch_audit_ref: '/private/tmp/kbg-evidence/launch-audit/kbg-run.json', launch_audit_sha256: DIGEST('4'), launch_seal_sha256: DIGEST('3'), bootstrap_projection_ref: '/private/tmp/kbg-evidence/bootstrap-projections/kbg-run/00000000000000000001.json', bootstrap_projection_sha256: DIGEST('0') } })), /launch_commit/u);
  });

  void it('rejects a non-D65 coordination authority', () => {
    assert.throws(() => parseD65LaunchManifest(manifestFixture({ coordination_authority: 'legacy-path-claims-v1' })), /coordination_authority/u);
  });
});
