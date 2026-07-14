import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { claimModesConflict } from '../../src/core/coordination/contracts.ts';
import { assertCoordinationObservationSourceIdentity, deriveCoordinationObservationSourceIdentity } from '../../src/core/coordination/observations.ts';
import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  if ((result.status ?? -1) !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-observation-'));
  try {
    git(root, ['init']); git(root, ['config', 'user.email', 'test@example.invalid']); git(root, ['config', 'user.name', 'Test']);
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    await writeFile(join(root, 'src', 'file.ts'), 'export const value = 1;\n', 'utf8');
    await writeFile(join(root, 'src', 'nested', 'child.ts'), 'export const child = 1;\n', 'utf8');
    await symlink('file.ts', join(root, 'src', 'link.ts'));
    git(root, ['add', '.']); git(root, ['commit', '-m', 'initial']);
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

void describe('commit-bound coordination observations', () => {
  void it('binds exact blob, symlink blob, and subtree identities to one full commit', async () => {
    await fixture(async (root) => {
      const head = git(root, ['rev-parse', 'HEAD']);
      const file = deriveCoordinationObservationSourceIdentity({ cwd: root, path: 'src/file.ts' });
      const link = deriveCoordinationObservationSourceIdentity({ cwd: root, path: 'src/link.ts' });
      const tree = deriveCoordinationObservationSourceIdentity({ cwd: root, path: 'src/**' });
      assert.equal(file.base_commit, head); assert.equal(link.base_commit, head); assert.equal(tree.base_commit, head);
      assert.equal(file.object_kind, 'blob'); assert.equal(link.object_kind, 'blob'); assert.equal(tree.object_kind, 'tree');
      assert.equal(file.object_id, git(root, ['rev-parse', 'HEAD:src/file.ts']));
      assert.equal(link.object_id, git(root, ['rev-parse', 'HEAD:src/link.ts']));
      assert.equal(tree.object_id, git(root, ['rev-parse', 'HEAD:src']));
    });
  });

  void it('detects commit movement and rejects untracked or missing paths', async () => {
    await fixture(async (root) => {
      const identity = deriveCoordinationObservationSourceIdentity({ cwd: root, path: 'src/file.ts' });
      await writeFile(join(root, 'src', 'file.ts'), 'export const value = 2;\n', 'utf8');
      // A working-tree mutation does not rewrite the immutable observed object.
      assert.doesNotThrow(() => assertCoordinationObservationSourceIdentity({ cwd: root, path: 'src/file.ts', expected: identity }));
      git(root, ['add', 'src/file.ts']); git(root, ['commit', '-m', 'change']);
      assert.throws(() => assertCoordinationObservationSourceIdentity({ cwd: root, path: 'src/file.ts', expected: identity }), (error: unknown) => error instanceof CoordinationRuntimeError && error.code === 'stale-version');
      await writeFile(join(root, 'untracked.txt'), 'untracked\n', 'utf8');
      assert.throws(() => deriveCoordinationObservationSourceIdentity({ cwd: root, path: 'untracked.txt' }), /not tracked at the exact worktree commit/u);
      assert.throws(() => deriveCoordinationObservationSourceIdentity({ cwd: root, path: 'missing.txt' }), /not tracked at the exact worktree commit/u);
    });
  });

  void it('keeps observations non-blocking for ordinary edits while bounded EXCLUSIVE remains incompatible', () => {
    assert.equal(claimModesConflict('READ', 'READ'), false);
    assert.equal(claimModesConflict('READ', 'WRITE'), false);
    assert.equal(claimModesConflict('WRITE', 'READ'), false);
    assert.equal(claimModesConflict('READ', 'EXCLUSIVE'), true);
    assert.equal(claimModesConflict('EXCLUSIVE', 'READ'), true);
    assert.equal(claimModesConflict('WRITE', 'WRITE'), false);
    assert.equal(claimModesConflict('WRITE', 'EXCLUSIVE'), true);
    assert.equal(claimModesConflict('EXCLUSIVE', 'EXCLUSIVE'), true);
  });
});
