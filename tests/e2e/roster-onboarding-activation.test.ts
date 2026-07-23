import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import autopilotExtension, { type ExtensionCommandContextLike, type ExtensionCommandDefinitionLike, type ExtensionHostLike } from '../../src/extension.ts';
import { AUTOPILOT_COMMAND } from '../../src/core/names.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

const SETUP_TOOL_NAME = 'autopilot_manage_rosters';

class FakePi implements ExtensionHostLike {
  readonly commands = new Map<string, ExtensionCommandDefinitionLike>();
  readonly tools: { readonly name: string }[] = [];
  readonly activeTools: string[] = [];
  readonly messages: string[] = [];
  readonly notifications: string[] = [];

  registerCommand(name: string, definition: ExtensionCommandDefinitionLike): void {
    this.commands.set(name, definition);
  }

  registerTool(tool: { readonly name: string }): void {
    this.tools.push(tool);
  }

  getActiveTools(): readonly string[] {
    return [...this.activeTools];
  }

  setActiveTools(toolNames: readonly string[]): void {
    this.activeTools.splice(0, this.activeTools.length, ...toolNames);
  }

  async setModel(): Promise<boolean> {
    throw new Error('setModel must not be called during no-roster onboarding');
  }

  getThinkingLevel(): string {
    return 'off';
  }

  setThinkingLevel(): void {
    throw new Error('setThinkingLevel must not be called during no-roster onboarding');
  }

  sendUserMessage(content: string): void {
    this.messages.push(content);
  }
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function initGitProject(project: string): Promise<void> {
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# roster onboarding activation\n', 'utf8');
  git(project, ['init']);
  git(project, ['config', 'user.email', 'autopilot@example.invalid']);
  git(project, ['config', 'user.name', 'Autopilot Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-m', 'baseline']);
}

function makeContext(pi: FakePi, cwd: string): ExtensionCommandContextLike {
  return {
    cwd,
    ui: { notify: (message) => pi.notifications.push(message) },
    modelRegistry: {
      find() {
        throw new Error('modelRegistry.find must not be called before roster setup');
      },
    },
    sessionManager: { getSessionId: () => 'e2e-session' },
    isIdle: () => true,
    isProjectTrusted: () => false,
  };
}

void describe('D69 W2 no-roster onboarding activation e2e', () => {
  void it('uses the production resolver to activate packaged setup without creating run, roster, project, or model side effects', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'roster-onboarding-e2e-'));
    const project = join(root, 'project');
    const rosterStateRoot = join(root, 'roster-state');
    const runtimeStateRoot = join(root, 'runtime-state');
    const previousStateRoot = process.env[AUTOPILOT_STATE_ROOT_ENV];
    process.env[AUTOPILOT_STATE_ROOT_ENV] = runtimeStateRoot;
    try {
      await initGitProject(project);
      const pi = new FakePi();
      autopilotExtension(pi, {
        rosterStateRoot,
        prepareAutopilotWorkstream: async () => {
          throw new Error('prepareAutopilotWorkstream must not run during no-roster onboarding');
        },
      });

      await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo prove onboarding', makeContext(pi, project));

      assert.equal(pi.tools.filter((tool) => tool.name === SETUP_TOOL_NAME).length, 1);
      assert.equal(pi.activeTools.includes(SETUP_TOOL_NAME), true);
      assert.equal(pi.messages.length, 1);
      const message = pi.messages[0] ?? '';
      assert.match(message, /\/skill:autopilot-roster-setup/);
      assert.match(message, /Original command: \/autopilot demo prove onboarding/);
      assert.match(message, /templates\/skills\/autopilot-roster-setup\/SKILL\.md/);
      assert.match(message, /fresh Pi session/);
      assert.match(message, /Do not auto-start Autopilot/);
      assert.ok(pi.notifications.some((entry) => entry.includes('roster setup is required')));

      assert.equal(existsSync(rosterStateRoot), false);
      assert.equal(existsSync(runtimeStateRoot), false);
      assert.equal(existsSync(join(project, '.autopilot')), false);
      assert.equal(existsSync(join(project, '.pi', 'autopilot', 'demo')), false);
    } finally {
      if (previousStateRoot === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
      else process.env[AUTOPILOT_STATE_ROOT_ENV] = previousStateRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
});
