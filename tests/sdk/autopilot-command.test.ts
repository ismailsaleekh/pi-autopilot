import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import autopilotExtension, {
  type ExtensionCommandDefinitionLike,
  type ExtensionCommandContextLike,
  type ExtensionHostLike,
  type ExtensionLifecycleHandler,
  type ExtensionModelLike,
  type ExtensionToolCallHandler,
  type NotificationKind,
} from '../../src/extension.ts';
import {
  AUTOPILOT_ABORT_COMMAND,
  AUTOPILOT_CLAIM_GC_COMMAND,
  AUTOPILOT_CLOSE_COMMAND,
  AUTOPILOT_COMMAND,
  AUTOPILOT_CONFIG_COMMAND,
  AUTOPILOT_COORDINATION_COMMAND,
  AUTOPILOT_HANDOFF_COMMAND,
  AUTOPILOT_INJECT_COMMAND,
  AUTOPILOT_ONBOARD_COMMAND,
  AUTOPILOT_STATUS_TOOL,
  AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME,
  CONTEXT_BUDGET_TOOL_NAME,
} from '../../src/core/names.ts';
import { AUTOPILOT_STATE_ROOT_ENV, coordinationRootForRepo, resolveRepoIdentity } from '../../src/core/parallel-runtime.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { startTaggedCoordinator, type TaggedCoordinatorProcess } from '../helpers/tagged-coordinator.ts';

interface CapturedMessage {
  readonly content: string;
  readonly deliverAs: 'followUp';
}

interface CapturedNotification {
  readonly message: string;
  readonly kind: NotificationKind | undefined;
}

interface Harness {
  readonly commands: Map<string, ExtensionCommandDefinitionLike>;
  readonly toolNames: string[];
  readonly activeTools: string[];
  readonly messages: CapturedMessage[];
  readonly notifications: CapturedNotification[];
  readonly toolCallHandlers: ExtensionToolCallHandler[];
  readonly shutdownHandlers: ExtensionLifecycleHandler[];
  readonly selectedModels: ExtensionModelLike[];
  readonly thinkingLevels: string[];
  readonly ctx: ExtensionCommandContextLike;
}

function createHarness(
  cwd?: string,
  options: { readonly modelAvailable?: boolean; readonly authenticationAvailable?: boolean } = {},
): Harness {
  const commands = new Map<string, ExtensionCommandDefinitionLike>();
  const toolNames: string[] = [];
  const activeTools: string[] = [];
  const messages: CapturedMessage[] = [];
  const notifications: CapturedNotification[] = [];
  const toolCallHandlers: ExtensionToolCallHandler[] = [];
  const shutdownHandlers: ExtensionLifecycleHandler[] = [];
  const selectedModels: ExtensionModelLike[] = [];
  const thinkingLevels: string[] = [];
  let thinkingLevel = 'high';
  const host: ExtensionHostLike = {
    registerCommand: (name, definition) => {
      commands.set(name, definition);
    },
    registerTool: (tool) => {
      toolNames.push(tool.name);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools.splice(0, activeTools.length, ...names);
    },
    setModel: (model) => {
      selectedModels.push(model);
      return Promise.resolve(options.authenticationAvailable !== false);
    },
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level) => {
      thinkingLevel = level;
      thinkingLevels.push(level);
    },
    sendUserMessage: (content, options) => {
      messages.push({ content, deliverAs: options.deliverAs });
    },
    sendMessage: () => undefined,
    on: (eventName, handler) => {
      if (eventName === 'tool_call') toolCallHandlers.push(handler as ExtensionToolCallHandler);
      else if (eventName === 'session_shutdown') shutdownHandlers.push(handler as ExtensionLifecycleHandler);
    },
  };
  const ctx: ExtensionCommandContextLike = {
    ui: {
      notify: (message, kind) => {
        notifications.push({ message, kind });
      },
    },
    modelRegistry: {
      find: (provider, modelId) =>
        options.modelAvailable === false ? undefined : { provider, id: modelId },
    },
    sessionManager: { getSessionId: () => 'sdk-command-session' },
    isIdle: () => true,
    ...(cwd === undefined ? {} : { cwd }),
  };
  autopilotExtension(host);
  return { commands, toolNames, activeTools, messages, notifications, toolCallHandlers, shutdownHandlers, selectedModels, thinkingLevels, ctx };
}

function requireCommand(harness: Harness, name: string): ExtensionCommandDefinitionLike {
  const command = harness.commands.get(name);
  if (command === undefined) throw new Error(`missing command ${name}`);
  return command;
}

function publicCommands(harness: Harness): string[] {
  return [...harness.commands.keys()].sort();
}

async function withIsolatedHarness<T>(run: (harness: Harness) => Promise<T>, coordinatorBuild: 'current' | 'v1.0.1' = 'current'): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-command-'));
  const project = join(root, 'project');
  const originalStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
  process.env[AUTOPILOT_STATE_ROOT_ENV] = join(root, 'state');
  let coordinator: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
  let taggedCoordinator: TaggedCoordinatorProcess | null = null;
  let harness: Harness | null = null;
  try {
    await initGitProject(project);
    if (coordinatorBuild === 'current') coordinator = await startCoordinatorServer(coordinatorRuntimePaths(process.env));
    else taggedCoordinator = await startTaggedCoordinator({ stateRoot: process.env[AUTOPILOT_STATE_ROOT_ENV] ?? join(root, 'state'), extractionRoot: root });
    harness = createHarness(project);
    return await run(harness);
  } finally {
    if (harness !== null) {
      for (const handler of harness.shutdownHandlers) await handler({ reason: 'test-complete' }, harness.ctx);
    }
    if (coordinator !== null) await coordinator.close();
    if (taggedCoordinator !== null) await taggedCoordinator.close();
    if (originalStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
    else process.env[AUTOPILOT_STATE_ROOT_ENV] = originalStateRoot;
    await rm(root, { recursive: true, force: true });
  }
}

async function initGitProject(project: string): Promise<void> {
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# test project\n', 'utf8');
  git(project, ['init']);
  git(project, ['config', 'user.email', 'autopilot@example.invalid']);
  git(project, ['config', 'user.name', 'Autopilot Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-m', 'baseline']);
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

void describe('Autopilot command SDK surface', () => {
  void it('BUG-174 queues the hardened parent prompt and activates authenticated parent tools only for /autopilot', async () => {
    await withIsolatedHarness(async (harness) => {
      await requireCommand(harness, AUTOPILOT_COMMAND).handler('demo operator scope', harness.ctx);
      assert.deepEqual(publicCommands(harness), [
        AUTOPILOT_COMMAND,
        AUTOPILOT_ABORT_COMMAND,
        AUTOPILOT_CLAIM_GC_COMMAND,
        AUTOPILOT_CLOSE_COMMAND,
        AUTOPILOT_CONFIG_COMMAND,
        AUTOPILOT_COORDINATION_COMMAND,
        AUTOPILOT_HANDOFF_COMMAND,
        AUTOPILOT_INJECT_COMMAND,
        AUTOPILOT_ONBOARD_COMMAND,
      ]);
      assert.deepEqual(harness.toolNames, [CONTEXT_BUDGET_TOOL_NAME, AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME]);
      assert.deepEqual(harness.activeTools, [CONTEXT_BUDGET_TOOL_NAME, AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME]);
      assert.deepEqual(harness.selectedModels, [{ provider: 'openai-codex', id: 'gpt-5.6-sol' }]);
      assert.deepEqual(harness.thinkingLevels, ['xhigh']);
      assert.equal(harness.messages.length, 1);
      const message = harness.messages[0];
      if (message === undefined) throw new Error('missing parent prompt');
      assert.equal(message.deliverAs, 'followUp');
      assert.match(message.content, /call `context_budget` with no arguments/);
      assert.match(message.content, /autopilot_respond_claim_request/);
      assert.match(message.content, /parent\/orchestrator: openai-codex\/gpt-5\.6-sol at xhigh/);
      assert.match(message.content, /implement: openai-codex\/gpt-5\.6-terra at high/);
      assert.match(message.content, /validate: openai-codex\/gpt-5\.6-sol at xhigh/);
      assert.match(message.content, /extract: openai-codex\/gpt-5\.6-luna at high/);
      assert.match(message.content, /Runtime root: `.*\.pi\/autopilot\/demo`/);
      assert.match(message.content, /Registered Autopilot worktree/);
      assert.match(message.content, /autopilot\.execution_commit\.v1/);
      assert.match(message.content, /only through the exact injected invocation/);
      assert.match(message.content, /validated status and receipt pair/);
      assert.equal(message.content.includes(AUTOPILOT_STATUS_TOOL), false);
      const sourceCwdForPreflight = harness.ctx.cwd;
      if (sourceCwdForPreflight === undefined) throw new Error('missing source cwd for coordination preflight');
      const repo = resolveRepoIdentity(sourceCwdForPreflight);
      const preflightFiles = await readdir(join(coordinationRootForRepo(repo.repoKey), 'preflight'), { withFileTypes: true });
      assert.equal(preflightFiles.some((file) => file.name.includes('.activation.') && file.name.endsWith('.json')), true);
      assert.equal(harness.toolCallHandlers.length, 1);
      const handler = harness.toolCallHandlers[0];
      if (handler === undefined) throw new Error('missing worktree guard handler');
      const sourceCwd = harness.ctx.cwd;
      if (sourceCwd === undefined) throw new Error('missing source cwd');
      const blocked = await handler({ toolName: 'bash', input: { command: 'git status' } }, { cwd: sourceCwd });
      assert.equal(blocked?.block, true);
      const match = /Registered Autopilot worktree: `([^`]+)`/u.exec(message.content);
      const worktreePath = match?.[1];
      if (worktreePath === undefined) throw new Error('missing worktree path in prompt');
      const allowed = await handler({ toolName: 'bash', input: { command: 'git status' } }, { cwd: worktreePath });
      assert.equal(allowed, undefined);
      const runtimeMatch = /Runtime root: `([^`]+)`/u.exec(message.content);
      const runtimeRoot = runtimeMatch?.[1];
      if (runtimeRoot === undefined) throw new Error('missing runtime root in prompt');
      const unitSpecWrite = await handler(
        { toolName: 'write', input: { path: `${runtimeRoot}/unit-specs/demo.json` } },
        { cwd: worktreePath },
      );
      assert.equal(unitSpecWrite, undefined);
    });
  });

  void it('queries coordinator status and doctor without queueing an LLM turn', async () => {
    await withIsolatedHarness(async (harness) => {
      await requireCommand(harness, AUTOPILOT_COMMAND).handler('coordination-observability', harness.ctx);
      const messageCount = harness.messages.length;
      await requireCommand(harness, AUTOPILOT_COORDINATION_COMMAND).handler('status', harness.ctx);
      await requireCommand(harness, AUTOPILOT_COORDINATION_COMMAND).handler('doctor', harness.ctx);
      assert.equal(harness.messages.length, messageCount);
      assert.equal(harness.notifications.some((entry) => /coordinator status:.*runs=1 sessions=2/u.test(entry.message)), true);
      assert.equal(harness.notifications.some((entry) => /coordinator doctor:.*healthy=true/u.test(entry.message)), true);
      const sourceCwd = harness.ctx.cwd;
      if (sourceCwd === undefined) throw new Error('missing source cwd');
      const repo = resolveRepoIdentity(sourceCwd);
      const runsStatus = await new CoordinatorClient({ env: process.env, autoStart: false }).query('status', repo.repoKey, null);
      const runs = runsStatus.payload['runs'];
      if (!Array.isArray(runs) || runs.length !== 1 || typeof runs[0] !== 'object' || runs[0] === null || Array.isArray(runs[0])) throw new Error('missing durable run');
      const workstreamRun = (runs[0] as Readonly<Record<string, unknown>>)['workstream_run'];
      if (typeof workstreamRun !== 'string') throw new Error('missing workstream run');
      const exactStatus = await new CoordinatorClient({ env: process.env, autoStart: false }).query('status', repo.repoKey, workstreamRun);
      const operations = exactStatus.payload['worktree_operations'];
      if (!Array.isArray(operations)) throw new Error('missing worktree operations');
      const mainCreate = operations.find((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry) && (entry as Readonly<Record<string, unknown>>)['operation_type'] === 'create' && (entry as Readonly<Record<string, unknown>>)['stage'] === 'committed');
      if (typeof mainCreate !== 'object' || mainCreate === null || Array.isArray(mainCreate)) throw new Error('missing committed main create operation');
      const evidence = (mainCreate as Readonly<Record<string, unknown>>)['verification_evidence'];
      if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) throw new Error('missing main create evidence');
      const evidenceRef = (evidence as Readonly<Record<string, unknown>>)['ref'];
      if (typeof evidenceRef !== 'string') throw new Error('missing main create evidence ref');
      const stateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
      if (stateRoot === undefined) throw new Error('missing state root');
      const evidenceDocument: unknown = JSON.parse(await readFile(join(stateRoot, 'worktrees', repo.repoKey, ...evidenceRef.split('/')), 'utf8')) as unknown;
      if (typeof evidenceDocument !== 'object' || evidenceDocument === null || Array.isArray(evidenceDocument)) throw new Error('main create evidence document is malformed');
      const proof = (evidenceDocument as Readonly<Record<string, unknown>>)['proof'];
      if (!Array.isArray(proof) || !proof.every((entry) => typeof entry === 'string')) throw new Error('main create evidence proof is malformed');
      assert.equal(proof.includes('metadata_complete'), true);
    });
  });

  void it('fails loudly before worktree preparation when the fixed parent model is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-roster-command-'));
    const project = join(root, 'project');
    try {
      await initGitProject(project);
      const missingModel = createHarness(project, { modelAvailable: false });
      await requireCommand(missingModel, AUTOPILOT_COMMAND).handler('demo', missingModel.ctx);
      assert.equal(missingModel.messages.length, 0);
      assert.equal(missingModel.notifications.some((entry) => /gpt-5\.6-sol is not registered/u.test(entry.message)), true);

      const missingAuth = createHarness(project, { authenticationAvailable: false });
      await requireCommand(missingAuth, AUTOPILOT_COMMAND).handler('demo', missingAuth.ctx);
      assert.equal(missingAuth.messages.length, 0);
      assert.equal(missingAuth.notifications.some((entry) => /no usable subscription authentication/u.test(entry.message)), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('injects an active workstream without queueing the parent prompt and enables handoff', async () => {
    await withIsolatedHarness(async (harness) => {
      await requireCommand(harness, AUTOPILOT_INJECT_COMMAND).handler('demo', harness.ctx);
      assert.deepEqual(harness.toolNames, [CONTEXT_BUDGET_TOOL_NAME, AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME]);
      assert.deepEqual(harness.activeTools, [CONTEXT_BUDGET_TOOL_NAME, AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME]);
      assert.deepEqual(harness.selectedModels, [{ provider: 'openai-codex', id: 'gpt-5.6-sol' }]);
      assert.deepEqual(harness.thinkingLevels, ['xhigh']);
      assert.equal(harness.messages.length, 0);
      assert.equal(harness.notifications.some((entry) => /Autopilot injected for demo/.test(entry.message)), true);

      await requireCommand(harness, AUTOPILOT_HANDOFF_COMMAND).handler('handoff after injected session', harness.ctx);
      assert.equal(harness.messages.length, 1);
      const message = harness.messages[0];
      if (message === undefined) throw new Error('missing handoff prompt after inject');
      assert.match(message.content, /current Autopilot parent for workstream `demo`/);
      assert.match(message.content, /handoff after injected session/);
      assert.match(message.content, /Active workstream run:/);
    });
  });

  void it('rejects the actual protocol-1.3 v1.0.1 coordinator without replacing its process', async () => {
    await withIsolatedHarness(async (harness) => {
      const stateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
      if (stateRoot === undefined) throw new Error('mixed-build SDK harness has no state root');
      const paths = coordinatorRuntimePaths(process.env);
      const before: unknown = JSON.parse(await readFile(paths.lockPath, 'utf8')) as unknown;
      if (typeof before !== 'object' || before === null || Array.isArray(before)) throw new Error('mixed-build lifecycle lock is invalid');

      await requireCommand(harness, AUTOPILOT_INJECT_COMMAND).handler('mixed-build-resume', harness.ctx);

      const after: unknown = JSON.parse(await readFile(paths.lockPath, 'utf8')) as unknown;
      assert.deepEqual(after, before, 'inject must not replace an incompatible live historical coordinator');
      assert.equal(harness.notifications.some((entry) => /Autopilot injected for mixed-build-resume/u.test(entry.message)), false);
      assert.equal(harness.notifications.some((entry) => /protocol|schema|incompatible/u.test(entry.message)), true);
      assert.deepEqual(harness.activeTools, [CONTEXT_BUDGET_TOOL_NAME]);
    }, 'v1.0.1');
  });

  void it('queues an onboard brief without registering tools or launch authority', async () => {
    const harness = createHarness();
    await requireCommand(harness, AUTOPILOT_ONBOARD_COMMAND).handler('demo handoff refs', harness.ctx);
    assert.deepEqual(harness.toolNames, []);
    assert.deepEqual(harness.activeTools, []);
    assert.equal(harness.messages.length, 1);
    const message = harness.messages[0];
    if (message === undefined) throw new Error('missing onboard prompt');
    assert.match(message.content, /onboard-brief generator/);
    assert.match(message.content, /Do not start child agents/);
    assert.match(message.content, /Do not create, edit, move, delete/);
    assert.match(message.content, /validated status\+receipt evidence/);
    assert.equal(message.content.includes(AUTOPILOT_STATUS_TOOL), false);
  });

  void it('rejects handoff before /autopilot establishes the active workstream', async () => {
    const harness = createHarness();
    await requireCommand(harness, AUTOPILOT_HANDOFF_COMMAND).handler('operator note', harness.ctx);
    assert.deepEqual(harness.toolNames, []);
    assert.deepEqual(harness.activeTools, []);
    assert.equal(harness.messages.length, 0);
    assert.equal(harness.notifications.some((entry) => /No active Autopilot workstream/.test(entry.message)), true);
  });

  void it('queues handoff for the active workstream and treats args as comments', async () => {
    await withIsolatedHarness(async (harness) => {
      await requireCommand(harness, AUTOPILOT_COMMAND).handler('demo initial scope', harness.ctx);
      await requireCommand(harness, AUTOPILOT_HANDOFF_COMMAND).handler('demo is a comment, not a slug', harness.ctx);
      assert.deepEqual(harness.toolNames, [CONTEXT_BUDGET_TOOL_NAME, AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME]);
      assert.deepEqual(harness.activeTools, [CONTEXT_BUDGET_TOOL_NAME, AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME]);
      assert.equal(harness.messages.length, 2);
      const message = harness.messages[1];
      if (message === undefined) throw new Error('missing handoff prompt');
      assert.match(message.content, /current Autopilot parent for workstream `demo`/);
      assert.match(message.content, /demo is a comment, not a slug/);
      assert.match(message.content, /Active workstream run:/);
      assert.match(message.content, /first line is exactly/);
      assert.match(message.content, new RegExp(`/${AUTOPILOT_COMMAND} demo`));
      assert.equal(message.content.includes(AUTOPILOT_STATUS_TOOL), false);
    });
  });
});
