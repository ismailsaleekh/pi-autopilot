import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runAutopilotAgentFromSpecPath } from '../../src/core/agent-runner.ts';
import { AUTOPILOT_STATE_ROOT_ENV, prepareAutopilotUnitWorktree, prepareAutopilotWorkstream } from '../../src/core/parallel-runtime.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { DurableRunSupervisorClient } from '../../src/core/coordination/supervisor.ts';
import type { AutopilotEventRow, AutopilotState, AutopilotUnitSpec, AutopilotVerificationPlan } from '../../src/core/contracts/types.ts';
import { appendAutopilotEventRow, readAutopilotResumeSnapshot, writeAutopilotStateAtomic } from '../../src/core/state-store/index.ts';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-agent-e2e-'));
  const originalStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
  const originalSessionContext = process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  process.env[AUTOPILOT_STATE_ROOT_ENV] = join(dir, 'autopilot-state');
  const coordinator = await startCoordinatorServer(coordinatorRuntimePaths(process.env));
  try {
    return await run(dir);
  } finally {
    await coordinator.close();
    if (originalStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
    else process.env[AUTOPILOT_STATE_ROOT_ENV] = originalStateRoot;
    if (originalSessionContext === undefined) delete process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
    else process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = originalSessionContext;
    await rm(dir, { recursive: true, force: true });
  }
}

function verificationPlan(): AutopilotVerificationPlan {
  return {
    positive_witnesses: [
      {
        id: 'positive-e2e-command',
        command: 'npm test -- --runInBand',
        expected_signal: 'fake command exits zero',
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

function makeSpec(worktree: string, runtimeRoot: string): AutopilotUnitSpec {
  return {
    schema_version: 'autopilot.unit_spec.v1',
    workstream: 'autopilot-e2e',
    unit_id: 'e01-implement',
    role: 'implement',
    template: 'implement',
    attempt: 1,
    objective: 'Run fake child and persist state.',
    cwd: worktree,
    model: 'openai-codex/gpt-5.6-terra',
    thinking: 'high',
    owned_paths: ['src/e2e.ts'],
    read_only_paths: [],
    untouchable_paths: ['private/**'],
    context_refs: [
      { path: '.pi/autopilot/autopilot-e2e/mission.md', purpose: 'Durable mission truth' },
      { path: '.pi/autopilot/autopilot-e2e/master-plan.json', purpose: 'Durable master plan truth' },
    ],
    validation_commands: [],
    status_output: join(runtimeRoot, 'statuses', 'e01-implement.implement.attempt-1.json'),
    receipt_output: join(runtimeRoot, 'receipts', 'e01-implement.implement.attempt-1.receipt.json'),
    evidence_dir: join(runtimeRoot, 'evidence', 'e01-implement'),
    stop_boundary: 'Edit only src/e2e.ts.',
    quality_profile: 'source-change',
    risk_level: 'medium',
    acceptance_criteria: ['fake e2e implementation completes'],
    verification_plan: verificationPlan(),
    closure_criteria: ['state resumes after fake run'],
    upstream_refs: [],
    timeout_seconds: 60,
    render_prompt_snapshot: true,
  };
}

async function writeFakePi(root: string): Promise<string> {
  const fakePath = join(root, 'fake-pi.mjs');
  await writeFile(fakePath, FAKE_PI_SOURCE, 'utf8');
  const chmodResult = spawnSync('chmod', ['755', fakePath], { encoding: 'utf8' });
  assert.equal(chmodResult.status, 0, chmodResult.stderr);
  return fakePath;
}

void describe('autopilot runner e2e smoke', () => {
  void it('runs fake Pi, validates status evidence, writes state, and resumes under runtime root', async () => {
    await withTempDir(async (root) => {
      const source = join(root, 'source');
      await initGitSource(source);
      const prepared = await prepareAutopilotWorkstream({ workstream: 'autopilot-e2e', sourceCwd: source });
      const runtimeRoot = prepared.runtimeRoot;
      const supervisor = new DurableRunSupervisorClient(process.env);
      const attachment = await supervisor.attach({ repo: prepared.repo, active: prepared.active, rawSessionId: 'e2e-parent-session' });
      process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = attachment.contextPath;
      const unitWorktree = await prepareAutopilotUnitWorktree({
        active: prepared.active,
        unitId: 'e01-implement',
        attempt: 1,
      });
      const unitSpec = makeSpec(unitWorktree.unitInfo.worktree_path, runtimeRoot);
      const specPath = join(runtimeRoot, 'unit-specs', 'e01-implement.implement.attempt-1.json');
      await mkdir(join(runtimeRoot, 'unit-specs'), { recursive: true });
      await writeFile(specPath, `${JSON.stringify(unitSpec, null, 2)}\n`, 'utf8');
      const fakePi = await writeFakePi(root);

      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: process.env,
        timeoutMsOverride: 5_000,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.verdict, 'DONE');
      assert.equal(typeof result.auditOutput, 'string');

      const statusRef = 'statuses/e01-implement.implement.attempt-1.json';
      const receiptRef = 'receipts/e01-implement.implement.attempt-1.receipt.json';
      const specRef = 'unit-specs/e01-implement.implement.attempt-1.json';
      const state: AutopilotState = {
        schema_version: 'autopilot.state.v1',
        workstream: unitSpec.workstream,
        updated_at: '2026-06-29T00:00:00.000Z',
        status: 'completed',
        context_gate: { gate: 'ok', percent: 10 },
        last_event_id: 1,
        ready_queue: [],
        running: [],
        blocked: [],
        completed: [unitSpec.unit_id],
        units: {
          [unitSpec.unit_id]: {
            unit_id: unitSpec.unit_id,
            role: unitSpec.role,
            state: 'completed',
            attempt: unitSpec.attempt,
            spec_ref: specRef,
            status_ref: statusRef,
            receipt_ref: receiptRef,
            summary: result.summary,
          },
        },
        operator_questions: [],
        next_actions: ['done'],
      };
      await writeAutopilotStateAtomic({ statePath: join(runtimeRoot, 'state.json'), state, artifactRoot: runtimeRoot });
      const event: AutopilotEventRow = {
        schema_version: 'autopilot.event.v1',
        id: 1,
        ts: '2026-06-29T00:00:00.000Z',
        event: 'agent_completed',
        workstream: unitSpec.workstream,
        unit_id: unitSpec.unit_id,
        role: unitSpec.role,
        verdict: 'DONE',
        severity: 'clean',
        spec_ref: specRef,
        status_ref: statusRef,
        receipt_ref: receiptRef,
        summary: result.summary,
      };
      await appendAutopilotEventRow({ eventsPath: join(runtimeRoot, 'events.jsonl'), event });

      const snapshot = await readAutopilotResumeSnapshot({ root: runtimeRoot, eventTailLimit: 5 });
      assert.equal(snapshot.state.status, 'completed');
      assert.equal(snapshot.eventsTail.length, 1);
      assert.equal(snapshot.statuses[statusRef]?.summary, 'Fake e2e Autopilot status completed.');
      const receiptText = await readFile(unitSpec.receipt_output, 'utf8');
      assert.match(receiptText, /autopilot_emit_status/u);
    });
  });
});

async function initGitSource(source: string): Promise<void> {
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, '.gitignore'), '.pi/\n', 'utf8');
  await writeFile(join(source, 'src', 'e2e.ts'), 'export const e2e = "baseline";\n', 'utf8');
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

const FAKE_PI_SOURCE = `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const contextPath = process.env.AUTOPILOT_AGENT_STATUS_CONTEXT;
if (process.env.AUTOPILOT_COORDINATOR_SESSION_CONTEXT !== undefined) throw new Error('parent session authority leaked into child Pi');
function write(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function response(cmd, success = true, extra = {}) { write({ id: cmd.id, type: 'response', command: cmd.type, success, ...extra }); }
function loadContext() {
  if (!contextPath) throw new Error('missing context path');
  return JSON.parse(readFileSync(contextPath, 'utf8'));
}
function emitForcedStatus() {
  const context = loadContext();
  const unit = context.unit_spec;
  const changedPath = join(unit.cwd, ...String(unit.owned_paths[0]).split('/'));
  mkdirSync(dirname(changedPath), { recursive: true });
  writeFileSync(changedPath, 'export const e2e = "fake implementation";\\n', 'utf8');
  const status = {
    schema_version: 'autopilot.status.v1', workstream: unit.workstream, unit_id: unit.unit_id,
    role: unit.role, attempt: unit.attempt, verdict: 'DONE', severity: 'clean', summary: 'Fake e2e Autopilot status completed.',
    changed_paths: [unit.owned_paths[0]], findings: [], commands: [], evidence_refs: [], report_ref: null, next_action: 'resume state'
  };
  mkdirSync(dirname(context.status_output), { recursive: true });
  mkdirSync(dirname(context.receipt_output), { recursive: true });
  const statusBytes = JSON.stringify(status, null, 2) + '\\n';
  writeFileSync(context.status_output, statusBytes, 'utf8');
  const statusSha256 = 'sha256:' + createHash('sha256').update(statusBytes, 'utf8').digest('hex');
  const receipt = {
    schema_version: 'autopilot.receipt.v1', tool_name: 'autopilot_emit_status', workstream: unit.workstream,
    unit_id: unit.unit_id, role: unit.role, attempt: unit.attempt, emitted_at: '2026-06-29T00:00:00.000Z',
    status_output: context.status_output, status_sha256: statusSha256, schema_sha256: context.schema_sha256,
    tool_call_id: 'call-autopilot-e2e-1', provider_identity: context.provider_identity,
    expected_identity_hash: context.expected_identity_hash
  };
  writeFileSync(context.receipt_output, JSON.stringify(receipt, null, 2) + '\\n', 'utf8');
  write({ type: 'tool_result', toolName: 'autopilot_emit_status', toolCallId: 'call-autopilot-e2e-1', isError: false, details: {
    tool_name: 'autopilot_emit_status', tool_call_id: 'call-autopilot-e2e-1', terminating: true,
    status_sha256: statusSha256
  }});
}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === 'get_state') { response(cmd, true, { data: { model: { id: 'gpt-5.6-terra', provider: 'openai-codex', api: 'openai-codex-responses' }, thinkingLevel: 'high' } }); return; }
  if (cmd.type === 'get_session_stats') { response(cmd, true, { data: { sessionId: 'autopilot-e2e' } }); return; }
  if (cmd.type === 'prompt') {
    if (typeof cmd.message !== 'string' || Object.prototype.hasOwnProperty.call(cmd, 'prompt')) {
      response(cmd, false, { error: 'prompt RPC command must use message field only' });
      return;
    }
    response(cmd);
    write({ type: 'agent_start' });
    write({ type: 'turn_start' });
    emitForcedStatus();
    const msg = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-5.6-terra', stopReason: 'stop' };
    write({ type: 'message_end', message: msg });
    write({ type: 'turn_end', message: msg, toolResults: [] });
    write({ type: 'agent_end', messages: [msg] });
    return;
  }
  response(cmd, false, { error: 'unsupported' });
});
`;
