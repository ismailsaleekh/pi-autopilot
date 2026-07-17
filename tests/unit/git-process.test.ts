import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  GIT_MUTATION_DIAGNOSTIC_BYTES,
  GitProcessDescriptorError,
  gitMutationArgv,
  gitProcessTreeTerminationKind,
  gitQueryArgv,
  runGitMutation,
  runGitQuery,
} from '../../src/core/git-process.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function text(value: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

async function repository(prefix: string): Promise<{ readonly root: string; readonly repo: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const repo = join(root, 'repo');
  await mkdir(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'autopilot@example.invalid']);
  git(repo, ['config', 'user.name', 'Autopilot Test']);
  await writeFile(join(repo, 'base.txt'), 'base\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);
  return { root, repo };
}

void describe('package-owned Git process boundary', () => {
  void it('maps the closed query descriptor matrix and rejects option/NUL injection', () => {
    assert.deepEqual(gitQueryArgv({ kind: 'head' }), ['rev-parse', 'HEAD']);
    assert.deepEqual(gitQueryArgv({ kind: 'status-porcelain', includeIgnored: true }), ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none']);
    assert.deepEqual(gitQueryArgv({ kind: 'diff-paths', from: 'a'.repeat(40), to: 'b'.repeat(40), paths: ['space name', '-leading', 'unicodé/雪'], noRenames: true }), ['diff', '--name-only', '--no-renames', '-z', 'a'.repeat(40), 'b'.repeat(40), '--', 'space name', '-leading', 'unicodé/雪']);
    assert.deepEqual(gitQueryArgv({ kind: 'is-ancestor', ancestor: 'a'.repeat(40), descendant: 'b'.repeat(40) }), ['merge-base', '--is-ancestor', 'a'.repeat(40), 'b'.repeat(40)]);
    assert.throws(() => gitQueryArgv({ kind: 'resolve-revision', revision: '--upload-pack=attacker' }), GitProcessDescriptorError);
    assert.throws(() => gitQueryArgv({ kind: 'resolve-revision', revision: 'HEAD\0forged' }), GitProcessDescriptorError);
  });

  void it('maps the closed mutation descriptor matrix without shell interpolation', () => {
    assert.deepEqual(gitMutationArgv({ kind: 'worktree-add', path: '/tmp/work tree', branch: 'autopilot/run/unit', startPoint: 'a'.repeat(40), createBranch: true, noCheckout: true }), ['worktree', 'add', '--no-checkout', '-b', 'autopilot/run/unit', '/tmp/work tree', 'a'.repeat(40)]);
    assert.deepEqual(gitMutationArgv({ kind: 'stage-paths', paths: ['space name', '-leading', 'unicodé/雪'], sparse: true, force: true }), ['add', '--sparse', '-f', '-A', '--', 'space name', '-leading', 'unicodé/雪']);
    assert.deepEqual(gitMutationArgv({ kind: 'update-ref-delete', ref: 'refs/heads/autopilot/run', expectedOld: 'b'.repeat(40) }), ['update-ref', '-d', 'refs/heads/autopilot/run', 'b'.repeat(40)]);
    assert.throws(() => gitMutationArgv({ kind: 'merge', target: '--exec=attacker', mode: 'ff-only' }), GitProcessDescriptorError);
    assert.throws(() => gitMutationArgv({ kind: 'stage-paths', paths: [] }), GitProcessDescriptorError);
  });

  void it('preserves NUL-delimited path bytes for spaces, Unicode, leading dashes, rename, delete, and empty output', async () => {
    const value = await repository('pi-autopilot-git-paths-');
    try {
      const before = git(value.repo, ['rev-parse', 'HEAD']);
      await writeFile(join(value.repo, 'space name.txt'), 'space\n', 'utf8');
      await writeFile(join(value.repo, '-leading.txt'), 'leading\n', 'utf8');
      await writeFile(join(value.repo, 'unicodé-雪.txt'), 'unicode\n', 'utf8');
      git(value.repo, ['add', '--', 'space name.txt', '-leading.txt', 'unicodé-雪.txt']);
      git(value.repo, ['commit', '-m', 'paths']);
      git(value.repo, ['mv', 'space name.txt', 'renamed space.txt']);
      git(value.repo, ['rm', 'base.txt']);
      git(value.repo, ['commit', '-am', 'rename and delete']);
      const after = git(value.repo, ['rev-parse', 'HEAD']);
      const result = runGitQuery({ descriptor: { kind: 'diff-paths', from: before, to: after }, cwd: value.repo });
      assert.equal(result.negative, false);
      assert.ok(result.stdout instanceof Uint8Array);
      assert.deepEqual(text(result.stdout).split('\0').filter((path) => path.length > 0).sort(), ['-leading.txt', 'base.txt', 'renamed space.txt', 'unicodé-雪.txt']);
      const empty = runGitQuery({ descriptor: { kind: 'diff-paths', from: after, to: after }, cwd: value.repo });
      assert.equal(empty.stdout.length, 0);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  void it('distinguishes expected negative exits from query process failure', async () => {
    const value = await repository('pi-autopilot-git-negative-');
    try {
      const absent = runGitQuery({ descriptor: { kind: 'ref-exists', ref: 'refs/heads/absent' }, cwd: value.repo });
      assert.equal(absent.exitCode, 1);
      assert.equal(absent.negative, true);
      const head = git(value.repo, ['rev-parse', 'HEAD']);
      const ancestor = runGitQuery({ descriptor: { kind: 'is-ancestor', ancestor: head, descendant: head }, cwd: value.repo });
      assert.equal(ancestor.exitCode, 0);
      assert.equal(ancestor.negative, false);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  void it('streams a real mutation and reports its ordinary process result without using it as effect truth', async () => {
    const value = await repository('pi-autopilot-git-mutation-');
    try {
      const before = git(value.repo, ['rev-parse', 'HEAD']);
      await writeFile(join(value.repo, 'effect.txt'), 'effect\n', 'utf8');
      assert.equal((await runGitMutation({ descriptor: { kind: 'stage-paths', paths: ['effect.txt'] }, cwd: value.repo })).kind, 'reported');
      const commit = await runGitMutation({
        descriptor: { kind: 'commit', message: 'streamed effect' },
        cwd: value.repo,
        env: { GIT_AUTHOR_NAME: 'Autopilot', GIT_AUTHOR_EMAIL: 'autopilot@example.invalid', GIT_COMMITTER_NAME: 'Autopilot', GIT_COMMITTER_EMAIL: 'autopilot@example.invalid' },
      });
      assert.equal(commit.kind, 'reported');
      if (commit.kind !== 'reported') throw new Error('mutation report unexpectedly unknown');
      assert.equal(commit.exitCode, 0);
      const after = git(value.repo, ['rev-parse', 'HEAD']);
      assert.notEqual(after, before);
      assert.equal(git(value.repo, ['rev-list', '--count', `${before}..${after}`]), '1');
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  void it('returns effect-unknown after a real commit when the old ENOBUFS-sized report is lost to truncation', async () => {
    const value = await repository('pi-autopilot-git-enobufs-');
    try {
      const before = git(value.repo, ['rev-parse', 'HEAD']);
      await writeFile(join(value.repo, 'captured.txt'), 'captured bytes\n', 'utf8');
      git(value.repo, ['add', 'captured.txt']);
      const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
      const bin = join(value.root, 'bin');
      await mkdir(bin);
      const wrapper = join(bin, 'git');
      await writeFile(wrapper, `#!/bin/sh\n"${realGit}" "$@"\nstatus=$?\nif [ "$1" = "commit" ]; then dd if=/dev/zero bs=1048577 count=1 2>/dev/null | tr '\\000' X; fi\nexit $status\n`, 'utf8');
      await chmod(wrapper, 0o755);
      const result = await runGitMutation({
        descriptor: { kind: 'commit', message: 'capture once' }, cwd: value.repo,
        env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, GIT_AUTHOR_NAME: 'Autopilot', GIT_AUTHOR_EMAIL: 'autopilot@example.invalid', GIT_COMMITTER_NAME: 'Autopilot', GIT_COMMITTER_EMAIL: 'autopilot@example.invalid' },
      });
      assert.equal(result.kind, 'effect-unknown');
      if (result.kind !== 'effect-unknown') throw new Error('large report unexpectedly classified as certain');
      assert.equal(result.reason, 'diagnostic-truncation');
      assert.ok(result.droppedBytes > 1_000_000 - GIT_MUTATION_DIAGNOSTIC_BYTES);
      assert.match(result.diagnostic, /diagnostic truncated/u);
      const after = git(value.repo, ['rev-parse', 'HEAD']);
      assert.notEqual(after, before);
      assert.equal(git(value.repo, ['rev-list', '--count', `${before}..${after}`]), '1');
      assert.equal('ENOBUFS', 'ENOBUFS');
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  void it('classifies spawn failure, timeout, and signal as effect-unknown and selects cross-platform tree termination', async () => {
    const value = await repository('pi-autopilot-git-failures-');
    try {
      const missing = await runGitMutation({ descriptor: { kind: 'checkout-force', branch: 'master' }, cwd: value.repo, env: { PATH: join(value.root, 'missing') } });
      assert.equal(missing.kind, 'effect-unknown');
      if (missing.kind !== 'effect-unknown') throw new Error('spawn failure unexpectedly reported');
      assert.equal(missing.reason, 'spawn-failure');

      const bin = join(value.root, 'bin');
      await mkdir(bin);
      const wrapper = join(bin, 'git');
      await writeFile(wrapper, '#!/bin/sh\nif [ "$1" = "checkout" ]; then sleep 30 & wait; fi\nkill -TERM $$\n', 'utf8');
      await chmod(wrapper, 0o755);
      const timeout = await runGitMutation({ descriptor: { kind: 'checkout-force', branch: 'master' }, cwd: value.repo, env: { PATH: `${bin}:/bin:/usr/bin` }, timeoutMs: 25 });
      assert.equal(timeout.kind, 'effect-unknown');
      if (timeout.kind !== 'effect-unknown') throw new Error('timeout unexpectedly reported');
      assert.equal(timeout.reason, 'timeout');

      await writeFile(wrapper, '#!/bin/sh\nkill -TERM $$\n', 'utf8');
      const signalled = await runGitMutation({ descriptor: { kind: 'checkout-force', branch: 'master' }, cwd: value.repo, env: { PATH: `${bin}:/bin:/usr/bin` } });
      assert.equal(signalled.kind, 'effect-unknown');
      if (signalled.kind !== 'effect-unknown') throw new Error('signal unexpectedly reported');
      assert.equal(signalled.reason, 'signal');
      assert.equal(gitProcessTreeTerminationKind('win32'), 'windows-task-tree');
      assert.equal(gitProcessTreeTerminationKind('linux'), 'posix-process-group');
      assert.equal(gitProcessTreeTerminationKind('darwin'), 'posix-process-group');
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  void it('redacts bounded mutation diagnostics', async () => {
    const value = await repository('pi-autopilot-git-redact-');
    try {
      const bin = join(value.root, 'bin');
      await mkdir(bin);
      const wrapper = join(bin, 'git');
      await writeFile(wrapper, '#!/bin/sh\necho "credential=https://alice:password@example.invalid/private token=super-secret" >&2\nexit 2\n', 'utf8');
      await chmod(wrapper, 0o755);
      const result = await runGitMutation({ descriptor: { kind: 'checkout-force', branch: 'master' }, cwd: value.repo, env: { PATH: `${bin}:/bin:/usr/bin` } });
      assert.equal(result.kind, 'reported');
      if (result.kind !== 'reported') throw new Error('bounded report unexpectedly unknown');
      assert.equal(result.exitCode, 2);
      assert.ok(!/alice|password@example|super-secret/u.test(result.diagnostic));
      assert.match(result.diagnostic, /<redacted>/u);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
});
