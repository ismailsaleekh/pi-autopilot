import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AutopilotRosterActivationStore } from '../../src/extension.ts';
import { resolveRepoIdentity } from '../../src/core/parallel-runtime.ts';
import { canonicalRosterJson } from '../../src/core/roster/canonical.ts';
import { SEED_ROSTERS } from '../../src/core/roster/provider-recipes.ts';
import { buildCanonicalPreRunSelection } from '../../src/core/roster/run-selection.ts';
import { requestProfileFromAssignment } from '../../src/core/roster/runtime-spec.ts';
import { resolveRosterScopePaths, rosterRevisionPath } from '../../src/core/roster/storage.ts';

export function sdkReadyRosterActivationStore(): AutopilotRosterActivationStore {
  return {
    async resolve(input) {
      const cwd = input.ctx.cwd;
      if (cwd === undefined) throw new Error('SDK ready-roster fixture requires a cwd');
      const stateRoot = input.env['AUTOPILOT_STATE_ROOT'];
      if (stateRoot === undefined) throw new Error('SDK ready-roster fixture requires AUTOPILOT_STATE_ROOT');
      const repo = resolveRepoIdentity(cwd);
      const roster = SEED_ROSTERS.find((entry) => entry.roster_id.startsWith('cruise-'));
      if (roster === undefined) throw new Error('SDK ready-roster fixture is unavailable');
      const parent = roster.assignments.find((entry) => entry.role === 'strategy');
      if (parent === undefined) throw new Error('SDK ready-roster fixture lacks a strategy assignment');
      const publication = buildCanonicalPreRunSelection({
        stateRoot,
        repo_id: repo.repoKey,
        workstream_run: input.plannedWorkstreamRun,
        selected: {
          scope: roster.scope,
          roster_id: roster.roster_id,
          roster_revision: roster.roster_revision,
          roster_sha256: requireDigest(roster.roster_sha256),
          assignment_set_sha256: requireDigest(roster.assignment_set_sha256),
          config_sha256: 'sha256:8888888888888888888888888888888888888888888888888888888888888888',
        },
        selected_at: input.now.toISOString(),
      });
      const paths = resolveRosterScopePaths({ scope: 'user', stateRoot });
      const rosterPath = rosterRevisionPath(paths, roster);
      for (const directory of [stateRoot, paths.selectionsRoot, dirname(publication.selection_path), paths.rostersRoot, dirname(rosterPath)]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
      }
      await writeFile(publication.selection_path, publication.selection_bytes, { flag: 'wx', mode: 0o600 });
      await writeFile(rosterPath, `${canonicalRosterJson(roster)}\n`, { flag: 'wx', encoding: 'utf8', mode: 0o600 });
      const requestProfile = requestProfileFromAssignment(parent);
      return {
        status: 'resolved',
        diagnostics: [],
        selection: {
          source: 'explicit-roster',
          existingRun: false,
          scope: roster.scope,
          roster_id: roster.roster_id,
          roster_revision: roster.roster_revision,
          roster_sha256: requireDigest(roster.roster_sha256),
          assignment_set_sha256: requireDigest(roster.assignment_set_sha256),
          config_sha256: publication.selection.config_sha256,
          workstream_run: publication.selection.workstream_run,
          pre_run_selection: publication.selection,
          pre_run_selection_path: publication.selection_path,
          selection_bytes: publication.selection_bytes,
          launch_fence: {
            schema_version: 'autopilot.run_selection_launch_fence.v1',
            token_id: randomUUID(),
            repo_id: publication.selection.repo_id,
            workstream_run: publication.selection.workstream_run,
            selection_sha256: requireDigest(publication.selection.selection_sha256),
            selection_path: publication.selection_path,
            issued_at: input.now.toISOString(),
            readback_verified: true,
          },
          runtime_mirror_path: null,
          parent: { model: requestProfile.model, thinking: requestProfile.thinking },
        },
      };
    },
  };
}

function requireDigest(value: string): `sha256:${string}` {
  if (!isDigest(value)) throw new Error(`invalid SDK ready-roster digest: ${value}`);
  return value;
}

function isDigest(value: string): value is `sha256:${string}` {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}
