import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { canonicalJson } from '../../src/core/coordination/canonical-json.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationRun, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { D65_ALLOWED_BOOTSTRAP_OPERATIONS } from '../../src/core/coordination/d65-semantic-graph.ts';
import { encodeUnpaddedBase64Url } from '../../src/core/coordination/d65-trust.ts';
import { writeCoordinatorSessionContext, type CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { executeOwnedWorktreeSaga, OwnedWorktreeSagaClient } from '../../src/core/coordination/worktree-saga.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import type { ActiveAutopilotRow, ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

export function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Autopilot Test', GIT_AUTHOR_EMAIL: 'autopilot@example.invalid',
      GIT_COMMITTER_NAME: 'Autopilot Test', GIT_COMMITTER_EMAIL: 'autopilot@example.invalid',
    },
  });
  if ((result.status ?? -1) !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export interface PolicyRepository {
  readonly repoRoot: string;
  readonly b0Commit: string;
  readonly b0Tree: string;
  readonly contentCommit: string;
  readonly contentTree: string;
}

/** Create the frozen B0 -> content_result ancestry (always two distinct commits). */
export async function createPolicyRepository(repoRoot: string, options: { readonly preexistingPolicyPath?: boolean } = {}): Promise<PolicyRepository> {
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  await writeFile(join(repoRoot, 'README.md'), 'B0\n', 'utf8');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'B0']);
  const b0Commit = git(repoRoot, ['rev-parse', 'HEAD']);
  const b0Tree = git(repoRoot, ['rev-parse', 'HEAD^{tree}']);
  await writeFile(join(repoRoot, 'content-result.txt'), 'sealed content result\n', 'utf8');
  if (options.preexistingPolicyPath === true) {
    await mkdir(join(repoRoot, 'authority', 'launch-policies'), { recursive: true });
    await writeFile(join(repoRoot, 'authority', 'launch-policies', 'policy-1.json'), '{"placeholder":true}\n', 'utf8');
  }
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'content result']);
  return {
    repoRoot, b0Commit, b0Tree,
    contentCommit: git(repoRoot, ['rev-parse', 'HEAD']),
    contentTree: git(repoRoot, ['rev-parse', 'HEAD^{tree}']),
  };
}

export interface PolicyCtx extends PolicyRepository {
  readonly client: CoordinatorClient;
  readonly stateRoot: string;
  readonly mainRoot: string;
  readonly repoId: string;
  readonly runId: string;
  readonly programId: string;
  readonly sessionId: string;
  readonly sessionLeaseId: string;
  readonly sessionToken: string;
  readonly privateKey: KeyObject;
  readonly trustRef: string;
  readonly trustSha256: `sha256:${string}`;
  readonly packageCommit: string;
  readonly packageTree: string;
  readonly bootstrapGraphSha256: `sha256:${string}`;
  readonly bootstrapReceiptEventSeq: number;
}

/**
 * Establish a real D65 bootstrap transaction, attached session, and active
 * durable main worktree. Policy registration therefore uses the frozen existing
 * task/run-main surface rather than repository-scope test shortcuts.
 */
export async function bootstrapPolicyRun(input: {
  readonly client: CoordinatorClient;
  readonly env: ProcessEnvLike;
  readonly stateRoot: string;
  readonly repository: PolicyRepository;
  readonly suffix: string;
  readonly leaveMainCreatePrepared?: boolean;
}): Promise<PolicyCtx> {
  const { client, stateRoot, repository, suffix } = input;
  const { repoRoot, b0Commit, b0Tree, contentCommit, contentTree } = repository;
  const repoId = `repo-lp-${suffix}`;
  const runId = `run-${suffix}`;
  const autopilotId = `autopilot-${suffix}`;
  const workstream = `work-${suffix}`;
  const programId = `program-${suffix}`;
  const branch = `autopilot/${runId}`;
  const worktreeRoot = join(stateRoot, 'worktrees', repoId);
  const mainRoot = join(worktreeRoot, 'active', runId, 'main');
  const runtimeRoot = join(mainRoot, '.pi', 'autopilot', workstream);
  const packageCommit = 'a'.repeat(40);
  const packageTree = 'b'.repeat(40);
  const runResource: Readonly<Record<string, unknown>> = {
    schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: runId,
    source_repo: repoRoot, git_common_dir: join(repoRoot, '.git'), worktree_root: worktreeRoot,
    main_worktree_path: mainRoot, runtime_root: runtimeRoot, branch, target_branch: 'main',
    target_base_sha: contentCommit, origin_url: null, started_at: '2026-07-19T00:00:00.000Z', version: 1,
  };
  const prospectiveRun: Readonly<Record<string, unknown>> = {
    schema_version: 'autopilot.coordination_run.v1', repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: runId,
    coordination_authority: 'coordinator-edit-leases-v1', status: 'active', active_session_generation: 0, created_event_seq: 1, version: 1,
  };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }) as unknown as Uint8Array);
  const trustRef = `.pi/autopilot-trust/d65/${programId}/operator-ed25519.spki`;
  const trustSha256 = sha256(spki);
  const bootstrapRef = `.pi/autopilot-bootstrap/${runId}/bootstrap.json`;
  const bootstrap = {
    schema_version: 'autopilot.semantic_graph_bootstrap.v1', program_id: programId, graph_sequence: 1, prior_graph_sha256: null,
    repo_id: repoId, autopilot_id: autopilotId, workstream, workstream_run: runId,
    run_timestamp: '2026-07-19T00:00:00.000Z', run_nonce: 'abcdef',
    content_commit: contentCommit, content_tree: contentTree, package_commit: packageCommit, package_tree: packageTree,
    prospective_run: prospectiveRun, prospective_resource: runResource, covered_event_seq: 0,
    trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256,
    allowed_bootstrap_operations: [...D65_ALLOWED_BOOTSTRAP_OPERATIONS], created_at: '2026-07-19T00:00:01.000Z',
  };
  const bootstrapBytes = `${JSON.stringify(bootstrap, null, 2)}\n`;
  git(repoRoot, ['checkout', '-b', `autopilot/bootstrap/${runId}`, contentCommit]);
  await mkdir(join(repoRoot, dirname(trustRef)), { recursive: true });
  await writeFile(join(repoRoot, trustRef), spki);
  await mkdir(join(repoRoot, dirname(bootstrapRef)), { recursive: true });
  await writeFile(join(repoRoot, bootstrapRef), bootstrapBytes, 'utf8');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'bootstrap overlay']);
  const bootstrapCommit = git(repoRoot, ['rev-parse', 'HEAD']);
  git(repoRoot, ['checkout', 'main']);

  const runResponse = await client.mutate('attach-run', {
    repoId, workstreamRun: runId, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `attach-run-${suffix}`,
  }, {
    repo_key: repoId, canonical_root: repoRoot, git_common_dir: join(repoRoot, '.git'),
    autopilot_id: autopilotId, workstream, coordination_authority: 'coordinator-edit-leases-v1', run_resource: runResource,
    bootstrap_graph: {
      schema_version: 'autopilot.semantic_graph_bootstrap.v1', ref: bootstrapRef, sha256: sha256(bootstrapBytes), byte_count: Buffer.byteLength(bootstrapBytes, 'utf8'),
      git_commit: bootstrapCommit, covered_event_seq: 0, prospective_run: prospectiveRun, prospective_resource: runResource,
      trust_anchor_ref: trustRef, trust_anchor_sha256: trustSha256,
    },
  });
  const run = parseCoordinationRun(runResponse.payload['run']);
  const bootstrapArtifact = runResponse.payload['bootstrap_artifact'] as Record<string, unknown>;
  const bootstrapGraphSha256 = (bootstrapArtifact['evidence'] as Record<string, unknown>)['sha256'] as `sha256:${string}`;
  const bootstrapReceiptEventSeq = bootstrapArtifact['registered_event_seq'] as number;
  const token = createHash('sha256').update(`lp-${suffix}`).digest('hex');
  const sessionResponse = await client.mutate('attach-session', {
    repoId, workstreamRun: runId, sessionId: `session-${suffix}`, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: `attach-session-${suffix}`,
  }, {
    session_lease_id: `session-lease-${suffix}`, session_token: token, pid: process.pid, boot_id: `boot-${suffix}`,
    lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null,
  });
  const attachedRun = parseCoordinationRun(sessionResponse.payload['run']);
  const session = parseCoordinationSessionLease(sessionResponse.payload['session']);
  const sessionContext: CoordinatorSessionContext = {
    schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot,
    repo_id: repoId, repo_key: repoId, autopilot_id: autopilotId, workstream, workstream_run: runId,
    session_id: session.session_id, session_generation: session.session_generation, run_version: attachedRun.version,
    session_lease_id: session.session_lease_id, session_token: token, session_version: session.version,
    pid: session.pid, boot_id: session.boot_id,
  };
  const sessionPath = join(stateRoot, `session-${suffix}.json`);
  await writeCoordinatorSessionContext(sessionPath, sessionContext);
  const active: ActiveAutopilotRow = {
    schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1',
    autopilot_id: autopilotId, workstream, workstream_run: runId, repo_key: repoId,
    source_repo: repoRoot, git_common_dir: join(repoRoot, '.git'), worktree_root: worktreeRoot,
    main_worktree_path: mainRoot, branch, runtime_root: runtimeRoot, target_branch: 'main', target_base_sha: contentCommit,
    origin_url: null, pid: process.pid, boot_id: session.boot_id, status: 'active', started_at: '2026-07-19T00:00:00.000Z',
    active_run_epoch: 1, active_epoch_started_at: '2026-07-19T00:00:00.000Z', active_run_receipt_id: `receipt-${suffix}`,
  };
  const sagaEnv: ProcessEnvLike = { ...input.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: sessionPath };
  const mainCreateSpec = {
    active, unitId: 'main', attempt: 1, kind: 'main' as const, operationType: 'create' as const,
    initialWorktreeState: 'planned' as const, committedWorktreeState: 'active' as const,
    intent: {
      repo_root: repoRoot, worktree_path: mainRoot, git_common_dir: join(repoRoot, '.git'), branch,
      reason: 'D65 bootstrap main worktree', base_sha: contentCommit, target_sha: null, archive_ref: null,
      checkout_mode: 'full' as const, sparse_patterns: [], paths: [], metadata_refs: [],
    },
  };
  if (input.leaveMainCreatePrepared === true) {
    // Faithful interrupted bootstrap fixture: the physical worktree exists, but
    // only prepare-operation committed; transition-operation has not advanced
    // the durable main/create edge beyond planned/prepared.
    await mkdir(dirname(mainRoot), { recursive: true });
    git(repoRoot, ['worktree', 'add', '-b', branch, mainRoot, contentCommit]);
    await new OwnedWorktreeSagaClient(client, sessionContext).prepare(mainCreateSpec);
  } else {
    await executeOwnedWorktreeSaga(mainCreateSpec, {
      action: async () => {
        await mkdir(dirname(mainRoot), { recursive: true });
        git(repoRoot, ['worktree', 'add', '-b', branch, mainRoot, contentCommit]);
      },
    }, sagaEnv);
  }

  return {
    ...repository, client, stateRoot, mainRoot, repoId, runId, programId,
    sessionId: session.session_id, sessionLeaseId: session.session_lease_id, sessionToken: token,
    privateKey, trustRef, trustSha256, packageCommit, packageTree, bootstrapGraphSha256, bootstrapReceiptEventSeq,
  };
}

export function launchPolicyFields(ctx: PolicyCtx, programEvidenceRoot: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'autopilot.launch_policy.v1', program_id: ctx.programId, policy_id: 'policy-1', policy_version: 1,
    repo_id: ctx.repoId, workstream_run: ctx.runId, package_commit: ctx.packageCommit, package_tree: ctx.packageTree,
    base_commit: ctx.b0Commit, base_tree: ctx.b0Tree, bootstrap_graph_sha256: ctx.bootstrapGraphSha256,
    bootstrap_receipt_event_seq: ctx.bootstrapReceiptEventSeq, roster_sha256: sha256('fixed D65 Pi-subscription roster'),
    parallel_cap: 1, maximum_parallel_cap: 1, expected_checkout_units: 1,
    program_evidence_root: programEvidenceRoot, trust_anchor_ref: ctx.trustRef, trust_anchor_sha256: ctx.trustSha256,
    prior_policy_sha256: null, capacity_decision_ref: null, capacity_decision_sha256: null,
    issued_at: '2026-07-19T00:00:00.000Z', signer_key_id: ctx.trustSha256, ...overrides,
  };
}

/** Domain || RFC-8785(policy without signature), with no LF in the signed payload. */
export function signPolicy(ctx: PolicyCtx, fields: Record<string, unknown>, signatureOverride?: string): string {
  const domain = Buffer.from('AUTOPILOT-D65-LAUNCH-POLICY\u0000', 'utf8');
  const message = Buffer.from(canonicalJson(fields), 'utf8');
  const signature = signatureOverride ?? encodeUnpaddedBase64Url(new Uint8Array(sign(null, Buffer.concat([domain, message]), ctx.privateKey) as unknown as Uint8Array));
  return `${JSON.stringify({ ...fields, signature }, null, 2)}\n`;
}

export async function createProgramEvidenceRoot(): Promise<string> {
  return realpathSync(await mkdtemp(join(tmpdir(), 'pi-autopilot-lp-evidence-')));
}

export async function commitPolicy(input: {
  readonly ctx: PolicyCtx;
  readonly policyId: string;
  readonly policyBytes: string;
  readonly ref?: string;
  readonly extraPath?: { readonly path: string; readonly body: string };
}): Promise<{ readonly head: string; readonly ref: string; readonly digest: `sha256:${string}` }> {
  const ref = input.ref ?? `authority/launch-policies/${input.policyId}.json`;
  await mkdir(join(input.ctx.mainRoot, dirname(ref)), { recursive: true });
  await writeFile(join(input.ctx.mainRoot, ref), input.policyBytes, 'utf8');
  if (input.extraPath !== undefined) {
    await mkdir(dirname(join(input.ctx.mainRoot, input.extraPath.path)), { recursive: true });
    await writeFile(join(input.ctx.mainRoot, input.extraPath.path), input.extraPath.body, 'utf8');
  }
  git(input.ctx.mainRoot, ['add', '.']);
  git(input.ctx.mainRoot, ['commit', '-m', `register ${input.policyId}`]);
  return { head: git(input.ctx.mainRoot, ['rev-parse', 'HEAD']), ref, digest: sha256(input.policyBytes) };
}

export async function registerPolicy(input: {
  readonly ctx: PolicyCtx;
  readonly artifactId: string;
  readonly ref: string;
  readonly digest: `sha256:${string}`;
  readonly head: string;
  readonly idempotencyKey: string;
  readonly sourceType?: 'mission' | 'master-plan' | 'task';
  readonly sourceScope?: 'repository' | 'run-main';
}): Promise<Awaited<ReturnType<CoordinatorClient['mutate']>>> {
  const status = await input.ctx.client.query('status', input.ctx.repoId, input.ctx.runId);
  const runVersion = (status.payload['runs'] as Array<Record<string, unknown>>)[0]?.['version'] as number;
  return input.ctx.client.mutate('register-authoritative-artifact', {
    repoId: input.ctx.repoId, workstreamRun: input.ctx.runId, sessionId: input.ctx.sessionId,
    fencingGeneration: 1, expectedVersion: runVersion, idempotencyKey: input.idempotencyKey,
  }, {
    artifact_id: input.artifactId, source_type: input.sourceType ?? 'task', source_scope: input.sourceScope ?? 'run-main',
    document_schema_version: 'autopilot.launch_policy.v1', git_commit: input.head, ref: input.ref, sha256: input.digest,
    session_lease_id: input.ctx.sessionLeaseId, session_token: input.ctx.sessionToken,
  });
}
