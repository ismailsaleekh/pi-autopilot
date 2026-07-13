import { coordinatorRuntimePaths, readOrCreateCoordinatorCapability } from '../../src/core/coordination/runtime-paths.ts';
import { preparePredecessorCoordinatorUpgrade } from '../../src/core/coordination/upgrade.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

const stateRoot = process.argv[2];
if (stateRoot === undefined) throw new Error('state root is required');
const paths = coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot });
const capability = await readOrCreateCoordinatorCapability(paths);
const pauseBoundary = process.argv[3];
await preparePredecessorCoordinatorUpgrade(paths, capability, Date.now() + 20_000, {
  onBoundary: async (boundary) => {
    if (boundary !== pauseBoundary) return;
    console.log(boundary);
    await new Promise<void>(() => undefined);
  },
});
console.log('migration-verified');
setInterval(() => undefined, 1_000);
