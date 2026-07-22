import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitStreamingQueryError, runGitStreamingLsTree, type GitLsTreeStreamRecord } from '../../src/core/git-process.ts';

import { describe, it } from 'node:test';

async function withTempRepo<T>(run: (repoRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'autopilot-git-stream-proc-'));
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

function git(repoRoot: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

void describe('D58 streaming ls-tree process lifecycle across a real subprocess', () => {
  void it('streams a real repo from an independent process and reaps the git child cleanly', async () => {
    await withTempRepo(async (repoRoot) => {
      await writeFile(join(repoRoot, 'a.txt'), 'alpha\n');
      await writeFile(join(repoRoot, 'b.txt'), 'beta beta\n');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'two']);
      const commit = git(repoRoot, ['rev-parse', 'HEAD']);
      const records: GitLsTreeStreamRecord[] = [];
      const summary = await runGitStreamingLsTree({ commit, cwd: repoRoot, onRecord: (record) => { records.push(record); } });
      assert.equal(summary.terminal_state, 'exited');
      assert.equal(summary.exit_code, 0);
      assert.equal(summary.stderr_bytes, 0);
      assert.equal(records.length, 2);
      // No leaked git ls-tree process remains after a clean exit.
      const leftover = spawnSync('pgrep', ['-f', 'git ls-tree'], { encoding: 'utf8' });
      assert.equal(leftover.stdout.trim().length, 0, 'no git ls-tree process should remain after a streamed scan');
    });
  });

  void it('contains and fails a wrapper that spawns a child retaining a pipe past the deadline', async () => {
    await withTempRepo(async (repoRoot) => {
      git(repoRoot, ['commit', '--allow-empty', '-m', 'one']);
      const commit = git(repoRoot, ['rev-parse', 'HEAD']);
      const bin = join(repoRoot, '..', 'stream-spawn-pending-bin');
      await mkdir(bin, { recursive: true });
      const wrapper = join(bin, 'git');
      // A wrapper that never writes a complete record and ignores SIGTERM, forcing force-kill.
      await writeFile(wrapper, '#!/bin/sh\ntrap ":" TERM\nwhile true; do sleep 0.2; done\n', 'utf8');
      await chmodReadWrite(wrapper);
      const start = Date.now();
      let caught: unknown = null;
      try {
        await runGitStreamingLsTree({ commit, cwd: repoRoot, env: { PATH: `${bin}:/usr/bin:/bin` }, onRecord: () => { } });
      } catch (error) {
        caught = error;
      }
      const elapsed = Date.now() - start;
      assert.ok(caught instanceof GitStreamingQueryError, 'a non-terminating git must fail loudly');
      const err = caught as GitStreamingQueryError;
      assert.ok(err.terminalState === 'force-terminated' || err.terminalState === 'containment-failed', `unexpected terminal state ${err.terminalState}`);
      assert.ok(elapsed < 40_000, `containment took ${String(elapsed)}ms, exceeding the bounded deadline`);
      // The hanging wrapper must be reaped (no leftover) after the bounded teardown.
      const leftover = spawnSync('pgrep', ['-f', 'while true; do sleep 0.2'], { encoding: 'utf8' });
      assert.equal(leftover.stdout.trim().length, 0, 'the force-killed wrapper must not survive its process group');
      await rm(bin, { recursive: true, force: true });
    });
  });
});

async function chmodReadWrite(path: string): Promise<void> {
  const { chmod } = await import('node:fs/promises');
  await chmod(path, 0o755);
}
