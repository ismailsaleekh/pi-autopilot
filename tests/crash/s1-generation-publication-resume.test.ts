import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { readCurrentStoreGeneration, STORE_PUBLICATION_BOUNDARIES, type StorePublicationBoundary } from '../../src/core/coordination/store-generation.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

class PublicationCrash extends Error {
  override readonly name = 'PublicationCrash';
  readonly boundary: StorePublicationBoundary;
  constructor(boundary: StorePublicationBoundary) { super(`crash-after:${boundary}`); this.boundary = boundary; }
}

void describe('S1 store publication crash recovery', () => {
  for (const boundary of STORE_PUBLICATION_BOUNDARIES) {
    void it(`selects only a complete generation after ${boundary}`, async () => {
      const root = await mkdtemp(join(tmpdir(), `pi-autopilot-s1-publish-${boundary}-`));
      const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: root });
      let injected = false;
      try {
        await assert.rejects(() => CoordinatorStore.open(paths, undefined, {
          onStorePublicationBoundary: (observed) => {
            if (!injected && observed === boundary) { injected = true; throw new PublicationCrash(observed); }
          },
        }), new RegExp(`crash-after:${boundary}`, 'u'));
        assert.equal(injected, true);
        const recovered = await CoordinatorStore.open(paths);
        const selected = recovered.currentGeneration();
        try {
          assert.equal(selected.pointer.generation_id, selected.publication.generation_id);
          assert.equal(selected.pointer.store_schema_version, 13);
          assert.equal(selected.publication.store_schema_version, 13);
          assert.equal(recovered.integrity(), 'ok');
          const staging = (await readdir(paths.storesRoot)).filter((name) => name.startsWith('.staging-'));
          assert.deepEqual(staging, []);
          assert.equal(readCurrentStoreGeneration(paths)?.pointer.generation_id, selected.pointer.generation_id);
        } finally { recovered.close(); }
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
});
