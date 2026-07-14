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
  parseAutopilotChildTerminalAcceptance,
  parseCoordinationEscalation,
  parseCoordinationMigrationRecoveryWork,
  parseCoordinationReservationObligation,
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
      'adjudication_assignment',
      'authoritative_artifact',
      'change_reservation',
      'child_lease',
      'child_terminal_acceptance',
      'claim_request',
      'contradiction_adjudication',
      'coordinator_request',
      'coordinator_response',
      'cutover_marker',
      'deadlock_resolution',
      'edit_lease',
      'escalation',
      'event',
      'integration_conflict',
      'mailbox_cursor',
      'message',
      'migration_record',
      'migration_recovery_work',
      'observation',
      'reconciliation_evidence',
      'repository',
      'reservation_obligation',
      'run',
      'run_resource',
      'run_terminal_intent',
      'session_lease',
      'snapshot',
      'unit_attempt',
      'wait_for_edge',
      'worktree',
      'worktree_operation',
    ]);
    for (const schema of Object.values(AUTOPILOT_COORDINATION_JSON_SCHEMAS)) {
      assert.equal(schema['type'], 'object');
      assert.equal(schema['additionalProperties'], false);
    }
  });

  void it('normalizes pre-classifier reservation obligations before exposing the required current schema', () => {
    const legacy = parseCoordinationReservationObligation({
      schema_version: 'autopilot.reservation_obligation.v1', obligation_id: 'legacy-obligation', repo_id: 'repo-1', workstream_run: 'run-b', reservation_id: 'reservation-b', predecessor_reservation_id: 'reservation-a', overlapping_paths: ['src/shared.ts'], state: 'waiting-for-predecessor', created_event_seq: 4, predecessor_released_event_seq: null, predecessor_terminal_sha: null, integration_evidence: null, validation_evidence: null, resolved_event_seq: null, version: 1,
    });
    assert.equal(legacy.integration_conflict.kind, 'legacy-conservative');
    assert.equal(legacy.integration_conflict.disposition, 'repair-required');
    const required = AUTOPILOT_COORDINATION_JSON_SCHEMAS.reservation_obligation['required'];
    assert.equal(Array.isArray(required) && required.includes('integration_conflict'), true, 'wire/status output requires the normalized classification even though the parser accepts old stored payloads');
  });

  void it('strictly parses parent-owned child-terminal acceptance evidence', () => {
    const digest = `sha256:${'a'.repeat(64)}` as const;
    const acceptance = {
      schema_version: 'autopilot.child_terminal_acceptance.v1', repo_id: 'repo-1', autopilot_id: 'auto-1', workstream: 'work-1', workstream_run: 'run-1',
      unit_id: 'unit-1', role: 'validate', attempt: 2, child_lease_id: 'child-run-1-unit-1-2', verdict: 'NEEDS_FIX', transport_result: 'accepted',
      spec: { ref: 'unit-specs/unit-1.validate.attempt-2.json', sha256: digest }, status: { ref: 'statuses/unit-1.validate.attempt-2.json', sha256: digest },
      receipt: { ref: 'receipts/unit-1.validate.attempt-2.receipt.json', sha256: digest }, audit: { ref: 'execution-audits/unit-1.validate.attempt-2.json', sha256: digest },
      tool_call_id: 'call-1', carrier_status_sha256: digest, audit_disposition: 'zero-change', created_at: '2026-07-14T00:00:00.000Z',
    } as const;
    assert.deepEqual(parseAutopilotChildTerminalAcceptance(jsonRoundTrip(acceptance)), acceptance);
    assert.throws(() => parseAutopilotChildTerminalAcceptance({ ...acceptance, hidden_fallback: true }), /fields are not exact/u);
    assert.throws(() => parseAutopilotChildTerminalAcceptance({ ...acceptance, carrier_status_sha256: `sha256:${'B'.repeat(64)}` }), /carrier_status_sha256 is invalid/u);
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
    assert.doesNotThrow(() => parseCoordinationSnapshot({
      ...snapshot,
      acquisition_groups: snapshot.acquisition_groups.map((group) => group.acquisition_group_id === 'group-b' ? {
        ...group,
        requested_leases: [
          ...group.requested_leases,
          { path: 'src', mode: 'READ', purpose: 'non-blocking parent observation', source_identity: { base_commit: 'a'.repeat(40), object_id: 'b'.repeat(40), object_kind: 'tree' } },
        ],
      } : group),
    }));
    const conflicting = {
      ...snapshot,
      edit_leases: [
        ...snapshot.edit_leases,
        {
          ...snapshot.edit_leases[0],
          edit_lease_id: 'lease-b',
          owner: snapshot.unit_attempts[1]?.owner,
          acquisition_group_id: 'group-b',
          mode: 'EXCLUSIVE' as const,
        },
      ],
      acquisition_groups: snapshot.acquisition_groups.map((group) => group.acquisition_group_id === 'group-b' ? { ...group, state: 'granted', grant_event_seq: 3, requested_leases: group.requested_leases.map((lease) => ({ ...lease, mode: 'EXCLUSIVE' as const })) } : group),
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

    const requesterNotifiedBeforeOtherOwnersRelease = {
      ...snapshot,
      claim_requests: snapshot.claim_requests.map((request) => ({ ...request, status: 'requester-notified' as const, release_event_seq: 3, grant_event_seq: null })),
      messages: [{
        schema_version: 'autopilot.coordination_message.v1' as const, message_id: 'release-message-before-grant', repo_id: 'repo-1', recipient_workstream_run: 'run-b',
        message_type: 'release-notification' as const, correlation_id: 'request-b-a', payload: { request_id: 'request-b-a' }, status: 'acknowledged' as const,
        created_event_seq: 3, delivered_event_seq: 3, acknowledged_event_seq: 3, version: 2,
      }],
    };
    assert.equal(checkCoordinationInvariants(requesterNotifiedBeforeOtherOwnersRelease).some((entry) => entry.code === 'granted-request-event-missing'), false);
  });

  void it('enforces the typed migration recovery lifecycle and closed resolution contract', () => {
    const pending = parseCoordinationMigrationRecoveryWork({
      schema_version: 'autopilot.migration_recovery_work.v2', recovery_id: 'recovery-1', repo_id: 'repo-1', workstream_run: 'run-a', recovery_type: 'ambiguous-live-claim',
      detail: { claim_path: 'src/owned.ts', claim_mode: 'WRITE', unit_id: 'unit-a', attempt: 1, edit_lease_id: 'lease-a' }, status: 'pending', resolution: null,
      created_event_seq: 3, resolved_event_seq: null, version: 1,
    });
    assert.equal(pending.status, 'pending');
    assert.throws(() => parseCoordinationMigrationRecoveryWork({ ...pending, status: 'resolved' }), /requires resolution evidence/u);
    assert.throws(() => parseCoordinationMigrationRecoveryWork({ ...pending, resolution: { resolution_type: 'authority-retained', evidence: { ref: 'recovery.json', sha256: `sha256:${'a'.repeat(64)}` }, release_source: 'unit-merge', release_target_id: 'unit-a:1', exact_postconditions: ['lease retained'] } }), /cannot carry a release source/u);
    const resolved = parseCoordinationMigrationRecoveryWork({ ...pending, status: 'resolved', resolution: { resolution_type: 'authority-released', evidence: { ref: 'recovery.json', sha256: `sha256:${'a'.repeat(64)}` }, release_source: 'attempt-reset', release_target_id: 'unit-a:1', exact_postconditions: ['worktree absent'] }, resolved_event_seq: 4, version: 2 });
    assert.equal(resolved.resolution?.resolution_type, 'authority-released');
  });

  void it('strictly validates versioned query and mutation envelopes', () => {
    const query = parseCoordinatorRequestEnvelope({
      schema_version: 'autopilot.coordinator_request.v1',
      protocol_version: '1.4',
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
    assert.throws(() => parseCoordinatorRequestEnvelope({ ...query, protocol_version: '1.2' }), /protocol_version must equal 1.4/u);
    assert.throws(
      () => parseCoordinatorRequestEnvelope({ ...query, action: 'heartbeat', payload: { lease_expires_at: '2026-07-11T16:00:00.000Z' } }),
      /mutating requests require/u,
    );
    assert.throws(
      () => parseCoordinatorRequestEnvelope({ ...query, action: 'unknown-action' }),
      /action must be one of/u,
    );
    assert.throws(() => parseCoordinatorRequestEnvelope({ ...query, repo_id: 'repo/../foreign' }), /filesystem-safe identifier segment/u);
    const mutation = {
      ...query,
      idempotency_key: 'claim-mutation-1',
      workstream_run: 'run-a',
      session_id: 'session-a',
      fencing_generation: 1,
      expected_version: 1,
    };
    assert.throws(() => parseCoordinatorRequestEnvelope({ ...mutation, workstream_run: 'run-a/../run-b', action: 'heartbeat', payload: { lease_expires_at: '2026-07-11T16:00:00.000Z', session_lease_id: 'lease-session-a', session_token: 'a'.repeat(64) } }), /filesystem-safe identifier segment/u);
    const sessionProof = { session_lease_id: 'lease-session-a', session_token: 'a'.repeat(64) };
    const recoveryResolution = parseCoordinatorRequestEnvelope({
      ...mutation,
      action: 'resolve-migration-recovery',
      payload: { recovery_id: 'recovery-1', resolution_type: 'authority-retained', evidence_ref: 'retention.json', evidence_sha256: `sha256:${'b'.repeat(64)}`, release_source: null, release_target_id: null, migration_operation_token: 'c'.repeat(48), ...sessionProof },
    });
    assert.equal(recoveryResolution.action, 'resolve-migration-recovery');
    assert.throws(() => parseCoordinatorRequestEnvelope({ ...recoveryResolution, payload: { ...recoveryResolution.payload, release_source: 'unit-merge', release_target_id: 'unit-a:1' } }), /cannot carry release_source/u);
    const acquisition = parseCoordinatorRequestEnvelope({
      ...mutation,
      action: 'acquire-group',
      payload: {
        acquisition_group_id: 'group-new', acquisition_kind: 'initial', unit_id: 'unit-new', attempt: 1,
        requested_leases: [{ path: 'src/new.ts', mode: 'WRITE', purpose: 'implement new source' }],
        reason: 'unit needs complete initial authority', normal_release_condition: { condition_type: 'unit-merged', target_id: 'unit-new:1', evidence: null },
        spec_ref: '.pi/autopilot/demo/unit-specs/unit-new.json', spec_sha256: `sha256:${'a'.repeat(64)}`,
        role: 'implement', preemptible: true, checkpoint_ordinal: 0, ...sessionProof,
      },
    });
    assert.equal(acquisition.action, 'acquire-group');
    assert.throws(() => parseCoordinatorRequestEnvelope({
      ...mutation, action: 'respond-claim-request',
      payload: { request_id: 'claim-request-1', response: 'deferred', owner_reason: 'still needed', release_condition: null, ...sessionProof },
    }), /deferred response requires/u);
    assert.throws(() => parseCoordinatorRequestEnvelope({
      ...mutation, action: 'respond-claim-request',
      payload: { request_id: 'claim-request-1', response: 'release-now', owner_reason: 'free', release_condition: { condition_type: 'unit-merged', target_id: 'unit-new:1', evidence: null }, ...sessionProof },
    }), /must not invent/u);
    assert.throws(() => parseCoordinatorRequestEnvelope({
      ...mutation, action: 'supersede-attempt',
      payload: { unit_id: 'unit-new', attempt: 1, superseded_by_attempt: 1, reason: 'invalid self supersession', ...sessionProof },
    }), /must differ/u);
    assert.equal(parseCoordinatorResponseEnvelope({
      schema_version: 'autopilot.coordinator_response.v1',
      protocol_version: '1.4',
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
      conflicting_clauses: [
        { authoritative_ref: { ref: 'mission-a.md', sha256: digest }, source_type: 'mission', source_scope: 'repository', source_run: 'run-a', schema_version: 'autopilot.mission.v1', clause_id: 'mission-a-output', exact_requirement: 'artifact must remain text', artifact_or_invariant: 'artifact format', demanded_outcome: 'text' },
        { authoritative_ref: { ref: 'mission-b.md', sha256: digest }, source_type: 'mission', source_scope: 'repository', source_run: 'run-b', schema_version: 'autopilot.mission.v1', clause_id: 'mission-b-output', exact_requirement: 'artifact must become binary', artifact_or_invariant: 'artifact format', demanded_outcome: 'binary' },
      ],
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
