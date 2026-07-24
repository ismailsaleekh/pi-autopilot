// Shared agent-runner test harness (Phase 40 / D70 change C4).
//
// Extracted VERBATIM from tests/unit/agent-runner.test.ts so the 25 wrapper
// tests can be sharded across sibling files without changing a single
// assertion or subprocess behaviour. Every helper here is a PURE function or an
// immutable constant — there is NO module-level mutable state — so importing it
// from multiple concurrent test files is race-free (node:test still runs one
// process per file). The fake-Pi source, spec builder, coordinator/worktree
// bootstrap, and CLI runner are byte-identical to the pre-split originals.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AutopilotUnitSpec, AutopilotVerificationPlan } from '../../src/core/contracts/index.ts';
import { AUTOPILOT_STATE_ROOT_ENV, prepareAutopilotUnitWorktree, prepareAutopilotWorkstream } from '../../src/core/parallel-runtime.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { DurableRunSupervisorClient } from '../../src/core/coordination/supervisor.ts';
import { autopilotModelAssignmentForRole } from '../../src/core/model-roster.ts';

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(TEST_DIR, '..', '..');
export const AUTOPILOT_AGENT_RUN_CLI = resolve(PACKAGE_ROOT, 'src', 'cli', 'autopilot-agent-run.ts');
export const FAKE_PI_COMPLETION_TIMEOUT_MS = 10_000;

export async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
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

export function verificationPlan(command = 'npm test -- --runInBand'): AutopilotVerificationPlan {
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

export function spec(root: string, overrides: Partial<AutopilotUnitSpec> = {}): AutopilotUnitSpec {
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

export async function writeSpec(root: string, unitSpec: AutopilotUnitSpec): Promise<string> {
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
  const specBytes = `${JSON.stringify(unitSpec, null, 2)}\n`;
  await writeFile(specPath, specBytes, 'utf8');
  await writeFile(`${specPath}.grandfather-authority.json`, `${JSON.stringify({
    schema_version: 'autopilot.v1_grandfather_authority.v1',
    authority: 'grandfathered-existing-v1',
    unit_spec_sha256: sha256Utf8(specBytes),
    historical_bytes_mutated: false,
    reason: 'agent-runner regression fixture preserves exact historical v1 bytes',
  }, null, 2)}\n`, 'utf8');
  return specPath;
}

export async function prepareRegisteredWorktree(root: string, unitSpec: AutopilotUnitSpec): Promise<{
  readonly repo: Awaited<ReturnType<typeof prepareAutopilotWorkstream>>['repo'];
  readonly active: Awaited<ReturnType<typeof prepareAutopilotWorkstream>>['active'];
  readonly mainWorktreePath: string;
  readonly runtimeRoot: string;
}> {
  const source = join(root, 'source');
  if (!existsGitRepo(source)) await initGitSource(source, unitSpec.owned_paths);
  return await prepareAutopilotWorkstream({ workstream: unitSpec.workstream, sourceCwd: source, coordinationSessionId: `runner-bootstrap-${unitSpec.unit_id}-${String(unitSpec.attempt)}` });
}

export function existsGitRepo(path: string): boolean {
  return spawnSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).status === 0;
}

export async function initGitSource(source: string, ownedPaths: readonly string[]): Promise<void> {
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

export async function writeFakePi(root: string): Promise<string> {
  const fakePath = join(root, 'fake-pi.mjs');
  await writeFile(fakePath, FAKE_PI_SOURCE, 'utf8');
  const chmodResult = spawnSync('chmod', ['755', fakePath], { encoding: 'utf8' });
  assert.equal(chmodResult.status, 0, chmodResult.stderr);
  return fakePath;
}

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export async function expectRejects(
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sha256Utf8(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function git(root: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

export async function initGitWorktree(worktree: string): Promise<void> {
  await mkdir(join(worktree, 'src'), { recursive: true });
  await writeFile(join(worktree, 'src', 'smoke.ts'), 'export const smoke = 1;\n', 'utf8');
  await writeFile(join(worktree, '.gitignore'), '.pi/\n', 'utf8');
  git(worktree, ['init']);
  git(worktree, ['config', 'user.email', 'autopilot@example.invalid']);
  git(worktree, ['config', 'user.name', 'Autopilot Test']);
  git(worktree, ['add', '.']);
  git(worktree, ['commit', '-m', 'baseline']);
}

export function runCli(args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', AUTOPILOT_AGENT_RUN_CLI, ...args], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --disable-warning=ExperimentalWarning`.trim() },
    encoding: 'utf8',
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}


export interface FakeReceipt {
  readonly tool_call_id: string;
}

export const FAKE_PI_SOURCE = `#!/usr/bin/env node
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
