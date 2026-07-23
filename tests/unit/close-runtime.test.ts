import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { AUTOPILOT_TERMINAL_CLEANUP_BOUNDARIES, AutopilotCloseError, abortAutopilotWorkstream, closeAutopilotWorkstream, closeRuntimeTestInternals } from '../../src/core/close-runtime.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { DurableRunSupervisorClient, readCoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { ensureMainWorktreeSagaRegistered } from '../../src/core/coordination/worktree-saga.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { materializeAutopilotSpecPaths } from '../../src/core/materialization.ts';
import type { AutopilotExecutionAudit, AutopilotExecutionCommit, AutopilotMasterPlan, AutopilotState, AutopilotStatusEntry, AutopilotUnitSpec } from '../../src/core/contracts/index.ts';
import { buildCanonicalPreRunSelection } from '../../src/core/roster/run-selection.ts';
import { canonicalRosterJson } from '../../src/core/roster/canonical.ts';
import { computeAutopilotRosterContractObjectHash, parseAutopilotRoster } from '../../src/core/roster/contracts.ts';
import { resolveRosterScopePaths, rosterRevisionPath } from '../../src/core/roster/paths.ts';
import { buildW4CertifiedRosterForCandidate, SEED_CANDIDATES } from '../../src/core/roster/provider-recipes.ts';
import { requestProfileFromAssignment } from '../../src/core/roster/runtime-spec.ts';
import { authorizeExistingRunRosterTransitionInput, buildExistingRunRosterTransitionProposal, commitApprovedExistingRunRosterTransition, savedRosterRefForSelection, type AutopilotSavedRosterRefV1 } from '../../src/core/roster/transition.ts';
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
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'autopilot-close-test-'));
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

function assertCloseTestDigest(value: string): asserts value is `sha256:${string}` {
  assert.match(value, /^sha256:[a-f0-9]{64}$/u);
}

function closeTestDigest(hex: '9' | 'a' | 'b' | 'c' | 'd' | 'e' | 'f'): `sha256:${string}` {
  const digest = `sha256:${hex.repeat(64)}`;
  assertCloseTestDigest(digest);
  return digest;
}

function closeTransitionRef(label: 'from' | 'to' | 'fork'): AutopilotSavedRosterRefV1 {
  return {
    roster_id: `${label}-close-roster`,
    roster_revision: 1,
    roster_sha256: closeTestDigest(label === 'from' ? 'a' : label === 'to' ? 'b' : 'e'),
    assignment_set_sha256: closeTestDigest(label === 'from' ? 'c' : label === 'to' ? 'd' : 'f'),
    path: `/authority/${label}-close-roster.json`,
  };
}

async function installCloseRosterSelection(input: {
  readonly stateRoot: string;
  readonly mainWorktreePath: string;
  readonly workstream: string;
  readonly repoId: string;
  readonly workstreamRun: string;
}): Promise<ReturnType<typeof buildCanonicalPreRunSelection>['selection']> {
  const canonical = buildCanonicalPreRunSelection({
    stateRoot: input.stateRoot,
    repo_id: input.repoId,
    workstream_run: input.workstreamRun,
    selected: {
      scope: 'user',
      roster_id: closeTransitionRef('from').roster_id,
      roster_revision: closeTransitionRef('from').roster_revision,
      roster_sha256: closeTestDigest('a'),
      assignment_set_sha256: closeTestDigest('c'),
      config_sha256: closeTestDigest('9'),
    },
  });
  await mkdir(dirname(canonical.selection_path), { recursive: true, mode: 0o700 });
  await chmod(input.stateRoot, 0o700).catch(() => undefined);
  await chmod(join(input.stateRoot, 'roster-selections'), 0o700).catch(() => undefined);
  await chmod(dirname(canonical.selection_path), 0o700);
  await writeFile(canonical.selection_path, canonical.selection_bytes, { mode: 0o600 });
  await chmod(canonical.selection_path, 0o600);
  const mirror = join(input.mainWorktreePath, '.pi', 'autopilot', input.workstream, 'roster-snapshot.json');
  await mkdir(dirname(mirror), { recursive: true, mode: 0o700 });
  await chmod(join(input.mainWorktreePath, '.pi'), 0o700).catch(() => undefined);
  await chmod(join(input.mainWorktreePath, '.pi', 'autopilot'), 0o700).catch(() => undefined);
  await chmod(dirname(mirror), 0o700);
  await writeFile(mirror, canonical.selection_bytes, { mode: 0o600 });
  await chmod(mirror, 0o600);
  return canonical.selection;
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
  await materializeAutopilotSpecPaths({ context: activeContext, spec, reason: 'close-runtime test setup materialization', allowLegacyV1RuntimeSpec: true });
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

async function commitCloseRosterTransition(root: string, fixture: PreparedCloseFixture, toRoster: AutopilotSavedRosterRefV1 = closeTransitionRef('to')): Promise<Awaited<ReturnType<typeof commitApprovedExistingRunRosterTransition>>> {
  const stateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV] ?? join(root, 'autopilot-state');
  const active = (await readActiveAutopilots(coordinationRootForRepo(fixture.repoKey))).find((row) => row.workstream_run === fixture.workstreamRun);
  if (active === undefined) throw new Error('active row missing');
  const selection = await installCloseRosterSelection({ stateRoot, mainWorktreePath: active.main_worktree_path, workstream: active.workstream, repoId: active.repo_key, workstreamRun: active.workstream_run });
  const run = { repo_id: active.repo_key, workstream: active.workstream, workstream_run: active.workstream_run, main_worktree_path: active.main_worktree_path, runtime_root: active.runtime_root, source_repo: active.source_repo };
  const fromRoster = savedRosterRefForSelection({ selection, stateRoot, trustedProjectRoot: active.source_repo });
  const proposal = buildExistingRunRosterTransitionProposal({ stateRoot, run, from_roster: fromRoster, to_roster: toRoster, reason: 'close fresh validation test', approved_at: '2026-07-23T00:00:00.000Z' });
  const approval = authorizeExistingRunRosterTransitionInput({ proposal, source: 'user', text: proposal.approval_phrase }).approval;
  if (approval === null) throw new Error('missing transition approval');
  const committed = await commitApprovedExistingRunRosterTransition({ stateRoot, run, proposal, approval, expected_active_run: run });
  assert.equal(committed.ok, true, committed.diagnostics.map((diagnostic) => diagnostic.code).join(', '));
  return committed;
}

async function writeValidationEvidence(runtimeRoot: string, name: string, validatedAt: string): Promise<void> {
  await writeJson(join(runtimeRoot, 'validation', name), {
    schema_version: 'autopilot.validation_evidence.v1',
    workstream: 'close-smoke',
    source_unit_id: 'u01-implement',
    source_attempt: 1,
    validation_unit_id: `v-${name.replace(/[^a-z0-9]+/giu, '-')}`,
    validation_attempt: 2,
    unit_merge_ref: 'unit-merges/missing.json',
    integration_head: `sha256:${'0'.repeat(64)}`,
    covered_paths: ['src/smoke.ts'],
    covered_path_groups: [],
    witness_ids: ['negative-transition-freshness-test'],
    status_ref: 'statuses/missing-transition-validation.json',
    status_sha256: `sha256:${'1'.repeat(64)}`,
    receipt_ref: 'receipts/missing-transition-validation.json',
    receipt_sha256: `sha256:${'2'.repeat(64)}`,
    audit_ref: 'execution-audits/missing-transition-validation.json',
    audit_sha256: `sha256:${'3'.repeat(64)}`,
    verdict: 'PASS',
    validated_at: validatedAt,
  });
}

function closeSha256(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function requireRosterHash(value: string | null): `sha256:${string}` {
  if (value === null) throw new Error('missing roster hash');
  assert.match(value, /^sha256:[a-f0-9]{64}$/u);
  return value as `sha256:${string}`;
}

async function installCloseTargetRoster(stateRoot: string): Promise<{ readonly roster: ReturnType<typeof parseAutopilotRoster>; readonly ref: AutopilotSavedRosterRefV1; readonly assignmentSha256: `sha256:${string}`; readonly requestProfile: ReturnType<typeof requestProfileFromAssignment> }> {
  const candidate = SEED_CANDIDATES.find((entry) => entry.candidate_id === 'kimi-coding-precision-v1');
  if (candidate === undefined) throw new Error('missing W4 target roster candidate');
  const roster = buildW4CertifiedRosterForCandidate({ candidate, certification_manifest_id: 'close-boundary-cert', certification_manifest_sha256: `sha256:${'c'.repeat(64)}` });
  if (roster === null) throw new Error('target roster unavailable');
  const assignment = roster.assignments.find((entry) => entry.role === 'validate');
  if (assignment === undefined) throw new Error('target roster missing validate assignment');
  const paths = resolveRosterScopePaths({ scope: 'user', stateRoot });
  const rosterPath = rosterRevisionPath(paths, roster);
  await mkdir(dirname(rosterPath), { recursive: true, mode: 0o700 });
  await writeFile(rosterPath, `${canonicalRosterJson(roster)}\n`, 'utf8');
  return {
    roster: parseAutopilotRoster(roster),
    ref: { roster_id: roster.roster_id, roster_revision: roster.roster_revision, roster_sha256: roster.roster_sha256, assignment_set_sha256: roster.assignment_set_sha256, path: rosterPath },
    assignmentSha256: requireRosterHash(assignment.assignment_sha256),
    requestProfile: requestProfileFromAssignment(assignment),
  };
}

async function writeBoundTransitionValidationEvidence(input: {
  readonly runtimeRoot: string;
  readonly committed: Awaited<ReturnType<typeof commitApprovedExistingRunRosterTransition>>;
  readonly target: Awaited<ReturnType<typeof installCloseTargetRoster>>;
  readonly preRunSelectionSha256: string;
  readonly validatedAt: string;
  readonly name: string;
  readonly integrationHead: string;
}): Promise<string> {
  const unitId = 'v-transition-boundary';
  const attempt = 2;
  const statusRef = `statuses/${input.name}.validate.attempt-2.json`;
  const receiptRef = `receipts/${input.name}.validate.attempt-2.receipt.json`;
  const auditRef = `execution-audits/${input.name}.validate.attempt-2.json`;
  const statusPath = join(input.runtimeRoot, statusRef);
  const receiptPath = join(input.runtimeRoot, receiptRef);
  const auditPath = join(input.runtimeRoot, auditRef);
  await Promise.all([mkdir(dirname(statusPath), { recursive: true }), mkdir(dirname(receiptPath), { recursive: true }), mkdir(dirname(auditPath), { recursive: true })]);
  const transition = input.committed.transition;
  const transitionArtifactSha256 = input.committed.transition_artifact_sha256;
  if (transition === null || transitionArtifactSha256 === null) throw new Error('committed transition missing authenticated artifact');
  const transitionBytes = await readFile(input.committed.runtime_transition_path);
  const spec = {
    schema_version: 'autopilot.unit_spec.v2',
    workstream: 'close-smoke',
    unit_id: unitId,
    role: 'validate',
    template: 'validate',
    attempt,
    objective: 'Validate the transition target roster after approval.',
    cwd: dirname(input.runtimeRoot),
    model: input.target.requestProfile['model'],
    thinking: input.target.requestProfile['thinking'],
    owned_paths: [],
    read_only_paths: ['src/smoke.ts'],
    untouchable_paths: [],
    context_refs: [{ path: input.committed.runtime_transition_ref, purpose: `committed existing-run roster transition ${transition.transition_id}`, sha256: transitionArtifactSha256, byte_count: transitionBytes.byteLength }],
    validation_commands: ['npm test -- close transition boundary'],
    status_output: statusPath,
    receipt_output: receiptPath,
    evidence_dir: join(input.runtimeRoot, 'evidence', unitId),
    stop_boundary: 'Validate only.',
    quality_profile: 'source-change-validation',
    risk_level: 'medium',
    acceptance_criteria: ['transition-bound validation passes'],
    verification_plan: emptyVerificationPlan(),
    closure_criteria: ['fresh transition validation passes'],
    upstream_refs: [{ unit_id: 'u01-implement', purpose: 'source under validation', status_ref: 'statuses/u01-implement.implement.attempt-1.json', audit_ref: 'execution-audits/u01-implement.implement.attempt-1.json' }],
    timeout_seconds: 3600,
    render_prompt_snapshot: true,
    roster_id: input.target.roster.roster_id,
    roster_revision: input.target.roster.roster_revision,
    roster_sha256: input.target.roster.roster_sha256,
    assignment_sha256: input.target.assignmentSha256,
    pre_run_selection_sha256: input.preRunSelectionSha256,
    request_profile: input.target.requestProfile,
  };
  await writeJson(join(input.runtimeRoot, 'unit-specs', `${unitId}.validate.attempt-2.json`), spec);
  const reportRef = `evidence/${unitId}/${input.name}.md`;
  const reportBytes = Buffer.from('transition-bound validation report\n', 'utf8');
  const reportEvidenceRef = { path: reportRef, sha256: closeSha256(reportBytes), byte_count: reportBytes.byteLength };
  await mkdir(dirname(join(input.runtimeRoot, reportRef)), { recursive: true });
  await writeFile(join(input.runtimeRoot, reportRef), reportBytes);
  const status = {
    schema_version: 'autopilot.status.v1',
    workstream: 'close-smoke',
    unit_id: unitId,
    role: 'validate',
    attempt,
    verdict: 'PASS',
    severity: 'clean',
    summary: 'Transition-bound validation passed.',
    changed_paths: [],
    findings: [],
    commands: [{ command: 'npm test -- close transition boundary', status: 'passed', exit_code: 0, summary: 'passed' }],
    evidence_refs: [reportEvidenceRef],
    report_ref: reportEvidenceRef,
    next_action: 'close',
  };
  const statusBytes = Buffer.from(`${JSON.stringify(status, null, 2)}\n`, 'utf8');
  const statusSha256 = closeSha256(statusBytes);
  await writeFile(statusPath, statusBytes);
  const observedProfileBase = {
    provider_id: input.target.requestProfile['provider_id'],
    requested_model_id: input.target.requestProfile['model_id'],
    executed_model_id: input.target.requestProfile['model_id'],
    api: input.target.requestProfile['api'],
    thinking: input.target.requestProfile['thinking'],
    service_tier: input.target.requestProfile['service_tier'],
    cache_policy: input.target.requestProfile['cache_policy'],
    system_prompt_profile: input.target.requestProfile['system_prompt_profile'],
    system_prompt_sha256: `sha256:${'a'.repeat(64)}`,
    route_policy_id: input.target.requestProfile['route_policy_id'],
    route_policy_revision: input.target.requestProfile['route_policy_revision'],
    request_profile_sha256: input.target.requestProfile['request_profile_sha256'],
    observed_profile_sha256: `sha256:${'0'.repeat(64)}`,
  };
  const observedProfile = { ...observedProfileBase, observed_profile_sha256: requireRosterHash(computeAutopilotRosterContractObjectHash('autopilot.observed_profile.v1', observedProfileBase)) };
  const receipt = {
    schema_version: 'autopilot.receipt.v2',
    tool_name: 'autopilot_emit_status',
    workstream: 'close-smoke',
    unit_id: unitId,
    role: 'validate',
    attempt,
    emitted_at: input.validatedAt,
    status_output: statusPath,
    status_sha256: statusSha256,
    schema_sha256: `sha256:${'b'.repeat(64)}`,
    tool_call_id: `call-${input.name}`,
    provider_identity: {
      provider_id: input.target.requestProfile['provider_id'],
      requested_model_id: input.target.requestProfile['model_id'],
      executed_model_id: input.target.requestProfile['model_id'],
      api: input.target.requestProfile['api'],
      thinking_level: input.target.requestProfile['thinking'],
    },
    expected_identity_hash: `sha256:${'d'.repeat(64)}`,
    roster_id: input.target.roster.roster_id,
    roster_revision: input.target.roster.roster_revision,
    roster_sha256: input.target.roster.roster_sha256,
    assignment_sha256: input.target.assignmentSha256,
    pre_run_selection_sha256: input.preRunSelectionSha256,
    request_profile: input.target.requestProfile,
    observed_profile: observedProfile,
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await writeFile(receiptPath, receiptBytes);
  const audit = {
    schema_version: 'autopilot.execution_audit.v1',
    workstream: 'close-smoke',
    unit_id: unitId,
    role: 'validate',
    attempt,
    audited_at: input.validatedAt,
    cwd: dirname(input.runtimeRoot),
    git_head: input.integrationHead,
    dirty_baseline: false,
    dirty_baseline_paths: [],
    dirty_relevant_paths: [],
    actual_changed_paths: [],
    status_reported_changed_paths: [],
    omitted_status_changes: [],
    reported_but_not_actual_changes: [],
    outside_owned_paths: [],
    read_only_touched_paths: [],
    untouchable_touched_paths: [],
    path_counts: { dirty_baseline_paths: 0, dirty_relevant_paths: 0, actual_changed_paths: 0, status_reported_changed_paths: 0, omitted_status_changes: 0, reported_but_not_actual_changes: 0, outside_owned_paths: 0, read_only_touched_paths: 0, untouchable_touched_paths: 0 },
    truncated_path_sets: [],
    declared_validation_commands: ['npm test -- close transition boundary'],
    status_reported_commands: ['npm test -- close transition boundary'],
    command_coverage_gaps: [],
    classification: 'clean',
    evidence_refs: [],
    summary: 'Clean transition-bound validation audit.',
  };
  const auditBytes = Buffer.from(`${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  await writeFile(auditPath, auditBytes);
  const validationRef = `validation/${input.name}.json`;
  await writeJson(join(input.runtimeRoot, validationRef), {
    schema_version: 'autopilot.validation_evidence.v1',
    workstream: 'close-smoke',
    source_unit_id: 'u01-implement',
    source_attempt: 1,
    validation_unit_id: unitId,
    validation_attempt: attempt,
    unit_merge_ref: 'unit-merges/u01-implement.implement.attempt-1.json',
    integration_head: input.integrationHead,
    covered_paths: ['src/smoke.ts'],
    covered_path_groups: [],
    witness_ids: ['strict-post-transition-boundary'],
    status_ref: statusRef,
    status_sha256: statusSha256,
    receipt_ref: receiptRef,
    receipt_sha256: closeSha256(receiptBytes),
    audit_ref: auditRef,
    audit_sha256: closeSha256(auditBytes),
    verdict: 'PASS',
    validated_at: input.validatedAt,
  });
  return validationRef;
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

  void it('blocks close after a roster transition until fresh target-roster validation exists', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      await commitCloseRosterTransition(root, fixture);
      const result = await closeAutopilotWorkstream({ workstream: 'close-smoke', sourceCwd: fixture.source, workstreamRun: fixture.workstreamRun, dryRun: true });
      assert.equal(result.outcome, 'dry-run');
      assert.equal(result.blockers.some((blocker) => /requires post-transition independent target-roster validate\/bughunt evidence|target roster cannot be authenticated/u.test(blocker)), true, result.blockers.join('\n'));
    });
  });

  void it('blocks close when a committed roster transition runtime mirror is missing or deleted', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      const committed = await commitCloseRosterTransition(root, fixture);
      await rm(committed.runtime_transition_path, { force: true });
      const result = await closeAutopilotWorkstream({ workstream: 'close-smoke', sourceCwd: fixture.source, workstreamRun: fixture.workstreamRun, dryRun: true });
      assert.equal(result.outcome, 'dry-run');
      assert.equal(result.blockers.some((blocker) => /runtime mirror is missing|byte-equal linear chain/u.test(blocker)), true);
    });
  });

  void it('blocks close when a roster transition exists only in runtime', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      const committed = await commitCloseRosterTransition(root, fixture);
      await rm(committed.transition_path, { force: true });
      const result = await closeAutopilotWorkstream({ workstream: 'close-smoke', sourceCwd: fixture.source, workstreamRun: fixture.workstreamRun, dryRun: true });
      assert.equal(result.outcome, 'dry-run');
      assert.equal(result.blockers.some((blocker) => /no authenticated external counterpart|absent from authenticated external chain/u.test(blocker)), true);
    });
  });

  void it('blocks close when roster transition runtime bytes drift from external authority', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      const committed = await commitCloseRosterTransition(root, fixture);
      const drift = Buffer.from(await readFile(committed.runtime_transition_path, 'utf8').then((text) => text.replace('close fresh validation test', 'close drift validation test')), 'utf8');
      await writeFile(committed.runtime_transition_path, drift);
      const result = await closeAutopilotWorkstream({ workstream: 'close-smoke', sourceCwd: fixture.source, workstreamRun: fixture.workstreamRun, dryRun: true });
      assert.equal(result.outcome, 'dry-run');
      assert.equal(result.blockers.some((blocker) => /byte-equal linear chain|READBACK_MISMATCH/u.test(blocker)), true);
    });
  });

  void it('blocks close when authenticated roster transition history forks', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      await commitCloseRosterTransition(root, fixture);
      await commitCloseRosterTransition(root, fixture, closeTransitionRef('fork'));
      const result = await closeAutopilotWorkstream({ workstream: 'close-smoke', sourceCwd: fixture.source, workstreamRun: fixture.workstreamRun, dryRun: true });
      assert.equal(result.outcome, 'dry-run');
      assert.equal(result.blockers.some((blocker) => /byte-equal linear chain|TRANSITION_REQUIRED/u.test(blocker)), true);
    });
  });

  void it('blocks close on invalid or pre-transition post-transition validation timestamps', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      await commitCloseRosterTransition(root, fixture);
      await writeValidationEvidence(fixture.runtimeRoot, 'invalid-date.json', 'not-a-date');
      await writeValidationEvidence(fixture.runtimeRoot, 'pre-transition-date.json', '2026-07-22T23:59:59.999Z');
      const result = await closeAutopilotWorkstream({ workstream: 'close-smoke', sourceCwd: fixture.source, workstreamRun: fixture.workstreamRun, dryRun: true });
      assert.equal(result.outcome, 'dry-run');
      assert.equal(result.blockers.some((blocker) => /invalid-date\.json.*validated_at is not a finite canonical UTC timestamp/u.test(blocker)), true);
      assert.equal(result.blockers.some((blocker) => /requires post-transition independent target-roster validate\/bughunt evidence/u.test(blocker)), true);
    });
  });

  void it('rejects exactly-at-approval transition-bound validation but accepts the +1ms boundary at freshness helpers', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      const stateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV] ?? join(root, 'autopilot-state');
      const active = (await readActiveAutopilots(coordinationRootForRepo(fixture.repoKey))).find((row) => row.workstream_run === fixture.workstreamRun);
      if (active === undefined) throw new Error('active row missing');
      const target = await installCloseTargetRoster(stateRoot);
      const committed = await commitCloseRosterTransition(root, fixture, target.ref);
      const transition = committed.transition;
      const transitionArtifactSha256 = committed.transition_artifact_sha256;
      if (transition === null || transitionArtifactSha256 === null) throw new Error('committed transition missing authenticated artifact');
      const fromSelection = await installCloseRosterSelection({ stateRoot, mainWorktreePath: active.main_worktree_path, workstream: active.workstream, repoId: active.repo_key, workstreamRun: active.workstream_run });
      const approvedAtMs = closeRuntimeTestInternals.parseCanonicalUtcMs(transition.approved_at);
      if (approvedAtMs === null) throw new Error('approved_at did not parse');
      const integrationHead = gitOutput(active.main_worktree_path, ['rev-parse', 'HEAD']);
      const equalRef = await writeBoundTransitionValidationEvidence({ runtimeRoot: fixture.runtimeRoot, committed, target, preRunSelectionSha256: fromSelection.selection_sha256, validatedAt: transition.approved_at, name: 'bound-equal-approval', integrationHead });
      const plusRef = await writeBoundTransitionValidationEvidence({ runtimeRoot: fixture.runtimeRoot, committed, target, preRunSelectionSha256: fromSelection.selection_sha256, validatedAt: '2026-07-23T00:00:00.001Z', name: 'bound-plus-one-ms', integrationHead });
      const terminal = { id: transition.transition_id, toRoster: transition.to_roster, artifactSha256: transitionArtifactSha256 };
      const context = { active } as never;
      const merge = {
        schema_version: 'autopilot.unit_merge.v1',
        workstream: active.workstream,
        workstream_run: active.workstream_run,
        autopilot_id: active.autopilot_id,
        active_run_epoch: active.active_run_epoch,
        unit_id: 'u01-implement',
        role: 'implement',
        attempt: 1,
        unit_branch: active.branch,
        main_branch: active.branch,
        unit_head: integrationHead,
        integration_before: integrationHead,
        integration_after: integrationHead,
        merge_commit_sha: integrationHead,
        changed_paths: ['src/smoke.ts'],
        status_ref: 'statuses/u01-implement.implement.attempt-1.json',
        receipt_ref: 'receipts/u01-implement.implement.attempt-1.receipt.json',
        audit_ref: 'execution-audits/u01-implement.implement.attempt-1.json',
        execution_commit_ref: 'execution-commits/u01-implement.implement.attempt-1.json',
        merged_at: '2026-07-23T00:00:00.001Z',
      } as const;
      assert.equal(await closeRuntimeTestInternals.transitionHasFreshTargetValidation({ context, validationRefs: [equalRef], terminal, approvedAtMs, targetRoster: target.roster, fromSelection }), false);
      assert.equal(await closeRuntimeTestInternals.transitionValidationEvidenceForMerge({ context, validationRefs: [equalRef], merge, terminal, approvedAtMs, targetRoster: target.roster, fromSelection }), false);
      assert.equal(await closeRuntimeTestInternals.transitionHasFreshTargetValidation({ context, validationRefs: [plusRef], terminal, approvedAtMs, targetRoster: target.roster, fromSelection }), true);
      assert.equal(await closeRuntimeTestInternals.transitionValidationEvidenceForMerge({ context, validationRefs: [plusRef], merge, terminal, approvedAtMs, targetRoster: target.roster, fromSelection }), true);
    });
  });

  void it('blocks close when copied stale validation evidence is not bound to the transition context', async () => {
    await withTempDir(async (root) => {
      const fixture = await prepareCloseFixture(root);
      await commitCloseRosterTransition(root, fixture);
      await writeValidationEvidence(fixture.runtimeRoot, 'copied-stale.json', '2026-07-23T00:00:01.000Z');
      const result = await closeAutopilotWorkstream({ workstream: 'close-smoke', sourceCwd: fixture.source, workstreamRun: fixture.workstreamRun, dryRun: true });
      assert.equal(result.outcome, 'dry-run');
      assert.equal(result.blockers.some((blocker) => /requires post-transition independent target-roster validate\/bughunt evidence/u.test(blocker)), true);
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
