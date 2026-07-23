import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EXPECTED_ROSTER_TOOL_PARAMETER_SCHEMA,
  FakeRosterJsonRpcHarness,
  ROSTER_SETUP_TOOL_NAME,
  assertNoRunWorktreeCoordinatorOrSpend,
  assertSecretFree,
  diagnosticCodes,
  isRpcFailure,
  isRpcSuccess,
  jsonRpcListTools,
  jsonRpcToolCall,
  kimiRosterInventory,
  requireCandidateSet,
  rpcListedTools,
  rpcToolResult,
  selfHashedKimiW4ManifestFixture,
  withRosterSetupHarness,
} from '../helpers/roster-setup-harness.ts';

void describe('Phase 37 W2 roster setup JSON-RPC proof lane', () => {
  void it('fails closed when the setup tool is unavailable or inactive, then lists the exact activated schema', async () => {
    await withRosterSetupHarness(async (harness) => {
      const rpc = new FakeRosterJsonRpcHarness(harness);
      const beforeList = await rpc.handleCommand(jsonRpcListTools('tools-before'));
      assert.equal(isRpcSuccess(beforeList), true);
      assert.deepEqual(rpcListedTools(beforeList), []);

      const beforeCall = await rpc.handleCommand(jsonRpcToolCall('call-before', harness.directRequest('inspect')));
      assert.equal(isRpcFailure(beforeCall), true);
      if (!isRpcFailure(beforeCall)) throw new Error('unreachable');
      assert.equal(beforeCall.error.code, -32003);
      assert.match(beforeCall.error.message, /unavailable or inactive/u);
      assert.equal(harness.counters.toolExecutions, 0);

      harness.activateSetup();
      const afterList = await rpc.handleCommand(jsonRpcListTools('tools-after'));
      const tools = rpcListedTools(afterList);
      assert.equal(tools.length, 1);
      const tool = tools[0];
      if (tool === undefined) throw new Error('missing listed setup tool');
      assert.equal(tool['name'], ROSTER_SETUP_TOOL_NAME);
      assert.deepEqual(tool['parameters'], EXPECTED_ROSTER_TOOL_PARAMETER_SCHEMA);
      assertNoRunWorktreeCoordinatorOrSpend(harness.sideEffectsSnapshot());
    });
  });

  void it('rejects malformed, unknown, duplicate, and concurrent RPC calls without writes', async () => {
    await withRosterSetupHarness(async (harness) => {
      harness.activateSetup();
      const rpc = new FakeRosterJsonRpcHarness(harness);

      const malformed = await rpc.handleLine('{ not json');
      assert.equal(isRpcFailure(malformed), true);
      if (!isRpcFailure(malformed)) throw new Error('unreachable');
      assert.equal(malformed.id, null);
      assert.equal(malformed.error.code, -32700);

      const notObject = await rpc.handleLine('[]');
      assert.equal(isRpcFailure(notObject), true);
      if (!isRpcFailure(notObject)) throw new Error('unreachable');
      assert.equal(notObject.error.code, -32600);

      const unknown = await rpc.handleCommand({ jsonrpc: '2.0', id: 'unknown-method', method: 'autopilot/run', params: {} });
      assert.equal(isRpcFailure(unknown), true);
      if (!isRpcFailure(unknown)) throw new Error('unreachable');
      assert.equal(unknown.error.code, -32601);

      const badParams = await rpc.handleCommand({ jsonrpc: '2.0', id: 'bad-params', method: 'tools/call', params: { name: ROSTER_SETUP_TOOL_NAME } });
      assert.equal(isRpcFailure(badParams), true);
      if (!isRpcFailure(badParams)) throw new Error('unreachable');
      assert.equal(badParams.error.code, -32602);

      const firstList = await rpc.handleCommand(jsonRpcListTools('duplicate-id'));
      assert.equal(isRpcSuccess(firstList), true);
      const duplicate = await rpc.handleCommand(jsonRpcListTools('duplicate-id'));
      assert.equal(isRpcFailure(duplicate), true);
      if (!isRpcFailure(duplicate)) throw new Error('unreachable');
      assert.equal(duplicate.error.code, -32001);

      const first = rpc.handleCommand(jsonRpcToolCall('concurrent-a', harness.directRequest('inspect')));
      const concurrent = await rpc.handleCommand(jsonRpcToolCall('concurrent-b', harness.directRequest('inspect')));
      assert.equal(isRpcFailure(concurrent), true);
      if (!isRpcFailure(concurrent)) throw new Error('unreachable');
      assert.equal(concurrent.error.code, -32002);
      const firstResponse = await first;
      assert.equal(isRpcSuccess(firstResponse), true);
      const firstResult = rpcToolResult(firstResponse);
      assert.equal(firstResult.write_count, 0);
      assert.deepEqual(await harness.stateFiles(), []);
      assertNoRunWorktreeCoordinatorOrSpend(harness.sideEffectsSnapshot());
    });
  });

  void it('blocks unqualified W0 saves and shaped-but-untrusted Kimi manifest saves without writes', async () => {
    await withRosterSetupHarness(async (harness) => {
      harness.activateSetup();
      const rpc = new FakeRosterJsonRpcHarness(harness);
      const proposalResponse = await rpc.handleCommand(jsonRpcToolCall('w0-propose', harness.directRequest('propose')));
      const proposal = rpcToolResult(proposalResponse);
      const approval = harness.hostApprove(proposal);
      const blockedResponse = await rpc.handleCommand(jsonRpcToolCall('w0-save', harness.directRequest('save', {
        approval_token: approval.approval_token,
        candidate_set_sha256: approval.candidate_set_sha256,
        approved_roster_sha256s: approval.approved_roster_sha256s,
        default_roster_id: approval.default_roster_id,
        default_roster_revision: approval.default_roster_revision,
        default_roster_sha256: approval.default_roster_sha256,
        original_command: approval.original_command,
      })));
      const blocked = rpcToolResult(blockedResponse);
      assert.equal(blocked.ok, false);
      assert.equal(blocked.status, 'blocked');
      assert.ok(diagnosticCodes(blocked).includes('ROSTER_QUALIFICATION_REQUIRED'));
      assert.equal(blocked.write_count, 0);
      assert.equal(harness.counters.saveCapabilityCalls, 0);
    });

    const fixture = selfHashedKimiW4ManifestFixture();
    await withRosterSetupHarness(async (harness) => {
      harness.activateSetup();
      const rpc = new FakeRosterJsonRpcHarness(harness);

      const proposalResponse = await rpc.handleCommand(jsonRpcToolCall('propose', harness.directRequest('propose')));
      const proposal = rpcToolResult(proposalResponse);
      const candidateSet = requireCandidateSet(proposal);
      assert.equal(candidateSet.candidates.some((candidate) => candidate.launch_readiness === 'w4-certified-ready'), false);
      assert.equal(proposal.write_count, 0);
      const approval = harness.hostApprove(proposal);

      const saveArgs = harness.directRequest('save', {
        approval_token: approval.approval_token,
        candidate_set_sha256: approval.candidate_set_sha256,
        approved_roster_sha256s: approval.approved_roster_sha256s,
        default_roster_id: approval.default_roster_id,
        default_roster_revision: approval.default_roster_revision,
        default_roster_sha256: approval.default_roster_sha256,
        original_command: approval.original_command,
      });
      const saveResponse = await rpc.handleCommand(jsonRpcToolCall('save', saveArgs));
      const blocked = rpcToolResult(saveResponse);
      assert.equal(blocked.ok, false);
      assert.equal(blocked.status, 'blocked');
      assert.ok(diagnosticCodes(blocked).includes('ROSTER_QUALIFICATION_REQUIRED'));
      assert.equal(blocked.write_count, 0);
      assert.equal(blocked.lock_count, 0);
      assert.deepEqual(blocked.files_touched, []);
      assert.equal(blocked.receipt, null);
      assertSecretFree(blocked);

      const duplicateTransportReplay = await rpc.handleCommand(jsonRpcToolCall('save', saveArgs));
      assert.equal(isRpcFailure(duplicateTransportReplay), true);
      if (!isRpcFailure(duplicateTransportReplay)) throw new Error('unreachable');
      assert.equal(duplicateTransportReplay.error.code, -32001);

      const replayResponse = await rpc.handleCommand(jsonRpcToolCall('save-replay-new-id', saveArgs));
      const replay = rpcToolResult(replayResponse);
      assert.equal(replay.ok, false);
      assert.equal(replay.status, 'blocked');
      assert.deepEqual(diagnosticCodes(replay), ['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
      assert.equal(replay.write_count, 0);
      assert.equal(harness.counters.saveCapabilityCalls, 0);
      assert.deepEqual(await harness.stateFiles(), []);
      assertNoRunWorktreeCoordinatorOrSpend(harness.sideEffectsSnapshot());
    }, {
      inventory: kimiRosterInventory(),
      qualificationManifests: [fixture.manifest],
    });
  });
});
