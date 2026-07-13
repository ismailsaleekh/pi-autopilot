import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { CoordinatorStore, type CoordinatorSemanticReplayBoundary } from '../../src/core/coordination/store.ts';
import type { ProcessEnvLike } from '../../src/core/parallel-runtime.ts';

const stateRoot = process.argv[2];
const target = process.argv[3] as CoordinatorSemanticReplayBoundary | undefined;
if (stateRoot === undefined || target === undefined) throw new Error('usage: semantic-replay-process <state-root> <boundary>');
const env: ProcessEnvLike = { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot };
await mkdir(stateRoot, { recursive: true });
const store = await CoordinatorStore.open(coordinatorRuntimePaths(env), { now: () => new Date('2026-07-13T02:00:00.000Z') }, {
  onSemanticReplayBoundary: async (boundary) => {
    if (boundary !== target) return;
    await writeFile(join(stateRoot, `semantic-replay-${boundary}.ready`), `${String(process.pid)}\n`, { encoding: 'utf8', mode: 0o600 });
    await new Promise<void>(() => { setInterval(() => undefined, 1_000); });
  },
});
store.close();
