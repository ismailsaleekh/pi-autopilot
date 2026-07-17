import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import { CoordinatorWriterGuard } from '../../src/core/coordination/writer-guard.ts';

void describe('S1 writer-guard authority-root binding', () => {
  void it('refuses to authorize a store under a different coordinator root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'pi-autopilot-guard-root-binding-'));
    const first = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(parent, 'first') });
    const second = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(parent, 'second') });
    const guard = await CoordinatorWriterGuard.acquire(first);
    try {
      assert.throws(() => guard.assertHeldFor(second), /different coordinator authority root/u);
      await assert.rejects(() => CoordinatorStore.open(second, undefined, { writerGuard: guard }), /different coordinator authority root/u);
      assert.equal(existsSync(second.currentStorePointerPath), false);
      guard.assertHeldFor(first);
    } finally {
      guard.release();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
