import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import autopilotExtension, {
  type ExtensionCommandDefinitionLike,
  type ExtensionCommandContextLike,
  type ExtensionHostLike,
  type NotificationKind,
} from '../../src/extension.ts';
import {
  AUTOPILOT_COMMAND,
  AUTOPILOT_RESTART_COMMAND,
  AUTOPILOT_STATUS_TOOL,
  CONTEXT_BUDGET_TOOL_NAME,
} from '../../src/core/names.ts';

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

function createHarness(): Harness {
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
  };
  autopilotExtension(host);
  return { commands, toolNames, activeTools, messages, notifications, ctx };
}

function requireCommand(harness: Harness, name: string): ExtensionCommandDefinitionLike {
  const command = harness.commands.get(name);
  if (command === undefined) throw new Error(`missing command ${name}`);
  return command;
}

void describe('Autopilot command SDK surface', () => {
  void it('queues the hardened parent prompt and activates context_budget only for /autopilot', async () => {
    const harness = createHarness();
    await requireCommand(harness, AUTOPILOT_COMMAND).handler('demo operator scope', harness.ctx);
    assert.deepEqual([...harness.commands.keys()].sort(), [AUTOPILOT_COMMAND, AUTOPILOT_RESTART_COMMAND]);
    assert.deepEqual(harness.toolNames, [CONTEXT_BUDGET_TOOL_NAME]);
    assert.deepEqual(harness.activeTools, [CONTEXT_BUDGET_TOOL_NAME]);
    assert.equal(harness.messages.length, 1);
    const message = harness.messages[0];
    if (message === undefined) throw new Error('missing parent prompt');
    assert.equal(message.deliverAs, 'followUp');
    assert.match(message.content, /call `context_budget` with no arguments/);
    assert.match(message.content, /Runtime root: `\.pi\/autopilot\/demo`/);
    assert.match(message.content, /only through the exact injected invocation/);
    assert.match(message.content, /validated status and receipt pair/);
    assert.equal(message.content.includes(AUTOPILOT_STATUS_TOOL), false);
  });

  void it('queues a restart brief without registering tools or launch authority', async () => {
    const harness = createHarness();
    await requireCommand(harness, AUTOPILOT_RESTART_COMMAND).handler('demo handoff refs', harness.ctx);
    assert.deepEqual(harness.toolNames, []);
    assert.deepEqual(harness.activeTools, []);
    assert.equal(harness.messages.length, 1);
    const message = harness.messages[0];
    if (message === undefined) throw new Error('missing restart prompt');
    assert.match(message.content, /restart-brief generator/);
    assert.match(message.content, /Do not start child agents/);
    assert.match(message.content, /Do not create, edit, move, delete/);
    assert.match(message.content, /validated status\+receipt evidence/);
    assert.equal(message.content.includes(AUTOPILOT_STATUS_TOOL), false);
  });
});
