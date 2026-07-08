import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { abortAutopilotWorkstream, closeAutopilotWorkstream } from '../../src/core/close-runtime.ts';
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
  process.env[AUTOPILOT_STATE_ROOT_ENV] = join(root, 'autopilot-state');
  try {
    return await run(root);
  } finally {
    if (originalStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
    else process.env[AUTOPILOT_STATE_ROOT_ENV] = originalStateRoot;
    await rm(root, { recursive: true, force: true });
  }
}

interface PreparedCloseFixture {
  readonly source: string;
  readonly worktree: string;
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
    worktree: prepared.mainWorktreePath,
    runtimeRoot: prepared.runtimeRoot,
    workstreamRun: prepared.active.workstream_run,
    repoKey: prepared.active.repo_key,
  };
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
    model: 'openai-codex/gpt-5.5',
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

void describe('Autopilot close runtime', () => {
  void it('lands a validated workstream branch, releases claims, archives runtime, and retires the branch', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      const result = await closeAutopilotWorkstream({ workstream: 'close-smoke', sourceCwd: fixture.source, workstreamRun: fixture.workstreamRun });
      assert.equal(result.outcome, 'closed');
      assert.deepEqual(result.blockers, []);
      assert.deepEqual(result.changed_paths, ['src/smoke.ts']);
      assert.equal(await readFile(join(fixture.source, 'src', 'smoke.ts'), 'utf8'), 'export const smoke = "autopilot";\n');
      assert.equal(existsSync(fixture.worktree), false);
      assert.equal(gitOutput(fixture.source, ['branch', '--list', `autopilot/${fixture.workstreamRun}`]), '');
      assert.match(gitOutput(fixture.source, ['branch', '--list', `autopilot/archive/${fixture.workstreamRun}/main`]), /autopilot\/archive\//u);
      const claims = await readPathClaims(coordinationRootForRepo(fixture.repoKey));
      assert.deepEqual(claims, []);
      if (result.archived_runtime_path === null) throw new Error('missing archive path');
      assert.equal(existsSync(result.archived_runtime_path), true);
      if (result.close_result_path === null) throw new Error('missing close result path');
      assert.equal(existsSync(result.close_result_path), true);
      const rows = await readActiveAutopilots(coordinationRootForRepo(fixture.repoKey));
      assert.equal(rows.find((row) => row.workstream_run === fixture.workstreamRun)?.status, 'closed');
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
      assert.match(gitOutput(fixture.source, ['branch', '--list', `autopilot/archive/${fixture.workstreamRun}/aborted`]), /autopilot\/archive\//u);
      const claims = await readPathClaims(coordinationRootForRepo(fixture.repoKey));
      assert.deepEqual(claims, []);
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
