import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import autopilotExtension, { type AutopilotRosterActivationResolution, type AutopilotRosterSetupToolBundle, type ExtensionCommandContextLike, type ExtensionCommandDefinitionLike, type ExtensionHostLike, type ExtensionInputHandler, type ExtensionLifecycleHandler, type ExtensionResourcesDiscoverHandler, type ExtensionToolCallHandler } from '../../src/extension.ts';
import { AUTOPILOT_COMMAND, AUTOPILOT_INJECT_COMMAND } from '../../src/core/names.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type PreparedAutopilotWorkstream } from '../../src/core/parallel-runtime.ts';
import { parseAutopilotRosterContract } from '../../src/core/roster/contracts.ts';
import { createAutopilotRosterSetupTool } from '../../src/core/roster/setup-tool.ts';
import { canonicalSha256, rosterDiagnostic } from '../../src/core/roster/route-policies.ts';

const SETUP_TOOL_NAME = 'autopilot_manage_rosters';
const ROSTER_ID = 'cruise-codex-subscription-bdb4f15f0ff9';
const ROSTER_SHA = 'sha256:f3ac0895d9abedfbe3616a79af0c1c3691962d24d5f17d195a78e6ab24d2b4a0' as const;
const ASSIGNMENT_SHA = 'sha256:bdb4f15f0ff90aff9d1e46a3a56bfdfddabafcf3c7f5c293a7b558ff2f22a3c4' as const;
const CONFIG_SHA = 'sha256:1d8a144806f7bd3df23724eb702223c7180b4d160cb09fc8cff5cbc77a1e3a38' as const;
const SELECTION_SHA = 'sha256:96c3625fddc6d43145ca5c6dece482e97fba78ad01c333e6aa3382fbe40d1878' as const;

type RegisteredHandler = ExtensionToolCallHandler | ExtensionLifecycleHandler | ExtensionResourcesDiscoverHandler | ExtensionInputHandler;
type SetupToolDetails = Awaited<ReturnType<AutopilotRosterSetupToolBundle['tool']['execute']>>['details'];

function checkedSetupToolDetails(value: unknown): SetupToolDetails {
  if (!isSetupToolDetails(value)) throw new Error('setup tool details failed the runtime result boundary');
  return value;
}

function isSetupToolDetails(value: unknown): value is SetupToolDetails {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const receipt = record['receipt'];
  return record['schema_version'] === 'autopilot.roster_tool_result.v1' && record['candidate_set'] === null &&
    typeof record['action'] === 'string' && typeof record['ok'] === 'boolean' && typeof record['status'] === 'string' &&
    Array.isArray(record['diagnostics']) && Number.isInteger(record['write_count']) && Number.isInteger(record['lock_count']) &&
    Array.isArray(record['files_touched']) && isSha256(record['result_sha256']) &&
    (receipt === null || isSetupReceipt(receipt));
}

function isSetupReceipt(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const receipt = value as Readonly<Record<string, unknown>>;
  return receipt['schema_version'] === 'autopilot.roster_setup_receipt.v1' && isSha256(receipt['receipt_sha256']);
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

class FakePi implements ExtensionHostLike {
  readonly commands = new Map<string, ExtensionCommandDefinitionLike>();
  readonly tools: ({ readonly name: string; execute?: (...args: unknown[]) => unknown })[] = [];
  readonly activeTools: string[] = [];
  readonly messages: string[] = [];
  readonly notifications: string[] = [];
  readonly handlers = new Map<string, RegisteredHandler[]>();
  modelSelections = 0;
  allowModelSelection = false;

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
    if (!this.allowModelSelection) throw new Error('setModel must not be called during no-roster onboarding');
    this.modelSelections += 1;
    return true;
  }

  getThinkingLevel(): string {
    return 'off';
  }

  setThinkingLevel(): void {
    if (!this.allowModelSelection) throw new Error('setThinkingLevel must not be called during no-roster onboarding');
  }

  sendUserMessage(content: string): void {
    this.messages.push(content);
  }

  on(eventName: string, handler: RegisteredHandler): void {
    const list = this.handlers.get(eventName) ?? [];
    list.push(handler);
    this.handlers.set(eventName, list);
  }

  async emitInput(text: string, ctx: ExtensionCommandContextLike, source = 'user'): Promise<void> {
    for (const handler of this.handlers.get('input') ?? []) {
      await (handler as ExtensionInputHandler)({ text, source }, ctx);
    }
  }

  async emitSessionStart(ctx: ExtensionCommandContextLike): Promise<void> {
    for (const handler of this.handlers.get('session_start') ?? []) {
      await (handler as ExtensionLifecycleHandler)({}, ctx);
    }
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
      find(provider: string, modelId: string) {
        if (!pi.allowModelSelection) throw new Error('modelRegistry.find must not be called before roster setup');
        return { provider, id: modelId };
      },
    },
    sessionManager: { getSessionId: () => 'e2e-session' },
    isIdle: () => true,
    isProjectTrusted: () => false,
  };
}

function setupSaveResult(originalCommand: string, replay: boolean): SetupToolDetails {
  const savedRef = { roster_id: ROSTER_ID, roster_revision: 1, roster_sha256: ROSTER_SHA, assignment_set_sha256: ASSIGNMENT_SHA, path: `~/.pi/agent/autopilot/rosters/${ROSTER_ID}/revision-1.json` };
  const receiptPreimage = {
    schema_version: 'autopilot.roster_setup_receipt.v1' as const,
    receipt_id: replay ? 'receipt-e2e-replay' : 'receipt-e2e-saved',
    scope: 'user' as const,
    saved_rosters: [savedRef],
    default_roster_id: ROSTER_ID,
    default_roster_revision: 1,
    default_roster_sha256: ROSTER_SHA,
    approved_candidate_set_sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    approved_roster_sha256s: [ROSTER_SHA],
    config_sha256: CONFIG_SHA,
    original_command: originalCommand,
    fresh_session_required: true,
    zero_secrets: true,
    issued_at: '2026-07-23T00:00:00.000Z',
  };
  const receipt = parseAutopilotRosterContract('autopilot.roster_setup_receipt.v1', { ...receiptPreimage, receipt_sha256: canonicalSha256(receiptPreimage) });
  const preimage = { schema_version: 'autopilot.roster_tool_result.v1' as const, action: 'save' as const, ok: true, status: 'saved' as const, candidate_set: null, receipt, diagnostics: [], write_count: replay ? 0 : 2, lock_count: 1, files_touched: replay ? [] : ['/state/config.json'] };
  return checkedSetupToolDetails(parseAutopilotRosterContract('autopilot.roster_tool_result.v1', { ...preimage, result_sha256: canonicalSha256(preimage) }));
}

function blockedSaveResult(): SetupToolDetails {
  const preimage = { schema_version: 'autopilot.roster_tool_result.v1' as const, action: 'save' as const, ok: false, status: 'blocked' as const, candidate_set: null, receipt: null, diagnostics: [rosterDiagnostic('ROSTER_STORAGE_TRUST_REQUIRED')], write_count: 0, lock_count: 0, files_touched: [] };
  return checkedSetupToolDetails(parseAutopilotRosterContract('autopilot.roster_tool_result.v1', { ...preimage, result_sha256: canonicalSha256(preimage) }));
}

function fakeSetupBundle(mode: 'saved' | 'replay' | 'blocked'): AutopilotRosterSetupToolBundle {
  const token = 'setup:e2e-restart-fence-0000000000000000000000';
  let active = false;
  let approved = false;
  const base = createAutopilotRosterSetupTool();
  const controller: AutopilotRosterSetupToolBundle['controller'] = {
    activate: () => { active = true; approved = false; return { ok: true, active: true, activation_token: token, session_id: 'e2e-session', reason: 'activated' }; },
    deactivate: (inputToken: string) => { if (!active || inputToken !== token) return false; active = false; approved = false; return true; },
    isActive: () => active,
    currentActivationToken: () => active ? token : null,
  };
  const hostAuthorization: AutopilotRosterSetupToolBundle['hostAuthorization'] = {
    currentApprovalPresentation: () => active && !approved ? ({ schema_version: 'autopilot.roster_tool_request.v1', activation_token: token, scope: 'user', candidate_set_sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', approved_roster_sha256s: [ROSTER_SHA], default_roster_id: ROSTER_ID, default_roster_revision: 1, default_roster_sha256: ROSTER_SHA, original_command: '/autopilot demo e2e saved', presentation_sha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', presentation_text: 'approve' }) : null,
    authorizeInput: (input) => {
      if (!active) return { ok: false, approval_token: null, reason: 'inactive' };
      if (input.activation_token !== token) return { ok: false, approval_token: null, reason: 'bad-activation-token' };
      if (input.source !== 'user' || input.text.length === 0) return { ok: false, approval_token: null, reason: 'source-not-user' };
      approved = true;
      return { ok: true, approval_token: 'approval:e2e-restart-fence-000000000000000000', reason: 'approved' };
    },
  };
  const tool: AutopilotRosterSetupToolBundle['tool'] = {
    ...base.tool,
    async execute(_id, params) {
      const request = typeof params === 'object' && params !== null ? params as Record<string, unknown> : Object.create(null);
      const originalCommand = typeof request['original_command'] === 'string' ? request['original_command'] : '/autopilot demo e2e saved';
      const details = active && approved && request['action'] === 'save'
        ? mode === 'blocked' ? blockedSaveResult() : setupSaveResult(originalCommand, mode === 'replay')
        : blockedSaveResult();
      return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
    },
  };
  return { controller, hostAuthorization, tool };
}

function setupSaveRequest(): Record<string, unknown> {
  return { schema_version: 'autopilot.roster_tool_request.v1', action: 'save', activation_token: 'setup:e2e-restart-fence-0000000000000000000000', approval_token: 'approval:e2e-restart-fence-000000000000000000', scope: 'user', trusted_project_root: null, candidate_set_sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', approved_roster_sha256s: [ROSTER_SHA], default_roster_id: ROSTER_ID, default_roster_revision: 1, default_roster_sha256: ROSTER_SHA, original_command: '/autopilot demo e2e saved' };
}

function readyResolution(): AutopilotRosterActivationResolution {
  const selection = { schema_version: 'autopilot.pre_run_selection.v1' as const, repo_id: 'repo-e2e', workstream_run: 'demo-20260723t000000z-abcdef', scope: 'user' as const, roster_id: ROSTER_ID, roster_revision: 1, roster_sha256: ROSTER_SHA, assignment_set_sha256: ASSIGNMENT_SHA, config_sha256: CONFIG_SHA, selected_at: '2026-07-23T00:00:00.000Z', selection_sha256: SELECTION_SHA };
  return { status: 'resolved', diagnostics: [], selection: { source: 'explicit-roster', existingRun: false, scope: 'user', roster_id: ROSTER_ID, roster_revision: 1, roster_sha256: ROSTER_SHA, assignment_set_sha256: ASSIGNMENT_SHA, config_sha256: CONFIG_SHA, workstream_run: selection.workstream_run, pre_run_selection: selection, selection_bytes: new TextEncoder().encode('{}'), launch_fence: { schema_version: 'autopilot.run_selection_launch_fence.v1', token_id: 'fence', repo_id: selection.repo_id, workstream_run: selection.workstream_run, selection_sha256: selection.selection_sha256, selection_path: '/tmp/selection.json', issued_at: '2026-07-23T00:00:00.000Z', readback_verified: true }, runtime_mirror_path: null, parent: { model: 'openai-codex/gpt-5.6-sol', thinking: 'xhigh' } } };
}

function fakePrepared(): PreparedAutopilotWorkstream {
  return { repo: { repoRoot: '/repo', gitCommonDir: '/repo/.git', repoKey: 'repo-e2e', headSha: 'abc', targetBranch: 'main', originUrl: null }, active: { schema_version: 'autopilot.active_parent.v2', coordination_authority: 'legacy-path-claims-v1', autopilot_id: 'ap-demo-run', workstream: 'demo', workstream_run: 'demo-run', repo_key: 'repo-e2e', source_repo: '/repo', git_common_dir: '/repo/.git', worktree_root: '/worktrees', main_worktree_path: '/worktrees/demo/main', branch: 'autopilot/demo-run', runtime_root: '/worktrees/demo/main/.pi/autopilot/demo', target_branch: 'main', target_base_sha: 'abc', origin_url: null, pid: 1, boot_id: 'boot', status: 'active', started_at: '2026-07-23T00:00:00.000Z', active_run_epoch: 1, active_epoch_started_at: '2026-07-23T00:00:00.000Z', active_run_receipt_id: 'receipt' }, worktreeRoot: '/worktrees', taskRoot: '/worktrees/demo', mainWorktreePath: '/worktrees/demo/main', runtimeRoot: '/worktrees/demo/main/.pi/autopilot/demo', created: true, resumed: false } as PreparedAutopilotWorkstream;
}

void describe('D69 W2 no-roster onboarding activation e2e', () => {
  void it('fences same-session retries after the registered setup tool returns saved or replayed receipts', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'roster-restart-fence-e2e-'));
    const project = join(root, 'project');
    try {
      await initGitProject(project);
      for (const mode of ['saved', 'replay'] as const) {
        const pi = new FakePi();
        let resolution: AutopilotRosterActivationResolution = { status: 'setup-required', source: 'agent-first-onboarding', diagnostics: [] };
        let resolveCalls = 0;
        let prepareCalls = 0;
        autopilotExtension(pi, {
          rosterActivationStore: { resolve: async () => { resolveCalls += 1; return resolution; } },
          createRosterSetupTool: () => fakeSetupBundle(mode),
          prepareAutopilotWorkstream: async () => { prepareCalls += 1; return fakePrepared(); },
          publishRuntimeRosterSnapshot: async () => ({ schema_version: 'autopilot.runtime_roster_snapshot_publication_result.v1', ok: true, status: 'published', selection_sha256: SELECTION_SHA, mirror_path: '/tmp/mirror.json', idempotent_replay: false, diagnostics: [], write_count: 1, lock_count: 0, files_touched: ['/tmp/mirror.json'] }),
          attachSessionBridge: async () => true,
        });
        const ctx = makeContext(pi, project);
        await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo e2e saved', ctx);
        await pi.emitInput('approve setup', ctx);
        await pi.tools.find((tool) => tool.name === SETUP_TOOL_NAME)?.execute?.('tool-call', setupSaveRequest(), undefined, undefined, ctx);
        resolution = readyResolution();
        await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo e2e saved', ctx);
        await pi.commands.get(AUTOPILOT_INJECT_COMMAND)?.handler('demo', ctx);
        assert.equal(resolveCalls, 1, mode);
        assert.equal(prepareCalls, 0, mode);
        assert.equal(pi.modelSelections, 0, mode);
        assert.equal(pi.messages.length, 1, mode);
        assert.ok(pi.notifications.some((entry) => entry.includes('Start a fresh Pi session, then retry exactly the original command: /autopilot demo e2e saved')), mode);
        pi.allowModelSelection = true;
        await pi.emitSessionStart(ctx);
        await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo e2e saved', ctx);
        assert.equal(resolveCalls, 2, mode);
        assert.equal(prepareCalls, 1, mode);
        assert.equal(pi.modelSelections, 1, mode);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('does not fence blocked setup saves', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'roster-blocked-save-e2e-'));
    const project = join(root, 'project');
    try {
      await initGitProject(project);
      const pi = new FakePi();
      let resolution: AutopilotRosterActivationResolution = { status: 'setup-required', source: 'agent-first-onboarding', diagnostics: [] };
      let resolveCalls = 0;
      let prepareCalls = 0;
      autopilotExtension(pi, {
        rosterActivationStore: { resolve: async () => { resolveCalls += 1; return resolution; } },
        createRosterSetupTool: () => fakeSetupBundle('blocked'),
        prepareAutopilotWorkstream: async () => { prepareCalls += 1; return fakePrepared(); },
        publishRuntimeRosterSnapshot: async () => ({ schema_version: 'autopilot.runtime_roster_snapshot_publication_result.v1', ok: true, status: 'published', selection_sha256: SELECTION_SHA, mirror_path: '/tmp/mirror.json', idempotent_replay: false, diagnostics: [], write_count: 1, lock_count: 0, files_touched: ['/tmp/mirror.json'] }),
        attachSessionBridge: async () => true,
      });
      const ctx = makeContext(pi, project);
      await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo e2e saved', ctx);
      await pi.emitInput('approve setup', ctx);
      await pi.tools.find((tool) => tool.name === SETUP_TOOL_NAME)?.execute?.('tool-call', setupSaveRequest(), undefined, undefined, ctx);
      pi.allowModelSelection = true;
      resolution = readyResolution();
      await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo e2e saved', ctx);
      assert.equal(resolveCalls, 2);
      assert.equal(prepareCalls, 1);
      assert.equal(pi.modelSelections, 1);
      assert.equal(pi.notifications.some((entry) => entry.includes('Start a fresh Pi session')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
