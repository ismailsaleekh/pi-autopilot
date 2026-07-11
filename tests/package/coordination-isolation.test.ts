import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { assertStandalonePackageBoundary, scanStandalonePackageBoundary } from '../../src/core/coordination/package-isolation.ts';

const packageRoot = new URL('../../', import.meta.url).pathname;

void describe('Autopilot standalone package boundary', () => {
  void it('contains no production dependency on closed repository surfaces', async () => {
    assert.deepEqual(await scanStandalonePackageBoundary(packageRoot, { includeTests: true }), []);
    await assertStandalonePackageBoundary(packageRoot);
  });

  void it('rejects closed runtime imports and product-specific fixture assumptions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autopilot-isolation-scan-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      const closedImport = ['orchestrator', 'src', 'dev', 'coordination.js'].join('/');
      const productPath = ['products', 'stroy-mart', 'product'].join('/');
      await writeFile(join(root, 'src', 'bad.ts'), `export const first = '${closedImport}';\nexport const second = '${productPath}';\n`, 'utf8');
      const violations = await scanStandalonePackageBoundary(root);
      assert.equal(violations.length, 2);
      assert.deepEqual(violations.map((entry) => entry.rule).sort(), ['closed development runtime import', 'product fixture assumption']);
      await expectRejects(() => assertStandalonePackageBoundary(root), /standalone package boundary scan/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('refuses symbolic-link traversal instead of scanning outside the package root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autopilot-isolation-symlink-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'outside.ts'), 'export const outside = true;\n', 'utf8');
      const result = await import('node:fs/promises');
      await result.symlink(join(root, 'outside.ts'), join(root, 'src', 'linked.ts'));
      await expectRejects(() => scanStandalonePackageBoundary(root), /refuses symbolic links/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function expectRejects(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof Error)) throw new Error('expected package isolation rejection');
  assert.match(caught.message, pattern);
}
