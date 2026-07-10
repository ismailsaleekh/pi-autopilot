import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  AUTOPILOT_STATUS_CHANGED_PATHS_LIMIT,
  parseAutopilotExecutionAudit,
  parseAutopilotStatusEntry,
  type AutopilotMasterPlan,
  type AutopilotState,
  type AutopilotStatusEntry,
  type AutopilotUnitSpec,
  type AutopilotVerificationPlan,
} from '../../src/core/contracts/index.ts';
import {
  buildAutopilotExecutionAudit,
  captureAutopilotExecutionBaseline,
  deriveAutopilotExecutionAuditPath,
  writeAutopilotExecutionAudit,
} from '../../src/core/execution-audit/index.ts';
import { assertAutopilotSpecQualityGate } from '../../src/core/quality/spec-gate.ts';
import {
  appendAutopilotDecisionRow,
  readAutopilotPurposeSnapshot,
  readAutopilotResumeSnapshot,
  writeAutopilotMasterPlanAtomic,
  writeAutopilotStateAtomic,
} from '../../src/core/state-store/index.ts';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-quality-vnext-test-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function generatedChangedPaths(count: number): readonly string[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) => `src/generated/file-${String(index).padStart(4, '0')}.ts`),
  );
}

function verificationPlan(command = 'npm test'): AutopilotVerificationPlan {
  return {
    positive_witnesses: [
      {
        id: 'positive-command',
        command,
        expected_signal: 'command exits zero',
        required: true,
      },
    ],
    negative_witnesses: [],
    regression_witnesses: [],
    real_boundary_witnesses: [],
    blast_radius_checks: [],
    docs_schema_prompt_checks: [],
    dirty_tree_checks: [],
  };
}

function sourceSpec(root: string, overrides: Partial<AutopilotUnitSpec> = {}): AutopilotUnitSpec {
  const worktree = join(root, 'worktree');
  const runtimeRoot = join(worktree, '.pi', 'autopilot', 'quality-demo');
  return {
    schema_version: 'autopilot.unit_spec.v1',
    workstream: 'quality-demo',
    unit_id: 'u01-implement',
    role: 'implement',
    template: 'implement',
    attempt: 1,
    objective: 'Implement a quality-gated change.',
    cwd: worktree,
    model: 'openai-codex/gpt-5.6-terra',
    thinking: 'high',
    owned_paths: ['src/owned.ts'],
    read_only_paths: ['README.md'],
    untouchable_paths: ['private/**'],
    context_refs: [
      { path: '.pi/autopilot/quality-demo/mission.md', purpose: 'Durable mission truth' },
      { path: '.pi/autopilot/quality-demo/master-plan.json', purpose: 'Durable master plan truth' },
    ],
    validation_commands: [],
    status_output: join(runtimeRoot, 'statuses', 'u01-implement.implement.attempt-1.json'),
    receipt_output: join(runtimeRoot, 'receipts', 'u01-implement.implement.attempt-1.receipt.json'),
    evidence_dir: join(runtimeRoot, 'evidence', 'u01-implement'),
    stop_boundary: 'Edit only owned source.',
    quality_profile: 'source-change',
    risk_level: 'medium',
    acceptance_criteria: ['root-cause source change is complete'],
    verification_plan: verificationPlan(),
    closure_criteria: ['independent validation passes'],
    upstream_refs: [],
    timeout_seconds: 60,
    render_prompt_snapshot: true,
    ...overrides,
  };
}

function validateSpec(root: string): AutopilotUnitSpec {
  const worktree = join(root, 'worktree');
  const runtimeRoot = join(worktree, '.pi', 'autopilot', 'quality-demo');
  return {
    ...sourceSpec(root),
    unit_id: 'u02-validate',
    role: 'validate',
    template: 'validate',
    objective: 'Validate the quality-gated change.',
    model: 'openai-codex/gpt-5.6-sol',
    thinking: 'xhigh',
    owned_paths: [],
    read_only_paths: ['src/owned.ts'],
    validation_commands: ['npm test'],
    status_output: join(runtimeRoot, 'statuses', 'u02-validate.validate.attempt-1.json'),
    receipt_output: join(runtimeRoot, 'receipts', 'u02-validate.validate.attempt-1.receipt.json'),
    evidence_dir: join(runtimeRoot, 'evidence', 'u02-validate'),
    quality_profile: 'validation-only',
    risk_level: 'low',
    acceptance_criteria: ['validation covers declared command'],
    verification_plan: verificationPlan('npm test'),
    closure_criteria: ['validator PASS is clean'],
  };
}

function passingStatus(spec: AutopilotUnitSpec): AutopilotStatusEntry {
  return {
    schema_version: 'autopilot.status.v1',
    workstream: spec.workstream,
    unit_id: spec.unit_id,
    role: spec.role,
    attempt: spec.attempt,
    verdict: spec.role === 'validate' || spec.role === 'bughunt' ? 'PASS' : 'DONE',
    severity: 'clean',
    summary: 'Quality status passed.',
    changed_paths: spec.role === 'implement' || spec.role === 'fix' ? ['src/owned.ts'] : [],
    findings: [],
    commands: spec.validation_commands.map((command) => ({
      command,
      status: 'passed',
      exit_code: 0,
      summary: 'command passed',
    })),
    evidence_refs: [],
    report_ref: null,
    covered_witness_ids: spec.role === 'validate' || spec.role === 'bughunt' ? ['positive-command'] : [],
    next_action: 'continue quality workflow',
  };
}

function masterPlan(worktree: string): AutopilotMasterPlan {
  return {
    schema_version: 'autopilot.master_plan.v1',
    workstream: 'quality-demo',
    mission_ref: 'mission.md',
    goal_summary: 'Prove durable purpose state.',
    non_goals: ['no live provider call'],
    definition_of_done: ['quality gate passes'],
    risk_level: 'medium',
    lanes: [{ lane_id: 'lane-1', summary: 'quality lane', unit_ids: ['u01-implement'] }],
    units: {
      'u01-implement': {
        unit_id: 'u01-implement',
        role: 'implement',
        state: 'ready',
        dependencies: [],
        summary: 'implement quality state',
      },
    },
    ownership_matrix: {
      owned_paths: ['src/owned.ts'],
      read_only_paths: ['README.md'],
      untouchable_paths: ['private/**'],
      held_paths: [],
    },
    verification_matrix: verificationPlan(),
    closure_criteria: ['state and purpose validate'],
    current_focus: worktree,
    last_decision_id: 1,
    last_event_id: 0,
    updated_at: '2026-07-02T00:00:00.000Z',
  };
}

function missionText(): string {
  return [
    '# Quality Demo Mission',
    '## Goal',
    'Prove durable purpose truth.',
    '## Non-goals / exclusions',
    'No live provider call.',
    '## Perfect-quality bar',
    'No band-aids or fake-green closure.',
    '## Definition of done',
    'State, plan, and decisions validate.',
    '## Key constraints',
    'Offline only.',
    '## Current strategy summary',
    'Use package-owned purpose state.',
    '## Open questions',
    'None.',
  ].join('\n');
}

function git(root: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function initGitWorktree(worktree: string): Promise<void> {
  await mkdir(join(worktree, 'src'), { recursive: true });
  await mkdir(join(worktree, 'private'), { recursive: true });
  await writeFile(join(worktree, 'src', 'owned.ts'), 'export const value = 1;\n', 'utf8');
  await writeFile(join(worktree, 'README.md'), '# read only\n', 'utf8');
  await writeFile(join(worktree, '.gitignore'), '.pi/\n', 'utf8');
  git(worktree, ['init']);
  git(worktree, ['config', 'user.email', 'autopilot@example.invalid']);
  git(worktree, ['config', 'user.name', 'Autopilot Test']);
  git(worktree, ['add', '.']);
  git(worktree, ['commit', '-m', 'baseline']);
}

void describe('Autopilot Quality vNext gates', () => {
  void it('rejects weak unit specs before child launch', async () => {
    await withTempDir(async (root) => {
      const strong = sourceSpec(root);
      assertAutopilotSpecQualityGate(strong);
      const weak = { ...strong };
      delete weak.quality_profile;
      delete weak.risk_level;
      delete weak.acceptance_criteria;
      delete weak.verification_plan;
      delete weak.closure_criteria;
      assert.throws(
        () => assertAutopilotSpecQualityGate(weak),
        /quality_profile is required/u,
      );
      assert.throws(
        () =>
          assertAutopilotSpecQualityGate({
            ...strong,
            context_refs: [],
          }),
        /mission.md/u,
      );
      assert.throws(
        () => assertAutopilotSpecQualityGate({ ...validateSpec(root), context_refs: [] }),
        /non-strategy specs must include mission.md/u,
      );
    });
  });

  void it('rejects fake-green success statuses', async () => {
    await withTempDir(async (root) => {
      const implementSpec = sourceSpec(root, { validation_commands: ['npm test'] });
      const failedDone = passingStatus(implementSpec);
      assert.throws(
        () =>
          parseAutopilotStatusEntry(
            {
              ...failedDone,
              commands: [
                { command: 'npm test', status: 'failed', exit_code: 1, summary: 'failed command' },
              ],
            },
            { unitSpec: implementSpec },
          ),
        /DONE statuses must not include failed commands/u,
      );

      const validationSpec = validateSpec(root);
      const missingCoverage = passingStatus(validationSpec);
      assert.throws(
        () =>
          parseAutopilotStatusEntry(
            { ...missingCoverage, commands: [], covered_witness_ids: [] },
            { unitSpec: validationSpec },
          ),
        /declared validation command/u,
      );
      assert.throws(
        () =>
          parseAutopilotStatusEntry(
            {
              ...missingCoverage,
              commands: [{ command: 'npm test', status: 'not-run', exit_code: null, summary: 'skipped' }],
              covered_witness_ids: ['positive-command'],
            },
            { unitSpec: validationSpec },
          ),
        /PASS statuses must report passed for every command summary/u,
      );
      assert.throws(
        () =>
          parseAutopilotStatusEntry(
            { ...missingCoverage, covered_witness_ids: ['positive-command', 'ghost-witness'] },
            { unitSpec: validationSpec },
          ),
        /unknown witness id/u,
      );

      const nonMechanical = {
        ...validationSpec,
        risk_level: 'medium' as const,
        thinking: 'xhigh' as const,
        verification_plan: {
          ...verificationPlan('npm test'),
          positive_witnesses: [
            {
              id: 'inspection-witness',
              inspection_target: 'src/owned.ts',
              expected_signal: 'source change is correct',
              required: true,
            },
          ],
        },
      };
      assert.throws(
        () =>
          parseAutopilotStatusEntry(
            { ...passingStatus(nonMechanical), covered_witness_ids: ['inspection-witness'] },
            { unitSpec: nonMechanical },
          ),
        /requires evidence_refs or report_ref/u,
      );
    });
  });
});

void describe('Autopilot purpose state', () => {
  void it('loads mission, master-plan, and decisions before resume state', async () => {
    await withTempDir(async (root) => {
      const worktree = join(root, 'worktree');
      const runtimeRoot = join(worktree, '.pi', 'autopilot', 'quality-demo');
      await mkdir(runtimeRoot, { recursive: true });
      await writeFile(join(runtimeRoot, 'mission.md'), `${missionText()}\n`, 'utf8');
      await appendAutopilotDecisionRow({
        decisionLogPath: join(runtimeRoot, 'decision-log.jsonl'),
        decision: {
          schema_version: 'autopilot.decision.v1',
          id: 1,
          ts: '2026-07-02T00:00:00.000Z',
          event: 'master_plan_created',
          workstream: 'quality-demo',
          summary: 'Master plan created.',
          decision: 'Use durable purpose truth before queue state.',
          master_plan_ref: 'master-plan.json',
        },
      });
      await writeAutopilotMasterPlanAtomic({
        masterPlanPath: join(runtimeRoot, 'master-plan.json'),
        masterPlan: masterPlan(worktree),
      });
      const purpose = await readAutopilotPurposeSnapshot({ root: runtimeRoot, requirePurpose: true });
      assert.equal(purpose.mission?.sections.includes('Goal'), true);
      assert.equal(purpose.masterPlan?.last_decision_id, 1);
      assert.equal(purpose.decisionsTail.length, 1);

      const noUnits: AutopilotState['units'] = Object.freeze({});
      const state: AutopilotState = {
        schema_version: 'autopilot.state.v1',
        workstream: 'quality-demo',
        updated_at: '2026-07-02T00:00:00.000Z',
        status: 'running',
        context_gate: { gate: 'ok', percent: 10 },
        last_event_id: 0,
        ready_queue: [],
        running: [],
        blocked: [],
        completed: [],
        units: noUnits,
        operator_questions: [],
        next_actions: [],
      };
      await writeAutopilotStateAtomic({ statePath: join(runtimeRoot, 'state.json'), state, artifactRoot: runtimeRoot });
      const snapshot = await readAutopilotResumeSnapshot({ root: runtimeRoot });
      assert.equal(snapshot.purpose.masterPlan?.workstream, 'quality-demo');
      assert.equal(snapshot.state.workstream, 'quality-demo');
    });
  });
});

void describe('Autopilot execution audits', () => {
  void it('classifies clean, scope, and protected path attempts from git facts', async () => {
    await withTempDir(async (root) => {
      const worktree = join(root, 'worktree');
      await initGitWorktree(worktree);
      const spec = sourceSpec(root, { cwd: worktree });
      const cleanBaseline = await captureAutopilotExecutionBaseline(worktree);
      await writeFile(join(worktree, 'src', 'owned.ts'), 'export const value = 2;\n', 'utf8');
      const cleanAudit = await writeAutopilotExecutionAudit({
        unitSpec: spec,
        baseline: cleanBaseline,
        statusEntry: passingStatus(spec),
      });
      assert.equal(cleanAudit.classification, 'clean');
      assert.deepEqual(cleanAudit.actual_changed_paths, ['src/owned.ts']);
      assert.equal(
        deriveAutopilotExecutionAuditPath(spec).endsWith('execution-audits/u01-implement.implement.attempt-1.json'),
        true,
      );

      git(worktree, ['add', 'src/owned.ts']);
      git(worktree, ['commit', '-m', 'child committed owned change']);
      const committedBaseline = await captureAutopilotExecutionBaseline(worktree);
      await writeFile(join(worktree, 'src', 'owned.ts'), 'export const value = 20;\n', 'utf8');
      git(worktree, ['add', 'src/owned.ts']);
      git(worktree, ['commit', '-m', 'child committed second owned change']);
      const committedAudit = await writeAutopilotExecutionAudit({
        unitSpec: spec,
        baseline: committedBaseline,
        statusEntry: passingStatus(spec),
      });
      assert.equal(committedAudit.classification, 'clean');
      assert.equal(committedAudit.head_change_kind, 'fast-forward');
      assert.deepEqual(committedAudit.committed_changed_paths, ['src/owned.ts']);
      assert.deepEqual(committedAudit.actual_changed_paths, ['src/owned.ts']);

      assert.throws(
        () =>
          parseAutopilotExecutionAudit({
            ...cleanAudit,
            status_reported_changed_paths: [],
            omitted_status_changes: [],
            classification: 'scope-review-required',
          }),
        /omitted_status_changes/u,
      );
      assert.throws(
        () =>
          parseAutopilotExecutionAudit({
            ...cleanAudit,
            outside_owned_paths: ['src/outside.ts'],
            path_counts: { ...cleanAudit.path_counts, outside_owned_paths: 1 },
          }),
        /classification clean does not match audit facts/u,
      );

      git(worktree, ['checkout', '--', 'src/owned.ts']);
      await mkdir(join(worktree, 'docs'), { recursive: true });
      await writeFile(join(worktree, 'docs', 'operator-note.md'), 'pre-existing note\n', 'utf8');
      const unrelatedDirtyBaseline = await captureAutopilotExecutionBaseline(worktree);
      await writeFile(join(worktree, 'src', 'owned.ts'), 'export const value = 3;\n', 'utf8');
      const unrelatedDirtyAudit = await writeAutopilotExecutionAudit({
        unitSpec: spec,
        baseline: unrelatedDirtyBaseline,
        statusEntry: passingStatus(spec),
      });
      assert.equal(unrelatedDirtyAudit.classification, 'clean');
      assert.equal(unrelatedDirtyAudit.dirty_baseline, true);
      assert.deepEqual(unrelatedDirtyAudit.dirty_baseline_paths, ['docs/operator-note.md']);
      assert.deepEqual(unrelatedDirtyAudit.dirty_relevant_paths, []);
      assert.equal(unrelatedDirtyAudit.path_counts.dirty_baseline_paths, 1);
      assert.deepEqual(unrelatedDirtyAudit.truncated_path_sets, []);

      git(worktree, ['checkout', '--', 'src/owned.ts']);
      await rm(join(worktree, 'docs'), { recursive: true, force: true });
      await writeFile(join(worktree, 'README.md'), '# pre-existing dirty read-only change\n', 'utf8');
      const relevantDirtyBaseline = await captureAutopilotExecutionBaseline(worktree);
      await writeFile(join(worktree, 'src', 'owned.ts'), 'export const value = 4;\n', 'utf8');
      const relevantDirtyAudit = await writeAutopilotExecutionAudit({
        unitSpec: spec,
        baseline: relevantDirtyBaseline,
        statusEntry: passingStatus(spec),
      });
      assert.equal(relevantDirtyAudit.classification, 'audit-unavailable');
      assert.deepEqual(relevantDirtyAudit.dirty_relevant_paths, ['README.md']);

      git(worktree, ['checkout', '--', 'src/owned.ts', 'README.md']);
      const scopeBaseline = await captureAutopilotExecutionBaseline(worktree);
      await writeFile(join(worktree, 'src', 'outside.ts'), 'export const outside = true;\n', 'utf8');
      const scopeAudit = await writeAutopilotExecutionAudit({
        unitSpec: spec,
        baseline: scopeBaseline,
        statusEntry: { ...passingStatus(spec), changed_paths: ['src/outside.ts'] },
      });
      assert.equal(scopeAudit.classification, 'scope-review-required');
      assert.deepEqual(scopeAudit.outside_owned_paths, ['src/outside.ts']);

      await rm(join(worktree, 'src', 'outside.ts'), { force: true });
      const protectedBaseline = await captureAutopilotExecutionBaseline(worktree);
      await writeFile(join(worktree, 'README.md'), '# changed\n', 'utf8');
      await writeFile(join(worktree, 'private', 'secret.txt'), 'secret\n', 'utf8');
      const protectedAudit = await writeAutopilotExecutionAudit({
        unitSpec: spec,
        baseline: protectedBaseline,
        statusEntry: passingStatus(spec),
      });
      assert.equal(protectedAudit.classification, 'critical-protected-path-violation');
      assert.deepEqual(protectedAudit.read_only_touched_paths, ['README.md']);
      assert.deepEqual(protectedAudit.untouchable_touched_paths, ['private/secret.txt']);

      const auditText = await readFile(deriveAutopilotExecutionAuditPath(spec), 'utf8');
      assert.match(auditText, /autopilot.execution_audit.v1/u);
    });
  });

  void it('accepts clean status/audit coherence at the 500 changed-path boundary', async () => {
    await withTempDir(async (root) => {
      const changedPaths = generatedChangedPaths(AUTOPILOT_STATUS_CHANGED_PATHS_LIMIT);
      const spec = sourceSpec(root, { owned_paths: ['src/generated'] });
      const status: AutopilotStatusEntry = {
        ...passingStatus(spec),
        changed_paths: changedPaths,
      };
      const audit = buildAutopilotExecutionAudit({
        unitSpec: spec,
        baseline: {
          cwd: spec.cwd,
          available: true,
          gitHead: 'before-head',
          dirtyPaths: [],
          summary: 'clean baseline captured',
        },
        postRun: {
          available: true,
          gitHead: 'before-head',
          changedPaths,
          summary: 'post-run captured',
        },
        statusEntry: status,
      });

      assert.equal(audit.classification, 'clean');
      assert.equal(audit.actual_changed_paths.length, AUTOPILOT_STATUS_CHANGED_PATHS_LIMIT);
      assert.equal(audit.status_reported_changed_paths.length, AUTOPILOT_STATUS_CHANGED_PATHS_LIMIT);
      assert.equal(audit.path_counts.actual_changed_paths, AUTOPILOT_STATUS_CHANGED_PATHS_LIMIT);
      assert.equal(audit.path_counts.status_reported_changed_paths, AUTOPILOT_STATUS_CHANGED_PATHS_LIMIT);
      assert.deepEqual(audit.truncated_path_sets, []);
      assert.equal(
        parseAutopilotStatusEntry(status, { unitSpec: spec, executionAudit: audit }).changed_paths.length,
        AUTOPILOT_STATUS_CHANGED_PATHS_LIMIT,
      );
    });
  });

  void it('truncates oversized dirty baselines with counts and fail-closed classification', () => {
    const spec = sourceSpec('/tmp/autopilot-large-dirty-baseline');
    const dirtyPaths = Array.from(
      { length: 946 },
      (_, index) => `docs/baseline-${String(index).padStart(4, '0')}.md`,
    );
    const audit = buildAutopilotExecutionAudit({
      unitSpec: spec,
      baseline: {
        cwd: spec.cwd,
        available: true,
        gitHead: null,
        dirtyPaths,
        summary: 'large dirty baseline captured',
      },
      postRun: {
        available: true,
        gitHead: null,
        changedPaths: [...dirtyPaths, 'src/owned.ts'],
        summary: 'post-run captured',
      },
      statusEntry: passingStatus(spec),
    });

    assert.equal(audit.dirty_baseline, true);
    assert.equal(audit.dirty_baseline_paths.length, 500);
    assert.equal(audit.path_counts.dirty_baseline_paths, 946);
    assert.deepEqual(audit.truncated_path_sets, ['dirty_baseline_paths']);
    assert.equal(audit.classification, 'audit-unavailable');
    assert.match(audit.summary, /truncated dirty_baseline_paths/u);
    assert.equal(parseAutopilotExecutionAudit(audit).path_counts.dirty_baseline_paths, 946);
  });
});
