import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EXPECTED_ROSTER_TOOL_PARAMETER_SCHEMA,
  ROSTER_SETUP_TOOL_NAME,
  SECRET_MARKER,
  assertNoRunWorktreeCoordinatorOrSpend,
  assertSecretFree,
  diagnosticCodes,
  kimiRosterInventory,
  requireCandidateSet,
  rosterToolRequest,
  trustedKimiW4ManifestFixture,
  withRosterSetupHarness,
  type RosterToolRequestLike,
} from '../helpers/roster-setup-harness.ts';
import type { Digest } from '../../src/core/roster/route-policies.ts';

const STALE_SHA = 'sha256:1111111111111111111111111111111111111111111111111111111111111111' as Digest;

void describe('Phase 37 W2 roster setup Pi SDK proof lane', () => {
  void it('keeps the setup tool unavailable before activation and exposes the exact schema only after activation', async () => {
    await withRosterSetupHarness(async (harness) => {
      assert.equal(harness.bundle.controller.isActive(), false);
      assert.equal(harness.pi.getToolDefinition(ROSTER_SETUP_TOOL_NAME), undefined);
      assert.deepEqual(harness.pi.getActiveTools(), []);

      const inactiveRequest = rosterToolRequest('setup:inactive-token-000000000000000000000000', 'inspect');
      const inactive = await harness.bundle.tool.execute('inactive-call', inactiveRequest, undefined, undefined, harness.context());
      assert.equal(inactive.details.ok, false);
      assert.equal(inactive.details.status, 'blocked');
      assert.deepEqual(diagnosticCodes(inactive.details), ['ROSTER_TRANSITION_REQUIRED']);
      assert.equal(inactive.details.write_count, 0);
      assert.equal(inactive.details.lock_count, 0);
      assert.deepEqual(inactive.details.files_touched, []);
      assert.equal(harness.counters.modelCatalogReads, 0, 'inactive tool must not inspect the SDK model registry');

      const token = harness.activateSetup();
      assert.equal(harness.bundle.controller.isActive(), true);
      assert.equal(harness.bundle.controller.currentActivationToken(), token);
      const tool = harness.pi.getToolDefinition(ROSTER_SETUP_TOOL_NAME);
      if (tool === undefined) throw new Error('activated setup tool was not registered');
      assert.equal(harness.pi.isToolActive(ROSTER_SETUP_TOOL_NAME), true);
      assert.deepEqual(tool.parameters, EXPECTED_ROSTER_TOOL_PARAMETER_SCHEMA);
      assert.equal(tool.name, ROSTER_SETUP_TOOL_NAME);
      assert.match(tool.description, /Inactive until the package activates one setup session/u);
      assert.equal(tool.promptGuidelines.every((guideline) => guideline.includes(ROSTER_SETUP_TOOL_NAME)), true);
      assertNoRunWorktreeCoordinatorOrSpend(harness.sideEffectsSnapshot());
    });
  });

  void it('keeps inspect, propose, refine, doctor, and reject zero-write without credential resolution', async () => {
    await withRosterSetupHarness(async (harness) => {
      harness.activateSetup();
      for (const action of ['inspect', 'propose', 'refine', 'doctor', 'reject']) {
        const result = await harness.invoke(action);
        assert.equal(result.write_count, 0, action);
        assert.equal(result.lock_count, 0, action);
        assert.deepEqual(result.files_touched, [], action);
        assertSecretFree(result);
      }
      assert.equal(harness.counters.modelCatalogReads > 0, true, 'setup should inspect non-secret SDK model metadata');
      assert.equal(harness.counters.authStatusReads > 0, true, 'setup should inspect non-secret SDK auth status');
      assert.equal(harness.counters.credentialResolutions, 0, 'setup must not resolve credentials');
      assert.deepEqual(await harness.stateFiles(), [], 'zero-write operations must not create state roots');
      assertNoRunWorktreeCoordinatorOrSpend(harness.sideEffectsSnapshot());
    });
  });

  void it('blocks W0 unqualified saves before storage without writes', async () => {
    await withRosterSetupHarness(async (harness) => {
      harness.activateSetup();
      const proposal = await harness.invoke('propose');
      const approval = harness.hostApprove(proposal);
      const blocked = await harness.saveWithApproval(approval);
      assert.equal(blocked.ok, false);
      assert.equal(blocked.status, 'blocked');
      assert.ok(diagnosticCodes(blocked).includes('ROSTER_QUALIFICATION_REQUIRED'));
      assert.equal(blocked.write_count, 0);
      assert.equal(blocked.lock_count, 0);
      assert.deepEqual(blocked.files_touched, []);
      assert.equal(harness.counters.saveCapabilityCalls, 0);
      assert.deepEqual(await harness.stateFiles(), []);
      assertNoRunWorktreeCoordinatorOrSpend(harness.sideEffectsSnapshot());
    });
  });

  void it('rejects stale approvals, then saves only a registry-verified W4-ready subset and default tuple', async () => {
    const trusted = trustedKimiW4ManifestFixture();
    await withRosterSetupHarness(async (harness) => {
      harness.activateSetup();
      const proposal = await harness.invoke('propose');
      const candidateSet = requireCandidateSet(proposal);
      const ready = candidateSet.candidates.find((candidate) => candidate.launch_readiness === 'w4-certified-ready');
      if (ready === undefined) throw new Error('expected trusted manifest to promote a ready Kimi candidate');
      const approval = harness.hostApprove(proposal, {
        approved_roster_sha256s: [ready.roster_sha256],
        default_roster_id: ready.roster_id,
        default_roster_revision: ready.roster_revision,
        default_roster_sha256: ready.roster_sha256,
      });
      assert.deepEqual(approval.approved_roster_sha256s, [ready.roster_sha256]);

      const stale = await harness.saveWithApproval(approval, { candidate_set_sha256: STALE_SHA });
      assert.equal(stale.ok, false);
      assert.equal(stale.status, 'blocked');
      assert.deepEqual(diagnosticCodes(stale), ['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
      assert.equal(stale.write_count, 0);
      assert.equal(stale.lock_count, 0);
      assert.deepEqual(stale.files_touched, []);
      assert.equal(harness.counters.saveCapabilityCalls, 0, 'stale save must not reach storage');
      assert.deepEqual(await harness.stateFiles(), []);

      const saved = await harness.saveWithApproval(approval);
      assert.equal(saved.ok, true);
      assert.equal(saved.status, 'saved');
      assert.equal(saved.write_count, approval.approved_roster_sha256s.length + 1);
      assert.equal(saved.lock_count, 1);
      assert.equal(harness.counters.saveCapabilityCalls, 1);
      assert.equal(saved.receipt?.fresh_session_required, true);
      assert.equal(saved.receipt?.zero_secrets, true);
      assert.equal(saved.receipt?.original_command, harness.originalCommand);
      assert.deepEqual(saved.receipt?.approved_roster_sha256s, approval.approved_roster_sha256s);
      assertSecretFree(saved, SECRET_MARKER);

      const config = await harness.publishedConfig();
      assert.deepEqual(config.rosters.map((roster) => roster.roster_sha256), approval.approved_roster_sha256s);
      assert.equal(config.default_roster_id, approval.default_roster_id);
      assert.equal(config.default_roster_revision, approval.default_roster_revision);
      assert.equal(config.default_roster_sha256, approval.default_roster_sha256);
      assert.equal(config.rosters.filter((roster) => (
        roster.roster_id === approval.default_roster_id &&
        roster.roster_revision === approval.default_roster_revision &&
        roster.roster_sha256 === approval.default_roster_sha256
      )).length, 1);
      assert.deepEqual(
        saved.files_touched.map((file) => file.endsWith('config.json') ? 'config' : 'roster').sort(),
        [...approval.approved_roster_sha256s.map(() => 'roster'), 'config'].sort(),
      );

      const approvalSave = harness.lastApprovalSaveResult;
      if (approvalSave === null) throw new Error('expected approval save result');
      assert.equal(approvalSave.retry_command, harness.originalCommand);
      assert.equal(approvalSave.restart_required, true);
      assert.equal(approvalSave.auto_start_allowed, false);
      assert.equal(approvalSave.same_session_save_allowed, false);
      assert.equal(approvalSave.receipt_emitted_after_readback, true);

      const replay = await harness.saveWithApproval(approval);
      assert.equal(replay.ok, false);
      assert.equal(replay.status, 'blocked');
      assert.deepEqual(diagnosticCodes(replay), ['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
      assert.equal(replay.write_count, 0);
      assert.equal(harness.counters.saveCapabilityCalls, 1, 'approval-token replay must not reach storage');
      assertNoRunWorktreeCoordinatorOrSpend(harness.sideEffectsSnapshot());
    }, {
      inventory: kimiRosterInventory(),
      qualificationManifests: [trusted.manifest],
    });
  });

  void it('fails closed for malformed SDK tool inputs without writes or side effects', async () => {
    await withRosterSetupHarness(async (harness) => {
      harness.activateSetup();
      const malformed: Partial<RosterToolRequestLike> = {
        schema_version: 'autopilot.roster_tool_request.v1',
        action: 'inspect',
        activation_token: harness.activationToken ?? 'missing-token',
        approval_token: null,
        scope: 'user',
        trusted_project_root: null,
        candidate_set_sha256: null,
        approved_roster_sha256s: [],
        default_roster_id: null,
        default_roster_revision: null,
        default_roster_sha256: null,
        original_command: `/autopilot ${SECRET_MARKER}`,
      };
      const result = await harness.invokeRaw({ ...malformed, extra_field: true });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.deepEqual(diagnosticCodes(result), ['ROSTER_READBACK_MISMATCH']);
      assert.equal(result.write_count, 0);
      assert.deepEqual(await harness.stateFiles(), []);
      assertSecretFree(result);
      assertNoRunWorktreeCoordinatorOrSpend(harness.sideEffectsSnapshot());
    });
  });
});
