// Sharded 10-client persistent release-trace cohort (Phase 40 / D70 C3+C4).
// Extracted from tests/multiprocess/coordinator-process.test.ts so the 5/10/32
// cohorts run as independent sibling files (each its own coordinator, sockets,
// and state root) instead of one serial file. Test name and body are identical
// to the pre-split cohort loop; the shared harness holds certifyPersistentReleaseTrace
// byte-for-byte, including the O(1)-round-trip cadence assertion and every
// crash/handoff/defer/cancel/supersede/reacquire/fairness path.

import { after, describe, it } from 'node:test';

import { assertNoLeakedCoordinators } from '../helpers/coordinator-process-lifecycle.ts';
import { certifyPersistentReleaseTrace } from '../helpers/coordinator-process-harness.ts';

void describe('coordinator multiprocess lifecycle', () => {
  after(async () => { await assertNoLeakedCoordinators(); });

  void it(`runs the seeded reproducible 10-client persistent randomized release trace`, async () => {
    await certifyPersistentReleaseTrace(10);
  });
});
