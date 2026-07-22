import assert from 'node:assert/strict';
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { runAutopilotAgentCli } from '../../src/cli/autopilot-agent-run.ts';
import { closeAutopilotWorkstream } from '../../src/core/close-runtime.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { parseCoordinationAuthoritativeArtifact, parseCoordinationChildLease, parseCoordinationRun, parseCoordinationRunResource, parseCoordinationRunTerminalIntent, parseCoordinationSessionLease, parseCoordinationWorktree, parseCoordinationWorktreeOperation } from '../../src/core/coordination/contracts.ts';
import { projectD65SessionLease, type D65CoordinatorProjectionSnapshot } from '../../src/core/coordination/d65-coordinator-projection.ts';
import { currentBootId } from '../../src/core/coordination/process-identity.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { produceD65CompleteGraphFromAuthority } from '../../src/core/coordination/d65-graph-body.ts';
import type { D65ProducedGraph } from '../../src/core/coordination/d65-graph-producer.ts';
import { prepareD65CoordinatorOnlySuccessor, reconstructD65BootstrapCharterFromCoordinatorExport } from '../../src/core/coordination/d65-graph-successor.ts';
import { driveD65ParentLossRecoveryFromEnvironment, driveD65SubscriptionFailureRecoveryFromEnvironment, publishD65CoordinatorOnlySuccessorFromEnvironment, publishD65FirstCompleteGraphFromEnvironment } from '../../src/core/coordination/d65-graph-successor-runtime.ts';
import { readD65CoordinatorExport, readD65GraphAuthorityAtCommit } from '../../src/core/coordination/d65-graph-runtime.ts';
import { assertD65BootstrapMainWorktreeEffectBoundaryFromEnvironment } from '../../src/core/coordination/d65-runtime-dispatch.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { writeCoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { executeOwnedWorktreeSaga } from '../../src/core/coordination/worktree-saga.ts';
import {
  canonicalSha256,
  parseD65AttachRunResultV2,
  parseD65CompleteGraph,
  parseD65RunTerminalIntentV2,
} from '../../src/core/coordination/d65-semantic-graph.ts';
import { D65_ALLOWED_BOOTSTRAP_OPERATIONS } from '../../src/core/coordination/d65-semantic-graph.ts';
import { loadD65CompleteGraph } from '../../src/core/coordination/d65-graph-loader.ts';
import { d65TerminalIntentId } from '../../src/core/coordination/d65-terminal-intent.ts';
import type { CoordinationWorktree, CoordinationWorktreeOperation } from '../../src/core/coordination/types.ts';
import { encodeUnpaddedBase64Url } from '../../src/core/coordination/d65-trust.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { AUTOPILOT_STATE_ROOT_ENV, coordinationRootForRepo, prepareAutopilotUnitWorktree, resolveRepoIdentity, writeActiveAutopilots, type ActiveAutopilotRow, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import { resetFailedUnit } from '../../src/core/unit-failure.ts';
import { recordCoordinatorReleaseEvidenceFromFile } from '../../src/core/coordination/reconciliation.ts';

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
async function buildBootstrap(harness: Harness, suffix: string, resourceOverrides: Readonly<Record<string, unknown>> = {}): Promise<BootstrapFixture> {
  const repoId = `graph-repo-${suffix}`;
  const workstreamRun = `run-${suffix}`;
  const autopilotId = `autopilot-${suffix}`;
  const workstream = `work-${suffix}`;
  const contentCommit = git(harness.repository, ['rev-parse', 'HEAD']);
  const contentTree = git(harness.repository, ['rev-parse', 'HEAD^{tree}']);
  const packageCommit = 'a'.repeat(40);
  const packageTree = 'b'.repeat(40);

  // One shared resource object flows into all three prospective positions
  // (bootstrap.prospective_resource, attach.run_resource, and
  // attach.bootstrap_graph.prospective_resource); overrides therefore keep the
  // three byte-equal while letting a negative decouple target_base_sha from the
  // content-result commit.
  const runResource: Readonly<Record<string, unknown>> = {
    schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: workstreamRun,
    source_repo: harness.repository, git_common_dir: join(harness.repository, '.git'), worktree_root: join(harness.stateRoot, 'worktrees', repoId),
    main_worktree_path: join(harness.stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main'), runtime_root: join(harness.stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main', '.pi', 'autopilot', workstream),
    branch: `autopilot/${workstreamRun}`, target_branch: 'main', target_base_sha: contentCommit, origin_url: null,
    started_at: '2026-07-19T00:00:00.000Z', version: 1, ...resourceOverrides,
  };
  // The exact run row the transaction creates at B=1.
  const prospectiveRun: Readonly<Record<string, unknown>> = {
    schema_version: 'autopilot.coordination_run.v1', repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: workstreamRun,
    coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 0, created_event_seq: 1, version: 1,
  };

  // Operator trust anchor: 44-byte canonical Ed25519 SPKI.
  const { publicKey } = generateKeyPairSync('ed25519');
  const exportedSpki = publicKey.export({ format: 'der', type: 'spki' });
  if (!(exportedSpki instanceof Uint8Array)) throw new Error('Ed25519 SPKI export was not binary DER');
  const spki = Buffer.from(exportedSpki);
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

  void it('rejects a bootstrap whose run resource target_base_sha is not the content-result commit', async () => {
    const harness = await createHarness();
    try {
      // A real, distinct B0-style commit that is NOT the content-result commit.
      const contentCommit = git(harness.repository, ['rev-parse', 'HEAD']);
      await writeFile(join(harness.repository, 'later.txt'), 'a distinct real commit\n', 'utf8');
      git(harness.repository, ['add', '.']);
      git(harness.repository, ['commit', '-m', 'distinct commit']);
      const otherCommit = git(harness.repository, ['rev-parse', 'HEAD']);
      git(harness.repository, ['checkout', contentCommit]);
      assert.notEqual(otherCommit, contentCommit);
      // All three prospective_resource copies still byte-equal each other, so the
      // prospective checks pass; only the frozen target_base_sha=content_commit
      // binding catches the substitution.
      const fixture = await buildBootstrap(harness, 'targetbase', { target_base_sha: otherCommit });
      await assert.rejects(
        () => harness.client.mutate('attach-run', { repoId: fixture.repoId, workstreamRun: fixture.workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-targetbase' }, fixture.attachPayload),
        /run resource target_base_sha must equal the content-result commit/u,
      );
      // No repository/run rows leaked from the rolled-back transaction.
      const catalog = await harness.client.query('run-catalog', fixture.repoId, null);
      assert.equal(Array.isArray(catalog.payload['runs']) && (catalog.payload['runs'] as unknown[]).length === 0, true);
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
  readonly mainRoot: string;
  readonly programId: string;
  readonly autopilotId: string;
  readonly workstream: string;
  readonly policyCommit: string;
  readonly sessionPath: string;
  readonly sagaEnv: ProcessEnvLike;
  /** PEM-encoded operator private key; tests alone may hold the fixture key. */
  readonly privateKeyPem: string;
  readonly snapshot: D65CoordinatorProjectionSnapshot;
  readonly bootstrapCharter: Readonly<Record<string, unknown>>;
  /** Accepted bootstrap artifact digest = first complete graph prior_graph_sha256. */
  readonly priorGraphSha256: `sha256:${string}`;
  /** Bootstrap attach receipt B = first complete graph prior_event_seq. */
  readonly priorEventSeq: number;
  /** Coordinator event sequence after the full bootstrap charter = E. */
  readonly coveredEventSeq: number;
}

/** Reconstruct the exact D65 coordinator projection snapshot at E from a status page. */
function snapshotFromStatus(payload: Readonly<Record<string, unknown>>, coveredEventSeq: number): D65CoordinatorProjectionSnapshot {
  const run = parseCoordinationRun((payload['runs'] as unknown[])[0]);
  const resource = parseCoordinationRunResource((payload['run_resources'] as unknown[])[0]);
  const sessions = (payload['session_leases'] as unknown[]).map(parseCoordinationSessionLease).map((session) => projectD65SessionLease(session, 0));
  const worktrees = (payload['worktrees'] as unknown[]).map(parseCoordinationWorktree);
  const operations = (payload['worktree_operations'] as unknown[]).map(parseCoordinationWorktreeOperation);
  const artifacts = (payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
  return Object.freeze({ run, resource, sessions: Object.freeze(sessions), children: Object.freeze([]), attempts: Object.freeze([]), faults: Object.freeze([]), reservations: Object.freeze([]), edit_leases: Object.freeze([]), acquisition_groups: Object.freeze([]), worktrees: Object.freeze(worktrees), operations: Object.freeze(operations), terminal_intents: Object.freeze([]), current_terminal_intent_id: null, authoritative_artifacts: Object.freeze(artifacts), covered_event_seq: coveredEventSeq, run_version: run.version });
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
async function bootstrapAttach(client: CoordinatorClient, stateRoot: string, repoRoot: string, suffix: string, repoIdOverride?: string, bootIdOverride?: string): Promise<BootstrapCtx> {
  const repoId = repoIdOverride ?? `graph-reg-${suffix}`;
  const attachedBootId = bootIdOverride ?? `boot-${suffix}`;
  const runId = `run-${suffix}`;
  const autopilotId = `autopilot-${suffix}`;
  const workstream = `work-${suffix}`;
  const contentCommit = git(repoRoot, ['rev-parse', 'HEAD']);
  const contentTree = git(repoRoot, ['rev-parse', 'HEAD^{tree}']);
  const runResource: Readonly<Record<string, unknown>> = {
    schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: runId,
    source_repo: repoRoot, git_common_dir: join(repoRoot, '.git'), worktree_root: join(stateRoot, 'worktrees', repoId),
    main_worktree_path: join(stateRoot, 'worktrees', repoId, 'active', runId, 'main'), runtime_root: join(stateRoot, 'worktrees', repoId, 'active', runId, 'main', '.pi', 'autopilot', workstream),
    branch: `autopilot/${runId}`, target_branch: 'main', target_base_sha: contentCommit, origin_url: null,
    started_at: '2026-07-19T00:00:00.000Z', version: 1,
  };
  const prospectiveRun: Readonly<Record<string, unknown>> = {
    schema_version: 'autopilot.coordination_run.v1', repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: runId,
    coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 0, created_event_seq: 1, version: 1,
  };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const exportedSpki = publicKey.export({ format: 'der', type: 'spki' });
  if (!(exportedSpki instanceof Uint8Array)) throw new Error('Ed25519 SPKI export was not binary DER');
  const spki = Buffer.from(exportedSpki);
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
    session_lease_id: `session-lease-${suffix}`, session_token: token, pid: process.pid, boot_id: attachedBootId, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null,
  });
  const attachedRun = parseCoordinationRun(sessionResponse.payload['run']);
  const session = parseCoordinationSessionLease(sessionResponse.payload['session']);
  // Establish the complete bootstrap main-worktree operation through every
  // durable stage, then commit/register the signed launch policy and accept the
  // initial externally signed graph-publication heartbeat.
  const mainRoot = String(runResource['main_worktree_path']);
  const branch = String(runResource['branch']);
  const sessionContext = { schema_version: 'autopilot.coordinator_session_context.v1' as const, state_root: stateRoot, repo_id: repoId, repo_key: repoId, autopilot_id: autopilotId, workstream, workstream_run: runId, session_id: session.session_id, session_generation: session.session_generation, run_version: attachedRun.version, session_lease_id: session.session_lease_id, session_token: token, session_version: session.version, pid: session.pid, boot_id: session.boot_id };
  const sessionPath = join(stateRoot, `graph-session-${suffix}.json`);
  await writeCoordinatorSessionContext(sessionPath, sessionContext);
  const active: ActiveAutopilotRow = { schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1', autopilot_id: autopilotId, workstream, workstream_run: runId, repo_key: repoId, source_repo: repoRoot, git_common_dir: join(repoRoot, '.git'), worktree_root: String(runResource['worktree_root']), main_worktree_path: mainRoot, branch, runtime_root: String(runResource['runtime_root']), target_branch: 'main', target_base_sha: contentCommit, origin_url: null, pid: process.pid, boot_id: session.boot_id, status: 'active', started_at: '2026-07-19T00:00:00.000Z', active_run_epoch: 1, active_epoch_started_at: '2026-07-19T00:00:00.000Z', active_run_receipt_id: `receipt-${suffix}` };
  const taskRoot = dirname(mainRoot);
  const sagaResult = await executeOwnedWorktreeSaga({ active, unitId: 'main', attempt: 1, kind: 'main', operationType: 'create', initialWorktreeState: 'planned', committedWorktreeState: 'active', intent: { repo_root: repoRoot, worktree_path: mainRoot, git_common_dir: join(repoRoot, '.git'), branch, reason: 'D65 semantic graph run-main fixture', base_sha: contentCommit, target_sha: null, archive_ref: null, checkout_mode: 'full', sparse_patterns: [], paths: [], metadata_refs: ['_task-info.json', '_branches.json', '_unit-index.json'] } }, {
    action: async () => { await mkdir(taskRoot, { recursive: true }); git(repoRoot, ['worktree', 'add', '-b', branch, mainRoot, contentCommit]); },
    finalize: async () => {
      await writeFile(join(taskRoot, '_task-info.json'), `${JSON.stringify({ schema_version: 'autopilot.task_info.v2', coordination_authority: 'coordinator-edit-leases-v1', workstream, workstream_run: runId, autopilot_id: autopilotId, source_repo: repoRoot, git_common_dir: join(repoRoot, '.git'), repo_key: repoId, base_sha: contentCommit, branch, worktree_path: mainRoot, runtime_root: String(runResource['runtime_root']), target_branch: 'main', target_base_sha: contentCommit, started_at: '2026-07-19T00:00:00.000Z', closed_at: null, status: 'active', checkout_mode: 'full', checkout_profile_ref: '_checkout-profile.json', checkout_profile_sha256: sha256('fixture checkout profile'), checkout_profile_origin: 'default' }, null, 2)}\n`, 'utf8');
      await writeFile(join(taskRoot, '_branches.json'), `${JSON.stringify({ schema_version: 'autopilot.branches.v1', active_branch: branch, base_sha: contentCommit, current_sha: contentCommit, archive_ref: null, unit_branches: [] }, null, 2)}\n`, 'utf8');
      await writeFile(join(taskRoot, '_unit-index.json'), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [] }, null, 2)}\n`, 'utf8');
    },
  }, { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: sessionPath });
  const storedWorktree = parseCoordinationWorktree(sagaResult.worktree);
  const storedOperation = parseCoordinationWorktreeOperation(sagaResult.operation);

  const b0Commit = git(mainRoot, ['rev-parse', 'HEAD^']);
  const b0Tree = git(mainRoot, ['rev-parse', `${b0Commit}^{tree}`]);
  // The policy must bind the canonical REAL evidence-root path (macOS tmpdir
  // is a symlink alias); the store rejects any non-canonical path byte-for-byte.
  // The root must also live OUTSIDE every clone/state/session/worktree root
  // (fresh plan §3.2), so it is a SIBLING of the state root, never inside it.
  const rawProgramEvidenceRoot = join(dirname(stateRoot), `program-evidence-${suffix}`);
  await mkdir(rawProgramEvidenceRoot, { recursive: true, mode: 0o700 });
  chmodSync(rawProgramEvidenceRoot, 0o700);
  const programEvidenceRoot = realpathSync(rawProgramEvidenceRoot);
  const policyFields = { schema_version: 'autopilot.launch_policy.v1', program_id: `program-${suffix}`, policy_id: 'policy-1', policy_version: 1, repo_id: repoId, workstream_run: runId, package_commit: 'a'.repeat(40), package_tree: 'b'.repeat(40), base_commit: b0Commit, base_tree: b0Tree, bootstrap_graph_sha256: bootstrapSha256, bootstrap_receipt_event_seq: priorEventSeq, roster_sha256: sha256('fixed D65 Pi-subscription roster'), parallel_cap: 1, maximum_parallel_cap: 1, expected_checkout_units: 1, program_evidence_root: programEvidenceRoot, trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256, prior_policy_sha256: null, capacity_decision_ref: null, capacity_decision_sha256: null, issued_at: '2026-07-19T00:00:00.000Z', signer_key_id: trustSha256 };
  const policySignature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, Buffer.concat([Buffer.from('AUTOPILOT-D65-LAUNCH-POLICY\0', 'utf8'), Buffer.from(canonicalJson(policyFields), 'utf8')]), privateKey)));
  const policyBytes = `${canonicalJson({ ...policyFields, signature: policySignature })}\n`;
  const policyRef = 'authority/launch-policies/policy-1.json';
  await mkdir(dirname(join(mainRoot, policyRef)), { recursive: true });
  await writeFile(join(mainRoot, policyRef), policyBytes, 'utf8');
  git(mainRoot, ['add', policyRef]);
  git(mainRoot, ['commit', '-m', 'register policy-1']);
  const policyCommit = git(mainRoot, ['rev-parse', 'HEAD']);
  const policyDigest = sha256(policyBytes);
  const policyResponse = await client.mutate('register-authoritative-artifact', { repoId, workstreamRun: runId, sessionId: session.session_id, fencingGeneration: 1, expectedVersion: attachedRun.version, idempotencyKey: `register-policy-${suffix}` }, { artifact_id: `launch-policy-${suffix}`, source_type: 'task', source_scope: 'run-main', document_schema_version: 'autopilot.launch_policy.v1', git_commit: policyCommit, ref: policyRef, sha256: policyDigest, session_lease_id: session.session_lease_id, session_token: token });
  const policyArtifact = parseCoordinationAuthoritativeArtifact(policyResponse.payload['authoritative_artifact']);
  const statusBeforeHeartbeat = await client.query('status', repoId, runId);
  const doctorBeforeHeartbeat = await client.query('doctor', repoId, runId);
  const issued = new Date(); issued.setMilliseconds(Math.max(0, issued.getMilliseconds() - 50));
  const heartbeatFields = { schema_version: 'autopilot.program_heartbeat.v1', program_id: `program-${suffix}`, sequence: 1, prior_sha256: null, issued_at: issued.toISOString(), valid_until: new Date(issued.getTime() + 15 * 60 * 1000).toISOString(), package_commit: 'a'.repeat(40), package_tree: 'b'.repeat(40), base_commit: b0Commit, base_tree: b0Tree, rows: [{ workstream, workstream_run: runId, parent_session_file_sha256: null, coordinator_session_lease_id: session.session_lease_id, accepted_graph_sequence: 1, accepted_graph_sha256: bootstrapSha256, status_sha256: statusBeforeHeartbeat.payload['semantic_snapshot_sha256'], doctor_sha256: doctorBeforeHeartbeat.payload['semantic_snapshot_sha256'], session_lease_state: 'attached', child_lease_ids: [], launch_policy_sha256: policyDigest, last_progress_event_seq: policyResponse.committed_event_seq, last_handoff_sha256: null, row_state: 'active', dispatch_allowed: false, stop_reasons: ['graph-publication-pending'] }], provider_health: [{ provider: 'openai-codex', state: 'healthy', observation_ref: policyRef, observation_sha256: policyDigest, cooldown_until: null, probe_workstream_run: null, probe_ref: null, probe_sha256: null, consumption_event_seq: null }], dispatch_allowed: true, stop_reasons: [], trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256, signer_key_id: trustSha256 };
  const heartbeatSignature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, Buffer.concat([Buffer.from('AUTOPILOT-D65-PROGRAM-HEARTBEAT\0', 'utf8'), Buffer.from(canonicalJson(heartbeatFields), 'utf8')]), privateKey)));
  const heartbeatBytes = `${canonicalJson({ ...heartbeatFields, signature: heartbeatSignature })}\n`;
  const heartbeatRef = 'program-heartbeats/00000000000000000001.json';
  await mkdir(join(programEvidenceRoot, 'program-heartbeats'), { recursive: true, mode: 0o700 });
  chmodSync(join(programEvidenceRoot, 'program-heartbeats'), 0o700);
  await writeFile(join(programEvidenceRoot, heartbeatRef), heartbeatBytes, { encoding: 'utf8', mode: 0o600 });
  chmodSync(join(programEvidenceRoot, heartbeatRef), 0o600);
  const heartbeatDigest = sha256(heartbeatBytes);
  const heartbeatIdentity = { repo_id: repoId, workstream_run: runId, sequence: 1, heartbeat_sha256: heartbeatDigest, acceptance_kind: 'governing' };
  const heartbeatResponse = await client.mutate('accept-program-heartbeat', { repoId, workstreamRun: runId, sessionId: session.session_id, fencingGeneration: 1, expectedVersion: attachedRun.version, idempotencyKey: `accept-program-heartbeat:${sha256(`${canonicalJson(heartbeatIdentity)}\n`)}` }, { program_id: `program-${suffix}`, workstream_run: runId, heartbeat_ref: heartbeatRef, heartbeat_sha256: heartbeatDigest, acceptance_kind: 'governing', expected_prior_sequence: null, expected_prior_sha256: null, session_lease_id: session.session_lease_id, session_token: token });
  const coveredEventSeq = heartbeatResponse.committed_event_seq as number;
  void storedWorktree;
  void storedOperation;
  void policyArtifact;
  const statusAtE = await client.query('status', repoId, runId);
  const snapshot = snapshotFromStatus(statusAtE.payload as Record<string, unknown>, coveredEventSeq);
  const exported = await readD65CoordinatorExport(client, { schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: repoId, repo_key: repoId, autopilot_id: autopilotId, workstream, workstream_run: runId, session_id: session.session_id, session_generation: session.session_generation, run_version: attachedRun.version, session_lease_id: session.session_lease_id, session_token: token, session_version: session.version, pid: session.pid, boot_id: session.boot_id });
  const bootstrapCharter = Object.freeze({ ...reconstructD65BootstrapCharterFromCoordinatorExport(exported, repoId, runId) });
  const sagaEnv: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: sessionPath };
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return { client, repoId, runId, sessionId: session.session_id, sessionLeaseId: session.session_lease_id, sessionToken: token, runVersion: attachedRun.version, mainRoot, priorGraphSha256: priorGraphSha256 as `sha256:${string}`, priorEventSeq, coveredEventSeq, programId: `program-${suffix}`, autopilotId, workstream, policyCommit, sessionPath, sagaEnv, privateKeyPem, snapshot, bootstrapCharter };
}

async function attachOneForeignRunEvent(client: CoordinatorClient, stateRoot: string, repoRoot: string, repoId: string, suffix: string): Promise<ReturnType<typeof parseCoordinationRun>> {
  const workstreamRun = `run-${suffix}`;
  const base = git(repoRoot, ['rev-parse', 'main']);
  const response = await client.mutate('attach-run', { repoId, workstreamRun, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `attach-run-${suffix}` }, {
    repo_key: repoId,
    canonical_root: repoRoot,
    git_common_dir: join(repoRoot, '.git'),
    autopilot_id: `autopilot-${suffix}`,
    workstream: `work-${suffix}`,
    coordination_authority: 'coordinator-edit-leases-v1',
    run_resource: {
      schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: workstreamRun,
      source_repo: repoRoot, git_common_dir: join(repoRoot, '.git'), worktree_root: join(stateRoot, 'worktrees', repoId),
      main_worktree_path: join(stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main'), runtime_root: join(stateRoot, 'worktrees', repoId, 'active', workstreamRun, 'main', '.pi', 'autopilot', `work-${suffix}`),
      branch: `autopilot/${workstreamRun}`, target_branch: 'main', target_base_sha: base, origin_url: null,
      started_at: '2026-07-19T02:00:00.000Z', version: 1,
    },
  });
  return parseCoordinationRun(response.payload['run']);
}

async function withHarness(run: (ctx: { client: CoordinatorClient; stateRoot: string; repoRoot: string; close: () => Promise<void> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-terminal-v2-'));
  const repoRoot = join(root, 'repo');
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  await writeFile(join(repoRoot, 'README.md'), 'B0\n', 'utf8');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'B0']);
  await writeFile(join(repoRoot, 'content-result.txt'), 'sealed content result\n', 'utf8');
  git(repoRoot, ['add', 'content-result.txt']);
  git(repoRoot, ['commit', '-m', 'content result']);
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

// The five fixed core authority documents parent planning writes, the parent-
// planning writer, and the production first-graph publisher wrapper are shared
// by the registration and parent-loss suites.
function coreFileBodies(workstream: string, unitAuthority: Readonly<{ attempt: number; specRef?: string; state?: 'ready' | 'blocked' | 'completed' }> | null = null) {
    const prefix = `.pi/autopilot/${workstream}`;
    const unitState = unitAuthority?.state ?? 'ready';
    const complete = unitState === 'completed';
    const unit = { unit_id: 'unit-a', role: 'implement', state: unitState, attempt: unitAuthority?.attempt ?? 1, ...(unitAuthority?.specRef === undefined ? {} : { spec_ref: unitAuthority.specRef }), summary: `${unitState} unit` };
    const workItems = unitAuthority?.specRef === undefined ? {} : { work_items: { 'work-item-a': { work_item_id: 'work-item-a', state: complete ? 'closed' : 'planned', source_changing: true, unit_ids: ['unit-a'], implementation_unit_id: 'unit-a', summary: 'one exact unit authority' } } };
    const state = { schema_version: 'autopilot.state.v1', workstream, updated_at: '2026-07-19T00:00:00.000Z', status: complete ? 'completed' : 'running', context_gate: { gate: 'ok', percent: complete ? 100 : 10 }, last_event_id: 1, ready_queue: unitState === 'ready' ? ['unit-a'] : [], running: [], blocked: unitState === 'blocked' ? ['unit-a'] : [], completed: complete ? ['unit-a'] : [], units: { 'unit-a': unit }, ...workItems, ...(complete ? { closure_gate: { status: 'passed', checked_at: '2026-07-19T00:00:00.000Z', blocking_reasons: [], summary: 'all terminal-tail gates passed' } } : {}), operator_questions: [], next_actions: complete ? [] : ['dispatch'] };
    const masterPlan = { schema_version: 'autopilot.master_plan.v1', workstream, mission_ref: 'mission.md', goal_summary: 'exercise complete graph authority', non_goals: [], definition_of_done: ['graph accepted'], risk_level: 'low', lanes: [{ lane_id: 'main', summary: 'main', unit_ids: ['unit-a'] }], units: { 'unit-a': { unit_id: 'unit-a', role: 'implement', state: unitState, dependencies: [], summary: `${unitState} unit` } }, ownership_matrix: { owned_paths: [], read_only_paths: [], untouchable_paths: [], held_paths: [] }, verification_matrix: { positive_witnesses: [], negative_witnesses: [], regression_witnesses: [], real_boundary_witnesses: [], blast_radius_checks: [], docs_schema_prompt_checks: [], dirty_tree_checks: [] }, closure_criteria: ['graph accepted'], current_focus: complete ? 'closure' : 'unit-a', last_decision_id: 1, last_event_id: 1, updated_at: '2026-07-19T00:00:00.000Z' };
    const decision = { schema_version: 'autopilot.decision.v1', id: 1, ts: '2026-07-19T00:00:00.000Z', event: 'master_plan_created', workstream, summary: 'created plan', decision: 'run one unit' };
    const event = { schema_version: 'autopilot.event.v1', id: 1, ts: '2026-07-19T00:00:00.000Z', event: 'state_created', workstream, summary: 'created state' };
    return [
      { ref: `${prefix}/mission.md`, body: '# Mission\n' },
      { ref: `${prefix}/master-plan.json`, body: `${JSON.stringify(masterPlan)}\n` },
      { ref: `${prefix}/state.json`, body: `${JSON.stringify(state)}\n` },
      { ref: `${prefix}/decision-log.jsonl`, body: `${JSON.stringify(decision)}\n` },
      { ref: `${prefix}/events.jsonl`, body: `${JSON.stringify(event)}\n` },
    ] as const;
  }

/** Parent planning: write exactly the five previously absent core charter files. */
async function writeParentPlanningCore(ctx: BootstrapCtx, unitAuthority: Readonly<{ attempt: number; specRef?: string; state?: 'ready' | 'blocked' | 'completed' }> | null = null): Promise<void> {
  for (const entry of coreFileBodies(ctx.workstream, unitAuthority)) {
    await mkdir(join(ctx.mainRoot, ...entry.ref.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(ctx.mainRoot, ...entry.ref.split('/')), entry.body, 'utf8');
  }
}

/**
 * Publish + register the exact first complete graph (sequence 2) through the
 * COMPLETE production publisher saga: G (sole parent = policy commit; diff =
 * exactly the five core paths), graph-only H, real durable residue, store
 * registration R, run-main finalize to H, and residue cleanup. This is the
 * production API path (`publishD65FirstCompleteGraphFromEnvironment`), not a
 * fixture serializer.
 */
async function publishFirstGraph(ctx: BootstrapCtx, unitAuthority: Readonly<{ attempt: number; specRef?: string; state?: 'ready' | 'blocked' | 'completed' }> | null = null): Promise<Readonly<{ graphSha256: `sha256:${string}`; publicationCommit: string; registrationEventSeq: number; graphSequence: number }>> {
  await writeParentPlanningCore(ctx, unitAuthority);
  return await publishD65FirstCompleteGraphFromEnvironment({ env: ctx.sagaEnv, createdAt: '2026-07-19T00:00:00.000Z' });
}

/** Sign and accept one exact external heartbeat for a newly accepted graph. */
async function acceptGraphHeartbeat(input: {
  readonly ctx: BootstrapCtx;
  readonly graphSequence: number;
  readonly graphSha256: `sha256:${string}`;
  readonly sessionLeaseId?: string;
  readonly sessionId?: string;
  readonly sessionToken?: string;
  readonly sessionGeneration?: number;
  readonly rowState: 'active' | 'recovering';
  readonly rowStopReasons: readonly string[];
  readonly sessionLeaseState?: 'attached' | 'handoff-pending';
  readonly lastHandoffSha256?: `sha256:${string}` | null;
  readonly providerHealth?: readonly Readonly<Record<string, unknown>>[];
}): Promise<Readonly<{ ref: string; sha256: `sha256:${string}`; bytes: string; response: Awaited<ReturnType<CoordinatorClient['mutate']>>; replay: () => Promise<Awaited<ReturnType<CoordinatorClient['mutate']>>> }>> {
  const { ctx } = input;
  const status = await ctx.client.query('status', ctx.repoId, ctx.runId);
  const doctor = await ctx.client.query('doctor', ctx.repoId, ctx.runId);
  const artifacts = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
  const policyArtifact = artifacts.find((artifact) => artifact.document_schema_version === 'autopilot.launch_policy.v1');
  if (policyArtifact === undefined) throw new Error('graph heartbeat fixture lacks policy authority');
  const policyBytes = await readFile(join(ctx.mainRoot, policyArtifact.evidence.ref), 'utf8');
  const policy = JSON.parse(policyBytes) as Record<string, unknown>;
  const head = status.payload['accepted_program_heartbeat'] as Record<string, unknown>;
  const sequence = Number(head['sequence']) + 1;
  const priorSha = head['heartbeat_sha256'] as `sha256:${string}`;
  const run = parseCoordinationRun((status.payload['runs'] as unknown[])[0]);
  const issued = new Date(); issued.setMilliseconds(Math.max(0, issued.getMilliseconds() - 50));
  const fields = {
    schema_version: 'autopilot.program_heartbeat.v1', program_id: ctx.programId, sequence, prior_sha256: priorSha,
    issued_at: issued.toISOString(), valid_until: new Date(issued.getTime() + 15 * 60 * 1000).toISOString(),
    package_commit: policy['package_commit'], package_tree: policy['package_tree'], base_commit: policy['base_commit'], base_tree: policy['base_tree'],
    rows: [{ workstream: ctx.workstream, workstream_run: ctx.runId, parent_session_file_sha256: null, coordinator_session_lease_id: input.sessionLeaseId ?? ctx.sessionLeaseId, accepted_graph_sequence: input.graphSequence, accepted_graph_sha256: input.graphSha256, status_sha256: status.payload['semantic_snapshot_sha256'], doctor_sha256: doctor.payload['semantic_snapshot_sha256'], session_lease_state: input.sessionLeaseState ?? 'attached', child_lease_ids: [], launch_policy_sha256: policyArtifact.evidence.sha256, last_progress_event_seq: run.version, last_handoff_sha256: input.lastHandoffSha256 ?? null, row_state: input.rowState, dispatch_allowed: input.rowStopReasons.length === 0, stop_reasons: [...input.rowStopReasons] }],
    provider_health: input.providerHealth ?? [{ provider: 'openai-codex', state: 'healthy', observation_ref: policyArtifact.evidence.ref, observation_sha256: policyArtifact.evidence.sha256, cooldown_until: null, probe_workstream_run: null, probe_ref: null, probe_sha256: null, consumption_event_seq: null }],
    dispatch_allowed: true, stop_reasons: [], trust_anchor_ref: policy['trust_anchor_ref'], trust_anchor_sha256: policy['trust_anchor_sha256'], signer_key_id: policy['signer_key_id'],
  };
  const signature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, Buffer.concat([Buffer.from('AUTOPILOT-D65-PROGRAM-HEARTBEAT\0', 'utf8'), Buffer.from(canonicalJson(fields), 'utf8')]), createPrivateKey(ctx.privateKeyPem))));
  const bytes = `${canonicalJson({ ...fields, signature })}\n`;
  const ref = `program-heartbeats/${String(sequence).padStart(20, '0')}.json`;
  const evidenceRoot = String(policy['program_evidence_root']);
  await writeFile(join(evidenceRoot, ref), bytes, { encoding: 'utf8', mode: 0o600 });
  chmodSync(join(evidenceRoot, ref), 0o600);
  const digest = sha256(bytes);
  const identity = { repo_id: ctx.repoId, workstream_run: ctx.runId, sequence, heartbeat_sha256: digest, acceptance_kind: 'governing' };
  const replay = () => ctx.client.mutate('accept-program-heartbeat', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: input.sessionId ?? ctx.sessionId, fencingGeneration: input.sessionGeneration ?? 1, expectedVersion: run.version, idempotencyKey: `accept-program-heartbeat:${sha256(`${canonicalJson(identity)}\n`)}` }, { program_id: ctx.programId, workstream_run: ctx.runId, heartbeat_ref: ref, heartbeat_sha256: digest, acceptance_kind: 'governing', expected_prior_sequence: sequence - 1, expected_prior_sha256: priorSha, session_lease_id: input.sessionLeaseId ?? ctx.sessionLeaseId, session_token: input.sessionToken ?? ctx.sessionToken });
  const response = await replay();
  return Object.freeze({ ref, sha256: digest, bytes, response, replay });
}

void describe('D65 non-self-referential graph registration', () => {
  /** Build the production first-graph body from real G bytes at `authorityCommit`. */
  function produceFirstGraph(ctx: BootstrapCtx, authority: { readonly commit: string; readonly tree: string }, coveredEventSeq: number, snapshot: D65CoordinatorProjectionSnapshot): D65ProducedGraph {
    return produceD65CompleteGraphFromAuthority({
      header: {
        program_id: ctx.programId, repo_id: ctx.repoId, autopilot_id: ctx.autopilotId, workstream: ctx.workstream, workstream_run: ctx.runId,
        graph_sequence: 2, prior_graph_sha256: ctx.priorGraphSha256, prior_event_seq: ctx.priorEventSeq,
        covered_authority_commit: authority.commit, covered_authority_tree: authority.tree, covered_event_seq: coveredEventSeq,
        created_at: '2026-07-19T00:00:00.000Z', bootstrap_charter: ctx.bootstrapCharter,
      },
      readGitAtG: readD65GraphAuthorityAtCommit(ctx.mainRoot, authority.commit),
      acceptedArtifacts: snapshot.authoritative_artifacts,
      coordinatorProjection: snapshot,
    });
  }

  /** Commit exactly the five core charter files as G with sole parent = policy commit. */
  async function commitAuthorityCore(ctx: BootstrapCtx): Promise<{ commit: string; tree: string }> {
    await writeParentPlanningCore(ctx);
    git(ctx.mainRoot, ['add', '.']);
    git(ctx.mainRoot, ['commit', '-m', 'authority core G']);
    return { commit: git(ctx.mainRoot, ['rev-parse', 'HEAD']), tree: git(ctx.mainRoot, ['rev-parse', 'HEAD^{tree}']) };
  }

  /** Commit graph blobs as a graph-only H whose sole parent is G, then reset back to G. */
  async function commitGraphOnlyH(ctx: BootstrapCtx, produced: D65ProducedGraph, message: string): Promise<string> {
    const files = [{ ref: produced.rootRef, bytes: Buffer.from(produced.rootBytes) }, ...produced.shards.map((shard) => ({ ref: shard.ref, bytes: Buffer.from(shard.bytes) }))];
    for (const file of files) {
      await mkdir(join(ctx.mainRoot, ...file.ref.split('/').slice(0, -1)), { recursive: true });
      await writeFile(join(ctx.mainRoot, ...file.ref.split('/')), file.bytes);
    }
    git(ctx.mainRoot, ['add', '.']);
    git(ctx.mainRoot, ['commit', '-m', message]);
    const h = git(ctx.mainRoot, ['rev-parse', 'HEAD']);
    const g = git(ctx.mainRoot, ['rev-parse', 'HEAD^']);
    git(ctx.mainRoot, ['reset', '--hard', g]);
    return h;
  }

  /** Seal the real publication-committed residue binding this exact G/H/root tuple. */
  async function sealPublicationCommittedResidue(ctx: BootstrapCtx, input: { readonly authorityCommit: string; readonly authorityTree: string; readonly publicationCommit: string; readonly produced: D65ProducedGraph; readonly coveredEventSeq: number; readonly graphSequence?: number; readonly priorOverride?: Partial<{ prior_graph_sha256: `sha256:${string}`; prior_registration_event_seq: number }> }): Promise<void> {
    const sequence = input.graphSequence ?? 2;
    const residue = {
      schema_version: 'autopilot.graph_publication.v1', publication_id: `publication-${String(sequence)}`, program_id: ctx.programId,
      repo_id: ctx.repoId, autopilot_id: ctx.autopilotId, workstream_run: ctx.runId, graph_sequence: sequence,
      artifact_id: `semantic-graph:${String(sequence).padStart(20, '0')}`, stage: 'publication-committed', prior_authority_kind: 'bootstrap',
      prior_graph_sha256: input.priorOverride?.prior_graph_sha256 ?? ctx.priorGraphSha256, prior_publication_commit: null,
      prior_registration_event_seq: input.priorOverride?.prior_registration_event_seq ?? ctx.priorEventSeq,
      authority_base_commit: ctx.policyCommit, authority_path_count: 5, authority_path_manifest_sha256: canonicalSha256([]),
      authority_commit: input.authorityCommit, authority_tree: input.authorityTree, covered_event_seq: input.coveredEventSeq,
      publication_commit: input.publicationCommit, publication_tree: git(ctx.mainRoot, ['rev-parse', `${input.publicationCommit}^{tree}`]),
      graph_ref: input.produced.rootRef, graph_sha256: sha256(Buffer.from(input.produced.rootBytes).toString('utf8')),
      graph_byte_count: input.produced.rootBytes.length, registration_event_seq: null,
      created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-19T00:00:00.000Z',
    };
    const residuePath = join(dirname(ctx.mainRoot), '_graph-publication.json');
    await writeFile(residuePath, `${canonicalJson(residue)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(residuePath, 0o600);
  }

  async function removeResidue(ctx: BootstrapCtx): Promise<void> {
    await rm(join(dirname(ctx.mainRoot), '_graph-publication.json'), { force: true });
  }

  /** Manually publish G+H+residue and register through the coordinator (for negatives). */
  async function manualPublishAndRegister(client: CoordinatorClient, ctx: BootstrapCtx, options: {
    readonly mutateRoot?: (root: Record<string, unknown>) => Record<string, unknown>;
    readonly mutateShards?: (shards: readonly { ref: string; bytes: Uint8Array }[]) => readonly { ref: string; bytes: Uint8Array }[];
    readonly extraCommitPaths?: readonly { ref: string; body: string }[];
    readonly skipResidue?: boolean;
    readonly wrongTree?: string;
    readonly idempotencyKey: string;
  }): Promise<Awaited<ReturnType<CoordinatorClient['mutate']>>> {
    const authority = await commitAuthorityCore(ctx);
    const status = await client.query('status', ctx.repoId, ctx.runId);
    const snapshot = snapshotFromStatus(status.payload as Record<string, unknown>, ctx.coveredEventSeq);
    const produced = produceFirstGraph(ctx, { commit: authority.commit, tree: options.wrongTree ?? authority.tree }, ctx.coveredEventSeq, snapshot);
    let root = { ...(JSON.parse(new TextDecoder().decode(produced.rootBytes)) as Record<string, unknown>) };
    if (options.mutateRoot !== undefined) root = options.mutateRoot(root);
    const rootBytes = Buffer.from(`${canonicalJson(root)}\n`, 'utf8');
    let shards: readonly { ref: string; bytes: Uint8Array }[] = produced.shards.map((shard) => ({ ref: shard.ref, bytes: shard.bytes }));
    if (options.mutateShards !== undefined) shards = options.mutateShards(shards);
    const files = [{ ref: produced.rootRef, bytes: rootBytes as Uint8Array }, ...shards];
    for (const file of files) {
      await mkdir(join(ctx.mainRoot, ...file.ref.split('/').slice(0, -1)), { recursive: true });
      await writeFile(join(ctx.mainRoot, ...file.ref.split('/')), Buffer.from(file.bytes));
    }
    for (const extra of options.extraCommitPaths ?? []) {
      await mkdir(join(ctx.mainRoot, ...extra.ref.split('/').slice(0, -1)), { recursive: true });
      await writeFile(join(ctx.mainRoot, ...extra.ref.split('/')), extra.body, 'utf8');
    }
    git(ctx.mainRoot, ['add', '.']);
    git(ctx.mainRoot, ['commit', '-m', 'publish graph 2 (manual)']);
    const h = git(ctx.mainRoot, ['rev-parse', 'HEAD']);
    git(ctx.mainRoot, ['reset', '--hard', authority.commit]);
    const graphSha = sha256(rootBytes.toString('utf8'));
    const manualProduced: D65ProducedGraph = { root: produced.root, rootBytes, rootRef: produced.rootRef, shards: shards.map((shard) => ({ ref: shard.ref, bytes: shard.bytes })) };
    if (options.skipResidue !== true) await sealPublicationCommittedResidue(ctx, { authorityCommit: authority.commit, authorityTree: authority.tree, publicationCommit: h, produced: manualProduced, coveredEventSeq: ctx.coveredEventSeq });
    const statusNow = await client.query('status', ctx.repoId, ctx.runId);
    const runVersion = (statusNow.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
    return await client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: runVersion, idempotencyKey: options.idempotencyKey }, {
      artifact_id: 'semantic-graph:00000000000000000002', source_type: 'task', source_scope: 'run-main', document_schema_version: 'autopilot.semantic_graph.v1', git_commit: h, ref: produced.rootRef, sha256: graphSha, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
    });
  }

  void it('publishes and registers the exact first complete graph through the production saga', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'g');
      const result = await publishFirstGraph(ctx);
      assert.equal(result.graphSequence, 2);
      assert.equal(result.registrationEventSeq, ctx.coveredEventSeq + 1);
      // Run-main finalized to H with a clean worktree; residue cleaned up.
      assert.equal(git(ctx.mainRoot, ['rev-parse', 'HEAD']), result.publicationCommit);
      assert.equal(git(ctx.mainRoot, ['status', '--porcelain']), '');
      assert.equal(existsSync(join(dirname(ctx.mainRoot), '_graph-publication.json')), false);
      // The accepted artifact is the exact registered tuple.
      const status = await client.query('status', ctx.repoId, ctx.runId);
      const artifacts = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
      const graphArtifact = artifacts.find((artifact) => artifact.artifact_id === 'semantic-graph:00000000000000000002');
      assert.notEqual(graphArtifact, undefined);
      assert.equal(graphArtifact?.git_commit, result.publicationCommit);
      assert.equal(graphArtifact?.evidence.sha256, result.graphSha256);
      // First G's sole parent is the accepted policy commit.
      const gCommit = git(ctx.mainRoot, ['rev-parse', `${result.publicationCommit}^`]);
      assert.equal(git(ctx.mainRoot, ['rev-parse', `${gCommit}^`]), ctx.policyCommit);
    });
  });

  void it('rejects a direct registration without the durable pending publication residue', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'nores');
      await assert.rejects(
        () => manualPublishAndRegister(client, ctx, { skipResidue: true, idempotencyKey: 'register-graph-nores' }),
        /semantic-graph-publication-pending: D65 graph registration requires its durable pending publication residue/u,
      );
    });
  });

  void it('rejects an omitted fixed-root authority member discovered independently at G', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'body-omit');
      // A real evidence file exists at G, but the manual root claims empty
      // evidence: independent store-side discovery must reject the omission.
      const omittedRef = `.pi/autopilot/${ctx.workstream}/evidence/omitted.txt`;
      await mkdir(dirname(join(ctx.mainRoot, omittedRef)), { recursive: true });
      await writeFile(join(ctx.mainRoot, omittedRef), 'independently discovered authority\n', 'utf8');
      const emptyIndex = { entry_count: 0, total_bytes: 0, sha256: sha256('[]\n'), shards: [] };
      await assert.rejects(
        () => manualPublishAndRegister(client, ctx, {
          mutateRoot: (root) => ({ ...root, collections: { ...(root['collections'] as Record<string, unknown>), evidence: emptyIndex } }),
          mutateShards: (shards) => shards.filter((shard) => !shard.ref.includes('/evidence/')),
          idempotencyKey: 'register-graph-body-omit',
        }),
        /loaded authority collection does not equal independent G discovery/u,
      );
    });
  });

  void it('rejects repository-scoped semantic graph registration before reading repository bytes', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'scope');
      const status = await client.query('status', ctx.repoId, ctx.runId);
      const runVersion = (status.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
      await assert.rejects(
        () => client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: runVersion, idempotencyKey: 'reject-repository-scoped-graph' }, {
          artifact_id: 'semantic-graph:00000000000000000002', source_type: 'task', source_scope: 'repository', document_schema_version: 'autopilot.semantic_graph.v1', git_commit: git(ctx.mainRoot, ['rev-parse', 'HEAD']), ref: 'semantic-graphs/00000000000000000002/graph.json', sha256: `sha256:${'0'.repeat(64)}`, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
        }),
        /semantic graph registration requires source_type=task and source_scope=run-main/u,
      );
    });
  });

  void it('rejects fabricated no-event N+1 and retains the accepted graph tuple', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'noevent');
      const first = await publishFirstGraph(ctx);
      // The coordinator-only successor preparer must classify the state as
      // already-current (no semantic event after R) and refuse to build N+1.
      const status = await client.query('status', ctx.repoId, ctx.runId);
      const currentRun = parseCoordinationRun((status.payload['runs'] as unknown[])[0]);
      const currentSession = parseCoordinationSessionLease((status.payload['session_leases'] as unknown[])[0]);
      const publicationNeed = await prepareD65CoordinatorOnlySuccessor({
        client,
        session: { schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: ctx.repoId, repo_key: ctx.repoId, autopilot_id: currentRun.autopilot_id, workstream: currentRun.workstream, workstream_run: ctx.runId, session_id: currentSession.session_id, session_generation: currentSession.session_generation, run_version: currentRun.version, session_lease_id: currentSession.session_lease_id, session_token: ctx.sessionToken, session_version: currentSession.version, pid: currentSession.pid, boot_id: currentSession.boot_id },
        authorityBaseCommit: first.publicationCommit,
        authorityBaseTree: git(ctx.mainRoot, ['rev-parse', `${first.publicationCommit}^{tree}`]),
        createdAt: '2026-07-19T00:00:00.000Z',
      });
      assert.equal(publicationNeed.state, 'already-current');
      assert.equal(publicationNeed.graphSequence, 2);
      assert.equal(publicationNeed.semanticEventType, null);
      // A forged direct no-event graph-3 registration fails at the CAS boundary
      // (its residue/prior tuple would be for graph 3 with no semantic event).
      const after = await client.query('status', ctx.repoId, ctx.runId);
      assert.equal((after.payload['authoritative_artifacts'] as Array<Record<string, unknown>>).some((artifact) => artifact['artifact_id'] === 'semantic-graph:00000000000000000003'), false);
    });
  });

  void it('does not let a foreign run event authorize this run no-op N+1', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'foreign-noop');
      const first = await publishFirstGraph(ctx);
      await acceptGraphHeartbeat({ ctx, graphSequence: first.graphSequence, graphSha256: first.graphSha256, rowState: 'active', rowStopReasons: [] });
      const foreign = await attachOneForeignRunEvent(client, stateRoot, initialRepoRoot, ctx.repoId, 'foreign-noop-peer');
      assert.notEqual(foreign.workstream_run, ctx.runId);
      const status = await client.query('status', ctx.repoId, ctx.runId);
      const currentRun = parseCoordinationRun((status.payload['runs'] as unknown[])[0]);
      const currentSession = parseCoordinationSessionLease((status.payload['session_leases'] as unknown[])[0]);
      const publicationNeed = await prepareD65CoordinatorOnlySuccessor({
        client,
        session: { schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: ctx.repoId, repo_key: ctx.repoId, autopilot_id: currentRun.autopilot_id, workstream: currentRun.workstream, workstream_run: ctx.runId, session_id: currentSession.session_id, session_generation: currentSession.session_generation, run_version: currentRun.version, session_lease_id: currentSession.session_lease_id, session_token: ctx.sessionToken, session_version: currentSession.version, pid: currentSession.pid, boot_id: currentSession.boot_id },
        authorityBaseCommit: first.publicationCommit,
        authorityBaseTree: git(ctx.mainRoot, ['rev-parse', `${first.publicationCommit}^{tree}`]),
        createdAt: '2026-07-19T00:00:00.000Z',
      });
      assert.equal(publicationNeed.state, 'already-current');
      assert.equal(publicationNeed.graphSequence, 2);
      assert.equal(publicationNeed.semanticEventType, null);
      const after = await client.query('status', ctx.repoId, ctx.runId);
      assert.equal((after.payload['authoritative_artifacts'] as Array<Record<string, unknown>>).some((artifact) => artifact['artifact_id'] === 'semantic-graph:00000000000000000003'), false);
      // The same foreign event must not make the accepted graph stale and
      // deadlock ordinary dispatch when there is no current-run N+1 to publish.
      const sessionAfter = (after.payload['session_leases'] as unknown[]).map(parseCoordinationSessionLease).find((entry) => entry.session_lease_id === ctx.sessionLeaseId);
      if (sessionAfter === undefined) throw new Error('foreign no-op fixture lost its current session');
      const handoff = await client.mutate('prepare-handoff', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: sessionAfter.version, idempotencyKey: 'foreign-noop-ordinary-handoff' }, { handoff_token: 'foreign-noop-handoff-token', session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken });
      assert.equal(parseCoordinationSessionLease(handoff.payload['session']).status, 'handoff-pending');
    });
  });

  void it('rejects a queue projection whose loaded members disagree with the authority state equations', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'q');
      const emptyIndex = { entry_count: 0, total_bytes: 0, sha256: sha256('[]\n'), shards: [] };
      // Claim unit_ready is empty though the state has one ready unit.
      await assert.rejects(
        () => manualPublishAndRegister(client, ctx, {
          mutateRoot: (root) => ({ ...root, queue_projection: { ...(root['queue_projection'] as Record<string, unknown>), unit_ready: emptyIndex } }),
          mutateShards: (shards) => shards.filter((shard) => !shard.ref.includes('/unit_ready/')),
          idempotencyKey: 'register-graph-q',
        }),
        /unit_ready index entry_count 0 does not equal the derived queue size 1/u,
      );
    });
  });

  void it('rejects a queue whose loaded shard blob is missing at the publication commit', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'n');
      await assert.rejects(
        () => manualPublishAndRegister(client, ctx, {
          mutateShards: (shards) => shards.filter((shard) => !shard.ref.includes('/unit_ready/')),
          idempotencyKey: 'register-graph-n',
        }),
        /is not exactly graph root plus referenced shards|must resolve to exactly one Git tree entry/u,
      );
    });
  });

  void it('commits graph registration WITHOUT advancing the residue (SR-1)', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'r');
      // Manual publication with a REAL production-produced graph and a REAL
      // publication-committed residue; the store must commit R while leaving the
      // residue byte-untouched at publication-committed.
      const registered = await manualPublishAndRegister(client, ctx, { idempotencyKey: 'register-graph-r' });
      assert.equal(registered.committed_event_seq !== null, true);
      const finalResidue = JSON.parse(await readFile(join(dirname(ctx.mainRoot), '_graph-publication.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(finalResidue['stage'], 'publication-committed');
      assert.equal(finalResidue['registration_event_seq'], null);
    });
  });

  // SR-3: the register idempotency key binds the exact payload tuple; a
  // byte-identical replay returns the same committed effect and a changed bound
  // field under the same key is an idempotency-conflict.
  void it('replays a byte-identical register idempotently (SR-3) and rejects a changed tuple under the same key', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'i');
      const authority = await commitAuthorityCore(ctx);
      const status = await client.query('status', ctx.repoId, ctx.runId);
      const snapshot = snapshotFromStatus(status.payload as Record<string, unknown>, ctx.coveredEventSeq);
      const produced = produceFirstGraph(ctx, authority, ctx.coveredEventSeq, snapshot);
      const h = await commitGraphOnlyH(ctx, produced, 'publish graph 2 (idempotent register)');
      await sealPublicationCommittedResidue(ctx, { authorityCommit: authority.commit, authorityTree: authority.tree, publicationCommit: h, produced, coveredEventSeq: ctx.coveredEventSeq });
      const graphSha = sha256(Buffer.from(produced.rootBytes).toString('utf8'));
      const runVersion = (status.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
      const registerPayload = {
        artifact_id: 'semantic-graph:00000000000000000002', source_type: 'task', source_scope: 'run-main', document_schema_version: 'autopilot.semantic_graph.v1', git_commit: h, ref: produced.rootRef, sha256: graphSha, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
      } as const;
      const identity = { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: runVersion, idempotencyKey: 'register-graph-idem' } as const;
      const first = await client.mutate('register-authoritative-artifact', identity, { ...registerPayload });
      assert.equal(first.committed_event_seq !== null, true);
      const committedR = first.committed_event_seq;
      const replay = await client.mutate('register-authoritative-artifact', identity, { ...registerPayload });
      assert.equal(replay.committed_event_seq, committedR);
      assert.equal(canonicalJson(replay.payload['authoritative_artifact']), canonicalJson(first.payload['authoritative_artifact']));
      git(ctx.mainRoot, ['commit', '--allow-empty', '-m', 'a distinct later commit']);
      const h2 = git(ctx.mainRoot, ['rev-parse', 'HEAD']);
      git(ctx.mainRoot, ['reset', '--hard', authority.commit]);
      assert.notEqual(h2, h);
      await assert.rejects(
        () => client.mutate('register-authoritative-artifact', identity, { ...registerPayload, git_commit: h2 }),
        /idempotency key was reused with a different request/u,
      );
    });
  });

  // SR-2: response-loss recovery lookup over a REAL registered first graph.
  void it('surfaces the exact committed graph registration for response-loss recovery and fails closed on absence/mismatch (SR-2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-graph-sr2-'));
    const initialRepoRoot = join(root, 'repo');
    await mkdir(initialRepoRoot, { recursive: true });
    git(initialRepoRoot, ['init', '-b', 'main']);
    await writeFile(join(initialRepoRoot, 'README.md'), 'B0\n', 'utf8');
    git(initialRepoRoot, ['add', 'README.md']);
    git(initialRepoRoot, ['commit', '-m', 'B0']);
    await writeFile(join(initialRepoRoot, 'content-result.txt'), 'sealed content result\n', 'utf8');
    git(initialRepoRoot, ['add', 'content-result.txt']);
    git(initialRepoRoot, ['commit', '-m', 'content result']);
    const stateRoot = join(root, 'state');
    const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    const client = new CoordinatorClient({ env, autoStart: false });
    let committedR: number;
    let artifactId: string;
    let publicationCommit: string;
    let graphSha: `sha256:${string}`;
    let coveredEventSeq: number;
    let repoId: string;
    let runId: string;
    try {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'sr2');
      repoId = ctx.repoId;
      runId = ctx.runId;
      coveredEventSeq = ctx.coveredEventSeq;
      const result = await publishFirstGraph(ctx);
      committedR = result.registrationEventSeq;
      publicationCommit = result.publicationCommit;
      graphSha = result.graphSha256;
      artifactId = 'semantic-graph:00000000000000000002';
    } finally {
      await server.close();
    }
    const store = await CoordinatorStore.open(coordinatorRuntimePaths(env));
    try {
      const idempotencyKey = `register-authoritative-artifact:${artifactId}:${graphSha}`;
      const lookup = { artifactId, publicationCommit, graphRef: 'semantic-graphs/00000000000000000002/graph.json', graphSha256: graphSha, coveredEventSeq, idempotencyKey } as const;
      const proven = store.lookupCommittedGraphRegistration(repoId, runId, lookup);
      assert.notEqual(proven, null);
      assert.equal(proven?.registrationEventSeq, committedR);
      assert.equal(proven?.registrationEventSeq, coveredEventSeq + 1);
      assert.equal(store.lookupCommittedGraphRegistration(repoId, runId, { ...lookup, artifactId: 'semantic-graph:00000000000000000003', coveredEventSeq: coveredEventSeq + 1, idempotencyKey: 'register-graph-3-absent' }), null);
      assert.throws(() => store.lookupCommittedGraphRegistration(repoId, runId, { ...lookup, publicationCommit: 'f'.repeat(40) }), /git_commit does not match the sealed publication commit H/u);
      assert.throws(() => store.lookupCommittedGraphRegistration(repoId, runId, { ...lookup, graphSha256: `sha256:${'0'.repeat(64)}` }), /evidence digest does not match the sealed graph_sha256/u);
      assert.throws(() => store.lookupCommittedGraphRegistration(repoId, runId, { ...lookup, coveredEventSeq: coveredEventSeq + 5 }), /event sequence is not exactly R=E\+1/u);
      assert.throws(() => store.lookupCommittedGraphRegistration(repoId, 'run-other', lookup), /identity\/scope\/version is not exact/u);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('rejects a first authority G whose sole parent is not the accepted policy commit', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'gpar');
      // An interloper commit between the policy commit and G breaks the frozen
      // first-G parent rule even though the core paths are exact.
      git(ctx.mainRoot, ['commit', '--allow-empty', '-m', 'interloper before G']);
      await assert.rejects(
        () => manualPublishAndRegister(client, ctx, { idempotencyKey: 'register-graph-gpar' }),
        /first authority G must have the accepted policy commit as its sole parent|successor authority movement/u,
      );
    });
  });

  void it('rejects a first authority G whose parent-planning diff carries an extra non-core path', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'gextra');
      // The extra path is committed WITH the core files into G itself, so the
      // policy→G diff is six paths instead of the exact five.
      await writeParentPlanningCore(ctx);
      await writeFile(join(ctx.mainRoot, 'extra-planning-output.txt'), 'unauthorized extra planning artifact\n', 'utf8');
      git(ctx.mainRoot, ['add', '.']);
      git(ctx.mainRoot, ['commit', '-m', 'authority core G plus extra path']);
      const authority = { commit: git(ctx.mainRoot, ['rev-parse', 'HEAD']), tree: git(ctx.mainRoot, ['rev-parse', 'HEAD^{tree}']) };
      const status = await client.query('status', ctx.repoId, ctx.runId);
      const snapshot = snapshotFromStatus(status.payload as Record<string, unknown>, ctx.coveredEventSeq);
      const produced = produceFirstGraph(ctx, authority, ctx.coveredEventSeq, snapshot);
      const h = await commitGraphOnlyH(ctx, produced, 'publish graph 2 (extra path negative)');
      await sealPublicationCommittedResidue(ctx, { authorityCommit: authority.commit, authorityTree: authority.tree, publicationCommit: h, produced, coveredEventSeq: ctx.coveredEventSeq });
      const graphSha = sha256(Buffer.from(produced.rootBytes).toString('utf8'));
      const runVersion = (status.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
      await assert.rejects(
        () => client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: runVersion, idempotencyKey: 'register-graph-gextra' }, {
          artifact_id: 'semantic-graph:00000000000000000002', source_type: 'task', source_scope: 'run-main', document_schema_version: 'autopilot.semantic_graph.v1', git_commit: h, ref: produced.rootRef, sha256: graphSha, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
        }),
        /no-event parent planning must change exactly the five core paths|loaded authority collection does not equal independent G discovery/u,
      );
    });
  });

  void it('rejects a forged bootstrap charter that does not equal immutable B event\/result authority', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'gforge');
      const charter = ctx.bootstrapCharter as Record<string, Record<string, unknown>>;
      // Forge the attach_event occurrence time: the charter still parses (the
      // field is not duplicated inside attach_result) but no longer equals the
      // immutable B event authority reconstructed by the store.
      const forgedCharter = { ...ctx.bootstrapCharter, attach_event: { ...charter['attach_event'], occurred_at: '1999-01-01T00:00:00.000Z' } };
      await assert.rejects(
        () => manualPublishAndRegister(client, { ...ctx, bootstrapCharter: Object.freeze(forgedCharter) }, { idempotencyKey: 'register-graph-gforge' }),
        /graph charter does not equal immutable B event\/result authority/u,
      );
    });
  });

  void it('rejects a graph whose covered_authority_tree does not match the authority commit tree', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 't');
      await assert.rejects(
        () => manualPublishAndRegister(client, ctx, { wrongTree: 'd'.repeat(40), idempotencyKey: 'register-graph-t' }),
        /covered_authority_tree does not match the authority commit tree/u,
      );
    });
  });

  void it('rejects a publication commit that also changes a non-graph product path', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'p');
      await assert.rejects(
        () => manualPublishAndRegister(client, ctx, { extraCommitPaths: [{ ref: 'product.ts', body: 'export const x = 1;\n' }], idempotencyKey: 'register-graph-p' }),
        /changes a non-graph path/u,
      );
    });
  });

  // Sub-part 2a: prior-tuple CAS + R=E+1. Each negative keeps everything else
  // faithful and tampers exactly one bound field so the CAS is the sole cause.
  async function publishAndRegisterWithCas(client: CoordinatorClient, ctx: BootstrapCtx, cas: { readonly priorGraphSha256: `sha256:${string}`; readonly priorEventSeq: number; readonly coveredEventSeq: number }): Promise<void> {
    const authority = await commitAuthorityCore(ctx);
    const status = await client.query('status', ctx.repoId, ctx.runId);
    const snapshot = snapshotFromStatus(status.payload as Record<string, unknown>, ctx.coveredEventSeq);
    const tampered: BootstrapCtx = { ...ctx, priorGraphSha256: cas.priorGraphSha256, priorEventSeq: cas.priorEventSeq };
    const produced = produceFirstGraph(tampered, authority, cas.coveredEventSeq, { ...snapshot, covered_event_seq: cas.coveredEventSeq });
    const h = await commitGraphOnlyH(ctx, produced, 'publish graph 2 (cas negative)');
    await sealPublicationCommittedResidue(ctx, { authorityCommit: authority.commit, authorityTree: authority.tree, publicationCommit: h, produced, coveredEventSeq: cas.coveredEventSeq, priorOverride: { prior_graph_sha256: cas.priorGraphSha256, prior_registration_event_seq: cas.priorEventSeq } });
    const graphSha = sha256(Buffer.from(produced.rootBytes).toString('utf8'));
    const runVersion = (status.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
    await client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: runVersion, idempotencyKey: 'register-graph-cas' }, {
      artifact_id: 'semantic-graph:00000000000000000002', source_type: 'task', source_scope: 'run-main', document_schema_version: 'autopilot.semantic_graph.v1', git_commit: h, ref: produced.rootRef, sha256: graphSha, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
    });
  }

  void it('rejects a first complete graph whose covered_event_seq is not the current head (R=E+1)', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'e');
      await assert.rejects(
        () => publishAndRegisterWithCas(client, ctx, { priorGraphSha256: ctx.priorGraphSha256, priorEventSeq: ctx.priorEventSeq, coveredEventSeq: ctx.coveredEventSeq + 1 }),
        /semantic-graph-cas-conflict: graph covered_event_seq must equal the current coordinator event sequence/u,
      );
    });
  });

  void it('rejects a first complete graph whose prior_graph_sha256 is not the accepted bootstrap digest', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'd');
      await assert.rejects(
        () => publishAndRegisterWithCas(client, ctx, { priorGraphSha256: `sha256:${'a'.repeat(64)}`, priorEventSeq: ctx.priorEventSeq, coveredEventSeq: ctx.coveredEventSeq }),
        /first publication residue does not bind the accepted bootstrap prior tuple|first complete graph prior_graph_sha256 is not the accepted bootstrap digest/u,
      );
    });
  });

  void it('rejects a first complete graph whose prior_event_seq is not the bootstrap attach receipt', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'b');
      await assert.rejects(
        () => publishAndRegisterWithCas(client, ctx, { priorGraphSha256: ctx.priorGraphSha256, priorEventSeq: ctx.priorEventSeq + 41, coveredEventSeq: ctx.coveredEventSeq }),
        /first publication residue does not bind the accepted bootstrap prior tuple|first complete graph prior_event_seq is not the bootstrap attach receipt/u,
      );
    });
  });

  // Bootstrap-mode denies any non-charter artifact registration, so a mission
  // document can no longer squat the semantic-graph:<seq> namespace before the
  // first complete graph. This proves the whitelist gate rather than tolerating
  // the squatter.
  void it('denies a non-charter artifact squatting the semantic-graph:<seq> id in bootstrap mode', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 's');
      const missionRef = 'runtime/mission.md';
      const missionBody = '# Mission\n## Goal\ng\n## Non-goals / exclusions\nn\n## Perfect-quality bar\np\n## Definition of done\nd\n## Key constraints\nk\n## Current strategy summary\nc\n## Open questions\no\n';
      await mkdir(join(ctx.mainRoot, 'runtime'), { recursive: true });
      await writeFile(join(ctx.mainRoot, missionRef), missionBody, 'utf8');
      git(ctx.mainRoot, ['add', '.']);
      git(ctx.mainRoot, ['commit', '-m', 'mission squatter']);
      const missionCommit = git(ctx.mainRoot, ['rev-parse', 'HEAD']);
      const missionSha = sha256(missionBody);
      const status1 = await client.query('status', ctx.repoId, ctx.runId);
      const version1 = (status1.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
      await assert.rejects(
        () => client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: version1, idempotencyKey: 'register-mission-squatter' }, {
          artifact_id: 'semantic-graph:00000000000000000009', source_type: 'mission', source_scope: 'run-main', document_schema_version: 'autopilot.mission.v1', git_commit: missionCommit, ref: missionRef, sha256: missionSha, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
        }),
        /bootstrap mode permits only launch-policy and complete-graph artifact registration/u,
      );
      // The legitimate first complete graph still publishes after resetting the
      // squatter commit away (parent planning must start from the policy HEAD).
      git(ctx.mainRoot, ['reset', '--hard', ctx.policyCommit]);
      await removeResidue(ctx);
      const result = await publishFirstGraph(ctx);
      assert.equal(result.graphSequence, 2);
    });
  });
});

void describe('D65 bootstrap main-worktree effect authority', () => {
  // The exact positive is exercised end-to-end by every bootstrapAttach above
  // (the saga's external action passes through the bootstrap boundary). These
  // negatives prove the narrow path rejects everything except that one exact
  // effect, without weakening ordinary dispatch.
  async function partialBootstrap(client: CoordinatorClient, stateRoot: string, repoRoot: string, suffix: string): Promise<{ readonly ctxEnv: ProcessEnvLike; readonly mainRoot: string; readonly branch: string; readonly contentCommit: string; readonly repoId: string; readonly runId: string; readonly active: ActiveAutopilotRow }> {
    const repoId = `graph-reg-${suffix}`;
    const runId = `run-${suffix}`;
    const autopilotId = `autopilot-${suffix}`;
    const workstream = `work-${suffix}`;
    const contentCommit = git(repoRoot, ['rev-parse', 'HEAD']);
    const contentTree = git(repoRoot, ['rev-parse', 'HEAD^{tree}']);
    const runResource: Readonly<Record<string, unknown>> = {
      schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: runId,
      source_repo: repoRoot, git_common_dir: join(repoRoot, '.git'), worktree_root: join(stateRoot, 'worktrees', repoId),
      main_worktree_path: join(stateRoot, 'worktrees', repoId, 'active', runId, 'main'), runtime_root: join(stateRoot, 'worktrees', repoId, 'active', runId, 'main', '.pi', 'autopilot', workstream),
      branch: `autopilot/${runId}`, target_branch: 'main', target_base_sha: contentCommit, origin_url: null,
      started_at: '2026-07-19T00:00:00.000Z', version: 1,
    };
    const prospectiveRun: Readonly<Record<string, unknown>> = {
      schema_version: 'autopilot.coordination_run.v1', repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: runId,
      coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 0, created_event_seq: 1, version: 1,
    };
    const { publicKey } = generateKeyPairSync('ed25519');
    const exportedSpki = publicKey.export({ format: 'der', type: 'spki' });
    if (!(exportedSpki instanceof Uint8Array)) throw new Error('Ed25519 SPKI export was not binary DER');
    const spki = Buffer.from(exportedSpki);
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
        schema_version: 'autopilot.semantic_graph_bootstrap.v1', ref: bootstrapRef, sha256: sha256(bootstrapBytes), byte_count: Buffer.byteLength(bootstrapBytes, 'utf8'),
        git_commit: bootstrapCommit, covered_event_seq: 0, prospective_run: prospectiveRun, prospective_resource: runResource,
        trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256,
      },
    });
    const { event_type: _et, entity_type: _ent, entity_id: _eid, ...attachEffect } = runResponse.payload as Record<string, unknown>;
    const attachResult = parseD65AttachRunResultV2(attachEffect);
    const run = parseCoordinationRun(attachResult.run as unknown);
    const token = createHash('sha256').update(`bootstrap-${suffix}`).digest('hex');
    const sessionResponse = await client.mutate('attach-session', { repoId, workstreamRun: runId, sessionId: `session-${suffix}`, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: `attach-session-${suffix}` }, {
      session_lease_id: `session-lease-${suffix}`, session_token: token, pid: process.pid, boot_id: `boot-${suffix}`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null,
    });
    const attachedRun = parseCoordinationRun(sessionResponse.payload['run']);
    const session = parseCoordinationSessionLease(sessionResponse.payload['session']);
    const mainRoot = String(runResource['main_worktree_path']);
    const branch = String(runResource['branch']);
    const sessionContext = { schema_version: 'autopilot.coordinator_session_context.v1' as const, state_root: stateRoot, repo_id: repoId, repo_key: repoId, autopilot_id: autopilotId, workstream, workstream_run: runId, session_id: session.session_id, session_generation: session.session_generation, run_version: attachedRun.version, session_lease_id: session.session_lease_id, session_token: token, session_version: session.version, pid: session.pid, boot_id: session.boot_id };
    const sessionPath = join(stateRoot, `graph-session-${suffix}.json`);
    await writeCoordinatorSessionContext(sessionPath, sessionContext);
    const active: ActiveAutopilotRow = { schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1', autopilot_id: autopilotId, workstream, workstream_run: runId, repo_key: repoId, source_repo: repoRoot, git_common_dir: join(repoRoot, '.git'), worktree_root: String(runResource['worktree_root']), main_worktree_path: mainRoot, branch, runtime_root: String(runResource['runtime_root']), target_branch: 'main', target_base_sha: contentCommit, origin_url: null, pid: process.pid, boot_id: session.boot_id, status: 'active', started_at: '2026-07-19T00:00:00.000Z', active_run_epoch: 1, active_epoch_started_at: '2026-07-19T00:00:00.000Z', active_run_receipt_id: `receipt-${suffix}` };
    const ctxEnv: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: sessionPath };
    return { ctxEnv, mainRoot, branch, contentCommit, repoId, runId, active };
  }

  void it('rejects a unit worktree creation inside the bootstrap window', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const fixture = await partialBootstrap(client, stateRoot, repoRoot, 'bwneg1');
      // The unit creation attempts its own prepare + transition, so the durable
      // window then contains a unit operation, which the bootstrap authority
      // rejects at the external-effect boundary as not the sole main/create.
      await assert.rejects(
        () => executeOwnedWorktreeSaga({
          active: fixture.active, unitId: 'unit-a', attempt: 1, kind: 'unit', operationType: 'create', initialWorktreeState: 'planned', committedWorktreeState: 'active',
          intent: { repo_root: repoRoot, worktree_path: join(dirname(fixture.mainRoot), 'units', 'unit-a', 'attempt-1', 'worktree'), git_common_dir: join(repoRoot, '.git'), branch: `autopilot/unit/${fixture.runId}/unit-a/attempt-1`, reason: 'unauthorized unit creation in bootstrap window', base_sha: fixture.contentCommit, target_sha: null, archive_ref: null, checkout_mode: 'full', sparse_patterns: [], paths: [], metadata_refs: [] },
        }, { action: () => { throw new Error('external unit-creation effect must never run in the bootstrap window'); } }, fixture.ctxEnv),
        /bootstrap authorizes only the sole canonical main\/create worktree operation/u,
      );
    });
  });

  void it('rejects a bootstrap main/create whose intent does not bind the run-resource identity', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const fixture = await partialBootstrap(client, stateRoot, repoRoot, 'bwneg2');
      await assert.rejects(
        () => assertD65BootstrapMainWorktreeEffectBoundaryFromEnvironment({
          kind: 'main', unitId: 'main', attempt: 1, operationType: 'create',
          intent: { repo_root: repoRoot, worktree_path: fixture.mainRoot, git_common_dir: join(repoRoot, '.git'), branch: 'autopilot/wrong-branch', reason: 'wrong branch', base_sha: fixture.contentCommit, target_sha: null, archive_ref: null, checkout_mode: 'full', sparse_patterns: [], paths: [], metadata_refs: [] },
        }, fixture.ctxEnv),
        /bootstrap main\/create intent does not bind the exact run-resource identity/u,
      );
    });
  });

  void it('rejects a bootstrap main/create when the durable operation is not at its exact in-progress stage', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const fixture = await partialBootstrap(client, stateRoot, repoRoot, 'bwneg3');
      // No prepare/transition has run: the window has zero operations.
      await assert.rejects(
        () => assertD65BootstrapMainWorktreeEffectBoundaryFromEnvironment({
          kind: 'main', unitId: 'main', attempt: 1, operationType: 'create',
          intent: { repo_root: repoRoot, worktree_path: fixture.mainRoot, git_common_dir: join(repoRoot, '.git'), branch: fixture.branch, reason: 'no durable operation yet', base_sha: fixture.contentCommit, target_sha: null, archive_ref: null, checkout_mode: 'full', sparse_patterns: [], paths: [], metadata_refs: [] },
        }, fixture.ctxEnv),
        /bootstrap window must contain exactly one worktree operation/u,
      );
    });
  });

  void it('steps aside (returns false) once a launch policy is accepted so ordinary dispatch owns the boundary', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      // Full bootstrap through policy+heartbeat: the bootstrap window is over.
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'bwneg4');
      const authorized = await assertD65BootstrapMainWorktreeEffectBoundaryFromEnvironment({
        kind: 'main', unitId: 'main', attempt: 1, operationType: 'create',
        intent: { repo_root: initialRepoRoot, worktree_path: ctx.mainRoot, git_common_dir: join(initialRepoRoot, '.git'), branch: `autopilot/${ctx.runId}`, reason: 'post-policy create attempt', base_sha: git(initialRepoRoot, ['rev-parse', 'HEAD']), target_sha: null, archive_ref: null, checkout_mode: 'full', sparse_patterns: [], paths: [], metadata_refs: [] },
      }, ctx.sagaEnv);
      assert.equal(authorized, false);
    });
  });
});

void describe('D65 attempt/probe transaction authority', () => {
  void it('drives real reset→continuation→probe cadence and consumes one signed probe exactly once', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const suffix = 'probe-positive';
      const workstream = `work-${suffix}`;
      const repoId = `graph-reg-${suffix}`;
      const runId = `run-${suffix}`;
      const runtimePrefix = `.pi/autopilot/${workstream}`;
      const mainRoot = join(stateRoot, 'worktrees', repoId, 'active', runId, 'main');
      const runtimeRoot = join(mainRoot, runtimePrefix);
      const specRef1 = `${runtimePrefix}/unit-specs/unit-a.attempt-1.json`;
      const unitRootForAttempt = (attempt: number) => join(stateRoot, 'worktrees', repoId, 'active', runId, 'units', 'unit-a', `attempt-${String(attempt)}`, 'worktree');
      const makeSpec = (attempt: number) => ({
        schema_version: 'autopilot.unit_spec.v1', workstream, unit_id: 'unit-a', role: 'implement', template: 'implement', attempt,
        objective: 'Exercise exact one-use subscription probe recovery.', cwd: unitRootForAttempt(attempt), model: 'openai-codex/gpt-5.6-terra', thinking: 'high',
        owned_paths: ['probe-positive.ts'], read_only_paths: [], untouchable_paths: [], context_refs: [], validation_commands: [],
        status_output: join(runtimeRoot, 'statuses', `unit-a.attempt-${String(attempt)}.json`), receipt_output: join(runtimeRoot, 'receipts', `unit-a.attempt-${String(attempt)}.json`), evidence_dir: join(runtimeRoot, 'evidence', `unit-a-${String(attempt)}`),
        stop_boundary: 'stop after the exact probe witness', quality_profile: 'source-change', risk_level: 'low', acceptance_criteria: ['one exact retry is authorized'], verification_plan: { positive_witnesses: [], negative_witnesses: [], regression_witnesses: [], real_boundary_witnesses: [], blast_radius_checks: [], docs_schema_prompt_checks: [], dirty_tree_checks: [] }, closure_criteria: ['retry is registered'], upstream_refs: [], timeout_seconds: 60, render_prompt_snapshot: true,
      });
      // The initial spec is inherited from content-result authority, so first G
      // still changes exactly the five frozen core paths.
      const spec1Bytes = Buffer.from(`${canonicalJson(makeSpec(1))}\n`, 'utf8');
      await mkdir(dirname(join(repoRoot, specRef1)), { recursive: true });
      await writeFile(join(repoRoot, specRef1), spec1Bytes, 'utf8');
      git(repoRoot, ['add', specRef1]);
      git(repoRoot, ['commit', '-m', 'content result with attempt-one authority']);
      const ctx = await bootstrapAttach(client, stateRoot, repoRoot, suffix);
      const first = await publishFirstGraph(ctx, { attempt: 1, specRef: 'unit-specs/unit-a.attempt-1.json', state: 'blocked' });
      await acceptGraphHeartbeat({ ctx, graphSequence: first.graphSequence, graphSha256: first.graphSha256, rowState: 'active', rowStopReasons: [] });

      const latestGraph = async () => {
        const page = await client.query('status', ctx.repoId, ctx.runId);
        const graphs = (page.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact).filter((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1').sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
        const graph = graphs[graphs.length - 1];
        if (graph === undefined) throw new Error('probe cadence lost its accepted graph');
        return { sequence: Number(graph.artifact_id.slice(-20)), sha256: graph.evidence.sha256 };
      };
      const acceptLatest = async (reasons: readonly string[], providerHealth?: readonly Readonly<Record<string, unknown>>[]) => {
        const graph = await latestGraph();
        await acceptGraphHeartbeat({ ctx, graphSequence: graph.sequence, graphSha256: graph.sha256, rowState: reasons.length === 0 ? 'active' : 'recovering', rowStopReasons: reasons, ...(providerHealth === undefined ? {} : { providerHealth }) });
      };
      const missingHeartbeat = (error: unknown): boolean => /next external program heartbeat|program-heartbeats\//u.test(error instanceof Error ? error.message : String(error));
      const active: ActiveAutopilotRow = { schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1', autopilot_id: ctx.autopilotId, workstream: ctx.workstream, workstream_run: ctx.runId, repo_key: ctx.repoId, source_repo: repoRoot, git_common_dir: join(repoRoot, '.git'), worktree_root: join(stateRoot, 'worktrees', ctx.repoId), main_worktree_path: ctx.mainRoot, branch: `autopilot/${ctx.runId}`, runtime_root: join(ctx.mainRoot, runtimePrefix), target_branch: 'main', target_base_sha: git(repoRoot, ['rev-parse', 'HEAD']), origin_url: null, pid: process.pid, boot_id: `boot-${suffix}`, status: 'active', started_at: '2026-07-19T00:00:00.000Z', active_run_epoch: 1, active_epoch_started_at: '2026-07-19T00:00:00.000Z', active_run_receipt_id: `receipt-${suffix}` };
      let unitRoot = unitRootForAttempt(1);
      let created = false;
      let createPauses = 0;
      for (let index = 0; index < 12 && !created; index += 1) {
        try {
          const prepared = await prepareAutopilotUnitWorktree({ active, unitId: 'unit-a', attempt: 1, env: ctx.sagaEnv });
          unitRoot = prepared.unitInfo.worktree_path;
          created = true;
        } catch (error) {
          if (!missingHeartbeat(error)) throw error;
          createPauses += 1;
          await acceptLatest([]);
        }
      }
      assert.equal(created, true);
      assert.ok(createPauses > 0, 'unit create must prove durable stage resume across an external-heartbeat pause');

      const attemptPayload = (attempt: number, ref: string, digest: `sha256:${string}`) => ({ unit_id: 'unit-a', attempt, spec_ref: ref, spec_sha256: digest, role: 'implement', preemptible: true, checkpoint_ordinal: 0, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken });
      let status = await client.query('status', ctx.repoId, ctx.runId);
      let run = parseCoordinationRun((status.payload['runs'] as unknown[])[0]);
      await client.mutate('register-attempt', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: 'probe-attempt-one' }, attemptPayload(1, specRef1, sha256(spec1Bytes.toString('utf8'))));
      let graph = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env: ctx.sagaEnv });
      await acceptGraphHeartbeat({ ctx, graphSequence: graph.graphSequence, graphSha256: graph.graphSha256, rowState: 'active', rowStopReasons: [] });
      status = await client.query('status', ctx.repoId, ctx.runId); run = parseCoordinationRun((status.payload['runs'] as unknown[])[0]);
      const childToken = createHash('sha256').update('probe-child-token').digest('hex');
      const childId = `child-${ctx.runId}-unit-a-1`;
      const childResponse = await client.mutate('register-child', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: 'probe-child-one' }, { child_lease_id: childId, autopilot_id: ctx.autopilotId, unit_id: 'unit-a', attempt: 1, pid: process.pid, boot_id: 'probe-child-boot', child_token: childToken, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken, lease_expires_at: '2099-01-01T00:00:00.000Z' });
      graph = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env: ctx.sagaEnv });
      await acceptGraphHeartbeat({ ctx, graphSequence: graph.graphSequence, graphSha256: graph.graphSha256, rowState: 'active', rowStopReasons: [] });
      const child = parseCoordinationChildLease(childResponse.payload['child']);
      const observedAt = new Date(Date.now() - 15 * 60 * 1000 - 100).toISOString();
      const cooldownUntil = new Date(Date.parse(observedAt) + 15 * 60 * 1000).toISOString();
      // The child failure and exact reset are first isolated as row-local unit
      // recovery. Provider-wide blocking begins only when its immutable
      // first-failure continuation exists and can be cited byte-for-byte.
      await acceptGraphHeartbeat({ ctx, graphSequence: graph.graphSequence, graphSha256: graph.graphSha256, rowState: 'recovering', rowStopReasons: ['unit-recovering'] });
      await client.mutate('complete-child', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: null, fencingGeneration: null, expectedVersion: child.version, idempotencyKey: 'probe-child-failed' }, { child_lease_id: childId, child_token: childToken, pid: process.pid, boot_id: 'probe-child-boot', status: 'recovery-required', evidence_ref: null, evidence_sha256: null });
      graph = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env: ctx.sagaEnv });
      await acceptGraphHeartbeat({ ctx, graphSequence: graph.graphSequence, graphSha256: graph.graphSha256, rowState: 'recovering', rowStopReasons: ['unit-recovering'] });

      const failureInput = { context: { repo: resolveRepoIdentity(repoRoot), active, coordinationRoot: coordinationRootForRepo(active.repo_key, ctx.sagaEnv), claimsPath: join(stateRoot, 'claims.json'), claimEventsPath: join(stateRoot, 'claim-events.jsonl') }, unitId: 'unit-a', attempt: 1, unitWorktreePath: unitRoot, summary: 'subscription capacity failure reset', env: ctx.sagaEnv };
      let reset = false;
      let resetPauses = 0;
      for (let index = 0; index < 16 && !reset; index += 1) {
        try { await resetFailedUnit(failureInput); reset = true; }
        catch (error) {
          if (!missingHeartbeat(error)) throw error;
          resetPauses += 1;
          await acceptLatest(['unit-recovering']);
        }
      }
      assert.equal(reset, true);
      assert.ok(resetPauses > 0, 'unit reset/remove must prove forward-only resume across an external-heartbeat pause');
      assert.equal(existsSync(unitRoot), false);
      const resetGraph = await latestGraph();
      status = await client.query('status', ctx.repoId, ctx.runId);
      const priorAttempt = (status.payload['unit_attempts'] as Array<Record<string, unknown>>).find((entry) => (entry['owner'] as Record<string, unknown>)['unit_id'] === 'unit-a');
      assert.equal(priorAttempt?.['state'], 'reset');

      const receiptRef = `${runtimePrefix}/receipts/unit-a.attempt-1.failed.json`;
      const receiptBytes = Buffer.from(`${canonicalJson({ schema_version: 'autopilot.receipt.v1', tool_name: 'autopilot_emit_status', workstream, unit_id: 'unit-a', role: 'implement', attempt: 1, emitted_at: new Date().toISOString(), status_output: makeSpec(1).status_output, status_sha256: sha256('failed status'), schema_sha256: sha256('receipt schema'), tool_call_id: 'probe-failed-receipt', provider_identity: { provider_id: 'openai-codex', requested_model_id: 'openai-codex/gpt-5.6-terra', executed_model_id: 'openai-codex/gpt-5.6-terra', api: 'openai-codex-responses', thinking_level: 'high' }, expected_identity_hash: sha256('probe identity') })}\n`, 'utf8');
      const specRef2 = `${runtimePrefix}/unit-specs/unit-a.attempt-2.json`;
      const spec2Bytes = Buffer.from(`${canonicalJson(makeSpec(2))}\n`, 'utf8');
      const stateRef = `${runtimePrefix}/state.json`;
      const stateEntry = coreFileBodies(workstream, { attempt: 2, specRef: 'unit-specs/unit-a.attempt-2.json' }).find((entry) => entry.ref === stateRef);
      if (stateEntry === undefined) throw new Error('missing successor state fixture');
      const stateBytes = Buffer.from(stateEntry.body, 'utf8');
      const evidence = (ref: string, bytes: Uint8Array) => ({ ref, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as `sha256:${string}`, byte_count: bytes.byteLength });
      const continuationRef = `${runtimePrefix}/authority/continuation/00000000000000000001-subscription-failure-1.json`;
      const continuation = { schema_version: 'autopilot.continuation_event.v1', program_id: ctx.programId, event_id: 'subscription-failure-1', event_sequence: 1, repo_id: ctx.repoId, workstream_run: ctx.runId, trigger: 'subscription-failure', class: 'provider-capacity-blocked', provider: 'openai-codex', failed_spec_ref: evidence(specRef1, spec1Bytes), failed_receipt_ref: evidence(receiptRef, receiptBytes), unit_id: 'unit-a', attempt: 1, session_lease_id: ctx.sessionLeaseId, child_lease_id: childId, observed_at: observedAt, cooldown_until: cooldownUntil, retry_ordinal: 1, successor_id: null, evidence_refs: [evidence(stateRef, stateBytes), evidence(specRef2, spec2Bytes)], prior_graph_sha256: resetGraph.sha256, result_graph_sequence: resetGraph.sequence + 1, operator_decision_ref: null };
      const continuationBytes = Buffer.from(`${canonicalJson(continuation)}\n`, 'utf8');
      const continuationSha256 = `sha256:${createHash('sha256').update(continuationBytes).digest('hex')}` as `sha256:${string}`;
      const blockedProvider = [{ provider: 'openai-codex', state: 'blocked', observation_ref: continuationRef, observation_sha256: continuationSha256, cooldown_until: cooldownUntil, probe_workstream_run: null, probe_ref: null, probe_sha256: null, consumption_event_seq: null }] as const;
      const artifacts = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
      const policyArtifact = artifacts.find((artifact) => artifact.document_schema_version === 'autopilot.launch_policy.v1');
      if (policyArtifact === undefined) throw new Error('missing policy for probe signing');
      const policy = JSON.parse(await readFile(join(ctx.mainRoot, policyArtifact.evidence.ref), 'utf8')) as Record<string, unknown>;
      const issuedAt = new Date().toISOString();
      const unsignedProbe = { schema_version: 'autopilot.subscription_probe.v1', probe_id: 'probe-positive-1', program_id: ctx.programId, probe_sequence: 1, prior_probe_sha256: null, provider: 'openai-codex', trigger_continuation_ref: continuationRef, trigger_continuation_sha256: continuationSha256, repo_id: ctx.repoId, workstream_run: ctx.runId, unit_id: 'unit-a', failed_attempt: 1, retry_ordinal: 1, successor_attempt: 2, observed_at: issuedAt, cooldown_until: cooldownUntil, issued_at: issuedAt, not_before: cooldownUntil, expires_at: new Date(Date.parse(issuedAt) + 5 * 60 * 1000).toISOString(), healthy: true, cooldown_completed: true, evidence_refs: [], trust_anchor_ref: policy['trust_anchor_ref'], trust_anchor_sha256: policy['trust_anchor_sha256'], signer_key_id: policy['signer_key_id'] };
      const probeSignature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, Buffer.concat([Buffer.from('AUTOPILOT-D65-SUBSCRIPTION-PROBE\0', 'utf8'), Buffer.from(canonicalJson(unsignedProbe), 'utf8')]), createPrivateKey(ctx.privateKeyPem))));
      const probeBytes = Buffer.from(`${canonicalJson({ ...unsignedProbe, signature: probeSignature })}\n`, 'utf8');
      const recovery = { continuationBytes, probeBytes, boundAuthorityFiles: [{ ref: receiptRef, bytes: receiptBytes }, { ref: stateRef, bytes: stateBytes }, { ref: specRef2, bytes: spec2Bytes }], continuationSequence: 1 } as const;
      await assert.rejects(
        () => driveD65SubscriptionFailureRecoveryFromEnvironment({ env: ctx.sagaEnv, recovery: { ...recovery, boundAuthorityFiles: [{ ref: receiptRef, bytes: receiptBytes }, { ref: stateRef, bytes: Buffer.from(`${stateBytes.toString('utf8')} `, 'utf8') }, { ref: specRef2, bytes: spec2Bytes }] } }),
        /bound authority bytes differ from their exact descriptor/u,
      );
      await assert.rejects(
        () => driveD65SubscriptionFailureRecoveryFromEnvironment({ env: ctx.sagaEnv, recovery: { ...recovery, boundAuthorityFiles: [...recovery.boundAuthorityFiles, { ref: `${runtimePrefix}/unbound.json`, bytes: Buffer.from('{}\n', 'utf8') }] } }),
        /supplied an unbound authority file/u,
      );
      const recoveryInputRoot = join(stateRoot, 'external-subscription-recovery-input');
      await mkdir(recoveryInputRoot, { recursive: true, mode: 0o700 });
      const continuationPath = join(recoveryInputRoot, 'continuation.json');
      const probePath = join(recoveryInputRoot, 'probe.json');
      const receiptPath = join(recoveryInputRoot, 'failed-receipt.json');
      const statePath = join(recoveryInputRoot, 'successor-state.json');
      const successorSpecPath = join(recoveryInputRoot, 'successor-spec.json');
      await writeFile(continuationPath, continuationBytes, { mode: 0o600 });
      await writeFile(probePath, probeBytes, { mode: 0o600 });
      await writeFile(receiptPath, receiptBytes, { mode: 0o600 });
      await writeFile(statePath, stateBytes, { mode: 0o600 });
      await writeFile(successorSpecPath, spec2Bytes, { mode: 0o600 });
      const cliArgs = ['recover-d65-subscription', '--continuation', continuationPath, '--probe', probePath, '--continuation-sequence', '1', '--bound', receiptRef, receiptPath, '--bound', stateRef, statePath, '--bound', specRef2, successorSpecPath, '--json'] as const;
      let recovered = false;
      let alteredContinuationObservationRejected = false;
      let postFailureInitialHealthyRejected = false;
      let crossRunProbeRejected = false;
      for (let index = 0; index < 8 && !recovered; index += 1) {
        const exitCode = await runAutopilotAgentCli(cliArgs, ctx.sagaEnv);
        if (exitCode === 0) { recovered = true; break; }
        assert.equal(exitCode, 40, 'production subscription-recovery CLI returned an untyped failure');
        const current = await latestGraph();
        const probeRef = 'authority/subscription-probes/00000000000000000001-probe-positive-1.json';
        const retryProvider = [{ provider: 'openai-codex', state: 'retry-authorized', observation_ref: probeRef, observation_sha256: `sha256:${createHash('sha256').update(probeBytes).digest('hex')}`, cooldown_until: cooldownUntil, probe_workstream_run: ctx.runId, probe_ref: probeRef, probe_sha256: `sha256:${createHash('sha256').update(probeBytes).digest('hex')}`, consumption_event_seq: null }] as const;
        const afterProbe = current.sequence > continuation.result_graph_sequence;
        if (!afterProbe && !alteredContinuationObservationRejected) {
          const altered = [{ ...blockedProvider[0], observation_sha256: sha256('altered continuation bytes') }] as const;
          await assert.rejects(() => acceptGraphHeartbeat({ ctx, graphSequence: current.sequence, graphSha256: current.sha256, rowState: 'recovering', rowStopReasons: ['provider-blocked', 'unit-recovering'], providerHealth: altered }), /does not name one exact accepted continuation/u);
          alteredContinuationObservationRejected = true;
        }
        if (afterProbe && !postFailureInitialHealthyRejected) {
          const fakeInitialHealthy = [{ provider: 'openai-codex', state: 'healthy', observation_ref: policyArtifact.evidence.ref, observation_sha256: policyArtifact.evidence.sha256, cooldown_until: null, probe_workstream_run: null, probe_ref: null, probe_sha256: null, consumption_event_seq: null }] as const;
          await assert.rejects(() => acceptGraphHeartbeat({ ctx, graphSequence: current.sequence, graphSha256: current.sha256, rowState: 'active', rowStopReasons: [], providerHealth: fakeInitialHealthy }), /blocked provider state may only remain exact or advance/u);
          postFailureInitialHealthyRejected = true;
        }
        if (afterProbe && !crossRunProbeRejected) {
          const crossRun = [{ ...retryProvider[0], probe_workstream_run: 'run-foreign' }] as const;
          await assert.rejects(() => acceptGraphHeartbeat({ ctx, graphSequence: current.sequence, graphSha256: current.sha256, rowState: 'recovering', rowStopReasons: ['provider-blocked'], providerHealth: crossRun }), /diverges from the registered live probe/u);
          crossRunProbeRejected = true;
        }
        await acceptGraphHeartbeat({ ctx, graphSequence: current.sequence, graphSha256: current.sha256, rowState: 'recovering', rowStopReasons: afterProbe ? ['provider-blocked'] : ['provider-blocked', 'unit-recovering'], providerHealth: afterProbe ? retryProvider : blockedProvider });
      }
      assert.equal(recovered, true, 'production subscription-recovery CLI did not finish its exact crash-resume cadence');
      assert.equal(alteredContinuationObservationRejected, true, 'blocked provider heartbeat must reject an altered continuation observation digest');
      assert.equal(postFailureInitialHealthyRejected, true, 'post-failure heartbeat must not replay initial launch-policy health');
      assert.equal(crossRunProbeRejected, true, 'retry heartbeat must not borrow another run identity');
      status = await client.query('status', ctx.repoId, ctx.runId); run = parseCoordinationRun((status.payload['runs'] as unknown[])[0]);
      const consumeKey = 'probe-attempt-two';
      const consume = () => client.mutate('register-attempt', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: consumeKey }, attemptPayload(2, specRef2, `sha256:${createHash('sha256').update(spec2Bytes).digest('hex')}`));
      const consumed = await consume();
      const consumedKeys = Object.keys(consumed.payload).filter((key) => key.startsWith('consumed_probe_')).sort();
      assert.deepEqual(consumedKeys, ['consumed_probe_artifact_id','consumed_probe_coordinator_time','consumed_probe_provider','consumed_probe_sequence','consumed_probe_sha256','consumed_probe_trigger_continuation_sha256'].sort());
      const replay = await consume();
      assert.equal(canonicalJson(replay.payload), canonicalJson(consumed.payload));
      const consumedGraph = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env: ctx.sagaEnv });
      const reader = readD65GraphAuthorityAtCommit(ctx.mainRoot, consumedGraph.publicationCommit);
      const root = parseD65CompleteGraph(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reader.readBlob(`semantic-graphs/${String(consumedGraph.graphSequence).padStart(20, '0')}/graph.json`))) as unknown);
      const loaded = loadD65CompleteGraph(root, reader.readBlob);
      const projection = loaded.coordinatorProjection.attempts.find((entry) => entry.attempt.owner.unit_id === 'unit-a' && entry.attempt.owner.attempt === 2)?.consumed_probe;
      assert.deepEqual(projection, { artifact_id: consumed.payload['consumed_probe_artifact_id'], sha256: consumed.payload['consumed_probe_sha256'], probe_sequence: consumed.payload['consumed_probe_sequence'], provider: consumed.payload['consumed_probe_provider'], trigger_continuation_sha256: consumed.payload['consumed_probe_trigger_continuation_sha256'], consumption_event_seq: consumed.committed_event_seq });
      const healthyProvider = [{ provider: 'openai-codex', state: 'healthy', observation_ref: 'authority/subscription-probes/00000000000000000001-probe-positive-1.json', observation_sha256: `sha256:${createHash('sha256').update(probeBytes).digest('hex')}`, cooldown_until: null, probe_workstream_run: ctx.runId, probe_ref: 'authority/subscription-probes/00000000000000000001-probe-positive-1.json', probe_sha256: `sha256:${createHash('sha256').update(probeBytes).digest('hex')}`, consumption_event_seq: consumed.committed_event_seq }] as const;
      await acceptGraphHeartbeat({ ctx, graphSequence: consumedGraph.graphSequence, graphSha256: consumedGraph.graphSha256, rowState: 'active', rowStopReasons: [], providerHealth: healthyProvider });
      await assert.rejects(() => client.mutate('register-attempt', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: 'probe-attempt-two-distinct' }, attemptPayload(2, specRef2, `sha256:${createHash('sha256').update(spec2Bytes).digest('hex')}`)), /probe-authorized attempt cannot be re-verified/u);
    });
  });

  void it('rejects a retry heartbeat naming no accepted local probe and rejects an ungraphed ordinary spec', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'probe-gate');
      const graph = await publishFirstGraph(ctx);
      const missingProbeRef = 'authority/subscription-probes/00000000000000000001-probe-missing.json';
      const missingProbeSha256 = sha256('missing probe');
      const missingProbe = { provider: 'openai-codex', state: 'retry-authorized', observation_ref: missingProbeRef, observation_sha256: missingProbeSha256, cooldown_until: new Date(Date.now() - 1_000).toISOString(), probe_workstream_run: ctx.runId, probe_ref: missingProbeRef, probe_sha256: missingProbeSha256, consumption_event_seq: null };
      await assert.rejects(() => acceptGraphHeartbeat({ ctx, graphSequence: graph.graphSequence, graphSha256: graph.graphSha256, rowState: 'recovering', rowStopReasons: ['provider-blocked'], providerHealth: [missingProbe] }), /does not name one exact registered probe/u);
      await acceptGraphHeartbeat({ ctx, graphSequence: graph.graphSequence, graphSha256: graph.graphSha256, rowState: 'active', rowStopReasons: [] });
      const status = await client.query('status', ctx.repoId, ctx.runId);
      const run = parseCoordinationRun((status.payload['runs'] as unknown[])[0]);
      const attemptPayload = { unit_id: 'unit-a', attempt: 1, spec_ref: `.pi/autopilot/${ctx.workstream}/unit-specs/unit-a.attempt-1.json`, spec_sha256: sha256('not graphed'), role: 'implement', preemptible: true, checkpoint_ordinal: 0, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken };
      await assert.rejects(() => client.mutate('register-attempt', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: 'ordinary-attempt-with-ungraphed-spec' }, attemptPayload), /spec is not one exact accepted graph authority/u);
      await writeFile(join(ctx.mainRoot, 'unpaired-authority.txt'), 'must fence\n', 'utf8');
      git(ctx.mainRoot, ['add', 'unpaired-authority.txt']);
      git(ctx.mainRoot, ['commit', '-m', 'unpaired authority drift']);
      await assert.rejects(() => client.mutate('register-attempt', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: 'ordinary-attempt-after-unpaired-git' }, attemptPayload), /graph-not-current|fenced at its coordinator transaction boundary/u);
      const after = await client.query('status', ctx.repoId, ctx.runId);
      assert.equal((after.payload['unit_attempts'] as unknown[]).length, 0);
    });
  });
});

void describe('D65 close/abort no-successor terminal tail', () => {
  void it('production close accepts the prepared-terminal graph before the terminal target mutation', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot }) => {
      const canonicalRepoRoot = realpathSync(repoRoot);
      const ctx = await bootstrapAttach(client, stateRoot, canonicalRepoRoot, 'terminal-production-close', resolveRepoIdentity(canonicalRepoRoot).repoKey, currentBootId());
      const first = await publishFirstGraph(ctx, { attempt: 1, state: 'completed' });
      await acceptGraphHeartbeat({ ctx, graphSequence: first.graphSequence, graphSha256: first.graphSha256, rowState: 'active', rowStopReasons: [] });
      const sourceMainBefore = git(canonicalRepoRoot, ['rev-parse', 'main']);
      const active: ActiveAutopilotRow = { schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1', autopilot_id: ctx.autopilotId, workstream: ctx.workstream, workstream_run: ctx.runId, repo_key: ctx.repoId, source_repo: canonicalRepoRoot, git_common_dir: join(canonicalRepoRoot, '.git'), worktree_root: join(stateRoot, 'worktrees', ctx.repoId), main_worktree_path: ctx.mainRoot, branch: `autopilot/${ctx.runId}`, runtime_root: join(ctx.mainRoot, '.pi', 'autopilot', ctx.workstream), target_branch: 'main', target_base_sha: sourceMainBefore, origin_url: null, pid: process.pid, boot_id: currentBootId(), status: 'active', started_at: '2026-07-19T00:00:00.000Z', active_run_epoch: 1, active_epoch_started_at: '2026-07-19T00:00:00.000Z', active_run_receipt_id: 'receipt-terminal-production-close' };
      await writeActiveAutopilots(coordinationRootForRepo(ctx.repoId, ctx.sagaEnv), [active]);
      let observedPreparedPrefix = false;
      const invokeClose = () => closeAutopilotWorkstream({
        workstream: ctx.workstream,
        workstreamRun: ctx.runId,
        sourceCwd: canonicalRepoRoot,
        coordinationSessionId: ctx.sessionId,
        env: ctx.sagaEnv,
        observeTerminalCleanupBoundary: async (boundary) => {
          if (boundary !== 'after-terminal-manifest') return;
          const status = await client.query('status', ctx.repoId, ctx.runId);
          const intents = status.payload['run_terminal_intents'];
          const artifacts = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact).filter((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1');
          if (!Array.isArray(intents) || intents.length !== 1 || intents[0] === undefined) throw new Error('production close did not prepare exactly one terminal intent before its manifest');
          const terminalIntent = parseCoordinationRunTerminalIntent(intents[0]);
          assert.equal(terminalIntent.state, 'prepared');
          assert.ok(artifacts.length >= 2, 'prepared terminal intent must already be covered by a successor complete graph');
          assert.equal(git(canonicalRepoRoot, ['rev-parse', 'main']), sourceMainBefore, 'target authority changed before prepared-terminal graph acceptance');
          observedPreparedPrefix = true;
        },
      });
      let result: Awaited<ReturnType<typeof closeAutopilotWorkstream>> | null = null;
      const closeRecoveryErrors: string[] = [];
      for (let index = 0; index < 6 && result === null; index += 1) {
        try { result = await invokeClose(); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          closeRecoveryErrors.push(message);
          if (/terminal-cleanup-recovery-required/u.test(message)) continue;
          if (!/terminal-successor-required/u.test(message)) throw error;
          const status = await client.query('status', ctx.repoId, ctx.runId);
          const graphs = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact).filter((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1').sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
          const graph = graphs.at(-1);
          if (graph === undefined) throw new Error('prepared close lost its successor complete graph');
          await acceptGraphHeartbeat({ ctx, graphSequence: Number(graph.artifact_id.slice(-20)), graphSha256: graph.evidence.sha256, rowState: 'recovering', rowStopReasons: ['terminal-tail'] });
        }
      }
      if (result === null) throw new Error(`production close did not resume after its external terminal heartbeat:\n${closeRecoveryErrors.join('\n---\n')}`);
      assert.equal(result.outcome, 'closed', result.blockers.join('\n'));
      assert.equal(observedPreparedPrefix, true);
      assert.notEqual(git(canonicalRepoRoot, ['rev-parse', 'main']), sourceMainBefore);
    });
  });

  for (const outcome of ['closed', 'aborted'] as const) {
    void it(`${outcome}: commits once, rejects backward/liveness re-entry, and replays cleanup forward-only`, async () => {
      await withHarness(async ({ client, stateRoot, repoRoot }) => {
        const suffix = `terminal-${outcome}`;
        const ctx = await bootstrapAttach(client, stateRoot, repoRoot, suffix);
        const first = await publishFirstGraph(ctx, { attempt: 1, state: 'completed' });
        await acceptGraphHeartbeat({ ctx, graphSequence: first.graphSequence, graphSha256: first.graphSha256, rowState: 'active', rowStopReasons: [] });
        const intent = await prepareV2(ctx, 1, outcome, null, null);
        const preparedGraph = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env: ctx.sagaEnv });
        assert.equal(preparedGraph.semanticEventType, 'run-terminal-prepared');
        await acceptGraphHeartbeat({ ctx, graphSequence: preparedGraph.graphSequence, graphSha256: preparedGraph.graphSha256, rowState: 'recovering', rowStopReasons: ['terminal-tail'] });

        const sourceMainBefore = git(repoRoot, ['rev-parse', 'main']);
        if (outcome === 'closed') git(repoRoot, ['merge', '--ff-only', `autopilot/${ctx.runId}`]);
        const terminalSha = git(outcome === 'closed' ? repoRoot : ctx.mainRoot, ['rev-parse', 'HEAD']);
        const evidencePath = join(ctx.mainRoot, '.pi', 'autopilot', ctx.workstream, 'terminal', `${outcome}.json`);
        const evidenceBytes = `${canonicalJson({ schema_version: 'autopilot.run_terminal.v1', repo_key: ctx.repoId, autopilot_id: ctx.autopilotId, workstream_run: ctx.runId, outcome, terminal_sha: terminalSha })}\n`;
        await mkdir(dirname(evidencePath), { recursive: true });
        await writeFile(evidencePath, evidenceBytes, { encoding: 'utf8', mode: 0o600 });
        const activeBase: ActiveAutopilotRow = { schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1', autopilot_id: ctx.autopilotId, workstream: ctx.workstream, workstream_run: ctx.runId, repo_key: ctx.repoId, source_repo: repoRoot, git_common_dir: join(repoRoot, '.git'), worktree_root: join(stateRoot, 'worktrees', ctx.repoId), main_worktree_path: ctx.mainRoot, branch: `autopilot/${ctx.runId}`, runtime_root: join(ctx.mainRoot, '.pi', 'autopilot', ctx.workstream), target_branch: 'main', target_base_sha: terminalSha, origin_url: null, pid: process.pid, boot_id: `boot-${suffix}`, status: 'active', started_at: '2026-07-19T00:00:00.000Z', active_run_epoch: 1, active_epoch_started_at: '2026-07-19T00:00:00.000Z', active_run_receipt_id: `receipt-${suffix}` };
        const source = outcome === 'closed' ? 'run-close' : 'run-abort';
        const firstRelease = await recordCoordinatorReleaseEvidenceFromFile({ active: activeBase, source, targetId: ctx.runId, evidencePath, env: ctx.sagaEnv });
        if (firstRelease === null) throw new Error('terminal-tail release unexpectedly lacked coordinator authority');
        let status = await client.query('status', ctx.repoId, ctx.runId);
        const terminalRun = parseCoordinationRun((status.payload['runs'] as unknown[])[0]);
        assert.equal(terminalRun.status, outcome);
        const terminalSession = (status.payload['session_leases'] as unknown[]).map(parseCoordinationSessionLease).find((entry) => entry.session_lease_id === ctx.sessionLeaseId);
        if (terminalSession === undefined) throw new Error('terminal-tail attached session is absent');
        await assert.rejects(() => client.mutate('heartbeat', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: terminalSession.version, idempotencyKey: `forbidden-terminal-heartbeat-${outcome}` }, { session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken, lease_expires_at: '2099-02-01T00:00:00.000Z' }), /forbids a session heartbeat after its first terminal effect/u);
        await assert.rejects(() => acceptGraphHeartbeat({ ctx, graphSequence: preparedGraph.graphSequence, graphSha256: preparedGraph.graphSha256, rowState: 'recovering', rowStopReasons: ['terminal-tail'] }), /fenced|terminal|row-closed/u);
        const replayRelease = await recordCoordinatorReleaseEvidenceFromFile({ active: activeBase, source, targetId: ctx.runId, evidencePath, env: ctx.sagaEnv });
        if (replayRelease === null) throw new Error('terminal-tail release replay unexpectedly lacked coordinator authority');
        assert.equal(replayRelease.evidence.reconciliation_evidence_id, firstRelease.evidence.reconciliation_evidence_id);

        await writeCoordinatorSessionContext(ctx.sessionPath, { schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: ctx.repoId, repo_key: ctx.repoId, autopilot_id: ctx.autopilotId, workstream: ctx.workstream, workstream_run: ctx.runId, session_id: terminalSession.session_id, session_generation: terminalSession.session_generation, run_version: terminalRun.version, session_lease_id: terminalSession.session_lease_id, session_token: ctx.sessionToken, session_version: terminalSession.version, pid: terminalSession.pid, boot_id: terminalSession.boot_id });
        const terminalActive: ActiveAutopilotRow = { ...activeBase, status: 'closed' };
        const archiveRef = `autopilot/archive/${ctx.runId}/${outcome === 'closed' ? 'main' : 'aborted'}`;
        const archiveSpec = { active: terminalActive, unitId: 'main', attempt: 1, kind: 'main' as const, operationType: 'archive' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'terminal' as const, intent: { repo_root: repoRoot, worktree_path: ctx.mainRoot, git_common_dir: join(repoRoot, '.git'), branch: terminalActive.branch, reason: `terminal ${outcome} archive`, base_sha: terminalSha, target_sha: terminalSha, archive_ref: archiveRef, checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [] } };
        const archive = () => executeOwnedWorktreeSaga(archiveSpec, { action: async () => { git(repoRoot, ['update-ref', `refs/heads/${archiveRef}`, terminalSha, '0'.repeat(40)]); } }, ctx.sagaEnv);
        const archived = await archive();
        assert.equal(archived.operation?.stage, 'committed');
        const removeSpec = { active: terminalActive, unitId: 'main', attempt: 1, kind: 'main' as const, operationType: 'remove' as const, initialWorktreeState: 'terminal' as const, committedWorktreeState: 'removed' as const, intent: { repo_root: repoRoot, worktree_path: ctx.mainRoot, git_common_dir: join(repoRoot, '.git'), branch: terminalActive.branch, reason: `terminal ${outcome} cleanup`, base_sha: terminalSha, target_sha: terminalSha, archive_ref: archiveRef, checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [] } };
        const removeMain = () => executeOwnedWorktreeSaga(removeSpec, { action: async () => { await rm(terminalActive.runtime_root, { recursive: true, force: false }); git(repoRoot, ['worktree', 'remove', '--force', ctx.mainRoot]); git(repoRoot, ['update-ref', '-d', `refs/heads/${terminalActive.branch}`, terminalSha]); } }, ctx.sagaEnv);
        const removed = await removeMain();
        assert.equal(removed.operation?.stage, 'committed');
        assert.equal(existsSync(ctx.mainRoot), false);
        assert.equal(git(repoRoot, ['rev-parse', `refs/heads/${archiveRef}`]), terminalSha);
        assert.equal((await archive()).replayed, true);
        assert.equal((await removeMain()).replayed, true);
        assert.equal(git(repoRoot, ['rev-parse', 'main']), outcome === 'closed' ? terminalSha : sourceMainBefore);

        status = await client.query('status', ctx.repoId, ctx.runId);
        const finalSession = (status.payload['session_leases'] as unknown[]).map(parseCoordinationSessionLease).find((entry) => entry.session_lease_id === ctx.sessionLeaseId);
        if (finalSession === undefined) throw new Error('terminal-tail final session is absent');
        const detached = await client.mutate('detach-session', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: finalSession.version, idempotencyKey: `terminal-detach-${outcome}` }, { session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken, reason: `terminal ${outcome} cleanup complete` });
        assert.equal(parseCoordinationSessionLease(detached.payload['session']).status, 'detached');
        await assert.rejects(() => client.mutate('cancel-run-terminal', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: intent.version + 1, idempotencyKey: `cancel-after-${outcome}` }, { terminal_intent_id: intent.terminal_intent_id, reason: 'forbidden backward transition', session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken }), /run terminal intent is committed|terminal run .* rejects new coordination action cancel-run-terminal|session is not attached/u);
      });
    });
  }
});

void describe('D65 planned-handoff successor cadence', () => {
  void it('requires one graph-bound continuation, attaches its exact successor, and graphs attach before further dispatch', async () => {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'handoff');
      const first = await publishFirstGraph(ctx);
      await acceptGraphHeartbeat({ ctx, graphSequence: first.graphSequence, graphSha256: first.graphSha256, rowState: 'active', rowStopReasons: [] });
      const before = await client.query('status', ctx.repoId, ctx.runId);
      const oldSession = (before.payload['session_leases'] as unknown[]).map(parseCoordinationSessionLease).find((entry) => entry.session_lease_id === ctx.sessionLeaseId);
      if (oldSession === undefined) throw new Error('planned handoff fixture lacks predecessor');
      const handoffToken = 'handoff-token-d65-exact';
      await client.mutate('prepare-handoff', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: oldSession.version, idempotencyKey: 'prepare-planned-handoff' }, { handoff_token: handoffToken, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken });
      // One independently owned run now appends a repository event after this
      // run's semantic handoff event. The production producer and store must
      // both treat it as contiguous history but never as this run's authority.
      const foreign = await attachOneForeignRunEvent(client, stateRoot, initialRepoRoot, ctx.repoId, 'handoff-foreign');
      assert.equal(foreign.workstream_run, 'run-handoff-foreign');
      await assert.rejects(() => acceptGraphHeartbeat({ ctx, graphSequence: first.graphSequence, graphSha256: first.graphSha256, rowState: 'recovering', rowStopReasons: ['handoff-pending'], sessionLeaseState: 'handoff-pending' }), /cannot mask a semantic event that requires successor graph/u);
      const preparedGraph = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env: ctx.sagaEnv, createdAt: '2026-07-19T02:00:00.000Z' });
      assert.equal(preparedGraph.semanticEventType, 'session-handoff-prepared');
      const handoffHeartbeat = await acceptGraphHeartbeat({ ctx, graphSequence: preparedGraph.graphSequence, graphSha256: preparedGraph.graphSha256, rowState: 'recovering', rowStopReasons: ['handoff-pending'], sessionLeaseState: 'handoff-pending' });
      assert.equal(canonicalJson((await handoffHeartbeat.replay()).payload), canonicalJson(handoffHeartbeat.response.payload), 'handoff heartbeat response-loss replay must return the committed effect');

      const runtimePrefix = `.pi/autopilot/${ctx.workstream}`;
      const continuationRef = `${runtimePrefix}/authority/continuation/00000000000000000001-planned-turnover-1.json`;
      const continuation = {
        schema_version: 'autopilot.continuation_event.v1', program_id: ctx.programId, event_id: 'planned-turnover-1', event_sequence: 1,
        repo_id: ctx.repoId, workstream_run: ctx.runId, trigger: 'planned-turnover', class: 'handoff-pending', provider: null,
        failed_spec_ref: null, failed_receipt_ref: null, unit_id: null, attempt: null, session_lease_id: ctx.sessionLeaseId, child_lease_id: null,
        observed_at: '2026-07-19T02:00:00.000Z', cooldown_until: null, retry_ordinal: null, successor_id: 'session-lease-handoff-2',
        evidence_refs: [],
        prior_graph_sha256: preparedGraph.graphSha256, result_graph_sequence: preparedGraph.graphSequence + 1, operator_decision_ref: null,
      };
      const continuationBytes = Buffer.from(`${canonicalJson(continuation)}\n`, 'utf8');
      await mkdir(dirname(join(ctx.mainRoot, continuationRef)), { recursive: true });
      await writeFile(join(ctx.mainRoot, continuationRef), continuationBytes, { mode: 0o600 });
      git(ctx.mainRoot, ['add', continuationRef]);
      git(ctx.mainRoot, ['commit', '-m', 'planned turnover authority']);
      const continuationCommit = git(ctx.mainRoot, ['rev-parse', 'HEAD']);
      const statusForRegistration = await client.query('status', ctx.repoId, ctx.runId);
      const runForRegistration = parseCoordinationRun((statusForRegistration.payload['runs'] as unknown[])[0]);
      const continuationDigest = sha256(continuationBytes.toString('utf8'));
      const registerContinuation = () => client.mutate('register-authoritative-artifact', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: runForRegistration.version, idempotencyKey: 'register-planned-turnover' }, { artifact_id: 'continuation:planned-turnover-1', source_type: 'task', source_scope: 'run-main', document_schema_version: 'autopilot.continuation_event.v1', git_commit: continuationCommit, ref: continuationRef, sha256: continuationDigest, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken });
      const registered = await registerContinuation();
      assert.equal(parseCoordinationAuthoritativeArtifact(registered.payload['authoritative_artifact']).evidence.sha256, continuationDigest);
      assert.equal(canonicalJson((await registerContinuation()).payload), canonicalJson(registered.payload), 'handoff artifact response-loss replay must return the committed effect');
      const continuationGraph = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env: ctx.sagaEnv, createdAt: '2026-07-19T02:00:01.000Z' });
      assert.equal(continuationGraph.graphSequence, continuation.result_graph_sequence);
      await acceptGraphHeartbeat({ ctx, graphSequence: continuationGraph.graphSequence, graphSha256: continuationGraph.graphSha256, rowState: 'recovering', rowStopReasons: ['handoff-pending'], sessionLeaseState: 'handoff-pending', lastHandoffSha256: continuationDigest });

      const statusBeforeAttach = await client.query('status', ctx.repoId, ctx.runId);
      const currentRun = parseCoordinationRun((statusBeforeAttach.payload['runs'] as unknown[])[0]);
      // A successor not named by the graph-bound continuation has no authority.
      await assert.rejects(() => client.mutate('attach-session', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: 'session-handoff-wrong', fencingGeneration: 2, expectedVersion: currentRun.version, idempotencyKey: 'attach-planned-wrong' }, { session_lease_id: 'session-lease-handoff-wrong', session_token: sha256('wrong-token').slice(7), pid: process.pid, boot_id: 'boot-handoff-wrong', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: handoffToken }), /requires one accepted successor continuation/u);
      const nextToken = createHash('sha256').update('handoff-next-token').digest('hex');
      const attached = await client.mutate('attach-session', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: 'session-handoff-2', fencingGeneration: 2, expectedVersion: currentRun.version, idempotencyKey: 'attach-planned-exact' }, { session_lease_id: 'session-lease-handoff-2', session_token: nextToken, pid: process.pid, boot_id: 'boot-handoff-2', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: handoffToken });
      const nextRun = parseCoordinationRun(attached.payload['run']);
      const nextSession = parseCoordinationSessionLease(attached.payload['session']);
      assert.equal(nextSession.session_generation, 2);
      // No ordinary dispatch may cross the semantic attach before graph N+1.
      await assert.rejects(() => client.mutate('register-attempt', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: nextSession.session_id, fencingGeneration: 2, expectedVersion: nextRun.version, idempotencyKey: 'handoff-before-attach-graph' }, { unit_id: 'unit-a', attempt: 2, spec_ref: `${runtimePrefix}/unit-specs/unit-a.attempt-2.json`, spec_sha256: `sha256:${'0'.repeat(64)}`, role: 'implement', preemptible: true, checkpoint_ordinal: 0, session_lease_id: nextSession.session_lease_id, session_token: nextToken }), /fenced at its coordinator transaction boundary/u);
      const nextContextPath = join(stateRoot, 'planned-handoff-next-session.json');
      await writeCoordinatorSessionContext(nextContextPath, { schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: ctx.repoId, repo_key: ctx.repoId, autopilot_id: ctx.autopilotId, workstream: ctx.workstream, workstream_run: ctx.runId, session_id: nextSession.session_id, session_generation: nextSession.session_generation, run_version: nextRun.version, session_lease_id: nextSession.session_lease_id, session_token: nextToken, session_version: nextSession.version, pid: nextSession.pid, boot_id: nextSession.boot_id });
      const attachGraph = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env: { ...ctx.sagaEnv, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: nextContextPath }, createdAt: '2026-07-19T02:00:02.000Z' });
      assert.equal(attachGraph.semanticEventType, 'session-attached');
      await acceptGraphHeartbeat({ ctx, graphSequence: attachGraph.graphSequence, graphSha256: attachGraph.graphSha256, sessionId: nextSession.session_id, sessionLeaseId: nextSession.session_lease_id, sessionToken: nextToken, sessionGeneration: 2, rowState: 'active', rowStopReasons: [] });
    });
  });
});

void describe('D65 parent-loss sealed-candidate attach', () => {
  // The exact-once null-handoff attach: fixed policy-root candidate, purpose
  // signature, current graph/policy/heartbeat digests, expired predecessor,
  // proposed successor identity, one unused budget, zero pending handoff.
  async function withParentLossFixture(run: (fixture: Readonly<{ ctx: BootstrapCtx; client: CoordinatorClient; evidenceRoot: string; privateKeyPem: string; graphSha256: `sha256:${string}`; policySha256: `sha256:${string}`; heartbeatSha256: `sha256:${string}`; writeCandidate: (overrides?: Record<string, unknown>) => Promise<`sha256:${string}`>; attach: (generation: number, sessionId: string, leaseId: string, bootId: string) => Promise<Awaited<ReturnType<CoordinatorClient['mutate']>>> }>) => Promise<void>): Promise<void> {
    await withHarness(async ({ client, stateRoot, repoRoot: initialRepoRoot }) => {
      const ctx = await bootstrapAttach(client, stateRoot, initialRepoRoot, 'ploss');
      const result = await publishFirstGraph(ctx);
      // Expire the attached generation-1 session at coordinator time through a
      // real pure lease renewal to an already-past expiry (parent loss leaves
      // the row attached-but-expired; no fabricated store mutation).
      await client.mutate('heartbeat', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: 1, idempotencyKey: 'ploss-expire-lease' }, { session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken, lease_expires_at: '2020-01-01T00:00:00.000Z' });
      // The sealed candidate is governed by the accepted parent-recovering
      // heartbeat for graph 2, never by the bootstrap heartbeat for graph 1.
      const heartbeat = await acceptGraphHeartbeat({ ctx, graphSequence: result.graphSequence, graphSha256: result.graphSha256, rowState: 'recovering', rowStopReasons: ['parent-recovering'] });
      const status = await client.query('status', ctx.repoId, ctx.runId);
      const doctor = await client.query('doctor', ctx.repoId, ctx.runId);
      const artifacts = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
      const policyArtifact = artifacts.find((artifact) => artifact.document_schema_version === 'autopilot.launch_policy.v1');
      if (policyArtifact === undefined) throw new Error('parent-loss fixture lacks the accepted policy');
      const policyBytes = await readFile(join(ctx.mainRoot, policyArtifact.evidence.ref), 'utf8');
      const policy = JSON.parse(policyBytes) as Record<string, unknown>;
      const evidenceRoot = String(policy['program_evidence_root']);
      const heartbeatBytes = heartbeat.bytes;
      const graphSha256 = result.graphSha256;
      const policySha256 = policyArtifact.evidence.sha256;
      const heartbeatSha256 = heartbeat.sha256;
      const graphRef = `semantic-graphs/${String(result.graphSequence).padStart(20, '0')}/graph.json`;
      const graphBytes = await readFile(join(ctx.mainRoot, graphRef));
      const candidateDir = join(evidenceRoot, 'parent-loss', ctx.runId);
      await mkdir(candidateDir, { recursive: true, mode: 0o700 });
      chmodSync(join(evidenceRoot, 'parent-loss'), 0o700);
      chmodSync(candidateDir, 0o700);
      const statusRef = `parent-loss/${ctx.runId}/status.json`;
      const doctorRef = `parent-loss/${ctx.runId}/doctor.json`;
      const statusBytes = `${canonicalJson(status)}\n`;
      const doctorBytes = `${canonicalJson(doctor)}\n`;
      await writeFile(join(evidenceRoot, statusRef), statusBytes, { encoding: 'utf8', mode: 0o600 });
      await writeFile(join(evidenceRoot, doctorRef), doctorBytes, { encoding: 'utf8', mode: 0o600 });
      chmodSync(join(evidenceRoot, statusRef), 0o600);
      chmodSync(join(evidenceRoot, doctorRef), 0o600);
      const predecessor = (status.payload['session_leases'] as unknown[]).map(parseCoordinationSessionLease).find((entry) => entry.session_lease_id === ctx.sessionLeaseId);
      if (predecessor === undefined) throw new Error('parent-loss fixture lost its predecessor session');
      const observedAt = String(doctor.payload['coordinator_time']);
      const privateKeyPem = ctx.privateKeyPem;
      const writeCandidate = async (overrides: Record<string, unknown> = {}): Promise<`sha256:${string}`> => {
        const physicalIdentity = (path: string) => ({ path, device: 1, inode: 1, session_id: null, pid: null, boot_id: null });
        const fields = {
          schema_version: 'autopilot.parent_loss.v1', program_id: ctx.programId, event_id: 'parent-loss-1', repo_id: ctx.repoId, workstream_run: ctx.runId,
          lost_physical_session_file_identity: physicalIdentity('/tmp/lost-session.jsonl'), lost_coordinator_session_identity: { path: ctx.sessionPath, device: 1, inode: 1, session_id: predecessor.session_id, pid: predecessor.pid, boot_id: predecessor.boot_id },
          successor_physical_session_file_identity: physicalIdentity('/tmp/successor-session.jsonl'),
          successor_session_id: 'session-ploss-2', successor_session_lease_id: 'session-lease-ploss-2', successor_generation: 2,
          successor_pid: process.pid, successor_boot_id: 'boot-ploss-2',
          last_graph: { ref: graphRef, sha256: graphSha256, byte_count: graphBytes.byteLength },
          last_policy: { ref: policyArtifact.evidence.ref, sha256: policySha256, byte_count: Buffer.byteLength(policyBytes, 'utf8') },
          last_heartbeat: { ref: heartbeat.ref, sha256: heartbeatSha256, byte_count: Buffer.byteLength(heartbeatBytes, 'utf8') },
          status_ref: { ref: statusRef, sha256: sha256(statusBytes), byte_count: Buffer.byteLength(statusBytes, 'utf8') },
          doctor_ref: { ref: doctorRef, sha256: sha256(doctorBytes), byte_count: Buffer.byteLength(doctorBytes, 'utf8') },
          observed_at: observedAt, successor_budget: 1, operator_decision_ref: null, issued_at: observedAt,
          trust_anchor_ref: String(policy['trust_anchor_ref']), trust_anchor_sha256: String(policy['trust_anchor_sha256']), signer_key_id: String(policy['signer_key_id']),
          ...overrides,
        };
        const signature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, Buffer.concat([Buffer.from('AUTOPILOT-D65-PARENT-LOSS\0', 'utf8'), Buffer.from(canonicalJson(fields), 'utf8')]), createPrivateKey(privateKeyPem))));
        const bytes = `${canonicalJson({ ...fields, signature })}\n`;
        const candidateDir = join(evidenceRoot, 'parent-loss', ctx.runId);
        await mkdir(candidateDir, { recursive: true, mode: 0o700 });
        chmodSync(join(evidenceRoot, 'parent-loss'), 0o700);
        chmodSync(candidateDir, 0o700);
        const candidatePath = join(candidateDir, 'candidate.json');
        await rm(candidatePath, { force: true });
        await writeFile(candidatePath, bytes, { encoding: 'utf8', mode: 0o600 });
        chmodSync(candidatePath, 0o600);
        return sha256(bytes);
      };
      const attach = async (generation: number, sessionId: string, leaseId: string, bootId: string) => {
        const statusNow = await client.query('status', ctx.repoId, ctx.runId);
        const runVersion = (statusNow.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
        return client.mutate('attach-session', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId, fencingGeneration: generation, expectedVersion: runVersion, idempotencyKey: `parent-loss-attach-${sessionId}` }, {
          session_lease_id: leaseId, session_token: createHash('sha256').update(`ploss-${sessionId}`).digest('hex'), pid: process.pid, boot_id: bootId, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null,
        });
      };
      await run({ ctx, client, evidenceRoot, privateKeyPem, graphSha256, policySha256, heartbeatSha256, writeCandidate, attach });
    });
  }

  void it('admits the exact sealed candidate once and rejects candidate replay as parent-recovery-exhausted', async () => {
    await withParentLossFixture(async (fixture) => {
      await fixture.writeCandidate();
      const attached = await fixture.attach(2, 'session-ploss-2', 'session-lease-ploss-2', 'boot-ploss-2');
      assert.equal(typeof attached.payload['parent_loss_candidate_sha256'], 'string');
      const attachedSession = parseCoordinationSessionLease(attached.payload['session']);
      assert.equal(attachedSession.session_generation, 2);
      // Candidate replay for a third generation is parent-recovery-exhausted.
      await assert.rejects(
        () => fixture.attach(3, 'session-ploss-3', 'session-lease-ploss-3', 'boot-ploss-3'),
        /parent-recovery-exhausted|successor identity does not equal the attach request/u,
      );
    });
  });

  void it('drives attach→graph→parent artifact→graph→continuation→graph with explicit heartbeat pauses and exact replay', async () => {
    await withParentLossFixture(async (fixture) => {
      const candidateDigest = await fixture.writeCandidate();
      const attached = await fixture.attach(2, 'session-ploss-2', 'session-lease-ploss-2', 'boot-ploss-2');
      const run = parseCoordinationRun(attached.payload['run']);
      const session = parseCoordinationSessionLease(attached.payload['session']);
      const sessionToken = createHash('sha256').update(`ploss-${session.session_id}`).digest('hex');
      const stateRoot = fixture.ctx.sagaEnv[AUTOPILOT_STATE_ROOT_ENV];
      if (stateRoot === undefined) throw new Error('parent-loss cadence fixture lacks state root');
      const contextPath = join(stateRoot, 'parent-loss-successor-session.json');
      await writeCoordinatorSessionContext(contextPath, { schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: fixture.ctx.repoId, repo_key: fixture.ctx.repoId, autopilot_id: fixture.ctx.autopilotId, workstream: fixture.ctx.workstream, workstream_run: fixture.ctx.runId, session_id: session.session_id, session_generation: session.session_generation, run_version: run.version, session_lease_id: session.session_lease_id, session_token: sessionToken, session_version: session.version, pid: session.pid, boot_id: session.boot_id });
      const env = { ...fixture.ctx.sagaEnv, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: contextPath };
      const drive = () => driveD65ParentLossRecoveryFromEnvironment({ env, expectedCandidateSha256: candidateDigest, continuationSequence: 1 });
      const latestGraph = async () => {
        const status = await fixture.client.query('status', fixture.ctx.repoId, fixture.ctx.runId);
        const graphs = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact).filter((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1').sort((left, right) => left.artifact_id < right.artifact_id ? -1 : 1);
        const graph = graphs[graphs.length - 1];
        if (graph === undefined) throw new Error('parent-loss cadence lacks a complete graph');
        return { sequence: Number(graph.artifact_id.slice(-20)), sha256: graph.evidence.sha256 };
      };
      // Each invocation may advance exactly one edge, then fails loudly until
      // the independently signed next heartbeat exists. Re-entry proves the
      // already-committed edge byte-identically and continues forward only.
      await assert.rejects(drive, /program-heartbeats\/00000000000000000003\.json|next external program heartbeat/u);
      let graph = await latestGraph();
      assert.equal(graph.sequence, 3);
      await acceptGraphHeartbeat({ ctx: fixture.ctx, graphSequence: graph.sequence, graphSha256: graph.sha256, sessionId: session.session_id, sessionLeaseId: session.session_lease_id, sessionToken, sessionGeneration: 2, rowState: 'recovering', rowStopReasons: ['parent-recovering'] });
      await assert.rejects(drive, /program-heartbeats\/00000000000000000004\.json|next external program heartbeat/u);
      graph = await latestGraph();
      assert.equal(graph.sequence, 4);
      await acceptGraphHeartbeat({ ctx: fixture.ctx, graphSequence: graph.sequence, graphSha256: graph.sha256, sessionId: session.session_id, sessionLeaseId: session.session_lease_id, sessionToken, sessionGeneration: 2, rowState: 'recovering', rowStopReasons: ['parent-recovering'] });
      await assert.rejects(drive, /program-heartbeats\/00000000000000000005\.json|next external program heartbeat/u);
      graph = await latestGraph();
      assert.equal(graph.sequence, 5);
      await acceptGraphHeartbeat({ ctx: fixture.ctx, graphSequence: graph.sequence, graphSha256: graph.sha256, sessionId: session.session_id, sessionLeaseId: session.session_lease_id, sessionToken, sessionGeneration: 2, rowState: 'recovering', rowStopReasons: ['parent-recovering'] });
      await drive();
      const after = await fixture.client.query('status', fixture.ctx.repoId, fixture.ctx.runId);
      const schemas = (after.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact).map((artifact) => artifact.document_schema_version);
      assert.equal(schemas.filter((schema) => schema === 'autopilot.parent_loss.v1').length, 1);
      assert.equal(schemas.filter((schema) => schema === 'autopilot.continuation_event.v1').length, 1);
    });
  });

  void it('rejects candidate replacement after attach before any graph or Git artifact effect', async () => {
    await withParentLossFixture(async (fixture) => {
      const consumedDigest = await fixture.writeCandidate();
      const attached = await fixture.attach(2, 'session-ploss-2', 'session-lease-ploss-2', 'boot-ploss-2');
      const run = parseCoordinationRun(attached.payload['run']);
      const session = parseCoordinationSessionLease(attached.payload['session']);
      await fixture.writeCandidate({ event_id: 'parent-loss-replacement' });
      const stateRoot = fixture.ctx.sagaEnv[AUTOPILOT_STATE_ROOT_ENV];
      if (stateRoot === undefined) throw new Error('parent-loss replacement fixture lacks state root');
      const sessionToken = createHash('sha256').update(`ploss-${session.session_id}`).digest('hex');
      const contextPath = join(stateRoot, 'parent-loss-replacement-session.json');
      await writeCoordinatorSessionContext(contextPath, { schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: fixture.ctx.repoId, repo_key: fixture.ctx.repoId, autopilot_id: fixture.ctx.autopilotId, workstream: fixture.ctx.workstream, workstream_run: fixture.ctx.runId, session_id: session.session_id, session_generation: session.session_generation, run_version: run.version, session_lease_id: session.session_lease_id, session_token: sessionToken, session_version: session.version, pid: session.pid, boot_id: session.boot_id });
      await assert.rejects(() => driveD65ParentLossRecoveryFromEnvironment({ env: { ...fixture.ctx.sagaEnv, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: contextPath }, expectedCandidateSha256: consumedDigest }), /candidate no longer equals the digest consumed by attach-session/u);
      const status = await fixture.client.query('status', fixture.ctx.repoId, fixture.ctx.runId);
      const artifacts = (status.payload['authoritative_artifacts'] as unknown[]).map(parseCoordinationAuthoritativeArtifact);
      assert.equal(artifacts.filter((artifact) => artifact.document_schema_version === 'autopilot.semantic_graph.v1').length, 1);
      assert.equal(artifacts.some((artifact) => artifact.document_schema_version === 'autopilot.parent_loss.v1'), false);
    });
  });

  void it('rejects an unsigned/tampered candidate and a wrong successor identity without any row effect', async () => {
    await withParentLossFixture(async (fixture) => {
      // Wrong successor generation in the sealed candidate.
      await fixture.writeCandidate({ successor_generation: 9 });
      await assert.rejects(
        () => fixture.attach(2, 'session-ploss-2', 'session-lease-ploss-2', 'boot-ploss-2'),
        /successor identity does not equal the attach request/u,
      );
      // A candidate naming a stale graph digest rejects.
      await fixture.writeCandidate({ last_graph: { ref: 'program-evidence/last-graph.json', sha256: `sha256:${'0'.repeat(64)}`, byte_count: 1 } });
      await assert.rejects(
        () => fixture.attach(2, 'session-ploss-2', 'session-lease-ploss-2', 'boot-ploss-2'),
        /does not name the exact current accepted graph evidence tuple/u,
      );
      // Signed alternate status bytes/digest and a caller-selected predecessor
      // identity are independently rejected before any successor row exists.
      await fixture.writeCandidate({ status_ref: { ref: `parent-loss/${fixture.ctx.runId}/status.json`, sha256: `sha256:${'0'.repeat(64)}`, byte_count: 1 } });
      await assert.rejects(
        () => fixture.attach(2, 'session-ploss-2', 'session-lease-ploss-2', 'boot-ploss-2'),
        /status evidence bytes do not equal the signed parent-loss tuple/u,
      );
      await fixture.writeCandidate({ lost_coordinator_session_identity: { path: fixture.ctx.sessionPath, device: 1, inode: 1, session_id: 'foreign-session', pid: process.pid, boot_id: 'foreign-boot' } });
      await assert.rejects(
        () => fixture.attach(2, 'session-ploss-2', 'session-lease-ploss-2', 'boot-ploss-2'),
        /lost coordinator identity does not equal the residual predecessor session/u,
      );
      // The run still has exactly one attached generation-1 session (rollback).
      const after = await fixture.client.query('status', fixture.ctx.repoId, fixture.ctx.runId);
      const sessions = (after.payload['session_leases'] as unknown[]).map(parseCoordinationSessionLease).filter((session) => session.status === 'attached');
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.session_generation, 1);
    });
  });
});
