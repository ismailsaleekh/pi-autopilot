import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import { AUTOPILOT_COORDINATOR_PROTOCOL_VERSION, type CoordinatorRequestEnvelope } from '../../src/core/coordination/types.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Autopilot Test', GIT_AUTHOR_EMAIL: 'autopilot@example.invalid', GIT_COMMITTER_NAME: 'Autopilot Test', GIT_COMMITTER_EMAIL: 'autopilot@example.invalid' } });
  if ((result.status ?? -1) !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function sha256(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

const OID = (c: string): string => c.repeat(40);
const DIGEST = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}` as const;

function launchPolicy(run: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'autopilot.launch_policy.v1', program_id: 'program-1', policy_id: 'policy-1', policy_version: 1,
    repo_id: 'repo-lp-crash', workstream_run: run, package_commit: OID('a'), package_tree: OID('b'), base_commit: OID('c'), base_tree: OID('d'),
    bootstrap_graph_sha256: DIGEST('e'), bootstrap_receipt_event_seq: 1, roster_sha256: DIGEST('f'),
    parallel_cap: 1, maximum_parallel_cap: 1, expected_checkout_units: 1,
    program_evidence_root: '/var/evidence/program-1', trust_anchor_ref: '.pi/autopilot-trust/d65/program-1/operator-ed25519.spki', trust_anchor_sha256: DIGEST('0'),
    prior_policy_sha256: null, capacity_decision_ref: null, capacity_decision_sha256: null, issued_at: '2026-07-19T00:00:00.000Z', signer_key_id: DIGEST('1'), signature: 'abcABC_-', ...overrides,
  };
}

interface Setup {
  readonly repoRoot: string;
  readonly env: Record<string, string | undefined>;
  readonly paths: ReturnType<typeof coordinatorRuntimePaths>;
  readonly repoId: string;
  readonly runId: string;
}

async function setup(root: string, suffix: string): Promise<Setup> {
  const repoRoot = join(root, 'repo');
  await mkdir(join(repoRoot, 'authority', 'launch-policies'), { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  await writeFile(join(repoRoot, 'README.md'), 'base\n', 'utf8');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'base']);
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') };
  return { repoRoot, env, paths: coordinatorRuntimePaths(env), repoId: 'repo-lp-crash', runId: `run-${suffix}` };
}

function attachRequest(s: Setup): CoordinatorRequestEnvelope {
  return {
    schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
    request_id: 'attach', action: 'attach-run', idempotency_key: 'attach', repo_id: s.repoId, workstream_run: s.runId,
    session_id: null, fencing_generation: null, expected_version: 0,
    payload: { repo_key: s.repoId, canonical_root: s.repoRoot, git_common_dir: join(s.repoRoot, '.git'), autopilot_id: 'autopilot-1', workstream: 'work-1', coordination_authority: 'coordinator-edit-leases-v1', run_resource: {
      schema_version: 'autopilot.coordination_run_resource.v1', repo_id: s.repoId, workstream_run: s.runId, source_repo: s.repoRoot, git_common_dir: join(s.repoRoot, '.git'), worktree_root: join(s.repoRoot, 'wt'),
      main_worktree_path: join(s.repoRoot, 'wt', 'main'), runtime_root: join(s.repoRoot, 'wt', 'main', '.pi', 'autopilot', 'work-1'), branch: 'autopilot/run', target_branch: null, target_base_sha: OID('0'), origin_url: null, started_at: '2026-07-19T00:00:00.000Z', version: 1,
    } },
  };
}

function sessionRequest(s: Setup, version: number): CoordinatorRequestEnvelope {
  return {
    schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
    request_id: 'session', action: 'attach-session', idempotency_key: 'session', repo_id: s.repoId, workstream_run: s.runId,
    session_id: 'session-1', fencing_generation: 1, expected_version: version,
    payload: { session_lease_id: 'lease-1', session_token: 'a'.repeat(64), pid: process.pid, boot_id: 'boot-1', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null },
  };
}

function registerRequest(s: Setup, version: number, ref: string, digest: `sha256:${string}`, head: string): CoordinatorRequestEnvelope {
  return {
    schema_version: 'autopilot.coordinator_request.v1', protocol_version: AUTOPILOT_COORDINATOR_PROTOCOL_VERSION,
    request_id: 'register', action: 'register-authoritative-artifact', idempotency_key: 'register-policy', repo_id: s.repoId, workstream_run: s.runId,
    session_id: 'session-1', fencing_generation: 1, expected_version: version,
    payload: { artifact_id: 'launch-policy-policy-1', source_type: 'task', source_scope: 'repository', document_schema_version: 'autopilot.launch_policy.v1', git_commit: head, ref, sha256: digest, session_lease_id: 'lease-1', session_token: 'a'.repeat(64) },
  };
}

void describe('D65 launch policy registration crash-safe replay', () => {
  void it('replays the exact registered policy artifact across store reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-lp-crash-'));
    try {
      const s = await setup(root, 'ok');
      const policyBytes = `${JSON.stringify(launchPolicy(s.runId), null, 2)}\n`;
      await writeFile(join(s.repoRoot, 'authority', 'launch-policies', 'policy-1.json'), policyBytes, 'utf8');
      git(s.repoRoot, ['add', '.']);
      git(s.repoRoot, ['commit', '-m', 'policy']);
      const head = git(s.repoRoot, ['rev-parse', 'HEAD']);

      let committed: string;
      const store = await CoordinatorStore.open(s.paths, { now: () => new Date('2026-07-19T00:00:00.000Z') });
      try {
        assert.equal(store.handle(attachRequest(s)).ok, true);
        const session = store.handle(sessionRequest(s, 1));
        assert.equal(session.ok, true);
        const runVersion = (session.payload['run'] as Record<string, unknown>)['version'] as number;
        const registered = store.handle(registerRequest(s, runVersion, 'authority/launch-policies/policy-1.json', sha256(policyBytes), head));
        assert.equal(registered.ok, true);
        committed = canonicalJson(registered.payload);
      } finally { store.close(); }

      const reopened = await CoordinatorStore.open(s.paths, { now: () => new Date('2026-07-19T00:01:00.000Z') });
      try {
        const runs = reopened.status(s.repoId, s.runId).payload['runs'] as Array<Record<string, unknown>>;
        const runRow = runs[0];
        if (runRow === undefined) throw new Error('run row missing after reopen');
        const runVersion = runRow['version'] as number;
        const replay = reopened.handle(registerRequest(s, runVersion, 'authority/launch-policies/policy-1.json', sha256(policyBytes), head));
        assert.equal(canonicalJson(replay.payload), committed, 'policy registration replay must be byte-identical');
        const database = new DatabaseSync(reopened.currentGeneration().database_path, { readOnly: true });
        try {
          assert.equal(database.prepare('SELECT COUNT(*) AS count FROM authoritative_artifacts WHERE repo_id=? AND entity_id=?').get(s.repoId, 'launch-policy-policy-1')?.['count'], 1);
        } finally { database.close(); }
      } finally { reopened.close(); }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('rolls back a malformed policy registration leaving no artifact across reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-lp-crash-bad-'));
    try {
      const s = await setup(root, 'bad');
      const badBytes = `${JSON.stringify(launchPolicy(s.runId, { parallel_cap: 2 }), null, 2)}\n`;
      await writeFile(join(s.repoRoot, 'authority', 'launch-policies', 'policy-1.json'), badBytes, 'utf8');
      git(s.repoRoot, ['add', '.']);
      git(s.repoRoot, ['commit', '-m', 'bad policy']);
      const head = git(s.repoRoot, ['rev-parse', 'HEAD']);

      const store = await CoordinatorStore.open(s.paths, { now: () => new Date('2026-07-19T00:00:00.000Z') });
      try {
        assert.equal(store.handle(attachRequest(s)).ok, true);
        const session = store.handle(sessionRequest(s, 1));
        const runVersion = (session.payload['run'] as Record<string, unknown>)['version'] as number;
        const rejected = store.handle(registerRequest(s, runVersion, 'authority/launch-policies/policy-1.json', sha256(badBytes), head));
        assert.equal(rejected.ok, false);
        assert.match(String((rejected.payload as Record<string, unknown>)['message']), /not schema-valid|parallel_cap must be exactly 1/u);
      } finally { store.close(); }

      const reopened = await CoordinatorStore.open(s.paths, { now: () => new Date('2026-07-19T00:01:00.000Z') });
      try {
        const database = new DatabaseSync(reopened.currentGeneration().database_path, { readOnly: true });
        try {
          assert.equal(database.prepare('SELECT COUNT(*) AS count FROM authoritative_artifacts WHERE repo_id=?').get(s.repoId)?.['count'], 0);
        } finally { database.close(); }
      } finally { reopened.close(); }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
