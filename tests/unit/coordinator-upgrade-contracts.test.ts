import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCoordinatorLegacyReplayTransportRequest } from '../../src/core/coordination/ipc.ts';
import { classifyCoordinatorRuntimeIdentity } from '../../src/core/coordination/runtime-compatibility.ts';
import { COORDINATOR_UPGRADE_PATH, parseCoordinatorUpgradeIntent, parseCurrentCoordinatorLock, parseKnownCompatibleCurrentCoordinatorLock, parseKnownCoordinatorUpgradeIntent, parsePredecessorCoordinatorLock, parsePredecessorStatusEnvelope } from '../../src/core/coordination/upgrade-contracts.ts';

const capability = 'a'.repeat(64);

void describe('BUG-175 standalone coordinator upgrade contracts', () => {
  void it('locks one exact 1.2/schema-6/build predecessor to one exact 1.3/schema-9 target', () => {
    assert.deepEqual(COORDINATOR_UPGRADE_PATH.source, { package_build: '0.13.0-cf34', protocol_version: '1.2', database_schema_version: 6, lifecycle_lock_schema: 'autopilot.coordinator_lock.v1' });
    assert.deepEqual(COORDINATOR_UPGRADE_PATH.target, { package_build: '1.0.3-cf40', protocol_version: '1.3', database_schema_version: 9, lifecycle_lock_schema: 'autopilot.coordinator_lock.v2' });
    const predecessor = { schema_version: 'autopilot.coordinator_lock.v1', pid: 123, boot_id: 'boot', token: 'token', started_at: '2026-07-12T00:00:00.000Z' };
    const current = { schema_version: 'autopilot.coordinator_lock.v2', pid: 456, boot_id: 'boot', process_start_identity: 'process-start', token: 'token', instance_id: 'instance', package_build: '1.0.3-cf40', protocol_version: '1.3', database_schema_version: 9, started_at: '2026-07-12T00:00:00.000Z' };
    const compatiblePrior = { ...current, package_build: '1.0.1-cf38' };
    assert.notEqual(parsePredecessorCoordinatorLock(predecessor), null);
    assert.equal(parsePredecessorCoordinatorLock(current), null);
    assert.notEqual(parseCurrentCoordinatorLock(current), null);
    assert.equal(parseCurrentCoordinatorLock(compatiblePrior), null, 'schema upgrades retain exact target-build parsing');
    assert.notEqual(parseKnownCompatibleCurrentCoordinatorLock(compatiblePrior), null, 'ordinary lifecycle election recognizes an audited prior patch lock');
    assert.equal(parseKnownCompatibleCurrentCoordinatorLock({ ...current, package_build: '0.14.1-unknown' }), null);
    assert.equal(parseKnownCompatibleCurrentCoordinatorLock({ ...current, package_build: '1.0.1-cf38', protocol_version: '1.4' }), null);
    assert.equal(parseKnownCompatibleCurrentCoordinatorLock({ ...current, package_build: '1.0.1-cf38', database_schema_version: 10 }), null);
    assert.equal(parsePredecessorCoordinatorLock({ ...predecessor, extra: true }), null);
  });

  void it('classifies only the closed patch lineage as ordinary wire-compatible', () => {
    assert.equal(classifyCoordinatorRuntimeIdentity({ package_build: '1.0.3-cf40', protocol_version: '1.3', database_schema_version: 9 }).kind, 'exact-target');
    assert.equal(classifyCoordinatorRuntimeIdentity({ package_build: '1.0.1-cf38', protocol_version: '1.3', database_schema_version: 9 }).kind, 'wire-compatible-known');
    assert.deepEqual(classifyCoordinatorRuntimeIdentity({ package_build: 'unknown-cf40', protocol_version: '1.3', database_schema_version: 9 }), { kind: 'incompatible', reason: 'unknown-build', package_build: 'unknown-cf40' });
    assert.deepEqual(classifyCoordinatorRuntimeIdentity({ package_build: '1.0.1-cf38', protocol_version: '1.4', database_schema_version: 9 }), { kind: 'incompatible', reason: 'protocol-mismatch', package_build: '1.0.1-cf38' });
    assert.deepEqual(classifyCoordinatorRuntimeIdentity({ package_build: '1.0.1-cf38', protocol_version: '1.3', database_schema_version: 10 }), { kind: 'incompatible', reason: 'schema-mismatch', package_build: '1.0.1-cf38' });
  });

  void it('allows only exact prior-protocol idempotency replay and rejects status or unknown protocol replay', () => {
    const request = { schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.2', request_id: 'request-prior', action: 'acquire-group', idempotency_key: 'idempotency-prior', repo_id: 'repo-prior', workstream_run: 'run-prior', session_id: 'session-prior', fencing_generation: 1, expected_version: 1, payload: { acquisition_group_id: 'group-prior' } };
    const parsed = parseCoordinatorLegacyReplayTransportRequest({ transport_version: 'autopilot.coordinator_transport.v1', capability, request });
    assert.equal(parsed.replay_protocol, '1.2');
    assert.throws(() => parseCoordinatorLegacyReplayTransportRequest({ transport_version: 'autopilot.coordinator_transport.v1', capability, request: { ...request, idempotency_key: null, action: 'status' } }), /identity or payload/u);
    assert.throws(() => parseCoordinatorLegacyReplayTransportRequest({ transport_version: 'autopilot.coordinator_transport.v1', capability, request: { ...request, protocol_version: '1.0' } }), /proven-compatible/u);
  });

  void it('binds the durable handoff fence and exact process-creation identity without inventing predecessor controls', () => {
    const fence = { schema_version: 'autopilot.coordinator_lock.v1', pid: 123, boot_id: 'boot', token: 'token', started_at: '2026-07-12T00:00:00.000Z' } as const;
    const intent = {
      schema_version: 'autopilot.coordinator_upgrade_intent.v1', upgrade_id: 'upgrade', state: 'starting',
      source: { package_build: '0.13.0-cf34', protocol_version: '1.2', database_schema_version: 6, pid: 122, boot_id: 'boot', process_start_identity: 'process-start', lock_token: 'old-token', lock_started_at: fence.started_at },
      target: COORDINATOR_UPGRADE_PATH.target, safe_checkpoints: [], blockers: [], predecessor_fence: fence, backup: null,
      created_at: fence.started_at, updated_at: fence.started_at, failure: null,
    };
    assert.equal(parseCoordinatorUpgradeIntent(intent).predecessor_fence?.token, 'token');
    const historicalCommitted = { ...intent, state: 'committed', target: { ...intent.target, package_build: '1.0.1-cf38' } };
    assert.equal(parseKnownCoordinatorUpgradeIntent(historicalCommitted).target.package_build, '1.0.1-cf38');
    assert.throws(() => parseCoordinatorUpgradeIntent(historicalCommitted), /target differs from this package/u);
    assert.throws(() => parseKnownCoordinatorUpgradeIntent({ ...historicalCommitted, target: { ...historicalCommitted.target, package_build: 'unknown-cf99' } }), /outside the closed schema-9 build lineage/u);
    assert.throws(() => parseCoordinatorUpgradeIntent({ ...intent, source: { ...intent.source, process_start_identity: '' } }), /process_start_identity/u);
    assert.throws(() => parseCoordinatorUpgradeIntent({ ...intent, predecessor_fence: { ...fence, extra: true } }), /predecessor fence is invalid/u);
  });

  void it('requires an authenticated predecessor status response to carry exact build, protocol, and schema identity', () => {
    const response = { schema_version: 'autopilot.coordinator_response.v1', protocol_version: '1.2', request_id: 'status-exact', ok: true, committed_event_seq: null, error_code: null, retryable: false, payload: { schema_version: 'autopilot.coordinator_status.v1', package_build: '0.13.0-cf34', protocol_version: '1.2', database_schema_version: 6, runs: [], unit_attempts: [], worktree_operations: [] } };
    assert.equal(parsePredecessorStatusEnvelope(response, 'status-exact').database_schema_version, 6);
    assert.throws(() => parsePredecessorStatusEnvelope({ ...response, payload: { ...response.payload, package_build: 'unknown' } }, 'status-exact'), /locked 1.2 predecessor/u);
    assert.throws(() => parsePredecessorStatusEnvelope({ ...response, extra: true }, 'status-exact'), /fields are incompatible/u);
  });
});
