import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CoordinatorClient } from '../../src/core/coordination/client.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { CoordinatorWriterGuard } from '../../src/core/coordination/writer-guard.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: () => void = () => { throw new Error('deferred resolver was used before initialization'); };
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: () => resolvePromise() };
}

function openIdleSocket(path: string): Promise<Socket> {
  const socket = connect(path);
  return new Promise<Socket>((resolveConnection, rejectConnection) => {
    const onError = (error: Error): void => rejectConnection(error);
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      resolveConnection(socket);
    });
  });
}

void describe('S1 ordered coordinator shutdown', () => {
  void it('retires idle sockets without hanging before store, lifecycle, and writer authority teardown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s1-idle-shutdown-'));
    const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root });
    const server = await startCoordinatorServer(paths);
    try {
      const databasePath = server.store.currentGeneration().database_path;
      const socket = await openIdleSocket(paths.socketPath);
      const socketClosed = new Promise<void>((resolveClose) => socket.once('close', resolveClose));
      await Promise.all([server.close(), socketClosed]);
      assert.equal(existsSync(paths.lockPath), false);
      assert.equal(existsSync(`${databasePath}-wal`), false);
      assert.equal(existsSync(`${databasePath}-shm`), false);
      const reacquired = await CoordinatorWriterGuard.acquire(paths, 100);
      reacquired.release();
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('keeps store, lifecycle, and writer authority until a committed in-flight response finishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-s1-inflight-shutdown-'));
    const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root };
    const paths = coordinatorRuntimePaths(env);
    const enteredHook = deferred();
    const releaseHook = deferred();
    const server = await startCoordinatorServer(paths, undefined, undefined, {
      afterStoreCommitBeforeResponse: async (action) => {
        if (action !== 'attach-run') return;
        enteredHook.resolve();
        await releaseHook.promise;
      },
    });
    try {
      const client = new CoordinatorClient({ env, autoStart: false });
      const mutation = client.mutate('attach-run', {
        repoId: 'repo-shutdown-order', workstreamRun: 'run-shutdown-order', sessionId: null,
        fencingGeneration: null, expectedVersion: 0, idempotencyKey: 'attach-run-shutdown-order',
      }, {
        repo_key: 'repo-shutdown-order', canonical_root: join(root, 'repository'), git_common_dir: join(root, 'repository', '.git'),
        autopilot_id: 'autopilot-shutdown-order', workstream: 'shutdown-order', coordination_authority: 'coordinator-edit-leases-v1',
        run_resource: {
          schema_version: 'autopilot.coordination_run_resource.v1', repo_id: 'repo-shutdown-order', workstream_run: 'run-shutdown-order',
          source_repo: join(root, 'repository'), git_common_dir: join(root, 'repository', '.git'), worktree_root: join(root, 'worktrees'),
          main_worktree_path: join(root, 'worktrees', 'main'), runtime_root: join(root, 'runtime'), branch: 'autopilot/run-shutdown-order',
          target_branch: null, target_base_sha: 'a'.repeat(40), origin_url: null, started_at: '2026-07-16T04:00:00.000Z', version: 1,
        },
      });
      await enteredHook.promise;
      let closed = false;
      const closing = server.close().then(() => { closed = true; });
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
      assert.equal(closed, false);
      assert.equal(existsSync(paths.lockPath), true);
      await assert.rejects(() => CoordinatorWriterGuard.acquire(paths, 10), /SQLite writer guard acquisition failed/u);
      releaseHook.resolve();
      const response = await mutation;
      assert.equal(response.ok, true);
      await closing;
      assert.equal(existsSync(paths.lockPath), false);
      const reacquired = await CoordinatorWriterGuard.acquire(paths, 100);
      reacquired.release();
    } finally {
      releaseHook.resolve();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
