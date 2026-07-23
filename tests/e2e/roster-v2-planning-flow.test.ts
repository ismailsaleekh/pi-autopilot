import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { AutopilotMasterPlan, AutopilotState } from '../../src/core/contracts/types.ts';
import { renderAutopilotPrompt } from '../../src/core/prompts.ts';
import { renderAutopilotAgentPrompt } from '../../src/core/prompt-renderer/index.ts';
import { planNextDispatch } from '../../src/core/scheduler.ts';
import { computeAutopilotRosterContractObjectHash } from '../../src/core/roster/contracts.ts';
import { SEED_ROSTERS } from '../../src/core/roster/provider-recipes.ts';
import {
  materializeNewRunUnitSpecV2,
  requestProfileFromAssignment,
  type AutopilotRosterSelectionV1,
  type AutopilotRosterUnitSpecV2,
  type AutopilotRosterV1,
  type AutopilotUnitSpecV2MaterializationInput,
} from '../../src/core/roster/runtime-spec.ts';
import { unitSpecAuthorityProjection } from '../../src/core/roster/runtime-consumers.ts';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-roster-v2-planning-flow-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void describe('Phase37 roster v2 planning flow', () => {
  void it('instructs v2 authoring from pinned roster and dispatches only v2 specs with identity retained', async () => {
    await withTempDir(async (root) => {
      const repo = join(root, 'repo');
      await initGit(repo);
      const runtimeRoot = join(repo, '.pi', 'autopilot', 'phase37-plan');
      const parentPrompt = renderAutopilotPrompt({
        workstream: 'phase37-plan',
        runtimeRoot,
        runnerInvocation: '/tmp/autopilot-agent-run',
        taskIntro: 'plan with v2 roster runtime specs',
        workstreamRun: 'run-phase37-plan',
        worktreePath: repo,
      });
      assert.match(parentPrompt, /autopilot\.unit_spec\.v2/u);
      assert.match(parentPrompt, /roster-snapshot\.json/u);
      assert.match(parentPrompt, /request_profile/u);
      assert.equal(/## Fixed model roster/u.test(parentPrompt), false);
      assert.equal(/Every newly created or retried unit spec must use this exact package-owned assignment/u.test(parentPrompt), false);

      const spec = makeUnitSpec({
        cwd: repo,
        status_output: join(runtimeRoot, 'statuses', 'u-plan.implement.attempt-1.json'),
        receipt_output: join(runtimeRoot, 'receipts', 'u-plan.implement.attempt-1.receipt.json'),
        evidence_dir: join(runtimeRoot, 'evidence', 'u-plan'),
      });
      const childPrompt = renderAutopilotAgentPrompt(spec);
      assert.match(childPrompt, /"schema_version": "autopilot.status.v1"/u);
      assert.match(childPrompt, /"roster_runtime_identity"/u);
      assert.match(childPrompt, /"request_profile_sha256"/u);
      assert.match(childPrompt, new RegExp(spec.assignment_sha256.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

      const dispatch = await planNextDispatch({
        workstream: 'phase37-plan',
        runtimeRoot,
        contextGate: 'ok',
        state: makeState(),
        masterPlan: makeMasterPlan(),
        config: { schema_version: 'autopilot.scheduler_config.v1', workstream: 'phase37-plan', parallel_cap: 2, updated_at: '2026-07-23T12:00:00.000Z', updated_by: 'runtime-test' },
        candidates: [
          { unit_id: 'u-plan', attempt: 1, spec },
          { unit_id: 'u-v1', attempt: 1, spec: { ...unitSpecAuthorityProjection(spec), unit_id: 'u-v1' } },
        ],
        runningAttempts: [],
        activeClaims: [],
        reservationCoordination: null,
        now: new Date('2026-07-23T12:00:00.000Z'),
      });

      assert.deepEqual(dispatch.selected.map((unit) => unit.unit_id), ['u-plan']);
      assert.equal(dispatch.selected[0]?.spec.schema_version, 'autopilot.unit_spec.v2');
      assert.equal((dispatch.selected[0]?.spec as AutopilotRosterUnitSpecV2 | undefined)?.assignment_sha256, spec.assignment_sha256);
      const v1Skip = dispatch.skipped.find((entry) => entry.unit_id === 'u-v1');
      assert.ok(v1Skip?.reasons.includes('invalid-spec'));
      assert.ok(v1Skip?.details.some((detail) => detail.includes('unit_spec.v2')));
    });
  });
});

function makeUnitSpec(overrides: Partial<AutopilotUnitSpecV2MaterializationInput>): AutopilotRosterUnitSpecV2 {
  const { selection, roster, requestProfile } = pinnedFacts();
  return materializeNewRunUnitSpecV2({
    selection,
    roster,
    role: 'implement',
    request_profile: requestProfile,
    workstream: 'phase37-plan',
    unit_id: 'u-plan',
    attempt: 1,
    objective: 'Implement a v2 planning-flow unit.',
    cwd: '/tmp/phase37-plan/repo',
    owned_paths: ['src/planning.ts'],
    read_only_paths: ['README.md'],
    untouchable_paths: ['private/**'],
    context_refs: [{ path: 'README.md', purpose: 'repository context', sha256: null, byte_count: null }],
    validation_commands: [],
    status_output: '/tmp/phase37-plan/repo/.pi/autopilot/phase37-plan/statuses/u-plan.implement.attempt-1.json',
    receipt_output: '/tmp/phase37-plan/repo/.pi/autopilot/phase37-plan/receipts/u-plan.implement.attempt-1.receipt.json',
    evidence_dir: '/tmp/phase37-plan/repo/.pi/autopilot/phase37-plan/evidence/u-plan',
    stop_boundary: 'Stop at planning flow boundary.',
    quality_profile: 'source-change',
    risk_level: 'medium',
    acceptance_criteria: ['v2 plan dispatches'],
    verification_plan: null,
    closure_criteria: ['focused e2e passes'],
    upstream_refs: [],
    timeout_seconds: 600,
    render_prompt_snapshot: false,
    ...overrides,
  });
}

function makeState(): AutopilotState {
  return {
    schema_version: 'autopilot.state.v1',
    workstream: 'phase37-plan',
    updated_at: '2026-07-23T12:00:00.000Z',
    status: 'running',
    context_gate: { gate: 'ok', percent: null },
    last_event_id: 0,
    ready_queue: ['u-plan', 'u-v1'],
    running: [],
    blocked: [],
    completed: [],
    units: {
      'u-plan': { unit_id: 'u-plan', role: 'implement', state: 'ready', attempt: 1, summary: 'v2' },
      'u-v1': { unit_id: 'u-v1', role: 'implement', state: 'ready', attempt: 1, summary: 'v1 rejected' },
    },
    operator_questions: [],
    next_actions: [],
  };
}

function makeMasterPlan(): AutopilotMasterPlan {
  return {
    schema_version: 'autopilot.master_plan.v1',
    workstream: 'phase37-plan',
    mission_ref: 'mission.md',
    goal_summary: 'v2 planning flow',
    non_goals: [],
    definition_of_done: [],
    risk_level: 'medium',
    lanes: [{ lane_id: 'lane', summary: 'main', unit_ids: ['u-plan', 'u-v1'] }],
    units: {
      'u-plan': { unit_id: 'u-plan', role: 'implement', state: 'ready', dependencies: [], summary: 'v2' },
      'u-v1': { unit_id: 'u-v1', role: 'implement', state: 'ready', dependencies: [], summary: 'v1 rejected' },
    },
    ownership_matrix: { owned_paths: ['src/planning.ts'], read_only_paths: ['README.md'], untouchable_paths: ['private/**'], held_paths: [] },
    verification_matrix: {
      positive_witnesses: [],
      negative_witnesses: [],
      regression_witnesses: [],
      real_boundary_witnesses: [],
      blast_radius_checks: [],
      docs_schema_prompt_checks: [],
      dirty_tree_checks: [],
    },
    closure_criteria: [],
    current_focus: 'dispatch v2',
    last_decision_id: 0,
    last_event_id: 0,
    updated_at: '2026-07-23T12:00:00.000Z',
  };
}

function pinnedFacts(): {
  readonly selection: AutopilotRosterSelectionV1;
  readonly roster: AutopilotRosterV1;
  readonly requestProfile: ReturnType<typeof requestProfileFromAssignment>;
} {
  const roster = SEED_ROSTERS.find((entry) => entry.assignments.some((assignment) => assignment.role === 'implement'));
  if (roster === undefined) throw new Error('missing seed roster');
  const assignment = roster.assignments.find((entry) => entry.role === 'implement');
  if (assignment === undefined) throw new Error('missing implement assignment');
  const selectionWithoutHash = {
    schema_version: 'autopilot.pre_run_selection.v1' as const,
    repo_id: 'repo-plan-v2',
    workstream_run: 'run-plan-v2',
    scope: roster.scope,
    roster_id: roster.roster_id,
    roster_revision: roster.roster_revision,
    roster_sha256: roster.roster_sha256,
    assignment_set_sha256: roster.assignment_set_sha256,
    config_sha256: 'sha256:6666666666666666666666666666666666666666666666666666666666666666',
    selected_at: '2026-07-23T12:00:00.000Z',
    selection_sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  const selection = {
    ...selectionWithoutHash,
    selection_sha256: requiredHash('autopilot.pre_run_selection.v1', selectionWithoutHash),
  };
  return { selection, roster, requestProfile: requestProfileFromAssignment(assignment) };
}

function requiredHash(schemaVersion: Parameters<typeof computeAutopilotRosterContractObjectHash>[0], value: unknown): string {
  const hash = computeAutopilotRosterContractObjectHash(schemaVersion, value);
  if (hash === null) throw new Error(`${schemaVersion} has no hash field`);
  return hash;
}

async function initGit(root: string): Promise<void> {
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# planning\n', 'utf8');
  await writeFile(join(root, 'src', 'baseline.ts'), 'export const baseline = true;\n', 'utf8');
  git(root, ['init']);
  git(root, ['config', 'user.email', 'autopilot@example.invalid']);
  git(root, ['config', 'user.name', 'Autopilot Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'baseline']);
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
