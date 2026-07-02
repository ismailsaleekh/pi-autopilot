import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AutopilotUnitSpec, AutopilotVerificationPlan } from '../../src/core/contracts/index.ts';
import { AutopilotAgentRunError, runAutopilotAgentFromSpecPath } from '../../src/core/agent-runner.ts';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, '..', '..');
const AUTOPILOT_AGENT_RUN_CLI = resolve(PACKAGE_ROOT, 'src', 'cli', 'autopilot-agent-run.ts');
const FAKE_PI_COMPLETION_TIMEOUT_MS = 10_000;

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-agent-runner-test-'));
  try {
    return await run(dir);
  } finally {
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
    model: 'openai-codex/gpt-5.5',
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
  if (merged.role === 'validate' || merged.role === 'bughunt') {
    const command = merged.validation_commands[0] ?? 'true';
    return {
      ...merged,
      quality_profile: 'validation-only',
      risk_level: overrides.risk_level ?? 'low',
      acceptance_criteria: ['independent validation covers declared commands'],
      verification_plan: verificationPlan(command),
      closure_criteria: ['validation status is PASS'],
      upstream_refs: merged.upstream_refs ?? [],
    };
  }
  return merged;
}

async function writeSpec(root: string, unitSpec: AutopilotUnitSpec): Promise<string> {
  await mkdir(unitSpec.cwd, { recursive: true });
  const specPath = join(root, 'unit-spec.json');
  await writeFile(specPath, `${JSON.stringify(unitSpec, null, 2)}\n`, 'utf8');
  return specPath;
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

const CURRENT_PI_SUBSCRIPTION_MODELS = [
  'openai-codex/gpt-5.3-codex-spark',
  'openai-codex/gpt-5.4',
  'openai-codex/gpt-5.4-mini',
  'openai-codex/gpt-5.5',
  'anthropic/claude-3-5-haiku-20241022',
  'anthropic/claude-3-5-haiku-latest',
  'anthropic/claude-3-5-sonnet-20240620',
  'anthropic/claude-3-5-sonnet-20241022',
  'anthropic/claude-3-7-sonnet-20250219',
  'anthropic/claude-3-haiku-20240307',
  'anthropic/claude-3-opus-20240229',
  'anthropic/claude-3-sonnet-20240229',
  'anthropic/claude-fable-5',
  'anthropic/claude-haiku-4-5',
  'anthropic/claude-haiku-4-5-20251001',
  'anthropic/claude-opus-4-0',
  'anthropic/claude-opus-4-1',
  'anthropic/claude-opus-4-1-20250805',
  'anthropic/claude-opus-4-20250514',
  'anthropic/claude-opus-4-5',
  'anthropic/claude-opus-4-5-20251101',
  'anthropic/claude-opus-4-6',
  'anthropic/claude-opus-4-7',
  'anthropic/claude-opus-4-8',
  'anthropic/claude-sonnet-4-0',
  'anthropic/claude-sonnet-4-20250514',
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-sonnet-4-5-20250929',
  'anthropic/claude-sonnet-4-6',
  'opencode-go/deepseek-v4-flash',
  'opencode-go/deepseek-v4-pro',
  'opencode-go/glm-5.1',
  'opencode-go/glm-5.2',
  'opencode-go/kimi-k2.6',
  'opencode-go/kimi-k2.7-code',
  'opencode-go/mimo-v2.5',
  'opencode-go/mimo-v2.5-pro',
  'opencode-go/minimax-m2.7',
  'opencode-go/minimax-m3',
  'opencode-go/qwen3.6-plus',
  'opencode-go/qwen3.7-max',
  'opencode-go/qwen3.7-plus',
  'kimi-coding/k2p7',
  'kimi-coding/kimi-for-coding',
  'kimi-coding/kimi-k2-thinking',
  'zai/glm-4.5-air',
  'zai/glm-4.7',
  'zai/glm-5-turbo',
  'zai/glm-5.1',
  'zai/glm-5.2',
  'zai/glm-5v-turbo',
] as const;

function runCli(args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', AUTOPILOT_AGENT_RUN_CLI, ...args], {
    cwd: PACKAGE_ROOT,
    env: process.env,
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

  void it('dry-runs every current Pi subscription model under Autopilot provider gates', async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, 'worktree'), { recursive: true });
      for (const [index, model] of CURRENT_PI_SUBSCRIPTION_MODELS.entries()) {
        const unitId = `u${String(index).padStart(2, '0')}-validate`;
        const unitSpec = spec(root, {
          unit_id: unitId,
          role: 'validate',
          template: 'validate',
          model,
          owned_paths: [],
          validation_commands: ['true'],
          status_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'statuses', `${unitId}.validate.attempt-1.json`),
          receipt_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'receipts', `${unitId}.validate.attempt-1.receipt.json`),
          evidence_dir: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'evidence', unitId),
        });
        const specPath = join(root, `${unitId}.unit-spec.json`);
        await writeFile(specPath, `${JSON.stringify(unitSpec, null, 2)}\n`, 'utf8');
        const result = await runAutopilotAgentFromSpecPath(specPath, { dryRun: true });
        assert.equal(result.status, 'dry-run', model);
      }
    });
  });

  void it('rejects unsupported provider routes during dry-run preflight', async () => {
    const models = ['openrouter/gpt-4', 'openai/gpt-5', 'github-copilot/claude-sonnet', 'missing-slash'];
    await withTempDir(async (root) => {
      await mkdir(join(root, 'worktree'), { recursive: true });
      for (const [index, model] of models.entries()) {
        const unitId = `unsupported-${String(index)}`;
        const unitSpec = spec(root, {
          unit_id: unitId,
          model,
          status_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'statuses', `${unitId}.implement.attempt-1.json`),
          receipt_output: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'receipts', `${unitId}.implement.attempt-1.receipt.json`),
          evidence_dir: join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'evidence', unitId),
        });
        const specPath = join(root, `${unitId}.unit-spec.json`);
        await writeFile(specPath, `${JSON.stringify(unitSpec, null, 2)}\n`, 'utf8');
        await expectRejects(
          () => runAutopilotAgentFromSpecPath(specPath, { dryRun: true }),
          (error: unknown) =>
            error instanceof AutopilotAgentRunError &&
            error.failureClass === 'spec-invalid' &&
            /unsupported Autopilot subscription model|\/model has invalid format/u.test(error.details.reason),
          model,
        );
      }
    });
  });

  void it('CLI dry-run prints terse stdout without prompt body', async () => {
    await withTempDir(async (root) => {
      const unitSpec = spec(root);
      const specPath = await writeSpec(root, unitSpec);
      const result = runCli(['--dry-run', specPath]);
      assert.equal(result.code, 0);
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
      const receipt = JSON.parse(await readFile(unitSpec.receipt_output, 'utf8')) as FakeReceipt;
      assert.equal(receipt.tool_call_id, 'call-autopilot-fake-1');
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
        await expectRejects(
          () =>
            runAutopilotAgentFromSpecPath(specPath, {
              piExecutable: fakePi,
              env: { ...process.env, AUTOPILOT_FAKE_PI_SCENARIO: scenario },
              timeoutMsOverride: FAKE_PI_COMPLETION_TIMEOUT_MS,
            }),
          (error: unknown) =>
            error instanceof AutopilotAgentRunError && error.failureClass === 'status-non-success',
        );
      });
    }
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
          /model="gpt-5\.5"/u.test(error.details.reason) &&
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
      await mkdir(join(root, 'worktree', '.pi', 'autopilot', 'autopilot-smoke', 'statuses'), { recursive: true });
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
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

const scenario = process.env.AUTOPILOT_FAKE_PI_SCENARIO || 'success';
const contextPath = process.env.AUTOPILOT_AGENT_STATUS_CONTEXT;

function write(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function response(cmd, success = true, extra = {}) { write({ id: cmd.id, type: 'response', command: cmd.type, success, ...extra }); }
function state() {
  return {
    model: { id: 'gpt-5.5', provider: 'openai-codex', api: 'openai-codex-responses' },
    thinkingLevel: 'high',
    sessionFile: null,
    sessionId: 'autopilot-fake-session',
    isStreaming: false,
  };
}
function assistant(message, stopReason = 'stop') {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: message }],
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-5.5',
    usage: { input: 1, output: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}
function loadContext() {
  if (!contextPath) throw new Error('missing AUTOPILOT_AGENT_STATUS_CONTEXT');
  return JSON.parse(readFileSync(contextPath, 'utf8'));
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
  if (scenario === 'needs-fix-status') {
    return {
      schema_version: 'autopilot.status.v1', workstream: unit.workstream, unit_id: unit.unit_id,
      role: unit.role, attempt: unit.attempt, verdict: 'NEEDS_FIX', severity: 'major-local', summary: 'Fix needed by fake scenario.',
      changed_paths: [], findings: [{ id: 'fake.issue', severity: 'major-local', summary: 'fake issue' }], commands: [], evidence_refs: [], report_ref: null, next_action: 'fix fake issue'
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
  if (scenario === 'mismatched-only-carrier') {
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
