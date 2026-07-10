import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { scanTrackedTree } from '../../src/core/checkout-profile.ts';

async function withTempRepo<T>(run: (repoRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'autopilot-checkout-profile-test-'));
  try {
    git(repoRoot, ['init']);
    git(repoRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    return await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

function git(repoRoot: string, args: readonly string[], input?: string): string {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function largeTreeFastImport(entryCount: number): string {
  const lines = [
    'blob',
    'mark :1',
    'data 1',
    'x',
    'commit refs/heads/main',
    'mark :2',
    'committer Autopilot Test <autopilot@example.invalid> 1700000000 +0000',
    'data 10',
    'large tree',
  ];
  const longStem = 'x'.repeat(180);
  for (let index = 0; index < entryCount; index += 1) {
    lines.push(`M 100644 :1 large/${String(index).padStart(6, '0')}-${longStem}.txt`);
  }
  lines.push('', 'done', '');
  return lines.join('\n');
}

void describe('streamed tracked-tree scan', () => {
  void it('scans ls-tree output larger than spawnSync maxBuffer without buffering the command output', async () => {
    await withTempRepo(async (repoRoot) => {
      const entryCount = 6_000;
      git(repoRoot, ['fast-import', '--quiet'], largeTreeFastImport(entryCount));

      const scan = await scanTrackedTree(repoRoot, new Date('2026-07-10T00:00:00.000Z'));
      const minimumWireBytes = scan.entries.reduce((sum, entry) => sum + 56 + new TextEncoder().encode(entry.path).length, 0);

      assert.ok(minimumWireBytes > 1_048_576, `fixture must exceed Node's historical 1 MiB child-output buffer; got ${String(minimumWireBytes)} bytes`);
      assert.equal(scan.entries.length, entryCount);
      assert.equal(scan.total_bytes, entryCount);
      assert.equal(scan.head_sha, git(repoRoot, ['rev-parse', 'HEAD']));
      assert.equal(scan.scanned_at, '2026-07-10T00:00:00.000Z');
      assert.equal(scan.entries[0]?.path.startsWith('large/000000-'), true);
      assert.equal(scan.entries.at(-1)?.path.startsWith('large/005999-'), true);
    });
  });
});
