import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseAutopilotMasterPlan,
  parseAutopilotState,
  parseAutopilotStatusEntry,
  type AutopilotMasterPlan,
  type AutopilotState,
  type AutopilotStatusEntry,
} from '../../src/core/contracts/index.ts';
import {
  assertD65ProjectionMembersClosed,
  d65GraphProjectionIdentity,
  normalizeD65NonCoordinatorProjections,
  parseD65ClosureProjection,
  parseD65WorkItemProjection,
} from '../../src/core/coordination/d65-graph-projections.ts';

function masterPlan(): AutopilotMasterPlan {
  return parseAutopilotMasterPlan({
    schema_version: 'autopilot.master_plan.v1', workstream: 'projection-test', mission_ref: 'mission.md',
    goal_summary: 'Prove exact graph projections.', non_goals: [], definition_of_done: ['done'], risk_level: 'low',
    lanes: [{ lane_id: 'main', summary: 'main', unit_ids: ['bug-1'] }],
    units: { 'bug-1': { unit_id: 'bug-1', role: 'bughunt', state: 'completed', dependencies: [], summary: 'hunt' } },
    ownership_matrix: { owned_paths: [], read_only_paths: [], untouchable_paths: [], held_paths: [] },
    verification_matrix: { positive_witnesses: [], negative_witnesses: [], regression_witnesses: [], real_boundary_witnesses: [], blast_radius_checks: [], docs_schema_prompt_checks: [], dirty_tree_checks: [] },
    closure_criteria: ['clean bughunt'], current_focus: 'close', last_decision_id: 0, last_event_id: 0,
    updated_at: '2026-07-22T00:00:00.000Z',
  });
}

function state(overrides: Readonly<Record<string, unknown>> = {}): AutopilotState {
  return parseAutopilotState({
    schema_version: 'autopilot.state.v1', workstream: 'projection-test', updated_at: '2026-07-22T00:00:00.000Z',
    status: 'completed', context_gate: { gate: 'ok', percent: 100 }, last_event_id: 0,
    ready_queue: [], running: [], blocked: [], completed: ['bug-1'],
    units: { 'bug-1': { unit_id: 'bug-1', role: 'bughunt', state: 'completed', attempt: 2, status_ref: 'statuses/bug-1.bughunt.attempt-2.json', summary: 'clean' } },
    operator_questions: [], next_actions: [],
    work_items: { 'work-1': { work_item_id: 'work-1', state: 'closed', source_changing: false, unit_ids: ['bug-1'], summary: 'closed' } },
    audit_review_queue: [], validation_ready_queue: [], scope_exceptions: [], protected_path_exceptions: [],
    closure_gate: { status: 'passed', checked_at: '2026-07-22T00:00:00.000Z', blocking_reasons: [], bughunt_status_ref: 'statuses/bug-1.bughunt.attempt-2.json', summary: 'passed' },
    ...overrides,
  });
}

function bughuntStatus(role: 'bughunt' | 'validate' = 'bughunt'): AutopilotStatusEntry {
  return parseAutopilotStatusEntry({
    schema_version: 'autopilot.status.v1', workstream: 'projection-test', unit_id: 'bug-1', role, attempt: 2,
    verdict: 'PASS', severity: 'clean', summary: 'clean', changed_paths: [], findings: [], commands: [],
    evidence_refs: [], report_ref: null, next_action: 'none',
  });
}

describe('D65 non-coordinator graph projections', () => {
  it('normalizes explicit nulls and binds every projection identity', () => {
    const normalized = normalizeD65NonCoordinatorProjections(masterPlan(), state(), [
      { runtime_ref: 'statuses/bug-1.bughunt.attempt-2.json', status: bughuntStatus() },
    ]);
    assert.equal(normalized.work_items.length, 1);
    assert.deepEqual(normalized.work_items[0]?.value, {
      work_item_id: 'work-1', state: 'closed', source_changing: false, unit_ids: ['bug-1'],
      implementation_unit_id: null, validation_unit_id: null, audit_ref: null, status_ref: null,
      validation_status_ref: null, summary: 'closed',
    });
    assert.equal(normalized.work_items[0]?.identity, d65GraphProjectionIdentity('work-item', 'work-1'));
    assert.equal(normalized.bughunt[0]?.identity, d65GraphProjectionIdentity('bughunt', 'bug-1\u00002'));
    assert.equal(normalized.bughunt[0]?.value['covered_witness_ids'], null);
    assert.deepEqual(normalized.closure, {
      status: 'passed', checked_at: '2026-07-22T00:00:00.000Z', blocking_reasons: [],
      bughunt_status_ref: 'statuses/bug-1.bughunt.attempt-2.json', decision_ref: null, summary: 'passed',
    });
    assertD65ProjectionMembersClosed('work_items', normalized.work_items);
    assertD65ProjectionMembersClosed('bughunt', normalized.bughunt);
  });

  it('rejects a state/master-plan unit-set mismatch before producing members', () => {
    const mismatched = state({
      units: {
        'bug-1': { unit_id: 'bug-1', role: 'bughunt', state: 'completed', attempt: 2, summary: 'clean' },
        extra: { unit_id: 'extra', role: 'validate', state: 'queued', attempt: 1, summary: 'extra' },
      },
      completed: ['bug-1'],
    });
    assert.throws(
      () => normalizeD65NonCoordinatorProjections(masterPlan(), mismatched, []),
      /state unit set does not exactly equal the master-plan unit set/u,
    );
  });

  it('rejects a closure bughunt ref that does not resolve to exactly one bughunt status', () => {
    assert.throws(
      () => normalizeD65NonCoordinatorProjections(masterPlan(), state(), [
        { runtime_ref: 'statuses/bug-1.bughunt.attempt-2.json', status: bughuntStatus('validate') },
      ]),
      /closure bughunt_status_ref does not resolve to exactly one discovered bughunt status/u,
    );
  });

  it('rejects projection-only optional-field omission and forged identities at the lowest layer', () => {
    assert.throws(
      () => parseD65WorkItemProjection({ work_item_id: 'work-1', state: 'closed', source_changing: false, unit_ids: [], summary: 'missing null fields' }),
      /missing required fields/u,
    );
    const value = parseD65WorkItemProjection({ work_item_id: 'work-1', state: 'closed', source_changing: false, unit_ids: [], implementation_unit_id: null, validation_unit_id: null, audit_ref: null, status_ref: null, validation_status_ref: null, summary: 'closed' });
    assert.throws(
      () => assertD65ProjectionMembersClosed('work_items', [{ identity: d65GraphProjectionIdentity('work-item', 'other'), kind: 'work_items', value }]),
      /identity does not bind its complete natural identity/u,
    );
  });

  it('parses closure as one exact projection-only shape', () => {
    assert.equal(parseD65ClosureProjection(null), null);
    assert.throws(
      () => parseD65ClosureProjection({ status: 'passed', checked_at: null, blocking_reasons: [], bughunt_status_ref: null, decision_ref: null, summary: 'ok', extra: true }),
      /contains unknown fields/u,
    );
  });
});
