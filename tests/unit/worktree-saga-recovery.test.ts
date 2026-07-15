import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationRun, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { CoordinationRuntimeError, formatCoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { DurableRunSupervisorClient, writeCoordinatorSessionContext, type CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { executeOwnedWorktreeSaga, OwnedWorktreeSagaClient, recoverOwnedWorktreeSagas, WORKTREE_SAGA_BOUNDARIES } from '../../src/core/coordination/worktree-saga.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { AUTOPILOT_STATE_ROOT_ENV, BRANCHES_FILE, MATERIALIZED_PATHS_FILE, UNIT_INDEX_FILE, UNIT_INFO_FILE, WORKTREE_LEDGER_FILE, prepareAutopilotWorkstream, readUnitIndex, recoverAutopilotWorktreeSagas, resolveRepoIdentity, type ActiveAutopilotRow, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

interface Harness {
  readonly root: string;
  readonly stateRoot: string;
  readonly repo: string;
  readonly env: ProcessEnvLike;
  readonly active: ActiveAutopilotRow;
  readonly session: CoordinatorSessionContext;
  readonly server: Awaited<ReturnType<typeof startCoordinatorServer>>;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitInput(cwd: string, args: readonly string[], input: string): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', input });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function setup(suffix = 'a', testHooks?: Parameters<typeof startCoordinatorServer>[3]): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `pi-autopilot-saga-${suffix}-`));
  const stateRoot = join(root, 'state');
  const repo = join(root, 'generic-repository');
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'docs'), { recursive: true });
  await writeFile(join(repo, 'src', 'base.ts'), 'export const base = true;\n', 'utf8');
  await writeFile(join(repo, 'docs', 'context.md'), '# Context\n', 'utf8');
  await writeFile(join(repo, 'docs', 'pointer.bin'), 'version https://git-lfs.github.com/spec/v1\noid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsize 42\n', 'utf8');
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'autopilot@example.invalid']);
  git(repo, ['config', 'user.name', 'Autopilot Test']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'baseline']);
  const repoId = `repo-${suffix}`;
  const runId = `run-${suffix}`;
  const workstream = `work-${suffix}`;
  const autopilotId = `autopilot-${suffix}`;
  const taskRoot = join(stateRoot, 'worktrees', repoId, 'active', runId);
  const mainPath = join(taskRoot, 'main');
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const server = await startCoordinatorServer(coordinatorRuntimePaths(env), undefined, undefined, testHooks);
  const client = new CoordinatorClient({ env, autoStart: false });
  const runResponse = await client.mutate('attach-run', {
    repoId, workstreamRun: runId, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `attach-${runId}`,
  }, {
    repo_key: repoId, canonical_root: repo, git_common_dir: join(repo, '.git'), autopilot_id: autopilotId, workstream, coordination_authority: 'coordinator-edit-leases-v1',
    run_resource: {
      schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: runId,
      source_repo: repo, git_common_dir: join(repo, '.git'), worktree_root: join(stateRoot, 'worktrees', repoId), main_worktree_path: mainPath,
      runtime_root: join(mainPath, '.pi', 'autopilot', workstream), branch: `autopilot/${runId}`, target_branch: 'master', target_base_sha: git(repo, ['rev-parse', 'HEAD']), origin_url: null,
      started_at: '2026-07-11T00:00:00.000Z', version: 1,
    },
  });
  const run = parseCoordinationRun(runResponse.payload['run']);
  const token = suffix.charCodeAt(0).toString(16).slice(-1).repeat(64);
  const sessionResponse = await client.mutate('attach-session', {
    repoId, workstreamRun: runId, sessionId: `session-${suffix}`, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: `session-${runId}`,
  }, { session_lease_id: `lease-${suffix}`, session_token: token, pid: process.pid, boot_id: `boot-${suffix}`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });
  const attachedRun = parseCoordinationRun(sessionResponse.payload['run']);
  const lease = parseCoordinationSessionLease(sessionResponse.payload['session']);
  const session: CoordinatorSessionContext = {
    schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: repoId, repo_key: repoId,
    autopilot_id: autopilotId, workstream, workstream_run: runId, session_id: lease.session_id,
    session_generation: lease.session_generation, run_version: attachedRun.version, session_lease_id: lease.session_lease_id,
    session_token: token, session_version: lease.version, pid: lease.pid, boot_id: lease.boot_id,
  };
  const contextPath = join(stateRoot, 'test-session.json');
  await writeCoordinatorSessionContext(contextPath, session);
  const active: ActiveAutopilotRow = {
    schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1', autopilot_id: autopilotId, workstream, workstream_run: runId, repo_key: repoId,
    source_repo: repo, git_common_dir: join(repo, '.git'), worktree_root: join(stateRoot, 'worktrees', repoId), main_worktree_path: mainPath,
    branch: `autopilot/${runId}`, runtime_root: join(mainPath, '.pi', 'autopilot', workstream), target_branch: 'master',
    target_base_sha: git(repo, ['rev-parse', 'HEAD']), origin_url: null, pid: process.pid, boot_id: `boot-${suffix}`, status: 'active',
    started_at: '2026-07-11T00:00:00.000Z', active_run_epoch: 1, active_epoch_started_at: '2026-07-11T00:00:00.000Z', active_run_receipt_id: `receipt-${suffix}`,
  };
  return { root, stateRoot, repo, env: { ...env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: contextPath }, active, session, server };
}

async function close(value: Harness): Promise<void> {
  await value.server.close();
  await rm(value.root, { recursive: true, force: true });
}

function unitCreateSpec(value: Harness, unit = 'unit-a') {
  const worktreePath = join(value.stateRoot, 'worktrees', value.active.repo_key, 'active', value.active.workstream_run, 'units', unit, 'attempt-1', 'worktree');
  const branch = `autopilot/unit/${value.active.workstream_run}/${unit}/attempt-1`;
  return {
    active: value.active, unitId: unit, attempt: 1, kind: 'unit' as const, operationType: 'create' as const,
    operationKey: `create-${unit}`, initialWorktreeState: 'planned' as const, committedWorktreeState: 'active' as const,
    intent: {
      repo_root: value.repo, worktree_path: worktreePath, git_common_dir: join(value.repo, '.git'), branch,
      reason: `create ${unit}`, base_sha: value.active.target_base_sha, target_sha: null, archive_ref: null,
      checkout_mode: 'full' as const, sparse_patterns: [], paths: [], metadata_refs: [],
    },
  };
}

void describe('owner-scoped worktree and Git saga recovery', () => {
  void it('recovers prepared and post-action create crash boundaries idempotently', async () => {
    const value = await setup('a');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const spec = unitCreateSpec(value);
      const prepared = await saga.prepare(spec);
      assert.equal(prepared.operation.stage, 'prepared');
      const recoveredPrepared = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recoveredPrepared.length, 1);
      assert.equal(recoveredPrepared[0]?.stage, 'committed');
      assert.equal(existsSync(spec.intent.worktree_path), true);
      assert.equal(git(spec.intent.worktree_path, ['rev-parse', '--abbrev-ref', 'HEAD']), spec.intent.branch);

      const unitB = unitCreateSpec(value, 'unit-b');
      await saga.prepare(unitB);
      await mkdir(join(unitB.intent.worktree_path, '..'), { recursive: true });
      git(value.repo, ['worktree', 'add', '-b', unitB.intent.branch, unitB.intent.worktree_path, unitB.intent.base_sha ?? 'HEAD']);
      const recoveredPostAction = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recoveredPostAction.some((entry) => entry.operation_type === 'create' && entry.owner.unit_id === 'unit-b' && entry.stage === 'committed'), true);
      assert.equal(git(unitB.intent.worktree_path, ['rev-parse', 'HEAD']), value.active.target_base_sha);

      const unitC = unitCreateSpec(value, 'unit-c');
      await saga.prepare(unitC);
      git(value.repo, ['branch', unitC.intent.branch, value.active.target_base_sha]);
      const recoveredBranchOnly = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recoveredBranchOnly.some((entry) => entry.owner.unit_id === 'unit-c' && entry.stage === 'committed'), true);
      assert.equal(existsSync(unitC.intent.worktree_path), true);
      const intendedTerminal = git(unitC.intent.worktree_path, ['rev-parse', 'HEAD']);
      const removeMovedBranch = { ...unitC, operationType: 'remove' as const, operationKey: 'remove-moved-branch', initialWorktreeState: 'active' as const, committedWorktreeState: 'removed' as const, intent: { ...unitC.intent, reason: 'branch movement fence witness', target_sha: intendedTerminal } };
      await saga.prepare(removeMovedBranch);
      await writeFile(join(unitC.intent.worktree_path, 'src', 'late.ts'), 'late change\n', 'utf8');
      git(unitC.intent.worktree_path, ['add', 'src/late.ts']);
      git(unitC.intent.worktree_path, ['commit', '-m', 'foreign late branch movement']);
      const movedHead = git(unitC.intent.worktree_path, ['rev-parse', 'HEAD']);
      await assert.rejects(
        () => recoverOwnedWorktreeSagas({ active: value.active, env: value.env }),
        (error: unknown) => error instanceof CoordinationRuntimeError
          && error.code === 'recovery-required'
          && error.evidence.includes(`cause_evidence[0]=branch_expected=${intendedTerminal}`)
          && error.evidence.includes(`cause_evidence[1]=branch_actual=${movedHead}`),
      );
      assert.equal(existsSync(unitC.intent.worktree_path), true);
    } finally {
      await close(value);
    }
  });

  void it('preserves bounded typed preflight and reconciling evidence without executing an unsafe action', async () => {
    let rejectReconcilingReport = true;
    const value = await setup('x', {
      afterStoreCommitBeforeResponse: (action) => {
        if (rejectReconcilingReport && action === 'transition-operation') {
          rejectReconcilingReport = false;
          throw new CoordinationRuntimeError('coordinator-unavailable', 'synthetic durable report response loss', ['transition_marker=reconciling-committed']);
        }
      },
    });
    try {
      const spec = unitCreateSpec(value, 'unit-unsafe-probe');
      let actionCount = 0;
      const unsafeProof = ['expected_branch=autopilot/unit/run-preflight-recovery/unit-unsafe-probe/attempt-1', 'actual_branch=foreign/unit-unsafe-probe', 'session_token=synthetic-secret-must-not-escape', ...Array.from({ length: 40 }, (_, index) => `probe_detail_${String(index).padStart(2, '0')}=${'x'.repeat(300)}`)];
      let observed: CoordinationRuntimeError | null = null;
      try {
        await executeOwnedWorktreeSaga(spec, {
          inspect: () => ({ outcome: 'unsafe', proof: unsafeProof }),
          action: () => { actionCount += 1; },
          verify: () => { throw new Error('verification must not run after an unsafe probe'); },
        }, value.env);
      } catch (error) {
        if (!(error instanceof CoordinationRuntimeError)) throw error;
        observed = error;
      }
      if (observed === null) throw new Error('unsafe preflight did not fail');
      assert.equal(observed.code, 'recovery-required');
      assert.equal(actionCount, 0);
      assert.equal(observed.evidence.includes('cause_code=recovery-required'), true);
      assert.equal(observed.evidence.includes('cause_evidence[0]=expected_branch=autopilot/unit/run-preflight-recovery/unit-unsafe-probe/attempt-1'), true);
      assert.equal(observed.evidence.includes('cause_evidence[1]=actual_branch=foreign/unit-unsafe-probe'), true);
      assert.equal(observed.evidence.includes('cause_evidence[2]=session_token=<redacted>'), true);
      assert.equal(observed.evidence.some((entry) => entry.includes('synthetic-secret-must-not-escape')), false);
      const visibleDiagnostic = formatCoordinationRuntimeError(observed);
      assert.match(visibleDiagnostic, /cause_evidence\[0\]=expected_branch=autopilot\/unit\/run-preflight-recovery\/unit-unsafe-probe\/attempt-1/u);
      assert.equal(/synthetic-secret-must-not-escape/u.test(visibleDiagnostic), false);
      assert.equal(observed.evidence.includes('reconciliation_code=coordinator-unavailable'), true);
      assert.equal(observed.evidence.includes('reconciliation_evidence[0]=failure_class=retryable-contention'), true);
      assert.equal(observed.evidence.includes('reconciliation_evidence[1]=server_evidence[0]=transition_marker=reconciling-committed'), true);
      assert.equal(observed.evidence.some((entry) => entry.includes('truncated')), true);
      assert.equal(observed.evidence.length <= 32, true);
      assert.equal(observed.evidence.every((entry) => [...entry].length <= 256), true);

      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const operation = (await saga.operations()).find((candidate) => candidate.owner.unit_id === 'unit-unsafe-probe');
      assert.equal(operation?.stage, 'reconciling');
      const status = await new CoordinatorClient({ env: value.env, autoStart: false }).query('status', value.active.repo_key, value.active.workstream_run);
      const sessions = status.payload['session_leases'];
      assert.equal(Array.isArray(sessions) && sessions.some((entry) => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['session_lease_id'] === value.session.session_lease_id && (entry as Record<string, unknown>)['status'] === 'attached'), true);

      let replayed: CoordinationRuntimeError | null = null;
      try {
        await executeOwnedWorktreeSaga(spec, {
          inspect: () => ({ outcome: 'unsafe', proof: unsafeProof }),
          action: () => { actionCount += 1; },
          verify: () => { throw new Error('verification must not run after an unsafe replay probe'); },
        }, value.env);
      } catch (error) {
        if (!(error instanceof CoordinationRuntimeError)) throw error;
        replayed = error;
      }
      if (replayed === null) throw new Error('unsafe replay preflight did not fail');
      assert.equal(replayed.code, 'recovery-required');
      assert.deepEqual(replayed.evidence.filter((entry) => entry.startsWith('cause_evidence[')).slice(0, 3), observed.evidence.filter((entry) => entry.startsWith('cause_evidence[')).slice(0, 3));
      assert.equal(actionCount, 0);
      assert.equal((await saga.operations()).find((candidate) => candidate.owner.unit_id === 'unit-unsafe-probe')?.stage, 'reconciling');
    } finally {
      await close(value);
    }
  });

  void it('commits an already-applied exact effect without repeating the external action', async () => {
    const value = await setup('y');
    try {
      const spec = unitCreateSpec(value, 'unit-applied-effect');
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      await saga.prepare(spec);
      git(value.repo, ['worktree', 'add', '-b', spec.intent.branch, spec.intent.worktree_path, spec.intent.base_sha ?? 'HEAD']);
      let actionCount = 0;
      const result = await executeOwnedWorktreeSaga(spec, {
        inspect: () => ({ outcome: 'satisfied', proof: ['worktree_registered', `head=${git(spec.intent.worktree_path, ['rev-parse', 'HEAD'])}`] }),
        action: () => { actionCount += 1; },
        verify: () => ['worktree_registered', `head=${git(spec.intent.worktree_path, ['rev-parse', 'HEAD'])}`],
      }, value.env);
      assert.equal(actionCount, 0);
      assert.equal(result.operation?.stage, 'committed');
    } finally {
      await close(value);
    }
  });

  void it('finishes an exact pre-spend rollback projection after remove response loss without touching another live child', async () => {
    const value = await setup('z');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const create = unitCreateSpec(value, 'unit-pre-spend-failure');
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const taskRoot = dirname(dirname(dirname(dirname(create.intent.worktree_path))));
      const attemptRoot = dirname(create.intent.worktree_path);
      const branchInfo = {
        unit_id: 'unit-pre-spend-failure', attempt: 1, branch: create.intent.branch, worktree_path: create.intent.worktree_path,
        base_sha: value.active.target_base_sha, current_sha: value.active.target_base_sha, archive_ref: null, status: 'active' as const,
      };
      await writeFile(join(attemptRoot, UNIT_INFO_FILE), `${JSON.stringify({
        schema_version: 'autopilot.unit_info.v1', workstream: value.active.workstream, workstream_run: value.active.workstream_run,
        autopilot_id: value.active.autopilot_id, ...branchInfo, runtime_root: value.active.runtime_root,
        created_at: value.active.started_at, checkout_mode: 'full', checkout_profile_ref: '_checkout-profile.json', materialized_paths_ref: MATERIALIZED_PATHS_FILE,
      }, null, 2)}\n`, 'utf8');
      await writeFile(join(attemptRoot, MATERIALIZED_PATHS_FILE), '{}\n', 'utf8');
      await writeFile(join(taskRoot, UNIT_INDEX_FILE), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [branchInfo] }, null, 2)}\n`, 'utf8');
      await writeFile(join(taskRoot, BRANCHES_FILE), `${JSON.stringify({ schema_version: 'autopilot.branches.v1', active_branch: value.active.branch, base_sha: value.active.target_base_sha, current_sha: value.active.target_base_sha, archive_ref: null, unit_branches: [branchInfo] }, null, 2)}\n`, 'utf8');

      const coordinator = new CoordinatorClient({ env: value.env, autoStart: false });
      await coordinator.mutate('register-attempt', {
        repoId: value.session.repo_id, workstreamRun: value.session.workstream_run, sessionId: value.session.session_id,
        fencingGeneration: value.session.session_generation, expectedVersion: value.session.run_version, idempotencyKey: 'register-unrelated-strategy-attempt',
      }, {
        unit_id: 'strategy-read-only', attempt: 1, spec_ref: 'unit-specs/strategy-read-only.json', spec_sha256: `sha256:${'a'.repeat(64)}`,
        role: 'strategy', preemptible: true, checkpoint_ordinal: 0, session_lease_id: value.session.session_lease_id, session_token: value.session.session_token,
      });
      await coordinator.mutate('register-child', {
        repoId: value.session.repo_id, workstreamRun: value.session.workstream_run, sessionId: value.session.session_id,
        fencingGeneration: value.session.session_generation, expectedVersion: value.session.run_version, idempotencyKey: 'register-unrelated-strategy-child',
      }, {
        child_lease_id: 'child-run-z-strategy-read-only-1', autopilot_id: value.active.autopilot_id, unit_id: 'strategy-read-only', attempt: 1,
        pid: process.pid, boot_id: 'strategy-child-boot', child_token: 'e'.repeat(64), session_lease_id: value.session.session_lease_id,
        session_token: value.session.session_token, lease_expires_at: '2099-01-01T00:00:00.000Z',
      });

      const remove = {
        ...create, operationType: 'remove' as const, operationKey: 'pre-spend-rollback-response-loss', initialWorktreeState: 'active' as const, committedWorktreeState: 'removed' as const,
        intent: { ...create.intent, reason: 'autopilot-agent-run preflight rollback after failure: synthetic pre-spend rejection', target_sha: value.active.target_base_sha, checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [WORKTREE_LEDGER_FILE] },
      };
      await saga.prepare(remove);
      git(value.repo, ['worktree', 'remove', create.intent.worktree_path]);
      git(value.repo, ['branch', '-D', create.intent.branch]);

      const recovered = await recoverAutopilotWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recovered.some((operation) => operation.operation_type === 'remove' && operation.owner.unit_id === 'unit-pre-spend-failure' && operation.stage === 'committed'), true);
      assert.equal((await readUnitIndex(taskRoot)).units.some((unit) => unit.unit_id === 'unit-pre-spend-failure' && unit.attempt === 1), false);
      const branches = JSON.parse(await readFile(join(taskRoot, BRANCHES_FILE), 'utf8')) as Readonly<Record<string, unknown>>;
      assert.equal(Array.isArray(branches['unit_branches']) && branches['unit_branches'].length, 0);
      assert.equal(existsSync(attemptRoot), false);
      const replayed = await recoverAutopilotWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(replayed.some((operation) => operation.owner.unit_id === 'unit-pre-spend-failure' && operation.stage !== 'committed'), false);
      assert.equal((await readUnitIndex(taskRoot)).units.some((unit) => unit.unit_id === 'unit-pre-spend-failure'), false);
      const status = await coordinator.query('status', value.active.repo_key, value.active.workstream_run);
      const children = status.payload['child_leases'];
      assert.equal(Array.isArray(children) && children.some((entry) => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['child_lease_id'] === 'child-run-z-strategy-read-only-1' && (entry as Record<string, unknown>)['status'] === 'running'), true);
    } finally {
      await close(value);
    }
  });

  void it('transactionally retires an exact schema-12 duplicate projection while preserving history', async () => {
    const value = await setup('d');
    let restarted: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const create = unitCreateSpec(value, 'unit-duplicate');
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const before = await saga.worktrees();
      const canonical = before.find((entry) => entry.owner.unit_id === 'unit-duplicate');
      if (canonical === undefined) throw new Error('canonical unit worktree is missing');
      await value.server.close();
      const database = new DatabaseSync(coordinatorRuntimePaths(value.env).databasePath);
      try {
        const duplicate = { ...canonical, worktree_id: 'migration-worktree-schema12-duplicate' };
        database.prepare('INSERT INTO worktrees(entity_id, repo_id, workstream_run, payload_json, version) VALUES(?, ?, ?, ?, ?)').run(duplicate.worktree_id, duplicate.owner.repo_id, duplicate.owner.workstream_run, JSON.stringify(duplicate), duplicate.version);
      } finally { database.close(); }
      restarted = await startCoordinatorServer(coordinatorRuntimePaths(value.env));
      const client = new CoordinatorClient({ env: value.env, autoStart: false });
      const doctorBefore = await client.query('doctor');
      const findings = doctorBefore.payload['invariant_findings'];
      assert.equal(Array.isArray(findings) && findings.some((finding) => typeof finding === 'object' && finding !== null && (finding as Record<string, unknown>)['code'] === 'duplicate-active-worktree-authority'), true);

      const next = { ...create, operationType: 'materialize' as const, operationKey: 'dedup-consumer', initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const, intent: { ...create.intent, base_sha: null, sparse_patterns: ['/src/base.ts'], paths: ['src/base.ts'] } };
      await saga.prepare(next);
      const status = await client.query('status', value.active.repo_key, value.active.workstream_run);
      const worktrees = status.payload['worktrees'];
      const operations = status.payload['worktree_operations'];
      assert.equal(Array.isArray(worktrees), true);
      assert.equal((worktrees as readonly Record<string, unknown>[]).filter((entry) => entry['owner'] !== null && typeof entry['owner'] === 'object' && (entry['owner'] as Record<string, unknown>)['unit_id'] === 'unit-duplicate' && entry['state'] !== 'removed').length, 1);
      assert.equal((worktrees as readonly Record<string, unknown>[]).find((entry) => entry['worktree_id'] === 'migration-worktree-schema12-duplicate')?.['state'], 'removed');
      assert.equal(Array.isArray(operations) && operations.length, 2);
      const doctorAfter = await client.query('doctor');
      const afterFindings = doctorAfter.payload['invariant_findings'];
      assert.equal(Array.isArray(afterFindings) && afterFindings.some((finding) => typeof finding === 'object' && finding !== null && (finding as Record<string, unknown>)['code'] === 'duplicate-active-worktree-authority'), false);
    } finally {
      if (restarted !== null) await restarted.close();
      await rm(value.root, { recursive: true, force: true });
    }
  });

  void it('serializes concurrent stale-lock reclaimers before the external effect', async () => {
    const value = await setup('o');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const create = unitCreateSpec(value, 'unit-stale-lock');
      const prepared = await saga.prepare(create);
      const lockRoot = join(value.stateRoot, 'worktrees', value.active.repo_key, '.locks');
      await mkdir(lockRoot, { recursive: true });
      await writeFile(join(lockRoot, `${prepared.worktree.worktree_id}.saga.lock`), `${JSON.stringify({ schema_version: 'autopilot.saga_execution_lock.v1', pid: 99999999, boot_id: 'foreign-dead-boot', token: 'dead-token' })}\n`, 'utf8');
      const [left, right] = await Promise.all([
        recoverOwnedWorktreeSagas({ active: value.active, env: value.env }),
        recoverOwnedWorktreeSagas({ active: value.active, env: value.env }),
      ]);
      assert.equal([...left, ...right].some((operation) => operation.owner.unit_id === 'unit-stale-lock' && operation.stage === 'committed'), true);
      assert.equal(git(value.repo, ['branch', '--list', create.intent.branch]).split('\n').filter((line) => line.includes(create.intent.branch)).length, 1);
      assert.equal(existsSync(create.intent.worktree_path), true);
    } finally {
      await close(value);
    }
  });

  void it('autonomously finishes real unit-create metadata after a partial Git effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-unit-create-metadata-'));
    const stateRoot = join(root, 'state');
    const source = join(root, 'source');
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    let server: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      await mkdir(join(source, 'src'), { recursive: true });
      await writeFile(join(source, 'src', 'base.ts'), 'export const base = true;\n', 'utf8');
      git(source, ['init']);
      git(source, ['config', 'user.email', 'autopilot@example.invalid']);
      git(source, ['config', 'user.name', 'Autopilot Test']);
      git(source, ['add', '.']);
      git(source, ['commit', '-m', 'baseline']);
      const prepared = await prepareAutopilotWorkstream({ workstream: 'metadata-recovery', sourceCwd: source, env });
      server = await startCoordinatorServer(coordinatorRuntimePaths(env));
      const attachment = await new DurableRunSupervisorClient(env).attach({ repo: resolveRepoIdentity(source), active: prepared.active, rawSessionId: 'metadata-recovery-session' });
      const managedEnv = { ...env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
      const unitId = 'unit-metadata';
      const attempt = 1;
      const unitPath = join(prepared.taskRoot, 'units', unitId, 'attempt-1', 'worktree');
      const branch = `autopilot/unit/${prepared.active.workstream_run}/${unitId}/attempt-1`;
      const ownerSaga = await OwnedWorktreeSagaClient.fromEnvironment(managedEnv);
      await ownerSaga.prepare({
        active: prepared.active, unitId, attempt, kind: 'unit', operationType: 'create', operationKey: 'real-unit-metadata-crash', initialWorktreeState: 'planned', committedWorktreeState: 'active',
        intent: { repo_root: prepared.active.source_repo, worktree_path: unitPath, git_common_dir: prepared.active.git_common_dir, branch, reason: 'real partial unit create metadata witness', base_sha: prepared.active.target_base_sha, target_sha: null, archive_ref: null, checkout_mode: 'claim-minimal', sparse_patterns: ['/src/base.ts'], paths: ['src/future.ts'], metadata_refs: [`units/${unitId}/attempt-1/_unit-info.json`, '_unit-index.json', '_branches.json'] },
      });
      await mkdir(join(unitPath, '..'), { recursive: true });
      git(source, ['worktree', 'add', '--no-checkout', '-b', branch, unitPath, prepared.active.target_base_sha]);
      const recovered = await recoverAutopilotWorktreeSagas({ active: prepared.active, env: managedEnv });
      assert.equal(recovered.some((operation) => operation.owner.unit_id === unitId && operation.stage === 'committed'), true);
      assert.equal(existsSync(join(prepared.taskRoot, 'units', unitId, 'attempt-1', '_unit-info.json')), true);
      assert.equal(existsSync(join(prepared.taskRoot, '_unit-index.json')), true);
      assert.equal(existsSync(join(prepared.taskRoot, '_branches.json')), true);
      assert.equal(existsSync(join(unitPath, 'src')), true);
      assert.equal(git(unitPath, ['config', '--bool', 'core.sparseCheckout']), 'true');
    } finally {
      if (server !== null) await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('retains recoverable intent across simulated ENOSPC and permission failures', async () => {
    const value = await setup('p');
    try {
      const create = unitCreateSpec(value, 'unit-io-failure');
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      for (const code of ['ENOSPC', 'EACCES', 'EEXIST'] as const) {
        const marker = join(create.intent.worktree_path, 'src', `${code.toLowerCase()}.ts`);
        const operation = { ...create, operationType: 'materialize' as const, operationKey: `io-${code}`, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const, intent: { ...create.intent, reason: `${code} recovery witness`, base_sha: null, sparse_patterns: [`/src/${code.toLowerCase()}.ts`], paths: [`src/${code.toLowerCase()}.ts`] } };
        let failOnce = true;
        const callbacks = {
          inspect: () => existsSync(marker) ? { outcome: 'satisfied' as const, proof: [`marker=${marker}`] } : { outcome: 'not-applied' as const, proof: [`missing=${marker}`] },
          action: async () => { if (failOnce) { failOnce = false; throw Object.assign(new Error(`simulated ${code}`), { code }); } await writeFile(marker, `${code}\n`, 'utf8'); },
          verify: () => { assert.equal(existsSync(marker), true); return [`verified=${marker}`]; },
        };
        await assert.rejects(() => executeOwnedWorktreeSaga(operation, callbacks, value.env), new RegExp(`simulated ${code}`, 'u'));
        assert.equal((await saga.operations()).find((entry) => entry.intent.reason === `${code} recovery witness`)?.error_code, code);
        const recovered = await executeOwnedWorktreeSaga(operation, callbacks, value.env);
        assert.equal(recovered.operation?.stage, 'committed');
      }
    } finally {
      await close(value);
    }
  });

  void it('recovers every durable orchestration boundary without duplicating its external effect', async () => {
    const value = await setup('b');
    try {
      const create = unitCreateSpec(value, 'unit-boundaries');
      await new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session).prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      for (const [index, boundary] of WORKTREE_SAGA_BOUNDARIES.entries()) {
        const relativeMarker = `src/boundary-${String(index)}.ts`;
        const marker = join(create.intent.worktree_path, relativeMarker);
        let effectCount = 0;
        let injected = false;
        const spec = {
          ...create, operationType: 'materialize' as const, operationKey: `boundary-${boundary}`, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
          intent: { ...create.intent, reason: `fault-injection witness at ${boundary}`, base_sha: null, checkout_mode: 'full' as const, sparse_patterns: [`/${relativeMarker}`], paths: [relativeMarker] },
        };
        const callbacks = {
          inspect: () => existsSync(marker) ? { outcome: 'satisfied' as const, proof: [`marker=${relativeMarker}`] } : { outcome: 'not-applied' as const, proof: [`missing=${relativeMarker}`] },
          action: async () => { effectCount += 1; await writeFile(marker, `export const boundary = ${String(index)};\n`, 'utf8'); },
          verify: () => { assert.equal(existsSync(marker), true); return [`verified=${relativeMarker}`]; },
          observeBoundary: (current: typeof boundary) => { if (!injected && current === boundary) { injected = true; throw new Error(`injected boundary ${boundary}`); } },
        };
        const expectedPhase = boundary === 'after-prepare' ? 'prepared'
          : boundary === 'before-probe' || boundary === 'after-probe' ? 'preflight-probe'
            : boundary === 'after-start' ? 'start-report'
              : boundary === 'before-action' || boundary === 'after-action' ? 'external-action'
                : boundary === 'after-action-report' ? 'action-report'
                  : boundary === 'before-verification' || boundary === 'after-verification' ? 'postcondition-verification'
                    : boundary === 'after-evidence' ? 'evidence-write'
                      : boundary === 'after-verified-commit' ? 'verified-report'
                        : 'commit-report';
        await assert.rejects(() => executeOwnedWorktreeSaga(spec, callbacks, value.env), (error: unknown) => error instanceof CoordinationRuntimeError && error.message.includes(`injected boundary ${boundary}`) && error.evidence.includes(`phase=${expectedPhase}`));
        const recovered = await executeOwnedWorktreeSaga(spec, { inspect: callbacks.inspect, action: callbacks.action, verify: callbacks.verify }, value.env);
        assert.equal(recovered.operation?.stage, 'committed');
        assert.equal(effectCount <= 1, true, `${boundary} repeated its external effect`);
      }
    } finally {
      await close(value);
    }
  });

  void it('replays materialize, commit, quarantine, archive, and remove effects without duplication', async () => {
    const value = await setup('g');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const full = unitCreateSpec(value, 'unit-g');
      const create = { ...full, intent: { ...full.intent, checkout_mode: 'claim-minimal' as const, sparse_patterns: ['/src/base.ts'] } };
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(existsSync(join(create.intent.worktree_path, 'src', 'base.ts')), true);
      assert.equal(existsSync(join(create.intent.worktree_path, 'docs', 'context.md')), false);

      const materialize = {
        ...create, operationType: 'materialize' as const, operationKey: 'materialize-docs', initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
        intent: { ...create.intent, reason: 'materialize docs context', base_sha: null, checkout_mode: 'claim-minimal' as const, sparse_patterns: ['/docs/context.md'], paths: ['docs/context.md'] },
      };
      await saga.prepare(materialize);
      gitInput(create.intent.worktree_path, ['sparse-checkout', 'add', '--skip-checks', '--stdin'], '/docs/context.md\n');
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(existsSync(join(create.intent.worktree_path, 'docs', 'context.md')), true);

      const commitBase = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      await writeFile(join(create.intent.worktree_path, 'src', 'change.ts'), 'export const changed = true;\n', 'utf8');
      const commit = {
        ...create, operationType: 'commit' as const, operationKey: 'commit-change', initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
        intent: { ...create.intent, reason: 'commit exact change', base_sha: commitBase, target_sha: null, checkout_mode: null, sparse_patterns: [], paths: ['src/change.ts'] },
      };
      await saga.prepare(commit);
      git(create.intent.worktree_path, ['add', '--sparse', 'src/change.ts']);
      git(create.intent.worktree_path, ['commit', '-m', 'simulated response-loss commit']);
      const committedHead = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(git(create.intent.worktree_path, ['rev-list', '--count', `${commitBase}..HEAD`]), '1');

      const mainCreate = {
        active: value.active, unitId: 'main', attempt: 1, kind: 'main' as const, operationType: 'create' as const,
        operationKey: 'create-main', initialWorktreeState: 'planned' as const, committedWorktreeState: 'active' as const,
        intent: {
          repo_root: value.repo, worktree_path: value.active.main_worktree_path, git_common_dir: join(value.repo, '.git'), branch: value.active.branch,
          reason: 'create integration main', base_sha: value.active.target_base_sha, target_sha: null, archive_ref: null,
          checkout_mode: 'full' as const, sparse_patterns: [], paths: [], metadata_refs: [],
        },
      };
      await saga.prepare(mainCreate);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const integrationBefore = git(value.active.main_worktree_path, ['rev-parse', 'HEAD']);
      const merge = {
        ...mainCreate, operationType: 'merge' as const, operationKey: 'merge-unit-g', initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
        intent: { ...mainCreate.intent, reason: 'merge committed unit', base_sha: integrationBefore, target_sha: committedHead, checkout_mode: null, paths: ['src/change.ts'] },
      };
      await saga.prepare(merge);
      git(value.active.main_worktree_path, ['merge', '--no-ff', '--no-edit', '-m', 'simulated response-loss merge', committedHead]);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      git(value.active.main_worktree_path, ['merge-base', '--is-ancestor', committedHead, 'HEAD']);
      assert.equal(git(value.active.main_worktree_path, ['rev-list', '--merges', '--count', `${integrationBefore}..HEAD`]), '1');
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(git(value.active.main_worktree_path, ['rev-list', '--merges', '--count', `${integrationBefore}..HEAD`]), '1');

      await writeFile(join(create.intent.worktree_path, 'src', 'quarantine.ts'), 'preserve me\n', 'utf8');
      const quarantine = {
        ...create, operationType: 'quarantine' as const, operationKey: 'quarantine-dirty', initialWorktreeState: 'active' as const, committedWorktreeState: 'quarantined' as const,
        intent: { ...create.intent, reason: 'capture dirty work', base_sha: committedHead, target_sha: null, checkout_mode: null, sparse_patterns: [], paths: ['src/quarantine.ts'] },
      };
      await saga.prepare(quarantine);
      git(create.intent.worktree_path, ['add', '--sparse', 'src/quarantine.ts']);
      git(create.intent.worktree_path, ['commit', '-m', 'simulated response-loss quarantine capture']);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const captureHead = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      assert.notEqual(captureHead, committedHead);
      assert.equal(git(create.intent.worktree_path, ['status', '--porcelain']), '');

      const reset = {
        ...create, operationType: 'reset' as const, operationKey: 'reset-after-capture', initialWorktreeState: 'quarantined' as const, committedWorktreeState: 'terminal' as const,
        intent: { ...create.intent, reason: 'verify exact captured reset boundary', base_sha: captureHead, target_sha: captureHead, checkout_mode: null, sparse_patterns: [], paths: [] },
      };
      await saga.prepare(reset);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(git(create.intent.worktree_path, ['rev-parse', 'HEAD']), captureHead);

      const archiveRef = `autopilot/archive/${value.active.workstream_run}/unit/unit-g/attempt-1/capture`;
      const archive = {
        ...create, operationType: 'archive' as const, operationKey: 'archive-capture', initialWorktreeState: 'quarantined' as const, committedWorktreeState: 'terminal' as const,
        intent: { ...create.intent, reason: 'archive quarantine capture', base_sha: committedHead, target_sha: captureHead, archive_ref: archiveRef, checkout_mode: null, sparse_patterns: [], paths: ['src/quarantine.ts'] },
      };
      await saga.prepare(archive);
      git(value.repo, ['update-ref', `refs/heads/${archiveRef}`, captureHead]);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(git(value.repo, ['rev-parse', `refs/heads/${archiveRef}`]), captureHead);

      const remove = {
        ...create, operationType: 'remove' as const, operationKey: 'remove-captured', initialWorktreeState: 'terminal' as const, committedWorktreeState: 'removed' as const,
        intent: { ...create.intent, reason: 'remove archived terminal worktree', base_sha: commitBase, target_sha: captureHead, archive_ref: archiveRef, checkout_mode: null, sparse_patterns: [], paths: [] },
      };
      await saga.prepare(remove);
      git(value.repo, ['worktree', 'remove', create.intent.worktree_path]);
      git(value.repo, ['branch', '-D', create.intent.branch]);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(existsSync(create.intent.worktree_path), false);
      assert.equal(git(value.repo, ['rev-parse', `refs/heads/${archiveRef}`]), captureHead);
    } finally {
      await close(value);
    }
  });

  void it('refuses to commit a recovered Git effect until its declared metadata artifact exists', async () => {
    const value = await setup('q');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const create = unitCreateSpec(value, 'unit-metadata-gate');
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const base = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      await writeFile(join(create.intent.worktree_path, 'src', 'gated.ts'), 'gated\n', 'utf8');
      const commit = { ...create, operationType: 'commit' as const, operationKey: 'metadata-gated-commit', initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const, intent: { ...create.intent, reason: 'metadata gate witness', base_sha: base, target_sha: null, checkout_mode: null, paths: ['src/gated.ts'], metadata_refs: ['execution-commits/gated.json'] } };
      await saga.prepare(commit);
      git(create.intent.worktree_path, ['add', 'src/gated.ts']);
      git(create.intent.worktree_path, ['commit', '-m', 'simulated response-loss gated commit']);
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: value.active, env: value.env }), /metadata postcondition|missing_metadata|partial-effect/u);
      assert.notEqual((await saga.operations()).find((operation) => operation.intent.reason === 'metadata gate witness')?.stage, 'committed');
      const taskRoot = dirname(dirname(dirname(dirname(create.intent.worktree_path))));
      await mkdir(join(taskRoot, 'execution-commits'), { recursive: true });
      await writeFile(join(taskRoot, 'execution-commits', 'gated.json'), '{}\n', 'utf8');
      const recovered = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recovered.some((operation) => operation.intent.reason === 'metadata gate witness' && operation.stage === 'committed'), true);
    } finally {
      await close(value);
    }
  });

  void it('recreates future-owned parents but refuses an unresolved LFS pointer during materialization recovery', async () => {
    const value = await setup('n');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const base = unitCreateSpec(value, 'unit-lfs');
      const create = { ...base, intent: { ...base.intent, checkout_mode: 'claim-minimal' as const, sparse_patterns: ['/src/base.ts'] } };
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      await saga.prepare({ ...create, operationType: 'materialize', operationKey: 'materialize-lfs', initialWorktreeState: 'active', committedWorktreeState: 'active', intent: { ...create.intent, reason: 'LFS recovery refusal witness', base_sha: null, sparse_patterns: ['/docs/pointer.bin', '/src/future/new.ts'], paths: ['docs/pointer.bin', 'src/future/new.ts'] } });
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: value.active, env: value.env }), /postcondition|lfs_pointer|recovery/u);
      assert.equal(existsSync(join(create.intent.worktree_path, 'src', 'future')), true);
      assert.equal(existsSync(join(create.intent.worktree_path, 'docs', 'pointer.bin')), true);
      assert.notEqual((await saga.operations()).find((operation) => operation.operation_type === 'materialize')?.stage, 'committed');
    } finally {
      await close(value);
    }
  });

  void it('refuses stale archive refs and unrelated path substitution without mutating either', async () => {
    const archiveHarness = await setup('h');
    try {
      const create = unitCreateSpec(archiveHarness, 'unit-archive-fence');
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: archiveHarness.env, autoStart: false }), archiveHarness.session);
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: archiveHarness.active, env: archiveHarness.env });
      await assert.rejects(() => saga.prepare({ ...create, operationType: 'materialize', operationKey: 'pathspec-magic-escape', initialWorktreeState: 'active', committedWorktreeState: 'active', intent: { ...create.intent, reason: 'Git pathspec magic rejection witness', base_sha: null, sparse_patterns: ['/src/base.ts'], paths: [':(top)foreign.ts'] } }), /pathspec magic|invalid-request/u);
      const staleSha = git(archiveHarness.repo, ['rev-parse', 'HEAD']);
      await writeFile(join(archiveHarness.repo, 'foreign.ts'), 'foreign\n', 'utf8');
      git(archiveHarness.repo, ['add', 'foreign.ts']);
      git(archiveHarness.repo, ['commit', '-m', 'foreign target movement']);
      const intendedSha = git(archiveHarness.repo, ['rev-parse', 'HEAD']);
      await assert.rejects(() => saga.prepare({ ...create, operationType: 'archive', operationKey: 'archive-namespace-escape', initialWorktreeState: 'active', committedWorktreeState: 'active', intent: { ...create.intent, reason: 'archive namespace escape witness', base_sha: staleSha, target_sha: intendedSha, archive_ref: git(archiveHarness.repo, ['rev-parse', '--abbrev-ref', 'HEAD']) } }), /run-owned namespace|unauthorized/u);
      const archiveRef = `autopilot/archive/${archiveHarness.active.workstream_run}/stale-proof`;
      git(archiveHarness.repo, ['update-ref', `refs/heads/${archiveRef}`, staleSha]);
      await saga.prepare({ ...create, operationType: 'archive', operationKey: 'archive-stale-ref', initialWorktreeState: 'active', committedWorktreeState: 'active', intent: { ...create.intent, reason: 'stale archive ref fence witness', base_sha: staleSha, target_sha: intendedSha, archive_ref: archiveRef } });
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: archiveHarness.active, env: archiveHarness.env }), /archive_expected|archive_actual|recovery/u);
      assert.equal(git(archiveHarness.repo, ['rev-parse', `refs/heads/${archiveRef}`]), staleSha);
    } finally {
      await close(archiveHarness);
    }

    const substitutionHarness = await setup('i');
    try {
      const substituted = unitCreateSpec(substitutionHarness, 'unit-substituted');
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: substitutionHarness.env, autoStart: false }), substitutionHarness.session);
      await saga.prepare(substituted);
      const substitutedAttemptRoot = join(substituted.intent.worktree_path, '..');
      const outside = join(substitutionHarness.root, 'foreign-directory');
      await mkdir(join(substitutedAttemptRoot, '..'), { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, substitutedAttemptRoot);
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: substitutionHarness.active, env: substitutionHarness.env }), /symlink substitution|path_present|git_registered|registered_branch_mismatch|recovery/u);
      assert.equal(existsSync(substitutedAttemptRoot), true);
      assert.equal(existsSync(join(outside, 'worktree')), false);
      assert.equal(git(substitutionHarness.repo, ['rev-parse', 'HEAD']), substitutionHarness.active.target_base_sha);
    } finally {
      await close(substitutionHarness);
    }
  });

  void it('safely compensates an interrupted conflicting merge at its exact pre-merge HEAD', async () => {
    const value = await setup('c');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const unit = unitCreateSpec(value, 'unit-conflict');
      await saga.prepare(unit);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      await writeFile(join(unit.intent.worktree_path, 'src', 'base.ts'), 'export const unit = true;\n', 'utf8');
      git(unit.intent.worktree_path, ['add', 'src/base.ts']);
      git(unit.intent.worktree_path, ['commit', '-m', 'unit conflicting change']);
      const sourceHead = git(unit.intent.worktree_path, ['rev-parse', 'HEAD']);
      const main = { ...unit, unitId: 'main', kind: 'main' as const, operationKey: 'main-conflict', intent: { ...unit.intent, worktree_path: value.active.main_worktree_path, branch: value.active.branch, reason: 'create conflict main' } };
      await saga.prepare(main);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      await writeFile(join(main.intent.worktree_path, 'src', 'base.ts'), 'export const main = true;\n', 'utf8');
      git(main.intent.worktree_path, ['add', 'src/base.ts']);
      git(main.intent.worktree_path, ['commit', '-m', 'main conflicting change']);
      const mainBase = git(main.intent.worktree_path, ['rev-parse', 'HEAD']);
      const merge = { ...main, operationType: 'merge' as const, operationKey: 'interrupted-conflict', initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const, intent: { ...main.intent, reason: 'interrupted conflict compensation witness', base_sha: mainBase, target_sha: sourceHead, checkout_mode: null, paths: ['src/base.ts'] } };
      await saga.prepare(merge);
      const conflicted = spawnSync('git', ['merge', '--no-ff', '--no-edit', sourceHead], { cwd: main.intent.worktree_path, encoding: 'utf8' });
      assert.notEqual(conflicted.status, 0);
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: value.active, env: value.env }), /restored to its exact pre-merge HEAD/u);
      assert.equal(git(main.intent.worktree_path, ['rev-parse', 'HEAD']), mainBase);
      assert.equal(git(main.intent.worktree_path, ['status', '--porcelain']), '');
      assert.equal((await saga.operations()).find((operation) => operation.operation_type === 'merge')?.stage, 'compensated');
    } finally {
      await close(value);
    }
  });

  void it('recovers final target fast-forward response loss across coordinator restart', async () => {
    const value = await setup('j');
    let replacement: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const mainCreate = {
        active: value.active, unitId: 'main', attempt: 1, kind: 'main' as const, operationType: 'create' as const,
        operationKey: 'main-create-close-recovery', initialWorktreeState: 'planned' as const, committedWorktreeState: 'active' as const,
        intent: { repo_root: value.repo, worktree_path: value.active.main_worktree_path, git_common_dir: join(value.repo, '.git'), branch: value.active.branch, reason: 'create close recovery main', base_sha: value.active.target_base_sha, target_sha: null, archive_ref: null, checkout_mode: 'full' as const, sparse_patterns: [], paths: [], metadata_refs: [] },
      };
      await saga.prepare(mainCreate);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      await writeFile(join(value.active.main_worktree_path, 'src', 'close.ts'), 'export const close = true;\n', 'utf8');
      git(value.active.main_worktree_path, ['add', 'src/close.ts']);
      git(value.active.main_worktree_path, ['commit', '-m', 'validated close result']);
      const desired = git(value.active.main_worktree_path, ['rev-parse', 'HEAD']);
      const targetBefore = git(value.repo, ['rev-parse', 'HEAD']);
      const finalMerge = {
        ...mainCreate, operationType: 'merge' as const, operationKey: `close-final:${targetBefore}:${desired}`, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
        intent: { ...mainCreate.intent, reason: 'final target fast-forward response loss witness', base_sha: targetBefore, target_sha: desired, archive_ref: git(value.repo, ['rev-parse', '--abbrev-ref', 'HEAD']) },
      };
      await saga.prepare(finalMerge);
      git(value.repo, ['merge', '--ff-only', desired]);
      await value.server.close();
      replacement = await startCoordinatorServer(coordinatorRuntimePaths(value.env));
      const recovered = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recovered.some((operation) => operation.operation_id.includes('operation-') && operation.operation_type === 'merge' && operation.stage === 'committed'), true);
      assert.equal(git(value.repo, ['rev-parse', 'HEAD']), desired);
    } finally {
      await value.server.close().catch(() => undefined);
      if (replacement !== null) await replacement.close();
      await rm(value.root, { recursive: true, force: true });
    }
  });

  void it('queues durable owner recovery on coordinator restart and resumes before dispatch', async () => {
    const value = await setup('r');
    let restarted: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const spec = unitCreateSpec(value, 'unit-r');
      await saga.prepare(spec);
      await value.server.close();
      restarted = await startCoordinatorServer(coordinatorRuntimePaths(value.env));
      const client = new CoordinatorClient({ env: value.env, autoStart: false });
      const status = await client.query('status', value.active.repo_key, value.active.workstream_run);
      assert.equal(typeof status.payload['pending_messages'] === 'number' && status.payload['pending_messages'] > 0, true);
      const doctor = await client.query('doctor');
      const incomplete = doctor.payload['incomplete_worktree_operations'];
      assert.equal(Array.isArray(incomplete) && incomplete.length === 1, true);
      const recovered = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recovered[0]?.stage, 'committed');
      assert.equal(existsSync(spec.intent.worktree_path), true);
    } finally {
      if (restarted !== null) await restarted.close();
      await close(value);
    }
  });

  void it('repairs only exact owned stale Git metadata without globally pruning foreign entries', async () => {
    const value = await setup('l');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const create = unitCreateSpec(value, 'unit-stale-metadata');
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const terminalSha = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      const foreignPath = join(value.root, 'foreign-run-worktree');
      git(value.repo, ['worktree', 'add', '-b', 'foreign/run-l', foreignPath, value.active.target_base_sha]);
      await rm(foreignPath, { recursive: true, force: false });
      await rm(create.intent.worktree_path, { recursive: true, force: false });
      assert.equal(git(value.repo, ['worktree', 'list', '--porcelain']).includes(create.intent.worktree_path), true);
      await saga.prepare({ ...create, operationType: 'remove', operationKey: 'remove-stale-metadata', initialWorktreeState: 'terminal', committedWorktreeState: 'removed', intent: { ...create.intent, reason: 'exact stale metadata repair witness', target_sha: terminalSha } });
      const recovered = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recovered.some((operation) => operation.operation_type === 'remove' && operation.stage === 'committed'), true);
      const afterList = git(value.repo, ['worktree', 'list', '--porcelain']);
      assert.equal(afterList.includes(create.intent.worktree_path), false, afterList);
      assert.equal(afterList.includes(foreignPath), true, 'owner recovery globally pruned foreign stale metadata');
      assert.equal(git(value.repo, ['branch', '--list', 'foreign/run-l']).includes('foreign/run-l'), true);
      assert.equal(git(value.repo, ['branch', '--list', create.intent.branch]), '');
    } finally {
      await close(value);
    }
  });

  void it('fences the old saga executor across session handoff and lets only the new owner generation recover', async () => {
    const value = await setup('k');
    try {
      const client = new CoordinatorClient({ env: value.env, autoStart: false });
      const saga = new OwnedWorktreeSagaClient(client, value.session);
      const create = unitCreateSpec(value, 'unit-handoff');
      await saga.prepare(create);
      const handoff = await client.mutate('prepare-handoff', {
        repoId: value.session.repo_id, workstreamRun: value.session.workstream_run, sessionId: value.session.session_id, fencingGeneration: value.session.session_generation,
        expectedVersion: value.session.session_version, idempotencyKey: 'prepare-saga-handoff',
      }, { handoff_token: 'handoff-saga-k', session_lease_id: value.session.session_lease_id, session_token: value.session.session_token });
      const handoffLease = parseCoordinationSessionLease(handoff.payload['session']);
      assert.equal(handoffLease.status, 'handoff-pending');
      const nextToken = 'c'.repeat(64);
      const attached = await client.mutate('attach-session', {
        repoId: value.session.repo_id, workstreamRun: value.session.workstream_run, sessionId: 'session-k-next', fencingGeneration: 2,
        expectedVersion: value.session.run_version, idempotencyKey: 'attach-saga-handoff-next',
      }, { session_lease_id: 'lease-k-next', session_token: nextToken, pid: process.pid, boot_id: 'boot-k-next', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });
      const nextRun = parseCoordinationRun(attached.payload['run']);
      const nextLease = parseCoordinationSessionLease(attached.payload['session']);
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: value.active, env: value.env }), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'fenced-session');
      assert.equal(existsSync(create.intent.worktree_path), false);
      const nextContext: CoordinatorSessionContext = { ...value.session, session_id: nextLease.session_id, session_generation: nextLease.session_generation, run_version: nextRun.version, session_lease_id: nextLease.session_lease_id, session_token: nextToken, session_version: nextLease.version, boot_id: nextLease.boot_id };
      const nextContextPath = join(value.stateRoot, 'next-session.json');
      await writeCoordinatorSessionContext(nextContextPath, nextContext);
      const nextEnv = { ...value.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: nextContextPath };
      const recovered = await recoverOwnedWorktreeSagas({ active: value.active, env: nextEnv });
      assert.equal(recovered.some((operation) => operation.owner.unit_id === 'unit-handoff' && operation.stage === 'committed'), true);
      assert.equal(existsSync(create.intent.worktree_path), true);
    } finally {
      await close(value);
    }
  });

  void it('preserves dirty work, then permits exact owned quarantine and removal without touching a foreign run', async () => {
    const value = await setup('a');
    const foreign = await setup('b');
    try {
      const spec = unitCreateSpec(value);
      const callbacks = {
        inspect: () => existsSync(spec.intent.worktree_path) ? { outcome: 'satisfied' as const, proof: ['present'] } : { outcome: 'not-applied' as const, proof: ['absent'] },
        action: () => { git(value.repo, ['worktree', 'add', '-b', spec.intent.branch, spec.intent.worktree_path, value.active.target_base_sha]); },
        verify: () => ['present'],
      };
      const ownedCreate = await executeOwnedWorktreeSaga(spec, callbacks, value.env);
      if (ownedCreate.operation === null) throw new Error('owned create operation missing');
      let unauthorizedActionRan = false;
      const noSessionEnv = { ...value.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: undefined };
      const noSessionSpec = unitCreateSpec(value, 'unit-no-session');
      await assert.rejects(() => executeOwnedWorktreeSaga(noSessionSpec, { inspect: () => ({ outcome: 'not-applied', proof: ['absent'] }), action: () => { unauthorizedActionRan = true; }, verify: () => ['should-not-run'] }, noSessionEnv), /coordinator-authoritative run is missing its durable session/u);
      assert.equal(unauthorizedActionRan, false);
      const sharedClient = new CoordinatorClient({ env: value.env, autoStart: false });
      const peerRunResponse = await sharedClient.mutate('attach-run', {
        repoId: value.active.repo_key, workstreamRun: 'run-peer', sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-peer',
      }, {
        repo_key: value.active.repo_key, canonical_root: value.repo, git_common_dir: join(value.repo, '.git'), autopilot_id: 'autopilot-peer', workstream: 'work-peer', coordination_authority: 'coordinator-edit-leases-v1',
        run_resource: {
          schema_version: 'autopilot.coordination_run_resource.v1', repo_id: value.active.repo_key, workstream_run: 'run-peer',
          source_repo: value.repo, git_common_dir: join(value.repo, '.git'), worktree_root: join(value.stateRoot, 'worktrees', value.active.repo_key),
          main_worktree_path: join(value.stateRoot, 'worktrees', value.active.repo_key, 'active', 'run-peer', 'main'), runtime_root: join(value.stateRoot, 'worktrees', value.active.repo_key, 'active', 'run-peer', 'main', '.pi', 'autopilot', 'work-peer'),
          branch: 'autopilot/run-peer', target_branch: 'master', target_base_sha: value.active.target_base_sha, origin_url: null,
          started_at: '2026-07-11T00:00:00.000Z', version: 1,
        },
      });
      const peerRun = parseCoordinationRun(peerRunResponse.payload['run']);
      const peerToken = 'f'.repeat(64);
      await sharedClient.mutate('attach-session', {
        repoId: value.active.repo_key, workstreamRun: 'run-peer', sessionId: 'session-peer', fencingGeneration: 1, expectedVersion: peerRun.version, idempotencyKey: 'attach-session-peer',
      }, { session_lease_id: 'lease-peer', session_token: peerToken, pid: process.pid, boot_id: 'boot-peer', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });
      await assert.rejects(
        () => sharedClient.mutate('transition-operation', {
          repoId: value.active.repo_key, workstreamRun: 'run-peer', sessionId: 'session-peer', fencingGeneration: 1,
          expectedVersion: ownedCreate.operation?.version ?? 0, idempotencyKey: 'foreign-transition-attempt',
        }, { operation_id: ownedCreate.operation?.operation_id ?? 'missing', stage: 'reconciling', completed_steps: [], current_step: 'foreign', recovery_attempts: 0, verification_evidence: null, error_code: 'recovery-required', worktree_state: 'active', session_lease_id: 'lease-peer', session_token: peerToken }),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'unauthorized-client',
      );
      const foreignSpec = unitCreateSpec(foreign, 'unit-b');
      await executeOwnedWorktreeSaga(foreignSpec, {
        inspect: () => existsSync(foreignSpec.intent.worktree_path) ? { outcome: 'satisfied' as const, proof: ['present'] } : { outcome: 'not-applied' as const, proof: ['absent'] },
        action: () => { git(foreign.repo, ['worktree', 'add', '-b', foreignSpec.intent.branch, foreignSpec.intent.worktree_path, foreign.active.target_base_sha]); },
        verify: () => ['present'],
      }, foreign.env);
      await writeFile(join(spec.intent.worktree_path, 'src', 'dirty.ts'), 'dirty\n', 'utf8');
      const removeSpec = { ...spec, operationType: 'remove' as const, operationKey: 'remove-dirty', initialWorktreeState: 'active' as const, committedWorktreeState: 'removed' as const, intent: { ...spec.intent, reason: 'remove terminal unit', target_sha: git(spec.intent.worktree_path, ['rev-parse', 'HEAD']) } };
      await assert.rejects(
        () => executeOwnedWorktreeSaga(removeSpec, {
          inspect: () => ({ outcome: 'unsafe', proof: ['dirty=src/dirty.ts'] }), action: () => undefined, verify: () => [],
        }, value.env),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'recovery-required',
      );
      assert.equal(existsSync(join(spec.intent.worktree_path, 'src', 'dirty.ts')), true);
      assert.equal(existsSync(foreignSpec.intent.worktree_path), true);
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: foreign.active, env: value.env }), /does not own|session does not own/u);
      assert.equal(existsSync(foreignSpec.intent.worktree_path), true);
    } finally {
      await close(value);
      await close(foreign);
    }
  });
});
