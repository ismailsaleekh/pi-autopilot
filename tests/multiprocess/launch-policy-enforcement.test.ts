import assert from 'node:assert/strict';
import { chmodSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
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
