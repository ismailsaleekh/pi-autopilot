import assert from 'node:assert/strict';
import { existsSync, lstatSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { isValidWorkstreamRun } from '../../src/core/paths.ts';
import { canonicalRosterJson } from '../../src/core/roster/canonical.ts';
import { SEED_CANDIDATES } from '../../src/core/roster/provider-recipes.ts';
import {
  buildCanonicalPreRunSelection,
  resolveAndCommitPreRunSelection,
  type RunSelectionAuthority,
} from '../../src/core/roster/run-selection.ts';
import {
  publishRuntimeRosterSnapshot,
  recoverRuntimeRosterSelection,
  runtimeRosterSnapshotPath,
  type RuntimeSelectionSpecIdentity,
} from '../../src/core/roster/snapshot.ts';
import {
  preRunSelectionPath,
  resolveRosterScopePaths,
  type RosterSha256,
} from '../../src/core/roster/storage.ts';

const CONFIG_SHA: RosterSha256 = 'sha256:1d8a144806f7bd3df23724eb702223c7180b4d160cb09fc8cff5cbc77a1e3a38';
const OTHER_CONFIG_SHA: RosterSha256 = 'sha256:2d8a144806f7bd3df23724eb702223c7180b4d160cb09fc8cff5cbc77a1e3a38';
const SELECTED_AT = '2026-07-22T12:01:00.000Z';
const ISSUED_AT = '2026-07-22T12:01:01.000Z';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const root = await realpath(tmpdir());
  const dir = await mkdtemp(join(root, 'roster-run-selection-'));
  try {
    await chmod(dir, 0o700);
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function cruiseCandidate() {
  const candidate = SEED_CANDIDATES.find((entry) => entry.candidate_id === 'codex-cruise-v1');
  if (candidate === undefined) throw new Error('missing codex cruise candidate');
  return candidate;
}

function authority(
  source: RunSelectionAuthority['source'],
  overrides: Partial<RunSelectionAuthority> = {},
): RunSelectionAuthority {
  const candidate = cruiseCandidate();
  const base: RunSelectionAuthority = {
    source,
    state: 'present',
    scope: source === 'trusted-project-default' ? 'trusted-project' : 'user',
    roster_id: candidate.roster_id,
    roster_revision: candidate.roster_revision,
    roster_sha256: candidate.roster_sha256 as RosterSha256,
    assignment_set_sha256: candidate.assignment_set_sha256 as RosterSha256,
    config_sha256: CONFIG_SHA,
    ...(source === 'trusted-project-default' ? { trusted: true } : {}),
  };
  return { ...base, ...overrides };
}

function diagnosticCodes(result: { readonly diagnostics: readonly { readonly code: string }[] }): readonly string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('required value missing');
  return value;
}

async function commitSelection(stateRoot: string, overrides: Partial<Parameters<typeof resolveAndCommitPreRunSelection>[0]> = {}) {
  return await resolveAndCommitPreRunSelection({
    stateRoot,
    repo_id: 'repo-phase37-w0-fixtures',
    workstream_run: 'phase37-w0-run-001',
    user_default: authority('user-default'),
    selected_at: SELECTED_AT,
    issued_at: ISSUED_AT,
    ...overrides,
  });
}

function specIdentity(result: Awaited<ReturnType<typeof commitSelection>>, workstream = 'phase37'): RuntimeSelectionSpecIdentity {
  const selection = required(result.selection);
  return {
    schema_version: 'autopilot.unit_spec.v2',
    workstream,
    roster_id: selection.roster_id,
    roster_revision: selection.roster_revision,
    roster_sha256: selection.roster_sha256 as RosterSha256,
    pre_run_selection_sha256: selection.selection_sha256 as RosterSha256,
  };
}

void describe('D69 W3 immutable pre-run selection/runtime snapshot lane', () => {
  void it('accepts the exact production timestamped KBG workstream-run identity and keeps the path grammar closed', async () => {
    await withTempDir(async (dir) => {
      const exactRun = 'kbg-finalize-fresh-20260722T220032Z-181913';
      assert.equal(isValidWorkstreamRun(exactRun), true);
      assert.equal(isValidWorkstreamRun('kbg-finalize-fresh-20260722t220032z-181913'), true);
      for (const invalidRun of ['bad_run', '../escape', 'bad/run', 'é-run', `a${'a'.repeat(120)}`]) {
        assert.equal(isValidWorkstreamRun(invalidRun), false, invalidRun);
      }
      const publication = buildCanonicalPreRunSelection({
        stateRoot: join(dir, 'state'),
        repo_id: 'sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        workstream_run: exactRun,
        selected: authority('user-default'),
        selected_at: SELECTED_AT,
      });
      assert.equal(publication.selection.workstream_run, exactRun);
      assert.match(publication.selection_path, /kbg-finalize-fresh-20260722T220032Z-181913\.json$/u);
      assert.throws(() => buildCanonicalPreRunSelection({
        stateRoot: join(dir, 'bad-state'),
        repo_id: 'repo-valid',
        workstream_run: 'bad_run',
        selected: authority('user-default'),
        selected_at: SELECTED_AT,
      }), /workstream_run is not a valid roster storage path segment/u);
    });
  });

  void it('resolves, publishes canonical selection, verifies readback, then opens mutation/spend gates', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const gateEvents: string[] = [];
      const result = await commitSelection(stateRoot, {
        hooks: {
          onOrderingStage: (event) => {
            gateEvents.push(event.stage);
          },
          beforeWorktreeMutation: async (context) => {
            gateEvents.push('mutation-hook');
            assert.equal(existsSync(context.selection_path), true);
            assert.equal(bytesEqual(await readFile(context.selection_path), context.selection_bytes), true);
            assert.equal(context.token.readback_verified, true);
            assert.equal(gateEvents.includes('after-selection-readback'), true);
          },
          beforeModelSpend: async (context) => {
            gateEvents.push('spend-hook');
            assert.equal(existsSync(context.selection_path), true);
            assert.equal(bytesEqual(await readFile(context.selection_path), context.selection_bytes), true);
            assert.equal(context.token.selection_sha256, context.selection.selection_sha256);
            assert.equal(gateEvents.includes('mutation-hook'), true);
          },
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, 'committed');
      assert.equal(result.source, 'user-default');
      assert.equal(result.write_count, 1);
      assert.equal(result.lock_count, 0);
      assert.equal(required(result.launch_fence).issued_at, ISSUED_AT);
      assert.equal(gateEvents.indexOf('after-selection-readback') < gateEvents.indexOf('mutation-hook'), true);
      assert.equal(gateEvents.indexOf('mutation-hook') < gateEvents.indexOf('spend-hook'), true);

      const selection = required(result.selection);
      const bytes = required(result.selection_bytes);
      assert.equal(Buffer.from(bytes).toString('utf8'), canonicalRosterJson(selection));
      assert.equal(bytesEqual(await readFile(required(result.selection_path)), bytes), true);
      const paths = resolveRosterScopePaths({ scope: 'user', stateRoot });
      assert.equal(required(result.selection_path), preRunSelectionPath(paths, selection));
      assert.equal(lstatSync(required(result.selection_path)).mode & 0o777, 0o600);
    });
  });

  void it('respects explicit/trusted/user precedence and setup-required without alternate-authority writes', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const explicit = await commitSelection(stateRoot, {
        explicit_roster: authority('explicit-roster', { config_sha256: OTHER_CONFIG_SHA }),
        trusted_project_default: authority('trusted-project-default'),
        user_default: authority('user-default'),
      });
      assert.equal(explicit.ok, true);
      assert.equal(explicit.source, 'explicit-roster');
      assert.equal(required(explicit.selection).config_sha256, OTHER_CONFIG_SHA);

      const setupRoot = join(dir, 'setup-state');
      let gated = false;
      const setup = await resolveAndCommitPreRunSelection({
        stateRoot: setupRoot,
        repo_id: 'repo-phase37-w0-fixtures',
        workstream_run: 'phase37-w0-run-setup',
        selected_at: SELECTED_AT,
        hooks: { beforeWorktreeMutation: () => { gated = true; } },
      });
      assert.equal(setup.ok, false);
      assert.equal(setup.status, 'setup-required');
      assert.equal(setup.source, 'agent-first-onboarding');
      assert.equal(setup.write_count, 0);
      assert.equal(gated, false);
      assert.equal(existsSync(setupRoot), false);
    });
  });

  void it('fails closed on corrupt or untrusted higher-precedence authority before selection publication', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      let mutationGate = false;
      const corrupt = await commitSelection(stateRoot, {
        trusted_project_default: authority('trusted-project-default', {
          state: 'corrupt',
          roster_id: null,
          roster_revision: null,
          roster_sha256: null,
          assignment_set_sha256: null,
          config_sha256: null,
        }),
        user_default: authority('user-default'),
        hooks: { beforeWorktreeMutation: () => { mutationGate = true; } },
      });
      assert.equal(corrupt.ok, false);
      assert.equal(corrupt.status, 'blocked');
      assert.equal(corrupt.source, 'trusted-project-default');
      assert.deepEqual(diagnosticCodes(corrupt), ['ROSTER_READBACK_MISMATCH']);
      assert.equal(corrupt.write_count, 0);
      assert.equal(mutationGate, false);
      assert.equal(existsSync(stateRoot), false);

      const untrusted = await commitSelection(join(dir, 'untrusted-state'), {
        trusted_project_default: authority('trusted-project-default', { trusted: false }),
        user_default: authority('user-default'),
      });
      assert.equal(untrusted.ok, false);
      assert.deepEqual(diagnosticCodes(untrusted), ['ROSTER_PROJECT_UNTRUSTED']);
    });
  });

  void it('preserves external create-only conflict bytes and never opens gates on conflict', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const canonical = buildCanonicalPreRunSelection({
        stateRoot,
        repo_id: 'repo-phase37-w0-fixtures',
        workstream_run: 'phase37-w0-run-001',
        selected: authority('user-default'),
        selected_at: '2026-07-22T12:02:00.000Z',
      });
      await mkdir(dirname(canonical.selection_path), { recursive: true, mode: 0o700 });
      const conflictPaths = resolveRosterScopePaths({ scope: 'user', stateRoot });
      await chmod(conflictPaths.authorityRoot, 0o700);
      await chmod(conflictPaths.selectionsRoot, 0o700);
      await chmod(dirname(canonical.selection_path), 0o700);
      await writeFile(canonical.selection_path, canonical.selection_bytes, { mode: 0o600 });
      await chmod(canonical.selection_path, 0o600);
      const original = await readFile(canonical.selection_path);

      let gated = false;
      const result = await commitSelection(stateRoot, {
        hooks: { beforeModelSpend: () => { gated = true; } },
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'blocked');
      assert.deepEqual(diagnosticCodes(result), ['ROSTER_CREATE_ONLY_CONFLICT']);
      assert.equal(result.write_count, 0);
      assert.equal(gated, false);
      assert.equal(bytesEqual(await readFile(canonical.selection_path), original), true);
    });
  });

  void it('is idempotent on byte-identical replay and recovers a post-link crash by replaying exact bytes', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const first = await commitSelection(stateRoot);
      assert.equal(first.ok, true);
      assert.equal(first.write_count, 1);
      const replay = await commitSelection(stateRoot);
      assert.equal(replay.ok, true);
      assert.equal(replay.status, 'committed');
      assert.equal(replay.write_count, 0);
      assert.equal(replay.publish_result?.idempotent_replay, true);
      assert.deepEqual(diagnosticCodes(replay), ['ROSTER_SELECTION_IDEMPOTENT_REPLAY']);
      assert.equal(required(replay.selection).selection_sha256, required(first.selection).selection_sha256);

      const crashRoot = join(dir, 'crash-state');
      let injected = false;
      const crashed = await commitSelection(crashRoot, {
        hooks: {
          onTransactionStage: (event) => {
            if (!injected && event.stage === 'after-link') {
              injected = true;
              throw new Error('simulated post-link crash');
            }
          },
        },
      });
      assert.equal(crashed.ok, false);
      assert.equal(crashed.status, 'failed');
      assert.equal(crashed.write_count, 0);
      assert.equal(crashed.launch_fence, null);
      const retried = await commitSelection(crashRoot);
      assert.equal(retried.ok, true);
      assert.equal(retried.write_count, 0);
      assert.equal(retried.publish_result?.idempotent_replay, true);
    });
  });

  void it('mirrors only after the authoritative worktree exists, then verifies byte equality and mirror idempotency', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const selection = await commitSelection(stateRoot);
      const worktree = join(dir, 'main-worktree');
      const missing = await publishRuntimeRosterSnapshot({
        mainWorktreeRoot: worktree,
        workstream: 'phase37',
        selection_bytes: required(selection.selection_bytes),
        expected_selection_sha256: required(selection.selection).selection_sha256 as RosterSha256,
      });
      assert.equal(missing.ok, false);
      assert.equal(missing.status, 'failed');
      assert.deepEqual(diagnosticCodes(missing), ['ROSTER_PINNED_SELECTION_UNAVAILABLE']);
      assert.equal(existsSync(worktree), false);

      await mkdir(worktree, { mode: 0o700 });
      const stages: string[] = [];
      const published = await publishRuntimeRosterSnapshot({
        mainWorktreeRoot: worktree,
        workstream: 'phase37',
        selection_bytes: required(selection.selection_bytes),
        expected_selection_sha256: required(selection.selection).selection_sha256 as RosterSha256,
        hooks: { onStage: (event) => { stages.push(event.stage); } },
      });
      assert.equal(published.ok, true);
      assert.equal(published.status, 'published');
      assert.equal(published.write_count, 1);
      assert.equal(stages.indexOf('after-main-worktree-check') < stages.indexOf('before-mirror-publish'), true);
      const mirrorPath = runtimeRosterSnapshotPath({ mainWorktreeRoot: worktree, workstream: 'phase37' });
      assert.equal(published.mirror_path, mirrorPath);
      assert.equal(bytesEqual(await readFile(mirrorPath), required(selection.selection_bytes)), true);

      const replay = await publishRuntimeRosterSnapshot({
        mainWorktreeRoot: worktree,
        workstream: 'phase37',
        selection_bytes: required(selection.selection_bytes),
      });
      assert.equal(replay.ok, true);
      assert.equal(replay.status, 'inspected');
      assert.equal(replay.write_count, 0);
      assert.equal(replay.idempotent_replay, true);
    });
  });

  void it('fails closed on mirror drift and recovers existing runs while ignoring default drift', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const committed = await commitSelection(stateRoot);
      assert.equal(committed.ok, true);
      const worktree = join(dir, 'main-worktree');
      await mkdir(worktree, { mode: 0o700 });
      const mirror = await publishRuntimeRosterSnapshot({
        mainWorktreeRoot: worktree,
        workstream: 'phase37',
        selection_bytes: required(committed.selection_bytes),
      });
      assert.equal(mirror.ok, true);

      const recovered = await recoverRuntimeRosterSelection({
        stateRoot,
        mainWorktreeRoot: worktree,
        workstream: 'phase37',
        repo_id: 'repo-phase37-w0-fixtures',
        workstream_run: 'phase37-w0-run-001',
        spec_identity: specIdentity(committed),
        current_default: {
          roster_id: 'afterburner-codex-subscription-drift',
          roster_revision: 99,
          roster_sha256: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
        },
      });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.status, 'inspected');
      assert.equal(required(recovered.selection).selection_sha256, required(committed.selection).selection_sha256);
      assert.deepEqual(diagnosticCodes(recovered), []);

      const mirrorPath = runtimeRosterSnapshotPath({ mainWorktreeRoot: worktree, workstream: 'phase37' });
      await writeFile(mirrorPath, Buffer.from('{"tampered":true}\n', 'utf8'));
      await chmod(mirrorPath, 0o600);
      const drift = await recoverRuntimeRosterSelection({
        stateRoot,
        mainWorktreeRoot: worktree,
        workstream: 'phase37',
        repo_id: 'repo-phase37-w0-fixtures',
        workstream_run: 'phase37-w0-run-001',
        spec_identity: specIdentity(committed),
      });
      assert.equal(drift.ok, false);
      assert.equal(drift.status, 'failed');
      assert.deepEqual(diagnosticCodes(drift), ['ROSTER_READBACK_MISMATCH', 'ROSTER_TRANSITION_REQUIRED']);
    });
  });

  void it('requires external, mirror, spec, and pinned roster availability for recovery; never onboards existing runs', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const worktree = join(dir, 'main-worktree');
      await mkdir(worktree, { mode: 0o700 });
      const missingExternal = await recoverRuntimeRosterSelection({
        stateRoot,
        mainWorktreeRoot: worktree,
        workstream: 'phase37',
        repo_id: 'repo-phase37-w0-fixtures',
        workstream_run: 'phase37-w0-run-001',
        spec_identity: {
          workstream: 'phase37',
          roster_id: cruiseCandidate().roster_id,
          roster_revision: cruiseCandidate().roster_revision,
          roster_sha256: cruiseCandidate().roster_sha256 as RosterSha256,
          pre_run_selection_sha256: 'sha256:96c3625fddc6d43145ca5c6dece482e97fba78ad01c333e6aa3382fbe40d1878',
        },
      });
      assert.equal(missingExternal.ok, false);
      assert.equal(missingExternal.status, 'blocked');
      assert.equal(missingExternal.existing_resolution, null);
      assert.deepEqual(diagnosticCodes(missingExternal), ['ROSTER_PINNED_SELECTION_UNAVAILABLE', 'ROSTER_TRANSITION_REQUIRED']);

      const committed = await commitSelection(stateRoot);
      await publishRuntimeRosterSnapshot({ mainWorktreeRoot: worktree, workstream: 'phase37', selection_bytes: required(committed.selection_bytes) });
      const missingSpec = await recoverRuntimeRosterSelection({
        stateRoot,
        mainWorktreeRoot: worktree,
        workstream: 'phase37',
        repo_id: 'repo-phase37-w0-fixtures',
        workstream_run: 'phase37-w0-run-001',
        spec_identity: null,
      });
      assert.equal(missingSpec.ok, false);
      assert.equal(missingSpec.status, 'blocked');
      assert.deepEqual(diagnosticCodes(missingSpec), ['ROSTER_PINNED_SELECTION_UNAVAILABLE', 'ROSTER_TRANSITION_REQUIRED']);

      const specConflict = await recoverRuntimeRosterSelection({
        stateRoot,
        mainWorktreeRoot: worktree,
        workstream: 'phase37',
        repo_id: 'repo-phase37-w0-fixtures',
        workstream_run: 'phase37-w0-run-001',
        spec_identity: { ...specIdentity(committed), roster_revision: 2 },
      });
      assert.equal(specConflict.ok, false);
      assert.deepEqual(diagnosticCodes(specConflict), ['ROSTER_READBACK_MISMATCH', 'ROSTER_TRANSITION_REQUIRED']);

      const unavailableRoster = await recoverRuntimeRosterSelection({
        stateRoot,
        mainWorktreeRoot: worktree,
        workstream: 'phase37',
        repo_id: 'repo-phase37-w0-fixtures',
        workstream_run: 'phase37-w0-run-001',
        spec_identity: specIdentity(committed),
        roster_file_state: 'missing',
      });
      assert.equal(unavailableRoster.ok, false);
      assert.equal(unavailableRoster.status, 'blocked');
      assert.equal(unavailableRoster.existing_resolution?.action, 'resolve-existing-run');
      assert.deepEqual(diagnosticCodes(unavailableRoster), ['ROSTER_PINNED_SELECTION_UNAVAILABLE', 'ROSTER_TRANSITION_REQUIRED']);
    });
  });

  void it('rejects unsafe repo/workstream/path inputs before publishing external or mirror files', async () => {
    await withTempDir(async (dir) => {
      const invalidRepoRoot = join(dir, 'invalid-repo-state');
      const invalidRepo = await commitSelection(invalidRepoRoot, { repo_id: 'repo-../escape' });
      assert.equal(invalidRepo.ok, false);
      assert.equal(invalidRepo.write_count, 0);
      assert.equal(existsSync(invalidRepoRoot), false);

      const invalidRunRoot = join(dir, 'invalid-run-state');
      const invalidRun = await commitSelection(invalidRunRoot, { workstream_run: 'bad/run' });
      assert.equal(invalidRun.ok, false);
      assert.equal(invalidRun.write_count, 0);
      assert.equal(existsSync(invalidRunRoot), false);

      const committed = await commitSelection(join(dir, 'valid-state'));
      const worktree = join(dir, 'main-worktree');
      await mkdir(worktree, { mode: 0o700 });
      const invalidMirror = await publishRuntimeRosterSnapshot({
        mainWorktreeRoot: worktree,
        workstream: '../phase37',
        selection_bytes: required(committed.selection_bytes),
      });
      assert.equal(invalidMirror.ok, false);
      assert.equal(invalidMirror.write_count, 0);
      assert.equal(existsSync(join(worktree, '.pi')), false);

      const relativeWorktree = await publishRuntimeRosterSnapshot({
        mainWorktreeRoot: 'relative-worktree',
        workstream: 'phase37',
        selection_bytes: required(committed.selection_bytes),
      });
      assert.equal(relativeWorktree.ok, false);
      assert.deepEqual(diagnosticCodes(relativeWorktree), ['ROSTER_STORAGE_PATH_INVALID']);
    });
  });
});
