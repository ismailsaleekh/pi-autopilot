import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { parseCoordinationRun, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import {
  parseD65AttachRunResultV2,
  parseD65RunTerminalIntentV2,
} from '../../src/core/coordination/d65-semantic-graph.ts';
import { D65_ALLOWED_BOOTSTRAP_OPERATIONS } from '../../src/core/coordination/d65-semantic-graph.ts';
import { d65TerminalIntentId } from '../../src/core/coordination/d65-terminal-intent.ts';
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
const EMPTY_EFFECT_SETS = { blocking_owned_obligations: [], foreign_dependent_obligations: [], abort_owned_obligations: [], other_nonterminal_obligations: [] };

interface Ctx {
  readonly client: CoordinatorClient;
  readonly repoId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly sessionLeaseId: string;
  readonly sessionToken: string;
  runVersion: number;
}

async function attach(client: CoordinatorClient, stateRoot: string, repoRoot: string, suffix: string): Promise<Ctx> {
  const repoId = 'repo-terminal-v2';
  const runId = `run-${suffix}`;
  const runResponse = await client.mutate('attach-run', { repoId, workstreamRun: runId, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `attach-run-${suffix}` }, {
    repo_key: repoId, canonical_root: repoRoot, git_common_dir: join(repoRoot, '.git'), autopilot_id: `autopilot-${suffix}`, workstream: `work-${suffix}`, coordination_authority: 'coordinator-edit-leases-v1',
    run_resource: {
      schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: runId, source_repo: repoRoot, git_common_dir: join(repoRoot, '.git'), worktree_root: join(stateRoot, 'wt', repoId),
      main_worktree_path: join(stateRoot, 'wt', repoId, 'active', runId, 'main'), runtime_root: join(stateRoot, 'wt', repoId, 'active', runId, 'main', '.pi', 'autopilot', `work-${suffix}`),
      branch: `autopilot/${runId}`, target_branch: null, target_base_sha: '0'.repeat(40), origin_url: null, started_at: '2026-07-12T00:00:00.000Z', version: 1,
    },
  });
  const run = parseCoordinationRun(runResponse.payload['run']);
  const token = createHash('sha256').update(suffix).digest('hex');
  const sessionResponse = await client.mutate('attach-session', { repoId, workstreamRun: runId, sessionId: `session-${suffix}`, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: `attach-session-${suffix}` }, {
    session_lease_id: `session-lease-${suffix}`, session_token: token, pid: process.pid, boot_id: `boot-${suffix}`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null,
  });
  const attachedRun = parseCoordinationRun(sessionResponse.payload['run']);
  const session = parseCoordinationSessionLease(sessionResponse.payload['session']);
  return { client, repoId, runId, sessionId: session.session_id, sessionLeaseId: session.session_lease_id, sessionToken: token, runVersion: attachedRun.version };
}

async function prepareV2(ctx: Ctx, attempt: number, outcome: 'closed' | 'aborted', priorId: string | null, priorSha: `sha256:${string}` | null): Promise<ReturnType<typeof parseD65RunTerminalIntentV2>> {
  const response = await ctx.client.mutate('prepare-run-terminal', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: ctx.runVersion, idempotencyKey: `prepare-v2-${attempt}` }, {
    outcome, terminal_intent_id: d65TerminalIntentId(ctx.runId, attempt), session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
    intent_attempt: attempt, prior_terminal_intent_id: priorId, prior_terminal_intent_sha256: priorSha, terminal_effect_sets: EMPTY_EFFECT_SETS,
  });
  const intent = parseD65RunTerminalIntentV2(response.payload['run_terminal_intent']);
  ctx.runVersion = parseCoordinationRun(response.payload['run']).version;
  return intent;
}

async function cancelV2(ctx: Ctx, intent: ReturnType<typeof parseD65RunTerminalIntentV2>): Promise<void> {
  const response = await ctx.client.mutate('cancel-run-terminal', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: intent.version, idempotencyKey: `cancel-v2-${intent.intent_attempt}` }, {
    terminal_intent_id: intent.terminal_intent_id, reason: 'operator re-plan', session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
  });
  ctx.runVersion = parseCoordinationRun(response.payload['run']).version;
}

function digestOf(intent: ReturnType<typeof parseD65RunTerminalIntentV2>): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(`${canonicalJson(intent)}\n`, 'utf8').digest('hex')}`;
}

interface BootstrapCtx extends Ctx {
  /** Accepted bootstrap artifact digest = first complete graph prior_graph_sha256. */
  readonly priorGraphSha256: string;
  /** Bootstrap attach receipt B = first complete graph prior_event_seq. */
  readonly priorEventSeq: number;
  /** Coordinator event sequence after bootstrap attach + session attach = E. */
  readonly coveredEventSeq: number;
}

/**
 * Attach a real D65 bootstrap-backed run in `repoRoot`: commit the 44-byte
 * operator SPKI + a matching bootstrap envelope on a bootstrap branch, run the
 * atomic `attach-run` bootstrap transaction (creating the deterministic
 * `semantic-graph-bootstrap:<run>` artifact at receipt B=1), attach a session,
 * and return the exact CAS values (bootstrap digest, attach receipt, and the
 * current coordinator event sequence E) the first complete graph must bind. This
 * makes the registration fixtures faithful to the store's authoritative
 * sequence instead of synthetic prior/covered values.
 */
async function bootstrapAttach(client: CoordinatorClient, stateRoot: string, repoRoot: string, suffix: string): Promise<BootstrapCtx> {
  const repoId = `graph-reg-${suffix}`;
  const runId = `run-${suffix}`;
  const autopilotId = `autopilot-${suffix}`;
  const workstream = `work-${suffix}`;
  const contentCommit = git(repoRoot, ['rev-parse', 'HEAD']);
  const contentTree = git(repoRoot, ['rev-parse', 'HEAD^{tree}']);
  const runResource: Readonly<Record<string, unknown>> = {
    schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: runId,
    source_repo: repoRoot, git_common_dir: join(repoRoot, '.git'), worktree_root: join(stateRoot, 'wt', repoId),
    main_worktree_path: join(stateRoot, 'wt', repoId, 'active', runId, 'main'), runtime_root: join(stateRoot, 'wt', repoId, 'active', runId, 'main', '.pi', 'autopilot', workstream),
    branch: `autopilot/${runId}`, target_branch: 'main', target_base_sha: contentCommit, origin_url: null,
    started_at: '2026-07-19T00:00:00.000Z', version: 1,
  };
  const prospectiveRun: Readonly<Record<string, unknown>> = {
    schema_version: 'autopilot.coordination_run.v1', repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: runId,
    coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 0, created_event_seq: 1, version: 1,
  };
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }) as unknown as Uint8Array);
  const trustRef = `.pi/autopilot-trust/d65/program-${suffix}/operator-ed25519.spki`;
  const trustSha256 = `sha256:${createHash('sha256').update(spki).digest('hex')}` as `sha256:${string}`;
  const bootstrapRef = `.pi/autopilot-bootstrap/${runId}/bootstrap.json`;
  const bootstrap = {
    schema_version: 'autopilot.semantic_graph_bootstrap.v1', program_id: `program-${suffix}`, graph_sequence: 1, prior_graph_sha256: null,
    repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: runId,
    run_timestamp: '2026-07-19T00:00:00.000Z', run_nonce: 'abcdef',
    content_commit: contentCommit, content_tree: contentTree, package_commit: 'a'.repeat(40), package_tree: 'b'.repeat(40),
    prospective_run: prospectiveRun, prospective_resource: runResource, covered_event_seq: 0,
    trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256,
    allowed_bootstrap_operations: [...D65_ALLOWED_BOOTSTRAP_OPERATIONS], created_at: '2026-07-19T00:00:01.000Z',
  };
  const bootstrapBytes = `${JSON.stringify(bootstrap, null, 2)}\n`;
  const bootstrapSha256 = sha256(bootstrapBytes);
  git(repoRoot, ['checkout', '-b', `autopilot/bootstrap/${runId}`, contentCommit]);
  await mkdir(join(repoRoot, `.pi/autopilot-trust/d65/program-${suffix}`), { recursive: true });
  await writeFile(join(repoRoot, trustRef), spki);
  await mkdir(join(repoRoot, `.pi/autopilot-bootstrap/${runId}`), { recursive: true });
  await writeFile(join(repoRoot, bootstrapRef), bootstrapBytes, 'utf8');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'bootstrap overlay']);
  const bootstrapCommit = git(repoRoot, ['rev-parse', 'HEAD']);
  git(repoRoot, ['checkout', 'main']);
  const runResponse = await client.mutate('attach-run', { repoId, workstreamRun: runId, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `attach-run-${suffix}` }, {
    repo_key: repoId, canonical_root: repoRoot, git_common_dir: join(repoRoot, '.git'),
    autopilot_id: autopilotId, workstream, coordination_authority: 'coordinator-edit-leases-v1', run_resource: runResource,
    bootstrap_graph: {
      schema_version: 'autopilot.semantic_graph_bootstrap.v1', ref: bootstrapRef, sha256: bootstrapSha256, byte_count: Buffer.byteLength(bootstrapBytes, 'utf8'),
      git_commit: bootstrapCommit, covered_event_seq: 0, prospective_run: prospectiveRun, prospective_resource: runResource,
      trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256,
    },
  });
  const { event_type: _et, entity_type: _ent, entity_id: _eid, ...attachEffect } = runResponse.payload as Record<string, unknown>;
  const attachResult = parseD65AttachRunResultV2(attachEffect);
  const bootstrapEvidence = attachResult.bootstrap_artifact['evidence'] as Record<string, unknown>;
  const priorGraphSha256 = bootstrapEvidence['sha256'] as string;
  const priorEventSeq = attachResult.bootstrap_artifact['registered_event_seq'] as number;
  const run = parseCoordinationRun(attachResult.run as unknown);
  const token = createHash('sha256').update(`bootstrap-${suffix}`).digest('hex');
  const sessionResponse = await client.mutate('attach-session', { repoId, workstreamRun: runId, sessionId: `session-${suffix}`, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: `attach-session-${suffix}` }, {
    session_lease_id: `session-lease-${suffix}`, session_token: token, pid: process.pid, boot_id: `boot-${suffix}`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null,
  });
  const attachedRun = parseCoordinationRun(sessionResponse.payload['run']);
  const session = parseCoordinationSessionLease(sessionResponse.payload['session']);
  // E = the coordinator event sequence covered by the first complete graph =
  // the highest committed event so far. attach-run committed receipt B=1 and
  // attach-session committed event 2, so the session-attached committed event
  // sequence is exactly the current head E (no coordinator event occurs between
  // here and graph registration).
  const coveredEventSeq = sessionResponse.committed_event_seq as number;
  return { client, repoId, runId, sessionId: session.session_id, sessionLeaseId: session.session_lease_id, sessionToken: token, runVersion: attachedRun.version, priorGraphSha256, priorEventSeq, coveredEventSeq };
}

async function withHarness(run: (ctx: { client: CoordinatorClient; stateRoot: string; repoRoot: string; close: () => Promise<void> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-terminal-v2-'));
  const repoRoot = join(root, 'repo');
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  await writeFile(join(repoRoot, 'README.md'), 'base\n', 'utf8');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'base']);
  const stateRoot = join(root, 'state');
  const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
  const client = new CoordinatorClient({ env, autoStart: false });
  try {
    await run({ client, stateRoot, repoRoot, close: async () => { await server.close(); } });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

void describe('D65-A3 append-only terminal-intent v2', () => {
  void it('prepares a first v2 intent, moves the run to merging, and projects a v1-compatible status row', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const ctx = await attach(client, stateRoot, repoRoot, 'a');
      const intent = await prepareV2(ctx, 1, 'closed', null, null);
      assert.equal(intent.schema_version, 'autopilot.run_terminal_intent.v2');
      assert.equal(intent.intent_attempt, 1);
      assert.equal(intent.state, 'prepared');
      assert.equal(intent.prior_terminal_intent_id, null);
      // Status projects the v2 row through the v1-compatible shape without throwing.
      const status = await client.query('status', ctx.repoId, ctx.runId);
      const intents = status.payload['run_terminal_intents'] as Array<Record<string, unknown>>;
      assert.equal(intents.length, 1);
      assert.equal(intents[0]?.['schema_version'], 'autopilot.run_terminal_intent.v1');
      assert.equal(intents[0]?.['state'], 'prepared');
      const runs = status.payload['runs'] as Array<Record<string, unknown>>;
      assert.equal(runs[0]?.['status'], 'merging');
    });
  });

  void it('enforces the append-only chain: cancel then attempt+1 with exact prior id/digest', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const ctx = await attach(client, stateRoot, repoRoot, 'b');
      const first = await prepareV2(ctx, 1, 'closed', null, null);
      await cancelV2(ctx, first);
      const cancelledFirst = parseD65RunTerminalIntentV2({ ...first, state: 'cancelled', terminal_event_seq: first.prepared_event_seq + 1, version: first.version + 1 });
      // Attempt 2 must name the exact cancelled first row id + digest.
      const second = await prepareV2(ctx, 2, 'closed', cancelledFirst.terminal_intent_id, digestOf(cancelledFirst));
      assert.equal(second.intent_attempt, 2);
      assert.equal(second.prior_terminal_intent_id, cancelledFirst.terminal_intent_id);
      // A wrong prior digest rejects.
      await cancelV2(ctx, second);
      await assert.rejects(
        () => prepareV2(ctx, 3, 'closed', d65TerminalIntentId(ctx.runId, 2), `sha256:${'0'.repeat(64)}`),
        /does not bind the exact latest attempt bytes/u,
      );
    });
  });

  void it('binds the 3-cancel bound and mandatory fourth noncancellable abort', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const ctx = await attach(client, stateRoot, repoRoot, 'c');
      let prior = await prepareV2(ctx, 1, 'closed', null, null);
      for (let attempt = 2; attempt <= 3; attempt += 1) {
        await cancelV2(ctx, prior);
        const cancelled = parseD65RunTerminalIntentV2({ ...prior, state: 'cancelled', terminal_event_seq: prior.prepared_event_seq + 1, version: prior.version + 1 });
        prior = await prepareV2(ctx, attempt, 'closed', cancelled.terminal_intent_id, digestOf(cancelled));
      }
      // After the third cancellation, only attempt 4 abort may follow.
      await cancelV2(ctx, prior);
      const cancelledThird = parseD65RunTerminalIntentV2({ ...prior, state: 'cancelled', terminal_event_seq: prior.prepared_event_seq + 1, version: prior.version + 1 });
      // A close attempt 4 rejects; only abort is allowed.
      await assert.rejects(
        () => prepareV2(ctx, 4, 'closed', cancelledThird.terminal_intent_id, digestOf(cancelledThird)),
        /mandatory fourth terminal intent attempt must be a noncancellable abort/u,
      );
      const abort = await prepareV2(ctx, 4, 'aborted', cancelledThird.terminal_intent_id, digestOf(cancelledThird));
      assert.equal(abort.outcome, 'aborted');
      // The mandatory fourth abort is noncancellable.
      await assert.rejects(
        () => cancelV2(ctx, abort),
        /the mandatory fourth abort intent is noncancellable/u,
      );
    });
  });

  void it('still creates an unchanged v1 intent when the D65 fields are omitted', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const ctx = await attach(client, stateRoot, repoRoot, 'd');
      const response = await client.mutate('prepare-run-terminal', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: ctx.runVersion, idempotencyKey: 'prepare-v1' }, {
        outcome: 'closed', terminal_intent_id: 'legacy-terminal-intent-1', session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
      });
      assert.equal(response.payload['run_terminal_intent'] !== undefined, true);
      const intent = response.payload['run_terminal_intent'] as Record<string, unknown>;
      assert.equal(intent['schema_version'], 'autopilot.run_terminal_intent.v1');
      assert.equal(intent['terminal_intent_id'], 'legacy-terminal-intent-1');
      assert.equal(Object.prototype.hasOwnProperty.call(intent, 'intent_attempt'), false);
    });
  });
});

void describe('D65 non-self-referential graph registration', () => {
  const EMPTY = { entry_count: 0, total_bytes: 0, sha256: `sha256:${createHash('sha256').update('[]\n', 'utf8').digest('hex')}`, shards: [] };

  function sha(bytes: string): `sha256:${string}` { return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`; }

  // The five fixed core authority documents. state has one ready unit -> the
  // unit_ready queue has one member, all other queues empty.
  const CORE_FILES = {
    mission: { ref: 'runtime/mission.md', schema: null as string | null, records: null as number | null, body: '# Mission\n' },
    master_plan: { ref: 'runtime/master-plan.json', schema: 'autopilot.master_plan.v1', records: 1, body: '{"schema_version":"autopilot.master_plan.v1"}\n' },
    state: { ref: 'runtime/state.json', schema: 'autopilot.state.v1', records: 1, body: `${JSON.stringify({ schema_version: 'autopilot.state.v1', workstream: 'work-g', updated_at: '2026-07-19T00:00:00.000Z', status: 'running', context_gate: { gate: 'ok', percent: 10 }, last_event_id: 1, ready_queue: ['unit-a'], running: [], blocked: [], completed: [], units: { 'unit-a': { unit_id: 'unit-a', role: 'implement', state: 'ready', attempt: 1, summary: 'ready unit' } }, operator_questions: [], next_actions: ['dispatch'] }, null, 2)}\n` },
    decision_log: { ref: 'runtime/decisions.jsonl', schema: 'autopilot.decision.v1', records: 3, body: '{"a":1}\n{"a":2}\n{"a":3}\n' },
    events: { ref: 'runtime/events.jsonl', schema: 'autopilot.event.v1', records: 4, body: '{"e":1}\n{"e":2}\n{"e":3}\n{"e":4}\n' },
  } as const;

  // Build a real single-member queue projection index plus its exact on-disk
  // shard blob. The shard entry is exactly {identity,kind,value_sha256,value}
  // with value {identity}; the index sha256 is the canonical digest of the
  // complete identity-sorted entry array and total_bytes the summed RFC-8785+LF
  // entry bytes, matching the loader/replayer's checks.
  function realQueueShard(queueKind: string, identity: string): { index: Record<string, unknown>; shard: { ref: string; bytes: string } } {
    const ref = `semantic-graphs/00000000000000000002/queue/${queueKind}-0.json`;
    const value = { identity };
    const valueSha = sha(`${canonicalJson(value)}\n`);
    const entry = { identity, kind: queueKind, value_sha256: valueSha, value };
    const shardObject = {
      schema_version: 'autopilot.semantic_graph_projection_shard.v1', program_id: 'program-1', repo_id: 'repo-graph-reg', workstream_run: 'run-g',
      graph_sequence: 2, projection_kind: queueKind, entry_count: 1, total_bytes: Buffer.byteLength(`${canonicalJson(entry)}\n`, 'utf8'),
      first_identity: identity, last_identity: identity, entries: [entry],
    };
    const shardBytes = `${canonicalJson(shardObject)}\n`;
    const index = {
      entry_count: 1, total_bytes: Buffer.byteLength(`${canonicalJson(entry)}\n`, 'utf8'), sha256: sha(`${canonicalJson([entry])}\n`),
      shards: [{ ref, sha256: sha(shardBytes), byte_count: Buffer.byteLength(shardBytes, 'utf8'), entry_count: 1, first_identity: identity, last_identity: identity }],
    };
    return { index, shard: { ref, bytes: shardBytes } };
  }

  // The prior-tuple + R=E+1 CAS fields the registration gate now binds to real
  // store state. `bootstrapAttach` supplies these from the actual bootstrap
  // artifact (prior digest / attach receipt) and the current coordinator event
  // sequence so the first complete graph (sequence 2) is faithful.
  interface GraphCas {
    readonly priorGraphSha256: string;
    readonly priorEventSeq: number;
    readonly coveredEventSeq: number;
  }

  function completeGraph(authorityCommit: string, authorityTree: string, cas: GraphCas, queueOverride?: Record<string, unknown>): { root: Record<string, unknown>; shards: readonly { ref: string; bytes: string }[] } {
    const collections: Record<string, unknown> = {};
    for (const key of ['authorities', 'specs', 'statuses', 'receipts', 'audits', 'execution_commits', 'terminal_acceptances', 'unit_merge_intents', 'unit_merges', 'integration_analyses', 'quarantine', 'reconciliation', 'evidence']) collections[key] = { ...EMPTY };
    const ready = realQueueShard('unit_ready', 'unit-a');
    const queue: Record<string, unknown> = { unit_ready: ready.index, unit_running: { ...EMPTY }, unit_blocked: { ...EMPTY }, unit_completed: { ...EMPTY }, unit_held: { ...EMPTY }, work_audit_review: { ...EMPTY }, work_validation_ready: { ...EMPTY }, ...queueOverride };
    // Emit the real shard only when the queue still references it (no override).
    const shards = queueOverride?.['unit_ready'] === undefined ? [ready.shard] : [];
    const core = (entry: { ref: string; schema: string | null; records: number | null; body: string }): Record<string, unknown> => ({ ref: entry.ref, git_mode: '100644', git_blob_oid: 'a'.repeat(40), sha256: sha(entry.body), byte_count: Buffer.byteLength(entry.body, 'utf8'), record_count: entry.records, document_schema_version: entry.schema });
    const root = {
      schema_version: 'autopilot.semantic_graph.v1', program_id: 'program-1', mode: 'complete', graph_sequence: 2,
      prior_graph_sha256: cas.priorGraphSha256, prior_event_seq: cas.priorEventSeq, repo_id: 'repo-graph-reg', autopilot_id: 'auto-g', workstream: 'work-g', workstream_run: 'run-g',
      covered_authority_commit: authorityCommit, covered_authority_tree: authorityTree, covered_event_seq: cas.coveredEventSeq,
      bootstrap_charter: { repository: {}, run: {}, run_resource: {}, mailbox_cursor: {}, bootstrap_graph: {}, bootstrap_artifact: {}, trust_anchor: {}, attach_event: {}, attach_result: {} },
      core: { mission: core(CORE_FILES.mission), master_plan: core(CORE_FILES.master_plan), state: core(CORE_FILES.state), decision_log: core(CORE_FILES.decision_log), events: core(CORE_FILES.events) },
      collections, work_items: { ...EMPTY }, bughunt: { ...EMPTY }, closure: null, queue_projection: queue, exceptions: { ...EMPTY }, coordinator_projection: { ...EMPTY }, created_at: '2026-07-19T00:00:00.000Z',
    };
    return { root, shards };
  }

  async function writeGraphShards(repoRoot: string, shards: readonly { ref: string; bytes: string }[]): Promise<void> {
    for (const shard of shards) {
      await mkdir(join(repoRoot, join(...shard.ref.split('/').slice(0, -1))), { recursive: true });
      await writeFile(join(repoRoot, shard.ref), shard.bytes, 'utf8');
    }
  }

  async function commitAuthorityCore(repoRoot: string): Promise<{ commit: string; tree: string }> {
    await mkdir(join(repoRoot, 'runtime'), { recursive: true });
    for (const entry of Object.values(CORE_FILES)) await writeFile(join(repoRoot, entry.ref), entry.body, 'utf8');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'authority core']);
    return { commit: git(repoRoot, ['rev-parse', 'HEAD']), tree: git(repoRoot, ['rev-parse', 'HEAD^{tree}']) };
  }

  void it('registers a graph-only publication with a queue projection that matches the authority state', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, repoRoot, 'g');
      const authority = await commitAuthorityCore(repoRoot);
      const g = authority.commit;
      const graphRef = 'semantic-graphs/00000000000000000002/graph.json';
      const built = completeGraph(g, authority.tree, ctx);
      const graphBytes = JSON.stringify(built.root);
      await mkdir(join(repoRoot, 'semantic-graphs', '00000000000000000002'), { recursive: true });
      await writeFile(join(repoRoot, graphRef), graphBytes, 'utf8');
      await writeGraphShards(repoRoot, built.shards);
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'publish graph 2']);
      const h = git(repoRoot, ['rev-parse', 'HEAD']);
      const graphSha = `sha256:${createHash('sha256').update(graphBytes).digest('hex')}` as `sha256:${string}`;
      const status0 = await client.query('status', ctx.repoId, ctx.runId);
      const runVersion = (status0.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
      const registered = await client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: runVersion, idempotencyKey: 'register-graph-2' }, {
        artifact_id: 'semantic-graph:00000000000000000002', source_type: 'task', source_scope: 'repository', document_schema_version: 'autopilot.semantic_graph.v1', git_commit: h, ref: graphRef, sha256: graphSha, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
      });
      assert.equal(registered.committed_event_seq !== null, true);
    });
  });

  void it('rejects a queue projection whose index counts disagree with the authority state', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, repoRoot, 'q');
      const authority = await commitAuthorityCore(repoRoot);
      const g = authority.commit;
      const graphRef = 'semantic-graphs/00000000000000000002/graph.json';
      // Claim unit_ready is empty though the state has one ready unit.
      const graphBytes = JSON.stringify(completeGraph(g, authority.tree, ctx, { unit_ready: { ...EMPTY } }).root);
      await mkdir(join(repoRoot, 'semantic-graphs', '00000000000000000002'), { recursive: true });
      await writeFile(join(repoRoot, graphRef), graphBytes, 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'publish graph 2 with wrong queue']);
      const h = git(repoRoot, ['rev-parse', 'HEAD']);
      const graphSha = `sha256:${createHash('sha256').update(graphBytes).digest('hex')}` as `sha256:${string}`;
      const status0 = await client.query('status', ctx.repoId, ctx.runId);
      const runVersion = (status0.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
      await assert.rejects(
        () => client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: runVersion, idempotencyKey: 'register-graph-q' }, {
          artifact_id: 'semantic-graph:00000000000000000002', source_type: 'task', source_scope: 'repository', document_schema_version: 'autopilot.semantic_graph.v1', git_commit: h, ref: graphRef, sha256: graphSha, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
        }),
        /unit_ready index entry_count 0 does not equal the derived queue size 1/u,
      );
    });
  });

  void it('rejects a queue whose count is correct but whose loaded shard member identity is wrong', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, repoRoot, 'm');
      const authority = await commitAuthorityCore(repoRoot);
      const g = authority.commit;
      const graphRef = 'semantic-graphs/00000000000000000002/graph.json';
      // The index count stays 1 (matches the derived queue size), but the real
      // shard names a WRONG member identity (unit-zzz), which the counts-only
      // check cannot catch. The loader/replayer must load the shard and reject
      // the member mismatch against the derived equation (unit-a).
      const wrong = realQueueShard('unit_ready', 'unit-zzz');
      const built = completeGraph(g, authority.tree, ctx, { unit_ready: wrong.index });
      const graphBytes = JSON.stringify(built.root);
      await mkdir(join(repoRoot, 'semantic-graphs', '00000000000000000002'), { recursive: true });
      await writeFile(join(repoRoot, graphRef), graphBytes, 'utf8');
      await writeGraphShards(repoRoot, [wrong.shard]);
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'publish graph 2 with wrong member']);
      const h = git(repoRoot, ['rev-parse', 'HEAD']);
      const graphSha = `sha256:${createHash('sha256').update(graphBytes).digest('hex')}` as `sha256:${string}`;
      const status0 = await client.query('status', ctx.repoId, ctx.runId);
      const runVersion = (status0.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
      await assert.rejects(
        () => client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: runVersion, idempotencyKey: 'register-graph-m' }, {
          artifact_id: 'semantic-graph:00000000000000000002', source_type: 'task', source_scope: 'repository', document_schema_version: 'autopilot.semantic_graph.v1', git_commit: h, ref: graphRef, sha256: graphSha, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
        }),
        /unit_ready members do not equal the derived equation/u,
      );
    });
  });

  void it('rejects a queue whose loaded shard blob is missing at the publication commit', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, repoRoot, 'n');
      const authority = await commitAuthorityCore(repoRoot);
      const g = authority.commit;
      const graphRef = 'semantic-graphs/00000000000000000002/graph.json';
      // Declare a real unit_ready index/shard but DO NOT commit the shard blob:
      // the loader must fail loudly because the declared shard is absent at H.
      const built = completeGraph(g, authority.tree, ctx);
      const graphBytes = JSON.stringify(built.root);
      await mkdir(join(repoRoot, 'semantic-graphs', '00000000000000000002'), { recursive: true });
      await writeFile(join(repoRoot, graphRef), graphBytes, 'utf8');
      // Intentionally skip writeGraphShards so the shard blob is absent at H.
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'publish graph 2 with missing shard']);
      const h = git(repoRoot, ['rev-parse', 'HEAD']);
      const graphSha = `sha256:${createHash('sha256').update(graphBytes).digest('hex')}` as `sha256:${string}`;
      const status0 = await client.query('status', ctx.repoId, ctx.runId);
      const runVersion = (status0.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
      await assert.rejects(
        () => client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: runVersion, idempotencyKey: 'register-graph-n' }, {
          artifact_id: 'semantic-graph:00000000000000000002', source_type: 'task', source_scope: 'repository', document_schema_version: 'autopilot.semantic_graph.v1', git_commit: h, ref: graphRef, sha256: graphSha, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
        }),
        /shard blob is not readable at the publication commit/u,
      );
    });
  });

  void it('advances the graph publication residue from publication-committed to registered on registration', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, repoRoot, 'r');
      const authority = await commitAuthorityCore(repoRoot);
      const g = authority.commit;
      const graphRef = 'semantic-graphs/00000000000000000002/graph.json';
      const built = completeGraph(g, authority.tree, ctx);
      const graphBytes = JSON.stringify(built.root);
      await mkdir(join(repoRoot, 'semantic-graphs', '00000000000000000002'), { recursive: true });
      await writeFile(join(repoRoot, graphRef), graphBytes, 'utf8');
      await writeGraphShards(repoRoot, built.shards);
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'publish graph 2']);
      const h = git(repoRoot, ['rev-parse', 'HEAD']);
      const graphSha = `sha256:${createHash('sha256').update(graphBytes).digest('hex')}` as `sha256:${string}`;
      // Seal a publication-committed residue bound to this exact artifact/H at
      // the run's main-worktree sibling.
      const mainWorktreeSibling = join(stateRoot, 'wt', ctx.repoId, 'active', ctx.runId);
      await mkdir(mainWorktreeSibling, { recursive: true });
      const residueBytes = `${canonicalJson({
        schema_version: 'autopilot.graph_publication.v1', publication_id: 'pub-1', program_id: 'program-1', repo_id: 'repo-1', autopilot_id: 'auto-1', workstream_run: 'run-1',
        graph_sequence: 2, artifact_id: 'semantic-graph:00000000000000000002', stage: 'publication-committed', prior_authority_kind: 'bootstrap', prior_graph_sha256: `sha256:${'a'.repeat(64)}`, prior_publication_commit: null,
        prior_registration_event_seq: 1, authority_base_commit: g, authority_path_count: 5, authority_path_manifest_sha256: `sha256:${'c'.repeat(64)}`, authority_commit: g, authority_tree: authority.tree,
        covered_event_seq: 5, publication_commit: h, publication_tree: git(repoRoot, ['rev-parse', 'HEAD^{tree}']), graph_ref: graphRef, graph_sha256: graphSha, graph_byte_count: Buffer.byteLength(graphBytes, 'utf8'), registration_event_seq: null,
        created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-19T00:00:00.000Z',
      })}\n`;
      await writeFile(join(mainWorktreeSibling, '_graph-publication.json'), residueBytes, { encoding: 'utf8', mode: 0o600 });
      const status0 = await client.query('status', ctx.repoId, ctx.runId);
      const runVersion = (status0.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
      const registered = await client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: runVersion, idempotencyKey: 'register-graph-r' }, {
        artifact_id: 'semantic-graph:00000000000000000002', source_type: 'task', source_scope: 'repository', document_schema_version: 'autopilot.semantic_graph.v1', git_commit: h, ref: graphRef, sha256: graphSha, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
      });
      assert.equal(registered.committed_event_seq !== null, true);
      const finalResidue = JSON.parse(await readFile(join(mainWorktreeSibling, '_graph-publication.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(finalResidue['stage'], 'registered');
      assert.equal(finalResidue['registration_event_seq'], registered.committed_event_seq);
    });
  });

  void it('rejects a graph whose covered_authority_tree does not match the authority commit tree', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, repoRoot, 't');
      const authority = await commitAuthorityCore(repoRoot);
      const g = authority.commit;
      const graphRef = 'semantic-graphs/00000000000000000002/graph.json';
      // Wrong covered_authority_tree (CAS fields stay faithful so the tree check
      // is the sole failure).
      const graphBytes = JSON.stringify(completeGraph(g, 'd'.repeat(40), ctx).root);
      await mkdir(join(repoRoot, 'semantic-graphs', '00000000000000000002'), { recursive: true });
      await writeFile(join(repoRoot, graphRef), graphBytes, 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'publish graph 2 with wrong tree']);
      const h = git(repoRoot, ['rev-parse', 'HEAD']);
      const graphSha = `sha256:${createHash('sha256').update(graphBytes).digest('hex')}` as `sha256:${string}`;
      const status0 = await client.query('status', ctx.repoId, ctx.runId);
      const runVersion = (status0.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
      await assert.rejects(
        () => client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: runVersion, idempotencyKey: 'register-graph-t' }, {
          artifact_id: 'semantic-graph:00000000000000000002', source_type: 'task', source_scope: 'repository', document_schema_version: 'autopilot.semantic_graph.v1', git_commit: h, ref: graphRef, sha256: graphSha, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
        }),
        /covered_authority_tree does not match the authority commit tree/u,
      );
    });
  });

  void it('rejects a publication commit that also changes a non-graph product path', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, repoRoot, 'p');
      const authority = await commitAuthorityCore(repoRoot);
      const g = authority.commit;
      const graphRef = 'semantic-graphs/00000000000000000002/graph.json';
      const graphBytes = JSON.stringify(completeGraph(g, authority.tree, ctx).root);
      await mkdir(join(repoRoot, 'semantic-graphs', '00000000000000000002'), { recursive: true });
      await writeFile(join(repoRoot, graphRef), graphBytes, 'utf8');
      await writeFile(join(repoRoot, 'product.ts'), 'export const x = 1;\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'publish graph 2 with product change']);
      const h = git(repoRoot, ['rev-parse', 'HEAD']);
      const graphSha = `sha256:${createHash('sha256').update(graphBytes).digest('hex')}` as `sha256:${string}`;
      const status0 = await client.query('status', ctx.repoId, ctx.runId);
      const runVersion = (status0.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
      await assert.rejects(
        () => client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: runVersion, idempotencyKey: 'register-graph-p' }, {
          artifact_id: 'semantic-graph:00000000000000000002', source_type: 'task', source_scope: 'repository', document_schema_version: 'autopilot.semantic_graph.v1', git_commit: h, ref: graphRef, sha256: graphSha, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
        }),
        /changes a non-graph path/u,
      );
    });
  });

  // Sub-part 2a: prior-tuple CAS + R=E+1. Each negative keeps everything else
  // faithful and tampers exactly one bound field so the CAS is the sole cause.
  async function publishAndRegister(client: CoordinatorClient, repoRoot: string, ctx: BootstrapCtx, cas: GraphCas): Promise<void> {
    const authority = await commitAuthorityCore(repoRoot);
    const graphRef = 'semantic-graphs/00000000000000000002/graph.json';
    const built = completeGraph(authority.commit, authority.tree, cas);
    const graphBytes = JSON.stringify(built.root);
    await mkdir(join(repoRoot, 'semantic-graphs', '00000000000000000002'), { recursive: true });
    await writeFile(join(repoRoot, graphRef), graphBytes, 'utf8');
    await writeGraphShards(repoRoot, built.shards);
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'publish graph 2 (cas negative)']);
    const h = git(repoRoot, ['rev-parse', 'HEAD']);
    const graphSha = `sha256:${createHash('sha256').update(graphBytes).digest('hex')}` as `sha256:${string}`;
    const status0 = await client.query('status', ctx.repoId, ctx.runId);
    const runVersion = (status0.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
    await client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: runVersion, idempotencyKey: 'register-graph-cas' }, {
      artifact_id: 'semantic-graph:00000000000000000002', source_type: 'task', source_scope: 'repository', document_schema_version: 'autopilot.semantic_graph.v1', git_commit: h, ref: graphRef, sha256: graphSha, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
    });
  }

  void it('rejects a first complete graph whose covered_event_seq is not the current head (R=E+1)', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, repoRoot, 'e');
      await assert.rejects(
        () => publishAndRegister(client, repoRoot, ctx, { priorGraphSha256: ctx.priorGraphSha256, priorEventSeq: ctx.priorEventSeq, coveredEventSeq: ctx.coveredEventSeq + 1 }),
        /semantic-graph-cas-conflict: graph covered_event_seq must equal the current coordinator event sequence/u,
      );
    });
  });

  void it('rejects a first complete graph whose prior_graph_sha256 is not the accepted bootstrap digest', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, repoRoot, 'd');
      await assert.rejects(
        () => publishAndRegister(client, repoRoot, ctx, { priorGraphSha256: `sha256:${'a'.repeat(64)}`, priorEventSeq: ctx.priorEventSeq, coveredEventSeq: ctx.coveredEventSeq }),
        /semantic-graph-cas-conflict: first complete graph prior_graph_sha256 is not the accepted bootstrap digest/u,
      );
    });
  });

  void it('rejects a first complete graph whose prior_event_seq is not the bootstrap attach receipt', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, repoRoot, 'b');
      await assert.rejects(
        () => publishAndRegister(client, repoRoot, ctx, { priorGraphSha256: ctx.priorGraphSha256, priorEventSeq: ctx.priorEventSeq + 41, coveredEventSeq: ctx.coveredEventSeq }),
        /semantic-graph-cas-conflict: first complete graph prior_event_seq is not the bootstrap attach receipt/u,
      );
    });
  });

  // Namespace-squatter regression: register-authoritative-artifact accepts a
  // caller-chosen artifact_id, so a NON-graph authoritative artifact (here a
  // valid mission) can be registered under a `semantic-graph:<20-digit>` id. The
  // prior-graph CAS query must bind document_schema_version to the complete
  // graph schema, not just the id prefix; otherwise the squatter would be
  // mistaken for the prior graph and would break the legitimate first-graph
  // (bootstrap-parented) registration. This proves the fix: the first real graph
  // (sequence 2) still registers successfully despite the squatter.
  void it('ignores a non-graph artifact squatting the semantic-graph:<seq> id and still accepts the first complete graph', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, repoRoot, 's');
      // Commit a valid mission document and register it under a graph-shaped id.
      const missionRef = 'runtime/mission.md';
      const missionBody = '# Mission\n## Goal\ng\n## Non-goals / exclusions\nn\n## Perfect-quality bar\np\n## Definition of done\nd\n## Key constraints\nk\n## Current strategy summary\nc\n## Open questions\no\n';
      await mkdir(join(repoRoot, 'runtime'), { recursive: true });
      await writeFile(join(repoRoot, missionRef), missionBody, 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'mission squatter']);
      const missionCommit = git(repoRoot, ['rev-parse', 'HEAD']);
      const missionSha = `sha256:${createHash('sha256').update(missionBody).digest('hex')}` as `sha256:${string}`;
      const status1 = await client.query('status', ctx.repoId, ctx.runId);
      const version1 = (status1.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
      // The squatter uses a HIGHER graph-shaped id than the legitimate seq 2 so
      // that, without the schema predicate, DESC would pick it as the prior.
      await client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: version1, idempotencyKey: 'register-mission-squatter' }, {
        artifact_id: 'semantic-graph:00000000000000000009', source_type: 'mission', source_scope: 'repository', document_schema_version: 'autopilot.mission.v1', git_commit: missionCommit, ref: missionRef, sha256: missionSha, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
      });
      // Now publish + register the legitimate first complete graph (sequence 2).
      // It must chain to the BOOTSTRAP tuple (not the ...0009 squatter). The
      // authority core is committed on top of the mission commit; covered E is
      // unchanged because registering the mission emitted one coordinator event,
      // so recompute the current head for the graph's covered_event_seq.
      const status2 = await client.query('status', ctx.repoId, ctx.runId);
      const missionRegisteredHead = ctx.coveredEventSeq + 1;
      void status2;
      const authority = await commitAuthorityCore(repoRoot);
      const graphRef = 'semantic-graphs/00000000000000000002/graph.json';
      const built = completeGraph(authority.commit, authority.tree, { priorGraphSha256: ctx.priorGraphSha256, priorEventSeq: ctx.priorEventSeq, coveredEventSeq: missionRegisteredHead });
      const graphBytes = JSON.stringify(built.root);
      await mkdir(join(repoRoot, 'semantic-graphs', '00000000000000000002'), { recursive: true });
      await writeFile(join(repoRoot, graphRef), graphBytes, 'utf8');
      await writeGraphShards(repoRoot, built.shards);
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'publish graph 2 over squatter']);
      const h = git(repoRoot, ['rev-parse', 'HEAD']);
      const graphSha = `sha256:${createHash('sha256').update(graphBytes).digest('hex')}` as `sha256:${string}`;
      const version2 = (status2.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
      const registered = await client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: version2, idempotencyKey: 'register-graph-over-squatter' }, {
        artifact_id: 'semantic-graph:00000000000000000002', source_type: 'task', source_scope: 'repository', document_schema_version: 'autopilot.semantic_graph.v1', git_commit: h, ref: graphRef, sha256: graphSha, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
      });
      assert.equal(registered.committed_event_seq !== null, true);
    });
  });
});
