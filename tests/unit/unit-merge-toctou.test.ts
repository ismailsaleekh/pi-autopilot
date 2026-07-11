import { describe, it } from 'node:test';

import { mergeAutopilotUnit } from '../../src/core/unit-merge.ts';
import { assertUnitMergeDriftBlocksWithoutMutation, assertUnitMergeHappyPath } from '../helpers/unit-merge-regression.ts';

void describe('unit merge execution-commit authority', () => {
  void it('merges the exact evidenced source commit', async () => {
    await assertUnitMergeHappyPath(mergeAutopilotUnit);
  });

  void it('blocks clean branch drift before integration mutation', async () => {
    await assertUnitMergeDriftBlocksWithoutMutation(mergeAutopilotUnit);
  });
});
