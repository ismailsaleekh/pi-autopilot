import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import autopilotExtension, {
  type AutopilotRosterActivationResolution,
  type ExtensionCommandContextLike,
  type ExtensionCommandDefinitionLike,
  type ExtensionHostLike,
  type ExtensionModelLike,
  type ExtensionToolCallHandler,
  type ExtensionLifecycleHandler,
  type ExtensionResourcesDiscoverHandler,
  type ExtensionInputHandler,
} from '../../src/extension.ts';
import { AUTOPILOT_COMMAND, CONTEXT_BUDGET_TOOL_NAME } from '../../src/core/names.ts';
import { parseAutopilotArgs } from '../../src/core/paths.ts';
import { rosterDiagnostic } from '../../src/core/roster/route-policies.ts';
import type { PreparedAutopilotWorkstream } from '../../src/core/parallel-runtime.ts';
import type { VerifiedAutopilotRosterSetupSkillPackage } from '../../src/core/roster/skill-package.ts';

const SETUP_TOOL_NAME = 'autopilot_manage_rosters';
const ROSTER_ID = 'cruise-codex-subscription-bdb4f15f0ff9';
const ROSTER_SHA = 'sha256:f3ac0895d9abedfbe3616a79af0c1c3691962d24d5f17d195a78e6ab24d2b4a0' as const;
const ASSIGNMENT_SHA = 'sha256:bdb4f15f0ff90aff9d1e46a3a56bfdfddabafcf3c7f5c293a7b558ff2f22a3c4' as const;
const CONFIG_SHA = 'sha256:1d8a144806f7bd3df23724eb702223c7180b4d160cb09fc8cff5cbc77a1e3a38' as const;
const SELECTION_SHA = 'sha256:96c3625fddc6d43145ca5c6dece482e97fba78ad01c333e6aa3382fbe40d1878' as const;

type RegisteredHandler = ExtensionToolCallHandler | ExtensionLifecycleHandler | ExtensionResourcesDiscoverHandler | ExtensionInputHandler;

class FakePi implements ExtensionHostLike {
  readonly commands = new Map<string, ExtensionCommandDefinitionLike>();
  readonly tools: { readonly name: string }[] = [];
  readonly activeTools: string[] = [];
  readonly messages: string[] = [];
  readonly events: string[];
  readonly handlers = new Map<string, RegisteredHandler[]>();
  thinking = 'off';

  constructor(events: string[]) {
    this.events = events;
  }

  registerCommand(name: string, definition: ExtensionCommandDefinitionLike): void {
    this.commands.set(name, definition);
  }

  registerTool(tool: { readonly name: string }): void {
    this.events.push(`registerTool:${tool.name}`);
    this.tools.push(tool);
  }

  getActiveTools(): readonly string[] {
    return [...this.activeTools];
  }

  setActiveTools(toolNames: readonly string[]): void {
    this.events.push(`setActiveTools:${toolNames.join(',')}`);
    this.activeTools.splice(0, this.activeTools.length, ...toolNames);
  }

  async setModel(_model: ExtensionModelLike): Promise<boolean> {
    this.events.push('setModel');
    return true;
  }

  getThinkingLevel(): string {
    return this.thinking;
  }

  setThinkingLevel(level: 'high' | 'xhigh'): void {
    this.events.push(`setThinking:${level}`);
    this.thinking = level;
  }

  sendUserMessage(content: string): void {
    this.events.push('sendUserMessage');
    this.messages.push(content);
  }

  on(eventName: string, handler: RegisteredHandler): void {
    const list = this.handlers.get(eventName) ?? [];
    list.push(handler);
    this.handlers.set(eventName, list);
  }

  async emitLifecycle(eventName: 'session_shutdown' | 'session_start'): Promise<void> {
    const ctx = makeContext(this.events);
    for (const handler of this.handlers.get(eventName) ?? []) {
      await (handler as ExtensionLifecycleHandler)({}, ctx);
    }
  }
}

function fakePackage(): VerifiedAutopilotRosterSetupSkillPackage {
  return {
    packageRoot: '/pkg',
    name: 'autopilot-roster-setup',
    skillDirRelativePath: 'templates/skills/autopilot-roster-setup',
    skillPath: '/pkg/templates/skills/autopilot-roster-setup/SKILL.md',
    skillRelativePath: 'templates/skills/autopilot-roster-setup/SKILL.md',
    skillSha256: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    skillByteCount: 10,
    skillText: 'name: autopilot-roster-setup\nfresh Pi session\nRetry exactly the original command\nDo not auto-start Autopilot',
    payloadPath: '/pkg/templates/skills/autopilot-roster-setup/payload.json',
    payloadRelativePath: 'templates/skills/autopilot-roster-setup/payload.json',
    payloadSha256: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    payloadByteCount: 10,
    payloadText: '{}',
    payload: {} as VerifiedAutopilotRosterSetupSkillPackage['payload'],
    packageSkillEntry: './templates/skills/autopilot-roster-setup',
  } as unknown as VerifiedAutopilotRosterSetupSkillPackage;
}

function makeContext(events: string[]): ExtensionCommandContextLike {
  return {
    cwd: process.cwd(),
    ui: { notify: (message) => events.push(`notify:${message}`) },
    modelRegistry: {
      find(provider: string, modelId: string) {
        events.push(`find:${provider}/${modelId}`);
        return { provider, id: modelId };
      },
    },
    sessionManager: { getSessionId: () => 'session-unit' },
    isIdle: () => true,
    isProjectTrusted: () => true,
  };
}

function readyResolution(): AutopilotRosterActivationResolution {
  const preRunSelection = {
    schema_version: 'autopilot.pre_run_selection.v1' as const,
    repo_id: 'repo-unit',
    workstream_run: 'demo-20260723t000000z-abcdef',
    scope: 'user' as const,
    roster_id: ROSTER_ID,
    roster_revision: 1,
    roster_sha256: ROSTER_SHA,
    assignment_set_sha256: ASSIGNMENT_SHA,
    config_sha256: CONFIG_SHA,
    selected_at: '2026-07-23T00:00:00.000Z',
    selection_sha256: SELECTION_SHA,
  };
  return {
    status: 'resolved',
    diagnostics: [],
    selection: {
      source: 'explicit-roster',
      existingRun: false,
      scope: 'user',
      roster_id: ROSTER_ID,
      roster_revision: 1,
      roster_sha256: ROSTER_SHA,
      assignment_set_sha256: ASSIGNMENT_SHA,
      config_sha256: CONFIG_SHA,
      workstream_run: preRunSelection.workstream_run,
      pre_run_selection: preRunSelection,
      pre_run_selection_path: '/tmp/pre-run-selection.json',
      selection_bytes: new TextEncoder().encode('{"schema_version":"autopilot.pre_run_selection.v1"}\n'),
      launch_fence: {
        schema_version: 'autopilot.run_selection_launch_fence.v1',
        token_id: 'launch-fence-unit',
        repo_id: preRunSelection.repo_id,
        workstream_run: preRunSelection.workstream_run,
        selection_sha256: preRunSelection.selection_sha256,
        selection_path: '/tmp/pre-run-selection.json',
        issued_at: '2026-07-23T00:00:00.000Z',
        readback_verified: true,
      },
      runtime_mirror_path: null,
      parent: { model: 'openai-codex/gpt-5.6-sol', thinking: 'xhigh' },
    },
  };
}

function setupRequiredResolution(): AutopilotRosterActivationResolution {
  return { status: 'setup-required', source: 'agent-first-onboarding', diagnostics: [] };
}

function blockedResolution(): AutopilotRosterActivationResolution {
  return { status: 'blocked', source: 'trusted-project-default', diagnostics: [rosterDiagnostic('ROSTER_READBACK_MISMATCH')] };
}

function fakePrepared(): PreparedAutopilotWorkstream {
  return {
    repo: { repoRoot: '/repo', gitCommonDir: '/repo/.git', repoKey: 'repo-unit', headSha: 'abc', targetBranch: 'main', originUrl: null },
    active: {
      schema_version: 'autopilot.active_parent.v2',
      coordination_authority: 'legacy-path-claims-v1',
      autopilot_id: 'ap-demo-run',
      workstream: 'demo',
      workstream_run: 'demo-run',
      repo_key: 'repo-unit',
      source_repo: '/repo',
      git_common_dir: '/repo/.git',
      worktree_root: '/worktrees',
      main_worktree_path: '/worktrees/demo/main',
      branch: 'autopilot/demo-run',
      runtime_root: '/worktrees/demo/main/.pi/autopilot/demo',
      target_branch: 'main',
      target_base_sha: 'abc',
      origin_url: null,
      pid: 1,
      boot_id: 'boot',
      status: 'active',
      started_at: '2026-07-23T00:00:00.000Z',
      active_run_epoch: 1,
      active_epoch_started_at: '2026-07-23T00:00:00.000Z',
      active_run_receipt_id: 'receipt',
    },
    worktreeRoot: '/worktrees',
    taskRoot: '/worktrees/demo',
    mainWorktreePath: '/worktrees/demo/main',
    runtimeRoot: '/worktrees/demo/main/.pi/autopilot/demo',
    created: true,
    resumed: false,
  } as PreparedAutopilotWorkstream;
}

void describe('D69 W2 roster activation', () => {
  void it('parses strict leading --roster without changing legacy remainder behavior', () => {
    const parsed = parseAutopilotArgs(`demo --roster ${ROSTER_ID} build the feature`);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error(parsed.message);
    assert.equal(parsed.value.workstream, 'demo');
    assert.equal(parsed.value.rosterId, ROSTER_ID);
    assert.equal(parsed.value.remainder, 'build the feature');

    const legacy = parseAutopilotArgs('demo build with --roster literal text');
    assert.equal(legacy.ok, true);
    if (!legacy.ok) throw new Error(legacy.message);
    assert.equal(legacy.value.rosterId, null);
    assert.equal(legacy.value.remainder, 'build with --roster literal text');

    assert.equal(parseAutopilotArgs('demo --roster').ok, false);
    assert.equal(parseAutopilotArgs('demo --roster Bad_ID').ok, false);
  });

  void it('activates exactly one setup tool and packaged skill prompt with zero run/model side effects when no roster exists', async () => {
    const events: string[] = [];
    let prepareCalls = 0;
    const pi = new FakePi(events);
    autopilotExtension(pi, {
      rosterActivationStore: { resolve: async () => { events.push('resolve'); return setupRequiredResolution(); } },
      resolveSetupSkillPackage: () => fakePackage(),
      prepareAutopilotWorkstream: async () => { prepareCalls += 1; return fakePrepared(); },
    });

    await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo first task', makeContext(events));
    await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo first task', makeContext(events));

    assert.equal(prepareCalls, 0);
    assert.equal(events.some((event) => event.startsWith('find:')), false);
    assert.equal(events.includes('setModel'), false);
    assert.equal(pi.tools.filter((tool) => tool.name === SETUP_TOOL_NAME).length, 1);
    assert.equal(pi.tools.some((tool) => tool.name === CONTEXT_BUDGET_TOOL_NAME), false);
    assert.equal(pi.activeTools.includes(SETUP_TOOL_NAME), true);
    assert.equal(pi.activeTools.includes(CONTEXT_BUDGET_TOOL_NAME), false);
    assert.equal(pi.messages.length, 2);
    assert.match(pi.messages[0] ?? '', /\/skill:autopilot-roster-setup/);
    assert.match(pi.messages[0] ?? '', /Original command: \/autopilot demo first task/);
    assert.match(pi.messages[0] ?? '', /sha256:1111111111111111111111111111111111111111111111111111111111111111/);
    assert.match(pi.messages[0] ?? '', /fresh Pi session/);
  });

  void it('resolves a ready explicit roster before model lookup, workstream preparation, or prompt delivery', async () => {
    const events: string[] = [];
    const pi = new FakePi(events);
    autopilotExtension(pi, {
      rosterActivationStore: { resolve: async () => { events.push('resolve'); return readyResolution(); } },
      prepareAutopilotWorkstream: async () => { events.push('prepare'); return fakePrepared(); },
      publishRuntimeRosterSnapshot: async () => {
        events.push('publish-snapshot');
        return { schema_version: 'autopilot.runtime_roster_snapshot_publication_result.v1', ok: true, status: 'published', selection_sha256: SELECTION_SHA, mirror_path: '/tmp/mirror.json', idempotent_replay: false, diagnostics: [], write_count: 1, lock_count: 0, files_touched: ['/tmp/mirror.json'] };
      },
      attachSessionBridge: async () => { events.push('attach'); return true; },
    });

    await pi.commands.get(AUTOPILOT_COMMAND)?.handler(`demo --roster ${ROSTER_ID} ship it`, makeContext(events));

    assert.deepEqual(events.filter((event) => ['resolve', 'setModel', 'prepare', 'publish-snapshot', 'attach', 'sendUserMessage'].includes(event) || event.startsWith('find:')), [
      'resolve',
      'prepare',
      'publish-snapshot',
      'find:openai-codex/gpt-5.6-sol',
      'setModel',
      'attach',
      'sendUserMessage',
    ]);
    assert.equal(pi.activeTools.includes(CONTEXT_BUDGET_TOOL_NAME), true);
    assert.equal(pi.messages.length, 1);
    assert.match(pi.messages[0] ?? '', /ship it/);
    assert.equal(/--roster/u.test(pi.messages[0] ?? ''), false);
  });

  void it('fails closed on corrupt higher authority without setup or activation side effects', async () => {
    const events: string[] = [];
    let prepareCalls = 0;
    const pi = new FakePi(events);
    autopilotExtension(pi, {
      rosterActivationStore: { resolve: async () => { events.push('resolve'); return blockedResolution(); } },
      resolveSetupSkillPackage: () => fakePackage(),
      prepareAutopilotWorkstream: async () => { prepareCalls += 1; return fakePrepared(); },
    });

    await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo blocked', makeContext(events));

    assert.equal(prepareCalls, 0);
    assert.equal(events.some((event) => event.startsWith('find:')), false);
    assert.equal(pi.tools.some((tool) => tool.name === SETUP_TOOL_NAME), false);
    assert.equal(pi.activeTools.length, 0);
    assert.equal(pi.messages.length, 0);
    assert.ok(events.some((event) => event.includes('ROSTER_READBACK_MISMATCH')));
  });

  void it('deactivates the setup tool on session boundary', async () => {
    const events: string[] = [];
    const pi = new FakePi(events);
    autopilotExtension(pi, {
      rosterActivationStore: { resolve: async () => setupRequiredResolution() },
      resolveSetupSkillPackage: () => fakePackage(),
    });

    await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo', makeContext(events));
    assert.equal(pi.activeTools.includes(SETUP_TOOL_NAME), true);
    await pi.emitLifecycle('session_shutdown');
    assert.equal(pi.activeTools.includes(SETUP_TOOL_NAME), false);
  });
});
