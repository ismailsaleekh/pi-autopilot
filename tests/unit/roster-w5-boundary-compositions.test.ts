import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  validateReceiptV2TerminalCompatibility,
  assertRetryResumeArtifactCompatibility,
} from '../../src/core/roster/artifact-compatibility.ts';
import {
  resolveAndCommitPreRunSelection,
  type RunSelectionAuthority,
} from '../../src/core/roster/run-selection.ts';
import {
  publishRuntimeRosterSnapshot,
  recoverRuntimeRosterSelection,
  runtimeRosterSnapshotPath,
  type RuntimeSelectionSpecIdentity,
} from '../../src/core/roster/snapshot.ts';
import { preRunSelectionPath, resolveRosterScopePaths, type RosterSha256 } from '../../src/core/roster/storage.ts';
import {
  materializeNewRunUnitSpecV2,
  type AutopilotRosterReceiptV2,
} from '../../src/core/roster/runtime-spec.ts';
import { SEED_CANDIDATES } from '../../src/core/roster/provider-recipes.ts';
import {
  w5JsonBytes,
  w5PinnedFacts,
  w5Receipt,
  w5RehashObject,
  w5TerminalAcceptance,
  w5UnitSpec,
} from '../helpers/w5-roster-fixtures.ts';

const SELECTED_AT = '2026-07-23T12:10:00.000Z';
const ISSUED_AT = '2026-07-23T12:10:01.000Z';
const CONFIG_SHA = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as RosterSha256;

void describe('Phase37 W5 roster boundary compositions', () => {
  void it('fails corrupt explicit authority ahead of valid trusted/user defaults without fallback or gates', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      let mutationGate = false;
      let spendGate = false;
      const result = await resolveAndCommitPreRunSelection({
        stateRoot,
        repo_id: 'repo-w5-roster-fixtures',
        workstream_run: 'w5-roster-run-001',
        explicit_roster: authority('explicit-roster', { state: 'corrupt' }),
        trusted_project_default: authority('trusted-project-default'),
        user_default: authority('user-default'),
        selected_at: SELECTED_AT,
        issued_at: ISSUED_AT,
        hooks: {
          beforeWorktreeMutation: () => { mutationGate = true; },
          beforeModelSpend: () => { spendGate = true; },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'blocked');
      assert.equal(result.source, 'explicit-roster');
      assert.equal(result.selection, null);
      assert.equal(result.write_count, 0);
      assert.equal(result.files_touched.length, 0);
      assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_READBACK_MISMATCH']);
      assert.equal(mutationGate, false);
      assert.equal(spendGate, false);
      assert.equal(existsSync(stateRoot), false);
    });
  });

  void it('keeps existing-run pins when current defaults point at another available roster', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const committed = await resolveAndCommitPreRunSelection({
        stateRoot,
        repo_id: 'repo-w5-roster-fixtures',
        workstream_run: 'w5-roster-run-001',
        user_default: authority('user-default'),
        selected_at: SELECTED_AT,
        issued_at: ISSUED_AT,
      });
      assert.equal(committed.ok, true);
      if (committed.selection === null || committed.selection_bytes === null) throw new Error('selection missing');

      const worktree = join(dir, 'main-worktree');
      await mkdir(worktree, { mode: 0o700 });
      const mirror = await publishRuntimeRosterSnapshot({
        mainWorktreeRoot: worktree,
        workstream: 'w5-roster',
        selection_bytes: committed.selection_bytes,
      });
      assert.equal(mirror.ok, true);

      const alternate = candidate('codex-afterburner-v1');
      const recovered = await recoverRuntimeRosterSelection({
        stateRoot,
        mainWorktreeRoot: worktree,
        workstream: 'w5-roster',
        repo_id: 'repo-w5-roster-fixtures',
        workstream_run: 'w5-roster-run-001',
        spec_identity: specIdentity(committed.selection, 'w5-roster'),
        current_default: {
          roster_id: alternate.roster_id,
          roster_revision: alternate.roster_revision,
          roster_sha256: alternate.roster_sha256 as RosterSha256,
        },
        roster_file_state: 'missing',
      });

      assert.equal(recovered.ok, false);
      assert.equal(recovered.status, 'blocked');
      assert.equal(recovered.selection, null);
      assert.equal(recovered.existing_resolution?.action, 'resolve-existing-run');
      assert.equal(recovered.existing_resolution?.selected_roster_id, null);
      assert.deepEqual(recovered.diagnostics.map((diagnostic) => diagnostic.code), [
        'ROSTER_PINNED_SELECTION_UNAVAILABLE',
        'ROSTER_TRANSITION_REQUIRED',
      ]);
      assert.equal(recovered.write_count, 0);
      assert.equal(recovered.lock_count, 0);
    });
  });

  void it('publishes a crash-window runtime mirror as immutable evidence but never opens a mutable partial authority', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const committed = await resolveAndCommitPreRunSelection({
        stateRoot,
        repo_id: 'repo-w5-roster-fixtures',
        workstream_run: 'w5-roster-run-001',
        user_default: authority('user-default'),
        selected_at: SELECTED_AT,
      });
      assert.equal(committed.ok, true);
      if (committed.selection === null || committed.selection_bytes === null) throw new Error('selection missing');
      const worktree = join(dir, 'main-worktree');
      await mkdir(worktree, { mode: 0o700 });

      const crashed = await publishRuntimeRosterSnapshot({
        mainWorktreeRoot: worktree,
        workstream: 'w5-roster',
        selection_bytes: committed.selection_bytes,
        crashStage: 'after-mirror-publish-before-readback',
      });
      assert.equal(crashed.ok, false);
      assert.equal(crashed.status, 'failed');
      assert.equal(crashed.selection_sha256, committed.selection.selection_sha256);
      assert.deepEqual(crashed.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_READBACK_MISMATCH']);
      assert.equal(crashed.lock_count, 0);

      const mirrorPath = runtimeRosterSnapshotPath({ mainWorktreeRoot: worktree, workstream: 'w5-roster' });
      assert.deepEqual(await readFile(mirrorPath), Buffer.from(committed.selection_bytes));
      const replay = await publishRuntimeRosterSnapshot({
        mainWorktreeRoot: worktree,
        workstream: 'w5-roster',
        selection_bytes: committed.selection_bytes,
      });
      assert.equal(replay.ok, true);
      assert.equal(replay.idempotent_replay, true);
      assert.equal(replay.write_count, 0);

      await writeFile(mirrorPath, '{"tampered":true}\n', 'utf8');
      await chmod(mirrorPath, 0o600);
      const conflict = await publishRuntimeRosterSnapshot({
        mainWorktreeRoot: worktree,
        workstream: 'w5-roster',
        selection_bytes: committed.selection_bytes,
      });
      assert.equal(conflict.ok, false);
      assert.deepEqual(conflict.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_CREATE_ONLY_CONFLICT']);
      assert.equal(conflict.write_count, 0);
      assert.deepEqual(await readFile(mirrorPath), Buffer.from('{"tampered":true}\n'));
    });
  });

  void it('rejects request-profile drift in materialization instead of model/thinking/cache fallback', () => {
    const facts = w5PinnedFacts('validate');
    const driftedProfile = w5RehashObject('autopilot.request_profile.v1', {
      ...facts.requestProfile,
      model_id: 'gpt-5.6-terra',
      model: 'openai-codex/gpt-5.6-terra',
      thinking: 'high',
      service_tier: 'priority',
      cache_policy: 'none',
    }, 'request_profile_sha256');

    assert.throws(
      () => materializeNewRunUnitSpecV2({
        ...w5UnitSpec({ role: 'validate' }),
        selection: facts.selection,
        roster: facts.roster,
        role: 'validate',
        request_profile: driftedProfile,
      }),
      /request_profile\.(model_id|model|thinking|service_tier|cache_policy)/u,
    );
  });

  void it('reports receipt request-observed drift and stale terminal mirror/spec drift as separate fail-closed surfaces', () => {
    const unit = w5UnitSpec();
    const receipt = w5Receipt(unit);
    const unitBytes = w5JsonBytes(unit);
    const receiptBytes = w5JsonBytes(receipt);

    const driftedReceipt = receiptWithObservedModel(receipt, 'gpt-5.6-sol');
    const observedResult = validateReceiptV2TerminalCompatibility({
      unit_spec_bytes_utf8: unitBytes,
      receipt_bytes_utf8: w5JsonBytes(driftedReceipt),
      terminal_acceptance: w5TerminalAcceptance(unit, unitBytes, driftedReceipt, w5JsonBytes(driftedReceipt)),
    });
    assert.equal(observedResult.ok, false);
    assert.deepEqual(observedResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'ROSTER_OBSERVED_MODEL_MISMATCH',
      'ROSTER_REQUEST_PROFILE_DRIFT',
    ]);

    const staleTerminal = w5TerminalAcceptance(unit, unitBytes, receipt, receiptBytes, {
      receipt: { ref: 'receipts/stale-replayed.receipt.json', sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      tool_call_id: 'call-w5-replayed-stale',
      carrier_status_sha256: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
    });
    const terminalResult = validateReceiptV2TerminalCompatibility({
      unit_spec_bytes_utf8: unitBytes,
      receipt_bytes_utf8: receiptBytes,
      terminal_acceptance: staleTerminal,
    });
    assert.equal(terminalResult.ok, false);
    assert.deepEqual(terminalResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'ROSTER_READBACK_MISMATCH',
      'ROSTER_TERMINAL_ACCEPTANCE_INCOMPATIBLE',
    ]);
    assert.equal(JSON.stringify([observedResult, terminalResult]).includes('api-key'), false);
    assert.equal(JSON.stringify([observedResult, terminalResult]).includes('secret'), true, 'diagnostics should remain marked secret_free');
  });

  void it('preserves receipt pins across retry/resume while rejecting handoff drift in selection and profile hashes', () => {
    const firstUnit = w5UnitSpec({ attempt: 1 });
    const retryUnit = w5UnitSpec({ attempt: 2 });
    const firstReceipt = w5Receipt(firstUnit);
    const retryReceipt = w5Receipt(retryUnit);
    assert.doesNotThrow(() => assertRetryResumeArtifactCompatibility({
      kind: 'receipt',
      original_bytes_utf8: w5JsonBytes(firstReceipt),
      next_bytes_utf8: w5JsonBytes(retryReceipt),
    }));

    const selectionDrift = {
      ...retryReceipt,
      pre_run_selection_sha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    assert.throws(
      () => assertRetryResumeArtifactCompatibility({
        kind: 'receipt',
        original_bytes_utf8: w5JsonBytes(firstReceipt),
        next_bytes_utf8: w5JsonBytes(selectionDrift),
      }),
      /pre_run_selection_sha256/u,
    );

    const profileDrift = {
      ...retryReceipt,
      request_profile: {
        ...retryReceipt.request_profile,
        request_profile_sha256: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
    };
    assert.throws(
      () => assertRetryResumeArtifactCompatibility({
        kind: 'receipt',
        original_bytes_utf8: w5JsonBytes(firstReceipt),
        next_bytes_utf8: w5JsonBytes(profileDrift),
      }),
      /request_profile/u,
    );
  });
});

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const root = await realpath(tmpdir());
  const dir = await mkdtemp(join(root, 'roster-w5-boundaries-'));
  try {
    await chmod(dir, 0o700);
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function authority(source: RunSelectionAuthority['source'], overrides: Partial<RunSelectionAuthority> = {}): RunSelectionAuthority {
  const selected = candidate('codex-cruise-v1');
  const base: RunSelectionAuthority = {
    source,
    state: 'present',
    scope: source === 'trusted-project-default' ? 'trusted-project' : 'user',
    roster_id: selected.roster_id,
    roster_revision: selected.roster_revision,
    roster_sha256: selected.roster_sha256 as RosterSha256,
    assignment_set_sha256: selected.assignment_set_sha256 as RosterSha256,
    config_sha256: CONFIG_SHA,
    ...(source === 'trusted-project-default' ? { trusted: true } : {}),
  };
  if (overrides.state === 'corrupt') {
    return {
      ...base,
      ...overrides,
      roster_id: null,
      roster_revision: null,
      roster_sha256: null,
      assignment_set_sha256: null,
      config_sha256: null,
    };
  }
  return { ...base, ...overrides };
}

function candidate(candidateId: string): typeof SEED_CANDIDATES[number] {
  const selected = SEED_CANDIDATES.find((entry) => entry.candidate_id === candidateId);
  if (selected === undefined) throw new Error(`missing candidate ${candidateId}`);
  return selected;
}

function specIdentity(selection: NonNullable<Awaited<ReturnType<typeof resolveAndCommitPreRunSelection>>['selection']>, workstream: string): RuntimeSelectionSpecIdentity {
  return {
    schema_version: 'autopilot.unit_spec.v2',
    workstream,
    roster_id: selection.roster_id,
    roster_revision: selection.roster_revision,
    roster_sha256: selection.roster_sha256 as RosterSha256,
    pre_run_selection_sha256: selection.selection_sha256 as RosterSha256,
  };
}

function receiptWithObservedModel(receipt: AutopilotRosterReceiptV2, executedModelId: string): AutopilotRosterReceiptV2 {
  const observedProfile = w5RehashObject('autopilot.observed_profile.v1', {
    ...receipt.observed_profile,
    executed_model_id: executedModelId,
  }, 'observed_profile_sha256');
  return { ...receipt, observed_profile: observedProfile };
}
