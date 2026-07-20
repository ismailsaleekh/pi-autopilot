import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
