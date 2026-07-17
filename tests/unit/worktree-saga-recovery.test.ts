import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { ClaimNegotiationClient } from '../../src/core/coordination/negotiation.ts';
import { RunReconciliationClient } from '../../src/core/coordination/reconciliation.ts';
import { parseCoordinationRun, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { CoordinationRuntimeError, formatCoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { readCurrentStoreGeneration } from '../../src/core/coordination/store-generation.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { DurableRunSupervisorClient, writeCoordinatorSessionContext, type CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { executeOwnedWorktreeSaga, fixedWorktreeSagaCallbacks, OwnedWorktreeSagaClient, recoverOwnedWorktreeSagas, WORKTREE_SAGA_BOUNDARIES } from '../../src/core/coordination/worktree-saga.ts';
import { inspectWorktreePostcondition } from '../../src/core/coordination/worktree-postconditions.ts';
import { deterministicWorktreeId } from '../../src/core/coordination/worktree-identity.ts';
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
    initialWorktreeState: 'planned' as const, committedWorktreeState: 'active' as const,
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
      const removeMovedBranch = { ...unitC, operationType: 'remove' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'removed' as const, intent: { ...unitC.intent, reason: 'branch movement fence witness', target_sha: intendedTerminal } };
      await saga.prepare(removeMovedBranch);
      await writeFile(join(unitC.intent.worktree_path, 'src', 'late.ts'), 'late change\n', 'utf8');
      git(unitC.intent.worktree_path, ['add', 'src/late.ts']);
      git(unitC.intent.worktree_path, ['commit', '-m', 'foreign late branch movement']);
      const movedHead = git(unitC.intent.worktree_path, ['rev-parse', 'HEAD']);
      await assert.rejects(
        () => recoverOwnedWorktreeSagas({ active: value.active, env: value.env }),
        (error: unknown) => error instanceof CoordinationRuntimeError
          && error.code === 'recovery-required'
          && error.evidence.some((entry) => entry.includes(intendedTerminal))
          && error.evidence.some((entry) => entry.includes(movedHead)),
      );
      assert.equal(existsSync(unitC.intent.worktree_path), true);
      assert.equal(git(unitC.intent.worktree_path, ['rev-parse', 'HEAD']), movedHead);
    } finally {
      await close(value);
    }
  });

  void it('rejects caller-invented operation IDs while preserving existing historical resume IDs', async () => {
    const value = await setup('opid');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const spec = { ...unitCreateSpec(value, 'unit-operation-id'), operationId: 'operation-caller-invented' };
      await assert.rejects(() => saga.prepare(spec), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'invalid-request' && error.message.includes('existing historical operation'));
      assert.equal((await saga.operations()).some((operation) => operation.operation_id === spec.operationId), false);
      assert.equal(existsSync(spec.intent.worktree_path), false);
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
      git(value.repo, ['worktree', 'add', '-b', 'foreign/unit-unsafe-probe', spec.intent.worktree_path, spec.intent.base_sha ?? 'HEAD']);
      let observed: CoordinationRuntimeError | null = null;
      try {
        await executeOwnedWorktreeSaga(spec, {
          action: () => { actionCount += 1; },
        }, value.env);
      } catch (error) {
        if (!(error instanceof CoordinationRuntimeError)) throw error;
        observed = error;
      }
      if (observed === null) throw new Error('unsafe preflight did not fail');
      assert.equal(observed.code, 'recovery-required');
      assert.equal(actionCount, 0);
      assert.equal(observed.evidence.includes('cause_code=recovery-required'), true);
      assert.equal(observed.evidence.some((entry) => entry.includes('actual_registration_branch=refs/heads/foreign/unit-unsafe-probe')), true);
      assert.equal(observed.evidence.some((entry) => entry.includes('expected_registration_branch=refs/heads/autopilot/unit/')), true);
      const visibleDiagnostic = formatCoordinationRuntimeError(observed);
      assert.match(visibleDiagnostic, /actual_registration_branch=refs\/heads\/foreign\/unit-unsafe-probe/u);
      assert.equal(observed.evidence.includes('reconciliation_code=coordinator-unavailable'), true);
      assert.equal(observed.evidence.includes('reconciliation_evidence[0]=failure_class=retryable-contention'), true);
      assert.equal(observed.evidence.includes('reconciliation_evidence[1]=server_evidence[0]=transition_marker=reconciling-committed'), true);
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
          action: () => { actionCount += 1; },
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
        action: () => { actionCount += 1; },
      }, value.env);
      assert.equal(actionCount, 0);
      assert.equal(result.operation?.stage, 'committed');
    } finally {
      await close(value);
    }
  });

  void it('replays a committed canonical key through a later committed reset without repeating its historical effect', async () => {
    const value = await setup('sup');
    try {
      const create = unitCreateSpec(value, 'unit-superseded-commit');
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const base = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      const commit = { ...create, operationType: 'commit' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const, intent: { ...create.intent, reason: 'canonical supersession commit', base_sha: base, target_sha: null, checkout_mode: null, paths: ['src/historical.ts'] } };
      let commitActions = 0;
      const commitCallbacks = { action: async () => { commitActions += 1; await writeFile(join(create.intent.worktree_path, 'src', 'historical.ts'), 'historical\n', 'utf8'); git(create.intent.worktree_path, ['add', 'src/historical.ts']); git(create.intent.worktree_path, ['commit', '-m', 'historical commit']); } };
      const committed = await executeOwnedWorktreeSaga(commit, commitCallbacks, value.env);
      const committedHead = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      assert.equal(committed.operation?.stage, 'committed');
      assert.equal(commitActions, 1);

      const reset = { ...create, operationType: 'reset' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'terminal' as const, intent: { ...create.intent, reason: 'canonical later reset', base_sha: committedHead, target_sha: base, checkout_mode: null, paths: [] } };
      await executeOwnedWorktreeSaga(reset, { action: () => { git(create.intent.worktree_path, ['reset', '--hard', base]); } }, value.env);
      assert.equal(git(create.intent.worktree_path, ['rev-parse', 'HEAD']), base);

      const replay = await executeOwnedWorktreeSaga(commit, commitCallbacks, value.env);
      assert.equal(replay.operation?.operation_id, committed.operation?.operation_id);
      assert.equal(replay.replayed, true);
      assert.equal(commitActions, 1);
      assert.equal(git(create.intent.worktree_path, ['rev-parse', 'HEAD']), base);
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
        ...create, operationType: 'remove' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'removed' as const,
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

  void it('preserves a later package-owned quarantine when a historical preflight rollback was superseded', async () => {
    const value = await setup('s');
    let restarted: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const full = unitCreateSpec(value, 'unit-superseded-rollback');
      const create = { ...full, intent: { ...full.intent, checkout_mode: 'claim-minimal' as const, sparse_patterns: ['/src/base.ts'] } };
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const taskRoot = dirname(dirname(dirname(dirname(create.intent.worktree_path))));
      const attemptRoot = dirname(create.intent.worktree_path);
      const activeBranchInfo = {
        unit_id: create.unitId, attempt: create.attempt, branch: create.intent.branch, worktree_path: create.intent.worktree_path,
        base_sha: value.active.target_base_sha, current_sha: value.active.target_base_sha, archive_ref: null, status: 'active' as const,
      };
      await writeFile(join(attemptRoot, UNIT_INFO_FILE), `${JSON.stringify({
        schema_version: 'autopilot.unit_info.v1', workstream: value.active.workstream, workstream_run: value.active.workstream_run,
        autopilot_id: value.active.autopilot_id, ...activeBranchInfo, runtime_root: value.active.runtime_root,
        created_at: value.active.started_at, checkout_mode: 'claim-minimal', checkout_profile_ref: '_checkout-profile.json', materialized_paths_ref: MATERIALIZED_PATHS_FILE,
      }, null, 2)}\n`, 'utf8');
      await writeFile(join(attemptRoot, MATERIALIZED_PATHS_FILE), '{}\n', 'utf8');
      await writeFile(join(taskRoot, UNIT_INDEX_FILE), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [activeBranchInfo] }, null, 2)}\n`, 'utf8');
      await writeFile(join(taskRoot, BRANCHES_FILE), `${JSON.stringify({ schema_version: 'autopilot.branches.v1', active_branch: value.active.branch, base_sha: value.active.target_base_sha, current_sha: value.active.target_base_sha, archive_ref: null, unit_branches: [activeBranchInfo] }, null, 2)}\n`, 'utf8');

      const rollback = {
        ...create, operationType: 'remove' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'removed' as const,
        intent: { ...create.intent, reason: 'autopilot-agent-run preflight rollback after failure: synthetic pre-spend rejection', target_sha: value.active.target_base_sha, checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [WORKTREE_LEDGER_FILE] },
      };
      await saga.prepare(rollback);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(existsSync(create.intent.worktree_path), false);

      const recreate = { ...create, intent: { ...create.intent, reason: 'package recreate after rollback' } };
      const preparedRecreate = await saga.prepare(recreate);
      await executeOwnedWorktreeSaga(recreate, fixedWorktreeSagaCallbacks(preparedRecreate.operation, value.env), value.env);
      const materialize = {
        ...create, operationType: 'materialize' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
        intent: { ...create.intent, reason: 'package materialization after exact recreate', base_sha: null, sparse_patterns: ['/docs/context.md'], paths: ['docs/context.md'] },
      };
      await saga.prepare(materialize);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });

      const coordinator = new CoordinatorClient({ env: value.env, autoStart: false });
      await coordinator.mutate('register-attempt', {
        repoId: value.session.repo_id, workstreamRun: value.session.workstream_run, sessionId: value.session.session_id,
        fencingGeneration: value.session.session_generation, expectedVersion: value.session.run_version, idempotencyKey: 'register-superseded-rollback-attempt',
      }, {
        unit_id: create.unitId, attempt: create.attempt, spec_ref: `unit-specs/${create.unitId}.json`, spec_sha256: `sha256:${'c'.repeat(64)}`,
        role: 'fix', preemptible: true, checkpoint_ordinal: 0, session_lease_id: value.session.session_lease_id, session_token: value.session.session_token,
      });
      const childLeaseId = `child-${value.active.workstream_run}-${create.unitId}-${String(create.attempt)}`;
      await coordinator.mutate('register-child', {
        repoId: value.session.repo_id, workstreamRun: value.session.workstream_run, sessionId: value.session.session_id,
        fencingGeneration: value.session.session_generation, expectedVersion: value.session.run_version, idempotencyKey: 'register-superseded-rollback-child',
      }, {
        child_lease_id: childLeaseId, autopilot_id: value.active.autopilot_id, unit_id: create.unitId, attempt: create.attempt,
        pid: process.pid, boot_id: 'superseded-rollback-child-boot', child_token: 'f'.repeat(64), session_lease_id: value.session.session_lease_id,
        session_token: value.session.session_token, lease_expires_at: '2099-01-01T00:00:00.000Z',
      });

      const quarantineBase = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      await writeFile(join(create.intent.worktree_path, 'src', 'quarantined.ts'), 'preserve exact failed work\n', 'utf8');
      const quarantine = {
        ...create, operationType: 'quarantine' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'quarantined' as const,
        intent: { ...create.intent, reason: 'quarantine later package-owned failed work', base_sha: quarantineBase, target_sha: null, checkout_mode: null, sparse_patterns: [], paths: ['src/quarantined.ts'] },
      };
      await saga.prepare(quarantine);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const captureHead = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      const archiveRef = `autopilot/archive/${value.active.workstream_run}/unit/${create.unitId}/attempt-1/capture`;
      const archive = {
        ...create, operationType: 'archive' as const, initialWorktreeState: 'quarantined' as const, committedWorktreeState: 'quarantined' as const,
        intent: { ...create.intent, reason: 'archive exact later quarantine capture', base_sha: quarantineBase, target_sha: captureHead, archive_ref: archiveRef, checkout_mode: null, sparse_patterns: [], paths: [] },
      };
      const preparedArchive = await saga.prepare(archive);
      await executeOwnedWorktreeSaga(archive, fixedWorktreeSagaCallbacks(preparedArchive.operation, value.env), value.env);
      const quarantinedBranchInfo = { ...activeBranchInfo, current_sha: captureHead, archive_ref: archiveRef, status: 'quarantined' as const };
      await writeFile(join(taskRoot, UNIT_INDEX_FILE), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [quarantinedBranchInfo] }, null, 2)}\n`, 'utf8');
      await writeFile(join(taskRoot, BRANCHES_FILE), `${JSON.stringify({ schema_version: 'autopilot.branches.v1', active_branch: value.active.branch, base_sha: value.active.target_base_sha, current_sha: value.active.target_base_sha, archive_ref: null, unit_branches: [quarantinedBranchInfo] }, null, 2)}\n`, 'utf8');

      await value.server.close();
      const currentGeneration = readCurrentStoreGeneration(coordinatorRuntimePaths(value.env));
      if (currentGeneration === null) throw new Error('current schema-13 store generation is missing');
      const database = new DatabaseSync(currentGeneration.database_path);
      try {
        database.prepare("UPDATE child_leases SET status='recovery-required', version=version+1 WHERE child_lease_id=?").run(childLeaseId);
        const row = database.prepare("SELECT entity_id, payload_json FROM unit_attempts WHERE repo_id=? AND workstream_run=? AND json_extract(payload_json, '$.owner.unit_id')=? AND json_extract(payload_json, '$.owner.attempt')=?").get(value.active.repo_key, value.active.workstream_run, create.unitId, create.attempt) as Readonly<Record<string, unknown>> | undefined;
        if (row === undefined || typeof row['entity_id'] !== 'string' || typeof row['payload_json'] !== 'string') throw new Error('unit attempt fixture row is missing');
        const payload = JSON.parse(row['payload_json']) as Record<string, unknown>;
        const next = { ...payload, state: 'quarantined', version: Number(payload['version']) + 1 };
        database.prepare('UPDATE unit_attempts SET payload_json=?, version=? WHERE entity_id=?').run(JSON.stringify(next), next.version, row['entity_id']);
      } finally { database.close(); }
      restarted = await startCoordinatorServer(coordinatorRuntimePaths(value.env));

      const rejectUnprovenSupersession = async (): Promise<void> => {
        await assert.rejects(
          () => recoverAutopilotWorktreeSagas({ active: value.active, env: value.env }),
          (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'recovery-required',
        );
      };
      const foreignResidue = join(create.intent.worktree_path, 'src', 'foreign-residue.ts');
      await writeFile(foreignResidue, 'foreign residue\n', 'utf8');
      await rejectUnprovenSupersession();
      await rm(foreignResidue);

      git(value.repo, ['update-ref', `refs/heads/${archiveRef}`, quarantineBase]);
      await rejectUnprovenSupersession();
      git(value.repo, ['update-ref', `refs/heads/${archiveRef}`, captureHead]);

      const mismatchedIndex = { ...quarantinedBranchInfo, current_sha: quarantineBase };
      await writeFile(join(taskRoot, UNIT_INDEX_FILE), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [mismatchedIndex] }, null, 2)}\n`, 'utf8');
      await rejectUnprovenSupersession();
      await writeFile(join(taskRoot, UNIT_INDEX_FILE), `${JSON.stringify({ schema_version: 'autopilot.unit_index.v1', units: [quarantinedBranchInfo] }, null, 2)}\n`, 'utf8');

      const archiveOperation = (await saga.operations()).find((operation) => operation.operation_type === 'archive' && operation.owner.unit_id === create.unitId);
      if (archiveOperation?.verification_evidence === null || archiveOperation?.verification_evidence === undefined) throw new Error('archive operation evidence is missing');
      const archiveEvidencePath = join(value.active.worktree_root, ...archiveOperation.verification_evidence.ref.split('/'));
      const archiveEvidenceBytes = await readFile(archiveEvidencePath);
      await writeFile(archiveEvidencePath, Buffer.concat([archiveEvidenceBytes, Buffer.from('tamper')]));
      await rejectUnprovenSupersession();
      await writeFile(archiveEvidencePath, archiveEvidenceBytes);

      await recoverAutopilotWorktreeSagas({ active: value.active, env: value.env });
      await recoverAutopilotWorktreeSagas({ active: value.active, env: value.env });
      const rollbackOperation = (await saga.operations()).find((operation) => operation.intent.reason.startsWith('autopilot-agent-run preflight rollback after failure:'));
      if (rollbackOperation === undefined) throw new Error('historical rollback operation is missing');
      const auditPath = join(value.active.worktree_root, '_saga-evidence', value.active.workstream_run, 'supersessions', `${rollbackOperation.operation_id}.json`);
      assert.equal(existsSync(auditPath), true);
      const audit = JSON.parse(await readFile(auditPath, 'utf8')) as Readonly<Record<string, unknown>>;
      assert.equal(audit['schema_version'], 'autopilot.worktree_rollback_supersession.v1');
      assert.equal(audit['disposition'], 'historical-preflight-rollback-superseded-by-exact-later-package-quarantine');
      assert.equal(existsSync(create.intent.worktree_path), true);
      assert.equal(git(create.intent.worktree_path, ['status', '--porcelain']), '');
      assert.equal(git(create.intent.worktree_path, ['rev-parse', 'HEAD']), captureHead);
      assert.equal((await readUnitIndex(taskRoot)).units[0]?.status, 'quarantined');
      const doctor = await new CoordinatorClient({ env: value.env, autoStart: false }).query('doctor');
      const findings = doctor.payload['invariant_findings'];
      assert.equal(Array.isArray(findings) && findings.some((finding) => typeof finding === 'object' && finding !== null && (finding as Record<string, unknown>)['code'] === 'worktree-remove-state-mismatch'), false);
    } finally {
      if (restarted !== null) await restarted.close();
      await value.server.close().catch(() => undefined);
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
        active: prepared.active, unitId, attempt, kind: 'unit', operationType: 'create', initialWorktreeState: 'planned', committedWorktreeState: 'active',
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
        const target = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
        const archiveRef = `autopilot/archive/${value.active.workstream_run}/unit/unit-io-failure/attempt-1/${code.toLowerCase()}`;
        const operation = { ...create, operationType: 'archive' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const, intent: { ...create.intent, reason: `${code} recovery witness`, target_sha: target, archive_ref: archiveRef, checkout_mode: null, sparse_patterns: [], paths: [] } };
        let failOnce = true;
        const callbacks = {
          action: () => { if (failOnce) { failOnce = false; throw Object.assign(new Error(`simulated ${code}`), { code }); } git(value.repo, ['update-ref', `refs/heads/${archiveRef}`, target, '0'.repeat(40)]); },
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
        const archiveRef = `autopilot/archive/${value.active.workstream_run}/unit/unit-boundaries/attempt-1/boundary-${String(index)}`;
        const target = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
        let effectCount = 0;
        let injected = false;
        const spec = {
          ...create, operationType: 'archive' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
          intent: { ...create.intent, reason: `fault-injection witness at ${boundary}`, target_sha: target, archive_ref: archiveRef, checkout_mode: null, sparse_patterns: [], paths: [] },
        };
        const callbacks = {
          action: () => { effectCount += 1; git(value.repo, ['update-ref', `refs/heads/${archiveRef}`, target, '0'.repeat(40)]); },
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
        const recovered = await executeOwnedWorktreeSaga(spec, { action: callbacks.action }, value.env);
        assert.equal(recovered.operation?.stage, 'committed');
        assert.equal(effectCount <= 1, true, `${boundary} repeated its external effect`);
      }
    } finally {
      await close(value);
    }
  });

  void it('terminalizes sanitized I2 operation-5df1 branch-proof capture 8725cf1, releases exactly 42 WRITE leases, and performs no second commit', async () => {
    const value = await setup('i2');
    try {
      const client = new CoordinatorClient({ env: value.env, autoStart: false });
      const claims = new ClaimNegotiationClient(client, value.session);
      const capturedPaths = Array.from({ length: 42 }, (_entry, index) => `src/i2-captured-${String(index).padStart(2, '0')}.ts`);
      const acquired = await claims.acquire({
        acquisitionGroupId: 'group-i2-42-write', unitId: 'FOUND-APP-IMPL', attempt: 1,
        requestedLeases: capturedPaths.map((path) => ({ path, mode: 'WRITE' as const, purpose: 'sanitized historical I2 retained authority' })),
        reason: 'sanitized historical I2 42-WRITE authority shape', normalReleaseCondition: { condition_type: 'quarantine-captured', target_id: 'FOUND-APP-IMPL:1', evidence: null },
        specRef: '.pi/autopilot/work-i2/unit-specs/FOUND-APP-IMPL.json', specSha256: `sha256:${'a'.repeat(64)}`, role: 'implement', preemptible: true, checkpointOrdinal: 0,
      });
      assert.equal(acquired.outcome, 'granted');
      if (acquired.outcome !== 'granted') throw new Error('I2 retained authority was not granted');
      const unrelated = await claims.acquire({
        acquisitionGroupId: 'group-i2-unrelated', unitId: 'UNRELATED', attempt: 1,
        requestedLeases: [{ path: 'src/unrelated.ts', mode: 'WRITE', purpose: 'must survive I2 exact release' }],
        reason: 'unrelated authority isolation witness', normalReleaseCondition: { condition_type: 'quarantine-captured', target_id: 'UNRELATED:1', evidence: null },
        specRef: '.pi/autopilot/work-i2/unit-specs/UNRELATED.json', specSha256: `sha256:${'b'.repeat(64)}`, role: 'implement', preemptible: true, checkpointOrdinal: 0,
      });
      assert.equal(unrelated.outcome, 'granted');
      if (unrelated.outcome !== 'granted') throw new Error('unrelated authority was not granted');

      const create = unitCreateSpec(value, 'FOUND-APP-IMPL');
      const saga = new OwnedWorktreeSagaClient(client, value.session);
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      for (const [index, path] of capturedPaths.entries()) await writeFile(join(create.intent.worktree_path, path), `export const captured${String(index)} = true;\n`, 'utf8');
      const quarantine = {
        ...create,
        operationType: 'quarantine' as const,
        initialWorktreeState: 'active' as const,
        committedWorktreeState: 'quarantined' as const,
        intent: {
          ...create.intent,
          reason: 'sanitized regression for historical operation-5df1cda32ea1a860e6fe85d8891bb0d2 / capture 8725cf1',
          target_sha: value.active.target_base_sha,
          paths: capturedPaths,
        },
      };
      const prepared = await saga.prepare(quarantine);
      git(create.intent.worktree_path, ['add', '--', ...capturedPaths]);
      git(create.intent.worktree_path, ['commit', '-m', 'sanitized I2 quarantine capture']);
      const capture = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      assert.equal(git(value.repo, ['rev-list', '--count', `${value.active.target_base_sha}..${capture}`]), '1');
      await rm(create.intent.worktree_path, { recursive: true, force: false });

      const recovered = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const operation = recovered.find((entry) => entry.operation_id === prepared.operation.operation_id);
      assert.equal(operation?.stage, 'committed');
      assert.equal(operation?.error_code, null);
      assert.equal(existsSync(create.intent.worktree_path), false);
      assert.equal(git(value.repo, ['rev-parse', `refs/heads/${create.intent.branch}`]), capture);
      assert.equal(git(value.repo, ['rev-list', '--count', `${value.active.target_base_sha}..refs/heads/${create.intent.branch}`]), '1');
      if (operation?.verification_evidence === null || operation?.verification_evidence === undefined) throw new Error('I2 recovery evidence missing');
      const evidence: unknown = JSON.parse(await readFile(join(value.active.worktree_root, ...operation.verification_evidence.ref.split('/')), 'utf8'));
      if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) throw new Error('I2 recovery evidence is not an object');
      assert.equal(Reflect.get(evidence, 'capture_sha'), capture);
      assert.equal(Reflect.get(evidence, 'proof_source'), 'owned-git-ref');
      const worktree = (await saga.worktrees()).find((entry) => entry.worktree_id === operation.worktree_id);
      assert.equal(worktree?.state, 'quarantined');

      const captureRef = `autopilot/archive/${value.active.workstream_run}/unit/FOUND-APP-IMPL/attempt-1/quarantine-capture`;
      git(value.repo, ['update-ref', `refs/heads/${captureRef}`, capture, '0'.repeat(40)]);
      const evidenceRef = '.pi/autopilot/work-i2/quarantine/FOUND-APP-IMPL.attempt-1.quarantine.json';
      const failureDocument = {
        schema_version: 'autopilot.unit_failure.v1', action: 'quarantine', workstream: value.active.workstream, workstream_run: value.active.workstream_run,
        unit_id: 'FOUND-APP-IMPL', attempt: 1, unit_worktree_path: create.intent.worktree_path, dirty_paths: capturedPaths,
        capture_commit_sha: capture, capture_ref: captureRef, git_head_before: value.active.target_base_sha, git_head_after: capture,
        git_common_dir: value.active.git_common_dir, branch: create.intent.branch, postcondition_worktree_clean: true,
        summary: 'sanitized exact I2 absent-worktree authority release witness', created_at: '2026-07-11T00:00:01.000Z',
      };
      const failureBytes = `${JSON.stringify(failureDocument, null, 2)}\n`;
      const failurePath = join(value.active.main_worktree_path, ...evidenceRef.split('/'));
      await mkdir(dirname(failurePath), { recursive: true });
      await writeFile(failurePath, failureBytes, 'utf8');
      const failureSha: `sha256:${string}` = `sha256:${createHash('sha256').update(failureBytes, 'utf8').digest('hex')}`;
      const reconciliation = new RunReconciliationClient(client, value.session);
      const forgedRef = '.pi/autopilot/work-i2/quarantine/FOUND-APP-IMPL.attempt-1.forged-path-set.json';
      const forgedBytes = `${JSON.stringify({ ...failureDocument, dirty_paths: capturedPaths.slice(1) }, null, 2)}\n`;
      const forgedPath = join(value.active.main_worktree_path, ...forgedRef.split('/'));
      await mkdir(dirname(forgedPath), { recursive: true });
      await writeFile(forgedPath, forgedBytes, 'utf8');
      const forgedSha: `sha256:${string}` = `sha256:${createHash('sha256').update(forgedBytes, 'utf8').digest('hex')}`;
      await assert.rejects(
        () => reconciliation.recordReleaseEvidence({ source: 'quarantine-capture', targetId: 'FOUND-APP-IMPL:1', evidenceRef: forgedRef, evidenceSha256: forgedSha }),
        /exactly one matching committed canonical operation/u,
      );
      const afterRejectedRelease = await client.query('status', value.active.repo_key, value.active.workstream_run);
      const retained = afterRejectedRelease.payload['edit_leases'];
      if (!Array.isArray(retained)) throw new Error('I2 rejected-release status edit_leases is not an array');
      assert.equal(retained.length, 43, 'incomplete path proof must release no authority');

      const release = await reconciliation.recordReleaseEvidence({ source: 'quarantine-capture', targetId: 'FOUND-APP-IMPL:1', evidenceRef, evidenceSha256: failureSha });
      assert.deepEqual([...release.reconciliation.released_lease_ids].sort(), acquired.editLeases.map((lease) => lease.edit_lease_id).sort());
      assert.equal(release.reconciliation.released_lease_ids.length, 42);
      const afterRelease = await client.query('status', value.active.repo_key, value.active.workstream_run);
      const remaining = afterRelease.payload['edit_leases'];
      if (!Array.isArray(remaining)) throw new Error('I2 status edit_leases is not an array');
      assert.equal(remaining.length, 1);
      assert.equal(Reflect.get(remaining[0], 'edit_lease_id'), unrelated.editLeases[0]?.edit_lease_id);
      assert.equal(git(value.repo, ['rev-list', '--count', `${value.active.target_base_sha}..refs/heads/${create.intent.branch}`]), '1');

      git(value.repo, ['update-ref', '-d', `refs/heads/${create.intent.branch}`, capture]);
      const archiveOnly = inspectWorktreePostcondition({
        operationType: 'quarantine', owner: operation.owner, kind: 'unit', canonicalWorktreeId: deterministicWorktreeId(operation.owner, 'unit'),
        intent: { ...operation.intent, archive_ref: captureRef }, durableStage: operation.stage,
      });
      assert.equal(archiveOnly.outcome, 'satisfied', archiveOnly.proof.join('\n'));
      assert.equal(archiveOnly.proof_source, 'owned-git-ref');
      assert.equal(archiveOnly.capture_sha, capture);
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
        ...create, operationType: 'materialize' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
        intent: { ...create.intent, reason: 'materialize docs context', base_sha: null, checkout_mode: 'claim-minimal' as const, sparse_patterns: ['/docs/context.md'], paths: ['docs/context.md'] },
      };
      await saga.prepare(materialize);
      gitInput(create.intent.worktree_path, ['sparse-checkout', 'add', '--skip-checks', '--stdin'], '/docs/context.md\n');
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(existsSync(join(create.intent.worktree_path, 'docs', 'context.md')), true);

      const commitBase = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      await writeFile(join(create.intent.worktree_path, 'src', 'change.ts'), 'export const changed = true;\n', 'utf8');
      const commit = {
        ...create, operationType: 'commit' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
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
        initialWorktreeState: 'planned' as const, committedWorktreeState: 'active' as const,
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
        ...mainCreate, operationType: 'merge' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
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
        ...create, operationType: 'quarantine' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'quarantined' as const,
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
        ...create, operationType: 'reset' as const, initialWorktreeState: 'quarantined' as const, committedWorktreeState: 'terminal' as const,
        intent: { ...create.intent, reason: 'verify exact captured reset boundary', base_sha: captureHead, target_sha: captureHead, checkout_mode: null, sparse_patterns: [], paths: [] },
      };
      await saga.prepare(reset);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(git(create.intent.worktree_path, ['rev-parse', 'HEAD']), captureHead);

      const archiveRef = `autopilot/archive/${value.active.workstream_run}/unit/unit-g/attempt-1/capture`;
      const archive = {
        ...create, operationType: 'archive' as const, initialWorktreeState: 'quarantined' as const, committedWorktreeState: 'terminal' as const,
        intent: { ...create.intent, reason: 'archive quarantine capture', base_sha: committedHead, target_sha: captureHead, archive_ref: archiveRef, checkout_mode: null, sparse_patterns: [], paths: ['src/quarantine.ts'] },
      };
      await saga.prepare(archive);
      git(value.repo, ['update-ref', `refs/heads/${archiveRef}`, captureHead]);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(git(value.repo, ['rev-parse', `refs/heads/${archiveRef}`]), captureHead);

      const remove = {
        ...create, operationType: 'remove' as const, initialWorktreeState: 'terminal' as const, committedWorktreeState: 'removed' as const,
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
      const commit = { ...create, operationType: 'commit' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const, intent: { ...create.intent, reason: 'metadata gate witness', base_sha: base, target_sha: null, checkout_mode: null, paths: ['src/gated.ts'], metadata_refs: ['execution-commits/gated.json'] } };
      await saga.prepare(commit);
      git(create.intent.worktree_path, ['add', 'src/gated.ts']);
      git(create.intent.worktree_path, ['commit', '-m', 'simulated response-loss gated commit']);
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: value.active, env: value.env }), /canonical postcondition|metadata postcondition|missing_metadata|partial-effect/u);
      assert.equal(git(create.intent.worktree_path, ['rev-list', '--count', `${base}..HEAD`]), '1');
      assert.notEqual((await saga.operations()).find((operation) => operation.intent.reason === 'metadata gate witness')?.stage, 'committed');
      const taskRoot = dirname(dirname(dirname(dirname(create.intent.worktree_path))));
      await mkdir(join(taskRoot, 'execution-commits'), { recursive: true });
      await writeFile(join(taskRoot, 'execution-commits', 'gated.json'), '{}\n', 'utf8');
      const recovered = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recovered.some((operation) => operation.intent.reason === 'metadata gate witness' && operation.stage === 'committed'), true);
      assert.equal(git(create.intent.worktree_path, ['rev-list', '--count', `${base}..HEAD`]), '1');
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
      await saga.prepare({ ...create, operationType: 'materialize', initialWorktreeState: 'active', committedWorktreeState: 'active', intent: { ...create.intent, reason: 'LFS recovery refusal witness', base_sha: null, sparse_patterns: ['/docs/pointer.bin', '/src/future/new.ts'], paths: ['docs/pointer.bin', 'src/future/new.ts'] } });
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
      await assert.rejects(() => saga.prepare({ ...create, operationType: 'materialize', initialWorktreeState: 'active', committedWorktreeState: 'active', intent: { ...create.intent, reason: 'Git pathspec magic rejection witness', base_sha: null, sparse_patterns: ['/src/base.ts'], paths: [':(top)foreign.ts'] } }), /pathspec magic|invalid-request/u);
      const staleSha = git(archiveHarness.repo, ['rev-parse', 'HEAD']);
      await writeFile(join(archiveHarness.repo, 'foreign.ts'), 'foreign\n', 'utf8');
      git(archiveHarness.repo, ['add', 'foreign.ts']);
      git(archiveHarness.repo, ['commit', '-m', 'foreign target movement']);
      const intendedSha = git(archiveHarness.repo, ['rev-parse', 'HEAD']);
      await assert.rejects(() => saga.prepare({ ...create, operationType: 'archive', initialWorktreeState: 'active', committedWorktreeState: 'active', intent: { ...create.intent, reason: 'archive namespace escape witness', base_sha: staleSha, target_sha: intendedSha, archive_ref: git(archiveHarness.repo, ['rev-parse', '--abbrev-ref', 'HEAD']) } }), /run-owned namespace|unauthorized/u);
      const archiveRef = `autopilot/archive/${archiveHarness.active.workstream_run}/stale-proof`;
      git(archiveHarness.repo, ['update-ref', `refs/heads/${archiveRef}`, staleSha]);
      await saga.prepare({ ...create, operationType: 'archive', initialWorktreeState: 'active', committedWorktreeState: 'active', intent: { ...create.intent, reason: 'stale archive ref fence witness', base_sha: staleSha, target_sha: intendedSha, archive_ref: archiveRef } });
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
      const main = { ...unit, unitId: 'main', kind: 'main' as const, intent: { ...unit.intent, worktree_path: value.active.main_worktree_path, branch: value.active.branch, reason: 'create conflict main' } };
      await saga.prepare(main);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      await writeFile(join(main.intent.worktree_path, 'src', 'base.ts'), 'export const main = true;\n', 'utf8');
      git(main.intent.worktree_path, ['add', 'src/base.ts']);
      git(main.intent.worktree_path, ['commit', '-m', 'main conflicting change']);
      const mainBase = git(main.intent.worktree_path, ['rev-parse', 'HEAD']);
      const merge = { ...main, operationType: 'merge' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const, intent: { ...main.intent, reason: 'interrupted conflict compensation witness', base_sha: mainBase, target_sha: sourceHead, checkout_mode: null, paths: ['src/base.ts'] } };
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
        initialWorktreeState: 'planned' as const, committedWorktreeState: 'active' as const,
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
        ...mainCreate, operationType: 'merge' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
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
      await saga.prepare({ ...create, operationType: 'remove', initialWorktreeState: 'terminal', committedWorktreeState: 'removed', intent: { ...create.intent, reason: 'exact stale metadata repair witness', target_sha: terminalSha } });
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
        action: () => { git(value.repo, ['worktree', 'add', '-b', spec.intent.branch, spec.intent.worktree_path, value.active.target_base_sha]); },
      };
      const ownedCreate = await executeOwnedWorktreeSaga(spec, callbacks, value.env);
      if (ownedCreate.operation === null) throw new Error('owned create operation missing');
      let unauthorizedActionRan = false;
      const noSessionEnv = { ...value.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: undefined };
      const noSessionSpec = unitCreateSpec(value, 'unit-no-session');
      await assert.rejects(() => executeOwnedWorktreeSaga(noSessionSpec, { action: () => { unauthorizedActionRan = true; } }, noSessionEnv), /coordinator-authoritative run is missing its durable session/u);
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
        action: () => { git(foreign.repo, ['worktree', 'add', '-b', foreignSpec.intent.branch, foreignSpec.intent.worktree_path, foreign.active.target_base_sha]); },
      }, foreign.env);
      await writeFile(join(spec.intent.worktree_path, 'src', 'dirty.ts'), 'dirty\n', 'utf8');
      const removeSpec = { ...spec, operationType: 'remove' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'removed' as const, intent: { ...spec.intent, reason: 'remove terminal unit', target_sha: git(spec.intent.worktree_path, ['rev-parse', 'HEAD']) } };
      await assert.rejects(
        () => executeOwnedWorktreeSaga(removeSpec, { action: () => undefined }, value.env),
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
