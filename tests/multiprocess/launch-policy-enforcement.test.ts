import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { chmodSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { parseCoordinationRun } from '../../src/core/coordination/contracts.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { encodeUnpaddedBase64Url } from '../../src/core/coordination/d65-trust.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import {
  bootstrapPolicyRun,
  commitPolicy,
  createPolicyRepository,
  createProgramEvidenceRoot,
  git,
  launchPolicyFields,
  registerPolicy,
  sha256,
  signPolicy,
  type PolicyCtx,
} from '../helpers/d65-launch-policy-fixture.ts';

async function withHarness(
  suffix: string,
  run: (ctx: PolicyCtx) => Promise<void>,
  options: { readonly preexistingPolicyPath?: boolean; readonly leaveMainCreatePrepared?: boolean } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-lp-'));
  const repoRoot = join(root, 'repo');
  const stateRoot = join(root, 'state');
  const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const repository = await createPolicyRepository(repoRoot, options);
  const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
  try {
    const client = new CoordinatorClient({ env, autoStart: false });
    await run(await bootstrapPolicyRun({ client, env, stateRoot, repository, suffix, ...(options.leaveMainCreatePrepared === true ? { leaveMainCreatePrepared: true } : {}) }));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function registerSigned(ctx: PolicyCtx, evidenceRoot: string, input: {
  readonly policyId?: string;
  readonly artifactId?: string;
  readonly overrides?: Record<string, unknown>;
  readonly signatureOverride?: string;
  readonly extraPath?: { readonly path: string; readonly body: string };
  readonly ref?: string;
  readonly idempotencyKey: string;
}): Promise<Awaited<ReturnType<typeof registerPolicy>>> {
  const policyId = input.policyId ?? 'policy-1';
  const fields = launchPolicyFields(ctx, evidenceRoot, { policy_id: policyId, ...(input.overrides ?? {}) });
  const policyBytes = signPolicy(ctx, fields, input.signatureOverride);
  const committed = await commitPolicy({ ctx, policyId, policyBytes, ...(input.ref === undefined ? {} : { ref: input.ref }), ...(input.extraPath === undefined ? {} : { extraPath: input.extraPath }) });
  return registerPolicy({
    ctx, artifactId: input.artifactId ?? `policy-artifact-${policyId}`, ...committed,
    idempotencyKey: input.idempotencyKey,
  });
}

void describe('D65 immutable cap-one launch policy authority', () => {
  void it('registers a signed B0/content-result-distinct policy through exact task/run-main authority', async () => {
    await withHarness('ok', async (ctx) => {
      const root = await createProgramEvidenceRoot();
      try {
        assert.notEqual(ctx.b0Commit, ctx.contentCommit, 'fixture must keep B0 distinct from content_result_commit');
        const registered = await registerSigned(ctx, root, { artifactId: 'opaque-policy-artifact', idempotencyKey: 'register-policy-ok' });
        assert.equal(registered.committed_event_seq !== null, true);
        const artifact = registered.payload['authoritative_artifact'] as Record<string, unknown>;
        assert.equal(artifact['artifact_id'], 'opaque-policy-artifact', 'API-12 artifact ID remains caller-chosen');
        assert.equal(artifact['source_type'], 'task');
        assert.equal(artifact['source_scope'], 'run-main');
        assert.equal(artifact['git_commit'], git(ctx.mainRoot, ['rev-parse', 'HEAD']));
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  interface Negative {
    readonly name: string;
    readonly overrides?: (ctx: PolicyCtx) => Record<string, unknown>;
    readonly signatureOverride?: string;
    readonly extraPath?: { readonly path: string; readonly body: string };
    readonly pattern: RegExp;
  }

  const negatives: readonly Negative[] = [
    { name: 'wrong signature', signatureOverride: encodeUnpaddedBase64Url(new Uint8Array(64)), pattern: /launch-policy-invalid: policy signature/u },
    { name: 'wrong signer_key_id', overrides: () => ({ signer_key_id: `sha256:${'9'.repeat(64)}` }), pattern: /launch-policy-invalid: policy signer_key_id/u },
    { name: 'wrong trust_anchor_ref', overrides: () => ({ trust_anchor_ref: '.pi/autopilot-trust/d65/other/operator-ed25519.spki' }), pattern: /launch-policy-invalid: policy trust_anchor_ref/u },
    { name: 'wrong trust_anchor_sha256', overrides: () => ({ trust_anchor_sha256: `sha256:${'8'.repeat(64)}`, signer_key_id: `sha256:${'8'.repeat(64)}` }), pattern: /launch-policy-invalid: policy trust_anchor_sha256/u },
    { name: 'content_result_commit substituted for B0', overrides: (ctx) => ({ base_commit: ctx.contentCommit }), pattern: /launch-policy-invalid: policy base_commit is not B0/u },
    { name: 'content_result_tree substituted for B0 tree', overrides: (ctx) => ({ base_tree: ctx.contentTree }), pattern: /launch-policy-invalid: policy base_tree is not the resolved B0 tree/u },
    { name: 'wrong package_commit', overrides: () => ({ package_commit: '1'.repeat(40) }), pattern: /launch-policy-invalid: policy package_commit/u },
    { name: 'wrong package_tree', overrides: () => ({ package_tree: '2'.repeat(40) }), pattern: /launch-policy-invalid: policy package_tree/u },
    { name: 'wrong bootstrap_graph_sha256', overrides: () => ({ bootstrap_graph_sha256: `sha256:${'3'.repeat(64)}` }), pattern: /launch-policy-invalid: policy bootstrap_graph_sha256/u },
    { name: 'wrong bootstrap_receipt_event_seq', overrides: () => ({ bootstrap_receipt_event_seq: 99 }), pattern: /launch-policy-invalid: policy bootstrap_receipt_event_seq/u },
    { name: 'wrong program_id', overrides: () => ({ program_id: 'program-other' }), pattern: /launch-policy-invalid: policy program_id/u },
    { name: 'two-path policy commit', extraPath: { path: 'product.ts', body: 'export const x = 1;\n' }, pattern: /launch-policy-invalid: policy_authority_commit must change exactly the single previously-absent policy path/u },
  ];

  for (const [index, negative] of negatives.entries()) {
    void it(`rejects ${negative.name} even when tampered fields are re-signed`, async () => {
      await withHarness(`n${String(index)}`, async (ctx) => {
        const root = await createProgramEvidenceRoot();
        try {
          const fields = launchPolicyFields(ctx, root, negative.overrides?.(ctx) ?? {});
          const policyBytes = signPolicy(ctx, fields, negative.signatureOverride);
          const committed = await commitPolicy({ ctx, policyId: 'policy-1', policyBytes, ...(negative.extraPath === undefined ? {} : { extraPath: negative.extraPath }) });
          await assert.rejects(() => registerPolicy({ ctx, artifactId: `negative-${String(index)}`, ...committed, idempotencyKey: `register-negative-${String(index)}` }), negative.pattern);
        } finally { await rm(root, { recursive: true, force: true }); }
      });
    });
  }

  void it('maps structurally malformed policy bytes to launch-policy-invalid', async () => {
    await withHarness('malformed', async (ctx) => {
      const root = await createProgramEvidenceRoot();
      try {
        const bytes = signPolicy(ctx, launchPolicyFields(ctx, root, { unknown_field: true }));
        const committed = await commitPolicy({ ctx, policyId: 'policy-1', policyBytes: bytes });
        await assert.rejects(() => registerPolicy({ ctx, artifactId: 'malformed-policy', ...committed, idempotencyKey: 'malformed-policy' }), /launch-policy-invalid: policy document is malformed/u);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  void it('rejects repository scope before reading a repository-scoped policy path', async () => {
    await withHarness('scope', async (ctx) => {
      const root = await createProgramEvidenceRoot();
      try {
        const bytes = signPolicy(ctx, launchPolicyFields(ctx, root));
        const committed = await commitPolicy({ ctx, policyId: 'policy-1', policyBytes: bytes });
        await assert.rejects(() => registerPolicy({ ctx, artifactId: 'wrong-scope', ...committed, idempotencyKey: 'wrong-scope', sourceScope: 'repository' }), /launch-policy-invalid: launch policy registration requires source_type=task and source_scope=run-main/u);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  void it('rejects a non-task source type on run-main', async () => {
    await withHarness('source-type', async (ctx) => {
      const root = await createProgramEvidenceRoot();
      try {
        const bytes = signPolicy(ctx, launchPolicyFields(ctx, root));
        const committed = await commitPolicy({ ctx, policyId: 'policy-1', policyBytes: bytes });
        await assert.rejects(() => registerPolicy({ ctx, artifactId: 'wrong-source-type', ...committed, idempotencyKey: 'wrong-source-type', sourceType: 'master-plan' }), /launch-policy-invalid: launch policy registration requires source_type=task and source_scope=run-main/u);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  void it('rejects a policy path that is not authority/launch-policies/<policy_id>.json', async () => {
    await withHarness('path', async (ctx) => {
      const root = await createProgramEvidenceRoot();
      try {
        const bytes = signPolicy(ctx, launchPolicyFields(ctx, root));
        const committed = await commitPolicy({ ctx, policyId: 'policy-1', policyBytes: bytes, ref: 'authority/other/policy-1.json' });
        await assert.rejects(() => registerPolicy({ ctx, artifactId: 'wrong-path', ...committed, idempotencyKey: 'wrong-path' }), /launch-policy-invalid: policy path must be authority\/launch-policies/u);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  void it('rejects dirty run-main planning bytes at policy registration', async () => {
    await withHarness('dirty', async (ctx) => {
      const root = await createProgramEvidenceRoot();
      try {
        const bytes = signPolicy(ctx, launchPolicyFields(ctx, root));
        const committed = await commitPolicy({ ctx, policyId: 'policy-1', policyBytes: bytes });
        await mkdir(join(ctx.mainRoot, 'runtime'), { recursive: true });
        await writeFile(join(ctx.mainRoot, 'runtime', 'mission.md'), '# planning began before policy registration\n', 'utf8');
        await assert.rejects(() => registerPolicy({ ctx, artifactId: 'dirty-main', ...committed, idempotencyKey: 'dirty-main' }), /launch-policy-invalid: launch policy must register from a clean run-main worktree/u);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  void it('rejects policy registration while the durable main/create edge is still planned/prepared', async () => {
    await withHarness('prepared-main', async (ctx) => {
      const root = await createProgramEvidenceRoot();
      try {
        const bytes = signPolicy(ctx, launchPolicyFields(ctx, root));
        const committed = await commitPolicy({ ctx, policyId: 'policy-1', policyBytes: bytes });
        await assert.rejects(() => registerPolicy({ ctx, artifactId: 'prepared-main-policy', ...committed, idempotencyKey: 'prepared-main-policy' }), /launch-policy-invalid: launch policy registration requires the exact active run-main worktree/u);
      } finally { await rm(root, { recursive: true, force: true }); }
    }, { leaveMainCreatePrepared: true });
  });

  void it('rejects a policy commit whose parent is B0 rather than content_result_commit', async () => {
    await withHarness('parent', async (ctx) => {
      const root = await createProgramEvidenceRoot();
      try {
        git(ctx.mainRoot, ['reset', '--hard', ctx.b0Commit]);
        const bytes = signPolicy(ctx, launchPolicyFields(ctx, root));
        const committed = await commitPolicy({ ctx, policyId: 'policy-1', policyBytes: bytes });
        await assert.rejects(() => registerPolicy({ ctx, artifactId: 'wrong-parent', ...committed, idempotencyKey: 'wrong-parent' }), /launch-policy-invalid: policy_authority_commit sole parent is not content_result_commit/u);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  void it('rejects replacement of a policy path already present at content_result_commit', async () => {
    await withHarness('replace', async (ctx) => {
      const root = await createProgramEvidenceRoot();
      try {
        const bytes = signPolicy(ctx, launchPolicyFields(ctx, root));
        const committed = await commitPolicy({ ctx, policyId: 'policy-1', policyBytes: bytes });
        await assert.rejects(() => registerPolicy({ ctx, artifactId: 'replacement', ...committed, idempotencyKey: 'replacement' }), /launch-policy-invalid: policy path must be previously absent/u);
      } finally { await rm(root, { recursive: true, force: true }); }
    }, { preexistingPolicyPath: true });
  });

  void it('rejects a directory whose mode is private but not exact 0700', async () => {
    await withHarness('mode', async (ctx) => {
      const root = await createProgramEvidenceRoot();
      chmodSync(root, 0o500);
      try {
        await assert.rejects(() => registerSigned(ctx, root, { idempotencyKey: 'wrong-mode' }), /launch-policy-invalid: policy program_evidence_root must have exact mode 0700/u);
      } finally {
        chmodSync(root, 0o700);
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  void it('rejects a symlink-selected evidence root rather than its canonical realpath', async () => {
    await withHarness('symlink', async (ctx) => {
      const root = await createProgramEvidenceRoot();
      const alias = `${root}-alias`;
      await symlink(root, alias, 'dir');
      try {
        await assert.rejects(() => registerSigned(ctx, alias, { idempotencyKey: 'symlink-root' }), /launch-policy-invalid: policy program_evidence_root must be its canonical real directory path/u);
      } finally {
        await rm(alias, { force: true });
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  void it('rejects a mode-0700 evidence root nested under coordinator state', async () => {
    await withHarness('overlap', async (ctx) => {
      const nested = join(ctx.stateRoot, 'program-evidence');
      await mkdir(nested, { recursive: true, mode: 0o700 });
      chmodSync(nested, 0o700);
      await assert.rejects(() => registerSigned(ctx, realpathSync(nested), { idempotencyKey: 'overlap-root' }), /launch-policy-invalid: policy program_evidence_root overlaps/u);
    });
  });

  void it('rejects an absent-to-v2 initial policy gap with launch-policy-cas-conflict', async () => {
    await withHarness('gap', async (ctx) => {
      const root = await createProgramEvidenceRoot();
      try {
        await assert.rejects(() => registerSigned(ctx, root, {
          artifactId: 'gap-policy', idempotencyKey: 'gap-policy',
          overrides: {
            policy_version: 2,
            prior_policy_sha256: sha256('invented prior policy'),
            capacity_decision_ref: 'authority/capacity-decisions/decision-1.json',
            capacity_decision_sha256: sha256('invented capacity decision'),
          },
        }), /launch-policy-cas-conflict: the initial policy chain must begin at version 1 \(gap\)/u);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  void it('rejects a second valid sibling policy by schema-based absent-to-v1 CAS', async () => {
    await withHarness('twice', async (ctx) => {
      const root = await createProgramEvidenceRoot();
      try {
        const first = await registerSigned(ctx, root, { policyId: 'policy-1', artifactId: 'arbitrary-first-id', idempotencyKey: 'first-policy' });
        assert.equal(first.committed_event_seq !== null, true);
        git(ctx.mainRoot, ['reset', '--hard', ctx.contentCommit]);
        await assert.rejects(() => registerSigned(ctx, root, { policyId: 'policy-2', artifactId: 'unrelated-second-id', idempotencyKey: 'second-policy' }), /launch-policy-cas-conflict: an accepted launch policy already exists/u);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  void it('keeps roster_sha256 operator-authenticated: changing it without the operator signature rejects', async () => {
    await withHarness('roster', async (ctx) => {
      const root = await createProgramEvidenceRoot();
      try {
        const faithful = launchPolicyFields(ctx, root);
        const signed = JSON.parse(signPolicy(ctx, faithful)) as Record<string, unknown>;
        signed['roster_sha256'] = sha256('substituted roster');
        const bytes = `${JSON.stringify(signed, null, 2)}\n`;
        const committed = await commitPolicy({ ctx, policyId: 'policy-1', policyBytes: bytes });
        await assert.rejects(() => registerPolicy({ ctx, artifactId: 'roster-substitution', ...committed, idempotencyKey: 'roster-substitution' }), /launch-policy-invalid: policy signature/u);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });
});

void describe('D65 accept-program-heartbeat durable CAS authority', () => {
  void it('accepts an exact initial governing heartbeat with no run/lease mutation and surfaces its closed result', async () => {
    await withHarness('heartbeat-ok', async (ctx) => {
      const evidenceRoot = await createProgramEvidenceRoot();
      try {
        const registeredPolicy = await registerSigned(ctx, evidenceRoot, { artifactId: 'heartbeat-policy', idempotencyKey: 'register-heartbeat-policy' });
        const policy = registeredPolicy.payload['authoritative_artifact'] as Record<string, unknown>;
        const policyEvidence = policy['evidence'] as Record<string, unknown>;
        const policyRef = policyEvidence['ref'] as string;
        const policyDigest = policyEvidence['sha256'] as `sha256:${string}`;
        const status = await ctx.client.query('status', ctx.repoId, ctx.runId);
        const doctor = await ctx.client.query('doctor', ctx.repoId, ctx.runId);
        const runsValue = status.payload['runs'];
        if (!Array.isArray(runsValue) || runsValue.length !== 1) throw new Error('heartbeat fixture lacks one run');
        const run = parseCoordinationRun(runsValue[0]);
        const initialVersion = run.version;
        const issued = new Date();
        issued.setMilliseconds(Math.max(0, issued.getMilliseconds() - 50));
        const issuedAt = issued.toISOString();
        const validUntil = new Date(issued.getTime() + 15 * 60 * 1000).toISOString();
        const fields = {
          schema_version: 'autopilot.program_heartbeat.v1', program_id: ctx.programId, sequence: 1, prior_sha256: null,
          issued_at: issuedAt, valid_until: validUntil, package_commit: ctx.packageCommit, package_tree: ctx.packageTree,
          base_commit: ctx.b0Commit, base_tree: ctx.b0Tree,
          rows: [{ workstream: run.workstream, workstream_run: ctx.runId, parent_session_file_sha256: null, coordinator_session_lease_id: ctx.sessionLeaseId, accepted_graph_sequence: 1, accepted_graph_sha256: ctx.bootstrapGraphSha256, status_sha256: status.payload['semantic_snapshot_sha256'], doctor_sha256: doctor.payload['semantic_snapshot_sha256'], session_lease_state: 'attached', child_lease_ids: [], launch_policy_sha256: policyDigest, last_progress_event_seq: registeredPolicy.committed_event_seq, last_handoff_sha256: null, row_state: 'active', dispatch_allowed: true, stop_reasons: [] }],
          provider_health: [{ provider: 'openai-codex', state: 'healthy', observation_ref: policyRef, observation_sha256: policyDigest, cooldown_until: null, probe_workstream_run: null, probe_ref: null, probe_sha256: null, consumption_event_seq: null }],
          dispatch_allowed: true, stop_reasons: [], trust_anchor_ref: ctx.trustRef, trust_anchor_sha256: ctx.trustSha256, signer_key_id: ctx.trustSha256,
        };
        const domain = Buffer.from('AUTOPILOT-D65-PROGRAM-HEARTBEAT\0', 'utf8');
        const heartbeatRef = 'program-heartbeats/00000000000000000001.json';
        await mkdir(join(evidenceRoot, 'program-heartbeats'), { recursive: true, mode: 0o700 });
        const signHeartbeat = (heartbeatFields: Readonly<Record<string, unknown>>): string => {
          const signature = encodeUnpaddedBase64Url(new Uint8Array(sign(null, Buffer.concat([domain, Buffer.from(canonicalJson(heartbeatFields), 'utf8')]), ctx.privateKey)));
          return `${canonicalJson({ ...heartbeatFields, signature })}\n`;
        };
        const acceptHeartbeat = async (heartbeatBytes: string) => {
          const heartbeatDigest = sha256(heartbeatBytes);
          await writeFile(join(evidenceRoot, heartbeatRef), heartbeatBytes, { encoding: 'utf8', mode: 0o600 });
          chmodSync(join(evidenceRoot, heartbeatRef), 0o600);
          const identity = { repo_id: ctx.repoId, workstream_run: ctx.runId, sequence: 1, heartbeat_sha256: heartbeatDigest, acceptance_kind: 'governing' };
          return await ctx.client.mutate('accept-program-heartbeat', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: initialVersion, idempotencyKey: `accept-program-heartbeat:${sha256(`${canonicalJson(identity)}\n`)}` }, {
            program_id: ctx.programId, workstream_run: ctx.runId, heartbeat_ref: heartbeatRef, heartbeat_sha256: heartbeatDigest, acceptance_kind: 'governing', expected_prior_sequence: null, expected_prior_sha256: null, session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken,
          });
        };
        const alteredFields = { ...fields, provider_health: [{ ...fields.provider_health[0], observation_sha256: sha256('unaccepted launch policy') }] };
        await assert.rejects(() => acceptHeartbeat(signHeartbeat(alteredFields)), /initial healthy provider observation does not equal accepted launch policy authority/u);
        const accepted = await acceptHeartbeat(signHeartbeat(fields));
        assert.deepEqual(Object.keys(accepted.payload).sort(), ['acceptance_kind', 'coordinator_time', 'heartbeat_ref', 'heartbeat_sha256', 'issued_at', 'prior_sha256', 'program_id', 'repo_id', 'schema_version', 'sequence', 'valid_until', 'workstream_run'].sort());
        assert.equal(accepted.payload['schema_version'], 'autopilot.program_heartbeat_acceptance_result.v1');
        assert.equal(accepted.payload['acceptance_kind'], 'governing');
        const after = await ctx.client.query('status', ctx.repoId, ctx.runId);
        const doctorAfter = await ctx.client.query('doctor', ctx.repoId, ctx.runId);
        assert.equal((after.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'], initialVersion, 'liveness acceptance must not mutate run version');
        assert.deepEqual(after.payload['accepted_program_heartbeat'], accepted.payload);
        assert.equal(after.payload['semantic_snapshot_sha256'], status.payload['semantic_snapshot_sha256'], 'program-heartbeat acceptance must be removed from the status semantic digest');
        assert.equal(doctorAfter.payload['semantic_snapshot_sha256'], doctor.payload['semantic_snapshot_sha256'], 'program-heartbeat acceptance must be removed from the doctor semantic digest');
        await ctx.client.mutate('heartbeat', { repoId: ctx.repoId, workstreamRun: ctx.runId, sessionId: ctx.sessionId, fencingGeneration: 1, expectedVersion: 1, idempotencyKey: 'pure-session-heartbeat-after-program-head' }, { session_lease_id: ctx.sessionLeaseId, session_token: ctx.sessionToken, lease_expires_at: '2099-02-01T00:00:00.000Z' });
        const afterSessionHeartbeat = await ctx.client.query('status', ctx.repoId, ctx.runId);
        const doctorAfterSessionHeartbeat = await ctx.client.query('doctor', ctx.repoId, ctx.runId);
        assert.equal(afterSessionHeartbeat.payload['semantic_snapshot_sha256'], status.payload['semantic_snapshot_sha256'], 'pure session renewal must preserve the status semantic digest');
        assert.equal(doctorAfterSessionHeartbeat.payload['semantic_snapshot_sha256'], doctor.payload['semantic_snapshot_sha256'], 'pure session renewal must preserve the doctor semantic digest');
        const frame = await ctx.client.readD65DispatchAuthority(ctx.repoId, ctx.runId, { expected_version: initialVersion, session_lease_id: ctx.sessionLeaseId, session_id: ctx.sessionId, session_generation: 1 });
        assert.deepEqual(frame.graph, { complete_graph_current: false, graph_publication_pending: false }, 'bootstrap heartbeat cannot synthesize a complete graph');
        assert.equal(frame.policy.policy_current, true);
        assert.equal(frame.heartbeat.governing_heartbeat_current, true);
        assert.deepEqual(frame.session, { attached_session_current: true, expected_version_current: true, lease_current: true, cap_current: true });
        const stale = await ctx.client.readD65DispatchAuthority(ctx.repoId, ctx.runId, { expected_version: initialVersion + 1, session_lease_id: 'wrong-session', session_id: ctx.sessionId, session_generation: 1 });
        assert.equal(stale.session.expected_version_current, false);
        assert.equal(stale.session.attached_session_current, false);
      } finally { await rm(evidenceRoot, { recursive: true, force: true }); }
    });
  });
});
