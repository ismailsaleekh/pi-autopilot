import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertExactExclusiveRepositoryPath,
  COORDINATION_EXCLUSIVE_MAX_EXPECTED_DURATION_MS,
  coordinationExclusiveOperation,
  legacyMigrationExclusiveOperation,
} from '../../src/core/coordination/exclusive-policy.ts';
import {
  parseCoordinationAcquisitionGroup,
  parseCoordinationEditLease,
  parseCoordinationExclusiveOperation,
  parseCoordinationRequestedLease,
} from '../../src/core/coordination/contracts.ts';
import { checkCoordinationInvariants } from '../../src/core/coordination/invariants.ts';
import { releaseCoordinationLeaseAndNotify } from '../../src/core/coordination/transition-model.ts';
import { coordinationOwner, validCoordinationSnapshot } from '../helpers/coordination-fixture.ts';

function runtimeOperation(id = 'exclusive-policy-operation') {
  return coordinationExclusiveOperation({
    operationId: id,
    operationKind: 'canonical-authority-replacement',
    expectedDurationMs: 30_000,
  });
}

interface GroupOverrides {
  readonly acquisition_kind?: 'initial' | 'materialization-read-expansion' | 'legacy-unknown';
  readonly normal_release_condition?: {
    readonly condition_type: 'unit-merged' | 'child-terminal' | 'explicit-owner-release';
    readonly target_id: string;
    readonly evidence: null;
  };
}

function group(requestedLeases: readonly unknown[], overrides: GroupOverrides = {}) {
  return {
    schema_version: 'autopilot.acquisition_group.v2',
    acquisition_group_id: 'exclusive-policy-group',
    owner: coordinationOwner('run-a', 'unit-a'),
    acquisition_kind: 'initial',
    requested_leases: requestedLeases,
    reason: 'exercise the bounded EXCLUSIVE policy',
    normal_release_condition: { condition_type: 'unit-merged', target_id: 'unit-a:1', evidence: null },
    state: 'waiting',
    created_event_seq: 4,
    fairness_event_seq: 4,
    grant_event_seq: null,
    offer_expires_at: null,
    offer_count: 0,
    bypass_count: 0,
    version: 1,
    ...overrides,
  };
}

void describe('bounded EXCLUSIVE critical-operation policy', () => {
  void it('constructs only immutable closed package operations with bounded duration and exact scope', () => {
    const operation = runtimeOperation();
    assert.equal(Object.isFrozen(operation), true);
    assert.deepEqual(operation, {
      schema_version: 'autopilot.exclusive_operation.v1',
      operation_id: 'exclusive-policy-operation',
      operation_kind: 'canonical-authority-replacement',
      critical_section: 'canonical-authority-replacement',
      resource_scope: 'exact-repository-path',
      expected_duration_ms: 30_000,
      release_trigger: 'critical-section-exit',
    });
    assert.throws(() => coordinationExclusiveOperation({ operationId: 'bad id', operationKind: 'critical-git-operation', expectedDurationMs: 1 }), /operation_id/u);
    assert.throws(() => coordinationExclusiveOperation({ operationId: 'duration-zero', operationKind: 'critical-git-operation', expectedDurationMs: 0 }), /positive bounded/u);
    assert.throws(() => coordinationExclusiveOperation({ operationId: 'duration-large', operationKind: 'critical-git-operation', expectedDurationMs: COORDINATION_EXCLUSIVE_MAX_EXPECTED_DURATION_MS + 1 }), /positive bounded/u);
    assert.throws(() => assertExactExclusiveRepositoryPath('.'), /exact repository file/u);
    assert.throws(() => assertExactExclusiveRepositoryPath('src/**'), /exact repository file/u);
    assert.doesNotThrow(() => assertExactExclusiveRepositoryPath('src/exact.ts'));
  });

  void it('strictly parses operation metadata and rejects every open or contradictory shape', () => {
    const operation = runtimeOperation();
    assert.deepEqual(parseCoordinationExclusiveOperation(operation), operation);
    assert.throws(() => parseCoordinationExclusiveOperation({ ...operation, operation_kind: 'free-form-operation' }), /operation_kind/u);
    assert.throws(() => parseCoordinationExclusiveOperation({ ...operation, critical_section: 'critical-git-operation' }), /must equal/u);
    assert.throws(() => parseCoordinationExclusiveOperation({ ...operation, release_trigger: 'timeout' }), /release_trigger/u);
    assert.throws(() => parseCoordinationExclusiveOperation({ ...operation, resource_scope: 'repository-root' }), /resource_scope/u);
    assert.throws(() => parseCoordinationExclusiveOperation({ ...operation, expected_duration_ms: COORDINATION_EXCLUSIVE_MAX_EXPECTED_DURATION_MS + 1 }), /expected_duration_ms/u);
    assert.throws(() => parseCoordinationExclusiveOperation({ ...operation, invented: true }), /unknown fields/u);
  });

  void it('requires one exact EXCLUSIVE layered over WRITE and forbids spec-like expansion', () => {
    const operation = runtimeOperation();
    const write = { path: 'src/exact.ts', mode: 'WRITE', purpose: 'retained edit attribution' };
    const exclusive = { path: 'src/exact.ts', mode: 'EXCLUSIVE', purpose: 'bounded replacement', exclusive_operation: operation };
    const parsed = parseCoordinationAcquisitionGroup(group([write, exclusive]));
    assert.deepEqual(parsed.requested_leases.map((lease) => lease.mode), ['WRITE', 'EXCLUSIVE']);
    assert.throws(() => parseCoordinationRequestedLease({ path: 'src/exact.ts', mode: 'EXCLUSIVE', purpose: 'missing operation' }), /requires a closed/u);
    assert.throws(() => parseCoordinationRequestedLease({ ...write, exclusive_operation: operation }), /only EXCLUSIVE/u);
    assert.throws(() => parseCoordinationRequestedLease({ ...exclusive, path: 'src/**' }), /exact repository path/u);
    assert.throws(() => parseCoordinationAcquisitionGroup(group([exclusive])), /layer over an exact WRITE/u);
    assert.throws(() => parseCoordinationAcquisitionGroup(group([write, exclusive, { ...exclusive, path: 'src/other.ts', exclusive_operation: runtimeOperation('other-operation') }])), /at most one EXCLUSIVE/u);
    assert.throws(() => parseCoordinationAcquisitionGroup(group([write, exclusive], { acquisition_kind: 'materialization-read-expansion' })), /cannot acquire EXCLUSIVE/u);
    assert.throws(() => parseCoordinationAcquisitionGroup(group([write, exclusive], { normal_release_condition: { condition_type: 'child-terminal', target_id: 'child-a', evidence: null } })), /exact unit-merge/u);
  });

  void it('retains ambiguous legacy EXCLUSIVE scope without admitting it as new authority', () => {
    const operation = legacyMigrationExclusiveOperation('legacy-exclusive-policy');
    const legacy = { path: 'src/**', mode: 'EXCLUSIVE', purpose: 'historical broad authority', exclusive_operation: operation };
    assert.equal(parseCoordinationAcquisitionGroup(group([legacy], {
      acquisition_kind: 'legacy-unknown',
      normal_release_condition: { condition_type: 'explicit-owner-release', target_id: 'unit-a:1', evidence: null },
    })).requested_leases[0]?.exclusive_operation?.operation_kind, 'legacy-migration-exclusive');
    assert.equal(parseCoordinationEditLease({
      schema_version: 'autopilot.edit_lease.v1', edit_lease_id: 'legacy-exclusive-lease', owner: coordinationOwner('run-a', 'unit-a'),
      acquisition_group_id: 'legacy-exclusive-group', path: 'src/**', mode: 'EXCLUSIVE', purpose: 'historical broad authority', exclusive_operation: operation,
      acquired_event_seq: 1, normal_release_condition: { condition_type: 'explicit-owner-release', target_id: 'unit-a:1', evidence: null }, version: 1,
    }).path, 'src/**');
    assert.throws(() => parseCoordinationAcquisitionGroup(group([
      { path: 'src/exact.ts', mode: 'WRITE', purpose: 'edit' },
      { path: 'src/exact.ts', mode: 'EXCLUSIVE', purpose: 'bad new import', exclusive_operation: operation },
    ])), /cannot create legacy EXCLUSIVE/u);
  });

  void it('accepts only the explicit post-exit partial state and reports every unsafe variant', () => {
    const snapshot = validCoordinationSnapshot();
    const exited = releaseCoordinationLeaseAndNotify(snapshot, {
      repoId: 'repo-1', workstreamRun: 'run-a', sessionId: 'session-a', fencingGeneration: 1,
      idempotencyKey: 'exclusive-policy-exit', requestHash: `sha256:${'e'.repeat(64)}`,
      occurredAt: '2026-07-11T15:05:00.000Z', editLeaseId: 'lease-a', requestId: 'request-b-a', messageId: 'exclusive-policy-release-message',
    });
    assert.deepEqual(checkCoordinationInvariants(exited), []);

    const notExited = { ...snapshot, edit_leases: snapshot.edit_leases.filter((lease) => lease.mode !== 'EXCLUSIVE') };
    assert.equal(checkCoordinationInvariants(notExited).some((finding) => finding.code === 'granted-group-authority-incomplete'), true);

    const preemptibleCritical = {
      ...snapshot,
      unit_attempts: snapshot.unit_attempts.map((attempt) => attempt.owner.workstream_run === 'run-a' ? { ...attempt, preemptible: true } : attempt),
    };
    assert.equal(checkCoordinationInvariants(preemptibleCritical).some((finding) => finding.code === 'exclusive-critical-section-mismatch'), true);

    const missingWrite = { ...snapshot, edit_leases: snapshot.edit_leases.filter((lease) => lease.mode !== 'WRITE') };
    assert.equal(checkCoordinationInvariants(missingWrite).some((finding) => finding.code === 'exclusive-write-layer-missing'), true);
  });
});
