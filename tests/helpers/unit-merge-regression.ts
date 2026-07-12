import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AutopilotExecutionAudit, AutopilotExecutionCommit, AutopilotReceipt, AutopilotStatusEntry, AutopilotUnitSpec } from '../../src/core/contracts/index.ts';
import type { mergeAutopilotUnit } from '../../src/core/unit-merge.ts';
import {
  AUTOPILOT_STATE_ROOT_ENV,
  acquireClaimsForUnit,
  prepareAutopilotUnitWorktree,
  prepareAutopilotWorkstream,
  readPathClaims,
  readUnitIndex,
  resolveActiveAutopilotForSpec,
  type PreparedAutopilotWorkstream,
} from '../../src/core/parallel-runtime.ts';

export type AutopilotUnitMergeExecutor = typeof mergeAutopilotUnit;

export async function assertUnitMergeHappyPath(executeMerge: AutopilotUnitMergeExecutor): Promise<void> {
  await withTempDir(async (root) => {
    const fixture = await prepareUnitFixture(root);
    const result = await executeMerge({
      context: fixture.context,
      unitId: 'u01',
      attempt: 1,
      statusPath: fixture.evidence.statusPath,
      receiptPath: fixture.evidence.receiptPath,
      auditPath: fixture.evidence.auditPath,
      executionCommitPath: fixture.evidence.executionCommitPath,
      now: new Date('2026-07-11T00:00:00.000Z'),
    });

    assert.equal(result.outcome, 'merged');
    assert.deepEqual(result.blockers, []);
    assert.equal(result.conflict_path, null);
    const merge = result.merge;
    if (merge === null) throw new Error('expected unit merge evidence');
    assert.equal(merge.unit_head, fixture.validatedHead);
    assert.equal(gitOut(fixture.prepared.mainWorktreePath, ['rev-parse', `${merge.integration_after}^2`]), fixture.validatedHead);
    assert.deepEqual(merge.changed_paths, ['src/u01.ts']);
    assert.equal(gitOut(fixture.prepared.mainWorktreePath, ['show', `${merge.integration_after}:src/u01.ts`]), 'export const u01 = "validated";');
  });
}

export async function assertUnitMergeCrashResumePreservesOriginalDiff(executeMerge: AutopilotUnitMergeExecutor): Promise<void> {
  await withTempDir(async (root) => {
    const fixture = await prepareUnitFixture(root);
    const integrationBefore = gitOut(fixture.prepared.mainWorktreePath, ['rev-parse', 'HEAD']);
    const intentPath = join(fixture.prepared.runtimeRoot, 'unit-merge-intents', 'u01.implement.attempt-1.json');
    await mkdir(dirname(intentPath), { recursive: true });
    await writeFile(intentPath, `${JSON.stringify({ schema_version: 'autopilot.unit_merge_intent.v1', workstream: fixture.prepared.active.workstream, workstream_run: fixture.prepared.active.workstream_run, autopilot_id: fixture.prepared.active.autopilot_id, unit_id: 'u01', role: 'implement', attempt: 1, unit_head: fixture.validatedHead, integration_before: integrationBefore, created_at: '2026-07-12T00:00:00.000Z' })}\n`, 'utf8');
    git(fixture.prepared.mainWorktreePath, ['merge', '--no-ff', '--no-edit', '-m', 'simulated crash after Git merge', fixture.validatedHead]);
    const result = await executeMerge({ context: fixture.context, unitId: 'u01', attempt: 1, statusPath: fixture.evidence.statusPath, receiptPath: fixture.evidence.receiptPath, auditPath: fixture.evidence.auditPath, executionCommitPath: fixture.evidence.executionCommitPath, now: new Date('2026-07-12T00:00:01.000Z') });
    assert.equal(result.outcome, 'merged');
    assert.equal(result.merge?.integration_before, integrationBefore);
    assert.deepEqual(result.merge?.changed_paths, ['src/u01.ts']);
  });
}

export async function assertUnitMergeDriftBlocksWithoutMutation(executeMerge: AutopilotUnitMergeExecutor): Promise<void> {
  await withTempDir(async (root) => {
    const fixture = await prepareUnitFixture(root);
    await writeFile(join(fixture.unitCwd, 'src', 'u01.ts'), 'export const u01 = "drifted";\n', 'utf8');
    git(fixture.unitCwd, ['add', 'src/u01.ts']);
    git(fixture.unitCwd, ['commit', '-m', 'unvalidated branch drift']);
    const driftedHead = gitOut(fixture.unitCwd, ['rev-parse', 'HEAD']);
    assert.equal(driftedHead === fixture.validatedHead, false);

    const integrationHeadBefore = gitOut(fixture.prepared.mainWorktreePath, ['rev-parse', 'HEAD']);
    const integrationStatusBefore = gitOut(fixture.prepared.mainWorktreePath, ['status', '--short']);
    const result = await executeMerge({
      context: fixture.context,
      unitId: 'u01',
      attempt: 1,
      statusPath: fixture.evidence.statusPath,
      receiptPath: fixture.evidence.receiptPath,
      auditPath: fixture.evidence.auditPath,
      executionCommitPath: fixture.evidence.executionCommitPath,
      now: new Date('2026-07-11T00:00:01.000Z'),
    });

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.merge, null);
    assert.equal(result.conflict_path, null);
    assert.deepEqual(result.blockers, [
      `unit worktree HEAD ${driftedHead} does not match execution commit ${fixture.validatedHead}`,
    ]);
    assert.equal(gitOut(fixture.prepared.mainWorktreePath, ['rev-parse', 'HEAD']), integrationHeadBefore);
    assert.equal(gitOut(fixture.prepared.mainWorktreePath, ['status', '--short']), integrationStatusBefore);
    assert.equal(isAncestor(fixture.prepared.mainWorktreePath, fixture.validatedHead, integrationHeadBefore), false);
    assert.equal(isAncestor(fixture.prepared.mainWorktreePath, driftedHead, integrationHeadBefore), false);
    assert.equal(existsSync(join(fixture.prepared.runtimeRoot, 'unit-merges', 'u01.implement.attempt-1.json')), false);
    assert.equal(existsSync(join(fixture.prepared.runtimeRoot, 'merge-conflicts')), false);
    assert.equal((await readPathClaims(fixture.context.coordinationRoot)).length, 1);
    const unitRow = (await readUnitIndex(fixture.prepared.taskRoot)).units.find((candidate) => candidate.unit_id === 'u01' && candidate.attempt === 1);
    assert.equal(unitRow?.status, 'active');
    assert.equal(existsSync(fixture.unitCwd), true);
    assert.equal(gitOut(fixture.prepared.active.source_repo, ['rev-parse', `refs/heads/${fixture.unitBranch}`]), driftedHead);
    assert.equal(refExists(fixture.prepared.active.source_repo, `refs/heads/autopilot/archive/${fixture.prepared.active.workstream_run}/unit/u01/attempt-1`), false);
  });
}

interface UnitEvidencePaths {
  readonly statusPath: string;
  readonly receiptPath: string;
  readonly auditPath: string;
  readonly executionCommitPath: string;
}

interface UnitFixture {
  readonly prepared: PreparedAutopilotWorkstream;
  readonly context: Awaited<ReturnType<typeof resolveActiveAutopilotForSpec>>;
  readonly unitCwd: string;
  readonly unitBranch: string;
  readonly validatedHead: string;
  readonly evidence: UnitEvidencePaths;
}

async function prepareUnitFixture(root: string): Promise<UnitFixture> {
  const source = join(root, 'source');
  await initGitSource(source);
  const prepared = await prepareAutopilotWorkstream({ workstream: 'unit-merge-regression', sourceCwd: source });
  const expectedUnitCwd = join(prepared.taskRoot, 'units', 'u01', 'attempt-1', 'worktree');
  const spec = unitSpec(expectedUnitCwd, prepared.runtimeRoot);
  const unit = await prepareAutopilotUnitWorktree({ active: prepared.active, unitId: 'u01', attempt: 1, unitSpec: spec });
  const context = await resolveActiveAutopilotForSpec(spec);
  await acquireClaimsForUnit({ context, spec, reason: 'unit merge regression fixture' });
  const beforeHead = gitOut(unit.unitInfo.worktree_path, ['rev-parse', 'HEAD']);
  await writeFile(join(unit.unitInfo.worktree_path, 'src', 'u01.ts'), 'export const u01 = "validated";\n', 'utf8');
  git(unit.unitInfo.worktree_path, ['add', 'src/u01.ts']);
  git(unit.unitInfo.worktree_path, ['commit', '-m', 'validated unit commit']);
  const validatedHead = gitOut(unit.unitInfo.worktree_path, ['rev-parse', 'HEAD']);
  const evidence = await writeUnitEvidence({
    runtimeRoot: prepared.runtimeRoot,
    unitCwd: unit.unitInfo.worktree_path,
    branch: unit.unitInfo.branch,
    workstreamRun: prepared.active.workstream_run,
    autopilotId: prepared.active.autopilot_id,
    activeRunEpoch: prepared.active.active_run_epoch,
    beforeHead,
    validatedHead,
  });
  return {
    prepared,
    context,
    unitCwd: unit.unitInfo.worktree_path,
    unitBranch: unit.unitInfo.branch,
    validatedHead,
    evidence,
  };
}

function unitSpec(cwd: string, runtimeRoot: string): AutopilotUnitSpec {
  return {
    schema_version: 'autopilot.unit_spec.v1',
    workstream: 'unit-merge-regression',
    unit_id: 'u01',
    role: 'implement',
    template: 'implement',
    attempt: 1,
    objective: 'Exercise exact execution-commit mergeback.',
    cwd,
    model: 'openai-codex/gpt-5.6-terra',
    thinking: 'high',
    owned_paths: ['src/u01.ts'],
    read_only_paths: [],
    untouchable_paths: ['private/**'],
    context_refs: [
      { path: '.pi/autopilot/unit-merge-regression/mission.md', purpose: 'mission' },
      { path: '.pi/autopilot/unit-merge-regression/master-plan.json', purpose: 'plan' },
    ],
    validation_commands: [],
    status_output: join(runtimeRoot, 'statuses', 'u01.implement.attempt-1.json'),
    receipt_output: join(runtimeRoot, 'receipts', 'u01.implement.attempt-1.receipt.json'),
    evidence_dir: join(runtimeRoot, 'evidence', 'u01'),
    stop_boundary: 'Edit only the owned path.',
    quality_profile: 'source-change',
    risk_level: 'high',
    acceptance_criteria: ['mergeback selects only the evidenced commit'],
    verification_plan: {
      positive_witnesses: [],
      negative_witnesses: [],
      regression_witnesses: [],
      real_boundary_witnesses: [],
      blast_radius_checks: [],
      docs_schema_prompt_checks: [],
      dirty_tree_checks: [],
    },
    closure_criteria: ['branch drift blocks without integration mutation'],
    upstream_refs: [],
  };
}

async function writeUnitEvidence(input: {
  readonly runtimeRoot: string;
  readonly unitCwd: string;
  readonly branch: string;
  readonly workstreamRun: string;
  readonly autopilotId: string;
  readonly activeRunEpoch: number;
  readonly beforeHead: string;
  readonly validatedHead: string;
}): Promise<UnitEvidencePaths> {
  const status: AutopilotStatusEntry = {
    schema_version: 'autopilot.status.v1',
    workstream: 'unit-merge-regression',
    unit_id: 'u01',
    role: 'implement',
    attempt: 1,
    verdict: 'DONE',
    severity: 'clean',
    summary: 'validated implementation complete',
    changed_paths: ['src/u01.ts'],
    findings: [],
    commands: [],
    evidence_refs: [],
    report_ref: null,
    next_action: 'merge exact execution commit',
  };
  const audit: AutopilotExecutionAudit = {
    schema_version: 'autopilot.execution_audit.v1',
    workstream: 'unit-merge-regression',
    unit_id: 'u01',
    role: 'implement',
    attempt: 1,
    audited_at: '2026-07-11T00:00:00.000Z',
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
    summary: 'clean execution audit',
  };
  const executionCommit: AutopilotExecutionCommit = {
    schema_version: 'autopilot.execution_commit.v1',
    workstream: 'unit-merge-regression',
    workstream_run: input.workstreamRun,
    autopilot_id: input.autopilotId,
    active_run_epoch: input.activeRunEpoch,
    unit_id: 'u01',
    role: 'implement',
    attempt: 1,
    cwd: input.unitCwd,
    branch: input.branch,
    claimed_paths: ['src/u01.ts'],
    edited_claimed_paths: ['src/u01.ts'],
    before_head: input.beforeHead,
    after_head: input.validatedHead,
    commit_sha: input.validatedHead,
    commit_subject: 'validated unit commit',
    commit_origin: 'child',
    commit_shas: [input.validatedHead],
    status_ref: 'statuses/u01.implement.attempt-1.json',
    receipt_ref: 'receipts/u01.implement.attempt-1.receipt.json',
    audit_ref: 'execution-audits/u01.implement.attempt-1.json',
    created_at: '2026-07-11T00:00:00.000Z',
  };
  const statusText = `${JSON.stringify(status, null, 2)}\n`;
  const receipt: AutopilotReceipt = {
    schema_version: 'autopilot.receipt.v1',
    tool_name: 'autopilot_emit_status',
    workstream: 'unit-merge-regression',
    unit_id: 'u01',
    role: 'implement',
    attempt: 1,
    emitted_at: '2026-07-11T00:00:00.000Z',
    status_output: join(input.runtimeRoot, 'statuses', 'u01.implement.attempt-1.json'),
    status_sha256: sha256Text(statusText),
    schema_sha256: `sha256:${'b'.repeat(64)}`,
    tool_call_id: 'call-unit-merge-regression',
    provider_identity: {
      provider_id: 'openai-codex',
      requested_model_id: 'openai-codex/gpt-5.6-terra',
      executed_model_id: 'openai-codex/gpt-5.6-terra',
      api: 'openai-codex-responses',
      thinking_level: 'high',
    },
    expected_identity_hash: `sha256:${'c'.repeat(64)}`,
  };
  const statusPath = join(input.runtimeRoot, 'statuses', 'u01.implement.attempt-1.json');
  const receiptPath = join(input.runtimeRoot, 'receipts', 'u01.implement.attempt-1.receipt.json');
  const auditPath = join(input.runtimeRoot, 'execution-audits', 'u01.implement.attempt-1.json');
  const executionCommitPath = join(input.runtimeRoot, 'execution-commits', 'u01.implement.attempt-1.json');
  await writeJson(statusPath, status);
  await writeJson(receiptPath, receipt);
  await writeJson(auditPath, audit);
  await writeJson(executionCommitPath, executionCommit);
  return { statusPath, receiptPath, auditPath, executionCommitPath };
}

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-unit-merge-regression-'));
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256Text(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function gitOut(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, encoding: 'utf8' });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(result.stderr.trim());
}

function refExists(cwd: string, ref: string): boolean {
  const result = spawnSync('git', ['show-ref', '--verify', '--quiet', ref], { cwd, encoding: 'utf8' });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(result.stderr.trim());
}
