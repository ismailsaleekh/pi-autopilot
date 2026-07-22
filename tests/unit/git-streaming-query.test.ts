import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GIT_STREAM_ENTRY_MAX,
  GIT_STREAM_PATH_MAX_BYTES,
  GIT_STREAM_RECORD_MAX_BYTES,
  GIT_STREAM_TIMEOUT_MS,
  GIT_STREAM_WIRE_MAX_BYTES,
  GitPlumbingError,
  GitStreamingQueryError,
  checkedAdd,
  checkedCeilMultiply,
  checkedMultiply,
  gitPlumbingArgv,
  runGitPlumbing,
  runGitStreamingLsTree,
  type GitCommitIdentity,
  type GitLsTreeStreamRecord,
} from '../../src/core/git-process.ts';
import type { ChildProcessLite, ChildProcessReadablePipe, ChildProcessWritablePipe } from 'node:child_process';

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

  void it('reports error-before-PID as the exact spawn-failed terminal state', async () => {
    await withTempRepo(async (repoRoot) => {
      git(repoRoot, ['commit', '--allow-empty', '-m', 'one']);
      const commit = headCommit(repoRoot);
      await assert.rejects(
        () => runGitStreamingLsTree({ commit, cwd: repoRoot, env: { PATH: '/nonexistent-dir-for-autopilot-test' }, onRecord: () => { } }),
        (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'invalid-ls-tree-output' && error.terminalState === 'spawn-failed' && error.rootPid === null,
      );
    });
  });

  void it('returns the exact caught value when spawn throws synchronously before any child exists', async () => {
    await withTempRepo(async (repoRoot) => {
      git(repoRoot, ['commit', '--allow-empty', '-m', 'one']);
      const marker = new Error('synthetic exact synchronous spawn throw');
      await assert.rejects(
        () => runGitStreamingLsTree({ commit: headCommit(repoRoot), cwd: repoRoot, onRecord: () => { }, spawnChild: () => { throw marker; } }),
        (error: unknown) => error === marker,
      );
    });
  });

  void it('rejects a NUL-delimited empty record instead of silently skipping it', async () => {
    await withTempRepo(async (repoRoot) => {
      git(repoRoot, ['commit', '--allow-empty', '-m', 'one']);
      const commit = headCommit(repoRoot);
      const bin = join(repoRoot, '..', 'stream-empty-record-bin');
      await mkdir(bin, { recursive: true });
      const wrapper = join(bin, 'git');
      await writeFile(wrapper, '#!/bin/sh\nprintf "\\0"\n', 'utf8');
      await chmodReadWrite(wrapper);
      await assert.rejects(
        () => runGitStreamingLsTree({ commit, cwd: repoRoot, env: { PATH: `${bin}:/usr/bin:/bin` }, onRecord: () => { } }),
        (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'invalid-ls-tree-output' && /empty record/u.test(error.message),
      );
      await rm(bin, { recursive: true, force: true });
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

  void it('enforces the finite entry ceiling with git-stream-entry-overflow, not just the safe-integer guard', async () => {
    await withTempRepo(async (repoRoot) => {
      // Three tracked blobs; a tightening-only entry ceiling of 2 must reject the
      // third record loudly. The frozen 500k ceiling is unreachable in a unit
      // test, so the tightening seam proves the real comparison exists (the bug
      // was that only checkedAdd's safe-integer bound applied and the finite
      // GIT_STREAM_ENTRY_MAX ceiling was never compared).
      await writeFile(join(repoRoot, 'a.txt'), 'a\n');
      await writeFile(join(repoRoot, 'b.txt'), 'b\n');
      await writeFile(join(repoRoot, 'c.txt'), 'c\n');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'three']);
      const commit = headCommit(repoRoot);
      let delivered = 0;
      await assert.rejects(
        () => runGitStreamingLsTree({ commit, cwd: repoRoot, maxEntries: 2, onRecord: () => { delivered += 1; } }),
        (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'git-stream-entry-overflow',
      );
      // The first two records were delivered before the third tripped the cap.
      assert.equal(delivered, 2);
      // The same three-entry tree streams cleanly under the frozen ceiling.
      const records: GitLsTreeStreamRecord[] = [];
      const summary = await runGitStreamingLsTree({ commit, cwd: repoRoot, onRecord: (record) => { records.push(record); } });
      assert.equal(summary.entry_count, 3);
      assert.equal(records.length, 3);
    });
  });

  void it('enforces the finite cumulative path-byte ceiling with git-stream-path-overflow', async () => {
    await withTempRepo(async (repoRoot) => {
      // Two 9-byte paths => 18 cumulative path bytes. The ceiling is cumulative
      // across the whole stream (not per record), so a tightening ceiling of 8
      // rejects at the first record and a ceiling of 17 rejects at the second.
      await writeFile(join(repoRoot, 'alpha.txt'), 'a\n');
      await writeFile(join(repoRoot, 'bravo.txt'), 'b\n');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'two']);
      const commit = headCommit(repoRoot);
      await assert.rejects(
        () => runGitStreamingLsTree({ commit, cwd: repoRoot, maxPathBytes: 8, onRecord: () => { } }),
        (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'git-stream-path-overflow',
      );
      let delivered = 0;
      await assert.rejects(
        () => runGitStreamingLsTree({ commit, cwd: repoRoot, maxPathBytes: 17, onRecord: () => { delivered += 1; } }),
        (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'git-stream-path-overflow',
      );
      // Only the first 9-byte path was delivered before the cumulative 18 tripped 17.
      assert.equal(delivered, 1);
      // The exact cumulative 18 bytes stays within a ceiling of 18.
      const summary = await runGitStreamingLsTree({ commit, cwd: repoRoot, maxPathBytes: 18, onRecord: () => { } });
      assert.equal(summary.path_bytes, 'alpha.txt'.length + 'bravo.txt'.length);
      assert.equal(summary.entry_count, 2);
    });
  });

  void it('enforces the per-record byte ceiling on a COMPLETE record, not only an in-progress one', async () => {
    await withTempRepo(async (repoRoot) => {
      // A single small blob produces one complete NUL-terminated ls-tree record
      // (~50-60 bytes: mode type oid size TAB path NUL). Before the per-record
      // fix, flushPending drained and delivered a COMPLETE record before the
      // post-flush pendingBytes>RECORD_MAX check could fire, so a complete
      // oversized record silently bypassed the ceiling (independent reviewer
      // reproduced this with a real >1 MiB path). A tightening record ceiling
      // below the record size must now reject the complete record BEFORE onRecord.
      await writeFile(join(repoRoot, 'x.txt'), 'x\n');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'one blob']);
      const commit = headCommit(repoRoot);
      let delivered = 0;
      await assert.rejects(
        () => runGitStreamingLsTree({ commit, cwd: repoRoot, maxRecordBytes: 20, onRecord: () => { delivered += 1; } }),
        (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'git-stream-record-overflow',
      );
      // The complete oversized record must be rejected BEFORE it is delivered.
      assert.equal(delivered, 0);
      // Measure the exact record size INCLUDING its terminal NUL from wire_bytes
      // (a single-record stream is exactly the record + its terminal NUL).
      const measured = await runGitStreamingLsTree({ commit, cwd: repoRoot, maxRecordBytes: GIT_STREAM_RECORD_MAX_BYTES, onRecord: () => { } });
      const recordLenWithNul = measured.wire_bytes;
      // The ceiling is on the NUL-INCLUSIVE record length: a ceiling one byte
      // below it must reject (the D58 grammar counts the trailing NUL), and a
      // ceiling exactly equal to it must accept.
      await assert.rejects(
        () => runGitStreamingLsTree({ commit, cwd: repoRoot, maxRecordBytes: recordLenWithNul - 1, onRecord: () => { } }),
        (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'git-stream-record-overflow',
      );
      const records: GitLsTreeStreamRecord[] = [];
      const summary = await runGitStreamingLsTree({ commit, cwd: repoRoot, maxRecordBytes: recordLenWithNul, onRecord: (record) => { records.push(record); } });
      assert.equal(summary.entry_count, 1);
      assert.equal(records.length, 1);
    });
  });

  void it('rejects a containment-ceiling override that would loosen or malform the frozen cap', async () => {
    await withTempRepo(async (repoRoot) => {
      git(repoRoot, ['commit', '--allow-empty', '-m', 'one']);
      const commit = headCommit(repoRoot);
      // Loosening the frozen entry ceiling is rejected as an invalid descriptor:
      // the seam can only tighten containment, never weaken it.
      await assert.rejects(
        () => runGitStreamingLsTree({ commit, cwd: repoRoot, maxEntries: GIT_STREAM_ENTRY_MAX + 1, onRecord: () => { } }),
        (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'invalid-descriptor',
      );
      await assert.rejects(
        () => runGitStreamingLsTree({ commit, cwd: repoRoot, maxPathBytes: GIT_STREAM_PATH_MAX_BYTES + 1, onRecord: () => { } }),
        (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'invalid-descriptor',
      );
      await assert.rejects(
        () => runGitStreamingLsTree({ commit, cwd: repoRoot, maxEntries: 0, onRecord: () => { } }),
        (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'invalid-descriptor',
      );
      await assert.rejects(
        () => runGitStreamingLsTree({ commit, cwd: repoRoot, maxPathBytes: 1.5, onRecord: () => { } }),
        (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'invalid-descriptor',
      );
      await assert.rejects(
        () => runGitStreamingLsTree({ commit, cwd: repoRoot, maxRecordBytes: GIT_STREAM_RECORD_MAX_BYTES + 1, onRecord: () => { } }),
        (error: unknown) => error instanceof GitStreamingQueryError && error.code === 'invalid-descriptor',
      );
    });
  });

  void it('surfaces the OBSERVED child PID (not null) when a PID exists but the spawn event never settles by the deadline', async () => {
    // Finding B (D58 containment matrix): the contract says an unconfirmed spawn
    // resolves to `spawn-unconfirmed` with `root_pid` equal to the OBSERVED PID
    // if any else null. The local `pid` is only assigned inside the `spawn`
    // settle-event handler; if the child exposes a PID on its handle but the
    // `spawn` event never fires before the 30s execution deadline, the observed
    // PID must still be surfaced for process-tree containment. This is otherwise
    // nondeterministic against libuv, so it is proven with the injectable spawn
    // seam + the injectable clock: a controlled child that carries `pid` but
    // emits NO `spawn` event, and a clock that has already passed the execution
    // deadline so the exec timer fires immediately. Every settle-once rule and
    // the containment report path are the exact production code. The
    // spawn-unconfirmed path performs NO termination, so the fake PID is never
    // signalled.
    await withTempRepo(async (repoRoot) => {
      git(repoRoot, ['commit', '--allow-empty', '-m', 'one']);
      const commit = headCommit(repoRoot);
      const OBSERVED_PID = 424242;
      const child = fakeUnsettledChild(OBSERVED_PID);
      // A clock already past the 30000 ms execution deadline makes remainingMs(exec)
      // resolve to 0 so the exec timer fires on the next tick with the spawn still
      // unconfirmed (the fake never emits `spawn`).
      let ticks = 0;
      const clock = (): number => (ticks++ === 0 ? 0 : GIT_STREAM_TIMEOUT_MS + 1);
      let caught: unknown = null;
      try {
        await runGitStreamingLsTree({ commit, cwd: repoRoot, clock, onRecord: () => { }, spawnChild: () => child.handle });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof GitStreamingQueryError, 'an unconfirmed spawn must fail loudly');
      const err = caught as GitStreamingQueryError;
      assert.equal(err.code, 'git-process-containment-failed');
      assert.equal(err.terminalState, 'spawn-unconfirmed');
      // The crux of Finding B: root_pid is the OBSERVED handle PID, not null.
      assert.equal(err.rootPid, OBSERVED_PID);
    });
  });

  void it('reports root_pid null for an unconfirmed spawn when the handle exposes no observable PID', async () => {
    // The paired negative: when no PID is observable on the handle either, the
    // contract keeps root_pid null (no PID is invented). Same unsettled-spawn
    // path, handle.pid === undefined. This case exercises the UNCHANGED `pid`
    // path, so it passes with and without the Finding B fix (guarding the fix
    // is scoped to the observed-PID branch only).
    await withTempRepo(async (repoRoot) => {
      git(repoRoot, ['commit', '--allow-empty', '-m', 'one']);
      const commit = headCommit(repoRoot);
      const child = fakeUnsettledChild(undefined);
      let ticks = 0;
      const clock = (): number => (ticks++ === 0 ? 0 : GIT_STREAM_TIMEOUT_MS + 1);
      let caught: unknown = null;
      try {
        await runGitStreamingLsTree({ commit, cwd: repoRoot, clock, onRecord: () => { }, spawnChild: () => child.handle });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof GitStreamingQueryError);
      const err = caught as GitStreamingQueryError;
      assert.equal(err.code, 'git-process-containment-failed');
      assert.equal(err.terminalState, 'spawn-unconfirmed');
      assert.equal(err.rootPid, null);
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

/**
 * A controlled `ChildProcessLite` for the D58 spawn-lifecycle containment tests:
 * it carries a fixed `pid` (or undefined) but NEVER emits the `spawn` settle
 * event, `data`, `error`, or `close`, modelling a child observed with a PID whose
 * `spawn` event has not fired by the execution deadline. Its pipes and control
 * methods are inert no-ops; the streaming lifecycle never reads its streams on
 * the spawn-unconfirmed path (which performs no termination). Only the fields the
 * production code actually touches are populated, expressed entirely with the
 * package's existing `ChildProcessLite` type surface (no node type widening).
 */
function fakeUnsettledChild(pid: number | undefined): { readonly handle: ChildProcessLite } {
  const readable: ChildProcessReadablePipe = { on: () => { } };
  const writable: ChildProcessWritablePipe = { write: () => { }, end: () => { }, on: () => { } };
  const handle: ChildProcessLite = {
    stdin: writable,
    stdout: readable,
    stderr: readable,
    killed: false,
    pid,
    exitCode: null,
    kill: () => { },
    unref: () => { },
    // Never invokes any listener: no `spawn`, `error`, or `close` ever fires.
    on: () => { },
    once: () => { },
  };
  return { handle };
}

const IDENTITY: GitCommitIdentity = Object.freeze({ name: 'autopilot', email: 'autopilot@invalid', date: '1700000000 +0000' });

const encoder = new TextEncoder();

/** Assert an emitted oid is present and a 40-hex string, narrowing the type. */
function requireOid(oid: string | null, label: string): string {
  if (oid === null || !/^[0-9a-f]{40}$/u.test(oid)) throw new Error(`${label} must be a 40-hex object id (got ${String(oid)})`);
  return oid;
}

void describe('D65 isolated-index Git plumbing', () => {
  void it('builds a sole-parent G with the base tree plus exactly the graph blobs, without touching the shared index', async () => {
    await withTempRepo(async (repoRoot) => {
      // A base commit with a product file (which must survive into G's tree).
      await writeFile(join(repoRoot, 'product.txt'), 'product content\n');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'base']);
      const base = git(repoRoot, ['rev-parse', 'HEAD']);
      const baseTree = git(repoRoot, ['rev-parse', 'HEAD^{tree}']);
      const indexFile = join(repoRoot, '..', `iso-${String(process.pid)}.index`);

      // hash-object: write the two graph blobs.
      const rootBytes = encoder.encode('{"schema":"graph-root"}\n');
      const shardBytes = encoder.encode('{"schema":"graph-shard"}\n');
      const rootOid = requireOid(runGitPlumbing({ descriptor: { kind: 'hash-object-write', bytes: rootBytes }, cwd: repoRoot, indexFile }).oid, 'root blob');
      const shardOid = requireOid(runGitPlumbing({ descriptor: { kind: 'hash-object-write', bytes: shardBytes }, cwd: repoRoot, indexFile }).oid, 'shard blob');

      // read-tree base -> update-index graph blobs -> write-tree.
      assert.equal(runGitPlumbing({ descriptor: { kind: 'read-tree', tree: baseTree }, cwd: repoRoot, indexFile }).oid, null);
      assert.equal(runGitPlumbing({
        descriptor: {
          kind: 'update-index-cacheinfo',
          entries: [
            { oid: rootOid, path: 'semantic-graphs/00000000000000000002/graph.json' },
            { oid: shardOid, path: 'semantic-graphs/00000000000000000002/authorities/00000.json' },
          ],
        },
        cwd: repoRoot,
        indexFile,
      }).oid, null);
      const gTree = requireOid(runGitPlumbing({ descriptor: { kind: 'write-tree' }, cwd: repoRoot, indexFile }).oid, 'G tree');

      // commit-tree sole parent = base.
      const g = requireOid(runGitPlumbing({ descriptor: { kind: 'commit-tree', tree: gTree, parents: [base], message: 'graph authority G\n', identity: IDENTITY }, cwd: repoRoot, indexFile }).oid, 'G commit');

      // G has exactly one parent and it is base.
      const parents = git(repoRoot, ['rev-list', '--parents', '-n', '1', g]).split(/\s+/u);
      assert.deepEqual(parents, [g, base]);
      // G's diff vs base is exactly the two graph paths (product.txt preserved).
      const diff = git(repoRoot, ['diff', '--name-only', base, g]).split('\n').filter((line) => line.length > 0).sort();
      assert.deepEqual(diff, ['semantic-graphs/00000000000000000002/authorities/00000.json', 'semantic-graphs/00000000000000000002/graph.json']);
      // product.txt is still present in G's tree (base tree preserved).
      assert.equal(git(repoRoot, ['ls-tree', '--name-only', g, 'product.txt']), 'product.txt');
      // The graph blobs in G are byte-exact to what we wrote.
      assert.equal(git(repoRoot, ['cat-file', 'blob', `${g}:semantic-graphs/00000000000000000002/graph.json`]), '{"schema":"graph-root"}');

      // The shared .git/index was never touched: HEAD status is still clean and
      // the isolated index file lives outside the worktree.
      assert.equal(git(repoRoot, ['status', '--porcelain=v1']), '');
      assert.ok(existsSync(indexFile), 'the isolated index file exists outside the worktree');
      // .git/index either matches the base commit or is absent-of-staged-graph:
      // `git status` clean above already proves no graph paths were staged.
    });
  });

  void it('builds a graph-only H with sole parent G and reproduces byte-identical commits under the fixed identity', async () => {
    await withTempRepo(async (repoRoot) => {
      await writeFile(join(repoRoot, 'product.txt'), 'product\n');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'base']);
      const base = git(repoRoot, ['rev-parse', 'HEAD']);
      const baseTree = git(repoRoot, ['rev-parse', 'HEAD^{tree}']);
      const indexFile = join(repoRoot, '..', `iso-h-${String(process.pid)}.index`);

      const rootOid = requireOid(runGitPlumbing({ descriptor: { kind: 'hash-object-write', bytes: encoder.encode('root\n') }, cwd: repoRoot, indexFile }).oid, 'root blob');
      runGitPlumbing({ descriptor: { kind: 'read-tree', tree: baseTree }, cwd: repoRoot, indexFile });
      runGitPlumbing({ descriptor: { kind: 'update-index-cacheinfo', entries: [{ oid: rootOid, path: 'semantic-graphs/00000000000000000002/graph.json' }] }, cwd: repoRoot, indexFile });
      const gTree = requireOid(runGitPlumbing({ descriptor: { kind: 'write-tree' }, cwd: repoRoot, indexFile }).oid, 'G tree');
      const g1 = requireOid(runGitPlumbing({ descriptor: { kind: 'commit-tree', tree: gTree, parents: [base], message: 'G\n', identity: IDENTITY }, cwd: repoRoot, indexFile }).oid, 'G1');
      const g2 = requireOid(runGitPlumbing({ descriptor: { kind: 'commit-tree', tree: gTree, parents: [base], message: 'G\n', identity: IDENTITY }, cwd: repoRoot, indexFile }).oid, 'G2');
      // Deterministic: same tree/parent/message/identity => byte-identical commit id.
      assert.equal(g1, g2);

      // H is graph-only: its tree equals G's tree (no further authority change),
      // sole parent G. commit-tree over the same tree with parent G.
      const h = requireOid(runGitPlumbing({ descriptor: { kind: 'commit-tree', tree: gTree, parents: [g1], message: 'H\n', identity: IDENTITY }, cwd: repoRoot, indexFile }).oid, 'H');
      const hParents = git(repoRoot, ['rev-list', '--parents', '-n', '1', h]).split(/\s+/u);
      assert.deepEqual(hParents, [h, g1]);
      // G..H diff is empty (graph-only publication commit carries no new tree change here).
      assert.equal(git(repoRoot, ['diff', '--name-only', g1, h]), '');
    });
  });

  void it('rejects malformed descriptors loudly (bad oid, bad path, empty entries, bad identity, missing parent)', async () => {
    await withTempRepo(async (repoRoot) => {
      git(repoRoot, ['commit', '--allow-empty', '-m', 'base']);
      const base = git(repoRoot, ['rev-parse', 'HEAD']);
      const baseTree = git(repoRoot, ['rev-parse', 'HEAD^{tree}']);
      const indexFile = join(repoRoot, '..', `iso-neg-${String(process.pid)}.index`);
      const rejects = (fn: () => void, note: string): void => {
        assert.throws(fn, (error: unknown) => error instanceof GitPlumbingError && error.code === 'invalid-descriptor', note);
      };
      // Non-40-hex tree oid.
      rejects(() => runGitPlumbing({ descriptor: { kind: 'read-tree', tree: 'HEAD' }, cwd: repoRoot, indexFile }), 'read-tree non-hex');
      // Uppercase / abbreviated oid.
      rejects(() => runGitPlumbing({ descriptor: { kind: 'read-tree', tree: baseTree.toUpperCase() }, cwd: repoRoot, indexFile }), 'read-tree uppercase');
      // Empty cacheinfo entries.
      rejects(() => runGitPlumbing({ descriptor: { kind: 'update-index-cacheinfo', entries: [] }, cwd: repoRoot, indexFile }), 'empty entries');
      // Cacheinfo path with a comma.
      rejects(() => runGitPlumbing({ descriptor: { kind: 'update-index-cacheinfo', entries: [{ oid: '0'.repeat(40), path: 'a,b.json' }] }, cwd: repoRoot, indexFile }), 'comma path');
      // Absolute / traversal cacheinfo path.
      rejects(() => runGitPlumbing({ descriptor: { kind: 'update-index-cacheinfo', entries: [{ oid: '0'.repeat(40), path: '/etc/passwd' }] }, cwd: repoRoot, indexFile }), 'absolute path');
      rejects(() => runGitPlumbing({ descriptor: { kind: 'update-index-cacheinfo', entries: [{ oid: '0'.repeat(40), path: '../escape.json' }] }, cwd: repoRoot, indexFile }), 'traversal path');
      // Duplicate cacheinfo path.
      rejects(() => runGitPlumbing({ descriptor: { kind: 'update-index-cacheinfo', entries: [{ oid: '0'.repeat(40), path: 'a.json' }, { oid: '1'.repeat(40), path: 'a.json' }] }, cwd: repoRoot, indexFile }), 'dup path');
      // commit-tree with no parents.
      rejects(() => runGitPlumbing({ descriptor: { kind: 'commit-tree', tree: baseTree, parents: [], message: 'm', identity: IDENTITY }, cwd: repoRoot, indexFile }), 'no parent');
      // commit-tree with malformed identity date.
      rejects(() => runGitPlumbing({ descriptor: { kind: 'commit-tree', tree: baseTree, parents: [base], message: 'm', identity: { name: 'a', email: 'b', date: 'not-a-date' } }, cwd: repoRoot, indexFile }), 'bad date');
      // Index-using operations require an absolute path outside both worktree
      // and Git common directory; neither shared index can be touched.
      rejects(() => runGitPlumbing({ descriptor: { kind: 'write-tree' }, cwd: repoRoot, indexFile: 'relative.index' }), 'relative index');
      rejects(() => runGitPlumbing({ descriptor: { kind: 'write-tree' }, cwd: repoRoot, indexFile: join(repoRoot, 'isolated.index') }), 'worktree-contained index');
      rejects(() => runGitPlumbing({ descriptor: { kind: 'write-tree' }, cwd: repoRoot, indexFile: join(repoRoot, '.git', 'index') }), 'shared Git index');
    });
  });

  void it('fails loudly (not silently) when git rejects the operation', async () => {
    await withTempRepo(async (repoRoot) => {
      const indexFile = join(repoRoot, '..', `iso-fail-${String(process.pid)}.index`);
      // read-tree of a well-formed but non-existent tree oid must fail loud.
      assert.throws(
        () => runGitPlumbing({ descriptor: { kind: 'read-tree', tree: '0'.repeat(40) }, cwd: repoRoot, indexFile }),
        (error: unknown) => error instanceof GitPlumbingError && error.code === 'unexpected-exit',
      );
    });
  });

  void it('exposes a stable argv for each plumbing descriptor', () => {
    assert.deepEqual(gitPlumbingArgv({ kind: 'hash-object-write', bytes: new Uint8Array() }), ['hash-object', '-w', '--stdin']);
    assert.deepEqual(gitPlumbingArgv({ kind: 'read-tree', tree: '0'.repeat(40) }), ['read-tree', '0'.repeat(40)]);
    assert.deepEqual(gitPlumbingArgv({ kind: 'write-tree' }), ['write-tree']);
    assert.deepEqual(gitPlumbingArgv({ kind: 'update-index-cacheinfo', entries: [{ oid: '0'.repeat(40), path: 'g.json' }] }), ['update-index', '--add', '--cacheinfo', `100644,${'0'.repeat(40)},g.json`]);
    assert.deepEqual(gitPlumbingArgv({ kind: 'commit-tree', tree: '0'.repeat(40), parents: ['1'.repeat(40)], message: 'm', identity: IDENTITY }), ['commit-tree', '0'.repeat(40), '-p', '1'.repeat(40)]);
  });
});
