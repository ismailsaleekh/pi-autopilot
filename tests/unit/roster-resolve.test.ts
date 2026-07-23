import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SEED_CANDIDATES } from '../../src/core/roster/provider-recipes.ts';
import {
  publishPreRunSelection,
  resolveExistingRun,
  resolveNewRun,
  validateReceipt,
  type ExistingRunResolutionRequest,
  type PreRunSelection,
  type SavedRosterAuthority,
} from '../../src/core/roster/resolve.ts';

function cruiseCandidate() {
  const candidate = SEED_CANDIDATES.find((entry) => entry.candidate_id === 'codex-cruise-v1');
  if (candidate === undefined) {
    throw new Error('missing cruise candidate');
  }
  return candidate;
}

function authority(source: SavedRosterAuthority['source'], state: SavedRosterAuthority['state'] = 'present'): SavedRosterAuthority {
  const candidate = cruiseCandidate();
  const base = {
    source,
    state,
    scope: source === 'trusted-project-default' ? 'trusted-project' as const : 'user' as const,
    roster_id: state === 'present' ? candidate.roster_id : null,
    roster_revision: state === 'present' ? candidate.roster_revision : null,
    roster_sha256: state === 'present' ? candidate.roster_sha256 : null,
    assignment_set_sha256: state === 'present' ? candidate.assignment_set_sha256 : null,
  };
  return source === 'trusted-project-default' ? { ...base, trusted: true } : base;
}

function selection(): PreRunSelection {
  const candidate = cruiseCandidate();
  return {
    schema_version: 'autopilot.pre_run_selection.v1',
    repo_id: 'repo-phase37-w0-fixtures',
    workstream_run: 'phase37-w0-run-001',
    scope: 'user',
    roster_id: candidate.roster_id,
    roster_revision: candidate.roster_revision,
    roster_sha256: candidate.roster_sha256,
    assignment_set_sha256: candidate.assignment_set_sha256,
    config_sha256: 'sha256:1d8a144806f7bd3df23724eb702223c7180b4d160cb09fc8cff5cbc77a1e3a38',
    selected_at: '2026-07-22T12:01:00.000Z',
    selection_sha256: 'sha256:96c3625fddc6d43145ca5c6dece482e97fba78ad01c333e6aa3382fbe40d1878',
  };
}

function existingRequest(overrides: Partial<ExistingRunResolutionRequest> = {}): ExistingRunResolutionRequest {
  return {
    schema_version: 'autopilot.existing_run_resolution_request.v1',
    action: 'resolve-existing-run',
    repo_id: 'repo-phase37-w0-fixtures',
    workstream_run: 'phase37-w0-run-001',
    scope: 'user',
    selection_sha256: selection().selection_sha256,
    runtime_mirror_sha256: selection().selection_sha256,
    current_default_roster_id: 'afterburner-codex-subscription-drift',
    current_default_roster_revision: 99,
    current_default_roster_sha256: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
    roster_file_state: 'present',
    request_sha256: 'sha256:5546d49d4a7792321d21ad38739e42bde0343dd05450cce0286a538e6e94e3b9',
    ...overrides,
  };
}

void describe('Phase 37 W1 roster resolution', () => {
  void it('uses new-run precedence explicit, trusted project, user, onboarding', () => {
    const explicit = authority('explicit-roster');
    const trusted = authority('trusted-project-default');
    const user = authority('user-default');

    assert.equal(resolveNewRun({ explicit_roster: explicit, trusted_project_default: trusted, user_default: user }).source, 'explicit-roster');
    assert.equal(resolveNewRun({ trusted_project_default: trusted, user_default: user }).source, 'trusted-project-default');
    assert.equal(resolveNewRun({ user_default: user }).source, 'user-default');
    const onboarding = resolveNewRun({});
    assert.equal(onboarding.status, 'onboarding-required');
    assert.equal(onboarding.source, 'agent-first-onboarding');
    assert.equal(onboarding.write_count, 0);
  });

  void it('fails closed on corrupt higher precedence authority instead of falling back', () => {
    const result = resolveNewRun({
      trusted_project_default: authority('trusted-project-default', 'corrupt'),
      user_default: authority('user-default'),
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.equal(result.source, 'trusted-project-default');
    assert.equal(result.selected_roster_id, null);
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_READBACK_MISMATCH']);
  });

  void it('requires project trust for trusted-project defaults', () => {
    const project = { ...authority('trusted-project-default'), trusted: false };
    const result = resolveNewRun({ trusted_project_default: project, user_default: authority('user-default') });

    assert.equal(result.ok, false);
    assert.equal(result.source, 'trusted-project-default');
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_PROJECT_UNTRUSTED']);
  });

  void it('existing runs ignore default drift and use only immutable selection plus byte-equal mirror', () => {
    const result = resolveExistingRun(existingRequest(), selection());

    assert.equal(result.ok, true);
    assert.equal(result.status, 'inspected');
    assert.equal(result.selected_roster_id, cruiseCandidate().roster_id);
    assert.equal(result.selected_roster_sha256, cruiseCandidate().roster_sha256);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.write_count, 0);
    assert.equal(result.lock_count, 0);
  });

  void it('existing runs require explicit transition when pinned selection is unavailable', () => {
    const result = resolveExistingRun(existingRequest({ roster_file_state: 'missing' }), selection());

    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.equal(result.selected_roster_id, null);
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
      'ROSTER_PINNED_SELECTION_UNAVAILABLE',
      'ROSTER_TRANSITION_REQUIRED',
    ]);
  });

  void it('existing runs fail closed on runtime mirror hash drift', () => {
    const result = resolveExistingRun(
      existingRequest({ runtime_mirror_sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
      selection(),
    );

    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
      'ROSTER_PINNED_SELECTION_UNAVAILABLE',
      'ROSTER_TRANSITION_REQUIRED',
    ]);
  });

  void it('validates receipt request profile/model/thinking facts exactly', () => {
    assert.equal(
      validateReceipt({
        schema_version: 'autopilot.receipt_validation_request.v1',
        action: 'validate-receipt',
        requested_profile_sha256: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
        observed_request_profile_sha256: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
        requested_model_id: null,
        executed_model_id: null,
        requested_thinking: null,
        observed_thinking: null,
        request_sha256: 'sha256:1bdec2bd0989b8108c7c166355776558ac7005b3640701aa22414f96519d36b4',
      }).diagnostics[0]?.code,
      'ROSTER_REQUEST_PROFILE_DRIFT',
    );
    assert.deepEqual(
      validateReceipt({
        schema_version: 'autopilot.receipt_validation_request.v1',
        action: 'validate-receipt',
        requested_profile_sha256: null,
        observed_request_profile_sha256: null,
        requested_model_id: 'gpt-5.6-terra',
        executed_model_id: 'gpt-5.6-sol',
        requested_thinking: 'xhigh',
        observed_thinking: 'high',
        request_sha256: 'sha256:0cd99754f500ead2f44278e7c6270d0663199132918565a7b5831a6fb4a20a1a',
      }).diagnostics.map((diagnostic) => diagnostic.code),
      ['ROSTER_OBSERVED_MODEL_MISMATCH', 'ROSTER_OBSERVED_THINKING_MISMATCH'],
    );
  });

  void it('models create-only selection conflict and idempotent replay without writes', () => {
    const base = {
      schema_version: 'autopilot.pre_run_selection_publish_request.v1' as const,
      action: 'publish-pre-run-selection' as const,
      selection: selection(),
      selection_path: '~/.pi/agent/autopilot/roster-selections/repo-phase37-w0-fixtures/phase37-w0-run-001.json',
      request_sha256: 'sha256:8a61c178a3208a19e66af121198ad4b70d7dd069be0cf11050858f8b9bece565' as const,
    };

    const conflict = publishPreRunSelection({
      ...base,
      existing_selection_sha256: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.write_count, 0);
    assert.deepEqual(conflict.files_touched, []);
    assert.deepEqual(conflict.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_CREATE_ONLY_CONFLICT']);

    const replay = publishPreRunSelection({ ...base, existing_selection_sha256: selection().selection_sha256 });
    assert.equal(replay.ok, true);
    assert.equal(replay.idempotent_replay, true);
    assert.equal(replay.write_count, 0);
    assert.deepEqual(replay.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_SELECTION_IDEMPOTENT_REPLAY']);
  });
});
