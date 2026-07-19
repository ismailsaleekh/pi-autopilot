import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GIT_STREAM_ENTRY_MAX,
  GIT_STREAM_PATH_MAX_BYTES,
  GIT_STREAM_RECORD_MAX_BYTES,
  GIT_STREAM_WIRE_MAX_BYTES,
  GitStreamingQueryError,
  checkedAdd,
  checkedCeilMultiply,
  checkedMultiply,
  runGitStreamingLsTree,
  type GitLsTreeStreamRecord,
} from '../../src/core/git-process.ts';

import { describe, it } from 'node:test';

async function withTempRepo<T>(run: (repoRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'autopilot-git-stream-test-'));
  try {
    git(repoRoot, ['init']);
    git(repoRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(repoRoot, ['config', 'user.email', 'autopilot@example.invalid']);
    git(repoRoot, ['config', 'user.name', 'Autopilot Test']);
    return await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

function git(repoRoot: string, args: readonly string[], input?: string): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', ...(input === undefined ? {} : { input }) });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function headCommit(repoRoot: string): string {
  return git(repoRoot, ['rev-parse', 'HEAD']);
}

void describe('D58 streaming recursive ls-tree query', () => {
  void it('streams blob, tree (dir), gitlink (submodule placeholder), and executable modes without retaining raw output', async () => {
    await withTempRepo(async (repoRoot) => {
      await mkdir(join(repoRoot, 'subdir'), { recursive: true });
      await writeFile(join(repoRoot, 'README.md'), 'hello\n');
      await writeFile(join(repoRoot, 'run.sh'), '#!/bin/sh\n');
      await chmodReadWrite(join(repoRoot, 'run.sh'));
      await writeFile(join(repoRoot, 'subdir', 'nested.txt'), 'nested\n');
      git(repoRoot, ['add', '.']);
      // Register a gitlink (mode 160000 commit) at vendor/ext using a real commit object.
      const subRepo = await mkdtemp(join(tmpdir(), 'autopilot-git-stream-sub-'));
      try {
        git(subRepo, ['init']);
        git(subRepo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
        git(subRepo, ['config', 'user.email', 'autopilot@example.invalid']);
        git(subRepo, ['config', 'user.name', 'Autopilot Test']);
        await writeFile(join(subRepo, 'marker.txt'), 'x\n');
        git(subRepo, ['add', '.']);
        git(subRepo, ['commit', '-m', 'submodule head']);
        const gitlinkSha = git(subRepo, ['rev-parse', 'HEAD']);
        git(repoRoot, ['update-index', '--add', '--cacheinfo', `160000,${gitlinkSha},vendor/ext`]);
      } finally {
        await rm(subRepo, { recursive: true, force: true });
      }
      git(repoRoot, ['commit', '-m', 'mixed tree']);
      const commit = headCommit(repoRoot);
      const records: GitLsTreeStreamRecord[] = [];
      const summary = await runGitStreamingLsTree({ commit, cwd: repoRoot, onRecord: (record) => { records.push(record); } });
      assert.equal(summary.terminal_state, 'exited');
      assert.equal(summary.exit_code, 0);
      assert.equal(summary.stderr_bytes, 0);
      assert.equal(summary.stderr_sha256, null);
      const byPath = new Map(records.map((record) => [bytesToUtf8(record.path_bytes), record] as const));
      assert.deepEqual([...byPath.keys()].sort(), ['README.md', 'run.sh', 'subdir/nested.txt', 'vendor/ext']);
      const readme = byPath.get('README.md');
      assert.ok(readme !== undefined);
      assert.equal(readme?.object_type, 'blob');
      assert.equal(readme?.mode, '100644');
      assert.equal(readme?.size, 6);
      assert.ok(/^[0-9a-f]{40}$/u.test(readme?.oid ?? ''));
      const run = byPath.get('run.sh');
      assert.equal(run?.mode, '100755');
      assert.equal(run?.object_type, 'blob');
      const ext = byPath.get('vendor/ext');
      assert.equal(ext?.mode, '160000');
      assert.equal(ext?.object_type, 'commit');
      assert.equal(ext?.size, null);
      // Directories are not emitted by `ls-tree -r`; only blobs and gitlinks appear.
      assert.equal(records.some((record) => record.object_type === 'tree'), false);
      assert.equal(summary.entry_count, records.length);
      assert.equal(summary.path_bytes, records.reduce((sum, record) => sum + record.path_bytes.length, 0));
      assert.equal(summary.object_total_bytes, records.filter((record) => record.size !== null).reduce((sum, record) => sum + (record.size ?? 0), 0));
    });
  });

  void it('succeeds on an empty tree with zero entries and zero wire bytes of records', async () => {
    await withTempRepo(async (repoRoot) => {
      git(repoRoot, ['commit', '--allow-empty', '-m', 'empty']);
      const commit = headCommit(repoRoot);
      const records: GitLsTreeStreamRecord[] = [];
      const summary = await runGitStreamingLsTree({ commit, cwd: repoRoot, onRecord: (record) => { records.push(record); } });
      assert.equal(summary.terminal_state, 'exited');
      assert.equal(summary.entry_count, 0);
      assert.equal(summary.object_total_bytes, 0);
      assert.equal(records.length, 0);
      assert.equal(summary.stderr_bytes, 0);
    });
  });

  void it('rejects a descriptor whose commit is not an exact 40 lowercase-hex sealed OID', async () => {
    await withTempRepo(async (repoRoot) => {
      git(repoRoot, ['commit', '--allow-empty', '-m', 'one']);
      await assert.rejects(
        () => runGitStreamingLsTree({ commit: 'HEAD', cwd: repoRoot, onRecord: () => { } }),
        (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'invalid-descriptor',
      );
      await assert.rejects(
        () => runGitStreamingLsTree({ commit: 'XYZ'.repeat(14).slice(0, 40), cwd: repoRoot, onRecord: () => { } }),
        (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'invalid-descriptor',
      );
    });
  });

  void it('fails loudly on non-zero git exit (unknown revision) as an invalid-ls-tree-output read failure', async () => {
    await withTempRepo(async (repoRoot) => {
      git(repoRoot, ['commit', '--allow-empty', '-m', 'one']);
      await assert.rejects(
        () => runGitStreamingLsTree({ commit: '0'.repeat(40), cwd: repoRoot, onRecord: () => { } }),
        (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'invalid-ls-tree-output',
      );
    });
  });

  void it('reports a spawn failure when the git binary cannot be resolved (containment-shaped read failure)', async () => {
    await withTempRepo(async (repoRoot) => {
      git(repoRoot, ['commit', '--allow-empty', '-m', 'one']);
      const commit = headCommit(repoRoot);
      await assert.rejects(
        () => runGitStreamingLsTree({ commit, cwd: repoRoot, env: { PATH: '/nonexistent-dir-for-autopilot-test' }, onRecord: () => { } }),
        (error: unknown) => error instanceof GitStreamingQueryError && (error.code === 'invalid-ls-tree-output' || error.code === 'git-process-containment-failed'),
      );
    });
  });

  void it('force-terminates a hanging git process within the absolute deadline and fails loudly', async () => {
    await withTempRepo(async (repoRoot) => {
      git(repoRoot, ['commit', '--allow-empty', '-m', 'one']);
      const commit = headCommit(repoRoot);
      const bin = join(repoRoot, '..', 'stream-hang-bin');
      await mkdir(bin, { recursive: true });
      const wrapper = join(bin, 'git');
      // A wrapper that never exits and ignores SIGTERM, forcing force-kill.
      await writeFile(wrapper, '#!/bin/sh\ntrap ":" TERM\nwhile true; do sleep 0.1; done\n', 'utf8');
      await chmodReadWrite(wrapper);
      const start = Date.now();
      let caught: unknown = null;
      try {
        await runGitStreamingLsTree({ commit, cwd: repoRoot, env: { PATH: `${bin}:/usr/bin:/bin` }, onRecord: () => { } });
      } catch (error) {
        caught = error;
      }
      const elapsed = Date.now() - start;
      assert.ok(caught instanceof GitStreamingQueryError, 'a hanging git must fail loudly');
      const err = caught as GitStreamingQueryError;
      assert.ok(err.terminalState === 'force-terminated' || err.terminalState === 'containment-failed', `unexpected terminal state ${err.terminalState}`);
      // Bounded: must complete well under a generous 40s ceiling (absolute deadline is 35s).
      assert.ok(elapsed < 40_000, `termination took ${String(elapsed)}ms, exceeding the bounded deadline`);
      await rm(bin, { recursive: true, force: true });
    });
  });

  void it('parses exactly one record from a multi-chunk stream and preserves UTF-8 path bytes', async () => {
    await withTempRepo(async (repoRoot) => {
      await writeFile(join(repoRoot, 'café-雪.txt'), 'unicode path\n');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'unicode']);
      const commit = headCommit(repoRoot);
      const records: GitLsTreeStreamRecord[] = [];
      await runGitStreamingLsTree({ commit, cwd: repoRoot, onRecord: (record) => { records.push(record); } });
      assert.equal(records.length, 1);
      assert.equal(bytesToUtf8(records[0]?.path_bytes ?? new Uint8Array()), 'café-雪.txt');
      assert.equal(records[0]?.object_type, 'blob');
    });
  });
});

void describe('D58 streaming checked arithmetic', () => {
  void it('adds and multiplies safe non-negative integers within range', () => {
    assert.equal(checkedAdd(1, 2, 'git-stream-wire-overflow'), 3);
    assert.equal(checkedMultiply(3, 4, 'tracked-tree-total-overflow'), 12);
    assert.equal(checkedCeilMultiply(7, 3, 2, 'disk-projection-overflow'), 11);
  });

  void it('rejects overflow with the caller-named code rather than wrapping', () => {
    assert.throws(() => checkedAdd(Number.MAX_SAFE_INTEGER, 1, 'git-stream-wire-overflow'), (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'git-stream-wire-overflow');
    assert.throws(() => checkedMultiply(Number.MAX_SAFE_INTEGER, 2, 'tracked-tree-total-overflow'), (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'tracked-tree-total-overflow');
    assert.throws(() => checkedAdd(-1, 1, 'git-stream-entry-overflow'), (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'git-stream-entry-overflow');
  });

  void it('exposes the frozen D58 streaming caps unchanged', () => {
    assert.equal(GIT_STREAM_WIRE_MAX_BYTES, 268_435_456);
    assert.equal(GIT_STREAM_ENTRY_MAX, 500_000);
    assert.equal(GIT_STREAM_PATH_MAX_BYTES, 134_217_728);
    assert.equal(GIT_STREAM_RECORD_MAX_BYTES, 1_048_576);
  });
});

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

async function chmodReadWrite(path: string): Promise<void> {
  const { chmod } = await import('node:fs/promises');
  await chmod(path, 0o755);
}
