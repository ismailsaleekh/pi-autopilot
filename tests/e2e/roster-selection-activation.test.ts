import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import autopilotExtension, { type AutopilotParentToolDefinition, type ExtensionCommandContextLike, type ExtensionCommandDefinitionLike, type ExtensionHostLike, type ExtensionInputHandler, type ExtensionLifecycleHandler, type ExtensionResourcesDiscoverHandler, type ExtensionToolCallHandler } from '../../src/extension.ts';
import { AUTOPILOT_COMMAND } from '../../src/core/names.ts';
import {
  ACTIVE_AUTOPILOTS_FILE,
  AUTOPILOT_STATE_ROOT_ENV,
  coordinationRootForRepo,
  resolveRepoIdentity,
  worktreeRootForRepo,
  type ActiveAutopilotRow,
  type PreparedAutopilotWorkstream,
  type ProcessEnvLike,
} from '../../src/core/parallel-runtime.ts';
import { autopilotRosterContractCanonicalJson, autopilotRosterContractSha256OmittingOwnField, parseAutopilotRosterContract } from '../../src/core/roster/contracts.ts';
import { SEED_CANDIDATES, seedRosterByCandidate } from '../../src/core/roster/provider-recipes.ts';
import { type Digest } from '../../src/core/roster/route-policies.ts';
import { buildCanonicalPreRunSelection } from '../../src/core/roster/run-selection.ts';
import { publishRuntimeRosterSnapshot, runtimeRosterSnapshotPath } from '../../src/core/roster/snapshot.ts';
import { renderRosterSetupApprovalPresentation } from '../../src/core/roster/setup-tool.ts';
import { formatAuthorityPath, resolveRosterScopePaths, rosterRevisionPath, type RosterSha256, type SavedRosterRef } from '../../src/core/roster/storage.ts';

const SETUP_TOOL_NAME = 'autopilot_manage_rosters';
const ZERO_SHA = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const;
const FIXED_NOW = new Date('2026-07-23T00:00:00.000Z');

type RegisteredHandler = ExtensionToolCallHandler | ExtensionLifecycleHandler | ExtensionResourcesDiscoverHandler | ExtensionInputHandler;
type RegisteredTool = AutopilotParentToolDefinition;

class FakePi implements ExtensionHostLike {
  readonly commands = new Map<string, ExtensionCommandDefinitionLike>();
  readonly tools: RegisteredTool[] = [];
  readonly activeTools: string[] = [];
  readonly messages: string[] = [];
  readonly notifications: string[] = [];
  readonly events: string[] = [];
  readonly handlers = new Map<string, RegisteredHandler[]>();
  thinking = 'off';

  registerCommand(name: string, definition: ExtensionCommandDefinitionLike): void { this.commands.set(name, definition); }
  registerTool(tool: RegisteredTool): void { this.events.push(`registerTool:${tool.name}`); this.tools.push(tool); }
  getActiveTools(): readonly string[] { return [...this.activeTools]; }
  setActiveTools(toolNames: readonly string[]): void { this.events.push(`setActiveTools:${toolNames.join(',')}`); this.activeTools.splice(0, this.activeTools.length, ...toolNames); }
  async setModel(): Promise<boolean> { this.events.push('setModel'); return true; }
  getThinkingLevel(): string { return this.thinking; }
  setThinkingLevel(level: 'high' | 'xhigh'): void { this.events.push(`setThinking:${level}`); this.thinking = level; }
  sendUserMessage(content: string): void { this.events.push('sendUserMessage'); this.messages.push(content); }
  on(eventName: string, handler: RegisteredHandler): void {
    const list = this.handlers.get(eventName) ?? [];
    list.push(handler);
    this.handlers.set(eventName, list);
  }
  async emitInput(text: string, source: string, ctx: ExtensionCommandContextLike): Promise<unknown> {
    let result: unknown;
    for (const handler of this.handlers.get('input') ?? []) result = await (handler as ExtensionInputHandler)({ text, source }, ctx);
    return result;
  }
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const root = await realpath(tmpdir());
  const dir = await mkdtemp(join(root, 'roster-selection-activation-'));
  try {
    await chmod(dir, 0o700);
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function initGitProject(project: string): Promise<void> {
  await mkdir(project, { recursive: true, mode: 0o700 });
  await writeFile(join(project, 'README.md'), '# roster selection activation\n', 'utf8');
  git(project, ['init']);
  git(project, ['config', 'user.email', 'autopilot@example.invalid']);
  git(project, ['config', 'user.name', 'Autopilot Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-m', 'baseline']);
}

function makeContext(pi: FakePi, cwd: string, trusted = true): ExtensionCommandContextLike {
  return {
    cwd,
    ui: { notify: (message) => { pi.events.push(`notify:${message}`); pi.notifications.push(message); } },
    modelRegistry: {
      find(provider: string, modelId: string) {
        pi.events.push(`find:${provider}/${modelId}`);
        return { provider, id: modelId };
      },
      getAll() {
        return [
          { provider: 'openai-codex', id: 'gpt-5.6-sol', api: 'openai-codex-responses', reasoning: true, thinkingLevelMap: { high: 'high', xhigh: 'xhigh' }, input: ['text', 'image'], contextWindow: 512000, maxTokens: 65536 },
          { provider: 'openai-codex', id: 'gpt-5.6-terra', api: 'openai-codex-responses', reasoning: true, thinkingLevelMap: { high: 'high' }, input: ['text'], contextWindow: 512000, maxTokens: 65536 },
          { provider: 'openai-codex', id: 'gpt-5.6-luna', api: 'openai-codex-responses', reasoning: true, thinkingLevelMap: { high: 'high' }, input: ['text'], contextWindow: 256000, maxTokens: 32768 },
          { provider: 'openai-codex', id: 'gpt-5.5', api: 'openai-codex-responses', reasoning: true, thinkingLevelMap: { high: 'high' }, input: ['text'], contextWindow: 256000, maxTokens: 32768 },
        ];
      },
      getProviderAuthStatus(provider: string) {
        assert.equal(provider, 'openai-codex');
        return { configured: true, source: 'stored' };
      },
    },
    sessionManager: { getSessionId: () => 'e2e-session' },
    isIdle: () => true,
    isProjectTrusted: () => trusted,
  };
}

function cruiseSeed() {
  const candidate = SEED_CANDIDATES.find((entry) => entry.candidate_id === 'codex-cruise-v1');
  if (candidate === undefined) throw new Error('missing cruise seed candidate');
  const seed = seedRosterByCandidate(candidate);
  if (seed === null) throw new Error('missing cruise seed roster');
  return { candidate, seed };
}

async function writeReadyDefaultRoster(stateRoot: string): Promise<{ readonly ref: SavedRosterRef; readonly config_sha256: Digest }> {
  const { seed } = cruiseSeed();
  const readyWithoutHash = {
    ...seed,
    assignments: seed.assignments.map((assignment) => ({ ...assignment, qualification_state: 'synthetic-test-ready' as const })),
    roster_sha256: ZERO_SHA,
  };
  const readyRoster = parseAutopilotRosterContract('autopilot.roster.v1', {
    ...readyWithoutHash,
    roster_sha256: autopilotRosterContractSha256OmittingOwnField(readyWithoutHash, 'roster_sha256'),
  });
  const ref: SavedRosterRef = {
    roster_id: readyRoster.roster_id,
    roster_revision: readyRoster.roster_revision,
    roster_sha256: readyRoster.roster_sha256 as RosterSha256,
    assignment_set_sha256: readyRoster.assignment_set_sha256 as RosterSha256,
  };
  const paths = resolveRosterScopePaths({ scope: 'user', stateRoot });
  const rosterPath = rosterRevisionPath(paths, ref);
  await mkdir(dirname(rosterPath), { recursive: true, mode: 0o700 });
  await writeFile(rosterPath, autopilotRosterContractCanonicalJson(readyRoster), { mode: 0o600 });
  await chmod(rosterPath, 0o600);

  const rosters = [{ ...ref, path: formatAuthorityPath(rosterPath, paths.authorityRoot, paths.authorityDisplayRoot) }];
  const configWithoutHash = {
    schema_version: 'autopilot.roster_config.v1' as const,
    scope: 'user' as const,
    default_roster_id: ref.roster_id,
    default_roster_revision: ref.roster_revision,
    default_roster_sha256: ref.roster_sha256,
    rosters,
    previous_config_sha256: null,
    updated_at: FIXED_NOW.toISOString(),
    config_sha256: ZERO_SHA,
  };
  const config = parseAutopilotRosterContract('autopilot.roster_config.v1', {
    ...configWithoutHash,
    config_sha256: autopilotRosterContractSha256OmittingOwnField(configWithoutHash, 'config_sha256'),
  });
  await mkdir(dirname(paths.configPath), { recursive: true, mode: 0o700 });
  await writeFile(paths.configPath, autopilotRosterContractCanonicalJson(config), { mode: 0o600 });
  await chmod(paths.configPath, 0o600);
  return { ref, config_sha256: config.config_sha256 as Digest };
}

function fakePrepared(input: { readonly project: string; readonly repoKey: string; readonly workstreamRun: string }): PreparedAutopilotWorkstream {
  const main = join(input.project, '..', 'fake-main-worktree');
  return {
    repo: { repoRoot: input.project, gitCommonDir: join(input.project, '.git'), repoKey: input.repoKey, headSha: 'abc', targetBranch: 'main', originUrl: null },
    active: {
      schema_version: 'autopilot.active_parent.v2', coordination_authority: 'legacy-path-claims-v1', autopilot_id: `ap-${input.workstreamRun}`, workstream: 'demo', workstream_run: input.workstreamRun,
      repo_key: input.repoKey, source_repo: input.project, git_common_dir: join(input.project, '.git'), worktree_root: join(input.project, '..', 'worktrees'), main_worktree_path: main,
      branch: `autopilot/${input.workstreamRun}`, runtime_root: join(main, '.pi', 'autopilot', 'demo'), target_branch: 'main', target_base_sha: 'abc', origin_url: null,
      pid: 1, boot_id: 'boot', status: 'active', started_at: FIXED_NOW.toISOString(), active_run_epoch: 1, active_epoch_started_at: FIXED_NOW.toISOString(), active_run_receipt_id: 'receipt',
    },
    worktreeRoot: join(input.project, '..', 'worktrees'), taskRoot: dirname(main), mainWorktreePath: main, runtimeRoot: join(main, '.pi', 'autopilot', 'demo'), created: true, resumed: false,
  } as PreparedAutopilotWorkstream;
}

function approvalFields(candidateSet: unknown): {
  readonly candidate_set_sha256: Digest;
  readonly approved_roster_sha256s: readonly Digest[];
  readonly default_roster_id: string;
  readonly default_roster_revision: number;
  readonly default_roster_sha256: Digest;
} {
  if (typeof candidateSet !== 'object' || candidateSet === null) throw new Error('candidate set missing');
  const set = candidateSet as { readonly candidate_set_sha256: Digest; readonly recommended_profile_id: string; readonly candidates: readonly { readonly profile_id: string; readonly roster_sha256: Digest; readonly roster_id: string; readonly roster_revision: number }[] };
  const defaultCandidate = set.candidates.find((candidate) => candidate.profile_id === set.recommended_profile_id) ?? set.candidates[0];
  if (defaultCandidate === undefined) throw new Error('expected candidate');
  return {
    candidate_set_sha256: set.candidate_set_sha256,
    approved_roster_sha256s: set.candidates.map((candidate) => candidate.roster_sha256),
    default_roster_id: defaultCandidate.roster_id,
    default_roster_revision: defaultCandidate.roster_revision,
    default_roster_sha256: defaultCandidate.roster_sha256,
  };
}

async function withRuntimeEnv<T>(runtimeStateRoot: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env[AUTOPILOT_STATE_ROOT_ENV];
  process.env[AUTOPILOT_STATE_ROOT_ENV] = runtimeStateRoot;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
    else process.env[AUTOPILOT_STATE_ROOT_ENV] = previous;
  }
}

void describe('Phase 37 roster selection activation e2e', () => {
  void it('blocks a saved synthetic-ready default before workstream preparation or parent model selection', async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, 'project');
      const rosterStateRoot = join(dir, 'roster-state');
      const runtimeStateRoot = join(dir, 'runtime-state');
      await initGitProject(project);
      await writeReadyDefaultRoster(rosterStateRoot);
      await withRuntimeEnv(runtimeStateRoot, async () => {
        const pi = new FakePi();
        autopilotExtension(pi, {
          rosterStateRoot,
          now: () => FIXED_NOW,
          prepareAutopilotWorkstream: async () => { pi.events.push('prepare'); throw new Error('prepare must not run for untrusted roster authority'); },
          publishRuntimeRosterSnapshot: async () => { pi.events.push('publish-snapshot'); throw new Error('snapshot must not publish for untrusted roster authority'); },
          attachSessionBridge: async () => { pi.events.push('attach'); return true; },
        });

        await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo ship selection', makeContext(pi, project));

        const ordered = pi.events.filter((event) => ['prepare', 'publish-snapshot', 'setModel', 'attach', 'sendUserMessage'].includes(event) || event.startsWith('find:'));
        assert.deepEqual(ordered, []);
        assert.equal(pi.messages.length, 0);
        assert.ok(pi.notifications.some((message) => /Autopilot roster resolution failed closed/u.test(message)));
      });
    });
  });

  void it('rejects extension-source approval, unlaunchable save, and arbitrary public state roots', async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, 'project');
      const rosterStateRoot = join(dir, 'roster-state');
      const runtimeStateRoot = join(dir, 'runtime-state');
      const arbitraryRoot = join(dir, 'arbitrary-root');
      await initGitProject(project);
      await withRuntimeEnv(runtimeStateRoot, async () => {
        const pi = new FakePi();
        autopilotExtension(pi, { rosterStateRoot, now: () => FIXED_NOW });
        const ctx = makeContext(pi, project);
        await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo needs setup', ctx);
        const setupTool = pi.tools.find((tool) => tool.name === SETUP_TOOL_NAME);
        assert.notEqual(setupTool, undefined);
        const activationToken = /Activation token: (setup:[A-Za-z0-9._:-]+)/u.exec(pi.messages[0] ?? '')?.[1];
        assert.equal(typeof activationToken, 'string');
        if (typeof activationToken !== 'string' || setupTool?.execute === undefined) throw new Error('setup activation missing');

        const baseRequest = {
          schema_version: 'autopilot.roster_tool_request.v1', action: 'propose', activation_token: activationToken, approval_token: null, scope: 'user', trusted_project_root: null,
          candidate_set_sha256: null, approved_roster_sha256s: [], default_roster_id: null, default_roster_revision: null, default_roster_sha256: null, original_command: '/autopilot demo needs setup',
        };
        const proposal = await setupTool.execute('propose', baseRequest, undefined, undefined, ctx) as { readonly details: { readonly candidate_set: unknown; readonly ok: boolean } };
        assert.equal(proposal.details.ok, false);
        const fields = approvalFields(proposal.details.candidate_set);
        const presentation = renderRosterSetupApprovalPresentation({ scope: 'user', original_command: '/autopilot demo needs setup', ...fields });

        const extensionAttempt = await pi.emitInput(presentation, 'extension', ctx) as { readonly action?: string; readonly text?: string } | undefined;
        assert.equal(extensionAttempt?.action, 'continue');
        assert.equal(/approval_token:/u.test(extensionAttempt?.text ?? ''), false);

        const userAttempt = await pi.emitInput(presentation, 'user', ctx) as { readonly action?: string; readonly text?: string } | undefined;
        assert.equal(userAttempt?.action, 'transform');
        const approvalToken = /approval_token: (approval:[A-Za-z0-9._:-]+)/u.exec(userAttempt?.text ?? '')?.[1];
        assert.equal(typeof approvalToken, 'string');
        if (typeof approvalToken !== 'string') throw new Error('approval token missing');

        const rejectedRoot = await setupTool.execute('save-extra', { ...baseRequest, action: 'save', ...fields, approval_token: approvalToken, state_root_override: arbitraryRoot }, undefined, undefined, ctx) as { readonly details: { readonly ok: boolean; readonly status: string; readonly write_count: number } };
        assert.equal(rejectedRoot.details.ok, false);
        assert.equal(rejectedRoot.details.status, 'failed');
        assert.equal(existsSync(arbitraryRoot), false);

        const blocked = await setupTool.execute('save', { ...baseRequest, action: 'save', ...fields, approval_token: approvalToken }, undefined, undefined, ctx) as { readonly details: { readonly ok: boolean; readonly status: string; readonly write_count: number; readonly diagnostics: readonly { readonly code: string }[] } };
        assert.equal(blocked.details.ok, false);
        assert.equal(blocked.details.status, 'blocked');
        assert.equal(blocked.details.write_count, 0);
        assert.ok(blocked.details.diagnostics.map((diagnostic) => diagnostic.code).includes('ROSTER_QUALIFICATION_REQUIRED'));
        assert.equal(existsSync(rosterStateRoot), false);
      });
    });
  });

  void it('fails closed on existing-run discovery errors before setup or runtime state creation', async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, 'not-a-git-project');
      const rosterStateRoot = join(dir, 'roster-state');
      const runtimeStateRoot = join(dir, 'runtime-state');
      await mkdir(project, { recursive: true, mode: 0o700 });
      await withRuntimeEnv(runtimeStateRoot, async () => {
        const pi = new FakePi();
        autopilotExtension(pi, { rosterStateRoot, now: () => FIXED_NOW, prepareAutopilotWorkstream: async () => { throw new Error('prepare must not run'); } });
        await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo blocked', makeContext(pi, project));
        assert.equal(pi.tools.some((tool) => tool.name === SETUP_TOOL_NAME), false);
        assert.equal(pi.messages.length, 0);
        assert.equal(existsSync(rosterStateRoot), false);
        assert.equal(existsSync(runtimeStateRoot), false);
        assert.ok(pi.notifications.some((message) => message.includes('ROSTER_TRANSITION_REQUIRED')));
      });
    });
  });

  void it('uses recovery for existing runs and blocks mirror drift without falling through to ready defaults', async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, 'project');
      const rosterStateRoot = join(dir, 'roster-state');
      const runtimeStateRoot = join(dir, 'runtime-state');
      await initGitProject(project);
      const ready = await writeReadyDefaultRoster(rosterStateRoot);
      await withRuntimeEnv(runtimeStateRoot, async () => {
        const repo = resolveRepoIdentity(project);
        const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: runtimeStateRoot };
        const workstreamRun = 'demo-20260723t000000z-drift1';
        const mainWorktree = join(dir, 'existing-main');
        await mkdir(mainWorktree, { recursive: true, mode: 0o700 });
        const selection = buildCanonicalPreRunSelection({
          stateRoot: rosterStateRoot,
          repo_id: repo.repoKey,
          workstream_run: workstreamRun,
          selected: { scope: 'user', roster_id: ready.ref.roster_id, roster_revision: ready.ref.roster_revision, roster_sha256: ready.ref.roster_sha256, assignment_set_sha256: ready.ref.assignment_set_sha256, config_sha256: ready.config_sha256 as RosterSha256 },
          selected_at: FIXED_NOW.toISOString(),
        });
        await mkdir(dirname(selection.selection_path), { recursive: true, mode: 0o700 });
        await writeFile(selection.selection_path, selection.selection_bytes, { mode: 0o600 });
        await chmod(selection.selection_path, 0o600);
        const mirror = await publishRuntimeRosterSnapshot({ mainWorktreeRoot: mainWorktree, workstream: 'demo', selection_bytes: selection.selection_bytes });
        assert.equal(mirror.ok, true);
        const mirrorPath = runtimeRosterSnapshotPath({ mainWorktreeRoot: mainWorktree, workstream: 'demo' });
        await writeFile(mirrorPath, '{"tampered":true}\n', { mode: 0o600 });

        const row: ActiveAutopilotRow = {
          schema_version: 'autopilot.active_parent.v2', coordination_authority: 'legacy-path-claims-v1', autopilot_id: `ap-${workstreamRun}`, workstream: 'demo', workstream_run: workstreamRun,
          repo_key: repo.repoKey, source_repo: repo.repoRoot, git_common_dir: repo.gitCommonDir, worktree_root: worktreeRootForRepo(repo.repoKey, env), main_worktree_path: mainWorktree,
          branch: `autopilot/${workstreamRun}`, runtime_root: join(mainWorktree, '.pi', 'autopilot', 'demo'), target_branch: repo.targetBranch, target_base_sha: repo.headSha, origin_url: repo.originUrl,
          pid: 1, boot_id: 'boot', status: 'active', started_at: FIXED_NOW.toISOString(), active_run_epoch: 1, active_epoch_started_at: FIXED_NOW.toISOString(), active_run_receipt_id: 'receipt',
        };
        const activePath = join(coordinationRootForRepo(repo.repoKey, env), ACTIVE_AUTOPILOTS_FILE);
        await mkdir(dirname(activePath), { recursive: true, mode: 0o700 });
        await writeFile(activePath, JSON.stringify([row], null, 2), { mode: 0o600 });

        let prepareCalls = 0;
        const pi = new FakePi();
        autopilotExtension(pi, { rosterStateRoot, now: () => FIXED_NOW, prepareAutopilotWorkstream: async () => { prepareCalls += 1; return fakePrepared({ project, repoKey: repo.repoKey, workstreamRun }); } });
        await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo should-block', makeContext(pi, project));
        assert.equal(prepareCalls, 0);
        assert.equal(pi.messages.length, 0);
        assert.ok(pi.notifications.some((message) => message.includes('ROSTER_TRANSITION_REQUIRED')));
        assert.ok(pi.notifications.some((message) => message.includes('ROSTER_PINNED_SELECTION_UNAVAILABLE') || message.includes('ROSTER_READBACK_MISMATCH')));
      });
    });
  });
});
