import { writeFile } from 'node:fs/promises';

import { runCoordinationMigration, type CoordinationMigrationCommand, type CoordinationMigrationCrashBoundary } from '../../src/core/coordination/migration.ts';
import { migrationTestClock } from './migration-fixture.ts';

const [command, repoKey, stateRoot, boundary, barrier] = process.argv.slice(2);
if (command === undefined || repoKey === undefined || stateRoot === undefined || boundary === undefined || barrier === undefined) throw new Error('migration process client requires command, repo key, state root, boundary, and barrier');
await runCoordinationMigration({
  command: command as CoordinationMigrationCommand,
  repoKey,
  env: { ...process.env, AUTOPILOT_STATE_ROOT: stateRoot },
  clock: migrationTestClock(),
  afterBoundary: async (reached) => {
    if (reached !== boundary as CoordinationMigrationCrashBoundary) return;
    await writeFile(barrier, `${reached}\n`, 'utf8');
    await new Promise<void>(() => { setInterval(() => undefined, 1_000); });
  },
});
