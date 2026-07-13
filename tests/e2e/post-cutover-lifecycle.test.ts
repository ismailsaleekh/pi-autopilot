import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { closeAutopilotWorkstream } from '../../src/core/close-runtime.ts';
import {
  parseAutopilotExecutionAudit,
  parseAutopilotExecutionCommit,
  parseAutopilotMasterPlan,
  parseAutopilotReceipt,
  parseAutopilotState,
  parseAutopilotStatusEntry,
  type AutopilotMasterPlan,
  type AutopilotState,
  type AutopilotUnitSpec,
  type AutopilotVerificationPlan,
} from '../../src/core/contracts/index.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { readCoordinatorSessionContext, DurableRunSupervisorClient } from '../../src/core/coordination/supervisor.ts';
import { evaluateAutopilotClosureGate } from '../../src/core/lifecycle/index.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import {
  prepareAutopilotWorkstream,
  resolveRepoIdentity,
  unitWorktreePathForActiveAutopilot,
  type ProcessEnvLike,
} from '../../src/core/parallel-runtime.ts';
import { runAutopilotAgentFromSpecPath } from '../../src/core/agent-runner.ts';
import { isSparseCheckoutEnabled } from '../../src/core/sparse-worktree.ts';
import { mergeAutopilotUnit } from '../../src/core/unit-merge.ts';
import {
  parseValidationEvidence,
  validationCanCloseSourceWork,
  type AutopilotValidationEvidence,
} from '../../src/core/validation-staleness.ts';
import { writeAutopilotStateAtomic } from '../../src/core/state-store/index.ts';
import { withMigrationTestFixture, type MigrationTestFixture } from '../helpers/migration-fixture.ts';

const coordinatorCli = new URL('../../src/cli/autopilot-coordinator.ts', import.meta.url);
const fixedNow = '2026-07-13T10:00:00.000Z';

interface MigrationReport {
  readonly schema_version: string;
  readonly state: string;
  readonly blockers: readonly string[];
}

interface EvidencePaths {
  readonly status: string;
  readonly receipt: string;
  readonly audit: string;
  readonly executionCommit: string;
}

void describe('post-cutover coordinator-authoritative lifecycle', () => {
  void it('migrates generic legacy state and closes a new sparse source-changing run without legacy fallback', async () => {
    await withMigrationTestFixture(async (fixture) => {
      await mkdir(join(fixture.source, 'src'), { recursive: true });
      await mkdir(join(fixture.source, 'docs'), { recursive: true });
      await writeFile(join(fixture.source, '.gitignore'), '.pi/\n', 'utf8');
      await writeFile(join(fixture.source, 'src', 'feature.js'), 'export const feature = "baseline";\n', 'utf8');
      await writeFile(join(fixture.source, 'docs', 'unrelated.txt'), 'tracked but outside sparse claims\n', 'utf8');
      git(fixture.source, ['add', '.gitignore', 'src/feature.js', 'docs/unrelated.txt']);
      git(fixture.source, ['commit', '-m', 'add generic lifecycle fixture']);

      assert.equal(runMigrationCommand(fixture, ['migrate', '--dry-run']).state, 'planned');
      assert.equal(runMigrationCommand(fixture, ['migrate', '--apply']).state, 'imported');
      assert.equal(runMigrationCommand(fixture, ['verify']).state, 'cutover-ready');
      assert.equal(runMigrationCommand(fixture, ['cutover']).state, 'legacy-archived');

      const liveLegacyRoot = join(fixture.stateRoot, 'coordination', fixture.repoKey);
      const archivedLegacyRoot = join(fixture.stateRoot, 'migrations', fixture.repoKey, 'legacy-archive', 'coordination', fixture.repoKey);
      assert.equal(existsSync(archivedLegacyRoot), true);
      const archivedBefore = await snapshotFiles(archivedLegacyRoot);
      assert.equal(archivedBefore.size > 0, true);
      assertArchivedLegacyNotRecreated(liveLegacyRoot, archivedBefore);
      const lockedArchiveFiles = platform() === 'win32' ? [] : await makeFilesUnreadable(archivedLegacyRoot);
      const lockedWitness = lockedArchiveFiles[0];
      if (lockedWitness !== undefined) await assert.rejects(() => readFile(lockedWitness));

      const coordinator = await startCoordinatorServer(coordinatorRuntimePaths(fixture.env));
      try {
        const prepared = await prepareAutopilotWorkstream({
          workstream: 'post-cutover-e2e',
          sourceCwd: fixture.source,
          coordinationSessionId: 'post-cutover-activation',
          env: fixture.env,
          now: new Date(fixedNow),
        });
        assert.equal(prepared.created, true);
        assert.equal(prepared.active.coordination_authority, 'coordinator-edit-leases-v1');
        assert.equal(isSparseCheckoutEnabled(prepared.mainWorktreePath, fixture.env), true);
        assert.equal(existsSync(join(prepared.mainWorktreePath, 'docs', 'unrelated.txt')), false);
        assertArchivedLegacyNotRecreated(liveLegacyRoot, archivedBefore);

        const supervisor = new DurableRunSupervisorClient(fixture.env);
        const attachment = await supervisor.attach({
          repo: prepared.repo,
          active: prepared.active,
          rawSessionId: 'post-cutover-parent-session',
        });
        const persistedSession = await readCoordinatorSessionContext(attachment.contextPath);
        assert.equal(persistedSession.workstream_run, prepared.active.workstream_run);
        assert.equal(persistedSession.session_generation >= 1, true);
        const runEnv: ProcessEnvLike = {
          ...fixture.env,
          PI_OFFLINE: '1',
          PI_SKIP_VERSION_CHECK: '1',
          PI_TELEMETRY: '0',
          CI: '1',
          [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath,
        };

        await writeInitialPlanningArtifacts(prepared.runtimeRoot, prepared.active.workstream);
        const fakePi = await writeFakePi(fixture.root);
        const implementSpec = implementationSpec(prepared.runtimeRoot, prepared.active);
        const implementSpecPath = join(prepared.runtimeRoot, 'unit-specs', 'u01-implement.implement.attempt-1.json');
        await writeJson(implementSpecPath, implementSpec);
        const implementResult = await runAutopilotAgentFromSpecPath(implementSpecPath, {
          piExecutable: fakePi,
          env: runEnv,
          timeoutMsOverride: 5_000,
        });
        assert.equal(implementResult.status, 'success');
        assert.equal(implementResult.statusEntry?.verdict, 'DONE');
        assert.equal(implementResult.auditClassification, 'clean');
        assert.notEqual(implementResult.executionCommitOutput, null);
        assert.notEqual(implementResult.executionCommitSha, null);

        const unitWorktree = implementSpec.cwd;
        assert.equal(isSparseCheckoutEnabled(unitWorktree, fixture.env), true);
        assert.equal(existsSync(join(unitWorktree, 'src', 'feature.js')), true);
        assert.equal(existsSync(join(unitWorktree, 'README.md')), true);
        assert.equal(existsSync(join(unitWorktree, 'docs', 'unrelated.txt')), false);
        assert.equal(existsSync(join(prepared.mainWorktreePath, 'src', 'feature.js')), true);
        assert.equal(existsSync(join(prepared.taskRoot, '_materialization-ledger.jsonl')), true);

        const evidence = evidencePaths(implementSpec, implementResult.auditOutput, implementResult.executionCommitOutput);
        const implementStatus = parseAutopilotStatusEntry(await readJson(evidence.status), { unitSpec: implementSpec });
        const implementReceipt = parseAutopilotReceipt(await readJson(evidence.receipt));
        const implementAudit = parseAutopilotExecutionAudit(await readJson(evidence.audit));
        const executionCommit = parseAutopilotExecutionCommit(await readJson(evidence.executionCommit));
        assert.equal(implementReceipt.status_sha256, await sha256File(evidence.status));
        assert.deepEqual(implementAudit.actual_changed_paths, ['src/feature.js']);
        assert.equal(executionCommit.commit_sha, implementResult.executionCommitSha);
        assert.equal(executionCommit.commit_origin, 'runtime');
        assert.deepEqual(executionCommit.edited_claimed_paths, ['src/feature.js']);

        const coordinatorClient = new CoordinatorClient({ env: fixture.env, autoStart: false });
        const beforeMerge = await coordinatorClient.query('status', fixture.repoKey, prepared.active.workstream_run);
        const grantedGroups = records(beforeMerge.payload['acquisition_groups']).filter((row) => row['state'] === 'granted' && ownerUnit(row) === 'u01-implement');
        assert.equal(grantedGroups.length, 1);
        assert.deepEqual(
          records(beforeMerge.payload['edit_leases'])
            .filter((row) => ownerUnit(row) === 'u01-implement')
            .map((row) => `${String(row['mode'])}:${String(row['path'])}`)
            .sort(),
          ['READ:README.md', 'WRITE:src/feature.js'],
        );
        assert.equal(records(beforeMerge.payload['child_leases']).some((row) => ownerUnit(row) === 'u01-implement' && row['status'] === 'terminal'), true);

        const activeContext = {
          repo: resolveRepoIdentity(fixture.source),
          active: prepared.active,
          coordinationRoot: liveLegacyRoot,
          claimsPath: join(liveLegacyRoot, 'path-claims.json'),
          claimEventsPath: join(liveLegacyRoot, 'claim-events.jsonl'),
        };
        const mergeResult = await mergeAutopilotUnit({
          context: activeContext,
          unitId: 'u01-implement',
          attempt: 1,
          statusPath: evidence.status,
          receiptPath: evidence.receipt,
          auditPath: evidence.audit,
          executionCommitPath: evidence.executionCommit,
          env: runEnv,
          now: new Date('2026-07-13T10:01:00.000Z'),
        });
        assert.equal(mergeResult.outcome, 'merged');
        if (mergeResult.merge === null) throw new Error('unit merge omitted durable evidence');
        assert.deepEqual(mergeResult.merge.changed_paths, ['src/feature.js']);
        assert.equal(existsSync(unitWorktree), false);

        const afterMerge = await coordinatorClient.query('status', fixture.repoKey, prepared.active.workstream_run);
        assert.equal(records(afterMerge.payload['edit_leases']).some((row) => ownerUnit(row) === 'u01-implement'), false);
        const reservations = records(afterMerge.payload['change_reservations']);
        assert.equal(reservations.length, 1);
        assert.equal(reservations[0]?.['path'], 'src/feature.js');
        assert.equal(typeof record(reservations[0]?.['merge_evidence'])['sha256'], 'string');

        const validationSpec = validatorSpec(prepared.runtimeRoot, prepared.mainWorktreePath);
        const validationSpecPath = join(prepared.runtimeRoot, 'unit-specs', 'v01-validate.validate.attempt-1.json');
        await writeJson(validationSpecPath, validationSpec);
        const validationResult = await runAutopilotAgentFromSpecPath(validationSpecPath, {
          piExecutable: fakePi,
          env: runEnv,
          timeoutMsOverride: 5_000,
        });
        assert.equal(validationResult.status, 'success');
        assert.equal(validationResult.statusEntry?.verdict, 'PASS');
        assert.equal(validationResult.auditClassification, 'clean');
        assert.equal(validationResult.executionCommitOutput, null);

        const validationEvidencePaths = evidencePaths(validationSpec, validationResult.auditOutput, validationResult.executionCommitOutput);
        const validationStatus = parseAutopilotStatusEntry(await readJson(validationEvidencePaths.status), { unitSpec: validationSpec });
        const validationReceipt = parseAutopilotReceipt(await readJson(validationEvidencePaths.receipt));
        const validationAudit = parseAutopilotExecutionAudit(await readJson(validationEvidencePaths.audit));
        assert.deepEqual(validationStatus.covered_witness_ids, ['feature-syntax-and-content']);
        assert.equal(validationReceipt.status_sha256, await sha256File(validationEvidencePaths.status));
        assert.equal(validationAudit.classification, 'clean');

        const unitMergeRef = `unit-merges/u01-implement.implement.attempt-1.json`;
        const independentValidation = parseValidationEvidence({
          schema_version: 'autopilot.validation_evidence.v1',
          workstream: prepared.active.workstream,
          source_unit_id: 'u01-implement',
          source_attempt: 1,
          validation_unit_id: 'v01-validate',
          validation_attempt: 1,
          unit_merge_ref: unitMergeRef,
          integration_head: mergeResult.merge.integration_after,
          covered_paths: ['src/feature.js'],
          covered_path_groups: [],
          witness_ids: ['feature-syntax-and-content'],
          status_ref: 'statuses/v01-validate.validate.attempt-1.json',
          status_sha256: await sha256File(validationEvidencePaths.status),
          receipt_ref: 'receipts/v01-validate.validate.attempt-1.receipt.json',
          receipt_sha256: await sha256File(validationEvidencePaths.receipt),
          audit_ref: 'execution-audits/v01-validate.validate.attempt-1.json',
          audit_sha256: await sha256File(validationEvidencePaths.audit),
          verdict: 'PASS',
          validated_at: '2026-07-13T10:02:00.000Z',
        } satisfies AutopilotValidationEvidence);
        assert.equal(validationCanCloseSourceWork({ validation: independentValidation, unitMerge: mergeResult.merge }), true);
        await writeJson(join(prepared.runtimeRoot, 'validation', 'u01-implement.attempt-1.json'), independentValidation);

        const afterValidation = await coordinatorClient.query('status', fixture.repoKey, prepared.active.workstream_run);
        assert.equal(records(afterValidation.payload['edit_leases']).length, 0);
        assert.equal(records(afterValidation.payload['child_leases']).some((row) => ownerUnit(row) === 'v01-validate' && row['status'] === 'terminal'), true);
        assert.equal(records(afterValidation.payload['reconciliation_evidence']).filter((row) => row['source'] === 'child-process').length, 2);

        await writeClosureArtifacts({
          runtimeRoot: prepared.runtimeRoot,
          workstream: prepared.active.workstream,
          implementStatus,
          validationStatus,
          implementAudit,
          validationAudit,
        });
        const targetBefore = git(fixture.source, ['rev-parse', 'HEAD']);
        const taskRoot = prepared.taskRoot;
        const mainWorktree = prepared.mainWorktreePath;
        const runBranch = prepared.active.branch;
        const closeResult = await closeAutopilotWorkstream({
          workstream: prepared.active.workstream,
          workstreamRun: prepared.active.workstream_run,
          sourceCwd: fixture.source,
          env: runEnv,
          now: new Date('2026-07-13T10:03:00.000Z'),
        });
        assert.equal(closeResult.outcome, 'closed');
        assert.deepEqual(closeResult.blockers, []);
        assert.deepEqual(closeResult.changed_paths, ['src/feature.js']);
        assert.notEqual(closeResult.target_after, targetBefore);
        assert.equal(await readFile(join(fixture.source, 'src', 'feature.js'), 'utf8'), 'export const feature = "post-cutover";\n');
        assert.equal(existsSync(taskRoot), false);
        assert.equal(existsSync(mainWorktree), false);
        assert.equal(git(fixture.source, ['branch', '--list', runBranch]), '');
        assert.equal(gitWorktrees(fixture.source).includes(mainWorktree), false);
        if (closeResult.archived_runtime_path === null || closeResult.close_result_path === null) throw new Error('close omitted terminal archive paths');
        assert.equal(existsSync(closeResult.archived_runtime_path), true);
        assert.equal(existsSync(join(closeResult.archived_runtime_path, 'execution-commits', 'u01-implement.implement.attempt-1.json')), true);
        assert.equal(existsSync(join(closeResult.archived_runtime_path, 'validation', 'u01-implement.attempt-1.json')), true);
        assert.equal(existsSync(closeResult.close_result_path), true);
        assert.match(git(fixture.source, ['branch', '--list', `autopilot/archive/${prepared.active.workstream_run}/main`]), /autopilot\/archive\//u);

        const terminal = await coordinatorClient.query('status', fixture.repoKey, prepared.active.workstream_run);
        assert.equal(records(terminal.payload['runs'])[0]?.['status'], 'closed');
        assert.equal(records(terminal.payload['session_leases']).some((row) => row['status'] === 'attached'), false);
        assert.equal(records(terminal.payload['edit_leases']).length, 0);
        const terminalReservations = records(terminal.payload['change_reservations']);
        assert.equal(terminalReservations.length, 1);
        assert.equal(terminalReservations[0]?.['terminal_outcome'], 'closed');
        assert.equal(typeof terminalReservations[0]?.['released_event_seq'], 'number');
        assertArchivedLegacyNotRecreated(liveLegacyRoot, archivedBefore);
      } finally {
        await coordinator.close();
        for (const path of lockedArchiveFiles) await chmod(path, 0o600).catch(() => undefined);
      }

      assertArchivedLegacyNotRecreated(liveLegacyRoot, archivedBefore);
      assert.deepEqual(await snapshotFiles(archivedLegacyRoot), archivedBefore);
    });
  });
});

function runMigrationCommand(fixture: MigrationTestFixture, args: readonly string[]): MigrationReport {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', coordinatorCli.pathname, ...args, '--state-root', fixture.stateRoot, '--repo-key', fixture.repoKey], {
    cwd: fixture.source,
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTOPILOT_STATE_ROOT: fixture.stateRoot,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      CI: '1',
      NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --disable-warning=ExperimentalWarning`.trim(),
    },
  });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  const value: unknown = JSON.parse(result.stdout) as unknown;
  const parsed = record(value);
  const blockers = parsed['blockers'];
  if (!Array.isArray(blockers) || !blockers.every((entry) => typeof entry === 'string')) throw new Error('migration blockers are malformed');
  const report = {
    schema_version: String(parsed['schema_version']),
    state: String(parsed['state']),
    blockers,
  };
  assert.equal(report.schema_version, 'autopilot.coordination_migration_report.v1');
  assert.deepEqual(report.blockers, []);
  return report;
}

function implementationSpec(runtimeRoot: string, active: Parameters<typeof unitWorktreePathForActiveAutopilot>[0]): AutopilotUnitSpec {
  return {
    schema_version: 'autopilot.unit_spec.v1',
    workstream: 'post-cutover-e2e',
    unit_id: 'u01-implement',
    role: 'implement',
    template: 'implement',
    attempt: 1,
    objective: 'Change the generic fixture feature through a coordinator-authoritative child run.',
    cwd: unitWorktreePathForActiveAutopilot(active, 'u01-implement', 1),
    model: 'openai-codex/gpt-5.6-terra',
    thinking: 'high',
    owned_paths: ['src/feature.js'],
    read_only_paths: ['README.md'],
    untouchable_paths: ['docs/**'],
    context_refs: [
      { path: '.pi/autopilot/post-cutover-e2e/mission.md', purpose: 'durable mission authority' },
      { path: '.pi/autopilot/post-cutover-e2e/master-plan.json', purpose: 'durable plan authority' },
    ],
    validation_commands: [],
    status_output: join(runtimeRoot, 'statuses', 'u01-implement.implement.attempt-1.json'),
    receipt_output: join(runtimeRoot, 'receipts', 'u01-implement.implement.attempt-1.receipt.json'),
    evidence_dir: join(runtimeRoot, 'evidence', 'u01-implement'),
    stop_boundary: 'Edit only src/feature.js.',
    quality_profile: 'source-change',
    risk_level: 'medium',
    acceptance_criteria: ['feature source changes in an isolated unit commit'],
    verification_plan: {
      ...emptyVerificationPlan(),
      positive_witnesses: [{ id: 'implementation-syntax', command: 'node --check src/feature.js', expected_signal: 'changed feature remains valid JavaScript', required: true }],
    },
    closure_criteria: ['independent validation passes after coordinator merge'],
    upstream_refs: [],
    timeout_seconds: 60,
    render_prompt_snapshot: true,
  };
}

function validatorSpec(runtimeRoot: string, mainWorktree: string): AutopilotUnitSpec {
  const witness = {
    id: 'feature-syntax-and-content',
    command: 'node --check src/feature.js',
    expected_signal: 'syntax exits zero and deterministic content is present',
    required: true,
  };
  return {
    schema_version: 'autopilot.unit_spec.v1',
    workstream: 'post-cutover-e2e',
    unit_id: 'v01-validate',
    role: 'validate',
    template: 'validate',
    attempt: 1,
    objective: 'Independently validate the accepted feature merge.',
    cwd: mainWorktree,
    model: 'openai-codex/gpt-5.6-sol',
    thinking: 'xhigh',
    owned_paths: [],
    read_only_paths: ['src/feature.js'],
    untouchable_paths: ['docs/**'],
    context_refs: [
      { path: '.pi/autopilot/post-cutover-e2e/mission.md', purpose: 'durable mission authority' },
      { path: '.pi/autopilot/post-cutover-e2e/master-plan.json', purpose: 'durable plan authority' },
    ],
    validation_commands: [witness.command],
    status_output: join(runtimeRoot, 'statuses', 'v01-validate.validate.attempt-1.json'),
    receipt_output: join(runtimeRoot, 'receipts', 'v01-validate.validate.attempt-1.receipt.json'),
    evidence_dir: join(runtimeRoot, 'evidence', 'v01-validate'),
    stop_boundary: 'Read-only validation; do not edit source.',
    quality_profile: 'validation-only',
    risk_level: 'low',
    acceptance_criteria: ['merged feature has expected content and valid syntax'],
    verification_plan: { ...emptyVerificationPlan(), positive_witnesses: [witness] },
    closure_criteria: ['required witness passes'],
    upstream_refs: [{ unit_id: 'u01-implement', purpose: 'independently validate accepted merge', status_ref: 'statuses/u01-implement.implement.attempt-1.json', audit_ref: 'execution-audits/u01-implement.implement.attempt-1.json' }],
    timeout_seconds: 60,
    render_prompt_snapshot: true,
  };
}

function emptyVerificationPlan(): AutopilotVerificationPlan {
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

async function writeInitialPlanningArtifacts(runtimeRoot: string, workstream: string): Promise<void> {
  const plan = parseAutopilotMasterPlan({
    schema_version: 'autopilot.master_plan.v1',
    workstream,
    mission_ref: 'mission.md',
    goal_summary: 'Complete one coordinator-authoritative post-cutover source change.',
    non_goals: [],
    definition_of_done: ['validated feature lands on the target branch'],
    risk_level: 'low',
    lanes: [{ lane_id: 'main', summary: 'implementation then validation', unit_ids: ['u01-implement', 'v01-validate'] }],
    units: {
      'u01-implement': { unit_id: 'u01-implement', role: 'implement', state: 'ready', dependencies: [], summary: 'implement feature' },
      'v01-validate': { unit_id: 'v01-validate', role: 'validate', state: 'queued', dependencies: ['u01-implement'], summary: 'independently validate feature' },
    },
    ownership_matrix: { owned_paths: ['src/feature.js'], read_only_paths: ['README.md'], untouchable_paths: ['docs/**'], held_paths: ['src/feature.js'] },
    verification_matrix: {
      ...emptyVerificationPlan(),
      positive_witnesses: [{ id: 'feature-syntax-and-content', command: 'node --check src/feature.js', expected_signal: 'syntax and content pass', required: true }],
    },
    closure_criteria: ['independent validation passes'],
    current_focus: 'u01-implement',
    last_decision_id: 0,
    last_event_id: 0,
    updated_at: fixedNow,
  });
  await writeFile(join(runtimeRoot, 'mission.md'), '# Mission\n\nComplete the post-cutover lifecycle.\n', 'utf8');
  await writeJson(join(runtimeRoot, 'master-plan.json'), plan);
}

async function writeClosureArtifacts(input: {
  readonly runtimeRoot: string;
  readonly workstream: string;
  readonly implementStatus: ReturnType<typeof parseAutopilotStatusEntry>;
  readonly validationStatus: ReturnType<typeof parseAutopilotStatusEntry>;
  readonly implementAudit: ReturnType<typeof parseAutopilotExecutionAudit>;
  readonly validationAudit: ReturnType<typeof parseAutopilotExecutionAudit>;
}): Promise<void> {
  const stateBase: AutopilotState = {
    schema_version: 'autopilot.state.v1',
    workstream: input.workstream,
    updated_at: '2026-07-13T10:02:30.000Z',
    status: 'completed',
    context_gate: { gate: 'ok', percent: 12 },
    last_event_id: 0,
    ready_queue: [],
    running: [],
    blocked: [],
    completed: ['u01-implement', 'v01-validate'],
    units: {
      'u01-implement': { unit_id: 'u01-implement', role: 'implement', state: 'completed', attempt: 1, spec_ref: 'unit-specs/u01-implement.implement.attempt-1.json', status_ref: 'statuses/u01-implement.implement.attempt-1.json', receipt_ref: 'receipts/u01-implement.implement.attempt-1.receipt.json', summary: input.implementStatus.summary },
      'v01-validate': { unit_id: 'v01-validate', role: 'validate', state: 'completed', attempt: 1, spec_ref: 'unit-specs/v01-validate.validate.attempt-1.json', status_ref: 'statuses/v01-validate.validate.attempt-1.json', receipt_ref: 'receipts/v01-validate.validate.attempt-1.receipt.json', summary: input.validationStatus.summary },
    },
    operator_questions: [],
    next_actions: [],
    work_items: {
      'w01-feature': {
        work_item_id: 'w01-feature',
        state: 'closed',
        source_changing: true,
        unit_ids: ['u01-implement', 'v01-validate'],
        implementation_unit_id: 'u01-implement',
        validation_unit_id: 'v01-validate',
        audit_ref: 'execution-audits/u01-implement.implement.attempt-1.json',
        status_ref: 'statuses/u01-implement.implement.attempt-1.json',
        validation_status_ref: 'statuses/v01-validate.validate.attempt-1.json',
        summary: 'post-cutover feature implemented and independently validated',
      },
    },
    audit_review_queue: [],
    validation_ready_queue: [],
    scope_exceptions: [],
    protected_path_exceptions: [],
  };
  const plan: AutopilotMasterPlan = {
    schema_version: 'autopilot.master_plan.v1',
    workstream: input.workstream,
    mission_ref: 'mission.md',
    goal_summary: 'Complete one coordinator-authoritative post-cutover source change.',
    non_goals: [],
    definition_of_done: ['validated feature lands on the captured target branch'],
    risk_level: 'low',
    lanes: [{ lane_id: 'main', summary: 'implementation and independent validation', unit_ids: ['u01-implement', 'v01-validate'] }],
    units: {
      'u01-implement': { unit_id: 'u01-implement', role: 'implement', state: 'completed', dependencies: [], summary: 'implemented' },
      'v01-validate': { unit_id: 'v01-validate', role: 'validate', state: 'completed', dependencies: ['u01-implement'], summary: 'validated' },
    },
    ownership_matrix: { owned_paths: ['src/feature.js'], read_only_paths: ['README.md'], untouchable_paths: ['docs/**'], held_paths: ['src/feature.js'] },
    verification_matrix: validatorSpec(input.runtimeRoot, dirname(dirname(dirname(input.runtimeRoot)))).verification_plan ?? emptyVerificationPlan(),
    closure_criteria: ['independent validation PASS is durable'],
    current_focus: 'close',
    last_decision_id: 0,
    last_event_id: 0,
    updated_at: '2026-07-13T10:02:30.000Z',
  };
  const parsedPlan = parseAutopilotMasterPlan(plan);
  const gate = evaluateAutopilotClosureGate({
    state: stateBase,
    masterPlan: parsedPlan,
    statuses: [input.implementStatus, input.validationStatus],
    audits: [input.implementAudit, input.validationAudit],
    decisions: [],
    checkedAt: '2026-07-13T10:02:30.000Z',
  });
  assert.equal(gate.status, 'passed', gate.blocking_reasons.join('\n'));
  const state = parseAutopilotState({ ...stateBase, closure_gate: gate });
  await writeAutopilotStateAtomic({ statePath: join(input.runtimeRoot, 'state.json'), state, artifactRoot: input.runtimeRoot });
  await writeJson(join(input.runtimeRoot, 'master-plan.json'), parsedPlan);
  await writeFile(join(input.runtimeRoot, 'mission.md'), '# Mission\n\nComplete the post-cutover lifecycle.\n', 'utf8');
}

function evidencePaths(spec: AutopilotUnitSpec, auditPath: string | null, executionCommitPath: string | null): EvidencePaths {
  if (auditPath === null) throw new Error(`${spec.unit_id} omitted execution audit`);
  return {
    status: spec.status_output,
    receipt: spec.receipt_output,
    audit: auditPath,
    executionCommit: executionCommitPath ?? join(spec.evidence_dir, 'not-applicable.execution-commit.json'),
  };
}

async function writeFakePi(root: string): Promise<string> {
  const path = join(root, 'provider-free-pi.mjs');
  await writeFile(path, FAKE_PI_SOURCE, 'utf8');
  await chmod(path, 0o755);
  return path;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  return `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected object');
  return value as Readonly<Record<string, unknown>>;
}

function records(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) throw new Error('expected object array');
  return value.map(record);
}

function ownerUnit(row: Readonly<Record<string, unknown>>): string | null {
  const owner = row['owner'];
  return typeof owner === 'object' && owner !== null && !Array.isArray(owner) && typeof (owner as Readonly<Record<string, unknown>>)['unit_id'] === 'string'
    ? String((owner as Readonly<Record<string, unknown>>)['unit_id'])
    : typeof row['unit_id'] === 'string' ? row['unit_id'] : null;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitWorktrees(cwd: string): readonly string[] {
  return git(cwd, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
}

async function snapshotFiles(root: string): Promise<ReadonlyMap<string, string>> {
  const snapshot = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) snapshot.set(path.slice(root.length), createHash('sha256').update(await readFile(path)).digest('hex'));
    }
  };
  await walk(root);
  return snapshot;
}

function assertArchivedLegacyNotRecreated(liveRoot: string, archived: ReadonlyMap<string, string>): void {
  for (const relativePath of archived.keys()) {
    const normalized = relativePath.replace(/^[/\\]+/u, '');
    assert.equal(existsSync(join(liveRoot, normalized)), false, `archived legacy file was recreated: ${normalized}`);
  }
}

async function makeFilesUnreadable(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        await chmod(path, 0o000);
        paths.push(path);
      }
    }
  };
  await walk(root);
  return paths;
}

const FAKE_PI_SOURCE = `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';

if (process.env.PI_OFFLINE !== '1') throw new Error('provider-free fixture requires PI_OFFLINE=1');
if (process.env.AUTOPILOT_COORDINATOR_SESSION_CONTEXT !== undefined) throw new Error('parent coordinator capability leaked into child');
const contextPath = process.env.AUTOPILOT_AGENT_STATUS_CONTEXT;
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function respond(command, success = true, extra = {}) { send({ id: command.id, type: 'response', command: command.type, success, ...extra }); }
function context() {
  if (!contextPath) throw new Error('missing forced-output context');
  return JSON.parse(readFileSync(contextPath, 'utf8'));
}
function emitStatus() {
  const carrier = context();
  const unit = carrier.unit_spec;
  let status;
  if (unit.role === 'implement') {
    const source = join(unit.cwd, 'src', 'feature.js');
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, 'export const feature = "post-cutover";\\n', 'utf8');
    status = {
      schema_version: 'autopilot.status.v1', workstream: unit.workstream, unit_id: unit.unit_id, role: unit.role, attempt: unit.attempt,
      verdict: 'DONE', severity: 'clean', summary: 'Provider-free child completed the source change.', changed_paths: ['src/feature.js'],
      findings: [], commands: [], evidence_refs: [], report_ref: null, next_action: 'merge exact execution commit'
    };
  } else if (unit.role === 'validate') {
    const source = join(unit.cwd, 'src', 'feature.js');
    if (readFileSync(source, 'utf8') !== 'export const feature = "post-cutover";\\n') throw new Error('integrated feature content mismatch');
    const check = spawnSync(process.execPath, ['--check', source], { encoding: 'utf8' });
    if ((check.status ?? -1) !== 0) throw new Error('syntax witness failed: ' + check.stderr);
    status = {
      schema_version: 'autopilot.status.v1', workstream: unit.workstream, unit_id: unit.unit_id, role: unit.role, attempt: unit.attempt,
      verdict: 'PASS', severity: 'clean', summary: 'Independent provider-free validation passed.', changed_paths: [], findings: [],
      commands: [{ command: unit.validation_commands[0], status: 'passed', exit_code: 0, summary: 'Node syntax check and exact-content witness passed.' }],
      evidence_refs: [], report_ref: null, covered_witness_ids: ['feature-syntax-and-content'], next_action: 'close validated work item'
    };
  } else throw new Error('unsupported fixture role ' + unit.role);
  mkdirSync(dirname(carrier.status_output), { recursive: true });
  mkdirSync(dirname(carrier.receipt_output), { recursive: true });
  const statusBytes = JSON.stringify(status, null, 2) + '\\n';
  writeFileSync(carrier.status_output, statusBytes, 'utf8');
  const statusSha256 = 'sha256:' + createHash('sha256').update(statusBytes, 'utf8').digest('hex');
  const receipt = {
    schema_version: 'autopilot.receipt.v1', tool_name: 'autopilot_emit_status', workstream: unit.workstream, unit_id: unit.unit_id,
    role: unit.role, attempt: unit.attempt, emitted_at: '2026-07-13T10:00:30.000Z', status_output: carrier.status_output,
    status_sha256: statusSha256, schema_sha256: carrier.schema_sha256, tool_call_id: 'call-' + unit.unit_id,
    provider_identity: carrier.provider_identity, expected_identity_hash: carrier.expected_identity_hash
  };
  writeFileSync(carrier.receipt_output, JSON.stringify(receipt, null, 2) + '\\n', 'utf8');
  const evidenceRef = relative(carrier.artifact_root, carrier.receipt_output).replaceAll('\\\\', '/');
  if (evidenceRef.startsWith('../')) throw new Error('receipt escaped artifact root');
  send({ type: 'tool_result', toolName: 'autopilot_emit_status', toolCallId: receipt.tool_call_id, isError: false, details: {
    tool_name: 'autopilot_emit_status', tool_call_id: receipt.tool_call_id, terminating: true, status_sha256: statusSha256
  }});
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type === 'get_state') { const unit = context().unit_spec; respond(command, true, { data: { model: { id: unit.model.split('/')[1], provider: 'openai-codex', api: 'openai-codex-responses' }, thinkingLevel: unit.thinking } }); return; }
  if (command.type === 'get_session_stats') { respond(command, true, { data: { sessionId: 'provider-free-post-cutover' } }); return; }
  if (command.type === 'prompt') {
    respond(command); send({ type: 'agent_start' }); send({ type: 'turn_start' }); emitStatus();
    const unit = context().unit_spec;
    const message = { role: 'assistant', content: [{ type: 'text', text: 'deterministic ' + unit.role + ' complete' }], api: 'openai-codex-responses', provider: 'openai-codex', model: unit.model.split('/')[1], stopReason: 'stop' };
    send({ type: 'message_end', message }); send({ type: 'turn_end', message, toolResults: [] }); send({ type: 'agent_end', messages: [message] }); return;
  }
  respond(command, false, { error: 'unsupported command' });
});
`;
