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
import { buildCanonicalPreRunSelection } from '../../src/core/roster/run-selection.ts';
import { buildExistingRunRosterTransitionProposal, type AutopilotSavedRosterRefV1 } from '../../src/core/roster/transition.ts';
import { publishRuntimeRosterSnapshot } from '../../src/core/roster/snapshot.ts';
import { formatAuthorityPath, resolveRosterScopePaths, rosterRevisionPath, type RosterSha256, type SavedRosterRef } from '../../src/core/roster/storage.ts';

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
  registerTool(tool: RegisteredTool): void { this.tools.push(tool); }
  getActiveTools(): readonly string[] { return [...this.activeTools]; }
  setActiveTools(toolNames: readonly string[]): void { this.activeTools.splice(0, this.activeTools.length, ...toolNames); }
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
  const dir = await mkdtemp(join(root, 'roster-transition-e2e-'));
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
  await writeFile(join(project, 'README.md'), '# roster transition activation\n', 'utf8');
  git(project, ['init']);
  git(project, ['config', 'user.email', 'autopilot@example.invalid']);
  git(project, ['config', 'user.name', 'Autopilot Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-m', 'baseline']);
}

function makeContext(pi: FakePi, cwd: string): ExtensionCommandContextLike {
  return {
    cwd,
    ui: { notify: (message) => { pi.events.push(`notify:${message}`); pi.notifications.push(message); } },
    modelRegistry: {
      find(provider: string, modelId: string) {
        pi.events.push(`find:${provider}/${modelId}`);
        return { provider, id: modelId };
      },
    },
    sessionManager: { getSessionId: () => 'transition-session' },
    isIdle: () => true,
    isProjectTrusted: () => true,
  };
}

function seed(candidateId: string) {
  const candidate = SEED_CANDIDATES.find((entry) => entry.candidate_id === candidateId);
  if (candidate === undefined) throw new Error(`missing candidate ${candidateId}`);
  const roster = seedRosterByCandidate(candidate);
  if (roster === null) throw new Error(`missing seed roster ${candidateId}`);
  return roster;
}

function readyRoster(candidateId: string, scope: 'user') {
  const seedRoster = seed(candidateId);
  const withoutHash = {
    ...seedRoster,
    scope,
    selected_scope: scope,
    assignments: seedRoster.assignments.map((assignment) => ({ ...assignment, qualification_state: 'synthetic-test-ready' as const })),
    roster_sha256: ZERO_SHA,
  };
  return parseAutopilotRosterContract('autopilot.roster.v1', {
    ...withoutHash,
    roster_sha256: autopilotRosterContractSha256OmittingOwnField(withoutHash, 'roster_sha256'),
  });
}

async function writeExplicitReadyRosterConfig(stateRoot: string, candidateId: string): Promise<{ readonly ref: SavedRosterRef; readonly config_sha256: RosterSha256 }> {
  const roster = readyRoster(candidateId, 'user');
  const ref: SavedRosterRef = {
    roster_id: roster.roster_id,
    roster_revision: roster.roster_revision,
    roster_sha256: roster.roster_sha256 as RosterSha256,
    assignment_set_sha256: roster.assignment_set_sha256 as RosterSha256,
  };
  const paths = resolveRosterScopePaths({ scope: 'user', stateRoot });
  const rosterPath = rosterRevisionPath(paths, ref);
  await mkdir(dirname(rosterPath), { recursive: true, mode: 0o700 });
  await writeFile(rosterPath, autopilotRosterContractCanonicalJson(roster), { mode: 0o600 });
  await chmod(rosterPath, 0o600);
  const configRef = { ...ref, path: formatAuthorityPath(rosterPath, paths.authorityRoot, paths.authorityDisplayRoot) };
  const configWithoutHash = {
    schema_version: 'autopilot.roster_config.v1' as const,
    scope: 'user' as const,
    default_roster_id: ref.roster_id,
    default_roster_revision: ref.roster_revision,
    default_roster_sha256: ref.roster_sha256,
    rosters: [configRef],
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
  return { ref, config_sha256: config.config_sha256 as RosterSha256 };
}

function transitionRef(label: 'from' | 'to'): AutopilotSavedRosterRefV1 {
  return {
    roster_id: `${label}-roster`,
    roster_revision: 1,
    roster_sha256: `sha256:${(label === 'from' ? 'a' : 'b').repeat(64)}`,
    assignment_set_sha256: `sha256:${(label === 'from' ? 'c' : 'd').repeat(64)}`,
    path: `/authority/${label}-roster.json`,
  };
}

function fakePrepared(input: { readonly project: string; readonly repoKey: string; readonly workstreamRun: string }): PreparedAutopilotWorkstream {
  const main = join(input.project, '..', 'existing-main');
  return {
    repo: { repoRoot: input.project, gitCommonDir: join(input.project, '.git'), repoKey: input.repoKey, headSha: 'abc', targetBranch: 'main', originUrl: null },
    active: {
      schema_version: 'autopilot.active_parent.v2', coordination_authority: 'legacy-path-claims-v1', autopilot_id: `ap-${input.workstreamRun}`, workstream: 'demo', workstream_run: input.workstreamRun,
      repo_key: input.repoKey, source_repo: input.project, git_common_dir: join(input.project, '.git'), worktree_root: join(input.project, '..', 'worktrees'), main_worktree_path: main,
      branch: `autopilot/${input.workstreamRun}`, runtime_root: join(main, '.pi', 'autopilot', 'demo'), target_branch: 'main', target_base_sha: 'abc', origin_url: null,
      pid: 1, boot_id: 'boot', status: 'active', started_at: FIXED_NOW.toISOString(), active_run_epoch: 2, active_epoch_started_at: FIXED_NOW.toISOString(), active_run_receipt_id: 'receipt',
    },
    worktreeRoot: join(input.project, '..', 'worktrees'), taskRoot: dirname(main), mainWorktreePath: main, runtimeRoot: join(main, '.pi', 'autopilot', 'demo'), created: false, resumed: true,
  } as PreparedAutopilotWorkstream;
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

void describe('W5 existing-run roster transition activation e2e', () => {
  void it('pauses a mismatched existing run but blocks a non-certified transition target in production', async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, 'project');
      const rosterStateRoot = join(dir, 'roster-state');
      const runtimeStateRoot = join(dir, 'runtime-state');
      await initGitProject(project);
      await withRuntimeEnv(runtimeStateRoot, async () => {
        const repo = resolveRepoIdentity(project);
        const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: runtimeStateRoot };
        const workstreamRun = 'demo-20260723t000000z-abc123';
        const mainWorktree = join(dir, 'existing-main');
        await mkdir(mainWorktree, { recursive: true, mode: 0o700 });

        const to = await writeExplicitReadyRosterConfig(rosterStateRoot, 'codex-precision-v1');
        const oldRoster = readyRoster('codex-cruise-v1', 'user');
        const oldSelection = buildCanonicalPreRunSelection({
          stateRoot: rosterStateRoot,
          repo_id: repo.repoKey,
          workstream_run: workstreamRun,
          selected: { scope: 'user', roster_id: oldRoster.roster_id, roster_revision: oldRoster.roster_revision, roster_sha256: oldRoster.roster_sha256 as RosterSha256, assignment_set_sha256: oldRoster.assignment_set_sha256 as RosterSha256, config_sha256: to.config_sha256 },
          selected_at: FIXED_NOW.toISOString(),
        });
        await mkdir(dirname(oldSelection.selection_path), { recursive: true, mode: 0o700 });
        await writeFile(oldSelection.selection_path, oldSelection.selection_bytes, { mode: 0o600 });
        await chmod(oldSelection.selection_path, 0o600);
        const mirror = await publishRuntimeRosterSnapshot({ mainWorktreeRoot: mainWorktree, workstream: 'demo', selection_bytes: oldSelection.selection_bytes });
        assert.equal(mirror.ok, true);

        const active: ActiveAutopilotRow = {
          schema_version: 'autopilot.active_parent.v2', coordination_authority: 'legacy-path-claims-v1', autopilot_id: `ap-${workstreamRun}`, workstream: 'demo', workstream_run: workstreamRun,
          repo_key: repo.repoKey, source_repo: repo.repoRoot, git_common_dir: repo.gitCommonDir, worktree_root: worktreeRootForRepo(repo.repoKey, env), main_worktree_path: mainWorktree,
          branch: `autopilot/${workstreamRun}`, runtime_root: join(mainWorktree, '.pi', 'autopilot', 'demo'), target_branch: repo.targetBranch, target_base_sha: repo.headSha, origin_url: repo.originUrl,
          pid: 1, boot_id: 'boot', status: 'active', started_at: FIXED_NOW.toISOString(), active_run_epoch: 1, active_epoch_started_at: FIXED_NOW.toISOString(), active_run_receipt_id: 'receipt',
        };
        const activePath = join(coordinationRootForRepo(repo.repoKey, env), ACTIVE_AUTOPILOTS_FILE);
        await mkdir(dirname(activePath), { recursive: true, mode: 0o700 });
        await writeFile(activePath, JSON.stringify([active], null, 2), { mode: 0o600 });

        let prepareCalls = 0;
        const pi = new FakePi();
        autopilotExtension(pi, {
          rosterStateRoot,
          now: () => FIXED_NOW,
          prepareAutopilotWorkstream: async (input) => {
            prepareCalls += 1;
            assert.equal(input.workstreamRun, workstreamRun);
            assert.equal(input.phase37RosterSelection?.mode, 'existing-run');
            if (input.phase37RosterSelection?.mode !== 'existing-run') throw new Error('expected existing-run selection');
            assert.equal(input.phase37RosterSelection.selection.selection_sha256, oldSelection.selection.selection_sha256);
            return fakePrepared({ project, repoKey: repo.repoKey, workstreamRun });
          },
          publishRuntimeRosterSnapshot: async () => { throw new Error('existing-run transition must not rewrite runtime roster mirror'); },
          attachSessionBridge: async () => true,
        });
        const ctx = makeContext(pi, project);

        await pi.commands.get(AUTOPILOT_COMMAND)?.handler(`demo --roster ${to.ref.roster_id} continue`, ctx);
        assert.equal(prepareCalls, 0);
        assert.equal(pi.messages.length, 0);
        assert.ok(pi.notifications.some((message) => message.includes('Autopilot roster resolution failed closed')));
        const pausedRows = JSON.parse(await readFile(activePath, 'utf8')) as readonly { readonly status: string }[];
        assert.equal(pausedRows[0]?.status, 'paused');
        assert.equal(existsSync(oldSelection.selection_path), true);
        assert.equal(Buffer.from(await readFile(oldSelection.selection_path)).toString('utf8'), Buffer.from(oldSelection.selection_bytes).toString('utf8'));

        await pi.commands.get(AUTOPILOT_COMMAND)?.handler(`demo --roster ${to.ref.roster_id} continue`, ctx);
        assert.equal(prepareCalls, 0);
        assert.equal(pi.events.includes('setModel'), false);
      });
    });
  });

  void it('rejects approval when the active row drifts after presentation', async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, 'project');
      const rosterStateRoot = join(dir, 'roster-state');
      const runtimeStateRoot = join(dir, 'runtime-state');
      await initGitProject(project);
      await withRuntimeEnv(runtimeStateRoot, async () => {
        const repo = resolveRepoIdentity(project);
        const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: runtimeStateRoot };
        const workstreamRun = 'demo-20260723t000000z-def456';
        const mainWorktree = join(dir, 'existing-main-stale');
        await mkdir(mainWorktree, { recursive: true, mode: 0o700 });
        const active: ActiveAutopilotRow = {
          schema_version: 'autopilot.active_parent.v2', coordination_authority: 'legacy-path-claims-v1', autopilot_id: `ap-${workstreamRun}`, workstream: 'demo', workstream_run: workstreamRun,
          repo_key: repo.repoKey, source_repo: repo.repoRoot, git_common_dir: repo.gitCommonDir, worktree_root: worktreeRootForRepo(repo.repoKey, env), main_worktree_path: mainWorktree,
          branch: `autopilot/${workstreamRun}`, runtime_root: join(mainWorktree, '.pi', 'autopilot', 'demo'), target_branch: repo.targetBranch, target_base_sha: repo.headSha, origin_url: repo.originUrl,
          pid: 1, boot_id: 'boot', status: 'paused', started_at: FIXED_NOW.toISOString(), active_run_epoch: 1, active_epoch_started_at: FIXED_NOW.toISOString(), active_run_receipt_id: 'receipt',
        };
        const activePath = join(coordinationRootForRepo(repo.repoKey, env), ACTIVE_AUTOPILOTS_FILE);
        await mkdir(dirname(activePath), { recursive: true, mode: 0o700 });
        await writeFile(activePath, JSON.stringify([active], null, 2), { mode: 0o600 });
        const run = { repo_id: active.repo_key, workstream: active.workstream, workstream_run: active.workstream_run, main_worktree_path: active.main_worktree_path, runtime_root: active.runtime_root, source_repo: active.source_repo };
        const proposal = buildExistingRunRosterTransitionProposal({ stateRoot: rosterStateRoot, run, from_roster: transitionRef('from'), to_roster: transitionRef('to'), reason: 'stale active test', approved_at: FIXED_NOW.toISOString() });
        const pi = new FakePi();
        autopilotExtension(pi, {
          rosterStateRoot,
          rosterActivationStore: { resolve: async () => ({ status: 'transition-approval-required' as const, source: 'existing-run-selection' as const, proposal, run, active, originalCommand: '/autopilot demo --roster to-roster', diagnostics: [] }) },
        });
        const ctx = makeContext(pi, project);
        await pi.commands.get(AUTOPILOT_COMMAND)?.handler('demo --roster to-roster', ctx);
        assert.ok(pi.messages[0]?.includes('existing-run roster transition approval required'));
        await writeFile(activePath, JSON.stringify([{ ...active, status: 'active' }], null, 2), { mode: 0o600 });
        const result = await pi.emitInput(proposal.approval_phrase, 'user', ctx) as { readonly action?: string } | undefined;
        assert.equal(result?.action, 'handled');
        assert.ok(pi.notifications.some((message) => message.includes('active run identity/status drifted')));
        assert.equal(existsSync(proposal.transition_path), false);
      });
    });
  });
});
