import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import type { AutopilotExecutionAudit, AutopilotExecutionCommit, AutopilotReceipt, AutopilotState, AutopilotStatusEntry, AutopilotUnitSpec } from '../../src/core/contracts/index.ts';
import { runAutopilotAgentFromSpecPath } from '../../src/core/agent-runner.ts';
import { runAutopilotClaimGc } from '../../src/core/claim-gc.ts';
import { materializeAdditionalReadPathsForSpec, materializeAutopilotSpecPaths } from '../../src/core/materialization.ts';
import { parseAutopilotCheckoutProfile } from '../../src/core/checkout-profile.ts';
import { projectAutopilotDiskUse } from '../../src/core/disk-gate.ts';
import { planNextDispatch } from '../../src/core/scheduler.ts';
import { readSchedulerConfig, writeSchedulerConfig } from '../../src/core/scheduler-config.ts';
import { mergeAutopilotUnit } from '../../src/core/unit-merge.ts';
import { abortFailedUnit, resetFailedUnit } from '../../src/core/unit-failure.ts';
import { cleanupTerminalUnitWorktree, cleanupTerminalUnitWorktreesForRun } from '../../src/core/worktree-cleanup.ts';
import { recordValidationStalenessForMerge, validationCanCloseSourceWork, type AutopilotValidationEvidence } from '../../src/core/validation-staleness.ts';
import {
  AUTOPILOT_STATE_ROOT_ENV,
  acquireClaimsForUnit,
  coordinationRootForRepo,
  prepareAutopilotUnitWorktree,
  prepareAutopilotWorkstream,
  readPathClaims,
  readUnitIndex,
  resolveActiveAutopilotForSpec,
  resolveRepoIdentity,
  taskRootForActiveAutopilot,
  updateUnitBranchStatus,
} from '../../src/core/parallel-runtime.ts';

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-phase2-test-'));
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

function emptyPlan(): NonNullable<AutopilotUnitSpec['verification_plan']> {
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

function unitSpec(input: {
  readonly cwd: string;
  readonly runtimeRoot: string;
  readonly unitId: string;
  readonly attempt?: number;
  readonly ownedPaths?: readonly string[];
  readonly readOnlyPaths?: readonly string[];
}): AutopilotUnitSpec {
  const attempt = input.attempt ?? 1;
  return {
    schema_version: 'autopilot.unit_spec.v1',
    workstream: 'phase2-smoke',
    unit_id: input.unitId,
    role: 'implement',
    template: 'implement',
    attempt,
    objective: `Implement ${input.unitId}.`,
    cwd: input.cwd,
    model: 'openai-codex/gpt-5.6-terra',
    thinking: 'high',
    owned_paths: input.ownedPaths ?? [`src/${input.unitId}.ts`],
    read_only_paths: input.readOnlyPaths ?? [],
    untouchable_paths: ['private/**'],
    context_refs: [
      { path: '.pi/autopilot/phase2-smoke/mission.md', purpose: 'mission' },
      { path: '.pi/autopilot/phase2-smoke/master-plan.json', purpose: 'plan' },
    ],
    validation_commands: [],
    status_output: join(input.runtimeRoot, 'statuses', `${input.unitId}.implement.attempt-${String(attempt)}.json`),
    receipt_output: join(input.runtimeRoot, 'receipts', `${input.unitId}.implement.attempt-${String(attempt)}.receipt.json`),
    evidence_dir: join(input.runtimeRoot, 'evidence', input.unitId),
    stop_boundary: 'Edit only owned paths.',
    quality_profile: 'source-change',
    risk_level: 'medium',
    acceptance_criteria: ['change is implemented'],
    verification_plan: emptyPlan(),
    closure_criteria: ['validated after merge'],
    upstream_refs: [],
  };
}

async function initGitSource(source: string): Promise<void> {
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, '.gitignore'), '.pi/\n', 'utf8');
  await writeFile(join(source, 'src', 'baseline.ts'), 'export const baseline = true;\n', 'utf8');
  git(source, ['init']);
  git(source, ['config', 'user.email', 'autopilot@example.invalid']);
  git(source, ['config', 'user.name', 'Autopilot Test']);
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'baseline']);
}

function git(root: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function sha256Text(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function gitOut(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitWorktreeListContains(root: string, worktreePath: string): boolean {
  const expected = normalizeTestPath(worktreePath);
  return gitOut(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => normalizeTestPath(line.slice('worktree '.length)))
    .some((path) => path === expected);
}

function normalizeTestPath(path: string): string {
  if (!existsSync(path)) return path;
  return realpathSync(path);
}

void describe('Phase 2 scheduler config and deterministic scheduler', () => {
  void it('defaults parallel_cap to 8 and persists valid cap while rejecting invalid values without mutation', async () => {
    await withTempDir(async (root) => {
      const runtimeRoot = join(root, 'runtime');
      const initial = await readSchedulerConfig({ runtimeRoot, workstream: 'phase2-smoke', now: new Date('2026-07-08T00:00:00.000Z') });
      assert.equal(initial.parallel_cap, 8);
      const saved = await writeSchedulerConfig({ runtimeRoot, workstream: 'phase2-smoke', parallelCap: 12, updatedBy: 'runtime-test', now: new Date('2026-07-08T00:00:01.000Z') });
      assert.equal(saved.parallel_cap, 12);
      await expectRejects(() => writeSchedulerConfig({ runtimeRoot, workstream: 'phase2-smoke', parallelCap: 33, updatedBy: 'runtime-test' }));
      const reread = await readSchedulerConfig({ runtimeRoot, workstream: 'phase2-smoke' });
      assert.equal(reread.parallel_cap, 12);
    });
  });

  void it('validates sparse checkout profiles and disk-gate projection arithmetic loudly', () => {
    const profile = parseAutopilotCheckoutProfile({
      schema_version: 'autopilot.checkout_profile.v1',
      mode: 'claim-minimal',
      always_include: ['README.md'],
      exclude: [],
      auto_profile: { enabled: true, heavy_dir_threshold_bytes: 64, max_scan_depth: 2 },
      disk_gate: { expected_parallel_units: 2, headroom_factor: 2, floor_free_bytes: 100 },
      materialization: { auto_read_claims: true, max_auto_read_bytes: 1000, max_single_materialization_bytes: 500, max_auto_read_paths: 4 },
    });
    assert.equal(profile.mode, 'claim-minimal');
    const projection = projectAutopilotDiskUse({ profileMode: profile.mode, diskGate: profile.disk_gate, perWorktreeEstimateBytes: 10, additionalMaterializationBytes: 40 });
    assert.equal(projection.expected_worktree_count, 3);
    assert.equal(projection.projected_required_bytes, 6_291_636);
    assert.throws(() => parseAutopilotCheckoutProfile({ schema_version: 'autopilot.checkout_profile.v1', mode: 'claim-minimal', always_include: ['../escape'] }), /invalid-repo-path/u);
  });

  void it('selects dependency-clear conflict-free units in lane order and records cap/skip reasons', () => {
    const runtimeRoot = '/tmp/autopilot-phase2-main/.pi/autopilot/phase2-smoke';
    const baseSpec = unitSpec({ cwd: '/tmp/unit', runtimeRoot, unitId: 'u01' });
    const state: AutopilotState = {
      schema_version: 'autopilot.state.v1',
      workstream: 'phase2-smoke',
      updated_at: '2026-07-08T00:00:00.000Z',
      status: 'running',
      context_gate: { gate: 'ok', percent: 10 },
      last_event_id: 0,
      ready_queue: ['u02', 'u01', 'u03'],
      running: [],
      blocked: [],
      completed: ['dep'],
      units: {
        dep: { unit_id: 'dep', role: 'implement', state: 'completed', attempt: 1, summary: 'dep done' },
        u01: { unit_id: 'u01', role: 'implement', state: 'ready', attempt: 1, summary: 'ready' },
        u02: { unit_id: 'u02', role: 'implement', state: 'ready', attempt: 1, summary: 'ready' },
        u03: { unit_id: 'u03', role: 'implement', state: 'ready', attempt: 1, summary: 'ready' },
      },
      operator_questions: [],
      next_actions: [],
    };
    const masterPlan = {
      schema_version: 'autopilot.master_plan.v1' as const,
      workstream: 'phase2-smoke',
      mission_ref: 'mission.md',
      goal_summary: 'phase2',
      non_goals: [],
      definition_of_done: [],
      risk_level: 'medium' as const,
      lanes: [{ lane_id: 'lane-a', summary: 'lane', unit_ids: ['u02', 'u01', 'u03'] }],
      units: {
        dep: { unit_id: 'dep', role: 'implement' as const, state: 'completed' as const, dependencies: [], summary: 'dep' },
        u01: { unit_id: 'u01', role: 'implement' as const, state: 'ready' as const, dependencies: ['dep'], summary: 'one' },
        u02: { unit_id: 'u02', role: 'implement' as const, state: 'ready' as const, dependencies: [], summary: 'two' },
        u03: { unit_id: 'u03', role: 'implement' as const, state: 'ready' as const, dependencies: ['missing'], summary: 'three' },
      },
      ownership_matrix: { owned_paths: [], read_only_paths: [], untouchable_paths: [], held_paths: [] },
      verification_matrix: emptyPlan(),
      closure_criteria: [],
      current_focus: 'dispatch',
      last_decision_id: 0,
      last_event_id: 0,
      updated_at: '2026-07-08T00:00:00.000Z',
    };
    const dispatch = planNextDispatch({
      workstream: 'phase2-smoke',
      runtimeRoot,
      contextGate: 'ok',
      state,
      masterPlan,
      config: { schema_version: 'autopilot.scheduler_config.v1', workstream: 'phase2-smoke', parallel_cap: 1, updated_at: '2026-07-08T00:00:00.000Z', updated_by: 'runtime-test' },
      candidates: [
        { unit_id: 'u01', attempt: 1, spec: baseSpec },
        { unit_id: 'u02', attempt: 1, spec: { ...baseSpec, unit_id: 'u02', owned_paths: ['src/u02.ts'] } },
        { unit_id: 'u03', attempt: 1, spec: { ...baseSpec, unit_id: 'u03', owned_paths: ['src/u03.ts'] } },
      ],
      runningAttempts: [],
      activeClaims: [],
      now: new Date('2026-07-08T00:00:00.000Z'),
    });
    assert.deepEqual(dispatch.selected.map((unit) => unit.unit_id), ['u02']);
    const skippedReasons = new Map(dispatch.skipped.map((unit) => [unit.unit_id, unit.reasons]));
    assert.ok(skippedReasons.get('u01')?.includes('running-cap-reached'));
    assert.ok(skippedReasons.get('u03')?.includes('dependency-not-satisfied'));
  });
});

void describe('Phase 2 unit worktrees, claims, mergeback, staleness, and GC', () => {
  void it('creates separate unit worktrees, enforces same-parent claims, and keeps authoritative runtime root in main', async () => {
    await withTempDir(async (root) => {
      const source = join(root, 'source');
      await initGitSource(source);
      const prepared = await prepareAutopilotWorkstream({ workstream: 'phase2-smoke', sourceCwd: source });
      const unitA = await prepareAutopilotUnitWorktree({ active: prepared.active, unitId: 'u01', attempt: 1 });
      const unitB = await prepareAutopilotUnitWorktree({ active: prepared.active, unitId: 'u02', attempt: 1 });
      assert.ok(unitA.unitInfo.worktree_path !== unitB.unitInfo.worktree_path);
      assert.equal(unitA.unitInfo.runtime_root, prepared.runtimeRoot);
      const contextA = await resolveActiveAutopilotForSpec(unitSpec({ cwd: unitA.unitInfo.worktree_path, runtimeRoot: prepared.runtimeRoot, unitId: 'u01', ownedPaths: ['src/shared.ts'] }));
      await acquireClaimsForUnit({ context: contextA, spec: unitSpec({ cwd: unitA.unitInfo.worktree_path, runtimeRoot: prepared.runtimeRoot, unitId: 'u01', ownedPaths: ['src/shared.ts'] }), reason: 'phase2 claim test' });
      await acquireClaimsForUnit({ context: contextA, spec: unitSpec({ cwd: unitA.unitInfo.worktree_path, runtimeRoot: prepared.runtimeRoot, unitId: 'u01', ownedPaths: ['src/shared.ts'] }), reason: 'phase2 idempotent reuse' });
      const contextB = await resolveActiveAutopilotForSpec(unitSpec({ cwd: unitB.unitInfo.worktree_path, runtimeRoot: prepared.runtimeRoot, unitId: 'u02', ownedPaths: ['src/shared.ts'] }));
      await expectRejects(() => acquireClaimsForUnit({ context: contextB, spec: unitSpec({ cwd: unitB.unitInfo.worktree_path, runtimeRoot: prepared.runtimeRoot, unitId: 'u02', ownedPaths: ['src/shared.ts'] }), reason: 'phase2 conflict test' }), /claim-conflict/u);
      const readSpec = unitSpec({ cwd: unitB.unitInfo.worktree_path, runtimeRoot: prepared.runtimeRoot, unitId: 'u02-read', ownedPaths: ['src/other.ts'], readOnlyPaths: ['src/shared.ts'] });
      await expectRejects(() => acquireClaimsForUnit({ context: contextB, spec: readSpec, reason: 'phase2 write-read conflict test' }), /claim-conflict/u);
    });
  });

  void it('creates sparse main and unit worktrees, materializes declared paths, and keeps unrelated tracked files absent', async () => {
    await withTempDir(async (root) => {
      const source = join(root, 'source');
      await mkdir(join(source, 'src'), { recursive: true });
      await mkdir(join(source, 'docs'), { recursive: true });
      await mkdir(join(source, 'heavy'), { recursive: true });
      await writeFile(join(source, '.gitignore'), '.pi/\n', 'utf8');
      await writeFile(join(source, 'src', 'baseline.ts'), 'export const baseline = true;\n', 'utf8');
      await writeFile(join(source, 'docs', 'context.md'), 'context\n', 'utf8');
      await writeFile(join(source, 'heavy', 'blob.bin'), 'heavy but tiny fixture\n', 'utf8');
      git(source, ['init']);
      git(source, ['config', 'user.email', 'autopilot@example.invalid']);
      git(source, ['config', 'user.name', 'Autopilot Test']);
      git(source, ['add', '.']);
      git(source, ['commit', '-m', 'baseline']);

      const prepared = await prepareAutopilotWorkstream({ workstream: 'phase2-smoke', sourceCwd: source });
      assert.equal(gitOut(prepared.mainWorktreePath, ['config', '--bool', 'core.sparseCheckout']), 'true');
      assert.equal(existsSync(join(prepared.mainWorktreePath, 'heavy', 'blob.bin')), false);
      const taskInfo = JSON.parse(await readFile(join(prepared.taskRoot, '_task-info.json'), 'utf8')) as { checkout_mode?: string; checkout_profile_ref?: string };
      assert.equal(taskInfo.checkout_mode, 'sparse');
      assert.equal(taskInfo.checkout_profile_ref, '_checkout-profile.json');
      assert.equal(existsSync(join(prepared.taskRoot, '_checkout-profile.json')), true);

      const unitCwd = join(prepared.taskRoot, 'units', 'u-sparse', 'attempt-1', 'worktree');
      const sparseSpec = unitSpec({ cwd: unitCwd, runtimeRoot: prepared.runtimeRoot, unitId: 'u-sparse', ownedPaths: ['src/new-file.ts'], readOnlyPaths: ['src/baseline.ts'] });
      const specWithContext = { ...sparseSpec, context_refs: [{ path: 'docs/context.md', purpose: 'source context' }] };
      const unit = await prepareAutopilotUnitWorktree({ active: prepared.active, unitId: 'u-sparse', attempt: 1, unitSpec: specWithContext });
      const context = await resolveActiveAutopilotForSpec(specWithContext);
      await acquireClaimsForUnit({ context, spec: specWithContext, reason: 'sparse materialization test' });
      await materializeAutopilotSpecPaths({ context, spec: specWithContext, reason: 'sparse materialization test' });
      assert.equal(existsSync(join(unit.unitInfo.worktree_path, 'src', 'baseline.ts')), true);
      assert.equal(existsSync(join(unit.unitInfo.worktree_path, 'docs', 'context.md')), true);
      assert.equal(existsSync(join(unit.unitInfo.worktree_path, 'heavy', 'blob.bin')), false);
      assert.equal(existsSync(join(unit.unitInfo.worktree_path, 'src')), true);
      assert.equal(existsSync(join(prepared.taskRoot, '_materialization-ledger.jsonl')), true);

      const expanded = await materializeAdditionalReadPathsForSpec({ context, spec: specWithContext, paths: ['heavy/blob.bin'], reason: 'safe auto read expansion test' });
      assert.equal(expanded.checkout_mode, 'sparse');
      assert.equal(existsSync(join(unit.unitInfo.worktree_path, 'heavy', 'blob.bin')), true);
    });
  });

  void it('runtime-owned unit merge writes evidence, releases claims, marks stale validations, and GC releases proven stale leaks', async () => {
    await withTempDir(async (root) => {
      const source = join(root, 'source');
      await initGitSource(source);
      const prepared = await prepareAutopilotWorkstream({ workstream: 'phase2-smoke', sourceCwd: source });
      const expectedUnitCwd = join(prepared.taskRoot, 'units', 'u01', 'attempt-1', 'worktree');
      const spec = unitSpec({ cwd: expectedUnitCwd, runtimeRoot: prepared.runtimeRoot, unitId: 'u01', ownedPaths: ['src/u01.ts'] });
      const unit = await prepareAutopilotUnitWorktree({ active: prepared.active, unitId: 'u01', attempt: 1, unitSpec: spec });
      const context = await resolveActiveAutopilotForSpec(spec);
      await acquireClaimsForUnit({ context, spec, reason: 'phase2 merge test' });
      const beforeHead = gitOut(unit.unitInfo.worktree_path, ['rev-parse', 'HEAD']);
      await writeFile(join(unit.unitInfo.worktree_path, 'src', 'u01.ts'), 'export const u01 = true;\n', 'utf8');
      git(unit.unitInfo.worktree_path, ['add', 'src/u01.ts']);
      git(unit.unitInfo.worktree_path, ['commit', '-m', 'autopilot unit u01 attempt 1']);
      const afterHead = gitOut(unit.unitInfo.worktree_path, ['rev-parse', 'HEAD']);
      const refs = await writeUnitEvidence({ runtimeRoot: prepared.runtimeRoot, unitCwd: unit.unitInfo.worktree_path, branch: unit.unitInfo.branch, workstreamRun: prepared.active.workstream_run, autopilotId: prepared.active.autopilot_id, beforeHead, afterHead });
      const result = await mergeAutopilotUnit({ context, unitId: 'u01', attempt: 1, statusPath: refs.statusPath, receiptPath: refs.receiptPath, auditPath: refs.auditPath, executionCommitPath: refs.executionCommitPath, now: new Date('2026-07-08T00:00:00.000Z') });
      assert.equal(result.outcome, 'merged');
      const merge = result.merge;
      if (merge === null) throw new Error('expected unit merge evidence');
      assert.deepEqual(merge.changed_paths, ['src/u01.ts']);
      assert.equal((await readPathClaims(context.coordinationRoot)).length, 0);
      assert.equal(existsSync(join(prepared.runtimeRoot, 'unit-merges', 'u01.implement.attempt-1.json')), true);
      assert.equal(existsSync(unit.unitInfo.worktree_path), false);
      assert.equal(gitWorktreeListContains(source, unit.unitInfo.worktree_path), false);
      const validation: AutopilotValidationEvidence = {
        schema_version: 'autopilot.validation_evidence.v1',
        workstream: 'phase2-smoke',
        source_unit_id: 'u00',
        source_attempt: 1,
        validation_unit_id: 'v00',
        validation_attempt: 1,
        unit_merge_ref: 'unit-merges/u00.implement.attempt-1.json',
        integration_head: merge.integration_before,
        covered_paths: ['src/u01.ts'],
        covered_path_groups: [],
        witness_ids: ['witness'],
        status_ref: 'statuses/v00.validate.attempt-1.json',
        receipt_ref: 'receipts/v00.validate.attempt-1.receipt.json',
        audit_ref: 'execution-audits/v00.validate.attempt-1.json',
        verdict: 'PASS',
        validated_at: '2026-07-08T00:00:00.000Z',
      };
      await writeJson(join(prepared.runtimeRoot, 'validation', 'v00.json'), validation);
      const staleness = await recordValidationStalenessForMerge({ runtimeRoot: prepared.runtimeRoot, workstream: 'phase2-smoke', invalidatingMergeRef: 'unit-merges/u01.implement.attempt-1.json', validationEvidenceRefs: ['validation/v00.json'], now: new Date('2026-07-08T00:00:01.000Z') });
      assert.equal(staleness.length, 1);
      assert.equal(validationCanCloseSourceWork({ validation: { ...validation, source_unit_id: 'u01', unit_merge_ref: 'unit-merges/u01.implement.attempt-1.json', integration_head: merge.integration_after }, unitMerge: merge }), true);

      const unit2 = await prepareAutopilotUnitWorktree({ active: prepared.active, unitId: 'u02', attempt: 1 });
      const spec2 = unitSpec({ cwd: unit2.unitInfo.worktree_path, runtimeRoot: prepared.runtimeRoot, unitId: 'u02', ownedPaths: ['src/u02.ts'] });
      const context2 = await resolveActiveAutopilotForSpec(spec2);
      await acquireClaimsForUnit({ context: context2, spec: spec2, reason: 'phase2 gc setup' });
      const gcDry = await runAutopilotClaimGc({ sourceCwd: source, apply: false, now: new Date('2026-07-08T00:00:02.000Z') });
      assert.equal(gcDry.candidates.some((candidate) => candidate.blockers.some((blocker) => blocker.includes('live'))), true);
    });
  });

  void it('cleans same-run terminal unit worktrees before creating a new unit and leaves foreign runs untouched', async () => {
    await withTempDir(async (root) => {
      const source = join(root, 'source');
      await initGitSource(source);
      const runA = await prepareAutopilotWorkstream({ workstream: 'phase2-smoke', sourceCwd: source });
      const oldA = await prepareAutopilotUnitWorktree({ active: runA.active, unitId: 'u-old', attempt: 1 });
      await updateUnitBranchStatus({ active: runA.active, unitId: 'u-old', attempt: 1, status: 'aborted', currentSha: gitOut(oldA.unitInfo.worktree_path, ['rev-parse', 'HEAD']), archiveRef: null });
      const runB = await prepareAutopilotWorkstream({ workstream: 'phase2-other', sourceCwd: source });
      const oldB = await prepareAutopilotUnitWorktree({ active: runB.active, unitId: 'u-old', attempt: 1 });
      await updateUnitBranchStatus({ active: runB.active, unitId: 'u-old', attempt: 1, status: 'aborted', currentSha: gitOut(oldB.unitInfo.worktree_path, ['rev-parse', 'HEAD']), archiveRef: null });
      const cleanup = await cleanupTerminalUnitWorktreesForRun({ active: runA.active, reason: 'phase2 cleanup isolation test' });
      assert.equal(cleanup.removed_paths.includes(oldA.unitInfo.worktree_path), true);
      assert.equal(existsSync(oldA.unitInfo.worktree_path), false);
      assert.equal(gitWorktreeListContains(source, oldA.unitInfo.worktree_path), false);
      assert.equal(existsSync(oldB.unitInfo.worktree_path), true);
      assert.equal(gitWorktreeListContains(source, oldB.unitInfo.worktree_path), true);
      const nextA = await prepareAutopilotUnitWorktree({ active: runA.active, unitId: 'u-new', attempt: 1 });
      assert.equal(existsSync(nextA.unitInfo.worktree_path), true);
      assert.equal(existsSync(oldB.unitInfo.worktree_path), true);
    });
  });

  void it('unit reset and abort transitions remove their unit worktrees after recorded reset evidence', async () => {
    await withTempDir(async (root) => {
      const source = join(root, 'source');
      await initGitSource(source);
      const prepared = await prepareAutopilotWorkstream({ workstream: 'phase2-smoke', sourceCwd: source });
      const resetUnit = await prepareAutopilotUnitWorktree({ active: prepared.active, unitId: 'u-reset', attempt: 1 });
      await mkdir(join(resetUnit.unitInfo.worktree_path, 'src'), { recursive: true });
      await writeFile(join(resetUnit.unitInfo.worktree_path, 'src', 'reset.ts'), 'reset residue\n', 'utf8');
      await resetFailedUnit({ context: { repo: resolveRepoIdentity(resetUnit.unitInfo.worktree_path), active: prepared.active, coordinationRoot: coordinationRootForRepo(prepared.active.repo_key), claimsPath: '', claimEventsPath: '' }, unitId: 'u-reset', attempt: 1, unitWorktreePath: resetUnit.unitInfo.worktree_path, summary: 'reset failed unit', now: new Date('2026-07-08T00:00:03.000Z') });
      assert.equal(existsSync(resetUnit.unitInfo.worktree_path), false);
      assert.equal(gitWorktreeListContains(source, resetUnit.unitInfo.worktree_path), false);

      const abortUnit = await prepareAutopilotUnitWorktree({ active: prepared.active, unitId: 'u-abort', attempt: 1 });
      await mkdir(join(abortUnit.unitInfo.worktree_path, 'src'), { recursive: true });
      await writeFile(join(abortUnit.unitInfo.worktree_path, 'src', 'abort.ts'), 'abort residue\n', 'utf8');
      await abortFailedUnit({ context: { repo: resolveRepoIdentity(abortUnit.unitInfo.worktree_path), active: prepared.active, coordinationRoot: coordinationRootForRepo(prepared.active.repo_key), claimsPath: '', claimEventsPath: '' }, unitId: 'u-abort', attempt: 1, unitWorktreePath: abortUnit.unitInfo.worktree_path, summary: 'abort failed unit', now: new Date('2026-07-08T00:00:04.000Z') });
      assert.equal(existsSync(abortUnit.unitInfo.worktree_path), false);
      assert.equal(gitWorktreeListContains(source, abortUnit.unitInfo.worktree_path), false);
    });
  });

  void it('runner preflight rollback removes a newly-created unlaunched unit worktree', async () => {
    await withTempDir(async (root) => {
      const source = join(root, 'source');
      await initGitSource(source);
      const prepared = await prepareAutopilotWorkstream({ workstream: 'phase2-smoke', sourceCwd: source });
      const unitCwd = join(prepared.taskRoot, 'units', 'u-rollback', 'attempt-1', 'worktree');
      const baseSpec = unitSpec({ cwd: unitCwd, runtimeRoot: prepared.runtimeRoot, unitId: 'u-rollback', ownedPaths: ['src/rollback.ts'] });
      const spec: AutopilotUnitSpec = {
        ...baseSpec,
        verification_plan: {
          ...emptyPlan(),
          positive_witnesses: [{ id: 'rollback-stale-output', expected_signal: 'preflight fails before launch', required: true, inspection_target: 'src/rollback.ts' }],
        },
      };
      await writeJson(spec.status_output, { stale: true });
      const specPath = join(prepared.runtimeRoot, 'unit-specs', 'u-rollback.json');
      await writeJson(specPath, spec);
      await expectRejects(() => runAutopilotAgentFromSpecPath(specPath), /status_output already exists/u);
      assert.equal(existsSync(unitCwd), false);
      assert.equal(gitWorktreeListContains(source, unitCwd), false);
      const index = await readUnitIndex(taskRootForActiveAutopilot(prepared.active));
      assert.equal(index.units.some((unit) => unit.unit_id === 'u-rollback'), false);
    });
  });

  void it('dirty, quarantined, and active unit worktrees block direct cleanup', async () => {
    await withTempDir(async (root) => {
      const source = join(root, 'source');
      await initGitSource(source);
      const prepared = await prepareAutopilotWorkstream({ workstream: 'phase2-smoke', sourceCwd: source });
      const activeUnit = await prepareAutopilotUnitWorktree({ active: prepared.active, unitId: 'u-active', attempt: 1 });
      await expectRejects(() => cleanupTerminalUnitWorktree({ active: prepared.active, unitId: 'u-active', attempt: 1, reason: 'active blocker test' }), /unit-status-not-terminal/u);
      assert.equal(existsSync(activeUnit.unitInfo.worktree_path), true);

      const dirtyUnit = await prepareAutopilotUnitWorktree({ active: prepared.active, unitId: 'u-dirty', attempt: 1 });
      const quarantinedUnit = await prepareAutopilotUnitWorktree({ active: prepared.active, unitId: 'u-quarantine', attempt: 1 });
      await updateUnitBranchStatus({ active: prepared.active, unitId: 'u-dirty', attempt: 1, status: 'aborted', currentSha: gitOut(dirtyUnit.unitInfo.worktree_path, ['rev-parse', 'HEAD']), archiveRef: null });
      await mkdir(join(dirtyUnit.unitInfo.worktree_path, 'src'), { recursive: true });
      await writeFile(join(dirtyUnit.unitInfo.worktree_path, 'src', 'dirty.ts'), 'dirty residue\n', 'utf8');
      await expectRejects(() => cleanupTerminalUnitWorktree({ active: prepared.active, unitId: 'u-dirty', attempt: 1, reason: 'dirty blocker test' }), /dirty-terminal-unit-worktree/u);
      assert.equal(existsSync(dirtyUnit.unitInfo.worktree_path), true);

      await updateUnitBranchStatus({ active: prepared.active, unitId: 'u-quarantine', attempt: 1, status: 'quarantined', currentSha: gitOut(quarantinedUnit.unitInfo.worktree_path, ['rev-parse', 'HEAD']), archiveRef: null });
      await expectRejects(() => cleanupTerminalUnitWorktree({ active: prepared.active, unitId: 'u-quarantine', attempt: 1, reason: 'quarantine blocker test' }), /unit-status-not-terminal/u);
      assert.equal(existsSync(quarantinedUnit.unitInfo.worktree_path), true);
    });
  });
});

async function expectRejects(run: () => Promise<unknown>, pattern?: RegExp): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (pattern !== undefined) assert.match(error instanceof Error ? error.message : String(error), pattern);
    return;
  }
  throw new Error('expected rejection');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeUnitEvidence(input: {
  readonly runtimeRoot: string;
  readonly unitCwd: string;
  readonly branch: string;
  readonly workstreamRun: string;
  readonly autopilotId: string;
  readonly beforeHead: string;
  readonly afterHead: string;
}): Promise<{ readonly statusPath: string; readonly receiptPath: string; readonly auditPath: string; readonly executionCommitPath: string }> {
  const status: AutopilotStatusEntry = {
    schema_version: 'autopilot.status.v1',
    workstream: 'phase2-smoke',
    unit_id: 'u01',
    role: 'implement',
    attempt: 1,
    verdict: 'DONE',
    severity: 'clean',
    summary: 'implemented',
    changed_paths: ['src/u01.ts'],
    findings: [],
    commands: [],
    evidence_refs: [],
    report_ref: null,
    next_action: 'merge',
  };
  const audit: AutopilotExecutionAudit = {
    schema_version: 'autopilot.execution_audit.v1',
    workstream: 'phase2-smoke',
    unit_id: 'u01',
    role: 'implement',
    attempt: 1,
    audited_at: '2026-07-08T00:00:00.000Z',
    cwd: input.unitCwd,
    git_head: input.beforeHead,
    dirty_baseline: false,
    dirty_baseline_paths: [],
    dirty_relevant_paths: [],
    actual_changed_paths: ['src/u01.ts'],
    status_reported_changed_paths: ['src/u01.ts'],
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
    summary: 'clean',
  };
  const executionCommit: AutopilotExecutionCommit = {
    schema_version: 'autopilot.execution_commit.v1',
    workstream: 'phase2-smoke',
    workstream_run: input.workstreamRun,
    autopilot_id: input.autopilotId,
    active_run_epoch: 1,
    unit_id: 'u01',
    role: 'implement',
    attempt: 1,
    cwd: input.unitCwd,
    branch: input.branch,
    claimed_paths: ['src/u01.ts'],
    edited_claimed_paths: ['src/u01.ts'],
    before_head: input.beforeHead,
    after_head: input.afterHead,
    commit_sha: input.afterHead,
    commit_subject: 'autopilot unit u01 attempt 1',
    status_ref: 'statuses/u01.implement.attempt-1.json',
    receipt_ref: 'receipts/u01.implement.attempt-1.receipt.json',
    audit_ref: 'execution-audits/u01.implement.attempt-1.json',
    created_at: '2026-07-08T00:00:00.000Z',
  };
  const statusText = `${JSON.stringify(status, null, 2)}\n`;
  const receipt: AutopilotReceipt = {
    schema_version: 'autopilot.receipt.v1',
    tool_name: 'autopilot_emit_status',
    workstream: 'phase2-smoke',
    unit_id: 'u01',
    role: 'implement',
    attempt: 1,
    emitted_at: '2026-07-08T00:00:00.000Z',
    status_output: join(input.runtimeRoot, 'statuses', 'u01.implement.attempt-1.json'),
    status_sha256: sha256Text(statusText),
    schema_sha256: `sha256:${'b'.repeat(64)}`,
    tool_call_id: 'call-u01',
    provider_identity: { provider_id: 'openai-codex', requested_model_id: 'openai-codex/gpt-5.6-terra', executed_model_id: 'openai-codex/gpt-5.6-terra', api: 'openai-codex-responses', thinking_level: 'high' },
    expected_identity_hash: `sha256:${'c'.repeat(64)}`,
  };
  const statusPath = join(input.runtimeRoot, 'statuses', 'u01.implement.attempt-1.json');
  const receiptPath = join(input.runtimeRoot, 'receipts', 'u01.implement.attempt-1.receipt.json');
  const auditPath = join(input.runtimeRoot, 'execution-audits', 'u01.implement.attempt-1.json');
  const executionCommitPath = join(input.runtimeRoot, 'execution-commits', 'u01.implement.attempt-1.json');
  await mkdir(dirname(statusPath), { recursive: true });
  await writeFile(statusPath, statusText, 'utf8');
  await writeJson(receiptPath, receipt);
  await writeJson(auditPath, audit);
  await writeJson(executionCommitPath, executionCommit);
  return { statusPath, receiptPath, auditPath, executionCommitPath };
}
