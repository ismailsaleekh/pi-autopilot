import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import {
  parseD65AttachRunResultV2,
} from '../../src/core/coordination/d65-semantic-graph.ts';
import { D65_ALLOWED_BOOTSTRAP_OPERATIONS } from '../../src/core/coordination/d65-semantic-graph.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

interface Harness {
  readonly root: string;
  readonly repository: string;
  readonly stateRoot: string;
  readonly env: ProcessEnvLike;
  readonly server: Awaited<ReturnType<typeof startCoordinatorServer>>;
  readonly client: CoordinatorClient;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Autopilot Test', GIT_AUTHOR_EMAIL: 'autopilot@example.invalid', GIT_COMMITTER_NAME: 'Autopilot Test', GIT_COMMITTER_EMAIL: 'autopilot@example.invalid' } });
  if ((result.status ?? -1) !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function sha256(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-graph-authority-'));
  const repository = join(root, 'repository');
  await mkdir(repository, { recursive: true });
  git(repository, ['init', '-b', 'main']);
  await writeFile(join(repository, 'README.md'), 'content-result\n', 'utf8');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'content-result']);
  const stateRoot = join(root, 'state');
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
  return { root, repository, stateRoot, env, server, client: new CoordinatorClient({ env, autoStart: false }) };
}

interface BootstrapFixture {
  readonly repoId: string;
  readonly workstreamRun: string;
  readonly runResource: Readonly<Record<string, unknown>>;
  readonly attachPayload: Readonly<Record<string, unknown>>;
  readonly contentCommit: string;
  readonly bootstrapCommit: string;
}

/**
 * Commit the trust SPKI blob and a matching bootstrap envelope on a bootstrap
 * branch, and return the attach-run payload whose prospective run/resource
 * byte-equal the rows the transaction will create (created_event_seq=1).
 */
async function buildBootstrap(harness: Harness, suffix: string): Promise<BootstrapFixture> {
  const repoId = `graph-repo-${suffix}`;
  const workstreamRun = `run-${suffix}`;
  const autopilotId = `autopilot-${suffix}`;
  const workstream = `work-${suffix}`;
  const contentCommit = git(harness.repository, ['rev-parse', 'HEAD']);
  const contentTree = git(harness.repository, ['rev-parse', 'HEAD^{tree}']);
  const packageCommit = 'a'.repeat(40);
  const packageTree = 'b'.repeat(40);

  const runResource: Readonly<Record<string, unknown>> = {
    schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: workstreamRun,
    source_repo: harness.repository, git_common_dir: join(harness.repository, '.git'), worktree_root: join(harness.stateRoot, 'worktrees', repoId),
    main_worktree_path: join(harness.stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main'), runtime_root: join(harness.stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main', '.pi', 'autopilot', workstream),
    branch: `autopilot/${workstreamRun}`, target_branch: 'main', target_base_sha: contentCommit, origin_url: null,
    started_at: '2026-07-19T00:00:00.000Z', version: 1,
  };
  // The exact run row the transaction creates at B=1.
  const prospectiveRun: Readonly<Record<string, unknown>> = {
    schema_version: 'autopilot.coordination_run.v1', repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: workstreamRun,
    coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 0, created_event_seq: 1, version: 1,
  };

  // Operator trust anchor: 44-byte canonical Ed25519 SPKI.
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }) as unknown as Uint8Array);
  const trustRef = `.pi/autopilot-trust/d65/program-${suffix}/operator-ed25519.spki`;
  const trustSha256 = `sha256:${createHash('sha256').update(spki).digest('hex')}` as `sha256:${string}`;

  const bootstrapRef = `.pi/autopilot-bootstrap/${workstreamRun}/bootstrap.json`;
  const bootstrap = {
    schema_version: 'autopilot.semantic_graph_bootstrap.v1', program_id: `program-${suffix}`, graph_sequence: 1, prior_graph_sha256: null,
    repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: workstreamRun,
    run_timestamp: '2026-07-19T00:00:00.000Z', run_nonce: 'abcdef',
    content_commit: contentCommit, content_tree: contentTree, package_commit: packageCommit, package_tree: packageTree,
    prospective_run: prospectiveRun, prospective_resource: runResource, covered_event_seq: 0,
    trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256,
    allowed_bootstrap_operations: [...D65_ALLOWED_BOOTSTRAP_OPERATIONS], created_at: '2026-07-19T00:00:01.000Z',
  };
  const bootstrapBytes = `${JSON.stringify(bootstrap, null, 2)}\n`;
  const bootstrapSha256 = sha256(bootstrapBytes);

  // Commit the trust anchor and bootstrap envelope on a bootstrap branch.
  git(harness.repository, ['checkout', '-b', `autopilot/bootstrap/${workstreamRun}`, contentCommit]);
  await mkdir(join(harness.repository, `.pi/autopilot-trust/d65/program-${suffix}`), { recursive: true });
  await writeFile(join(harness.repository, trustRef), spki);
  await mkdir(join(harness.repository, `.pi/autopilot-bootstrap/${workstreamRun}`), { recursive: true });
  await writeFile(join(harness.repository, bootstrapRef), bootstrapBytes, 'utf8');
  git(harness.repository, ['add', '.']);
  git(harness.repository, ['commit', '-m', 'bootstrap overlay']);
  const bootstrapCommit = git(harness.repository, ['rev-parse', 'HEAD']);
  git(harness.repository, ['checkout', 'main']);

  const attachPayload = {
    repo_key: repoId, canonical_root: harness.repository, git_common_dir: join(harness.repository, '.git'),
    autopilot_id: autopilotId, workstream, coordination_authority: 'coordinator-edit-leases-v1', run_resource: runResource,
    bootstrap_graph: {
      schema_version: 'autopilot.semantic_graph_bootstrap.v1', ref: bootstrapRef, sha256: bootstrapSha256, byte_count: Buffer.byteLength(bootstrapBytes, 'utf8'),
      git_commit: bootstrapCommit, covered_event_seq: 0, prospective_run: prospectiveRun, prospective_resource: runResource,
      trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256,
    },
  };
  return { repoId, workstreamRun, runResource, attachPayload, contentCommit, bootstrapCommit };
}

void describe('D65 semantic-graph bootstrap attach-run transaction', () => {
  void it('atomically attaches a fresh D65 run and returns attach_run_result.v2', async () => {
    const harness = await createHarness();
    try {
      const fixture = await buildBootstrap(harness, 'a');
      const response = await harness.client.mutate('attach-run', {
        repoId: fixture.repoId, workstreamRun: fixture.workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-a',
      }, fixture.attachPayload);
      // The response envelope adds event metadata around the effect payload.
      const { event_type, entity_type, entity_id, ...effect } = response.payload as Record<string, unknown>;
      assert.equal(event_type, 'run-attached');
      assert.equal(entity_type, 'run');
      assert.equal(entity_id, fixture.workstreamRun);
      const result = parseD65AttachRunResultV2(effect);
      assert.equal(response.committed_event_seq, 1);
      assert.equal(result.bootstrap_graph.covered_event_seq, 0);
      assert.equal(result.trust_anchor.byte_count, 44);
      assert.equal(result.bootstrap_artifact['artifact_id'], `semantic-graph-bootstrap:${fixture.workstreamRun}`);
      assert.equal(result.bootstrap_artifact['registered_event_seq'], 1);
      assert.equal(result.run['created_event_seq'], 1);
      // Status reflects the created rows.
      const status = await harness.client.query('status', fixture.repoId, fixture.workstreamRun);
      assert.equal(Array.isArray(status.payload['runs']), true);
    } finally {
      await harness.server.close();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  void it('preserves legacy attach bytes and rejects a D65 bootstrap into a pre-existing repository', async () => {
    const harness = await createHarness();
    try {
      const fixture = await buildBootstrap(harness, 'legacy');
      // A legacy (non-bootstrap) attach-run in the SAME repo creates the
      // repository row first and keeps the old `{run}` result bytes.
      const legacyResource = {
        ...fixture.runResource, workstream_run: 'run-legacy-pre',
        main_worktree_path: join(harness.stateRoot, 'worktrees', fixture.repoId, 'active', 'run-legacy-pre', 'main'),
        runtime_root: join(harness.stateRoot, 'worktrees', fixture.repoId, 'active', 'run-legacy-pre', 'main', '.pi', 'autopilot', 'work-legacy'),
        branch: 'autopilot/run-legacy-pre',
      };
      const legacy = await harness.client.mutate('attach-run', {
        repoId: fixture.repoId, workstreamRun: 'run-legacy-pre', sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-legacy',
      }, {
        repo_key: fixture.repoId, canonical_root: harness.repository, git_common_dir: join(harness.repository, '.git'),
        autopilot_id: 'autopilot-legacy', workstream: 'work-legacy', coordination_authority: 'coordinator-edit-leases-v1', run_resource: legacyResource,
      });
      // Legacy omission keeps the old `{run}` result bytes with no D65 additions.
      assert.equal(legacy.payload['run'] !== undefined, true);
      assert.equal(legacy.payload['bootstrap_graph'], undefined);
      assert.equal(legacy.payload['trust_anchor'], undefined);
      assert.equal(legacy.payload['bootstrap_artifact'], undefined);

      // A D65 bootstrap into that same (now pre-existing) repository rejects.
      await assert.rejects(
        () => harness.client.mutate('attach-run', { repoId: fixture.repoId, workstreamRun: fixture.workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-legacy-2' }, fixture.attachPayload),
        /fresh empty coordinator repository/u,
      );
    } finally {
      await harness.server.close();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  void it('rejects a bootstrap whose committed digest does not match the blob', async () => {
    const harness = await createHarness();
    try {
      const fixture = await buildBootstrap(harness, 'digest');
      const bootstrapGraph = { ...(fixture.attachPayload['bootstrap_graph'] as Record<string, unknown>), sha256: `sha256:${'0'.repeat(64)}` };
      const payload = { ...fixture.attachPayload, bootstrap_graph: bootstrapGraph };
      await assert.rejects(
        () => harness.client.mutate('attach-run', { repoId: fixture.repoId, workstreamRun: fixture.workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-digest' }, payload),
        /sha256 does not match the committed blob/u,
      );
      // No repository/run rows leaked from the rolled-back transaction.
      const catalog = await harness.client.query('run-catalog', fixture.repoId, null);
      const runs = catalog.payload['runs'];
      assert.equal(Array.isArray(runs) && runs.length === 0, true);
    } finally {
      await harness.server.close();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  void it('rejects a prospective_run that does not byte-equal the created row', async () => {
    const harness = await createHarness();
    try {
      const fixture = await buildBootstrap(harness, 'prospective');
      const bootstrapGraph = fixture.attachPayload['bootstrap_graph'] as Record<string, unknown>;
      const badProspective = { ...(bootstrapGraph['prospective_run'] as Record<string, unknown>), created_event_seq: 2 };
      const payload = { ...fixture.attachPayload, bootstrap_graph: { ...bootstrapGraph, prospective_run: badProspective } };
      await assert.rejects(
        () => harness.client.mutate('attach-run', { repoId: fixture.repoId, workstreamRun: fixture.workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-prospective' }, payload),
        /prospective_run does not byte-equal/u,
      );
    } finally {
      await harness.server.close();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  void it('idempotently replays the exact bootstrap effect for the same request', async () => {
    const harness = await createHarness();
    try {
      const fixture = await buildBootstrap(harness, 'replay');
      const first = await harness.client.mutate('attach-run', { repoId: fixture.repoId, workstreamRun: fixture.workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-replay' }, fixture.attachPayload);
      const second = await harness.client.mutate('attach-run', { repoId: fixture.repoId, workstreamRun: fixture.workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-replay' }, fixture.attachPayload);
      assert.equal(canonicalJson(first.payload), canonicalJson(second.payload));
    } finally {
      await harness.server.close();
      await rm(harness.root, { recursive: true, force: true });
    }
  });
});
