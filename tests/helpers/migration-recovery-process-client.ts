import { writeFile } from 'node:fs/promises';

import { parseCoordinationMigrationRecoveryWork } from '../../src/core/coordination/contracts.ts';
import { DurableRunSupervisorClient, type MigrationRecoveryEvidenceBoundary } from '../../src/core/coordination/supervisor.ts';
import { resolveRepoIdentity } from '../../src/core/parallel-runtime.ts';

const [stateRoot, source, repoKey, workstreamRun, recoveryId, boundary, barrier] = process.argv.slice(2);
if (stateRoot === undefined || source === undefined || repoKey === undefined || workstreamRun === undefined || recoveryId === undefined || boundary === undefined || barrier === undefined) throw new Error('migration recovery process client requires state root, source, repo, run, recovery, boundary, and barrier');
const env = { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot };
const supervisor = new DurableRunSupervisorClient(env);
const status = await supervisor.client.query('status', repoKey, workstreamRun);
const values = status.payload['migration_recovery_work'];
if (!Array.isArray(values)) throw new Error('migration recovery status is missing work rows');
const workValue = values.find((value) => typeof value === 'object' && value !== null && !Array.isArray(value) && (value as Readonly<Record<string, unknown>>)['recovery_id'] === recoveryId);
if (workValue === undefined) throw new Error('requested migration recovery work is missing');
const work = parseCoordinationMigrationRecoveryWork(workValue);
const attachment = await supervisor.attachMigrationRecovery({ repo: resolveRepoIdentity(source), workstreamRun, recoveryId, rawSessionId: `hard-kill-${boundary}` });
await supervisor.resolveMigrationRecovery({
  attachment,
  recoveryWork: work,
  resolution: { resolutionType: 'authority-retained' },
  afterEvidenceBoundary: async (reached) => {
    if (reached !== boundary as MigrationRecoveryEvidenceBoundary) return;
    await writeFile(barrier, `${reached}\n`, 'utf8');
    await new Promise<void>(() => { setInterval(() => undefined, 1_000); });
  },
});
