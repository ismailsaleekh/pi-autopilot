import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { canonicalRosterJson } from '../../src/core/roster/canonical.ts';
import { SEED_ROSTERS } from '../../src/core/roster/provider-recipes.ts';
import { buildCanonicalPreRunSelection, bytesEqual } from '../../src/core/roster/run-selection.ts';
import {
  materializeNewRunUnitSpecV2,
  requestProfileFromAssignment,
  type AutopilotRosterSelectionV1,
  type AutopilotRosterUnitSpecV2,
  type AutopilotRosterV1,
  type AutopilotUnitSpecV2MaterializationInput,
} from '../../src/core/roster/runtime-spec.ts';
import { runtimeRosterSnapshotPath } from '../../src/core/roster/snapshot.ts';
import { resolveRosterScopePaths, rosterRevisionPath } from '../../src/core/roster/storage.ts';
import { readAuthorityFileIfPresent } from '../../src/core/roster/transaction.ts';

export interface RuntimeRosterAuthorityFixture {
  readonly selection: AutopilotRosterSelectionV1;
  readonly roster: AutopilotRosterV1;
}

export async function installRuntimeRosterAuthority(input: {
  readonly stateRoot: string;
  readonly mainWorktreePath: string;
  readonly workstream: string;
  readonly repoId: string;
  readonly workstreamRun: string;
}): Promise<RuntimeRosterAuthorityFixture> {
  const roster = SEED_ROSTERS.find((entry) => entry.roster_id.startsWith('cruise-') && entry.assignments.some((assignment) => assignment.role === 'implement' && assignment.service_tier === null) && entry.assignments.some((assignment) => assignment.role === 'validate' && assignment.service_tier === null));
  if (roster === undefined) throw new Error('runtime roster fixture requires implement and validate assignments');
  const publication = buildCanonicalPreRunSelection({
    stateRoot: input.stateRoot,
    repo_id: input.repoId,
    workstream_run: input.workstreamRun,
    selected: {
      scope: roster.scope,
      roster_id: roster.roster_id,
      roster_revision: roster.roster_revision,
      roster_sha256: requireDigest(roster.roster_sha256),
      assignment_set_sha256: requireDigest(roster.assignment_set_sha256),
      config_sha256: 'sha256:7777777777777777777777777777777777777777777777777777777777777777',
    },
    selected_at: '2026-07-23T12:00:00.000Z',
  });
  const paths = resolveRosterScopePaths({ scope: 'user', stateRoot: input.stateRoot });
  const rosterPath = rosterRevisionPath(paths, roster);
  const mirrorPath = runtimeRosterSnapshotPath({ mainWorktreeRoot: input.mainWorktreePath, workstream: input.workstream });
  for (const directory of [input.stateRoot, paths.rostersRoot, dirname(rosterPath), paths.selectionsRoot, dirname(publication.selection_path), dirname(mirrorPath)]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  await writeFile(publication.selection_path, publication.selection_bytes, { mode: 0o600 });
  await writeFile(mirrorPath, publication.selection_bytes, { mode: 0o600 });
  await writeFile(rosterPath, `${canonicalRosterJson(roster)}\n`, { encoding: 'utf8', mode: 0o600 });
  const externalRead = await readAuthorityFileIfPresent(publication.selection_path, paths.userStateRoot);
  const mirrorRead = await readAuthorityFileIfPresent(mirrorPath, dirname(mirrorPath));
  if (externalRead === null || mirrorRead === null || !bytesEqual(externalRead.bytes, mirrorRead.bytes)) throw new Error('runtime roster fixture failed exact safe readback');
  return { selection: publication.selection, roster };
}

export function runtimeRosterUnitSpec(
  authority: RuntimeRosterAuthorityFixture,
  input: Omit<AutopilotUnitSpecV2MaterializationInput, 'selection' | 'roster' | 'request_profile'>,
): AutopilotRosterUnitSpecV2 {
  const assignment = authority.roster.assignments.find((entry) => entry.role === input.role);
  if (assignment === undefined) throw new Error(`runtime roster fixture lacks role ${input.role}`);
  return materializeNewRunUnitSpecV2({
    ...input,
    selection: authority.selection,
    roster: authority.roster,
    request_profile: requestProfileFromAssignment(assignment),
  });
}

function requireDigest(value: string): `sha256:${string}` {
  if (!isDigest(value)) throw new Error(`invalid runtime roster fixture digest: ${value}`);
  return value;
}

function isDigest(value: string): value is `sha256:${string}` {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}
