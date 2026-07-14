import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import type { AutopilotExecutionAudit, AutopilotReceipt, AutopilotState, AutopilotStatusEntry, AutopilotUnitSpec } from '../../src/core/contracts/index.ts';
import { runAutopilotClaimGc } from '../../src/core/claim-gc.ts';
import {
  AUTOPILOT_STATE_ROOT_ENV,
  CLAIM_EVENTS_FILE,
  UNIT_INDEX_FILE,
  acquireClaimsForUnit,
  prepareAutopilotUnitWorktree,
  prepareAutopilotWorkstream,
  readPathClaims,
  readUnitIndex,
  resolveActiveAutopilotForSpec,
  type ActiveAutopilotContext,
  type PreparedAutopilotWorkstream,
} from '../../src/core/parallel-runtime.ts';

void describe('claim GC runtime terminal fallback', () => {
  void it('proves completed READ claims stale in dry-run and releases them on apply', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareClaimFixture(root, 'claim-gc-owner', 'READ');
      await writeRuntimeEvidence(fixture, 'completed');
      assert.equal((await readUnitIndex(fixture.prepared.taskRoot)).units.length, 0);

      const dryRun = await runAutopilotClaimGc({
        sourceCwd: fixture.source,
        apply: false,
        now: new Date('2026-07-11T10:00:00.000Z'),
      });
      const dryCandidate = candidateForUnit(dryRun.candidates, fixture.unitId);
      assert.equal(dryCandidate.stale, true);
      assert.deepEqual(dryCandidate.blockers, []);
      assert.equal(dryCandidate.proof.some((proof) => proof.includes('validated runtime terminal proof')), true);
      assert.deepEqual(dryRun.released_claims, []);
      const preflightFiles = await readdir(join(fixture.context.coordinationRoot, 'preflight'), { withFileTypes: true });
      assert.equal(preflightFiles.some((entry) => entry.name.startsWith('20260711T100000000Z.claim-gc-dry-run.') && entry.name.endsWith('.json')), true);
      assert.equal((await readPathClaims(fixture.context.coordinationRoot)).length, 1);

      const contender = await prepareClaimFixture(root, 'claim-gc-contender', 'WRITE', fixture.source, false);
      await acquireClaimsForUnit({ context: contender.context, spec: contender.spec, reason: 'legacy READ observation must not block isolated WRITE before cleanup' });
      assert.equal((await readPathClaims(fixture.context.coordinationRoot)).length, 2);

      const applied = await runAutopilotClaimGc({
        sourceCwd: fixture.source,
        apply: true,
        now: new Date('2026-07-11T10:00:01.000Z'),
      });
      const appliedCandidate = candidateForUnit(applied.candidates, fixture.unitId);
      assert.equal(appliedCandidate.stale, true);
      assert.deepEqual(applied.released_claims, [`READ src/shared.ts ${fixture.unitId} attempt 1`]);
      assert.equal((await readPathClaims(fixture.context.coordinationRoot)).length, 1);
      const events = await readFile(join(fixture.context.coordinationRoot, CLAIM_EVENTS_FILE), 'utf8');
      assert.match(events, /autopilot claim gc mechanical stale release/u);

      const claimsAfter = await readPathClaims(contender.context.coordinationRoot);
      assert.equal(claimsAfter.some((claim) => claim.autopilot_id === contender.prepared.active.autopilot_id && claim.claim_type === 'WRITE'), true);
    });
  });

  void it('never releases a running unit claim even when matching status and audit artifacts exist', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareClaimFixture(root, 'claim-gc-running', 'READ');
      await writeRuntimeEvidence(fixture, 'running');

      const dryRun = await runAutopilotClaimGc({
        sourceCwd: fixture.source,
        apply: false,
        now: new Date('2026-07-11T10:01:00.000Z'),
      });
      const dryCandidate = candidateForUnit(dryRun.candidates, fixture.unitId);
      assert.equal(dryCandidate.stale, false);
      assert.equal(dryCandidate.blockers.some((blocker) => blocker.includes('state=running')), true);

      const applied = await runAutopilotClaimGc({
        sourceCwd: fixture.source,
        apply: true,
        now: new Date('2026-07-11T10:01:01.000Z'),
      });
      assert.deepEqual(applied.released_claims, []);
      assert.equal(candidateForUnit(applied.candidates, fixture.unitId).stale, false);
      assert.equal((await readPathClaims(fixture.context.coordinationRoot)).length, 1);
    });
  });

  void it('blocks fallback release when completed runtime evidence has mismatched audit identity', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareClaimFixture(root, 'claim-gc-mismatch', 'READ');
      await writeRuntimeEvidence(fixture, 'completed', 2);

      const applied = await runAutopilotClaimGc({
        sourceCwd: fixture.source,
        apply: true,
        now: new Date('2026-07-11T10:02:00.000Z'),
      });
      const candidate = candidateForUnit(applied.candidates, fixture.unitId);
      assert.equal(candidate.stale, false);
      assert.equal(candidate.blockers.some((blocker) => blocker.includes('audit')), true);
      assert.deepEqual(applied.released_claims, []);
      assert.equal((await readPathClaims(fixture.context.coordinationRoot)).length, 1);
    });
  });

  void it('does not use runtime completion evidence to release a WRITE claim without unit metadata', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareClaimFixture(root, 'claim-gc-write', 'WRITE', undefined, true, true);
      await writeRuntimeEvidence(fixture, 'completed');

      const applied = await runAutopilotClaimGc({
        sourceCwd: fixture.source,
        apply: true,
        now: new Date('2026-07-11T10:03:00.000Z'),
      });
      const candidate = candidateForUnit(applied.candidates, fixture.unitId);
      assert.equal(candidate.stale, false);
      assert.equal(candidate.blockers.some((blocker) => blocker.includes('only to READ claims')), true);
      assert.deepEqual(applied.released_claims, []);
      assert.equal((await readPathClaims(fixture.context.coordinationRoot)).length, 1);
    });
  });
});

type RuntimeUnitState = 'completed' | 'running';
type FixtureClaimType = 'READ' | 'WRITE';
type ClaimGcCandidate = Awaited<ReturnType<typeof runAutopilotClaimGc>>['candidates'][number];

interface ClaimFixture {
  readonly source: string;
  readonly prepared: PreparedAutopilotWorkstream;
  readonly context: ActiveAutopilotContext;
  readonly spec: AutopilotUnitSpec;
  readonly unitId: string;
}

async function prepareClaimFixture(
  root: string,
  workstream: string,
  claimType: FixtureClaimType,
  existingSource?: string,
  acquire = true,
  omitUnitMetadata = false,
): Promise<ClaimFixture> {
  const source = existingSource ?? join(root, 'source');
  if (existingSource === undefined) await initGitSource(source);
  const prepared = await prepareAutopilotWorkstream({ workstream, sourceCwd: source });
  const unitId = `${workstream}-unit`;
  const cwd = claimType === 'WRITE'
    ? join(prepared.taskRoot, 'units', unitId, 'attempt-1', 'worktree')
    : prepared.mainWorktreePath;
  const spec = unitSpec({
    workstream,
    unitId,
    cwd,
    runtimeRoot: prepared.runtimeRoot,
    claimType,
  });
  if (claimType === 'WRITE') {
    await prepareAutopilotUnitWorktree({ active: prepared.active, unitId, attempt: 1, unitSpec: spec });
  }
  const context = await resolveActiveAutopilotForSpec(spec);
  if (acquire) await acquireClaimsForUnit({ context, spec, reason: 'claim gc regression fixture' });
  if (omitUnitMetadata) await rm(join(prepared.taskRoot, UNIT_INDEX_FILE), { force: true });
  return { source, prepared, context, spec, unitId };
}

function unitSpec(input: {
  readonly workstream: string;
  readonly unitId: string;
  readonly cwd: string;
  readonly runtimeRoot: string;
  readonly claimType: FixtureClaimType;
}): AutopilotUnitSpec {
  const writeClaim = input.claimType === 'WRITE';
  return {
    schema_version: 'autopilot.unit_spec.v1',
    workstream: input.workstream,
    unit_id: input.unitId,
    role: writeClaim ? 'implement' : 'validate',
    template: writeClaim ? 'implement' : 'validate',
    attempt: 1,
    objective: 'Exercise claim GC terminal proof.',
    cwd: input.cwd,
    model: writeClaim ? 'openai-codex/gpt-5.6-terra' : 'openai-codex/gpt-5.6-sol',
    thinking: writeClaim ? 'high' : 'xhigh',
    owned_paths: writeClaim ? ['src/shared.ts'] : [],
    read_only_paths: writeClaim ? [] : ['src/shared.ts'],
    untouchable_paths: ['private/**'],
    context_refs: [
      { path: `.pi/autopilot/${input.workstream}/mission.md`, purpose: 'mission' },
      { path: `.pi/autopilot/${input.workstream}/master-plan.json`, purpose: 'plan' },
    ],
    validation_commands: [],
    status_output: join(input.runtimeRoot, 'statuses', `${input.unitId}.${writeClaim ? 'implement' : 'validate'}.attempt-1.json`),
    receipt_output: join(input.runtimeRoot, 'receipts', `${input.unitId}.${writeClaim ? 'implement' : 'validate'}.attempt-1.receipt.json`),
    evidence_dir: join(input.runtimeRoot, 'evidence', input.unitId),
    stop_boundary: 'Do not mutate outside the declared claim.',
    quality_profile: writeClaim ? 'source-change' : 'validation-only',
    risk_level: 'low',
    acceptance_criteria: ['claim GC remains evidence-backed'],
    verification_plan: {
      positive_witnesses: [],
      negative_witnesses: [],
      regression_witnesses: [],
      real_boundary_witnesses: [],
      blast_radius_checks: [],
      docs_schema_prompt_checks: [],
      dirty_tree_checks: [],
    },
    closure_criteria: ['terminal claim proof is deterministic'],
    upstream_refs: [],
  };
}

async function writeRuntimeEvidence(
  fixture: ClaimFixture,
  unitState: RuntimeUnitState,
  auditAttempt = 1,
): Promise<void> {
  const role = fixture.spec.role;
  const verdict = role === 'validate' ? 'PASS' : 'DONE';
  const statusRef = `statuses/${fixture.unitId}.${role}.attempt-1.json`;
  const receiptRef = `receipts/${fixture.unitId}.${role}.attempt-1.receipt.json`;
  const auditRef = `execution-audits/${fixture.unitId}.${role}.attempt-1.json`;
  const status: AutopilotStatusEntry = {
    schema_version: 'autopilot.status.v1',
    workstream: fixture.prepared.active.workstream,
    unit_id: fixture.unitId,
    role,
    attempt: 1,
    verdict,
    severity: 'clean',
    summary: 'unit transport completed',
    changed_paths: role === 'implement' ? ['src/shared.ts'] : [],
    findings: [],
    commands: [],
    evidence_refs: [],
    report_ref: null,
    next_action: 'release terminal claims',
  };
  const audit: AutopilotExecutionAudit = {
    schema_version: 'autopilot.execution_audit.v1',
    workstream: fixture.prepared.active.workstream,
    unit_id: fixture.unitId,
    role,
    attempt: auditAttempt,
    audited_at: '2026-07-11T10:00:00.000Z',
    cwd: fixture.prepared.mainWorktreePath,
    git_head: gitOut(fixture.prepared.mainWorktreePath, ['rev-parse', 'HEAD']),
    dirty_baseline: false,
    dirty_baseline_paths: [],
    dirty_relevant_paths: [],
    actual_changed_paths: role === 'implement' ? ['src/shared.ts'] : [],
    status_reported_changed_paths: role === 'implement' ? ['src/shared.ts'] : [],
    omitted_status_changes: [],
    reported_but_not_actual_changes: [],
    outside_owned_paths: [],
    read_only_touched_paths: [],
    untouchable_touched_paths: [],
    path_counts: {
      dirty_baseline_paths: 0,
      dirty_relevant_paths: 0,
      actual_changed_paths: role === 'implement' ? 1 : 0,
      status_reported_changed_paths: role === 'implement' ? 1 : 0,
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
    summary: 'schema-valid execution audit',
  };
  const completed = unitState === 'completed';
  const state: AutopilotState = {
    schema_version: 'autopilot.state.v1',
    workstream: fixture.prepared.active.workstream,
    updated_at: '2026-07-11T10:00:00.000Z',
    status: 'running',
    context_gate: { gate: 'ok', percent: 10 },
    last_event_id: 0,
    ready_queue: [],
    running: completed ? [] : [fixture.unitId],
    blocked: [],
    completed: completed ? [fixture.unitId] : [],
    units: {
      [fixture.unitId]: {
        unit_id: fixture.unitId,
        role,
        state: unitState,
        attempt: 1,
        status_ref: statusRef,
        receipt_ref: receiptRef,
        summary: completed ? 'completed' : 'running',
      },
    },
    operator_questions: [],
    next_actions: [],
  };
  const statusPath = join(fixture.prepared.runtimeRoot, statusRef);
  const statusBytes = `${JSON.stringify(status, null, 2)}\n`;
  await mkdir(dirname(statusPath), { recursive: true });
  await writeFile(statusPath, statusBytes, 'utf8');
  const receipt: AutopilotReceipt = {
    schema_version: 'autopilot.receipt.v1', tool_name: 'autopilot_emit_status', workstream: fixture.prepared.active.workstream,
    unit_id: fixture.unitId, role, attempt: 1, emitted_at: '2026-07-11T10:00:00.000Z', status_output: statusPath,
    status_sha256: `sha256:${createHash('sha256').update(statusBytes).digest('hex')}`, schema_sha256: `sha256:${'a'.repeat(64)}`,
    tool_call_id: `tool-${fixture.unitId}`, provider_identity: { provider_id: 'openai-codex', requested_model_id: 'openai-codex/gpt-5.6-sol', executed_model_id: 'openai-codex/gpt-5.6-sol', api: 'openai-codex-responses', thinking_level: 'xhigh' },
    expected_identity_hash: `sha256:${'b'.repeat(64)}`,
  };
  await writeJson(join(fixture.prepared.runtimeRoot, receiptRef), receipt);
  await writeJson(join(fixture.prepared.runtimeRoot, auditRef), audit);
  await writeJson(join(fixture.prepared.runtimeRoot, 'state.json'), state);
}

function candidateForUnit(candidates: readonly ClaimGcCandidate[], unitId: string): ClaimGcCandidate {
  const candidate = candidates.find((entry) => entry.claim.unit_id === unitId);
  if (candidate === undefined) throw new Error(`missing claim GC candidate for ${unitId}`);
  return candidate;
}

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-claim-gc-test-'));
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
  await writeFile(join(source, 'src', 'shared.ts'), 'export const shared = true;\n', 'utf8');
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

async function expectRejects(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), pattern);
    return;
  }
  throw new Error('expected rejection');
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
