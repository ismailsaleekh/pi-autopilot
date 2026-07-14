import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';

import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { startCoordinatorServer } from '../../src/core/coordination/server.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

const stateRoot = process.argv[2];
const evidencePath = process.argv[3];
const crashAction = process.argv[4] ?? 'attach-session';
if (stateRoot === undefined || evidencePath === undefined) throw new Error('coordinator response crash helper requires state root and evidence path');

const running = await startCoordinatorServer(coordinatorRuntimePaths({ ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: stateRoot }), undefined, undefined, {
  afterStoreCommitBeforeResponse: (action, response) => {
    if (action !== crashAction) return;
    const descriptor = openSync(evidencePath, 'wx', 0o600);
    try {
      const bytes = Buffer.from(`${JSON.stringify(response)}\n`, 'utf8');
      let offset = 0;
      while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    process.kill(process.pid, 'SIGKILL');
  },
});

await new Promise<void>((resolveWait) => {
  const close = (): void => { void running.close().finally(resolveWait); };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
});
