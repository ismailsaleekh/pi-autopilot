import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessLite } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationRun, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { writeCoordinatorSessionContext, type CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { OwnedWorktreeSagaClient } from '../../src/core/coordination/worktree-saga.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ActiveAutopilotRow, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

function closeResult(child: ChildProcessLite): Promise<number | null> {
  return new Promise((resolveClose) => child.on('close', (code) => resolveClose(code)));
}

async function runClient(activePath: string, env: ProcessEnvLike): Promise<void> {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(packageRoot, 'tests', 'helpers', 'saga-process-client.ts'), activePath], { cwd: packageRoot, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const code = await closeResult(child);
  if (code !== 0) throw new Error(`saga client exited ${String(code)}: ${stderr}`);
}

void describe('owner-scoped worktree saga multiprocess execution', () => {
  void it('serializes two recovery executors and creates one branch/worktree/effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-saga-process-'));
    const stateRoot = join(root, 'state');
    const repo = join(root, 'generic-repository');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'base.ts'), 'export const base = true;\n', 'utf8');
    git(repo, ['init']); git(repo, ['config', 'user.email', 'autopilot@example.invalid']); git(repo, ['config', 'user.name', 'Autopilot Test']); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'baseline']);
    const env: ProcessEnvLike = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
    const server = await startCoordinatorServer(coordinatorRuntimePaths(env));
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const repoId = 'repo-process'; const runId = 'run-process'; const autopilotId = 'autopilot-process';
      const runResponse = await client.mutate('attach-run', { repoId, workstreamRun: runId, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-process' }, {
        repo_key: repoId, canonical_root: repo, git_common_dir: join(repo, '.git'), autopilot_id: autopilotId, workstream: 'work-process', coordination_authority: 'coordinator-edit-leases-v1',
        run_resource: {
          schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: runId,
          source_repo: repo, git_common_dir: join(repo, '.git'), worktree_root: join(stateRoot, 'worktrees', repoId),
          main_worktree_path: join(stateRoot, 'worktrees', repoId, 'active', runId, 'main'),
          runtime_root: join(stateRoot, 'worktrees', repoId, 'active', runId, 'main', '.pi', 'autopilot', 'work-process'),
          branch: `autopilot/${runId}`, target_branch: 'master', target_base_sha: git(repo, ['rev-parse', 'HEAD']), origin_url: null,
          started_at: '2026-07-11T00:00:00.000Z', version: 1,
        },
      });
      const run = parseCoordinationRun(runResponse.payload['run']);
      const token = 'e'.repeat(64);
      const sessionResponse = await client.mutate('attach-session', { repoId, workstreamRun: runId, sessionId: 'session-process', fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: 'attach-session-process' }, { session_lease_id: 'lease-process', session_token: token, pid: process.pid, boot_id: 'boot-process', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });
      const attachedRun = parseCoordinationRun(sessionResponse.payload['run']); const lease = parseCoordinationSessionLease(sessionResponse.payload['session']);
      const context: CoordinatorSessionContext = { schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: repoId, repo_key: repoId, autopilot_id: autopilotId, workstream: 'work-process', workstream_run: runId, session_id: lease.session_id, session_generation: lease.session_generation, run_version: attachedRun.version, session_lease_id: lease.session_lease_id, session_token: token, session_version: lease.version, pid: lease.pid, boot_id: lease.boot_id };
      const contextPath = join(stateRoot, 'session.json'); await writeCoordinatorSessionContext(contextPath, context);
      const taskRoot = join(stateRoot, 'worktrees', repoId, 'active', runId); const unitPath = join(taskRoot, 'units', 'unit-process', 'attempt-1', 'worktree');
      const active: ActiveAutopilotRow = { schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1', autopilot_id: autopilotId, workstream: 'work-process', workstream_run: runId, repo_key: repoId, source_repo: repo, git_common_dir: join(repo, '.git'), worktree_root: join(stateRoot, 'worktrees', repoId), main_worktree_path: join(taskRoot, 'main'), branch: `autopilot/${runId}`, runtime_root: join(taskRoot, 'main', '.pi', 'autopilot', 'work-process'), target_branch: 'master', target_base_sha: git(repo, ['rev-parse', 'HEAD']), origin_url: null, pid: process.pid, boot_id: 'boot-process', status: 'active', started_at: '2026-07-11T00:00:00.000Z', active_run_epoch: 1, active_epoch_started_at: '2026-07-11T00:00:00.000Z', active_run_receipt_id: 'receipt-process' };
      const childEnv = { ...env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: contextPath };
      const saga = new OwnedWorktreeSagaClient(client, context);
      await saga.prepare({ active, unitId: 'unit-process', attempt: 1, kind: 'unit', operationType: 'create', operationKey: 'multiprocess-create', initialWorktreeState: 'planned', committedWorktreeState: 'active', intent: { repo_root: repo, worktree_path: unitPath, git_common_dir: join(repo, '.git'), branch: `autopilot/unit/${runId}/unit-process/attempt-1`, reason: 'multiprocess create', base_sha: active.target_base_sha, target_sha: null, archive_ref: null, checkout_mode: 'full', sparse_patterns: [], paths: [], metadata_refs: [] } });
      const activePath = join(root, 'active.json'); await writeFile(activePath, `${JSON.stringify(active)}\n`, 'utf8');
      await Promise.all([runClient(activePath, childEnv), runClient(activePath, childEnv)]);
      assert.equal(git(repo, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).map((line) => realpathSync(line.slice('worktree '.length))).filter((path) => path === realpathSync(unitPath)).length, 1);
      assert.equal(git(repo, ['show-ref', '--verify', '--hash', `refs/heads/autopilot/unit/${runId}/unit-process/attempt-1`]), active.target_base_sha);
      const status = await client.query('status', repoId, runId);
      const operations = status.payload['worktree_operations'];
      assert.equal(Array.isArray(operations) && operations.length === 1, true);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
