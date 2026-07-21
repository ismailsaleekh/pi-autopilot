import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';
import {
  bootstrapPolicyRun,
  commitPolicy,
  createPolicyRepository,
  createProgramEvidenceRoot,
  launchPolicyFields,
  registerPolicy,
  signPolicy,
  type PolicyCtx,
} from '../helpers/d65-launch-policy-fixture.ts';

interface Harness {
  readonly root: string;
  readonly stateRoot: string;
  readonly env: ProcessEnvLike;
  readonly paths: ReturnType<typeof coordinatorRuntimePaths>;
  readonly ctx: PolicyCtx;
  server: Awaited<ReturnType<typeof startCoordinatorServer>> | null;
}

async function setup(suffix: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-lp-crash-'));
  const stateRoot = join(root, 'state');
  const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const paths = coordinatorRuntimePaths(env);
  const repository = await createPolicyRepository(join(root, 'repo'));
  const server = await startCoordinatorServer(paths);
  try {
    const client = new CoordinatorClient({ env, autoStart: false });
    const ctx = await bootstrapPolicyRun({ client, env, stateRoot, repository, suffix });
    return { root, stateRoot, env, paths, ctx, server };
  } catch (error) {
    await server.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function restart(harness: Harness): Promise<PolicyCtx> {
  if (harness.server === null) throw new Error('test server is not running');
  await harness.server.close();
  harness.server = await startCoordinatorServer(harness.paths);
  return { ...harness.ctx, client: new CoordinatorClient({ env: harness.env, autoStart: false }) };
}

async function cleanup(harness: Harness, evidenceRoot: string): Promise<void> {
  if (harness.server !== null) await harness.server.close();
  harness.server = null;
  await rm(evidenceRoot, { recursive: true, force: true });
  await rm(harness.root, { recursive: true, force: true });
}

function launchPolicyArtifacts(statusPayload: Readonly<Record<string, unknown>>): readonly Record<string, unknown>[] {
  return (statusPayload['authoritative_artifacts'] as Array<Record<string, unknown>>).filter((artifact) => artifact['document_schema_version'] === 'autopilot.launch_policy.v1');
}

void describe('D65 launch policy registration crash-safe replay', () => {
  void it('replays the exact signed task/run-main policy registration across coordinator reopen', async () => {
    const harness = await setup('replay');
    const evidenceRoot = await createProgramEvidenceRoot();
    try {
      const policyBytes = signPolicy(harness.ctx, launchPolicyFields(harness.ctx, evidenceRoot));
      const committed = await commitPolicy({ ctx: harness.ctx, policyId: 'policy-1', policyBytes });
      const registered = await registerPolicy({
        ctx: harness.ctx, artifactId: 'opaque-replay-policy', ...committed, idempotencyKey: 'register-policy-replay',
      });
      const committedPayload = canonicalJson(registered.payload);
      const committedSequence = registered.committed_event_seq;

      const reopenedCtx = await restart(harness);
      const replay = await registerPolicy({
        ctx: reopenedCtx, artifactId: 'opaque-replay-policy', ...committed, idempotencyKey: 'register-policy-replay',
      });
      assert.equal(replay.committed_event_seq, committedSequence);
      assert.equal(canonicalJson(replay.payload), committedPayload, 'response-loss replay must return the byte-identical committed effect');
      const status = await reopenedCtx.client.query('status', reopenedCtx.repoId, reopenedCtx.runId);
      const policies = launchPolicyArtifacts(status.payload);
      assert.equal(policies.length, 1);
      assert.equal(policies[0]?.['artifact_id'], 'opaque-replay-policy');
    } finally {
      await cleanup(harness, evidenceRoot);
    }
  });

  void it('rolls back malformed policy registration and preserves no policy artifact across reopen', async () => {
    const harness = await setup('rollback');
    const evidenceRoot = await createProgramEvidenceRoot();
    try {
      const malformedBytes = signPolicy(harness.ctx, launchPolicyFields(harness.ctx, evidenceRoot, { parallel_cap: 2 }));
      const committed = await commitPolicy({ ctx: harness.ctx, policyId: 'policy-1', policyBytes: malformedBytes });
      await assert.rejects(() => registerPolicy({
        ctx: harness.ctx, artifactId: 'malformed-policy', ...committed, idempotencyKey: 'register-malformed-policy',
      }), /launch-policy-cap-unauthorized: parallel_cap must remain exactly 1 under D65/u);

      const reopenedCtx = await restart(harness);
      const status = await reopenedCtx.client.query('status', reopenedCtx.repoId, reopenedCtx.runId);
      assert.equal(launchPolicyArtifacts(status.payload).length, 0, 'failed registration must leave no launch-policy row after restart');
    } finally {
      await cleanup(harness, evidenceRoot);
    }
  });
});
