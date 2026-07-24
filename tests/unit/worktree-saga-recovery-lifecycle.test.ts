// Sharded from tests/unit/worktree-saga-recovery.test.ts (Phase 40 / D70 change C4).
// Test bodies are byte-identical to the originals; only the file boundary and
// the shared-helper import changed. Same describe name preserves test identity.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { parseCoordinationRun, parseCoordinationSessionLease } from '../../src/core/coordination/contracts.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { writeCoordinatorSessionContext, type CoordinatorSessionContext } from '../../src/core/coordination/supervisor.ts';
import { executeOwnedWorktreeSaga, OwnedWorktreeSagaClient, recoverOwnedWorktreeSagas } from '../../src/core/coordination/worktree-saga.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV } from '../../src/core/names.ts';
import { git, setup, close, unitCreateSpec } from '../helpers/worktree-saga-harness.ts';

void describe('owner-scoped worktree and Git saga recovery', () => {
  void it('safely compensates an interrupted conflicting merge at its exact pre-merge HEAD', async () => {
    const value = await setup('c');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const unit = unitCreateSpec(value, 'unit-conflict');
      await saga.prepare(unit);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      await writeFile(join(unit.intent.worktree_path, 'src', 'base.ts'), 'export const unit = true;\n', 'utf8');
      git(unit.intent.worktree_path, ['add', 'src/base.ts']);
      git(unit.intent.worktree_path, ['commit', '-m', 'unit conflicting change']);
      const sourceHead = git(unit.intent.worktree_path, ['rev-parse', 'HEAD']);
      const main = { ...unit, unitId: 'main', kind: 'main' as const, intent: { ...unit.intent, worktree_path: value.active.main_worktree_path, branch: value.active.branch, reason: 'create conflict main' } };
      await saga.prepare(main);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      await writeFile(join(main.intent.worktree_path, 'src', 'base.ts'), 'export const main = true;\n', 'utf8');
      git(main.intent.worktree_path, ['add', 'src/base.ts']);
      git(main.intent.worktree_path, ['commit', '-m', 'main conflicting change']);
      const mainBase = git(main.intent.worktree_path, ['rev-parse', 'HEAD']);
      const merge = { ...main, operationType: 'merge' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const, intent: { ...main.intent, reason: 'interrupted conflict compensation witness', base_sha: mainBase, target_sha: sourceHead, checkout_mode: null, paths: ['src/base.ts'] } };
      await saga.prepare(merge);
      const conflicted = spawnSync('git', ['merge', '--no-ff', '--no-edit', sourceHead], { cwd: main.intent.worktree_path, encoding: 'utf8' });
      assert.notEqual(conflicted.status, 0);
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: value.active, env: value.env }), /restored to its exact pre-merge HEAD/u);
      assert.equal(git(main.intent.worktree_path, ['rev-parse', 'HEAD']), mainBase);
      assert.equal(git(main.intent.worktree_path, ['status', '--porcelain']), '');
      assert.equal((await saga.operations()).find((operation) => operation.operation_type === 'merge')?.stage, 'compensated');
    } finally {
      await close(value);
    }
  });


  void it('recovers final target fast-forward response loss across coordinator restart', async () => {
    const value = await setup('j');
    let replacement: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const mainCreate = {
        active: value.active, unitId: 'main', attempt: 1, kind: 'main' as const, operationType: 'create' as const,
        initialWorktreeState: 'planned' as const, committedWorktreeState: 'active' as const,
        intent: { repo_root: value.repo, worktree_path: value.active.main_worktree_path, git_common_dir: join(value.repo, '.git'), branch: value.active.branch, reason: 'create close recovery main', base_sha: value.active.target_base_sha, target_sha: null, archive_ref: null, checkout_mode: 'full' as const, sparse_patterns: [], paths: [], metadata_refs: [] },
      };
      await saga.prepare(mainCreate);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      await writeFile(join(value.active.main_worktree_path, 'src', 'close.ts'), 'export const close = true;\n', 'utf8');
      git(value.active.main_worktree_path, ['add', 'src/close.ts']);
      git(value.active.main_worktree_path, ['commit', '-m', 'validated close result']);
      const desired = git(value.active.main_worktree_path, ['rev-parse', 'HEAD']);
      const targetBefore = git(value.repo, ['rev-parse', 'HEAD']);
      const finalMerge = {
        ...mainCreate, operationType: 'merge' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
        intent: { ...mainCreate.intent, reason: 'final target fast-forward response loss witness', base_sha: targetBefore, target_sha: desired, archive_ref: git(value.repo, ['rev-parse', '--abbrev-ref', 'HEAD']) },
      };
      await saga.prepare(finalMerge);
      git(value.repo, ['merge', '--ff-only', desired]);
      await value.server.close();
      replacement = await startCoordinatorServer(coordinatorRuntimePaths(value.env));
      const recovered = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recovered.some((operation) => operation.operation_id.includes('operation-') && operation.operation_type === 'merge' && operation.stage === 'committed'), true);
      assert.equal(git(value.repo, ['rev-parse', 'HEAD']), desired);
    } finally {
      await value.server.close().catch(() => undefined);
      if (replacement !== null) await replacement.close();
      await rm(value.root, { recursive: true, force: true });
    }
  });


  void it('queues durable owner recovery on coordinator restart and resumes before dispatch', async () => {
    const value = await setup('r');
    let restarted: Awaited<ReturnType<typeof startCoordinatorServer>> | null = null;
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const spec = unitCreateSpec(value, 'unit-r');
      await saga.prepare(spec);
      await value.server.close();
      restarted = await startCoordinatorServer(coordinatorRuntimePaths(value.env));
      const client = new CoordinatorClient({ env: value.env, autoStart: false });
      const status = await client.query('status', value.active.repo_key, value.active.workstream_run);
      assert.equal(typeof status.payload['pending_messages'] === 'number' && status.payload['pending_messages'] > 0, true);
      const doctor = await client.query('doctor');
      const incomplete = doctor.payload['incomplete_worktree_operations'];
      assert.equal(Array.isArray(incomplete) && incomplete.length === 1, true);
      const recovered = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recovered[0]?.stage, 'committed');
      assert.equal(existsSync(spec.intent.worktree_path), true);
    } finally {
      if (restarted !== null) await restarted.close();
      await close(value);
    }
  });


  void it('repairs only exact owned stale Git metadata without globally pruning foreign entries', async () => {
    const value = await setup('l');
    try {
      const saga = new OwnedWorktreeSagaClient(new CoordinatorClient({ env: value.env, autoStart: false }), value.session);
      const create = unitCreateSpec(value, 'unit-stale-metadata');
      await saga.prepare(create);
      await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      const terminalSha = git(create.intent.worktree_path, ['rev-parse', 'HEAD']);
      const foreignPath = join(value.root, 'foreign-run-worktree');
      git(value.repo, ['worktree', 'add', '-b', 'foreign/run-l', foreignPath, value.active.target_base_sha]);
      await rm(foreignPath, { recursive: true, force: false });
      await rm(create.intent.worktree_path, { recursive: true, force: false });
      assert.equal(git(value.repo, ['worktree', 'list', '--porcelain']).includes(create.intent.worktree_path), true);
      await saga.prepare({ ...create, operationType: 'remove', initialWorktreeState: 'terminal', committedWorktreeState: 'removed', intent: { ...create.intent, reason: 'exact stale metadata repair witness', target_sha: terminalSha } });
      const recovered = await recoverOwnedWorktreeSagas({ active: value.active, env: value.env });
      assert.equal(recovered.some((operation) => operation.operation_type === 'remove' && operation.stage === 'committed'), true);
      const afterList = git(value.repo, ['worktree', 'list', '--porcelain']);
      assert.equal(afterList.includes(create.intent.worktree_path), false, afterList);
      assert.equal(afterList.includes(foreignPath), true, 'owner recovery globally pruned foreign stale metadata');
      assert.equal(git(value.repo, ['branch', '--list', 'foreign/run-l']).includes('foreign/run-l'), true);
      assert.equal(git(value.repo, ['branch', '--list', create.intent.branch]), '');
    } finally {
      await close(value);
    }
  });


  void it('fences the old saga executor across session handoff and lets only the new owner generation recover', async () => {
    const value = await setup('k');
    try {
      const client = new CoordinatorClient({ env: value.env, autoStart: false });
      const saga = new OwnedWorktreeSagaClient(client, value.session);
      const create = unitCreateSpec(value, 'unit-handoff');
      await saga.prepare(create);
      const handoff = await client.mutate('prepare-handoff', {
        repoId: value.session.repo_id, workstreamRun: value.session.workstream_run, sessionId: value.session.session_id, fencingGeneration: value.session.session_generation,
        expectedVersion: value.session.session_version, idempotencyKey: 'prepare-saga-handoff',
      }, { handoff_token: 'handoff-saga-k', session_lease_id: value.session.session_lease_id, session_token: value.session.session_token });
      const handoffLease = parseCoordinationSessionLease(handoff.payload['session']);
      assert.equal(handoffLease.status, 'handoff-pending');
      const nextToken = 'c'.repeat(64);
      const attached = await client.mutate('attach-session', {
        repoId: value.session.repo_id, workstreamRun: value.session.workstream_run, sessionId: 'session-k-next', fencingGeneration: 2,
        expectedVersion: value.session.run_version, idempotencyKey: 'attach-saga-handoff-next',
      }, { session_lease_id: 'lease-k-next', session_token: nextToken, pid: process.pid, boot_id: 'boot-k-next', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });
      const nextRun = parseCoordinationRun(attached.payload['run']);
      const nextLease = parseCoordinationSessionLease(attached.payload['session']);
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: value.active, env: value.env }), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'fenced-session');
      assert.equal(existsSync(create.intent.worktree_path), false);
      const nextContext: CoordinatorSessionContext = { ...value.session, session_id: nextLease.session_id, session_generation: nextLease.session_generation, run_version: nextRun.version, session_lease_id: nextLease.session_lease_id, session_token: nextToken, session_version: nextLease.version, boot_id: nextLease.boot_id };
      const nextContextPath = join(value.stateRoot, 'next-session.json');
      await writeCoordinatorSessionContext(nextContextPath, nextContext);
      const nextEnv = { ...value.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: nextContextPath };
      const recovered = await recoverOwnedWorktreeSagas({ active: value.active, env: nextEnv });
      assert.equal(recovered.some((operation) => operation.owner.unit_id === 'unit-handoff' && operation.stage === 'committed'), true);
      assert.equal(existsSync(create.intent.worktree_path), true);
    } finally {
      await close(value);
    }
  });


  void it('preserves dirty work, then permits exact owned quarantine and removal without touching a foreign run', async () => {
    const value = await setup('a');
    const foreign = await setup('b');
    try {
      const spec = unitCreateSpec(value);
      const callbacks = {
        action: () => { git(value.repo, ['worktree', 'add', '-b', spec.intent.branch, spec.intent.worktree_path, value.active.target_base_sha]); },
      };
      const ownedCreate = await executeOwnedWorktreeSaga(spec, callbacks, value.env);
      if (ownedCreate.operation === null) throw new Error('owned create operation missing');
      let unauthorizedActionRan = false;
      const noSessionEnv = { ...value.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: undefined };
      const noSessionSpec = unitCreateSpec(value, 'unit-no-session');
      await assert.rejects(() => executeOwnedWorktreeSaga(noSessionSpec, { action: () => { unauthorizedActionRan = true; } }, noSessionEnv), /coordinator-authoritative run is missing its durable session/u);
      assert.equal(unauthorizedActionRan, false);
      const sharedClient = new CoordinatorClient({ env: value.env, autoStart: false });
      const peerRunResponse = await sharedClient.mutate('attach-run', {
        repoId: value.active.repo_key, workstreamRun: 'run-peer', sessionId: null, fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-peer',
      }, {
        repo_key: value.active.repo_key, canonical_root: value.repo, git_common_dir: join(value.repo, '.git'), autopilot_id: 'autopilot-peer', workstream: 'work-peer', coordination_authority: 'coordinator-edit-leases-v1',
        run_resource: {
          schema_version: 'autopilot.coordination_run_resource.v1', repo_id: value.active.repo_key, workstream_run: 'run-peer',
          source_repo: value.repo, git_common_dir: join(value.repo, '.git'), worktree_root: join(value.stateRoot, 'worktrees', value.active.repo_key),
          main_worktree_path: join(value.stateRoot, 'worktrees', value.active.repo_key, 'active', 'run-peer', 'main'), runtime_root: join(value.stateRoot, 'worktrees', value.active.repo_key, 'active', 'run-peer', 'main', '.pi', 'autopilot', 'work-peer'),
          branch: 'autopilot/run-peer', target_branch: 'master', target_base_sha: value.active.target_base_sha, origin_url: null,
          started_at: '2026-07-11T00:00:00.000Z', version: 1,
        },
      });
      const peerRun = parseCoordinationRun(peerRunResponse.payload['run']);
      const peerToken = 'f'.repeat(64);
      await sharedClient.mutate('attach-session', {
        repoId: value.active.repo_key, workstreamRun: 'run-peer', sessionId: 'session-peer', fencingGeneration: 1, expectedVersion: peerRun.version, idempotencyKey: 'attach-session-peer',
      }, { session_lease_id: 'lease-peer', session_token: peerToken, pid: process.pid, boot_id: 'boot-peer', lease_expires_at: '2099-01-01T00:00:00.000Z', handoff_token: null });
      await assert.rejects(
        () => sharedClient.mutate('transition-operation', {
          repoId: value.active.repo_key, workstreamRun: 'run-peer', sessionId: 'session-peer', fencingGeneration: 1,
          expectedVersion: ownedCreate.operation?.version ?? 0, idempotencyKey: 'foreign-transition-attempt',
        }, { operation_id: ownedCreate.operation?.operation_id ?? 'missing', stage: 'reconciling', completed_steps: [], current_step: 'foreign', recovery_attempts: 0, verification_evidence: null, error_code: 'recovery-required', worktree_state: 'active', session_lease_id: 'lease-peer', session_token: peerToken }),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'unauthorized-client',
      );
      const foreignSpec = unitCreateSpec(foreign, 'unit-b');
      await executeOwnedWorktreeSaga(foreignSpec, {
        action: () => { git(foreign.repo, ['worktree', 'add', '-b', foreignSpec.intent.branch, foreignSpec.intent.worktree_path, foreign.active.target_base_sha]); },
      }, foreign.env);
      await writeFile(join(spec.intent.worktree_path, 'src', 'dirty.ts'), 'dirty\n', 'utf8');
      const removeSpec = { ...spec, operationType: 'remove' as const, initialWorktreeState: 'active' as const, committedWorktreeState: 'removed' as const, intent: { ...spec.intent, reason: 'remove terminal unit', target_sha: git(spec.intent.worktree_path, ['rev-parse', 'HEAD']) } };
      await assert.rejects(
        () => executeOwnedWorktreeSaga(removeSpec, { action: () => undefined }, value.env),
        (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'recovery-required',
      );
      assert.equal(existsSync(join(spec.intent.worktree_path, 'src', 'dirty.ts')), true);
      assert.equal(existsSync(foreignSpec.intent.worktree_path), true);
      await assert.rejects(() => recoverOwnedWorktreeSagas({ active: foreign.active, env: value.env }), /does not own|session does not own/u);
      assert.equal(existsSync(foreignSpec.intent.worktree_path), true);
    } finally {
      await close(value);
      await close(foreign);
    }
  });
});
