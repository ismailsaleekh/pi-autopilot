import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { runAutopilotAgentFromSpecPath } from '../../src/core/agent-runner.ts';
import { AUTOPILOT_STATE_ROOT_ENV, prepareAutopilotWorkstream } from '../../src/core/parallel-runtime.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { DurableRunSupervisorClient } from '../../src/core/coordination/supervisor.ts';
import { renderAutopilotAgentPrompt } from '../../src/core/prompt-renderer/index.ts';
import { parseAutopilotChildTerminalAcceptance } from '../../src/core/coordination/terminal-acceptance.ts';
import type { AutopilotUnitSpec } from '../../src/core/contracts/types.ts';

// D65-I2 end-to-end: the shared-role terminal chain must carry an `extract`
// unit all the way from spec → rendered prompt → coordinator child registration
// → forced status/receipt → execution audit → immutable terminal acceptance,
// with the SAME registry gate proven in both the source and dist builds. A
// fake Pi child emits a real forced `extract` DONE status; the runner produces
// the terminal acceptance artifact only if `extract` is admissible terminal
// evidence (the private terminal-role list is removed).

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-extract-e2e-'));
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

function extractSpec(mainWorktree: string, runtimeRoot: string): AutopilotUnitSpec {
  return {
    schema_version: 'autopilot.unit_spec.v1',
    workstream: 'autopilot-extract-e2e',
    unit_id: 'x01-extract',
    role: 'extract',
    template: 'extract',
    attempt: 1,
    objective: 'Extract a compact operator transfer packet from referenced artifacts.',
    // A non-source extract unit reads under the durable main worktree; it never
    // gets a source-changing unit worktree.
    cwd: mainWorktree,
    model: 'openai-codex/gpt-5.6-luna',
    thinking: 'high',
    owned_paths: [],
    read_only_paths: [],
    untouchable_paths: ['private/**'],
    context_refs: [
      { path: '.pi/autopilot/autopilot-extract-e2e/mission.md', purpose: 'Durable mission truth' },
      { path: '.pi/autopilot/autopilot-extract-e2e/master-plan.json', purpose: 'Durable master plan truth' },
    ],
    validation_commands: [],
    status_output: join(runtimeRoot, 'statuses', 'x01-extract.extract.attempt-1.json'),
    receipt_output: join(runtimeRoot, 'receipts', 'x01-extract.extract.attempt-1.receipt.json'),
    evidence_dir: join(runtimeRoot, 'evidence', 'x01-extract'),
    stop_boundary: 'Read only; produce an operator transfer packet.',
    quality_profile: 'extract',
    risk_level: 'low',
    acceptance_criteria: ['extract packet completes'],
    verification_plan: {
      positive_witnesses: [],
      negative_witnesses: [],
      regression_witnesses: [],
      real_boundary_witnesses: [],
      blast_radius_checks: [],
      docs_schema_prompt_checks: [],
      dirty_tree_checks: [],
    },
    closure_criteria: ['extract packet delivered'],
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

void describe('D65-I2 extract terminal chain e2e', () => {
  void it('renders the extract prompt and carries extract role through the whole terminal chain', async () => {
    await withTempDir(async (root) => {
      const source = join(root, 'source');
      await initGitSource(source);
      const prepared = await prepareAutopilotWorkstream({ workstream: 'autopilot-extract-e2e', sourceCwd: source });
      const runtimeRoot = prepared.runtimeRoot;
      const mainWorktree = prepared.active.main_worktree_path;
      const supervisor = new DurableRunSupervisorClient(process.env);
      const attachment = await supervisor.attach({ repo: prepared.repo, active: prepared.active, rawSessionId: 'e2e-extract-parent-session' });
      process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = attachment.contextPath;

      const unitSpec = extractSpec(mainWorktree, runtimeRoot);

      // Spec → rendered prompt: the extract template renders with the extract
      // role and its read/coordinator changed_paths-empty mandate.
      const prompt = renderAutopilotAgentPrompt(unitSpec);
      assert.match(prompt, /role: `extract`/u);
      assert.match(prompt, /operator packet or transfer summary/u);
      assert.match(prompt, /changed_paths must be an empty array for this read\/coordinator role/u);

      const specPath = join(runtimeRoot, 'unit-specs', 'x01-extract.extract.attempt-1.json');
      await mkdir(dirname(specPath), { recursive: true });
      await writeFile(specPath, `${JSON.stringify(unitSpec, null, 2)}\n`, 'utf8');
      const fakePi = await writeFakePi(root);

      const result = await runAutopilotAgentFromSpecPath(specPath, {
        piExecutable: fakePi,
        env: process.env,
        timeoutMsOverride: 5_000,
      });

      // Status/receipt/audit: the forced extract status is accepted as DONE.
      assert.equal(result.status, 'success');
      assert.equal(result.statusEntry?.role, 'extract');
      assert.equal(result.statusEntry?.verdict, 'DONE');
      assert.equal(result.statusEntry?.changed_paths.length, 0);
      assert.equal(typeof result.auditOutput, 'string');

      // Rendered prompt snapshot exists and is the extract template.
      assert.notEqual(result.promptSnapshotPath, null);
      const snapshot = await readFile(result.promptSnapshotPath as string, 'utf8');
      assert.match(snapshot, /Autopilot extract\/operator-packet unit/u);

      // Terminal acceptance: the immutable child-terminal acceptance artifact is
      // created for the extract role (proving the shared registry admits it).
      const acceptanceDir = join(runtimeRoot, 'terminal-acceptances');
      const acceptanceFiles = await readdir(acceptanceDir);
      const extractAcceptance = acceptanceFiles.find((name) => name.startsWith('x01-extract.extract.'));
      assert.notEqual(extractAcceptance, undefined, 'extract terminal acceptance artifact must exist');
      const acceptanceBytes = await readFile(join(acceptanceDir, extractAcceptance as string));
      const acceptance = parseAutopilotChildTerminalAcceptance(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(acceptanceBytes)) as unknown);
      assert.equal(acceptance.role, 'extract');
      assert.equal(acceptance.verdict, 'DONE');
      assert.equal(acceptance.transport_result, 'accepted');
      assert.equal(acceptance.audit_disposition, 'zero-change');
      assert.equal(acceptance.unit_id, 'x01-extract');

      // Receipt is bound to the exact forced-output carrier.
      const receiptText = await readFile(unitSpec.receipt_output, 'utf8');
      assert.match(receiptText, /autopilot_emit_status/u);
      assert.match(receiptText, /"role": "extract"/u);
    });
  });

  void it('unifies the terminal-role gate byte-for-byte across source and dist builds', async () => {
    const srcPath = join(packageRoot, 'src', 'core', 'coordination', 'terminal-acceptance.ts');
    const distPath = join(packageRoot, 'dist', 'src', 'core', 'coordination', 'terminal-acceptance.js');
    const srcText = await readFile(srcPath, 'utf8');
    // Source consumes the shared registry, not a private terminal-role list.
    assert.match(srcText, /AUTOPILOT_ROLE_VALUES\.includes\(role\)/u);
    assert.equal(/\['implement', 'validate', 'fix', 'bughunt', 'strategy', 'adjudicate'\]/u.test(srcText), false, 'the private terminal-role allow-list must be removed');
    assert.equal(existsSync(distPath), true, 'dist build must exist for source/dist parity');
    const distText = await readFile(distPath, 'utf8');
    assert.match(distText, /AUTOPILOT_ROLE_VALUES\.includes\(role\)/u);
    assert.equal(/\['implement', 'validate', 'fix', 'bughunt', 'strategy', 'adjudicate'\]/u.test(distText), false, 'dist must not retain the private terminal-role allow-list');
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
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
  const status = {
    schema_version: 'autopilot.status.v1', workstream: unit.workstream, unit_id: unit.unit_id,
    role: unit.role, attempt: unit.attempt, verdict: 'DONE', severity: 'clean',
    summary: 'Fake extract operator packet completed.',
    changed_paths: [], findings: [], commands: [], evidence_refs: [], report_ref: null, next_action: 'resume state'
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
    tool_call_id: 'call-autopilot-extract-e2e-1', provider_identity: context.provider_identity,
    expected_identity_hash: context.expected_identity_hash
  };
  writeFileSync(context.receipt_output, JSON.stringify(receipt, null, 2) + '\\n', 'utf8');
  write({ type: 'tool_result', toolName: 'autopilot_emit_status', toolCallId: 'call-autopilot-extract-e2e-1', isError: false, details: {
    tool_name: 'autopilot_emit_status', tool_call_id: 'call-autopilot-extract-e2e-1', terminating: true,
    status_sha256: statusSha256
  }});
}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === 'get_state') { response(cmd, true, { data: { model: { id: 'gpt-5.6-luna', provider: 'openai-codex', api: 'openai-codex-responses' }, thinkingLevel: 'high' } }); return; }
  if (cmd.type === 'get_session_stats') { response(cmd, true, { data: { sessionId: 'autopilot-extract-e2e' } }); return; }
  if (cmd.type === 'prompt') {
    if (typeof cmd.message !== 'string' || Object.prototype.hasOwnProperty.call(cmd, 'prompt')) {
      response(cmd, false, { error: 'prompt RPC command must use message field only' });
      return;
    }
    response(cmd);
    write({ type: 'agent_start' });
    write({ type: 'turn_start' });
    emitForcedStatus();
    const msg = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-5.6-luna', stopReason: 'stop' };
    write({ type: 'message_end', message: msg });
    write({ type: 'turn_end', message: msg, toolResults: [] });
    write({ type: 'agent_end', messages: [msg] });
    return;
  }
  response(cmd, false, { error: 'unsupported' });
});
`;
