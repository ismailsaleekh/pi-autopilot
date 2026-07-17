import { CoordinatorStore } from '../../src/core/coordination/store.ts';
import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { STORE_PUBLICATION_BOUNDARIES, type StorePublicationBoundary } from '../../src/core/coordination/store-generation.ts';

const requested = process.argv[2];
const boundary: StorePublicationBoundary | undefined = STORE_PUBLICATION_BOUNDARIES.find((candidate) => candidate === requested);
if (boundary === undefined) throw new Error('generation publication boundary is invalid');
let reached = false;
await CoordinatorStore.open(coordinatorRuntimePaths(), undefined, {
  onStorePublicationBoundary: async (observed) => {
    if (reached || observed !== boundary) return;
    reached = true;
    console.log(JSON.stringify({ state: 'boundary', boundary, pid: process.pid }));
    await new Promise<void>(() => { setInterval(() => undefined, 1_000); });
  },
});
throw new Error(`generation publication completed without reaching ${boundary}`);
