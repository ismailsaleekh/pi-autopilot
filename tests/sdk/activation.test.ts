import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AUTOPILOT_COMMAND,
  AUTOPILOT_HANDOFF_COMMAND,
  AUTOPILOT_ONBOARD_COMMAND,
  AUTOPILOT_STATUS_TOOL,
  CONTEXT_BUDGET_TOOL_NAME,
} from '../../src/core/names.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

type ThinkingLevelLike = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

interface IndexableValue {
  readonly [key: string]: unknown;
}

interface ResourceLoaderLike {
  reload(): Promise<void>;
}

interface ResourceLoaderOptionsLike {
  readonly cwd: string;
  readonly agentDir: string;
  readonly additionalExtensionPaths: readonly string[];
  readonly noExtensions: true;
  readonly noSkills: true;
  readonly noPromptTemplates: true;
  readonly noContextFiles: true;
}

interface AuthStorageLike {
  readonly marker?: unknown;
}

interface SessionManagerLike {
  readonly marker?: unknown;
}

interface SettingsManagerLike {
  readonly marker?: unknown;
}

interface ModelRegistryLike {
  readonly marker?: unknown;
}

interface ExtensionCommandLike {
  readonly name: string;
  readonly description?: string;
  handler(args: string, ctx: unknown): Promise<void> | void;
}

interface EmptyParameters {
  readonly [key: string]: never;
}

interface ContextUsageLike {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
}

interface ToolContextLike {
  getContextUsage(): ContextUsageLike | undefined;
}

interface ToolResultLike {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly details: { readonly gate: string; readonly percent: number | null };
}

interface ToolDefinitionLike {
  readonly name: string;
  execute(
    toolCallId: string,
    params: EmptyParameters,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ToolContextLike,
  ): Promise<ToolResultLike>;
}

interface MessageCapture {
  readonly content: string;
  readonly deliverAs: 'steer' | 'followUp' | undefined;
}

interface ExtensionActionsLike {
  sendMessage(message: unknown, options?: unknown): void;
  sendUserMessage(content: string | readonly unknown[], options?: { readonly deliverAs?: 'steer' | 'followUp' }): void;
  appendEntry(customType: string, data?: unknown): void;
  setSessionName(name: string): void;
  getSessionName(): string | undefined;
  setLabel(entryId: string, label: string | undefined): void;
  getActiveTools(): string[];
  getAllTools(): readonly unknown[];
  setActiveTools(toolNames: readonly string[]): void;
  refreshTools(): void;
  getCommands(): readonly { readonly name: string; readonly description?: string }[];
  setModel(model: unknown): Promise<boolean>;
  getThinkingLevel(): ThinkingLevelLike;
  setThinkingLevel(level: ThinkingLevelLike): void;
}

interface ExtensionContextActionsLike {
  getModel(): unknown;
  isIdle(): boolean;
  isProjectTrusted(): boolean;
  getSignal(): AbortSignal | undefined;
  abort(): void;
  hasPendingMessages(): boolean;
  shutdown(): void;
  getContextUsage(): ContextUsageLike | undefined;
  compact(options?: unknown): void;
  getSystemPrompt(): string;
}

interface ExtensionRunnerLike {
  bindCore(actions: ExtensionActionsLike, contextActions: ExtensionContextActionsLike): void;
  createCommandContext(): unknown;
  getCommand(name: string): ExtensionCommandLike | undefined;
  getRegisteredCommands(): readonly ExtensionCommandLike[];
  getToolDefinition(name: string): ToolDefinitionLike | undefined;
  emit(event: { readonly type: 'session_shutdown'; readonly reason: 'quit' }): Promise<unknown>;
}

interface SessionLike {
  readonly extensionRunner: ExtensionRunnerLike;
  dispose(): void;
}

interface CreateAgentSessionResultLike {
  readonly session: SessionLike;
}

interface CreateAgentSessionOptionsLike {
  readonly cwd: string;
  readonly agentDir: string;
  readonly resourceLoader: ResourceLoaderLike;
  readonly sessionManager: SessionManagerLike;
  readonly settingsManager: SettingsManagerLike;
  readonly authStorage: AuthStorageLike;
  readonly modelRegistry: ModelRegistryLike;
  readonly noTools: 'builtin';
}

interface PiSdkModuleLike {
  readonly DefaultResourceLoader: new (options: ResourceLoaderOptionsLike) => ResourceLoaderLike;
  readonly AuthStorage: { create(path: string): AuthStorageLike };
  readonly ModelRegistry: { inMemory(authStorage: AuthStorageLike): ModelRegistryLike };
  readonly SessionManager: { inMemory(cwd: string): SessionManagerLike };
  readonly SettingsManager: { inMemory(): SettingsManagerLike };
  createAgentSession(options: CreateAgentSessionOptionsLike): Promise<CreateAgentSessionResultLike>;
}

interface SdkHarness {
  readonly root: string;
  readonly session: SessionLike;
  readonly sentMessages: MessageCapture[];
  readonly activeTools: readonly string[];
  readonly previousCwd: string;
  readonly previousStateRoot: string | undefined;
}

const packageRoot = new URL('../../', import.meta.url).pathname;
const extensionPath = join(packageRoot, 'extensions/autopilot.ts');
const globalSdkPath = '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
const packageSdkSpecifier = '@earendil-works/pi-coding-agent';
const forbiddenLegacyCommand = ['hlo', 'v2'].join('-');

function isIndexable(value: unknown): value is IndexableValue {
  const valueType = typeof value;
  return (valueType === 'object' || valueType === 'function') && value !== null && !Array.isArray(value);
}

function hasPiSdkShape(value: unknown): value is PiSdkModuleLike {
  if (!isIndexable(value)) return false;
  const authStorage = value['AuthStorage'];
  const modelRegistry = value['ModelRegistry'];
  const sessionManager = value['SessionManager'];
  const settingsManager = value['SettingsManager'];
  return (
    typeof value['DefaultResourceLoader'] === 'function' &&
    isIndexable(authStorage) &&
    typeof authStorage['create'] === 'function' &&
    isIndexable(modelRegistry) &&
    typeof modelRegistry['inMemory'] === 'function' &&
    isIndexable(sessionManager) &&
    typeof sessionManager['inMemory'] === 'function' &&
    isIndexable(settingsManager) &&
    typeof settingsManager['inMemory'] === 'function' &&
    typeof value['createAgentSession'] === 'function'
  );
}

async function loadPiSdk(): Promise<PiSdkModuleLike> {
  let loaded: unknown;
  try {
    loaded = await import(packageSdkSpecifier);
  } catch {
    loaded = await import(pathToFileURL(globalSdkPath).href);
  }
  if (!hasPiSdkShape(loaded)) throw new TypeError('Pi SDK module did not expose the expected harness API');
  return loaded;
}

function setOfflineEnvironment(): void {
  process.env['PI_OFFLINE'] = '1';
  process.env['PI_SKIP_VERSION_CHECK'] = '1';
  process.env['PI_TELEMETRY'] = '0';
  process.env['CI'] = '1';
}

async function withAutopilotThreshold(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env['AUTOPILOT_CONTEXT_HALT_PERCENT'];
  if (value === undefined) delete process.env['AUTOPILOT_CONTEXT_HALT_PERCENT'];
  else process.env['AUTOPILOT_CONTEXT_HALT_PERCENT'] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env['AUTOPILOT_CONTEXT_HALT_PERCENT'];
    else process.env['AUTOPILOT_CONTEXT_HALT_PERCENT'] = previous;
  }
}

function commandNames(session: SessionLike): string[] {
  return session.extensionRunner
    .getRegisteredCommands()
    .map((command) => command.name)
    .sort();
}

function requireCommand(session: SessionLike, name: string): ExtensionCommandLike {
  const command = session.extensionRunner.getCommand(name);
  if (command === undefined) throw new Error(`missing SDK command ${name}`);
  return command;
}

function captureCoreActions(
  session: SessionLike,
  sentMessages: MessageCapture[],
  activeTools: string[],
): ExtensionActionsLike {
  let sessionName: string | undefined;
  return {
    sendMessage: () => undefined,
    sendUserMessage: (content, options) => {
      assert.equal(typeof content, 'string');
      if (typeof content !== 'string') throw new TypeError('Autopilot prompt must be text');
      sentMessages.push({ content, deliverAs: options?.deliverAs });
    },
    appendEntry: () => undefined,
    setSessionName: (name) => {
      sessionName = name;
    },
    getSessionName: () => sessionName,
    setLabel: () => undefined,
    getActiveTools: () => [...activeTools],
    getAllTools: () => [],
    setActiveTools: (toolNames) => {
      activeTools.splice(0, activeTools.length, ...toolNames);
    },
    refreshTools: () => undefined,
    getCommands: () =>
      session.extensionRunner.getRegisteredCommands().map((command) =>
        command.description === undefined
          ? { name: command.name }
          : { name: command.name, description: command.description },
      ),
    setModel: () => Promise.resolve(false),
    getThinkingLevel: () => 'off',
    setThinkingLevel: () => undefined,
  };
}

function contextActions(): ExtensionContextActionsLike {
  return {
    getModel: () => undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => ({ tokens: 25_000, contextWindow: 200_000, percent: 12.5 }),
    compact: () => undefined,
    getSystemPrompt: () => '',
  };
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

async function createSdkHarness(): Promise<SdkHarness> {
  setOfflineEnvironment();
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-sdk-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await initGitProject(cwd);
  await mkdir(agentDir, { recursive: true });
  const previousCwd = process.cwd();
  const previousStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
  process.env[AUTOPILOT_STATE_ROOT_ENV] = join(root, 'autopilot-state');
  process.chdir(cwd);

  const sdk = await loadPiSdk();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const authStorage = sdk.AuthStorage.create(join(agentDir, 'auth.json'));
  const modelRegistry = sdk.ModelRegistry.inMemory(authStorage);
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    settingsManager: sdk.SettingsManager.inMemory(),
    authStorage,
    modelRegistry,
    noTools: 'builtin',
  });
  const sentMessages: MessageCapture[] = [];
  const activeTools: string[] = [];
  session.extensionRunner.bindCore(captureCoreActions(session, sentMessages, activeTools), contextActions());
  return { root, session, sentMessages, activeTools, previousCwd, previousStateRoot };
}

async function disposeHarness(harness: SdkHarness): Promise<void> {
  await harness.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  harness.session.dispose();
  process.chdir(harness.previousCwd);
  if (harness.previousStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
  else process.env[AUTOPILOT_STATE_ROOT_ENV] = harness.previousStateRoot;
  await rm(harness.root, { recursive: true, force: true });
}

void describe('Pi SDK Autopilot activation', () => {
  void it('loads through the real Pi SDK with only Autopilot public commands', async () => {
    const harness = await createSdkHarness();
    try {
      assert.deepEqual(commandNames(harness.session), [
        AUTOPILOT_COMMAND,
        AUTOPILOT_HANDOFF_COMMAND,
        AUTOPILOT_ONBOARD_COMMAND,
      ]);
      assert.equal(harness.session.extensionRunner.getCommand(forbiddenLegacyCommand), undefined);
      assert.equal(harness.session.extensionRunner.getCommand(AUTOPILOT_STATUS_TOOL), undefined);
      assert.equal(harness.session.extensionRunner.getToolDefinition(CONTEXT_BUDGET_TOOL_NAME), undefined);
      assert.equal(harness.session.extensionRunner.getToolDefinition(AUTOPILOT_STATUS_TOOL), undefined);
      assert.equal(harness.activeTools.includes(CONTEXT_BUDGET_TOOL_NAME), false);
    } finally {
      await disposeHarness(harness);
    }
  });

  void it('activates context_budget and queues the Autopilot parent prompt from the SDK command', async () => {
    const harness = await createSdkHarness();
    try {
      await requireCommand(harness.session, AUTOPILOT_COMMAND).handler(
        'demo initial scope',
        harness.session.extensionRunner.createCommandContext(),
      );
      const contextBudget = harness.session.extensionRunner.getToolDefinition(CONTEXT_BUDGET_TOOL_NAME);
      if (contextBudget === undefined) throw new Error('context_budget was not registered');
      assert.equal(harness.session.extensionRunner.getToolDefinition(AUTOPILOT_STATUS_TOOL), undefined);
      assert.equal(harness.activeTools.includes(CONTEXT_BUDGET_TOOL_NAME), true);
      assert.equal(harness.sentMessages.length, 1);
      const message = harness.sentMessages[0];
      if (message === undefined) throw new Error('missing queued SDK prompt');
      assert.equal(message.deliverAs, 'followUp');
      assert.match(message.content, /Runtime root: `.*\.pi\/autopilot\/demo`/);
      assert.match(message.content, /Registered Autopilot worktree/);
      assert.match(message.content, /autopilot\.execution_commit\.v1/);
      assert.match(message.content, /context_budget/);
      assert.equal(new RegExp(AUTOPILOT_STATUS_TOOL).test(message.content), false);

      const result = await contextBudget.execute(
        'call-1',
        {},
        undefined,
        undefined,
        { getContextUsage: () => ({ tokens: 20_000, contextWindow: 200_000, percent: 10 }) },
      );
      assert.equal(result.details.gate, 'ok');
      assert.match(result.content[0].text, /"gate":"ok"/);
    } finally {
      await disposeHarness(harness);
    }
  });

  void it('uses AUTOPILOT_CONTEXT_HALT_PERCENT for lazy SDK context_budget activation', async () => {
    const harness = await createSdkHarness();
    try {
      await withAutopilotThreshold('72.5', async () => {
        await requireCommand(harness.session, AUTOPILOT_COMMAND).handler(
          'demo threshold check',
          harness.session.extensionRunner.createCommandContext(),
        );
      });
      const contextBudget = harness.session.extensionRunner.getToolDefinition(CONTEXT_BUDGET_TOOL_NAME);
      if (contextBudget === undefined) throw new Error('context_budget was not registered');
      const result = await contextBudget.execute(
        'call-threshold',
        {},
        undefined,
        undefined,
        { getContextUsage: () => ({ tokens: 146_000, contextWindow: 200_000, percent: 73 }) },
      );
      assert.equal(result.details.gate, 'halt');
      assert.equal(result.details.percent, 73);
      assert.match(result.content[0].text, /"thresholdPercent":72\.5/);
    } finally {
      await disposeHarness(harness);
    }
  });

  void it('keeps onboard as prompt-only SDK behavior without parent status-tool exposure', async () => {
    const harness = await createSdkHarness();
    try {
      await requireCommand(harness.session, AUTOPILOT_ONBOARD_COMMAND).handler(
        'demo refs',
        harness.session.extensionRunner.createCommandContext(),
      );
      assert.equal(harness.session.extensionRunner.getToolDefinition(CONTEXT_BUDGET_TOOL_NAME), undefined);
      assert.equal(harness.session.extensionRunner.getToolDefinition(AUTOPILOT_STATUS_TOOL), undefined);
      assert.equal(harness.activeTools.includes(CONTEXT_BUDGET_TOOL_NAME), false);
      assert.equal(harness.sentMessages.length, 1);
      const message = harness.sentMessages[0];
      if (message === undefined) throw new Error('missing onboard prompt');
      assert.equal(message.deliverAs, 'followUp');
      assert.match(message.content, /onboard-brief generator/);
      assert.match(message.content, /Do not start child agents/);
      assert.equal(new RegExp(AUTOPILOT_STATUS_TOOL).test(message.content), false);
    } finally {
      await disposeHarness(harness);
    }
  });

  void it('rejects a missing workstream through the SDK command without queueing a prompt', async () => {
    const harness = await createSdkHarness();
    try {
      await requireCommand(harness.session, AUTOPILOT_COMMAND).handler(
        '   ',
        harness.session.extensionRunner.createCommandContext(),
      );
      assert.equal(harness.sentMessages.length, 0);
      assert.equal(harness.session.extensionRunner.getToolDefinition(CONTEXT_BUDGET_TOOL_NAME), undefined);
      assert.equal(harness.activeTools.includes(CONTEXT_BUDGET_TOOL_NAME), false);
    } finally {
      await disposeHarness(harness);
    }
  });
});
