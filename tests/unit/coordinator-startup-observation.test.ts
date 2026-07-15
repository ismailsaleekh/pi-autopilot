import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { coordinatorRuntimePaths } from '../../src/core/coordination/runtime-paths.ts';
import { createCoordinatorStartupAttemptId, createCoordinatorStartupObserver, readCoordinatorStartupReport } from '../../src/core/coordination/startup-observation.ts';
import { AUTOPILOT_STATE_ROOT_ENV } from '../../src/core/parallel-runtime.ts';

void it('publishes bounded redacted explicit-truncation startup diagnostics atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-startup-report-'));
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') };
  const paths = coordinatorRuntimePaths(env);
  const attemptId = createCoordinatorStartupAttemptId();
  try {
    const observer = await createCoordinatorStartupObserver(paths, attemptId, env);
    await observer.transition('before-sqlite-open-reconciliation');
    const secret = 'a'.repeat(64);
    await observer.failed(new Error(`child_token=${secret} capability=${'b'.repeat(64)} ${'oversized '.repeat(2_000)}`));
    const report = readCoordinatorStartupReport(observer.reportPath, attemptId);
    assert.notEqual(report, null);
    assert.equal(report?.outcome, 'failed');
    assert.equal(report?.phase, 'before-sqlite-open-reconciliation');
    assert.equal(report?.diagnostics_truncated, true);
    assert.ok((report?.omitted_code_points ?? 0) > 0);
    assert.match(report?.error ?? '', /child_token=<redacted>/u);
    assert.match(report?.error ?? '', /capability=<redacted>/u);
    assert.equal((report?.error ?? '').includes(secret), false);
    assert.ok((await readFile(observer.reportPath)).byteLength < 32 * 1024);
  } finally { await rm(root, { recursive: true, force: true }); }
});

void it('fails closed on a diagnostic-path symlink without following or mutating its target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-autopilot-startup-report-symlink-'));
  const env = { ...process.env, [AUTOPILOT_STATE_ROOT_ENV]: join(root, 'state') };
  const paths = coordinatorRuntimePaths(env);
  const attemptId = createCoordinatorStartupAttemptId();
  const target = join(root, 'outside-target');
  try {
    const observer = await createCoordinatorStartupObserver(paths, attemptId, env);
    await writeFile(target, 'unchanged\n', { encoding: 'utf8', mode: 0o600 });
    await symlink(target, observer.reportPath);
    await assert.rejects(() => observer.transition('before-lifecycle-election'), /symbolic-link|alias/u);
    assert.equal(await readFile(target, 'utf8'), 'unchanged\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
