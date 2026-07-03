import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import autopilotExtension, {
  type ExtensionCommandDefinitionLike,
  type ExtensionCommandContextLike,
  type ExtensionHostLike,
  type NotificationKind,
} from '../../src/extension.ts';
import {
  AUTOPILOT_ABORT_COMMAND,
  AUTOPILOT_CLOSE_COMMAND,
  AUTOPILOT_COMMAND,
  AUTOPILOT_HANDOFF_COMMAND,
  AUTOPILOT_ONBOARD_COMMAND,
  AUTOPILOT_STATUS_TOOL,
  CONTEXT_BUDGET_TOOL_NAME,
} from '../../src/core/names.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

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
  readonly ctx: ExtensionCommandContextLike;
}

function createHarness(cwd?: string): Harness {
  const commands = new Map<string, ExtensionCommandDefinitionLike>();
  const toolNames: string[] = [];
  const activeTools: string[] = [];
  const messages: CapturedMessage[] = [];
  const notifications: CapturedNotification[] = [];
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
    sendUserMessage: (content, options) => {
      messages.push({ content, deliverAs: options.deliverAs });
    },
  };
  const ctx: ExtensionCommandContextLike = {
    ui: {
      notify: (message, kind) => {
        notifications.push({ message, kind });
      },
    },
    ...(cwd === undefined ? {} : { cwd }),
  };
  autopilotExtension(host);
  return { commands, toolNames, activeTools, messages, notifications, ctx };
}

function requireCommand(harness: Harness, name: string): ExtensionCommandDefinitionLike {
  const command = harness.commands.get(name);
  if (command === undefined) throw new Error(`missing command ${name}`);
  return command;
}

function publicCommands(harness: Harness): string[] {
  return [...harness.commands.keys()].sort();
}

async function withIsolatedHarness<T>(run: (harness: Harness) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-command-'));
  const project = join(root, 'project');
  const originalStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
  process.env[AUTOPILOT_STATE_ROOT_ENV] = join(root, 'state');
  try {
    await initGitProject(project);
    return await run(createHarness(project));
  } finally {
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
  void it('queues the hardened parent prompt and activates context_budget only for /autopilot', async () => {
    await withIsolatedHarness(async (harness) => {
      await requireCommand(harness, AUTOPILOT_COMMAND).handler('demo operator scope', harness.ctx);
      assert.deepEqual(publicCommands(harness), [
        AUTOPILOT_COMMAND,
        AUTOPILOT_ABORT_COMMAND,
        AUTOPILOT_CLOSE_COMMAND,
        AUTOPILOT_HANDOFF_COMMAND,
        AUTOPILOT_ONBOARD_COMMAND,
      ]);
      assert.deepEqual(harness.toolNames, [CONTEXT_BUDGET_TOOL_NAME]);
      assert.deepEqual(harness.activeTools, [CONTEXT_BUDGET_TOOL_NAME]);
      assert.equal(harness.messages.length, 1);
      const message = harness.messages[0];
      if (message === undefined) throw new Error('missing parent prompt');
      assert.equal(message.deliverAs, 'followUp');
      assert.match(message.content, /call `context_budget` with no arguments/);
      assert.match(message.content, /Runtime root: `.*\.pi\/autopilot\/demo`/);
      assert.match(message.content, /Registered Autopilot worktree/);
      assert.match(message.content, /autopilot\.execution_commit\.v1/);
      assert.match(message.content, /only through the exact injected invocation/);
      assert.match(message.content, /validated status and receipt pair/);
      assert.equal(message.content.includes(AUTOPILOT_STATUS_TOOL), false);
    });
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
      assert.deepEqual(harness.toolNames, [CONTEXT_BUDGET_TOOL_NAME]);
      assert.deepEqual(harness.activeTools, [CONTEXT_BUDGET_TOOL_NAME]);
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
