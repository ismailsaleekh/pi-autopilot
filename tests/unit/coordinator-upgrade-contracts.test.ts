import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCoordinatorLegacyReplayTransportRequest } from '../../src/core/coordination/ipc.ts';
import { classifyCoordinatorRuntimeIdentity } from '../../src/core/coordination/runtime-compatibility.ts';
import { COORDINATOR_UPGRADE_PATH, parseCoordinatorUpgradeIntent, parseCurrentCoordinatorLock, parseKnownCompatibleCurrentCoordinatorLock, parseKnownCoordinatorUpgradeIntent, parsePredecessorCoordinatorLock, parsePredecessorStatusEnvelope, parsePriorSchema11CurrentCoordinatorLock, parsePriorSchema10CurrentCoordinatorLock, parsePriorSchema9CurrentCoordinatorLock } from '../../src/core/coordination/upgrade-contracts.ts';

const capability = 'a'.repeat(64);

void describe('BUG-175 standalone coordinator upgrade contracts', () => {
  void it('locks one exact 1.2/schema-6/build predecessor to the protocol-1.6/schema-12 byte-bounded target', () => {
    assert.deepEqual(COORDINATOR_UPGRADE_PATH.source, { package_build: '0.13.0-cf34', protocol_version: '1.2', database_schema_version: 6, lifecycle_lock_schema: 'autopilot.coordinator_lock.v1' });
    assert.deepEqual(COORDINATOR_UPGRADE_PATH.target, { package_build: '1.1.7-cf49', protocol_version: '1.6', database_schema_version: 12, lifecycle_lock_schema: 'autopilot.coordinator_lock.v2' });
    const predecessor = { schema_version: 'autopilot.coordinator_lock.v1', pid: 123, boot_id: 'boot', token: 'token', started_at: '2026-07-12T00:00:00.000Z' };
    const current = { schema_version: 'autopilot.coordinator_lock.v2', pid: 456, boot_id: 'boot', process_start_identity: 'process-start', token: 'token', instance_id: 'instance', package_build: '1.1.7-cf49', protocol_version: '1.6', database_schema_version: 12, started_at: '2026-07-12T00:00:00.000Z' };
    const priorCf47 = { ...current, package_build: '1.1.5-cf47' };
    const priorCf46 = { ...current, package_build: '1.1.4-cf46' };
    const priorCf45 = { ...current, package_build: '1.1.3-cf45' };
    const priorCf44 = { ...current, package_build: '1.1.2-cf44' };
    const priorCf43 = { ...current, package_build: '1.1.1-cf43' };
    const priorSchema11 = { ...current, package_build: '1.1.0-cf42', protocol_version: '1.5', database_schema_version: 11 };
    const priorSchema10 = { ...current, package_build: '1.1.0-cf41', protocol_version: '1.4', database_schema_version: 10 };
    const priorSchema9 = { ...current, package_build: '1.0.3-cf40', protocol_version: '1.3', database_schema_version: 9 };
    assert.notEqual(parsePredecessorCoordinatorLock(predecessor), null);
    assert.equal(parsePredecessorCoordinatorLock(current), null);
    assert.notEqual(parseCurrentCoordinatorLock(current), null, 'the exact current build parses as the current lifecycle lock');
    assert.equal(parseCurrentCoordinatorLock(priorCf47), null, 'cf47 is a certified prior compatible patch build, not the exact current build');
    assert.notEqual(parseKnownCompatibleCurrentCoordinatorLock(priorCf47), null, 'cf47 is wire-compatible-known only after explicit real-binary certification');
    assert.equal(parseCurrentCoordinatorLock(priorCf46), null, 'a prior compatible patch build is not the exact current build');
    assert.notEqual(parseKnownCompatibleCurrentCoordinatorLock(priorCf46), null, 'cf46 remains wire-compatible-known after explicit certification');
    assert.equal(parseCurrentCoordinatorLock(priorCf45), null, 'an older compatible patch build is not the exact current build');
    assert.notEqual(parseKnownCompatibleCurrentCoordinatorLock(priorCf45), null, 'cf45 remains wire-compatible-known after explicit certification');
    assert.notEqual(parseKnownCompatibleCurrentCoordinatorLock(priorCf44), null, 'cf44 remains wire-compatible-known');
    assert.notEqual(parseKnownCompatibleCurrentCoordinatorLock(priorCf43), null, 'cf43 remains wire-compatible-known');
    assert.equal(parseCurrentCoordinatorLock(priorSchema9), null, 'schema upgrades retain exact target-build parsing');
    assert.equal(parseKnownCompatibleCurrentCoordinatorLock(priorSchema11), null, 'schema-11 is a migration source, never current-wire compatible');
    assert.notEqual(parsePriorSchema11CurrentCoordinatorLock(priorSchema11), null);
    assert.equal(parseKnownCompatibleCurrentCoordinatorLock(priorSchema10), null, 'schema-10 is a migration source, never current-wire compatible');
    assert.notEqual(parsePriorSchema10CurrentCoordinatorLock(priorSchema10), null);
    assert.equal(parseKnownCompatibleCurrentCoordinatorLock(priorSchema9), null, 'schema-9 is a migration source, never current-wire compatible');
    assert.notEqual(parsePriorSchema9CurrentCoordinatorLock(priorSchema9), null);
    assert.equal(parseKnownCompatibleCurrentCoordinatorLock({ ...current, package_build: '0.14.1-unknown' }), null);
    assert.equal(parseKnownCompatibleCurrentCoordinatorLock({ ...current, protocol_version: '1.3' }), null);
    assert.equal(parseKnownCompatibleCurrentCoordinatorLock({ ...current, database_schema_version: 9 }), null);
    assert.equal(parsePredecessorCoordinatorLock({ ...predecessor, extra: true }), null);
  });

  void it('classifies only the closed protocol-1.6/schema-12 builds as current-wire compatible', () => {
    assert.equal(classifyCoordinatorRuntimeIdentity({ package_build: '1.1.7-cf49', protocol_version: '1.6', database_schema_version: 12 }).kind, 'exact-target');
    assert.equal(classifyCoordinatorRuntimeIdentity({ package_build: '1.1.6-cf48', protocol_version: '1.6', database_schema_version: 12 }).kind, 'wire-compatible-known');
    assert.equal(classifyCoordinatorRuntimeIdentity({ package_build: '1.1.5-cf47', protocol_version: '1.6', database_schema_version: 12 }).kind, 'wire-compatible-known');
    assert.equal(classifyCoordinatorRuntimeIdentity({ package_build: '1.1.4-cf46', protocol_version: '1.6', database_schema_version: 12 }).kind, 'wire-compatible-known');
    assert.equal(classifyCoordinatorRuntimeIdentity({ package_build: '1.1.3-cf45', protocol_version: '1.6', database_schema_version: 12 }).kind, 'wire-compatible-known');
    assert.equal(classifyCoordinatorRuntimeIdentity({ package_build: '1.1.2-cf44', protocol_version: '1.6', database_schema_version: 12 }).kind, 'wire-compatible-known');
    assert.equal(classifyCoordinatorRuntimeIdentity({ package_build: '1.1.1-cf43', protocol_version: '1.6', database_schema_version: 12 }).kind, 'wire-compatible-known', 'a prior compatible patch build is wire-compatible, not the exact current build');
    assert.deepEqual(classifyCoordinatorRuntimeIdentity({ package_build: '1.0.3-cf40', protocol_version: '1.3', database_schema_version: 9 }), { kind: 'incompatible', reason: 'unknown-build', package_build: '1.0.3-cf40' });
    assert.deepEqual(classifyCoordinatorRuntimeIdentity({ package_build: 'unknown-cf42', protocol_version: '1.5', database_schema_version: 11 }), { kind: 'incompatible', reason: 'unknown-build', package_build: 'unknown-cf42' });
    assert.deepEqual(classifyCoordinatorRuntimeIdentity({ package_build: '1.1.7-cf49', protocol_version: '1.5', database_schema_version: 12 }), { kind: 'incompatible', reason: 'protocol-mismatch', package_build: '1.1.7-cf49' });
    assert.deepEqual(classifyCoordinatorRuntimeIdentity({ package_build: '1.1.7-cf49', protocol_version: '1.6', database_schema_version: 11 }), { kind: 'incompatible', reason: 'schema-mismatch', package_build: '1.1.7-cf49' });
  });

  void it('allows only exact prior-protocol idempotency replay and rejects status or unknown protocol replay', () => {
    const request = { schema_version: 'autopilot.coordinator_request.v1', protocol_version: '1.2', request_id: 'request-prior', action: 'acquire-group', idempotency_key: 'idempotency-prior', repo_id: 'repo-prior', workstream_run: 'run-prior', session_id: 'session-prior', fencing_generation: 1, expected_version: 1, payload: { acquisition_group_id: 'group-prior' } };
    const parsed = parseCoordinatorLegacyReplayTransportRequest({ transport_version: 'autopilot.coordinator_transport.v1', capability, request });
    assert.equal(parsed.replay_protocol, '1.2');
    assert.equal(parseCoordinatorLegacyReplayTransportRequest({ transport_version: 'autopilot.coordinator_transport.v1', capability, request: { ...request, protocol_version: '1.5' } }).replay_protocol, '1.5');
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
    const historicalCommitted = { ...intent, state: 'committed', target: { ...intent.target, package_build: '1.0.1-cf38', protocol_version: '1.3', database_schema_version: 9 } };
    assert.equal(parseKnownCoordinatorUpgradeIntent(historicalCommitted).target.package_build, '1.0.1-cf38');
    assert.throws(() => parseCoordinatorUpgradeIntent(historicalCommitted), /target differs from this package/u);
    assert.throws(() => parseKnownCoordinatorUpgradeIntent({ ...historicalCommitted, target: { ...historicalCommitted.target, package_build: 'unknown-cf99' } }), /outside the closed historical schema-9\/schema-10\/schema-11\/current-schema-12 lineage/u);
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
