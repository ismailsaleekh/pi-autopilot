import { describe, it } from 'node:test';

import { assertUnitMergeDriftBlocksWithoutMutation, assertUnitMergeHappyPath, type AutopilotUnitMergeExecutor } from '../helpers/unit-merge-regression.ts';

void describe('compiled unit merge execution-commit authority', () => {
  void it('merges the exact evidenced source commit through dist', async () => {
    await assertUnitMergeHappyPath(await loadDistUnitMerge());
  });

  void it('blocks clean branch drift before integration mutation through dist', async () => {
    await assertUnitMergeDriftBlocksWithoutMutation(await loadDistUnitMerge());
  });
});

async function loadDistUnitMerge(): Promise<AutopilotUnitMergeExecutor> {
  const moduleUrl = new URL('../../dist/src/core/unit-merge.js', import.meta.url).href;
  const loaded: unknown = await import(moduleUrl);
  if (!isRecord(loaded)) throw new TypeError('compiled unit-merge module must be an object');
  const candidate = loaded['mergeAutopilotUnit'];
  if (typeof candidate !== 'function') throw new TypeError('compiled unit-merge module must export mergeAutopilotUnit');
  return candidate as AutopilotUnitMergeExecutor;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
