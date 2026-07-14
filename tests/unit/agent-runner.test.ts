import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AutopilotUnitSpec, AutopilotVerificationPlan } from '../../src/core/contracts/index.ts';
import { AutopilotAgentRunError, runAutopilotAgentFromSpecPath } from '../../src/core/agent-runner.ts';
import { AUTOPILOT_STATE_ROOT_ENV, prepareAutopilotUnitWorktree, prepareAutopilotWorkstream } from '../../src/core/parallel-runtime.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { DurableRunSupervisorClient, readCoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationChildLease, parseCoordinationEditLease, parseCoordinationObservation, parseCoordinationUnitAttempt } from '../../src/core/coordination/contracts.ts';
import { parseAutopilotChildTerminalAcceptance } from '../../src/core/coordination/terminal-acceptance.ts';
import { RunReconciliationClient } from '../../src/core/coordination/reconciliation.ts';
import { proveStructuredAttemptTerminal } from '../../src/core/coordination/terminal-attempt-proof.ts';
import { autopilotModelAssignmentForRole } from '../../src/core/model-roster.ts';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, '..', '..');
const AUTOPILOT_AGENT_RUN_CLI = resolve(PACKAGE_ROOT, 'src', 'cli', 'autopilot-agent-run.ts');
const FAKE_PI_COMPLETION_TIMEOUT_MS = 10_000;

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-agent-runner-test-'));
  const originalStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
  const originalSessionContext = process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  process.env[AUTOPILOT_STATE_ROOT_ENV] = join(dir, 'autopilot-state');
  const coordinator = await startCoordinatorServer(coordinatorRuntimePaths(process.env));
  try {
    return await run(dir);
  } finally {
    delete process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    await coordinator.close();
    if (originalStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
    else process.env[AUTOPILOT_STATE_ROOT_ENV] = originalStateRoot;
    if (originalSessionContext !== undefined) process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = originalSessionContext;
    await rm(dir, { recursive: true, force: true });
  }
}

function verificationPlan(command = 'npm test -- --runInBand'): AutopilotVerificationPlan {
  return {
    positive_witnesses: [
      {
        id: 'positive-validation-command',
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

function spec(root: string, overrides: Partial<AutopilotUnitSpec> = {}): AutopilotUnitSpec {
  const worktree = join(root, 'worktree');
  const runtimeRoot = join(worktree, '.pi', 'autopilot', 'autopilot-smoke');
  const base: AutopilotUnitSpec = {
    schema_version: 'autopilot.unit_spec.v1',
    workstream: 'autopilot-smoke',
    unit_id: 'u01-implement',
    role: 'implement',
    template: 'implement',
    attempt: 1,
    objective: 'Implement a smoke fixture.',
    cwd: worktree,
    model: 'openai-codex/gpt-5.6-terra',
    thinking: 'high',
    owned_paths: ['src/smoke.ts'],
    read_only_paths: [],
    untouchable_paths: ['private/**'],
    context_refs: [
      { path: '.pi/autopilot/autopilot-smoke/mission.md', purpose: 'Durable mission truth' },
      { path: '.pi/autopilot/autopilot-smoke/master-plan.json', purpose: 'Durable master plan truth' },
    ],
    validation_commands: [],
    status_output: join(runtimeRoot, 'statuses', 'u01-implement.implement.attempt-1.json'),
    receipt_output: join(runtimeRoot, 'receipts', 'u01-implement.implement.attempt-1.receipt.json'),
    evidence_dir: join(runtimeRoot, 'evidence', 'u01-implement'),
    stop_boundary: 'Edit only src/smoke.ts.',
    quality_profile: 'source-change',
    risk_level: 'medium',
    acceptance_criteria: ['smoke fixture is implemented at root cause'],
    verification_plan: verificationPlan(),
    closure_criteria: ['independent validation passes'],
    upstream_refs: [],
    timeout_seconds: 3600,
    render_prompt_snapshot: true,
  };
  const merged: AutopilotUnitSpec = { ...base, ...overrides };
  const assignment = autopilotModelAssignmentForRole(merged.role);
  const rostered: AutopilotUnitSpec = {
    ...merged,
    model: overrides.model ?? assignment.model,
    thinking: overrides.thinking ?? assignment.thinking,
  };
  if (rostered.role === 'validate' || rostered.role === 'bughunt') {
    const command = rostered.validation_commands[0] ?? 'true';
    return {
      ...rostered,
      quality_profile: 'validation-only',
      risk_level: overrides.risk_level ?? 'low',
      acceptance_criteria: ['independent validation covers declared commands'],
      verification_plan: verificationPlan(command),
      closure_criteria: ['validation status is PASS'],
      upstream_refs: rostered.upstream_refs ?? [],
    };
  }
  return rostered;
}

async function writeSpec(root: string, unitSpec: AutopilotUnitSpec): Promise<string> {
  const prepared = await prepareRegisteredWorktree(root, unitSpec);
  const supervisor = new DurableRunSupervisorClient(process.env);
  const attachment = await supervisor.attach({ repo: prepared.repo, active: prepared.active, rawSessionId: `runner-test-${unitSpec.unit_id}-${String(unitSpec.attempt)}-${String(Date.now())}` });
  process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = attachment.contextPath;
  const mutable = unitSpec as {
    cwd: string;
    status_output: string;
    receipt_output: string;
    evidence_dir: string;
  };
  if (unitSpec.role === 'implement' || unitSpec.role === 'fix') {
    const unitWorktree = await prepareAutopilotUnitWorktree({ active: prepared.active, unitId: unitSpec.unit_id, attempt: unitSpec.attempt, unitSpec });
    mutable.cwd = unitWorktree.unitInfo.worktree_path;
  } else {
    mutable.cwd = prepared.mainWorktreePath;
  }
  mutable.status_output = join(
    prepared.runtimeRoot,
    'statuses',
    `${unitSpec.unit_id}.${unitSpec.role}.attempt-${String(unitSpec.attempt)}.json`,
  );
  mutable.receipt_output = join(
    prepared.runtimeRoot,
    'receipts',
    `${unitSpec.unit_id}.${unitSpec.role}.attempt-${String(unitSpec.attempt)}.receipt.json`,
  );
  mutable.evidence_dir = join(prepared.runtimeRoot, 'evidence', unitSpec.unit_id);
  const specPath = join(prepared.runtimeRoot, 'unit-specs', `${unitSpec.unit_id}.${unitSpec.role}.attempt-${String(unitSpec.attempt)}.json`);
  await mkdir(dirname(specPath), { recursive: true });
  await writeFile(specPath, `${JSON.stringify(unitSpec, null, 2)}\n`, 'utf8');
  return specPath;
}

async function prepareRegisteredWorktree(root: string, unitSpec: AutopilotUnitSpec): Promise<{
  readonly repo: Awaited<ReturnType<typeof prepareAutopilotWorkstream>>['repo'];
  readonly active: Awaited<ReturnType<typeof prepareAutopilotWorkstream>>['active'];
  readonly mainWorktreePath: string;
  readonly runtimeRoot: string;
}> {
  const source = join(root, 'source');
  if (!existsGitRepo(source)) await initGitSource(source, unitSpec.owned_paths);
  return await prepareAutopilotWorkstream({ workstream: unitSpec.workstream, sourceCwd: source, coordinationSessionId: `runner-bootstrap-${unitSpec.unit_id}-${String(unitSpec.attempt)}` });
}

function existsGitRepo(path: string): boolean {
  return spawnSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).status === 0;
}

async function initGitSource(source: string, ownedPaths: readonly string[]): Promise<void> {
  await mkdir(source, { recursive: true });
  await writeFile(join(source, '.gitignore'), '.pi/\n', 'utf8');
  for (const ownedPath of ownedPaths.length === 0 ? ['src/smoke.ts'] : ownedPaths) {
    if (ownedPath.includes('*')) continue;
    const abs = join(source, ...ownedPath.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, `export const baseline = ${JSON.stringify(ownedPath)};\n`, 'utf8');
  }
  git(source, ['init']);
  git(source, ['config', 'user.email', 'autopilot@example.invalid']);
  git(source, ['config', 'user.name', 'Autopilot Test']);
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'baseline']);
}

async function writeFakePi(root: string): Promise<string> {
  const fakePath = join(root, 'fake-pi.mjs');
  await writeFile(fakePath, FAKE_PI_SOURCE, 'utf8');
  const chmodResult = spawnSync('chmod', ['755', fakePath], { encoding: 'utf8' });
  assert.equal(chmodResult.status, 0, chmodResult.stderr);
  return fakePath;
}

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function expectRejects(
  run: () => Promise<unknown>,
  validator: (error: unknown) => boolean,
  message?: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert.equal(validator(error), true, message ?? errorMessage(error));
    return;
  }
  throw new Error('expected promise rejection');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function git(root: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function initGitWorktree(worktree: string): Promise<void> {
  await mkdir(join(worktree, 'src'), { recursive: true });
  await writeFile(join(worktree, 'src', 'smoke.ts'), 'export const smoke = 1;\n', 'utf8');
  await writeFile(join(worktree, '.gitignore'), '.pi/\n', 'utf8');
  git(worktree, ['init']);
  git(worktree, ['config', 'user.email', 'autopilot@example.invalid']);
  git(worktree, ['config', 'user.name', 'Autopilot Test']);
  git(worktree, ['add', '.']);
  git(worktree, ['commit', '-m', 'baseline']);
}

function runCli(args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', AUTOPILOT_AGENT_RUN_CLI, ...args], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --disable-warning=ExperimentalWarning`.trim() },
    encoding: 'utf8',
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

void describe('autopilot-agent-run wrapper', () => {
  void it('dry-runs by validating the spec and rendering a prompt without launching Pi', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const result = await runAutopilotAgentFromSpecPath(specPath, { dryRun: true });
      assert.equal(result.status, 'dry-run');
      assert.equal(result.statusEntry, null);
      const promptSnapshotPath = result.promptSnapshotPath;
      if (promptSnapshotPath === null) throw new Error('expected prompt snapshot path');
      const prompt = await readFile(promptSnapshotPath, 'utf8');
      assert.match(prompt, /autopilot_emit_status/u);
      assert.match(prompt, /Assistant-text JSON/u);
    });
  });

  void it('rejects model or thinking deviations from the fixed role roster before launch', async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, 'worktree'), { recursive: true });
      for (const [index, overrides] of [
        { model: 'openai-codex/gpt-5.6-sol' },
        { model: 'anthropic/claude-opus-4-8' },
        { thinking: 'xhigh' as const },
      ].entries()) {
        const unitId = `roster-mismatch-${String(index)}`;
        const unitSpec = spec(root, {
          unit_id: unitId,
          ...overrides,
          status_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'statuses', `${unitId}.implement.attempt-1.json`),
          receipt_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'receipts', `${unitId}.implement.attempt-1.receipt.json`),
          evidence_dir: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'evidence', unitId),
        });
        const specPath = await writeSpec(root, unitSpec);
        await expectRejects(
          () => runAutopilotAgentFromSpecPath(specPath, { dryRun: true }),
          (error: unknown) =>
            error instanceof AutopilotAgentRunError &&
            error.failureClass === 'spec-invalid' &&
            /implement role requires fixed roster/u.test(error.details.reason),
        );
      }
    });
  });

  void it('CLI dry-run prints terse stdout without prompt body', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const result = runCli(['--dry-run', specPath]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /^autopilot-agent-run dry-run unit=u01-implement role=implement /u);
      assert.equal(result.stdout.trim().split('\n').length, 1);
      assert.equal(/Forced final status/u.test(result.stdout), false);
    });
  });

  void it('accepts a fake Pi run only when status, receipt, hash, identity, and tool carrier join', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'success' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
      assert.equal(typeof result.executionCommitSha, 'string');
      if (result.executionCommitOutput === null) throw new Error('expected execution-commit evidence');
      const executionCommit = JSON.parse(await readFile(result.executionCommitOutput, 'utf8')) as { schema_version?: string; edited_claimed_paths?: string[] };
      assert.equal(executionCommit.schema_version, 'autopilot.execution_commit.v1');
      assert.deepEqual(executionCommit.edited_claimed_paths, ['src/smoke.ts']);
      const receipt = JSON.parse(await readFile(unitSpec.receipt_output, 'utf8')) as FakeReceipt;
      assert.equal(receipt.tool_call_id, 'call-autopilot-fake-1');
      const contextPath = process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
      if (contextPath === undefined) throw new Error('runner coordinator context path missing');
      const context = await readCoordinatorSessionContext(contextPath);
      const coordinationStatus = await new CoordinatorClient({ env: process.env, autoStart: false }).query('status', context.repo_id, context.workstream_run);
      const attempts = coordinationStatus.payload['unit_attempts'];
      if (!Array.isArray(attempts)) throw new Error('runner status unit_attempts is not an array');
      const durableAttempt = attempts.map(parseCoordinationUnitAttempt).find((attempt) => attempt.owner.unit_id === unitSpec.unit_id);
      assert.equal(durableAttempt?.state, 'transport-complete');
      assert.equal(durableAttempt?.checkpoint_ordinal, 1);
    });
  });

  void it('accepts a child-created git commit inside the registered worktree as execution evidence', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'child-commit' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.auditClassification, 'clean');
      if (result.executionCommitOutput === null) throw new Error('expected child commit evidence');
      const executionCommit = JSON.parse(await readFile(result.executionCommitOutput, 'utf8')) as {
        readonly commit_origin?: string;
        readonly commit_shas?: readonly string[];
        readonly edited_claimed_paths?: readonly string[];
      };
      assert.equal(executionCommit.commit_origin, 'child');
      assert.deepEqual(executionCommit.edited_claimed_paths, ['src/smoke.ts']);
      assert.equal((executionCommit.commit_shas ?? []).length, 1);
    });
  });

  void it('accepts fake Pi source-changing runs with more than the old 120 changed-path cap', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root, {
        owned_paths: ['src/generated'],
        stop_boundary: 'Edit only generated source files.',
      });
      const specPath = await writeSpec(root, unitSpec);
      git(unitSpec.cwd, ['rm', '-f', 'src/generated']);
      await mkdir(join(unitSpec.cwd, 'src', 'generated'), { recursive: true });
      await writeFile(join(unitSpec.cwd, 'src', 'generated', '.keep'), 'generated baseline\n', 'utf8');
      git(unitSpec.cwd, ['add', '.']);
      git(unitSpec.cwd, ['commit', '-m', 'generated directory baseline']);

      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'many-changed-paths' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });

      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.changed_paths.length, 121);
      assert.equal(result.auditClassification, 'clean');
      if (result.executionCommitOutput === null) throw new Error('expected execution-commit evidence');
      const executionCommit = JSON.parse(await readFile(result.executionCommitOutput, 'utf8')) as { edited_claimed_paths?: string[] };
      assert.equal(executionCommit.edited_claimed_paths?.length, 121);
    });
  });

  void it('rejects success status that omits audit-detected changed paths', async () => {
    await withTempDir(async (root) => {
      const worktree = join(root, 'worktree');
      await initGitWorktree(worktree);
      const unitSpec = spec(root, { cwd: worktree });
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'omitted-actual-change' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError &&
          error.failureClass === 'invalid-structured-output' &&
          /success status omitted actual changed path/u.test(error.details.reason),
      );
    });
  });

  void it('accepts terminal status-tool completion when Pi stops on toolUse without a follow-up message', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'terminal-tool-use' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
    });
  });

  void it('accepts Pi tool_execution_start/end framing without counting start as a status carrier', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'execution-events' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
    });
  });

  void it('deduplicates repeated status carrier frames for the same tool call', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'duplicate-carrier-frame' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
    });
  });

  void it('normalizes carrier tool identity from the Pi event when details omit tool_name', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'missing-details-tool-name' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
    });
  });

  void it('normalizes carrier call identity from the Pi event when details omit tool_call_id', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'missing-details-tool-call-id' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
    });
  });

  void it('rejects conflicting carrier tool identity inside details', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'conflicting-details-tool-name' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError &&
          error.failureClass === 'invalid-structured-output' &&
          /tool_name mismatch/u.test(error.details.reason),
      );
    });
  });

  void it('accepts an error-marked carrier when valid status and receipt evidence join', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'error-marked-carrier' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
    });
  });

  void it('rejects an error-marked carrier without matching status details', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'error-marked-carrier-missing-details' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError &&
          error.failureClass === 'invalid-structured-output' &&
          /details are missing/u.test(error.details.reason),
      );
    });
  });

  void it('selects the receipt-matching carrier when a stale mismatched carrier is also present', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'stale-carrier-before-valid' },
        timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
    });
  });

  void it('rejects status evidence when no carrier matches the accepted receipt', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'mismatched-only-carrier' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError &&
          error.failureClass === 'invalid-structured-output' &&
          /no autopilot_emit_status carrier matched accepted receipt\/status evidence/u.test(error.details.reason) &&
          /tool_call_id mismatch/u.test(error.details.reason),
      );
    });
  });

  void it('rejects assistant-text JSON without forced tool output', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'assistant-json-only' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError && error.failureClass === 'missing-structured-output',
      );
    });
  });

  void it('rejects invalid status artifacts even when a fake receipt exists', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'invalid-status' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError && error.failureClass === 'invalid-structured-output',
      );
    });
  });

  void it('classifies BLOCKED or NEEDS_FIX valid statuses as non-success', async () => {
    for (const scenario of ['blocked-status', 'needs-fix-status']) {
      await withTempDir(async (root) => {
        const unitSpec = scenario === 'needs-fix-status'
          ? spec(root, {
              role: 'validate',
              template: 'validate',
              owned_paths: [],
              validation_commands: ['true'],
              unit_id: 'u01-validate',
              status_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'statuses', 'u01-validate.validate.attempt-1.json'),
              receipt_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'receipts', 'u01-validate.validate.attempt-1.receipt.json'),
              evidence_dir: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'evidence', 'u01-validate'),
            })
          : spec(root);
        const specPath = await writeSpec(root, unitSpec);
        const fakePi = await writeFakePi(root);
        let terminalError: AutopilotAgentRunError | null = null;
        await expectRejects(
          () =>
            runAutopilotAgentFromSpecPath(specPath, {
              piExecutable: fakePi,
              env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: scenario },
              timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
            }),
          (error: unknown) => {
            if (error instanceof AutopilotAgentRunError) terminalError = error;
            return error instanceof AutopilotAgentRunError && error.failureClass === 'status-non-success';
          },
        );
        if (terminalError === null) throw new Error('status-non-success did not expose its typed terminal error');
        const acceptedError = terminalError as AutopilotAgentRunError;
        const acceptancePath = acceptedError.details.terminalAcceptanceOutput;
        assert.equal(typeof acceptancePath, 'string');
        const acceptance = parseAutopilotChildTerminalAcceptance(JSON.parse(await readFile(acceptancePath ?? '', 'utf8')) as unknown);
        assert.equal(acceptance.verdict, scenario === 'blocked-status' ? 'BLOCKED' : 'NEEDS_FIX');
        assert.equal(acceptance.transport_result, 'accepted');
        const contextPath = process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
        if (contextPath === undefined) throw new Error('missing coordinator test session context');
        const session = await readCoordinatorSessionContext(contextPath);
        const coordinatorStatus = await new CoordinatorClient({ env: { ...process.env, AUTOPILOT_STATE_ROOT: session.state_root } }).query('status', session.repo_id, session.workstream_run);
        const children = (coordinatorStatus.payload['child_leases'] as readonly unknown[]).map(parseCoordinationChildLease);
        const child = children.find((candidate) => candidate.owner.unit_id === unitSpec.unit_id && candidate.owner.attempt === unitSpec.attempt);
        assert.equal(child?.status, 'terminal');
        assert.equal(child?.terminal_evidence?.sha256, acceptedError.details.terminalAcceptanceSha256);
        const observations = (coordinatorStatus.payload['observations'] as readonly unknown[]).map(parseCoordinationObservation).filter((entry) => entry.owner.unit_id === unitSpec.unit_id && entry.owner.attempt === unitSpec.attempt);
        assert.equal(observations.every((entry) => entry.execution_state === 'released'), true);
        const editLeases = (coordinatorStatus.payload['edit_leases'] as readonly unknown[]).map(parseCoordinationEditLease).filter((entry) => entry.owner.unit_id === unitSpec.unit_id && entry.owner.attempt === unitSpec.attempt);
        assert.equal(editLeases.length, 0, 'clean terminal non-success must not retain edit authority');
      });
    }
  });

  void it('repairs a historical non-success leak only from an exact parent acceptance event', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root, {
        role: 'validate', template: 'validate', owned_paths: [], validation_commands: ['true'], unit_id: 'u02-historical-validate',
        status_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'statuses', 'u02-historical-validate.validate.attempt-1.json'),
        receipt_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'receipts', 'u02-historical-validate.validate.attempt-1.receipt.json'),
        evidence_dir: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'evidence', 'u02-historical-validate'),
      });
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () => runAutopilotAgentFromSpecPath(specPath, { piExecutable: fakePi, env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'needs-fix-mismatched-carrier' }, timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS }),
        (error: unknown) => error instanceof AutopilotAgentRunError && error.failureClass === 'invalid-structured-output',
      );
      const contextPath = process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
      if (contextPath === undefined) throw new Error('missing historical repair session context');
      const session = await readCoordinatorSessionContext(contextPath);
      const client = new CoordinatorClient({ env: { ...process.env, AUTOPILOT_STATE_ROOT: session.state_root } });
      const childStatus = async (): Promise<ReturnType<typeof parseCoordinationChildLease>> => {
        const response = await client.query('status', session.repo_id, session.workstream_run);
        const child = (response.payload['child_leases'] as readonly unknown[]).map(parseCoordinationChildLease).find((candidate) => candidate.owner.unit_id === unitSpec.unit_id);
        if (child === undefined) throw new Error('historical repair child disappeared');
        return child;
      };
      assert.equal((await childStatus()).status, 'recovery-required');
      await (await RunReconciliationClient.fromEnvironment(process.env)).reconcile('prove artifact files alone cannot repair carrier acceptance');
      assert.equal((await childStatus()).status, 'recovery-required');

      const runtimeRoot = dirname(dirname(unitSpec.status_output));
      await appendFile(join(runtimeRoot, 'events.jsonl'), `${JSON.stringify({
        schema_version: 'autopilot.event.v1', id: 1, ts: new Date(Date.now() + 1_000).toISOString(), event: 'agent_completed', workstream: unitSpec.workstream,
        unit_id: unitSpec.unit_id, role: unitSpec.role, verdict: 'NEEDS_FIX', severity: 'major-local',
        status_ref: `statuses/${unitSpec.unit_id}.${unitSpec.role}.attempt-${String(unitSpec.attempt)}.json`,
        receipt_ref: `receipts/${unitSpec.unit_id}.${unitSpec.role}.attempt-${String(unitSpec.attempt)}.receipt.json`, summary: 'Parent accepted the exact historical forced-output carrier.',
      })}\n`, 'utf8');
      const beforeRepair = await client.query('status', session.repo_id, session.workstream_run);
      const durableAttempt = (beforeRepair.payload['unit_attempts'] as readonly unknown[]).map(parseCoordinationUnitAttempt).find((candidate) => candidate.owner.unit_id === unitSpec.unit_id);
      if (durableAttempt === undefined) throw new Error('historical repair attempt disappeared');
      const proof = proveStructuredAttemptTerminal({ mainWorktreePath: unitSpec.cwd, runtimeRoot, repoId: session.repo_id, autopilotId: session.autopilot_id, workstream: session.workstream, workstreamRun: session.workstream_run, unitId: unitSpec.unit_id, attempt: unitSpec.attempt, childLeaseId: (await childStatus()).child_lease_id, spec: durableAttempt.spec });
      assert.equal(proof.proven, true, proof.proven ? undefined : proof.reason);
      await (await RunReconciliationClient.fromEnvironment(process.env)).reconcile('repair exact historical parent-accepted non-success');
      const repaired = await childStatus();
      assert.equal(repaired.status, 'terminal');
      assert.match(repaired.terminal_evidence?.ref ?? '', /receipts\//u);
    });
  });

  void it('includes bounded Pi result diagnostics when Pi returns an error result', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'error-result' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError &&
          error.failureClass === 'pi-spawn-failed' &&
          /provider="openai-codex"/u.test(error.details.reason) &&
          /model="gpt-5\.6-terra"/u.test(error.details.reason) &&
          /last_events/u.test(error.details.reason) &&
          /fake provider failure/u.test(error.details.reason),
      );
    });
  });

  void it('classifies fake Pi child exit as pi-spawn-failed', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'exit-after-prompt' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError && error.failureClass === 'pi-spawn-failed',
      );
    });
  });

  void it('classifies fake Pi wall timeout as pi-spawn-failed', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'hang-after-prompt' },
            timeoutMsOverride: 80,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError && error.failureClass === 'pi-spawn-failed',
      );
    });
  });

  void it('rejects stale status_output before launching live Pi while dry-run can inspect completed specs', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      await mkdir(dirname(unitSpec.status_output), { recursive: true });
      await writeFile(unitSpec.status_output, '{}\n', 'utf8');
      const dryRun = await runAutopilotAgentFromSpecPath(specPath, { dryRun: true });
      assert.equal(dryRun.status, 'dry-run');
      const fakePi = await writeFakePi(root);
      await expectRejects(
        () =>
          runAutopilotAgentFromSpecPath(specPath, {
            piExecutable: fakePi,
            env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: 'success' },
            timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
          }),
        (error: unknown) =>
          error instanceof AutopilotAgentRunError && error.failureClass === 'spec-invalid',
      );
    });
  });
});

interface FakeReceipt {
  readonly tool_call_id: string;
}

const FAKE_PI_SOURCE = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const scenario = process.env.AUTOPILOT_FAKE_PI_SCENARIO || 'success';
const contextPath = process.env.AUTOPILOT_AGENT_STATUS_CONTEXT;
if (process.env.AUTOPILOT_COORDINATOR_SESSION_CONTEXT !== undefined) throw new Error('parent session authority leaked into child Pi');

function write(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function response(cmd, success = true, extra = {}) { write({ id: cmd.id, type: 'response', command: cmd.type, success, ...extra }); }
function state() {
  return {
    model: { id: 'gpt-5.6-terra', provider: 'openai-codex', api: 'openai-codex-responses' },
    thinkingLevel: 'high',
    sessionFile: null,
    sessionId: 'autopilot-fake-session',
    isStreaming: false,
  };
}
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('fake git failed: ' + result.stderr);
}
function assistant(message, stopReason = 'stop') {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: message }],
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-5.6-terra',
    usage: { input: 1, output: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}
function loadContext() {
  if (!contextPath) throw new Error('missing AUTOPILOT_AGENT_STATUS_CONTEXT');
  return JSON.parse(readFileSync(contextPath, 'utf8'));
}
function manyChangedPaths() {
  return Array.from({ length: 121 }, (_, index) => 'src/generated/file-' + String(index).padStart(4, '0') + '.ts');
}
function buildStatus(context) {
  const unit = context.unit_spec;
  if (scenario === 'invalid-status') {
    return {
      schema_version: 'autopilot.status.v1', workstream: unit.workstream, unit_id: unit.unit_id,
      role: unit.role, attempt: unit.attempt, verdict: 'PASS', severity: 'clean', summary: 'Invalid implement PASS.',
      changed_paths: [], findings: [], commands: [], evidence_refs: [], report_ref: null, next_action: 'invalid'
    };
  }
  if (scenario === 'blocked-status') {
    return {
      schema_version: 'autopilot.status.v1', workstream: unit.workstream, unit_id: unit.unit_id,
      role: unit.role, attempt: unit.attempt, verdict: 'BLOCKED', severity: 'major-local', summary: 'Blocked by fake scenario.',
      changed_paths: [], findings: [], commands: [], evidence_refs: [], report_ref: null, next_action: 'operator decision needed'
    };
  }
  if (scenario === 'needs-fix-status' || scenario === 'needs-fix-mismatched-carrier') {
    return {
      schema_version: 'autopilot.status.v1', workstream: unit.workstream, unit_id: unit.unit_id,
      role: unit.role, attempt: unit.attempt, verdict: 'NEEDS_FIX', severity: 'major-local', summary: 'Fix needed by fake scenario.',
      changed_paths: [], findings: [{ id: 'fake.issue', severity: 'major-local', summary: 'fake issue' }], commands: [], evidence_refs: [], report_ref: null, next_action: 'fix fake issue'
    };
  }
  if (scenario === 'many-changed-paths') {
    const validationCommands = Array.isArray(unit.validation_commands) ? unit.validation_commands : [];
    const commands = validationCommands.map((command) => ({ command, status: 'passed', exit_code: 0, summary: 'fake command passed' }));
    return {
      schema_version: 'autopilot.status.v1', workstream: unit.workstream, unit_id: unit.unit_id,
      role: unit.role, attempt: unit.attempt, verdict: 'DONE', severity: 'clean', summary: 'Fake Autopilot status completed with many changed paths.',
      changed_paths: manyChangedPaths(), findings: [], commands, evidence_refs: [], report_ref: null, next_action: 'fake next action'
    };
  }
  const validationCommands = Array.isArray(unit.validation_commands) ? unit.validation_commands : [];
  const commands = validationCommands.map((command) => ({ command, status: 'passed', exit_code: 0, summary: 'fake command passed' }));
  const coveredWitnessIds = unit.role === 'validate' || unit.role === 'bughunt' ? ['positive-validation-command'] : undefined;
  return {
    schema_version: 'autopilot.status.v1', workstream: unit.workstream, unit_id: unit.unit_id,
    role: unit.role, attempt: unit.attempt, verdict: unit.role === 'validate' || unit.role === 'bughunt' ? 'PASS' : 'DONE',
    severity: 'clean', summary: 'Fake Autopilot status completed.',
    changed_paths: unit.role === 'implement' || unit.role === 'fix' ? [unit.owned_paths[0]] : [],
    findings: [], commands, evidence_refs: [], report_ref: null, ...(coveredWitnessIds === undefined ? {} : { covered_witness_ids: coveredWitnessIds }), next_action: 'fake next action'
  };
}
function emitForcedStatus() {
  const context = loadContext();
  const unit = context.unit_spec;
  if ((unit.role === 'implement' || unit.role === 'fix') && scenario === 'many-changed-paths') {
    for (const changedPath of manyChangedPaths()) {
      const ownedPath = join(unit.cwd, ...changedPath.split('/'));
      mkdirSync(dirname(ownedPath), { recursive: true });
      writeFileSync(ownedPath, 'export const generated = ' + JSON.stringify(changedPath) + ';\\n', 'utf8');
    }
  } else if ((unit.role === 'implement' || unit.role === 'fix') && scenario !== 'blocked-status') {
    const ownedPath = join(unit.cwd, ...String(unit.owned_paths[0]).split('/'));
    mkdirSync(dirname(ownedPath), { recursive: true });
    writeFileSync(ownedPath, 'export const smoke = "fake implementation";\\n', 'utf8');
  }
  if (scenario === 'omitted-actual-change') {
    const omittedPath = join(context.unit_spec.cwd, 'src', 'omitted.ts');
    mkdirSync(dirname(omittedPath), { recursive: true });
    writeFileSync(omittedPath, 'export const omitted = true;\\n', 'utf8');
  }
  if (scenario === 'child-commit') {
    git(['add', '--', String(unit.owned_paths[0])], unit.cwd);
    git(['commit', '-m', 'child commits owned change'], unit.cwd);
  }
  const status = buildStatus(context);
  mkdirSync(dirname(context.status_output), { recursive: true });
  mkdirSync(dirname(context.receipt_output), { recursive: true });
  const statusBytes = JSON.stringify(status, null, 2) + '\\n';
  writeFileSync(context.status_output, statusBytes, 'utf8');
  const statusSha256 = 'sha256:' + createHash('sha256').update(statusBytes, 'utf8').digest('hex');
  const receipt = {
    schema_version: 'autopilot.receipt.v1', tool_name: 'autopilot_emit_status', workstream: context.unit_spec.workstream,
    unit_id: context.unit_spec.unit_id, role: context.unit_spec.role, attempt: context.unit_spec.attempt,
    emitted_at: '2026-06-29T00:00:00.000Z', status_output: context.status_output, status_sha256: statusSha256,
    schema_sha256: context.schema_sha256, tool_call_id: 'call-autopilot-fake-1', provider_identity: context.provider_identity,
    expected_identity_hash: context.expected_identity_hash
  };
  writeFileSync(context.receipt_output, JSON.stringify(receipt, null, 2) + '\\n', 'utf8');
  const details = {
    schema_version: 'autopilot.status_tool_result.v1', tool_name: 'autopilot_emit_status', tool_call_id: 'call-autopilot-fake-1', terminating: true,
    workstream: status.workstream, unit_id: status.unit_id, role: status.role, attempt: status.attempt,
    verdict: status.verdict, severity: status.severity, status_output: context.status_output, receipt_output: context.receipt_output,
    status_sha256: statusSha256, schema_sha256: context.schema_sha256, expected_identity_hash: context.expected_identity_hash
  };
  const content = [{ type: 'text', text: 'Autopilot status emitted by fake Pi' }];
  const carrierDetails = scenario === 'missing-details-tool-name'
    ? { ...details, tool_name: undefined }
    : scenario === 'missing-details-tool-call-id'
      ? { ...details, tool_call_id: undefined }
      : scenario === 'conflicting-details-tool-name'
        ? { ...details, tool_name: 'wrong_tool' }
        : details;
  if (scenario === 'execution-events') {
    write({ type: 'tool_execution_start', toolName: 'autopilot_emit_status', toolCallId: 'call-autopilot-fake-1', args: { workstream: status.workstream } });
    write({ type: 'tool_execution_update', toolName: 'autopilot_emit_status', toolCallId: 'call-autopilot-fake-1', args: { workstream: status.workstream }, partialResult: { content, details } });
    write({ type: 'tool_execution_end', toolName: 'autopilot_emit_status', toolCallId: 'call-autopilot-fake-1', isError: false, result: { content, details } });
    return;
  }
  if (scenario === 'error-marked-carrier-missing-details') {
    write({ type: 'tool_result', toolName: 'autopilot_emit_status', toolCallId: 'call-autopilot-fake-1', isError: true });
    return;
  }
  const mismatchedDetails = { ...details, tool_call_id: 'call-autopilot-fake-2' };
  if (scenario === 'mismatched-only-carrier' || scenario === 'needs-fix-mismatched-carrier') {
    write({ type: 'tool_result', toolName: 'autopilot_emit_status', toolCallId: 'call-autopilot-fake-2', isError: false, details: mismatchedDetails });
    return;
  }
  if (scenario === 'stale-carrier-before-valid') {
    write({ type: 'tool_result', toolName: 'autopilot_emit_status', toolCallId: 'call-autopilot-fake-2', isError: false, details: mismatchedDetails });
  }
  const carrierIsError = scenario === 'error-marked-carrier';
  write({ type: 'tool_result', toolName: 'autopilot_emit_status', toolCallId: 'call-autopilot-fake-1', isError: carrierIsError, details: carrierDetails });
  if (scenario === 'duplicate-carrier-frame') {
    write({ type: 'tool_execution_end', toolName: 'autopilot_emit_status', toolCallId: 'call-autopilot-fake-1', isError: false, result: { content, details } });
  }
}
async function emitTurn(message) {
  write({ type: 'agent_start' });
  write({ type: 'turn_start' });
  if (scenario !== 'assistant-json-only') emitForcedStatus();
  const isErrorResult = scenario === 'error-result';
  const isTerminalToolUse = scenario === 'terminal-tool-use';
  if (isErrorResult) write({ type: 'message_update', isError: true, errorMessage: 'fake provider failure with bounded diagnostic text' });
  const msg = assistant(message, isErrorResult ? 'error' : isTerminalToolUse ? 'toolUse' : 'stop');
  if (isTerminalToolUse) msg.content = [];
  write({ type: 'message_end', message: msg, ...(isTerminalToolUse ? { isError: true } : {}) });
  write({ type: 'turn_end', message: msg, toolResults: [], ...(isTerminalToolUse ? { isError: true } : {}) });
  write({ type: 'agent_end', messages: [msg], ...(isTerminalToolUse ? { isError: true } : {}) });
}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === 'get_state') { response(cmd, true, { data: state() }); return; }
  if (cmd.type === 'get_session_stats') { response(cmd, true, { data: { sessionId: 'autopilot-fake-session', tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 } }); return; }
  if (cmd.type === 'prompt') {
    if (typeof cmd.message !== 'string' || Object.prototype.hasOwnProperty.call(cmd, 'prompt')) {
      response(cmd, false, { error: 'prompt RPC command must use message field only' });
      return;
    }
    response(cmd);
    if (scenario === 'exit-after-prompt') process.exit(7);
    if (scenario === 'hang-after-prompt') { write({ type: 'agent_start' }); return; }
    await emitTurn(scenario === 'assistant-json-only' ? JSON.stringify({ verdict: 'DONE' }) : 'fake done');
    return;
  }
  if (cmd.type === 'abort') { response(cmd); write({ type: 'agent_end', messages: [] }); return; }
  response(cmd, false, { error: 'unsupported' });
});
`;
