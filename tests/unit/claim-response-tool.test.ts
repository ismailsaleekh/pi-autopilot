import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createClaimResponseTool, type ClaimRequestResponder } from '../../src/core/coordination/claim-response-tool.ts';
import type { CoordinationClaimRequest, CoordinationReleaseCondition } from '../../src/core/coordination/types.ts';

function request(status: CoordinationClaimRequest['status'], condition: CoordinationReleaseCondition | null, reason: string): CoordinationClaimRequest {
  const owner = { repo_id: 'repo-tool', autopilot_id: 'owner-tool', workstream_run: 'run-owner-tool', unit_id: 'unit-owner-tool', attempt: 1 };
  return {
    schema_version: 'autopilot.claim_request.v1', request_id: 'request-tool', acquisition_group_id: 'group-tool', requester: { ...owner, autopilot_id: 'requester-tool', workstream_run: 'run-requester-tool', unit_id: 'unit-requester-tool' }, owner,
    blocking_lease_ids: ['lease-tool'], requested_leases: [{ path: 'src/shared.ts', mode: 'WRITE', purpose: 'tool witness' }], reason: 'request shared authority',
    created_event_seq: 1, status, owner_reason: reason, release_condition: condition, release_event_seq: status === 'released' ? 2 : null, grant_event_seq: null, version: 2,
  };
}

void describe('BUG-174 authenticated parent claim-response tool', () => {
  void it('wires exact release-now input to the current durable owner responder', async () => {
    let captured: Parameters<ClaimRequestResponder['respondById']>[0] | null = null;
    const responder: ClaimRequestResponder = {
      respondById: (input) => {
        captured = input;
        return Promise.resolve(request('released', null, input.ownerReason));
      },
    };
    const tool = createClaimResponseTool(() => responder);
    const result = await tool.execute('tool-call', { request_id: 'request-tool', response: 'release-now', owner_reason: 'The contested authority is no longer required.' }, undefined, undefined, undefined);
    assert.deepEqual(captured, { requestId: 'request-tool', response: 'release-now', ownerReason: 'The contested authority is no longer required.', releaseCondition: null });
    assert.equal(result.details.status, 'released');
    assert.equal(result.details.request_id, 'request-tool');
    assert.equal(result.content[0].text, JSON.stringify(result.details));
  });

  void it('supports only typed observable deferral and validates evidence as an exact pair', async () => {
    const captured: Parameters<ClaimRequestResponder['respondById']>[0][] = [];
    const responder: ClaimRequestResponder = {
      respondById: (input) => {
        captured.push(input);
        return Promise.resolve(request('deferred', input.releaseCondition, input.ownerReason));
      },
    };
    const tool = createClaimResponseTool(() => responder);
    await tool.execute('tool-call', {
      request_id: 'request-tool', response: 'deferred', owner_reason: 'Release after exact merge evidence is accepted.',
      condition_type: 'unit-merged', target_id: 'unit-owner-tool:1', evidence_ref: '.pi/autopilot/tool/unit-merges/unit-owner-tool.json', evidence_sha256: `sha256:${'a'.repeat(64)}`,
    }, undefined, undefined, undefined);
    assert.deepEqual(captured[0]?.releaseCondition, { condition_type: 'unit-merged', target_id: 'unit-owner-tool:1', evidence: { ref: '.pi/autopilot/tool/unit-merges/unit-owner-tool.json', sha256: `sha256:${'a'.repeat(64)}` } });
    await assert.rejects(() => tool.execute('bad-pair', { request_id: 'request-tool', response: 'deferred', owner_reason: 'bad pair', condition_type: 'unit-merged', target_id: 'unit-owner-tool:1', evidence_ref: 'only-ref' }, undefined, undefined, undefined), /must be supplied together/u);
    await assert.rejects(() => tool.execute('bad-release', { request_id: 'request-tool', response: 'release-now', owner_reason: 'bad condition', condition_type: 'unit-merged', target_id: 'unit-owner-tool:1' }, undefined, undefined, undefined), /must not include/u);
  });

  void it('fails loudly without an attached owner and before mutation when aborted', async () => {
    const tool = createClaimResponseTool(() => null);
    await assert.rejects(() => tool.execute('inactive', { request_id: 'request-tool', response: 'release-now', owner_reason: 'no session' }, undefined, undefined, undefined), /No authenticated active Autopilot run/u);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => tool.execute('aborted', { request_id: 'request-tool', response: 'release-now', owner_reason: 'aborted' }, controller.signal, undefined, undefined), /aborted before coordinator mutation/u);
  });
});
