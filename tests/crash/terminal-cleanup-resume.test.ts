import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessLite } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { AUTOPILOT_TERMINAL_CLEANUP_BOUNDARIES, abortAutopilotWorkstream, closeAutopilotWorkstream, type AutopilotTerminalCleanupBoundary } from '../../src/core/close-runtime.ts';
import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { DurableRunSupervisorClient } from '../../src/core/coordination/supervisor.ts';
import { ensureMainWorktreeSagaRegistered } from '../../src/core/coordination/worktree-saga.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { AUTOPILOT_STATE_ROOT_ENV, prepareAutopilotUnitWorktree, prepareAutopilotWorkstream, updateUnitBranchStatus } from '../../src/core/parallel-runtime.ts';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const processClient = fileURLToPath(new URL('../helpers/terminal-cleanup-process-client.ts', import.meta.url));

type TerminalAction = 'close' | 'abort';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function initRepo(repo: string): Promise<void> {
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, '.gitignore'), '.pi/\n', 'utf8');
  await writeFile(join(repo, 'src', 'base.ts'), 'export const base = true;\n', 'utf8');
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'autopilot@example.invalid']);
  git(repo, ['config', 'user.name', 'Autopilot Test']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'baseline']);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function archiveLegacyAndCutOver(stateRoot: string, repoKey: string): Promise<void> {
  const legacySource = join(stateRoot, 'coordination', repoKey);
  const legacyArchive = join(stateRoot, 'legacy', repoKey);
  if (existsSync(legacySource)) {
    await mkdir(dirname(legacyArchive), { recursive: true });
    await rename(legacySource, legacyArchive);
  }
  await writeJson(join(stateRoot, 'cutovers', `${repoKey}.json`), {
    schema_version: 'autopilot.coordination_cutover.v1', repo_key: repoKey,
    snapshot_sha256: `sha256:${'c'.repeat(64)}`, database_sha256: `sha256:${'d'.repeat(64)}`,
    committed_at: '2026-07-12T00:00:00.000Z', migration_id: `terminal-cleanup-${repoKey.slice(-12)}`,
  });
}

async function waitForCrash(child: ChildProcessLite): Promise<{ readonly code: number | null; readonly stderr: string }> {
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  return await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

async function runBoundary(action: TerminalAction, boundary: AutopilotTerminalCleanupBoundary): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `pi-autopilot-terminal-${action}-${boundary}-`));
  const stateRoot = join(root, 'state');
  const repo = join(root, 'repo');
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: undefined };
  const priorState = process.env[AUTOPILOT_STATE_ROOT_ENV];
  const priorContext = process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  process.env[AUTOPILOT_STATE_ROOT_ENV] = stateRoot;
  delete process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  let server: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
  try {
    await initRepo(repo);
    server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    const workstream = `cleanup-${action}`;
    const prepared = await prepareAutopilotWorkstream({ workstream, sourceCwd: repo, coordinationSessionId: `bootstrap-${action}`, env });
    const attachment = await new DurableRunSupervisorClient(env).attach({ repo: prepared.repo, active: prepared.active, rawSessionId: `setup-${action}` });
    const setupEnv = { ...env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath };
    await ensureMainWorktreeSagaRegistered({ active: prepared.active, env: setupEnv });
    const unit = await prepareAutopilotUnitWorktree({ active: prepared.active, unitId: 'terminal-unit', attempt: 1, env: setupEnv });
    await updateUnitBranchStatus({ active: prepared.active, unitId: 'terminal-unit', attempt: 1, status: 'superseded', currentSha: git(unit.unitInfo.worktree_path, ['rev-parse', 'HEAD']), archiveRef: null });
    await archiveLegacyAndCutOver(stateRoot, prepared.active.repo_key);

    const child = spawn(process.execPath, ['--experimental-strip-types', processClient, action, repo, workstream, prepared.active.workstream_run, boundary], {
      cwd: packageRoot, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    const crashed = await waitForCrash(child);
    assert.equal(crashed.code, 86, `${action}/${boundary} did not reach its crash boundary: ${crashed.stderr}`);

    const recover = action === 'close' ? closeAutopilotWorkstream : abortAutopilotWorkstream;
    const result = await recover({ workstream, sourceCwd: repo, workstreamRun: prepared.active.workstream_run, coordinationSessionId: `recovery-${action}-${boundary}`, env });
    assert.equal(result.outcome, action === 'close' ? 'closed' : 'aborted');
    assert.equal(existsSync(prepared.taskRoot), false, `${action}/${boundary} retained active task state`);
    assert.equal(existsSync(result.close_result_path ?? ''), true, `${action}/${boundary} lost final result projection`);
    const status = await new CoordinatorClient({ env, autoStart: false }).query('status', prepared.active.repo_key, prepared.active.workstream_run);
    const runs = status.payload['runs'];
    if (!Array.isArray(runs) || typeof runs[0] !== 'object' || runs[0] === null) throw new Error('terminal run status missing');
    assert.equal((runs[0] as Record<string, unknown>)['status'], action === 'close' ? 'closed' : 'aborted');
    const worktrees = status.payload['worktrees'];
    if (!Array.isArray(worktrees)) throw new Error('terminal worktree status missing');
    const main = worktrees.find((entry) => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['kind'] === 'main') as Record<string, unknown> | undefined;
    assert.equal(main?.['state'], 'removed');
    assert.equal(existsSync(join(stateRoot, 'legacy', prepared.active.repo_key)), true);
    assert.equal(existsSync(join(stateRoot, 'coordination', prepared.active.repo_key, 'active-autopilots.json')), false, 'post-cutover recovery recreated mutable legacy authority');
  } finally {
    if (server !== null) await server.close();
    if (priorState === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV]; else process.env[AUTOPILOT_STATE_ROOT_ENV] = priorState;
    if (priorContext === undefined) delete process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]; else process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = priorContext;
    await rm(root, { recursive: true, force: true });
  }
}

void describe('post-terminal close/abort process-death recovery', () => {
  for (const action of ['close', 'abort'] as const) {
    for (const boundary of AUTOPILOT_TERMINAL_CLEANUP_BOUNDARIES) {
      void it(`${action} resumes after real process death at ${boundary}`, async () => {
        await runBoundary(action, boundary);
      });
    }
  }
});
