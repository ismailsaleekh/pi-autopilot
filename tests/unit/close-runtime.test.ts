import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { AUTOPILOT_TERMINAL_CLEANUP_BOUNDARIES, AutopilotCloseError, abortAutopilotWorkstream, closeAutopilotWorkstream } from '../../src/core/close-runtime.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { DurableRunSupervisorClient, readCoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { ensureMainWorktreeSagaRegistered } from '../../src/core/coordination/worktree-saga.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { materializeAutopilotSpecPaths } from '../../src/core/materialization.ts';
import type { AutopilotExecutionAudit, AutopilotExecutionCommit, AutopilotMasterPlan, AutopilotState, AutopilotStatusEntry, AutopilotUnitSpec } from '../../src/core/contracts/index.ts';
import {
  AUTOPILOT_STATE_ROOT_ENV,
  acquireClaimsForUnit,
  coordinationRootForRepo,
  prepareAutopilotUnitWorktree,
  prepareAutopilotWorkstream,
  readActiveAutopilots,
  readPathClaims,
  resolveActiveAutopilotForSpec,
  resolveRepoIdentity,
  updateUnitBranchStatus,
} from '../../src/core/parallel-runtime.ts';

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-close-test-'));
  const originalStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
  const originalSessionContext = process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  process.env[AUTOPILOT_STATE_ROOT_ENV] = join(root, 'autopilot-state');
  try {
    return await run(root);
  } finally {
    if (originalStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
    else process.env[AUTOPILOT_STATE_ROOT_ENV] = originalStateRoot;
    if (originalSessionContext === undefined) delete process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    else process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = originalSessionContext;
    await rm(root, { recursive: true, force: true });
  }
}

interface PreparedCloseFixture {
  readonly source: string;
  readonly taskRoot: string;
  readonly worktree: string;
  readonly unitWorktree: string;
  readonly runtimeRoot: string;
  readonly workstreamRun: string;
  readonly repoKey: string;
}

async function prepareCloseFixture(root: string): Promise<PreparedCloseFixture> {
  const source = join(root, 'source');
  await initGitSource(source);
  const prepared = await prepareAutopilotWorkstream({ workstream: 'close-smoke', sourceCwd: source });
  const unitWorktree = await prepareAutopilotUnitWorktree({ active: prepared.active, unitId: 'u01-implement', attempt: 1 });
  const spec = unitSpec(unitWorktree.unitInfo.worktree_path, prepared.runtimeRoot);
  const activeContext = await resolveActiveAutopilotForSpec(spec);
  await acquireClaimsForUnit({ context: activeContext, spec, reason: 'close-runtime test setup' });
  await materializeAutopilotSpecPaths({ context: activeContext, spec, reason: 'close-runtime test setup materialization' });
  await updateUnitBranchStatus({
    active: prepared.active,
    unitId: 'u01-implement',
    attempt: 1,
    status: 'superseded',
    currentSha: gitOutput(unitWorktree.unitInfo.worktree_path, ['rev-parse', 'HEAD']),
    archiveRef: null,
  });

  const beforeHead = gitOutput(prepared.mainWorktreePath, ['rev-parse', 'HEAD']);
  await writeFile(join(prepared.mainWorktreePath, 'src', 'smoke.ts'), 'export const smoke = "autopilot";\n', 'utf8');
  git(prepared.mainWorktreePath, ['add', 'src/smoke.ts']);
  git(prepared.mainWorktreePath, ['commit', '-m', 'autopilot runtime commit u01-implement attempt 1']);
  const afterHead = gitOutput(prepared.mainWorktreePath, ['rev-parse', 'HEAD']);
  await writeRuntimeClosureArtifacts({
    runtimeRoot: prepared.runtimeRoot,
    worktree: prepared.mainWorktreePath,
    branch: prepared.active.branch,
    workstreamRun: prepared.active.workstream_run,
    autopilotId: prepared.active.autopilot_id,
    beforeHead,
    afterHead,
  });
  return {
    source,
    taskRoot: prepared.taskRoot,
    worktree: prepared.mainWorktreePath,
    unitWorktree: unitWorktree.unitInfo.worktree_path,
    runtimeRoot: prepared.runtimeRoot,
    workstreamRun: prepared.active.workstream_run,
    repoKey: prepared.active.repo_key,
  };
}

async function prepareEmptyCoordinatedFixture(root: string, workstream: string): Promise<{ readonly source: string; readonly taskRoot: string; readonly worktree: string; readonly workstreamRun: string; readonly repoKey: string }> {
  const source = join(root, `source-${workstream}`);
  await initGitSource(source);
  const prepared = await prepareAutopilotWorkstream({ workstream, sourceCwd: source, coordinationSessionId: `bootstrap-${workstream}` });
  const attachment = await new DurableRunSupervisorClient(process.env).attach({ repo: prepared.repo, active: prepared.active, rawSessionId: `active-${workstream}` });
  process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = attachment.contextPath;
  await ensureMainWorktreeSagaRegistered({ active: prepared.active });
  return { source, taskRoot: prepared.taskRoot, worktree: prepared.mainWorktreePath, workstreamRun: prepared.active.workstream_run, repoKey: prepared.active.repo_key };
}

async function commitTestCutover(root: string, repoKey: string): Promise<void> {
  const stateRoot = join(root, 'autopilot-state');
  const legacySource = join(stateRoot, 'coordination', repoKey);
  const legacyArchive = join(stateRoot, 'legacy', repoKey);
  if (existsSync(legacySource)) {
    await mkdir(dirname(legacyArchive), { recursive: true });
    await rename(legacySource, legacyArchive);
  }
  await writeJson(join(stateRoot, 'cutovers', `${repoKey}.json`), {
    schema_version: 'autopilot.coordination_cutover.v1', repo_key: repoKey,
    snapshot_sha256: `sha256:${'a'.repeat(64)}`, database_sha256: `sha256:${'b'.repeat(64)}`,
    committed_at: '2026-07-12T00:00:00.000Z', migration_id: `test-cutover-${repoKey.slice(-12)}`,
  });
}

function unitSpec(worktree: string, runtimeRoot: string): AutopilotUnitSpec {
  return {
    schema_version: 'autopilot.unit_spec.v1',
    workstream: 'close-smoke',
    unit_id: 'u01-implement',
    role: 'implement',
    template: 'implement',
    attempt: 1,
    objective: 'Implement close smoke change.',
    cwd: worktree,
    model: 'openai-codex/gpt-5.6-terra',
    thinking: 'high',
    owned_paths: ['src/smoke.ts'],
    read_only_paths: [],
    untouchable_paths: ['private/**'],
    context_refs: [
      { path: '.pi/autopilot/close-smoke/mission.md', purpose: 'mission' },
      { path: '.pi/autopilot/close-smoke/master-plan.json', purpose: 'master plan' },
    ],
    validation_commands: [],
    status_output: join(runtimeRoot, 'statuses', 'u01-implement.implement.attempt-1.json'),
    receipt_output: join(runtimeRoot, 'receipts', 'u01-implement.implement.attempt-1.receipt.json'),
    evidence_dir: join(runtimeRoot, 'evidence', 'u01-implement'),
    stop_boundary: 'Edit only src/smoke.ts.',
    quality_profile: 'source-change',
    risk_level: 'medium',
    acceptance_criteria: ['source change is present'],
    verification_plan: emptyVerificationPlan(),
    closure_criteria: ['independent validation passed'],
    upstream_refs: [],
  };
}

function emptyVerificationPlan(): NonNullable<AutopilotUnitSpec['verification_plan']> {
  return {
    positive_witnesses: [],
    negative_witnesses: [],
    regression_witnesses: [],
    real_boundary_witnesses: [],
    blast_radius_checks: [],
    docs_schema_prompt_checks: [],
    dirty_tree_checks: [],
  };
}

async function writeRuntimeClosureArtifacts(input: {
  readonly runtimeRoot: string;
  readonly worktree: string;
  readonly branch: string;
  readonly workstreamRun: string;
  readonly autopilotId: string;
  readonly beforeHead: string;
  readonly afterHead: string;
}): Promise<void> {
  await mkdir(join(input.runtimeRoot, 'statuses'), { recursive: true });
  await mkdir(join(input.runtimeRoot, 'execution-audits'), { recursive: true });
  await mkdir(join(input.runtimeRoot, 'execution-commits'), { recursive: true });
  const implementStatus: AutopilotStatusEntry = {
    schema_version: 'autopilot.status.v1',
    workstream: 'close-smoke',
    unit_id: 'u01-implement',
    role: 'implement',
    attempt: 1,
    verdict: 'DONE',
    severity: 'clean',
    summary: 'Implemented close smoke change.',
    changed_paths: ['src/smoke.ts'],
    findings: [],
    commands: [],
    evidence_refs: [],
    report_ref: null,
    next_action: 'validate',
  };
  const validateStatus: AutopilotStatusEntry = {
    schema_version: 'autopilot.status.v1',
    workstream: 'close-smoke',
    unit_id: 'v01-validate',
    role: 'validate',
    attempt: 1,
    verdict: 'PASS',
    severity: 'clean',
    summary: 'Independent validation passed.',
    changed_paths: [],
    findings: [],
    commands: [{ command: 'npm test', status: 'passed', exit_code: 0, summary: 'passed' }],
    evidence_refs: [],
    report_ref: null,
    next_action: 'close',
  };
  const audit: AutopilotExecutionAudit = {
    schema_version: 'autopilot.execution_audit.v1',
    workstream: 'close-smoke',
    unit_id: 'u01-implement',
    role: 'implement',
    attempt: 1,
    audited_at: '2026-07-03T00:00:00.000Z',
    cwd: input.worktree,
    git_head: input.beforeHead,
    dirty_baseline: false,
    dirty_baseline_paths: [],
    dirty_relevant_paths: [],
    actual_changed_paths: ['src/smoke.ts'],
    status_reported_changed_paths: ['src/smoke.ts'],
    omitted_status_changes: [],
    reported_but_not_actual_changes: [],
    outside_owned_paths: [],
    read_only_touched_paths: [],
    untouchable_touched_paths: [],
    path_counts: {
      dirty_baseline_paths: 0,
      dirty_relevant_paths: 0,
      actual_changed_paths: 1,
      status_reported_changed_paths: 1,
      omitted_status_changes: 0,
      reported_but_not_actual_changes: 0,
      outside_owned_paths: 0,
      read_only_touched_paths: 0,
      untouchable_touched_paths: 0,
    },
    truncated_path_sets: [],
    declared_validation_commands: [],
    status_reported_commands: [],
    command_coverage_gaps: [],
    classification: 'clean',
    evidence_refs: [],
    summary: 'Execution audit is clean.',
  };
  const executionCommit: AutopilotExecutionCommit = {
    schema_version: 'autopilot.execution_commit.v1',
    workstream: 'close-smoke',
    workstream_run: input.workstreamRun,
    autopilot_id: input.autopilotId,
    active_run_epoch: 1,
    unit_id: 'u01-implement',
    role: 'implement',
    attempt: 1,
    cwd: input.worktree,
    branch: input.branch,
    claimed_paths: ['src/smoke.ts'],
    edited_claimed_paths: ['src/smoke.ts'],
    before_head: input.beforeHead,
    after_head: input.afterHead,
    commit_sha: input.afterHead,
    commit_subject: 'autopilot runtime commit u01-implement attempt 1',
    status_ref: 'statuses/u01-implement.implement.attempt-1.json',
    receipt_ref: 'receipts/u01-implement.implement.attempt-1.receipt.json',
    audit_ref: 'execution-audits/u01-implement.implement.attempt-1.json',
    created_at: '2026-07-03T00:00:01.000Z',
  };
  const state: AutopilotState = {
    schema_version: 'autopilot.state.v1',
    workstream: 'close-smoke',
    updated_at: '2026-07-03T00:00:02.000Z',
    status: 'completed',
    context_gate: { gate: 'ok', percent: 10 },
    last_event_id: 0,
    ready_queue: [],
    running: [],
    blocked: [],
    completed: ['u01-implement', 'v01-validate'],
    units: {
      'u01-implement': {
        unit_id: 'u01-implement',
        role: 'implement',
        state: 'completed',
        attempt: 1,
        status_ref: 'statuses/u01-implement.implement.attempt-1.json',
        summary: 'implemented',
      },
      'v01-validate': {
        unit_id: 'v01-validate',
        role: 'validate',
        state: 'completed',
        attempt: 1,
        status_ref: 'statuses/v01-validate.validate.attempt-1.json',
        summary: 'validated',
      },
    },
    operator_questions: [],
    next_actions: [],
    work_items: {
      'w01-smoke': {
        work_item_id: 'w01-smoke',
        state: 'closed',
        source_changing: true,
        unit_ids: ['u01-implement', 'v01-validate'],
        implementation_unit_id: 'u01-implement',
        validation_unit_id: 'v01-validate',
        audit_ref: 'execution-audits/u01-implement.implement.attempt-1.json',
        status_ref: 'statuses/u01-implement.implement.attempt-1.json',
        validation_status_ref: 'statuses/v01-validate.validate.attempt-1.json',
        summary: 'smoke change closed',
      },
    },
    audit_review_queue: [],
    validation_ready_queue: [],
    scope_exceptions: [],
    protected_path_exceptions: [],
    closure_gate: { status: 'passed', blocking_reasons: [], summary: 'passed' },
  };
  const masterPlan: AutopilotMasterPlan = {
    schema_version: 'autopilot.master_plan.v1',
    workstream: 'close-smoke',
    mission_ref: 'mission.md',
    goal_summary: 'Close smoke workstream.',
    non_goals: [],
    definition_of_done: ['source change merged'],
    risk_level: 'low',
    lanes: [{ lane_id: 'main', summary: 'main lane', unit_ids: ['u01-implement', 'v01-validate'] }],
    units: {
      'u01-implement': { unit_id: 'u01-implement', role: 'implement', state: 'completed', dependencies: [], summary: 'implement' },
      'v01-validate': { unit_id: 'v01-validate', role: 'validate', state: 'completed', dependencies: ['u01-implement'], summary: 'validate' },
    },
    ownership_matrix: {
      owned_paths: ['src/smoke.ts'],
      read_only_paths: [],
      untouchable_paths: ['private/**'],
      held_paths: ['src/smoke.ts'],
    },
    verification_matrix: emptyVerificationPlan(),
    closure_criteria: ['validation passed'],
    current_focus: 'close',
    last_decision_id: 0,
    last_event_id: 0,
    updated_at: '2026-07-03T00:00:02.000Z',
  };
  await writeJson(join(input.runtimeRoot, 'statuses', 'u01-implement.implement.attempt-1.json'), implementStatus);
  await writeJson(join(input.runtimeRoot, 'statuses', 'v01-validate.validate.attempt-1.json'), validateStatus);
  await writeJson(join(input.runtimeRoot, 'execution-audits', 'u01-implement.implement.attempt-1.json'), audit);
  await writeJson(join(input.runtimeRoot, 'execution-commits', 'u01-implement.implement.attempt-1.json'), executionCommit);
  await writeJson(join(input.runtimeRoot, 'state.json'), state);
  await writeJson(join(input.runtimeRoot, 'master-plan.json'), masterPlan);
  await writeFile(join(input.runtimeRoot, 'mission.md'), '# Mission\n\nClose smoke.\n', 'utf8');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function initGitSource(source: string): Promise<void> {
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, '.gitignore'), '.pi/\n', 'utf8');
  await writeFile(join(source, 'src', 'smoke.ts'), 'export const smoke = "baseline";\n', 'utf8');
  git(source, ['init']);
  git(source, ['config', 'user.email', 'autopilot@example.invalid']);
  git(source, ['config', 'user.name', 'Autopilot Test']);
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'baseline']);
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function gitOutput(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitWorktreeListContains(cwd: string, worktreePath: string): boolean {
  const expected = normalizeTestPath(worktreePath);
  return gitOutput(cwd, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => normalizeTestPath(line.slice('worktree '.length)))
    .some((path) => path === expected);
}

function normalizeTestPath(path: string): string {
  if (!existsSync(path)) return path;
  return realpathSync(path);
}

void describe('Autopilot close runtime', () => {
  void it('lands a validated workstream branch, releases claims, archives runtime, and retires the branch', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      const coordinator = await startCoordinatorServer(coordinatorRuntimePaths(process.env));
      try {
        const active = (await readActiveAutopilots(coordinationRootForRepo(fixture.repoKey))).find((row) => row.workstream_run === fixture.workstreamRun);
        if (active === undefined) throw new Error('active run missing');
        const attachment = await new DurableRunSupervisorClient(process.env).attach({ repo: resolveRepoIdentity(fixture.source), active, rawSessionId: 'close-runtime-coordinated-test' });
        process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = attachment.contextPath;
        await ensureMainWorktreeSagaRegistered({ active });
        const result = await closeAutopilotWorkstream({ workstream: 'close-smoke', sourceCwd: fixture.source, workstreamRun: fixture.workstreamRun });
        assert.equal(result.outcome, 'closed');
        assert.deepEqual(result.blockers, []);
        assert.deepEqual(result.changed_paths, ['src/smoke.ts']);
        assert.equal(await readFile(join(fixture.source, 'src', 'smoke.ts'), 'utf8'), 'export const smoke = "autopilot";\n');
        assert.equal(existsSync(fixture.worktree), false);
        assert.equal(existsSync(fixture.unitWorktree), false);
        assert.equal(existsSync(fixture.taskRoot), false);
        assert.equal(gitWorktreeListContains(fixture.source, fixture.worktree), false);
        assert.equal(gitWorktreeListContains(fixture.source, fixture.unitWorktree), false);
        assert.equal(gitOutput(fixture.source, ['branch', '--list', `autopilot/${fixture.workstreamRun}`]), '');
        assert.match(gitOutput(fixture.source, ['branch', '--list', `autopilot/archive/${fixture.workstreamRun}/main`]), /autopilot\/archive\//u);
        const claims = await readPathClaims(coordinationRootForRepo(fixture.repoKey));
        assert.deepEqual(claims, []);
        if (result.archived_runtime_path === null) throw new Error('missing archive path');
        assert.equal(existsSync(result.archived_runtime_path), true);
        const s2Binding = JSON.parse(await readFile(join(result.archived_runtime_path, 'close', '_s2-terminal-retention.json'), 'utf8')) as Readonly<Record<string, unknown>>;
        assert.equal(s2Binding['schema_version'], 'autopilot.s2_retention.terminal_binding.v1');
        assert.equal(s2Binding['repo_id'], fixture.repoKey);
        assert.equal(s2Binding['workstream_run'], fixture.workstreamRun);
        assert.equal(s2Binding['terminal_kind'], 'closed');
        assert.equal(s2Binding['hot_eligible'], true);
        assert.equal(existsSync(join(root, 'autopilot-state', 'worktrees', fixture.repoKey, '_retention', 'cold')), true);
        assert.equal(existsSync(join(root, 'autopilot-state', 'worktrees', fixture.repoKey, '_retention', 'hot')), true);
        if (result.close_result_path === null) throw new Error('missing close result path');
        assert.equal(existsSync(result.close_result_path), true);
        const rows = await readActiveAutopilots(coordinationRootForRepo(fixture.repoKey));
        assert.equal(rows.find((row) => row.workstream_run === fixture.workstreamRun)?.status, 'closed');
      } finally { await coordinator.close(); }
    });
  });

  void it('rejects an external runtime symlink before terminal commit and never archives external bytes', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      const secret = join(root, 'external-secret.txt');
      await writeFile(secret, 'must-never-enter-terminal-archive\n', 'utf8');
      await symlink(secret, join(fixture.runtimeRoot, 'external-link'));
      await assert.rejects(
        () => closeAutopilotWorkstream({ workstream: 'close-smoke', sourceCwd: fixture.source, workstreamRun: fixture.workstreamRun }),
        (error: unknown) => error instanceof AutopilotCloseError && /symbolic link/u.test(error.message),
      );
      const archive = join(root, 'autopilot-state', 'worktrees', fixture.repoKey, '_archive', fixture.workstreamRun, 'runtime', 'external-link');
      assert.equal(existsSync(archive), false);
      assert.equal(await readFile(join(fixture.source, 'src', 'smoke.ts'), 'utf8'), 'export const smoke = "baseline";\n');
    });
  });

  void it('rejects a pre-existing _archive symlink before terminal commit without touching its target', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      const archiveParent = join(root, 'autopilot-state', 'worktrees', fixture.repoKey, '_archive');
      const external = join(root, 'external-archive-target');
      await rm(archiveParent, { recursive: true, force: true });
      await mkdir(external, { recursive: true });
      await writeFile(join(external, 'sentinel'), 'unchanged\n', 'utf8');
      await symlink(external, archiveParent, 'dir');
      await assert.rejects(
        () => closeAutopilotWorkstream({ workstream: 'close-smoke', sourceCwd: fixture.source, workstreamRun: fixture.workstreamRun }),
        (error: unknown) => error instanceof AutopilotCloseError && /archive|symbolic/u.test(error.message),
      );
      assert.equal(await readFile(join(external, 'sentinel'), 'utf8'), 'unchanged\n');
      assert.equal((await readActiveAutopilots(coordinationRootForRepo(fixture.repoKey))).find((row) => row.workstream_run === fixture.workstreamRun)?.status, 'blocked');
    });
  });

  void it('rejects a raced final archive symlink before terminal commit and never overwrites it', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      const external = join(root, 'raced-archive-target');
      await mkdir(external, { recursive: true });
      await writeFile(join(external, 'sentinel'), 'unchanged\n', 'utf8');
      const finalArchive = join(root, 'autopilot-state', 'worktrees', fixture.repoKey, '_archive', fixture.workstreamRun);
      await assert.rejects(
        () => closeAutopilotWorkstream({
          workstream: 'close-smoke', sourceCwd: fixture.source, workstreamRun: fixture.workstreamRun,
          observeCloseRaceBoundary: async (boundary) => { if (boundary === 'after-private-archive-staging-before-terminal-commit') await symlink(external, finalArchive, 'dir'); },
        }),
        (error: unknown) => error instanceof AutopilotCloseError && /archive|symbolic/u.test(error.message),
      );
      assert.equal(await readFile(join(external, 'sentinel'), 'utf8'), 'unchanged\n');
      assert.equal((await readActiveAutopilots(coordinationRootForRepo(fixture.repoKey))).find((row) => row.workstream_run === fixture.workstreamRun)?.status, 'blocked');
    });
  });

  void it('rejects a runtime symlink loop before abort terminal commit', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      await symlink('..', join(fixture.runtimeRoot, 'loop'));
      await assert.rejects(
        () => abortAutopilotWorkstream({ workstream: 'close-smoke', sourceCwd: fixture.source, workstreamRun: fixture.workstreamRun }),
        (error: unknown) => error instanceof AutopilotCloseError && /symbolic link|loop/u.test(error.message),
      );
      assert.equal(existsSync(join(root, 'autopilot-state', 'worktrees', fixture.repoKey, '_archive', fixture.workstreamRun)), false);
    });
  });

  void it('aborts an abandoned workstream without merging and releases retained claims', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      const result = await abortAutopilotWorkstream({ workstream: 'close-smoke', sourceCwd: fixture.source, workstreamRun: fixture.workstreamRun });
      assert.equal(result.outcome, 'aborted');
      assert.deepEqual(result.blockers, []);
      assert.equal(await readFile(join(fixture.source, 'src', 'smoke.ts'), 'utf8'), 'export const smoke = "baseline";\n');
      assert.equal(existsSync(fixture.worktree), false);
      assert.equal(existsSync(fixture.unitWorktree), false);
      assert.equal(existsSync(fixture.taskRoot), false);
      assert.equal(gitWorktreeListContains(fixture.source, fixture.worktree), false);
      assert.equal(gitWorktreeListContains(fixture.source, fixture.unitWorktree), false);
      assert.match(gitOutput(fixture.source, ['branch', '--list', `autopilot/archive/${fixture.workstreamRun}/aborted`]), /autopilot\/archive\//u);
      const claims = await readPathClaims(coordinationRootForRepo(fixture.repoKey));
      assert.deepEqual(claims, []);
    });
  });

  for (const action of ['close', 'abort'] as const) void it(`${action} durably fences a concurrent launch while validation is paused`, async () => {
    await withTempDir(async (root) => {
      const coordinator = await startCoordinatorServer(coordinatorRuntimePaths(process.env));
      try {
        const fixture = await prepareEmptyCoordinatedFixture(root, `fenced-${action}`);
        await commitTestCutover(root, fixture.repoKey);
        const contextPath = process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
        if (contextPath === undefined) throw new Error('missing durable close session');
        const context = await readCoordinatorSessionContext(contextPath);
        let releaseValidation!: () => void;
        let reportFenced!: () => void;
        const fenced = new Promise<void>((resolveFenced) => { reportFenced = resolveFenced; });
        const resume = new Promise<void>((resolveResume) => { releaseValidation = resolveResume; });
        const operation = (action === 'close' ? closeAutopilotWorkstream : abortAutopilotWorkstream)({
          workstream: `fenced-${action}`,
          sourceCwd: fixture.source,
          workstreamRun: fixture.workstreamRun,
          observeCloseRaceBoundary: async () => { reportFenced(); await resume; },
        });
        await fenced;
        const client = new CoordinatorClient({ env: process.env, autoStart: false });
        const status = await client.query('status', fixture.repoKey, fixture.workstreamRun);
        const run = (status.payload['runs'] as readonly Readonly<Record<string, unknown>>[])[0];
        assert.equal(run?.['status'], 'merging', 'durable coordinator state must expose the validation fence');
        await assert.rejects(() => client.mutate('register-attempt', {
          repoId: fixture.repoKey,
          workstreamRun: fixture.workstreamRun,
          sessionId: context.session_id,
          fencingGeneration: context.session_generation,
          expectedVersion: Number(run?.['version']),
          idempotencyKey: `paused-validation-launch-${action}`,
        }, {
          unit_id: `late-${action}`, attempt: 1, checkpoint_ordinal: 0, role: 'implement',
          spec_ref: `unit-specs/late-${action}.json`, spec_sha256: `sha256:${'c'.repeat(64)}`,
          preemptible: true, session_lease_id: context.session_lease_id, session_token: context.session_token,
        }), /terminal preparation fences new attempt dispatch/u);
        releaseValidation();
        await operation;
      } finally { await coordinator.close(); }
    });
  });

  void it('resumes fenced post-cutover terminal cleanup without resurrecting dispatch or touching a foreign run', async () => {
    await withTempDir(async (root) => {
      const coordinator = await startCoordinatorServer(coordinatorRuntimePaths(process.env));
      try {
        const closing = await prepareEmptyCoordinatedFixture(root, 'terminal-close');
        const foreign = await prepareAutopilotWorkstream({ workstream: 'foreign-run', sourceCwd: closing.source, coordinationSessionId: 'foreign-bootstrap' });
        const foreignAttachment = await new DurableRunSupervisorClient(process.env).attach({ repo: foreign.repo, active: foreign.active, rawSessionId: 'foreign-active' });
        await ensureMainWorktreeSagaRegistered({ active: foreign.active, env: { ...process.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: foreignAttachment.contextPath } });
        const closingActive = (await readActiveAutopilots(coordinationRootForRepo(closing.repoKey))).find((row) => row.workstream_run === closing.workstreamRun);
        if (closingActive === undefined) throw new Error('closing active row missing');
        const closingAttachment = await new DurableRunSupervisorClient(process.env).attach({ repo: resolveRepoIdentity(closing.source), active: closingActive, rawSessionId: 'closing-current' });
        process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = closingAttachment.contextPath;
        await commitTestCutover(root, closing.repoKey);
        await assert.rejects(
          () => closeAutopilotWorkstream({
            workstream: 'terminal-close', sourceCwd: closing.source, workstreamRun: closing.workstreamRun,
            observeTerminalCleanupBoundary: (boundary) => { if (boundary === 'after-terminal-commit') throw new Error('simulated post-terminal process death'); },
          }),
          (error: unknown) => error instanceof AutopilotCloseError && error.code === 'terminal-cleanup-recovery-required',
        );
        delete process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
        const replacement = await prepareAutopilotWorkstream({ workstream: 'terminal-close', sourceCwd: closing.source, coordinationSessionId: 'replacement-activation' });
        assert.notEqual(replacement.active.workstream_run, closing.workstreamRun);
        assert.equal(replacement.active.status, 'active');
        assert.equal(existsSync(closing.taskRoot), false);
        assert.equal(existsSync(join(root, 'autopilot-state', 'worktrees', closing.repoKey, '_archive', closing.workstreamRun, '_close-result.json')), true);
        assert.equal(existsSync(foreign.mainWorktreePath), true);
        const status = await new CoordinatorClient({ env: process.env, autoStart: false }).query('status', closing.repoKey, null);
        const runs = status.payload['runs'];
        if (!Array.isArray(runs)) throw new Error('coordinator runs missing');
        const terminal = runs.find((entry) => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['workstream_run'] === closing.workstreamRun) as Record<string, unknown> | undefined;
        const foreignRun = runs.find((entry) => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['workstream_run'] === foreign.active.workstream_run) as Record<string, unknown> | undefined;
        assert.equal(terminal?.['status'], 'closed');
        assert.equal(foreignRun?.['status'], 'active');
        const sessions = status.payload['session_leases'];
        if (!Array.isArray(sessions)) throw new Error('coordinator sessions missing');
        const terminalSessions = sessions.filter((entry) => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['workstream_run'] === closing.workstreamRun) as Record<string, unknown>[];
        assert.equal(terminalSessions.filter((entry) => entry['status'] === 'attached').length, 0);
        assert.equal(terminalSessions.some((entry) => entry['status'] === 'fenced'), true);
        const recoveryGeneration = Math.max(...terminalSessions.map((entry) => Number(entry['session_generation'])));
        assert.equal(terminalSessions.find((entry) => entry['session_generation'] === recoveryGeneration)?.['status'], 'detached');
        assert.equal(AUTOPILOT_TERMINAL_CLEANUP_BOUNDARIES.includes('after-terminal-commit'), true);
      } finally {
        await coordinator.close();
      }
    });
  });

  void it('blocks close when the target branch changed retained claimed paths', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      await writeFile(join(fixture.source, 'src', 'smoke.ts'), 'export const smoke = "manual target change";\n', 'utf8');
      git(fixture.source, ['add', 'src/smoke.ts']);
      git(fixture.source, ['commit', '-m', 'manual target change']);
      const result = await closeAutopilotWorkstream({ workstream: 'close-smoke', sourceCwd: fixture.source, workstreamRun: fixture.workstreamRun });
      assert.equal(result.outcome, 'blocked');
      assert.equal(result.blockers.some((blocker) => /target branch changed retained claimed path/.test(blocker)), true);
      assert.equal(existsSync(fixture.worktree), true);
      const repo = resolveRepoIdentity(fixture.source);
      const rows = await readActiveAutopilots(coordinationRootForRepo(repo.repoKey));
      assert.equal(rows.find((row) => row.workstream_run === fixture.workstreamRun)?.status, 'blocked');
      const claims = await readPathClaims(coordinationRootForRepo(repo.repoKey));
      assert.equal(claims.length > 0, true);
    });
  });
});
