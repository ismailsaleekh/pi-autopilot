import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';

import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

void it('derives long-path coordinator socket fallbacks from the supplied closed environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-runtime-paths-'));
  const closedTemp = join(root, 'clone-tmp');
  const longState = join(root, 'incident-states', 'i4-payload-owner-ambiguous', 'state', 'x'.repeat(80));
  try {
    await mkdir(closedTemp, { recursive: true });
    const paths = coordinatorRuntimePaths({ [AUTOPILOT_STATE_ROOT_ENV]: longState, TMPDIR: closedTemp });
    if (process.platform === 'win32') {
      assert.match(paths.socketPath, /^\\\\\.\\pipe\\pi-autopilot-/u);
      assert.match(paths.predecessorSocketPath, /^\\\\\.\\pipe\\pi-autopilot-/u);
    } else {
      assert.equal(dirname(paths.socketPath), closedTemp);
      assert.equal(dirname(paths.predecessorSocketPath), closedTemp);
    }
    assert.throws(() => coordinatorRuntimePaths({ [AUTOPILOT_STATE_ROOT_ENV]: longState, TMPDIR: 'relative-temp' }), /temporary root must be absolute/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
