import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { runAutopilotAgentFromSpecPath } from '../../src/core/agent-runner.ts';
import { AUTOPILOT_STATE_ROOT_ENV, prepareAutopilotWorkstream } from '../../src/core/parallel-runtime.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { DurableRunSupervisorClient } from '../../src/core/coordination/supervisor.ts';
import {
  computeAutopilotRosterContractObjectHash,
  parseAutopilotUnitSpecV2,
  type AutopilotRosterRequestProfileV1,
  type AutopilotUnitSpecV2,
} from '../../src/core/contracts/index.ts';

void describe('agent runner roster v2 identity', () => {
  void it('dry-runs v2 without fixed-roster clamping and writes v2-aware status context', async () => {
    await withTempDir(async (root) => {
      const source = join(root, 'source');
      await initGitSource(source);
      const prepared = await prepareAutopilotWorkstream({ workstream: 'rosterw3', sourceCwd: source });
      const supervisor = new DurableRunSupervisorClient(process.env);
      const attachment = await supervisor.attach({ repo: prepared.repo, active: prepared.active, rawSessionId: 'roster-runner-parent' });
      process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = attachment.contextPath;

      const requestProfile = makeRequestProfile();
      const unitSpec = parseAutopilotUnitSpecV2(makeUnitSpecV2(prepared.mainWorktreePath, prepared.runtimeRoot, requestProfile));
      const specPath = join(prepared.runtimeRoot, 'unit-specs', 'u01validate.validate.attempt-1.json');
      await mkdir(dirname(specPath), { recursive: true });
      await writeFile(specPath, `${JSON.stringify(unitSpec, null, 2)}\n`, 'utf8');

      const result = await runAutopilotAgentFromSpecPath(specPath, { dryRun: true });
      assert.equal(result.status, 'dry-run');
      assert.equal(result.spec.model, requestProfile.model);
      assert.equal(result.spec.thinking, requestProfile.thinking);

      const context = JSON.parse(await readFile(result.contextPath, 'utf8')) as Record<string, unknown>;
      assert.equal(context['receipt_schema_version'], 'autopilot.receipt.v2');
      const rosterIdentity = context['roster_execution_identity'] as Record<string, unknown>;
      assert.equal(rosterIdentity['roster_id'], unitSpec.roster_id);
      assert.equal((rosterIdentity['request_profile'] as Record<string, unknown>)['model'], requestProfile.model);

      assert.equal(typeof result.promptSnapshotPath, 'string');
      const prompt = await readFile(result.promptSnapshotPath ?? '', 'utf8');
      assert.match(prompt, /anthropic\/claude-sonnet-4-5/u);
      assert.equal(/openai-codex\/gpt-5\.6-sol/u.test(prompt), false);
    });
  });
});

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-agent-runner-roster-'));
  const originalStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
  const originalSessionContext = process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  process.env[AUTOPILOT_STATE_ROOT_ENV] = join(root, 'autopilot-state');
  const coordinator = await startCoordinatorServer(coordinatorRuntimePaths(process.env));
  try {
    return await run(root);
  } finally {
    await coordinator.close();
    if (originalStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
    else process.env[AUTOPILOT_STATE_ROOT_ENV] = originalStateRoot;
    if (originalSessionContext === undefined) delete process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    else process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = originalSessionContext;
    await rm(root, { recursive: true, force: true });
  }
}

function makeUnitSpecV2(mainWorktreePath: string, runtimeRoot: string, requestProfile: AutopilotRosterRequestProfileV1): AutopilotUnitSpecV2 {
  return {
    schema_version: 'autopilot.unit_spec.v2',
    workstream: 'rosterw3',
    unit_id: 'u01validate',
    role: 'validate',
    template: 'validate',
    attempt: 1,
    objective: 'Dry-run a v2 roster-selected validation unit.',
    cwd: mainWorktreePath,
    model: requestProfile.model,
    thinking: requestProfile.thinking,
    owned_paths: [],
    read_only_paths: ['src/index.ts'],
    untouchable_paths: [],
    context_refs: [
      { path: '.pi/autopilot/rosterw3/mission.md', purpose: 'Mission', sha256: null, byte_count: null },
      { path: '.pi/autopilot/rosterw3/master-plan.json', purpose: 'Plan', sha256: null, byte_count: null },
    ],
    validation_commands: ['true'],
    status_output: join(runtimeRoot, 'statuses', 'u01validate.validate.attempt-1.json'),
    receipt_output: join(runtimeRoot, 'receipts', 'u01validate.validate.attempt-1.receipt.json'),
    evidence_dir: join(runtimeRoot, 'evidence', 'u01validate'),
    stop_boundary: 'Validate only.',
    quality_profile: 'validation-only',
    risk_level: 'low',
    acceptance_criteria: ['dry-run accepted'],
    verification_plan: verificationPlan(),
    closure_criteria: ['prompt rendered'],
    upstream_refs: [],
    timeout_seconds: 60,
    render_prompt_snapshot: true,
    roster_id: 'anthropicroster',
    roster_revision: 1,
    roster_sha256: sha('roster'),
    assignment_sha256: sha('assignment'),
    pre_run_selection_sha256: sha('selection'),
    request_profile: requestProfile,
  };
}

function verificationPlan(): AutopilotUnitSpecV2['verification_plan'] {
  return {
    positive_witnesses: [{ id: 'positive-validation-command', command: 'true', expected_signal: 'passes', required: true }],
    negative_witnesses: [],
    regression_witnesses: [],
    real_boundary_witnesses: [],
    blast_radius_checks: [],
    docs_schema_prompt_checks: [],
    dirty_tree_checks: [],
  };
}

function makeRequestProfile(): AutopilotRosterRequestProfileV1 {
  const preimage = {
    provider_id: 'anthropic',
    model_id: 'claude-sonnet-4-5',
    model: 'anthropic/claude-sonnet-4-5',
    api: 'anthropic-messages' as const,
    thinking: 'xhigh' as const,
    service_tier: null,
    cache_policy: 'provider-default' as const,
    system_prompt_profile: 'anthropic-autopilot-sanitized.v1' as const,
    context_window: 200000,
    max_output_tokens: 64000,
    input_modalities: ['text'] as const,
    output_modalities: ['text'] as const,
    reasoning_capability: 'reasoning-supported' as const,
    tool_capability: 'tool-use-supported' as const,
    route_policy_id: 'anthropic-subscription-v1',
    route_policy_revision: 1,
  };
  return { ...preimage, request_profile_sha256: requiredHash('autopilot.request_profile.v1', preimage) };
}

async function initGitSource(source: string): Promise<void> {
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, '.gitignore'), '.pi/\n', 'utf8');
  await writeFile(join(source, 'src', 'index.ts'), 'export const roster = "baseline";\n', 'utf8');
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

function requiredHash(schemaVersion: Parameters<typeof computeAutopilotRosterContractObjectHash>[0], value: unknown): `sha256:${string}` {
  const hash = computeAutopilotRosterContractObjectHash(schemaVersion, value);
  if (hash === null) throw new Error(`${schemaVersion} has no hash field`);
  return hash as `sha256:${string}`;
}

function sha(label: string): `sha256:${string}` {
  return `sha256:${Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64)}` as `sha256:${string}`;
}
