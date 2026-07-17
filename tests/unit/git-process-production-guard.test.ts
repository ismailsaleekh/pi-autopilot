import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { WORKTREE_POSTCONDITION_REGISTRY } from '../../src/core/coordination/worktree-postconditions.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const coreRoot = join(packageRoot, 'src', 'core');

function sourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}

void describe('production Git and saga truth mechanical guards', () => {
  void it('exposes exactly the nine frozen canonical operation postconditions', () => {
    assert.deepEqual(Object.keys(WORKTREE_POSTCONDITION_REGISTRY).sort(), ['archive', 'commit', 'create', 'materialize', 'merge', 'metadata-reconcile', 'quarantine', 'remove', 'reset']);
  });

  void it('permits raw Git process creation only in the closed package boundary', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(coreRoot)) {
      const name = relative(coreRoot, path).replace(/\\/gu, '/');
      const source = readFileSync(path, 'utf8');
      const raw = /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*['"]git['"]/u.test(source);
      if (raw && name !== 'git-process.ts') violations.push(name);
    }
    assert.deepEqual(violations, []);
  });

  void it('keeps caller-owned inspect/verify truth out of every saga consumer', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(coreRoot)) {
      if (path.endsWith('coordination/worktree-postconditions.ts')) continue;
      const source = readFileSync(path, 'utf8');
      if (/\bWorktreeSagaInspection\b|\bfixedInspection\s*\(|\b(?:inspect|verify)\s*:\s*(?:async\s*)?\(/u.test(source)) violations.push(relative(coreRoot, path).replace(/\\/gu, '/'));
    }
    assert.deepEqual(violations, []);
  });
});
