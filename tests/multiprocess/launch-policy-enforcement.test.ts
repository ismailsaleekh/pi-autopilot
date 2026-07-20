import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationRun, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { PlanningContradictionClient } from '../../src/core/coordination/escalation.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import type { CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';

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

interface Actor {
  readonly context: CoordinatorSessionContext;
}

async function attachActor(client: CoordinatorClient, stateRoot: string, repoRoot: string, suffix: string): Promise<Actor> {
  const repoId = 'repo-launch-policy';
  const workstreamRun = `run-${suffix}`;
  const runResponse = await client.mutate('attach-run', { repoId, workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `attach-run-${suffix}` }, {
    repo_key: repoId, canonical_root: repoRoot, git_common_dir: join(repoRoot, '.git'), autopilot_id: `autopilot-${suffix}`, workstream: `work-${suffix}`, coordination_authority: 'coordinator-edit-leases-v1',
    run_resource: {
      schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: workstreamRun,
      source_repo: repoRoot, git_common_dir: join(repoRoot, '.git'), worktree_root: join(stateRoot, 'worktrees', repoId),
      main_worktree_path: join(stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main'), runtime_root: join(stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main', '.pi', 'autopilot', `work-${suffix}`),
      branch: `autopilot/${workstreamRun}`, target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null, started_at: '2026-07-12T00:00:00.000Z', version: 1,
    },
  });
  const run = parseCoordinationRun(runResponse.payload['run']);
  const token = suffix.charCodeAt(0).toString(16).repeat(64).slice(0, 64);
  const sessionResponse = await client.mutate('attach-session', { repoId, workstreamRun: run.workstream_run, sessionId: `session-${suffix}`, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: `attach-session-${suffix}` }, {
    session_lease_id: `session-lease-${suffix}`, session_token: token, pid: process.pid, boot_id: `boot-${suffix}`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null,
  });
  const attachedRun = parseCoordinationRun(sessionResponse.payload['run']);
  const session = parseCoordinationSessionLease(sessionResponse.payload['session']);
  const context: CoordinatorSessionContext = {
    schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: repoId, repo_key: repoId, autopilot_id: attachedRun.autopilot_id,
    workstream: attachedRun.workstream, workstream_run: attachedRun.workstream_run, session_id: session.session_id, session_generation: session.session_generation,
    run_version: attachedRun.version, session_lease_id: session.session_lease_id, session_token: token, session_version: session.version, pid: session.pid, boot_id: session.boot_id,
  };
  return { context };
}

function launchPolicy(run: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'autopilot.launch_policy.v1', program_id: 'program-1', policy_id: 'policy-1', policy_version: 1,
    repo_id: 'repo-launch-policy', workstream_run: run, package_commit: OID('a'), package_tree: OID('b'), base_commit: OID('c'), base_tree: OID('d'),
    bootstrap_graph_sha256: DIGEST('e'), bootstrap_receipt_event_seq: 1, roster_sha256: DIGEST('f'),
    parallel_cap: 1, maximum_parallel_cap: 1, expected_checkout_units: 1,
    program_evidence_root: '/var/evidence/program-1', trust_anchor_ref: '.pi/autopilot-trust/d65/program-1/operator-ed25519.spki', trust_anchor_sha256: DIGEST('0'),
    prior_policy_sha256: null, capacity_decision_ref: null, capacity_decision_sha256: null, issued_at: '2026-07-19T00:00:00.000Z', signer_key_id: DIGEST('1'), signature: 'abcABC_-', ...overrides,
  };
}

void describe('D65 launch policy registration and strict validation', () => {
  void it('registers a valid cap-one launch policy through the existing authoritative-artifact action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-launch-policy-'));
    const repoRoot = join(root, 'repo');
    await mkdir(join(repoRoot, 'authority', 'launch-policies'), { recursive: true });
    git(repoRoot, ['init', '-b', 'main']);
    const stateRoot = join(root, 'state');
    const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const actor = await attachActor(client, stateRoot, repoRoot, 'a');
      const policyBytes = `${JSON.stringify(launchPolicy(actor.context.workstream_run), null, 2)}\n`;
      await writeFile(join(repoRoot, 'authority', 'launch-policies', 'policy-1.json'), policyBytes, 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'register launch policy']);
      const head = git(repoRoot, ['rev-parse', 'HEAD']);
      const arbiter = new PlanningContradictionClient(client, actor.context);
      const artifact = await arbiter.registerAuthoritativeArtifact({
        artifactId: 'launch-policy-policy-1', sourceType: 'task', sourceScope: 'repository',
        documentSchemaVersion: 'autopilot.launch_policy.v1', gitCommit: head,
        evidence: { ref: 'authority/launch-policies/policy-1.json', sha256: sha256(policyBytes) },
      });
      assert.equal(artifact.document_schema_version, 'autopilot.launch_policy.v1');
      assert.equal(artifact.source_type, 'task');
      assert.equal(artifact.source_scope, 'repository');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('rejects a malformed launch policy (cap not exactly 1) at the authoritative-document boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-launch-policy-bad-'));
    const repoRoot = join(root, 'repo');
    await mkdir(join(repoRoot, 'authority', 'launch-policies'), { recursive: true });
    git(repoRoot, ['init', '-b', 'main']);
    const stateRoot = join(root, 'state');
    const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const actor = await attachActor(client, stateRoot, repoRoot, 'b');
      const badBytes = `${JSON.stringify(launchPolicy(actor.context.workstream_run, { parallel_cap: 2 }), null, 2)}\n`;
      await writeFile(join(repoRoot, 'authority', 'launch-policies', 'policy-1.json'), badBytes, 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'malformed launch policy']);
      const head = git(repoRoot, ['rev-parse', 'HEAD']);
      const arbiter = new PlanningContradictionClient(client, actor.context);
      await assert.rejects(
        () => arbiter.registerAuthoritativeArtifact({
          artifactId: 'launch-policy-policy-bad', sourceType: 'task', sourceScope: 'repository',
          documentSchemaVersion: 'autopilot.launch_policy.v1', gitCommit: head,
          evidence: { ref: 'authority/launch-policies/policy-1.json', sha256: sha256(badBytes) },
        }),
        /parallel_cap must be exactly 1|not schema-valid/u,
      );
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
