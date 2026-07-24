// Shared worktree-saga test harness (Phase 40 / D70 change C4).
//
// Extracted VERBATIM from tests/unit/worktree-saga-recovery.test.ts so its 27
// saga-recovery tests can be sharded across sibling files without changing a
// single assertion or subprocess behaviour. Every export here is a PURE helper
// or an immutable type — there is NO module-level mutable state — so importing
// it from multiple concurrent test files is race-free (node:test runs one
// process per file). `setup`/`close`/`git`/`gitInput`/`unitCreateSpec` are
// byte-identical to the pre-split originals.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationRun, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { writeCoordinatorSessionContext, type CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { AUTOPILOT_STATE_ROOT_ENV, type ActiveAutopilotRow, type ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

export interface Harness {
  readonly root: string;
  readonly stateRoot: string;
  readonly repo: string;
  readonly env: ProcessEnvLike;
  readonly active: ActiveAutopilotRow;
  readonly session: CoordinatorSessionContext;
  readonly server: Awaited<ReturnType<typeof startCoordinatorServer>>;
}

export function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function gitInput(cwd: string, args: readonly string[], input: string): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', input });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export async function setup(suffix = 'a', testHooks?: Parameters<typeof startCoordinatorServer>[3]): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `pi-autopilot-saga-${suffix}-`));
  const stateRoot = join(root, 'state');
  const repo = join(root, 'generic-repository');
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'docs'), { recursive: true });
  await writeFile(join(repo, 'src', 'base.ts'), 'export const base = true;\n', 'utf8');
  await writeFile(join(repo, 'docs', 'context.md'), '# Context\n', 'utf8');
  await writeFile(join(repo, 'docs', 'pointer.bin'), 'version https://git-lfs.github.com/spec/v1\noid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsize 42\n', 'utf8');
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'autopilot@example.invalid']);
  git(repo, ['config', 'user.name', 'Autopilot Test']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'baseline']);
  const repoId = `repo-${suffix}`;
  const runId = `run-${suffix}`;
  const workstream = `work-${suffix}`;
  const autopilotId = `autopilot-${suffix}`;
  const taskRoot = join(stateRoot, 'worktrees', repoId, 'active', runId);
  const mainPath = join(taskRoot, 'main');
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot };
  const server = await startCoordinatorServer(coordinatorRuntimePaths(env), undefined, undefined, testHooks);
  const client = new CoordinatorClient({ env, autoStart: false });
  const runResponse = await client.mutate('attach-run', {
    repoId, workstreamRun: runId, sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: `attach-${runId}`,
  }, {
    repo_key: repoId, canonical_root: repo, git_common_dir: join(repo, '.git'), autopilot_id: autopilotId, workstream, coordination_authority: 'coordinator-edit-leases-v1',
    run_resource: {
      schema_version: 'autopilot.coordination_run_resource.v1', repo_id: repoId, workstream_run: runId,
      source_repo: repo, git_common_dir: join(repo, '.git'), worktree_root: join(stateRoot, 'worktrees', repoId), main_worktree_path: mainPath,
      runtime_root: join(mainPath, '.pi', 'autopilot', workstream), branch: `autopilot/${runId}`, target_branch: 'master', target_base_sha: git(repo, ['rev-parse', 'HEAD']), origin_url: null,
      started_at: '2026-07-11T00:00:00.000Z', version: 1,
    },
  });
  const run = parseCoordinationRun(runResponse.payload['run']);
  const token = suffix.charCodeAt(0).toString(16).slice(-1).repeat(64);
  const sessionResponse = await client.mutate('attach-session', {
    repoId, workstreamRun: runId, sessionId: `session-${suffix}`, fencingGeneration: 1, expectedVersion: run.version, idempotencyKey: `session-${runId}`,
  }, { session_lease_id: `lease-${suffix}`, session_token: token, pid: process.pid, boot_id: `boot-${suffix}`, lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });
  const attachedRun = parseCoordinationRun(sessionResponse.payload['run']);
  const lease = parseCoordinationSessionLease(sessionResponse.payload['session']);
  const session: CoordinatorSessionContext = {
    schema_version: 'autopilot.coordinator_session_context.v1', state_root: stateRoot, repo_id: repoId, repo_key: repoId,
    autopilot_id: autopilotId, workstream, workstream_run: runId, session_id: lease.session_id,
    session_generation: lease.session_generation, run_version: attachedRun.version, session_lease_id: lease.session_lease_id,
    session_token: token, session_version: lease.version, pid: lease.pid, boot_id: lease.boot_id,
  };
  const contextPath = join(stateRoot, 'test-session.json');
  await writeCoordinatorSessionContext(contextPath, session);
  const active: ActiveAutopilotRow = {
    schema_version: 'autopilot.active_parent.v2', coordination_authority: 'coordinator-edit-leases-v1', autopilot_id: autopilotId, workstream, workstream_run: runId, repo_key: repoId,
    source_repo: repo, git_common_dir: join(repo, '.git'), worktree_root: join(stateRoot, 'worktrees', repoId), main_worktree_path: mainPath,
    branch: `autopilot/${runId}`, runtime_root: join(mainPath, '.pi', 'autopilot', workstream), target_branch: 'master',
    target_base_sha: git(repo, ['rev-parse', 'HEAD']), origin_url: null, pid: process.pid, boot_id: `boot-${suffix}`, status: 'active',
    started_at: '2026-07-11T00:00:00.000Z', active_run_epoch: 1, active_epoch_started_at: '2026-07-11T00:00:00.000Z', active_run_receipt_id: `receipt-${suffix}`,
  };
  return { root, stateRoot, repo, env: { ...env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: contextPath }, active, session, server };
}

export async function close(value: Harness): Promise<void> {
  await value.server.close();
  await rm(value.root, { recursive: true, force: true });
}

export function unitCreateSpec(value: Harness, unit = 'unit-a') {
  const worktreePath = join(value.stateRoot, 'worktrees', value.active.repo_key, 'active', value.active.workstream_run, 'units', unit, 'attempt-1', 'worktree');
  const branch = `autopilot/unit/${value.active.workstream_run}/${unit}/attempt-1`;
  return {
    active: value.active, unitId: unit, attempt: 1, kind: 'unit' as const, operationType: 'create' as const,
    initialWorktreeState: 'planned' as const, committedWorktreeState: 'active' as const,
    intent: {
      repo_root: value.repo, worktree_path: worktreePath, git_common_dir: join(value.repo, '.git'), branch,
      reason: `create ${unit}`, base_sha: value.active.target_base_sha, target_sha: null, archive_ref: null,
      checkout_mode: 'full' as const, sparse_patterns: [], paths: [], metadata_refs: [],
    },
  };
}
