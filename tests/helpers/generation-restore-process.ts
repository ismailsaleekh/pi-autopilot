import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { STORE_PUBLICATION_BOUNDARIES, type StorePublicationBoundary } from '../../src/core/coordination/store-generation.ts';
import { CoordinatorStore } from '../../src/core/coordination/store.ts';

function isSha256(value: string | undefined): value is `sha256:${string}` { return value !== undefined && /^sha256:[a-f0-9]{64}$/u.test(value); }

const requested = process.argv[2];
const source = process.argv[3];
const sourceSha256 = process.argv[4];
const boundary: StorePublicationBoundary | undefined = STORE_PUBLICATION_BOUNDARIES.find((candidate) => candidate === requested);
if (boundary === undefined || source === undefined || !isSha256(sourceSha256)) throw new Error('generation restore boundary/source is invalid');
let reached = false;
await CoordinatorStore.restoreGeneration(coordinatorRuntimePaths(), source, sourceSha256, undefined, async (observed) => {
  if (reached || observed !== boundary) return;
  reached = true;
  console.log(JSON.stringify({ state: 'boundary', boundary, pid: process.pid }));
  await new Promise<void>(() => { setInterval(() => undefined, 1_000); });
});
throw new Error(`generation restore completed without reaching ${boundary}`);
