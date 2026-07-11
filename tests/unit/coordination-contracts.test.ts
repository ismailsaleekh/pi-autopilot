import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTOPILOT_COORDINATION_JSON_SCHEMAS,
  COORDINATION_FAILURE_CODES,
  COORDINATION_FAILURE_MATRIX,
  COORDINATION_FAILURE_TAXONOMY,
  assertCoordinationInvariants,
  checkCoordinationInvariants,
  coordinationFailureDefinition,
  parseCoordinationEscalation,
  parseCoordinationSnapshot,
  parseCoordinatorRequestEnvelope,
  parseCoordinatorResponseEnvelope,
} from '../../src/core/coordination/index.ts';
import { validCoordinationSnapshot } from '../helpers/coordination-fixture.ts';

function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

void describe('Coordination Fabric contracts and invariants', () => {
  void it('publishes a closed schema for every Phase 27 coordination entity', () => {
    assert.deepEqual(Object.keys(AUTOPILOT_COORDINATION_JSON_SCHEMAS).sort(), [
      'acquisition_group',
      'change_reservation',
      'child_lease',
      'claim_request',
      'coordinator_request',
      'coordinator_response',
      'edit_lease',
      'escalation',
      'event',
      'message',
      'repository',
      'run',
      'session_lease',
      'snapshot',
      'unit_attempt',
      'worktree',
      'worktree_operation',
    ]);
    for (const schema of Object.values(AUTOPILOT_COORDINATION_JSON_SCHEMAS)) {
      assert.equal(schema['type'], 'object');
      assert.equal(schema['additionalProperties'], false);
    }
  });

  void it('parses a complete snapshot from unknown and proves its invariants', () => {
    const parsed = parseCoordinationSnapshot(jsonRoundTrip(validCoordinationSnapshot()));
    assert.equal(parsed.runs.length, 2);
    assert.equal(parsed.edit_leases.length, 1);
    assert.deepEqual(checkCoordinationInvariants(parsed), []);
    assert.doesNotThrow(() => assertCoordinationInvariants(parsed));
  });

  void it('rejects unknown fields and incompatible active authority loudly', () => {
    const snapshot = validCoordinationSnapshot();
    assert.throws(
      () => parseCoordinationSnapshot({ ...snapshot, hidden_fallback: true }),
      /unknown fields: hidden_fallback/u,
    );
    assert.throws(
      () => parseCoordinationSnapshot({
        ...snapshot,
        acquisition_groups: snapshot.acquisition_groups.map((group) => group.acquisition_group_id === 'group-b' ? {
          ...group,
          requested_leases: [
            ...group.requested_leases,
            { path: 'src', mode: 'READ', purpose: 'incompatible parent read' },
          ],
        } : group),
      }),
      /internally incompatible authority/u,
    );
    const conflicting = {
      ...snapshot,
      edit_leases: [
        ...snapshot.edit_leases,
        {
          ...snapshot.edit_leases[0],
          edit_lease_id: 'lease-b',
          owner: snapshot.unit_attempts[1]?.owner,
          acquisition_group_id: 'group-b',
        },
      ],
      acquisition_groups: snapshot.acquisition_groups.map((group) => group.acquisition_group_id === 'group-b' ? { ...group, state: 'granted', grant_event_seq: 3 } : group),
    };
    const findings = checkCoordinationInvariants(parseCoordinationSnapshot(jsonRoundTrip(conflicting)));
    assert.equal(findings.some((entry) => entry.code === 'incompatible-active-edit-leases'), true);
  });

  void it('requires typed deferred promises and atomic release notifications', () => {
    const snapshot = validCoordinationSnapshot();
    const incomplete = {
      ...snapshot,
      claim_requests: snapshot.claim_requests.map((request) => ({ ...request, owner_reason: null, release_condition: null })),
    };
    assert.equal(checkCoordinationInvariants(incomplete).some((entry) => entry.code === 'deferred-request-promise-incomplete'), true);

    const released = {
      ...snapshot,
      claim_requests: snapshot.claim_requests.map((request) => ({ ...request, status: 'released' as const, release_event_seq: 3 })),
    };
    assert.equal(checkCoordinationInvariants(released).some((entry) => entry.code === 'release-notification-not-atomic'), true);
  });

  void it('strictly validates versioned query and mutation envelopes', () => {
    const query = parseCoordinatorRequestEnvelope({
      schema_version: 'autopilot.coordinator_request.v1',
      protocol_version: '1.0',
      request_id: 'request-1',
      action: 'status',
      idempotency_key: null,
      repo_id: 'repo-1',
      workstream_run: null,
      session_id: null,
      fencing_generation: null,
      expected_version: null,
      payload: JSON.parse('{}') as unknown,
    });
    assert.equal(query.action, 'status');
    assert.throws(
      () => parseCoordinatorRequestEnvelope({ ...query, action: 'heartbeat', payload: { lease_expires_at: '2026-07-11T16:00:00.000Z' } }),
      /mutating requests require/u,
    );
    assert.throws(
      () => parseCoordinatorRequestEnvelope({ ...query, action: 'unknown-action' }),
      /action must be one of/u,
    );
    assert.equal(parseCoordinatorResponseEnvelope({
      schema_version: 'autopilot.coordinator_response.v1',
      protocol_version: '1.0',
      request_id: 'request-1',
      ok: false,
      committed_event_seq: null,
      error_code: 'fenced-session',
      retryable: false,
      payload: JSON.parse('{}') as unknown,
    }).error_code, 'fenced-session');
  });

  void it('permits operator decisions only for complete planning contradictions', () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    assert.equal(parseCoordinationEscalation({
      schema_version: 'autopilot.planning_contradiction.v1',
      escalation_id: 'contradiction-1',
      repo_id: 'repo-1',
      participating_runs: ['run-a', 'run-b'],
      authoritative_refs: [{ ref: 'mission-a.md', sha256: digest }, { ref: 'mission-b.md', sha256: digest }],
      conflicting_clauses: ['artifact must remain text', 'artifact must become binary'],
      exhausted_alternatives: ['sequencing', 'partitioning', 'ownership-transfer', 'rebase-revalidation', 'replanning'],
      adjudication: { ref: 'adjudication.json', sha256: digest },
      decision_options: ['retain text requirement', 'adopt binary requirement'],
      created_event_seq: 4,
      version: 1,
    }).schema_version, 'autopilot.planning_contradiction.v1');
    assert.throws(
      () => parseCoordinationEscalation({ schema_version: 'autopilot.operational_blocker.v1' }),
      /unknown fields|missing required field/u,
    );
    assert.deepEqual(COORDINATION_FAILURE_TAXONOMY.map((entry) => entry.code), COORDINATION_FAILURE_CODES);
    assert.deepEqual(COORDINATION_FAILURE_TAXONOMY.filter((entry) => entry.operator_decision).map((entry) => entry.code), ['planning-contradiction-review']);
    assert.equal(coordinationFailureDefinition('coordinator-contention').failure_class, 'retryable-contention');
    assert.equal(coordinationFailureDefinition('fenced-session').failure_class, 'fenced-client');
    assert.equal(coordinationFailureDefinition('recovery-required').failure_class, 'owned-recovery');
    assert.equal(coordinationFailureDefinition('planning-contradiction-review').failure_class, 'contradiction-review');
    assert.equal(coordinationFailureDefinition('store-corrupt').failure_class, 'system-fatal');
  });

  void it('locks the duplicate, timeout, stale generation, crash, corruption, disk, permission, and partial Git failure matrix', () => {
    assert.deepEqual(COORDINATION_FAILURE_MATRIX.map((entry) => entry.scenario), [
      'client-timeout-before-response',
      'duplicate-or-delayed-request',
      'stale-session-generation',
      'coordinator-crash-before-commit',
      'coordinator-crash-after-commit',
      'store-integrity-failure',
      'disk-capacity-or-io-failure',
      'filesystem-permission-failure',
      'git-or-filesystem-partial-effect',
    ]);
    assert.equal(COORDINATION_FAILURE_MATRIX.every((entry) => entry.forbidden_response.length > 0 && entry.required_response.length > 0), true);
  });
});
