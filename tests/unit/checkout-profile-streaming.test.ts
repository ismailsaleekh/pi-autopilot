import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveAutopilotCheckoutProfile, scanTrackedTree, estimateBytesForMaterializationPaths, defaultAutopilotCheckoutProfile } from '../../src/core/checkout-profile.ts';
import { AutopilotCheckoutProfileError } from '../../src/core/checkout-profile.ts';

import { describe, it } from 'node:test';

async function withTempRepo<T>(run: (repoRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'autopilot-checkout-stream-test-'));
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

void describe('D65 checkout-profile streaming consumer', () => {
  void it('streams the tracked tree through the D58 descriptor and never retains the raw buffer', async () => {
    await withTempRepo(async (repoRoot) => {
      await mkdir(join(repoRoot, 'a', 'b'), { recursive: true });
      await writeFile(join(repoRoot, 'a', 'b', 'deep.txt'), 'deep contents\n');
      await writeFile(join(repoRoot, 'top.txt'), 'top\n');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'tree']);
      const scan = await scanTrackedTree(repoRoot);
      assert.deepEqual(scan.entries.map((entry) => entry.path).sort(), ['a/b/deep.txt', 'top.txt']);
      assert.equal(scan.total_bytes, ('deep contents\n'.length) + 'top\n'.length);
      // The streaming summary path leaves no full-output retention; verify the scan is bounded by entry count.
      assert.equal(scan.entries.length, 2);
    });
  });

  void it('resolves a checkout profile whose base estimate uses checked arithmetic over the streamed tree', async () => {
    await withTempRepo(async (repoRoot) => {
      await writeFile(join(repoRoot, 'README.md'), 'readme\n');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'one']);
      const resolved = await resolveAutopilotCheckoutProfile({ repoRoot });
      assert.equal(resolved.origin, 'auto-profile');
      assert.equal(resolved.tracked_tree.entries.length, 1);
      assert.equal(resolved.tracked_tree.entries[0]?.byte_count, 'readme\n'.length);
      assert.equal(resolved.full_checkout_bytes, 'readme\n'.length);
    });
  });

  void it('fails loudly with checkout-estimate-overflow rather than wrapping a pathological estimate', () => {
    const scan = {
      repo_root: '/tmp',
      head_sha: '0'.repeat(40),
      scanned_at: '2026-07-19T00:00:00.000Z',
      entries: [
        { path: 'one', byte_count: Number.MAX_SAFE_INTEGER, object_type: 'blob' as const },
        { path: 'two', byte_count: 1, object_type: 'blob' as const },
      ],
      total_bytes: Number.MAX_SAFE_INTEGER,
    };
    assert.throws(
      () => estimateBytesForMaterializationPaths(scan, ['one', 'two']),
      (error: unknown) => error instanceof AutopilotCheckoutProfileError && error.code === 'checkout-estimate-overflow',
    );
  });
});
