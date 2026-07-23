import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { applyS2RetentionDiskPressure, clearDurableS2RetentionDiskPressure, clearS2RetentionDiskPressure, createS2RetentionProgressModel, readS2RetentionProgressState, recordS2RetentionDiskPressure, s2RetentionPressureStatePath, s2RetentionRunsPausedForWorktreeCreation } from '../../src/core/coordination/s2-retention-state-machine.ts';

function lane(model: ReturnType<typeof createS2RetentionProgressModel>, run: string) {
  const found = model.lanes.find((candidate) => candidate.workstream_run === run);
  if (found === undefined) throw new Error(`missing lane ${run}`);
  return found;
}

async function tempRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${label}-`));
}

void describe('S2-E retention progress-lane model', () => {
  void it('pauses only the offending run new worktree creation while evidence and diagnostics remain publishable', () => {
    const initial = createS2RetentionProgressModel(['run-a', 'run-b', 'run-c']);
    const pressured = applyS2RetentionDiskPressure(initial, { offendingRun: 'run-b', reason: 'disk-free-below-policy', eventSeq: 41 });

    assert.deepEqual(s2RetentionRunsPausedForWorktreeCreation(pressured), ['run-b']);
    assert.equal(lane(pressured, 'run-a').new_worktree_creation, 'running');
    assert.equal(lane(pressured, 'run-c').new_worktree_creation, 'running');
    assert.equal(lane(pressured, 'run-b').evidence_publication, 'open');
    assert.equal(lane(pressured, 'run-b').diagnostics_publication, 'open');

    const staleClear = clearS2RetentionDiskPressure(pressured, 'run-b', 40);
    assert.deepEqual(s2RetentionRunsPausedForWorktreeCreation(staleClear), ['run-b']);
    const cleared = clearS2RetentionDiskPressure(pressured, 'run-b', 41);
    assert.deepEqual(s2RetentionRunsPausedForWorktreeCreation(cleared), []);
  });

  void it('persists per-run pressure state durably for scheduler/disk-gate integration consumers', async () => {
    const root = await tempRoot('s2-retention-pressure');
    const path = s2RetentionPressureStatePath(root);
    assert.deepEqual((await readS2RetentionProgressState(path)).lanes, []);
    await recordS2RetentionDiskPressure(path, { offendingRun: 'run-durable', reason: 'disk-free-below-policy', eventSeq: 51 });
    const restarted = await readS2RetentionProgressState(path);
    assert.deepEqual(s2RetentionRunsPausedForWorktreeCreation(restarted), ['run-durable']);
    assert.equal(lane(restarted, 'run-durable').evidence_publication, 'open');
    const cleared = await clearDurableS2RetentionDiskPressure(path, 'run-durable', 51);
    assert.deepEqual(s2RetentionRunsPausedForWorktreeCreation(cleared), []);
    assert.deepEqual(s2RetentionRunsPausedForWorktreeCreation(await readS2RetentionProgressState(path)), []);
  });
});
