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
  selfHashedKimiW4ManifestFixture,
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

  void it('keeps a shaped but untrusted Kimi manifest unlaunchable and blocks save without writes', async () => {
    const fixture = selfHashedKimiW4ManifestFixture();
    await withRosterSetupHarness(async (harness) => {
      harness.activateSetup();
      const proposal = await harness.invoke('propose');
      const candidateSet = requireCandidateSet(proposal);
      assert.equal(candidateSet.candidates.some((candidate) => candidate.launch_readiness === 'w4-certified-ready'), false);
      const approval = harness.hostApprove(proposal);

      const stale = await harness.saveWithApproval(approval, { candidate_set_sha256: STALE_SHA });
      assert.equal(stale.ok, false);
      assert.equal(stale.status, 'blocked');
      assert.deepEqual(diagnosticCodes(stale), ['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
      assert.equal(stale.write_count, 0);
      assert.equal(stale.lock_count, 0);
      assert.deepEqual(stale.files_touched, []);
      assert.equal(harness.counters.saveCapabilityCalls, 0, 'stale save must not reach storage');
      assert.deepEqual(await harness.stateFiles(), []);

      const blocked = await harness.saveWithApproval(approval);
      assert.equal(blocked.ok, false);
      assert.equal(blocked.status, 'blocked');
      assert.ok(diagnosticCodes(blocked).includes('ROSTER_QUALIFICATION_REQUIRED'));
      assert.equal(blocked.write_count, 0);
      assert.equal(blocked.lock_count, 0);
      assert.deepEqual(blocked.files_touched, []);
      assert.equal(blocked.receipt, null);
      assert.equal(harness.lastApprovalSaveResult, null);
      assert.equal(harness.counters.saveCapabilityCalls, 0, 'uncertified manifest save must not reach storage');
      assert.deepEqual(await harness.stateFiles(), []);
      assertSecretFree(blocked, SECRET_MARKER);
      assertNoRunWorktreeCoordinatorOrSpend(harness.sideEffectsSnapshot());
    }, {
      inventory: kimiRosterInventory(),
      qualificationManifests: [fixture.manifest],
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
