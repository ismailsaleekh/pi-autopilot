import assert from 'node:assert/strict';
import { spawn, type ChildProcessLite } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseCoordinationMigrationRecoveryWork } from '../../src/core/coordination/contracts.ts';
import { runCoordinationMigration } from '../../src/core/coordination/migration.ts';
import { DurableRunSupervisorClient, type MigrationRecoveryEvidenceBoundary } from '../../src/core/coordination/supervisor.ts';
import { resolveRepoIdentity } from '../../src/core/parallel-runtime.ts';
import { hardKillProcess } from '../helpers/hard-kill-process.ts';
import { migrationTestClock, withMigrationTestFixture } from '../helpers/migration-fixture.ts';

const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const processClient = join(packageRoot, 'tests', 'helpers', 'migration-recovery-process-client.ts');

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`migration recovery subprocess did not reach boundary: ${path}`);
}

function childClose(child: ChildProcessLite): Promise<number | null> {
  return new Promise((resolveClose) => child.on('close', (code) => resolveClose(code)));
}

void describe('migration recovery evidence crash durability', () => {
  for (const boundary of ['after-evidence-temp-synced', 'after-evidence-published'] as const satisfies readonly MigrationRecoveryEvidenceBoundary[]) {
    void it(`resumes after hard death at ${boundary} without a partial final artifact`, async () => {
      await withMigrationTestFixture(async (fixture) => {
        await runCoordinationMigration({ command: 'apply', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
        await runCoordinationMigration({ command: 'verify', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
        await runCoordinationMigration({ command: 'cutover', repoKey: fixture.repoKey, env: fixture.env, clock: migrationTestClock() });
        const supervisor = new DurableRunSupervisorClient(fixture.env);
        const initial = await supervisor.client.query('status', fixture.repoKey, null);
        const values = initial.payload['migration_recovery_work'];
        if (!Array.isArray(values) || values.length !== 1 || values[0] === undefined) throw new Error('expected one pending migration recovery work row');
        const work = parseCoordinationMigrationRecoveryWork(values[0]);
        const barrier = join(fixture.root, `recovery-evidence-${boundary}`);
        await rm(barrier, { force: true });
        const child = spawn(process.execPath, ['--experimental-strip-types', processClient, fixture.stateRoot, fixture.source, fixture.repoKey, work.workstream_run, work.recovery_id, boundary, barrier], { cwd: packageRoot, env: { ...process.env, AUTOPILOT_STATE_ROOT: fixture.stateRoot }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        const closed = childClose(child);
        await waitForFile(barrier);
        hardKillProcess(child);
        assert.notEqual(await closed, 0);

        const evidenceRoot = join(fixture.stateRoot, 'migration-recovery-evidence', fixture.repoKey, work.workstream_run);
        if (boundary === 'after-evidence-temp-synced') {
          const residue = (await readdir(evidenceRoot)).find((entry) => entry.includes('.json.tmp-'));
          if (residue === undefined) throw new Error('hard death before publication did not retain its private temporary evidence');
          const finalName = residue.slice(0, residue.indexOf('.tmp-'));
          await writeFile(join(evidenceRoot, finalName), '{"partial":', 'utf8');
        }
        const pendingStatus = await supervisor.client.query('status', fixture.repoKey, work.workstream_run);
        const pendingValues = pendingStatus.payload['migration_recovery_work'];
        if (!Array.isArray(pendingValues) || pendingValues[0] === undefined) throw new Error('pending recovery work disappeared after evidence-only process death');
        const pending = parseCoordinationMigrationRecoveryWork(pendingValues[0]);
        assert.equal(pending.status, 'pending');
        const attachment = await supervisor.attachMigrationRecovery({ repo: resolveRepoIdentity(fixture.source), workstreamRun: work.workstream_run, recoveryId: work.recovery_id, rawSessionId: `resume-${boundary}` });
        const resolved = await supervisor.resolveMigrationRecovery({ attachment, recoveryWork: pending, resolution: { resolutionType: 'authority-retained' } });
        assert.equal(resolved.recoveryWork.status, 'resolved');
        const entries = await readdir(evidenceRoot);
        assert.equal(entries.filter((entry) => entry.endsWith('.json')).length, 1);
        assert.equal(entries.some((entry) => entry.includes('.tmp-') || entry.includes('.invalid-')), false);
      });
    });
  }
});
