import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import autopilotExtension, {
  trustedProjectForRequest,
  type AutopilotRosterActivationResolution,
  type ExtensionCommandContextLike,
  type ExtensionCommandDefinitionLike,
  type ExtensionHostLike,
  type ExtensionModelLike,
  type ExtensionToolCallHandler,
  type ExtensionLifecycleHandler,
  type ExtensionResourcesDiscoverHandler,
  type ExtensionInputHandler,
  type AutopilotRosterSetupToolBundle,
} from '../../src/extension.ts';
import { AUTOPILOT_COMMAND, AUTOPILOT_INJECT_COMMAND, CONTEXT_BUDGET_TOOL_NAME } from '../../src/core/names.ts';
import { parseAutopilotArgs } from '../../src/core/paths.ts';
import {
  autopilotRosterContractCanonicalJson,
  autopilotRosterContractSha256OmittingOwnField,
  parseAutopilotRosterContract,
} from '../../src/core/roster/contracts.ts';
import { buildUserCustomRosterFromAssignments } from '../../src/core/roster/custom-certification.ts';
import { SEED_ROSTERS, type Assignment, type Roster } from '../../src/core/roster/provider-recipes.ts';
import { canonicalSha256, rosterDiagnostic } from '../../src/core/roster/route-policies.ts';
import { formatAuthorityPath, resolveRosterScopePaths, rosterRevisionPath, type RosterSha256, type SavedRosterRef } from '../../src/core/roster/storage.ts';
import { publishCreateOnlyAtomic, publishReplaceAtomic } from '../../src/core/roster/transaction.ts';
import type { PreparedAutopilotWorkstream } from '../../src/core/parallel-runtime.ts';
import { verifyAutopilotRosterSetupSkillPackageRoot, type VerifiedAutopilotRosterSetupSkillPackage } from '../../src/core/roster/skill-package.ts';
import { createAutopilotRosterSetupTool } from '../../src/core/roster/setup-tool.ts';

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

  async emitInput(text: string, source = 'user'): Promise<Awaited<ReturnType<ExtensionInputHandler>> | undefined> {
    const ctx = makeContext(this.events);
    let latest: Awaited<ReturnType<ExtensionInputHandler>> | undefined;
    for (const handler of this.handlers.get('input') ?? []) {
      latest = await (handler as ExtensionInputHandler)({ text, source }, ctx);
    }
    return latest;
  }
}

function fakePackage(): VerifiedAutopilotRosterSetupSkillPackage {
  return verifyAutopilotRosterSetupSkillPackageRoot(fileURLToPath(new URL('../../', import.meta.url)));
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

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'roster-activation-custom-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function readyCustomRoster(): Roster {
  const seed = SEED_ROSTERS.find((entry) => entry.recipe_id === 'kimi-coding-plan');
  if (seed === undefined) throw new Error('missing seed roster');
  return buildUserCustomRosterFromAssignments({
    slug: 'activation-block',
    display_name: 'Activation custom block',
    scope: 'user',
    profile_id: 'precision',
    assignments: seed.assignments.map((assignment) => rehashAssignment(assignment, { qualification_state: 'w4-certified-ready' })),
    created_at: '2026-07-24T00:00:00.000Z',
  });
}

function rehashAssignment(assignment: Assignment, patch: Partial<Omit<Assignment, 'assignment_sha256'>>): Assignment {
  const withoutHash = {
    role: patch.role ?? assignment.role,
    provider_id: patch.provider_id ?? assignment.provider_id,
    model_id: patch.model_id ?? assignment.model_id,
    model: patch.model ?? assignment.model,
    api: patch.api ?? assignment.api,
    thinking: patch.thinking ?? assignment.thinking,
    service_tier: patch.service_tier ?? assignment.service_tier,
    cache_policy: patch.cache_policy ?? assignment.cache_policy,
    system_prompt_profile: patch.system_prompt_profile ?? assignment.system_prompt_profile,
    context_window: patch.context_window ?? assignment.context_window,
    max_output_tokens: patch.max_output_tokens ?? assignment.max_output_tokens,
    input_modalities: patch.input_modalities ?? assignment.input_modalities,
    output_modalities: patch.output_modalities ?? assignment.output_modalities,
    reasoning_capability: patch.reasoning_capability ?? assignment.reasoning_capability,
    tool_capability: patch.tool_capability ?? assignment.tool_capability,
    route_policy_id: patch.route_policy_id ?? assignment.route_policy_id,
    route_policy_revision: patch.route_policy_revision ?? assignment.route_policy_revision,
    billing_class: patch.billing_class ?? assignment.billing_class,
    billing_route_class: patch.billing_route_class ?? assignment.billing_route_class,
    auth_class: patch.auth_class ?? assignment.auth_class,
    auth_source: patch.auth_source ?? assignment.auth_source,
    qualification_state: patch.qualification_state ?? assignment.qualification_state,
  } satisfies Omit<Assignment, 'assignment_sha256'>;
  return { ...withoutHash, assignment_sha256: canonicalSha256(withoutHash) };
}

async function writeUserDefaultRoster(stateRoot: string, roster: Roster): Promise<void> {
  const paths = resolveRosterScopePaths({ scope: 'user', stateRoot });
  const parsedRoster = parseAutopilotRosterContract('autopilot.roster.v1', roster);
  const rosterBytes = new TextEncoder().encode(autopilotRosterContractCanonicalJson(parsedRoster));
  const ref: SavedRosterRef = {
    roster_id: roster.roster_id,
    roster_revision: roster.roster_revision,
    roster_sha256: roster.roster_sha256 as RosterSha256,
    assignment_set_sha256: roster.assignment_set_sha256 as RosterSha256,
  };
  const rosterPath = rosterRevisionPath(paths, ref);
  await mkdir(dirname(rosterPath), { recursive: true, mode: 0o700 });
  const rosterPublish = await publishCreateOnlyAtomic({ path: rosterPath, authorityRoot: paths.authorityRoot, bytes: rosterBytes });
  assert.notEqual(rosterPublish.status, 'conflict');
  const configWithoutHash = {
    schema_version: 'autopilot.roster_config.v1' as const,
    scope: 'user' as const,
    default_roster_id: roster.roster_id,
    default_roster_revision: roster.roster_revision,
    default_roster_sha256: roster.roster_sha256,
    rosters: [{ ...ref, path: formatAuthorityPath(rosterPath, paths.authorityRoot, paths.authorityDisplayRoot) }],
    previous_config_sha256: null,
    updated_at: '2026-07-24T00:00:00.000Z',
    config_sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  const config = {
    ...configWithoutHash,
    config_sha256: autopilotRosterContractSha256OmittingOwnField(configWithoutHash, 'config_sha256'),
  };
  const parsedConfig = parseAutopilotRosterContract('autopilot.roster_config.v1', config);
  await publishReplaceAtomic({ path: paths.configPath, authorityRoot: paths.authorityRoot, bytes: new TextEncoder().encode(autopilotRosterContractCanonicalJson(parsedConfig)) });
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

function setupToolResult(originalCommand: string, status: 'saved' | 'replay' | 'blocked'): SetupToolDetails {
  if (status === 'blocked') {
    const preimage = {
      schema_version: 'autopilot.roster_tool_result.v1' as const,
      action: 'save' as const,
      ok: false,
      status: 'blocked' as const,
      candidate_set: null,
      receipt: null,
      diagnostics: [rosterDiagnostic('ROSTER_STORAGE_TRUST_REQUIRED')],
      write_count: 0,
      lock_count: 0,
      files_touched: [],
    };
    return checkedSetupToolDetails(parseAutopilotRosterContract('autopilot.roster_tool_result.v1', { ...preimage, result_sha256: canonicalSha256(preimage) }));
  }
  const savedRef = {
    roster_id: ROSTER_ID,
    roster_revision: 1,
    roster_sha256: ROSTER_SHA,
    assignment_set_sha256: ASSIGNMENT_SHA,
    path: `~/.pi/agent/autopilot/rosters/${ROSTER_ID}/revision-1.json`,
  };
  const receiptPreimage = {
    schema_version: 'autopilot.roster_setup_receipt.v1' as const,
    receipt_id: status === 'replay' ? 'receipt-restart-fence-replay' : 'receipt-restart-fence-saved',
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
  const preimage = {
    schema_version: 'autopilot.roster_tool_result.v1' as const,
    action: 'save' as const,
    ok: true,
    status: 'saved' as const,
    candidate_set: null,
    receipt,
    diagnostics: [],
    write_count: status === 'replay' ? 0 : 3,
    lock_count: 1,
    files_touched: status === 'replay' ? [] : ['/state/rosters/default.json'],
  };
  return checkedSetupToolDetails(parseAutopilotRosterContract('autopilot.roster_tool_result.v1', { ...preimage, result_sha256: canonicalSha256(preimage) }));
}

function fakeSetupBundle(saveStatus: 'saved' | 'replay' | 'blocked'): AutopilotRosterSetupToolBundle {
  const token = 'setup:restart-fence-000000000000000000000000';
  const approvalToken = 'approval:restart-fence-00000000000000000000';
  let active = false;
  let approved = false;
  const base = createAutopilotRosterSetupTool();
  const controller: AutopilotRosterSetupToolBundle['controller'] = {
    activate: () => {
      active = true;
      approved = false;
      return { ok: true, active: true, activation_token: token, session_id: 'session-unit', reason: 'activated' };
    },
    deactivate: (inputToken: string) => {
      if (!active || inputToken !== token) return false;
      active = false;
      approved = false;
      return true;
    },
    isActive: () => active,
    currentActivationToken: () => active ? token : null,
  };
  const hostAuthorization: AutopilotRosterSetupToolBundle['hostAuthorization'] = {
    currentApprovalPresentation: () => active && !approved ? ({
      schema_version: 'autopilot.roster_tool_request.v1',
      activation_token: token,
      scope: 'user',
      candidate_set_sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      approved_roster_sha256s: [ROSTER_SHA],
      default_roster_id: ROSTER_ID,
      default_roster_revision: 1,
      default_roster_sha256: ROSTER_SHA,
      original_command: '/autopilot demo first task',
      presentation_sha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      presentation_text: 'approve restart fence save',
    }) : null,
    authorizeInput: (input) => {
      if (!active) return { ok: false, approval_token: null, reason: 'inactive' };
      if (input.activation_token !== token) return { ok: false, approval_token: null, reason: 'bad-activation-token' };
      if (input.source !== 'user' || input.text.length === 0) return { ok: false, approval_token: null, reason: 'source-not-user' };
      approved = true;
      return { ok: true, approval_token: approvalToken, reason: 'approved' };
    },
  };
  const tool: AutopilotRosterSetupToolBundle['tool'] = {
    ...base.tool,
    async execute(_toolCallId, params) {
      const request = typeof params === 'object' && params !== null ? params as Record<string, unknown> : Object.create(null);
      const originalCommand = typeof request['original_command'] === 'string' ? request['original_command'] : '/autopilot demo first task';
      const details = active && approved && request['action'] === 'save'
        ? setupToolResult(originalCommand, saveStatus)
        : setupToolResult(originalCommand, 'blocked');
      return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
    },
  };
  return { tool, controller, hostAuthorization };
}

function setupSaveRequest(): Record<string, unknown> {
  return {
    schema_version: 'autopilot.roster_tool_request.v1',
    action: 'save',
    activation_token: 'setup:restart-fence-000000000000000000000000',
    approval_token: 'approval:restart-fence-00000000000000000000',
    scope: 'user',
    trusted_project_root: null,
    candidate_set_sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    approved_roster_sha256s: [ROSTER_SHA],
    default_roster_id: ROSTER_ID,
    default_roster_revision: 1,
    default_roster_sha256: ROSTER_SHA,
    original_command: '/autopilot demo first task',
  };
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
    const skillPackage = fakePackage();
    autopilotExtension(pi, {
      rosterActivationStore: { resolve: async () => { events.push('resolve'); return setupRequiredResolution(); } },
      resolveSetupSkillPackage: () => skillPackage,
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
    assert.equal((pi.messages[0] ?? '').includes(skillPackage.skillSha256), true);
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

  void it('rejects caller-supplied trusted-project roots that do not match the current host context before storage', async () => {
    await withTempDir(async (root) => {
      const events: string[] = [];
      const actualRoot = join(root, 'actual');
      const attackerRoot = join(root, 'attacker');
      await mkdir(actualRoot, { recursive: true });
      await mkdir(attackerRoot, { recursive: true });
      const ctx = { ...makeContext(events), cwd: actualRoot, isProjectTrusted: () => true };
      const mismatch = await trustedProjectForRequest({ scope: 'trusted-project', trusted_project_root: attackerRoot }, ctx);
      assert.equal(mismatch.ok, false);
      if (mismatch.ok) throw new Error('trusted-project root mismatch unexpectedly accepted');
      assert.deepEqual(mismatch.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_STORAGE_TRUST_REQUIRED']);

      const match = await trustedProjectForRequest({ scope: 'trusted-project', trusted_project_root: actualRoot }, ctx);
      assert.equal(match.ok, true);
      if (!match.ok) throw new Error('trusted-project root match unexpectedly rejected');
      assert.equal(match.trustedProject?.root, await realpath(actualRoot));
      assert.equal(await match.trustedProject?.isProjectTrusted(), true);
    });
  });

  void it('blocks stored user-custom rosters even when assignments claim ready if exact custom registry authority is absent', async () => {
    await withTempDir(async (stateRoot) => {
      const events: string[] = [];
      let prepareCalls = 0;
      const pi = new FakePi(events);
      await writeUserDefaultRoster(stateRoot, readyCustomRoster());
      autopilotExtension(pi, {
        rosterStateRoot: stateRoot,
        resolveSetupSkillPackage: () => fakePackage(),
        prepareAutopilotWorkstream: async () => { prepareCalls += 1; return fakePrepared(); },
      });

      await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo custom default must block', makeContext(events));

      assert.equal(prepareCalls, 0);
      assert.equal(events.some((event) => event.startsWith('find:')), false);
      assert.equal(events.includes('setModel'), false);
      assert.equal(pi.tools.some((tool) => tool.name === SETUP_TOOL_NAME), false);
      assert.equal(pi.messages.length, 0);
      assert.ok(events.some((event) => event.includes('ROSTER_QUALIFICATION_REQUIRED')));
    });
  });

  void it('fences same-session autopilot and inject after a proven setup save until session_start resets', async () => {
    const events: string[] = [];
    const pi = new FakePi(events);
    let resolution: AutopilotRosterActivationResolution = setupRequiredResolution();
    let resolveCalls = 0;
    let prepareCalls = 0;
    autopilotExtension(pi, {
      rosterActivationStore: { resolve: async () => { resolveCalls += 1; events.push('resolve'); return resolution; } },
      resolveSetupSkillPackage: () => fakePackage(),
      createRosterSetupTool: () => fakeSetupBundle('saved'),
      prepareAutopilotWorkstream: async () => { prepareCalls += 1; events.push('prepare'); return fakePrepared(); },
      publishRuntimeRosterSnapshot: async () => ({ schema_version: 'autopilot.runtime_roster_snapshot_publication_result.v1', ok: true, status: 'published', selection_sha256: SELECTION_SHA, mirror_path: '/tmp/mirror.json', idempotent_replay: false, diagnostics: [], write_count: 1, lock_count: 0, files_touched: ['/tmp/mirror.json'] }),
      attachSessionBridge: async () => { events.push('attach'); return true; },
    });

    await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo first task', makeContext(events));
    assert.equal(resolveCalls, 1);
    assert.equal(pi.activeTools.includes(SETUP_TOOL_NAME), true);
    const approved = await pi.emitInput('I approve this exact setup save.', 'user');
    assert.equal(approved?.action, 'transform');
    const setupTool = pi.tools.find((tool) => tool.name === SETUP_TOOL_NAME);
    assert.notEqual(setupTool?.execute, undefined);
    await setupTool?.execute?.('tool-call', setupSaveRequest(), undefined, undefined, makeContext(events));
    assert.equal(pi.activeTools.includes(SETUP_TOOL_NAME), false);

    resolution = readyResolution();
    const baselineMessages = pi.messages.length;
    await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo first task', makeContext(events));
    await pi.commands.get(AUTOPILOT_INJECT_COMMAND)?.handler('demo', makeContext(events));

    assert.equal(resolveCalls, 1);
    assert.equal(prepareCalls, 0);
    assert.equal(events.some((event) => event.startsWith('find:')), false);
    assert.equal(events.includes('setModel'), false);
    assert.equal(pi.messages.length, baselineMessages);
    assert.ok(events.some((event) => event === 'notify:Autopilot roster setup was saved in this Pi session. Start a fresh Pi session, then retry exactly the original command: /autopilot demo first task'));

    await pi.emitLifecycle('session_start');
    await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo first task', makeContext(events));
    assert.equal(resolveCalls, 2);
    assert.equal(prepareCalls, 1);
    assert.equal(events.includes('setModel'), true);
    assert.equal(events.some((event) => event === 'sendUserMessage'), true);
  });

  void it('fences idempotent saved receipt replay but not blocked setup saves', async () => {
    const replayEvents: string[] = [];
    const replayPi = new FakePi(replayEvents);
    let replayResolveCalls = 0;
    autopilotExtension(replayPi, {
      rosterActivationStore: { resolve: async () => { replayResolveCalls += 1; return setupRequiredResolution(); } },
      resolveSetupSkillPackage: () => fakePackage(),
      createRosterSetupTool: () => fakeSetupBundle('replay'),
    });
    await replayPi.commands.get(AUTOPILOT_COMMAND)?.handler('demo first task', makeContext(replayEvents));
    await replayPi.emitInput('I approve replay save.', 'user');
    await replayPi.tools.find((tool) => tool.name === SETUP_TOOL_NAME)?.execute?.('tool-call', setupSaveRequest(), undefined, undefined, makeContext(replayEvents));
    await replayPi.commands.get(AUTOPILOT_COMMAND)?.handler('demo first task', makeContext(replayEvents));
    assert.equal(replayResolveCalls, 1);
    assert.equal(replayEvents.some((event) => event.includes('Start a fresh Pi session, then retry exactly the original command: /autopilot demo first task')), true);

    const blockedEvents: string[] = [];
    const blockedPi = new FakePi(blockedEvents);
    let blockedResolveCalls = 0;
    let blockedPrepareCalls = 0;
    let blockedResolution: AutopilotRosterActivationResolution = setupRequiredResolution();
    autopilotExtension(blockedPi, {
      rosterActivationStore: { resolve: async () => { blockedResolveCalls += 1; return blockedResolution; } },
      resolveSetupSkillPackage: () => fakePackage(),
      createRosterSetupTool: () => fakeSetupBundle('blocked'),
      prepareAutopilotWorkstream: async () => { blockedPrepareCalls += 1; return fakePrepared(); },
      publishRuntimeRosterSnapshot: async () => ({ schema_version: 'autopilot.runtime_roster_snapshot_publication_result.v1', ok: true, status: 'published', selection_sha256: SELECTION_SHA, mirror_path: '/tmp/mirror.json', idempotent_replay: false, diagnostics: [], write_count: 1, lock_count: 0, files_touched: ['/tmp/mirror.json'] }),
      attachSessionBridge: async () => true,
    });
    await blockedPi.commands.get(AUTOPILOT_COMMAND)?.handler('demo first task', makeContext(blockedEvents));
    await blockedPi.emitInput('I approve blocked save.', 'user');
    await blockedPi.tools.find((tool) => tool.name === SETUP_TOOL_NAME)?.execute?.('tool-call', setupSaveRequest(), undefined, undefined, makeContext(blockedEvents));
    blockedResolution = readyResolution();
    await blockedPi.commands.get(AUTOPILOT_COMMAND)?.handler('demo first task', makeContext(blockedEvents));
    assert.equal(blockedResolveCalls, 2);
    assert.equal(blockedPrepareCalls, 1);
    assert.equal(blockedEvents.some((event) => event.includes('Start a fresh Pi session')), false);
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
