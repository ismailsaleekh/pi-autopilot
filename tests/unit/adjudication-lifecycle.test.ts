import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseAutopilotState,
  type AutopilotDecisionRow,
  type AutopilotExecutionAudit,
  type AutopilotMasterPlan,
  type AutopilotState,
  type AutopilotStatusEntry,
  type AutopilotVerificationPlan,
  type AutopilotWorkItem,
} from '../../src/core/contracts/index.ts';
import {
  buildAutopilotProtectedPathException,
  buildAutopilotScopeException,
  ratifyAutopilotScopeException,
} from '../../src/core/adjudication/index.ts';
import {
  evaluateAutopilotClosureGate,
  nextAutopilotWorkItemStateAfterTransport,
  nextAutopilotWorkItemStateAfterValidation,
} from '../../src/core/lifecycle/index.ts';

function verificationPlan(): AutopilotVerificationPlan {
  return {
    positive_witnesses: [
      { id: 'validation-command', command: 'npm test', expected_signal: 'tests pass', required: true },
    ],
    negative_witnesses: [],
    regression_witnesses: [],
    real_boundary_witnesses: [],
    blast_radius_checks: [],
    docs_schema_prompt_checks: [],
    dirty_tree_checks: [],
  };
}

function masterPlan(overrides: Partial<AutopilotMasterPlan> = {}): AutopilotMasterPlan {
  return {
    schema_version: 'autopilot.master_plan.v1',
    workstream: 'quality-demo',
    mission_ref: 'mission.md',
    goal_summary: 'Close only after audit and validation.',
    non_goals: ['no live provider calls'],
    definition_of_done: ['closure gate passes'],
    risk_level: 'medium',
    lanes: [{ lane_id: 'lane-1', summary: 'main lane', unit_ids: ['u01-implement', 'u02-validate'] }],
    units: {
      'u01-implement': {
        unit_id: 'u01-implement',
        role: 'implement',
        state: 'completed',
        dependencies: [],
        summary: 'implementation transport complete',
      },
      'u02-validate': {
        unit_id: 'u02-validate',
        role: 'validate',
        state: 'completed',
        dependencies: ['u01-implement'],
        summary: 'independent validation complete',
      },
    },
    ownership_matrix: {
      owned_paths: ['src/owned.ts'],
      read_only_paths: ['README.md'],
      untouchable_paths: ['private/**'],
      held_paths: [],
    },
    verification_matrix: verificationPlan(),
    closure_criteria: ['audit clean or adjudicated', 'validation passed'],
    current_focus: 'quality-demo',
    last_decision_id: 0,
    last_event_id: 0,
    updated_at: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

function decision(overrides: Partial<AutopilotDecisionRow> = {}): AutopilotDecisionRow {
  return {
    schema_version: 'autopilot.decision.v1',
    id: 1,
    ts: '2026-07-02T00:00:00.000Z',
    event: 'scope_exception_ratified',
    workstream: 'quality-demo',
    unit_id: 'u01-implement',
    summary: 'Scope expansion ratified.',
    decision: 'The outside-owned path is correct root-cause expansion and is added to ownership.',
    master_plan_ref: 'master-plan.json',
    ...overrides,
  };
}

function status(role: 'implement' | 'validate' | 'bughunt' = 'validate'): AutopilotStatusEntry {
  return {
    schema_version: 'autopilot.status.v1',
    workstream: 'quality-demo',
    unit_id: role === 'implement' ? 'u01-implement' : role === 'validate' ? 'u02-validate' : 'u03-bughunt',
    role,
    attempt: 1,
    verdict: role === 'implement' ? 'DONE' : 'PASS',
    severity: 'clean',
    summary: `${role} passed`,
    changed_paths: role === 'implement' ? ['src/owned.ts'] : [],
    findings: [],
    commands: role === 'implement' ? [] : [{ command: 'npm test', status: 'passed', exit_code: 0, summary: 'passed' }],
    evidence_refs: [],
    report_ref: null,
    covered_witness_ids: role === 'implement' ? [] : ['validation-command'],
    next_action: 'continue closure',
  };
}

function audit(overrides: Partial<AutopilotExecutionAudit> = {}): AutopilotExecutionAudit {
  return {
    schema_version: 'autopilot.execution_audit.v1',
    workstream: 'quality-demo',
    unit_id: 'u01-implement',
    role: 'implement',
    attempt: 1,
    audited_at: '2026-07-02T00:00:00.000Z',
    cwd: '/tmp/autopilot-quality-demo',
    git_head: null,
    dirty_baseline: false,
    dirty_baseline_paths: [],
    dirty_relevant_paths: [],
    actual_changed_paths: ['src/owned.ts'],
    status_reported_changed_paths: ['src/owned.ts'],
    omitted_status_changes: [],
    reported_but_not_actual_changes: [],
    outside_owned_paths: [],
    read_only_touched_paths: [],
    untouchable_touched_paths: [],
    declared_validation_commands: [],
    status_reported_commands: [],
    command_coverage_gaps: [],
    classification: 'clean',
    evidence_refs: [],
    summary: 'audit clean',
    ...overrides,
  };
}

function state(workItem: AutopilotWorkItem): AutopilotState {
  return {
    schema_version: 'autopilot.state.v1',
    workstream: 'quality-demo',
    updated_at: '2026-07-02T00:00:00.000Z',
    status: 'running',
    context_gate: { gate: 'ok', percent: 10 },
    last_event_id: 0,
    ready_queue: [],
    running: [],
    blocked: [],
    completed: ['u01-implement', 'u02-validate'],
    units: {
      'u01-implement': {
        unit_id: 'u01-implement',
        role: 'implement',
        state: 'completed',
        attempt: 1,
        summary: 'implementation done',
      },
      'u02-validate': {
        unit_id: 'u02-validate',
        role: 'validate',
        state: 'completed',
        attempt: 1,
        summary: 'validation passed',
      },
    },
    operator_questions: [],
    next_actions: [],
    work_items: { [workItem.work_item_id]: workItem },
    audit_review_queue: [],
    validation_ready_queue: [],
    scope_exceptions: [],
    protected_path_exceptions: [],
    closure_gate: { status: 'not-run', blocking_reasons: [], summary: 'not checked' },
  };
}

function closedWorkItem(overrides: Partial<AutopilotWorkItem> = {}): AutopilotWorkItem {
  return {
    work_item_id: 'w01',
    state: 'closed',
    source_changing: true,
    unit_ids: ['u01-implement', 'u02-validate'],
    implementation_unit_id: 'u01-implement',
    validation_unit_id: 'u02-validate',
    audit_ref: 'execution-audits/u01-implement.implement.attempt-1.json',
    status_ref: 'statuses/u01-implement.implement.attempt-1.json',
    validation_status_ref: 'statuses/u02-validate.validate.attempt-1.json',
    summary: 'source change closed after validation',
    ...overrides,
  };
}

void describe('Autopilot adjudication workflow', () => {
  void it('routes outside-owned edits to scope review until ratified in decisions and master plan', () => {
    const scopeAudit = audit({
      actual_changed_paths: ['src/outside.ts'],
      status_reported_changed_paths: ['src/outside.ts'],
      outside_owned_paths: ['src/outside.ts'],
      classification: 'scope-review-required',
      summary: 'scope review required',
    });
    const exception = buildAutopilotScopeException({
      audit: scopeAudit,
      auditRef: 'execution-audits/u01-implement.implement.attempt-1.json',
    });
    assert.equal(exception?.state, 'open');
    assert.deepEqual(exception?.paths, ['src/outside.ts']);

    const beforeGate = evaluateAutopilotClosureGate({
      state: state(closedWorkItem()),
      masterPlan: masterPlan(),
      statuses: [status('implement'), status('validate')],
      audits: [scopeAudit],
      decisions: [],
      checkedAt: '2026-07-02T00:00:00.000Z',
    });
    assert.equal(beforeGate.status, 'failed');
    assert.match(beforeGate.blocking_reasons.join('\n'), /scope review unresolved/u);

    const ratification = decision();
    const amendedPlan = ratifyAutopilotScopeException({
      masterPlan: masterPlan(),
      audit: scopeAudit,
      decision: ratification,
    });
    assert.equal(amendedPlan.ownership_matrix.owned_paths.includes('src/outside.ts'), true);

    const afterGate = evaluateAutopilotClosureGate({
      state: state(closedWorkItem()),
      masterPlan: amendedPlan,
      statuses: [status('implement'), status('validate')],
      audits: [scopeAudit],
      decisions: [ratification],
      checkedAt: '2026-07-02T00:00:00.000Z',
    });
    assert.equal(afterGate.status, 'passed');
  });

  void it('blocks read-only and untouchable writes until protected-path ownership is amended', () => {
    const protectedAudit = audit({
      actual_changed_paths: ['README.md', 'private/secret.txt'],
      status_reported_changed_paths: ['README.md', 'private/secret.txt'],
      outside_owned_paths: ['README.md', 'private/secret.txt'],
      read_only_touched_paths: ['README.md'],
      untouchable_touched_paths: ['private/secret.txt'],
      classification: 'critical-protected-path-violation',
      summary: 'protected review required',
    });
    const exception = buildAutopilotProtectedPathException({
      audit: protectedAudit,
      auditRef: 'execution-audits/u01-implement.implement.attempt-1.json',
    });
    assert.equal(exception?.state, 'open');
    assert.deepEqual(exception?.read_only_paths, ['README.md']);

    const blockedGate = evaluateAutopilotClosureGate({
      state: state(closedWorkItem()),
      masterPlan: masterPlan(),
      statuses: [status('implement'), status('validate')],
      audits: [protectedAudit],
      decisions: [],
      checkedAt: '2026-07-02T00:00:00.000Z',
    });
    assert.equal(blockedGate.status, 'failed');
    assert.match(blockedGate.blocking_reasons.join('\n'), /protected-path review unresolved/u);

    const approval = decision({
      event: 'operator_approval_recorded',
      decision: 'Operator approved protected-path ownership amendment after review.',
    });
    const amendedPlan = masterPlan({
      ownership_matrix: {
        owned_paths: ['src/owned.ts', 'README.md', 'private/secret.txt'],
        read_only_paths: [],
        untouchable_paths: [],
        held_paths: [],
      },
      last_decision_id: 1,
    });
    const resolvedGate = evaluateAutopilotClosureGate({
      state: state(closedWorkItem()),
      masterPlan: amendedPlan,
      statuses: [status('implement'), status('validate')],
      audits: [protectedAudit],
      decisions: [approval],
      checkedAt: '2026-07-02T00:00:00.000Z',
    });
    assert.equal(resolvedGate.status, 'passed');
  });
});

void describe('Autopilot lifecycle and closure gate', () => {
  void it('keeps transport-complete source work open until audit and independent validation close it', () => {
    const item: AutopilotWorkItem = {
      work_item_id: 'w01',
      state: 'transport-complete',
      source_changing: true,
      unit_ids: ['u01-implement', 'u02-validate'],
      implementation_unit_id: 'u01-implement',
      validation_unit_id: 'u02-validate',
      audit_ref: 'execution-audits/u01-implement.implement.attempt-1.json',
      status_ref: 'statuses/u01-implement.implement.attempt-1.json',
      summary: 'source change awaits independent validation',
    };
    assert.equal(nextAutopilotWorkItemStateAfterTransport({ workItem: item, audit: audit() }), 'validation-ready');
    assert.equal(nextAutopilotWorkItemStateAfterValidation({ workItem: item, validationStatus: status('validate') }), 'closed');

    const parsed = parseAutopilotState(state(closedWorkItem()));
    assert.equal(parsed.work_items?.['w01']?.state, 'closed');

    const notClosedGate = evaluateAutopilotClosureGate({
      state: state(item),
      masterPlan: masterPlan(),
      statuses: [status('implement'), status('validate')],
      audits: [audit()],
      decisions: [],
      checkedAt: '2026-07-02T00:00:00.000Z',
    });
    assert.equal(notClosedGate.status, 'failed');
    assert.match(notClosedGate.blocking_reasons.join('\n'), /transport-complete/u);
  });

  void it('requires referenced validation PASS for each source-changing work item', () => {
    const firstItem = closedWorkItem();
    const secondItem = closedWorkItem({
      work_item_id: 'w02',
      unit_ids: ['u04-implement', 'u05-validate'],
      implementation_unit_id: 'u04-implement',
      validation_unit_id: 'u05-validate',
      audit_ref: 'execution-audits/u04-implement.implement.attempt-1.json',
      status_ref: 'statuses/u04-implement.implement.attempt-1.json',
      validation_status_ref: 'statuses/u05-validate.validate.attempt-1.json',
      summary: 'second source change closed after validation',
    });
    const baseState = state(firstItem);
    const twoItemState: AutopilotState = {
      ...baseState,
      completed: [...baseState.completed, 'u04-implement', 'u05-validate'],
      units: {
        ...baseState.units,
        'u04-implement': {
          unit_id: 'u04-implement',
          role: 'implement',
          state: 'completed',
          attempt: 1,
          summary: 'second implementation done',
        },
        'u05-validate': {
          unit_id: 'u05-validate',
          role: 'validate',
          state: 'completed',
          attempt: 1,
          summary: 'second validation passed',
        },
      },
      work_items: { w01: firstItem, w02: secondItem },
    };
    const secondAudit = audit({
      unit_id: 'u04-implement',
      actual_changed_paths: ['src/owned.ts'],
      status_reported_changed_paths: ['src/owned.ts'],
      summary: 'second audit clean',
    });

    const missingSecondValidation = evaluateAutopilotClosureGate({
      state: twoItemState,
      masterPlan: masterPlan(),
      statuses: [status('implement'), status('validate')],
      audits: [audit(), secondAudit],
      decisions: [],
      checkedAt: '2026-07-02T00:00:00.000Z',
    });
    assert.equal(missingSecondValidation.status, 'failed');
    assert.match(missingSecondValidation.blocking_reasons.join('\n'), /w02 lacks referenced validation PASS status/u);

    const secondValidation: AutopilotStatusEntry = {
      ...status('validate'),
      unit_id: 'u05-validate',
      summary: 'second validation passed',
    };
    const wrongRefState: AutopilotState = {
      ...twoItemState,
      work_items: {
        w01: firstItem,
        w02: {
          ...secondItem,
          validation_status_ref: 'statuses/u02-validate.validate.attempt-1.json',
        },
      },
    };
    const wrongRefGate = evaluateAutopilotClosureGate({
      state: wrongRefState,
      masterPlan: masterPlan(),
      statuses: [status('implement'), status('validate'), secondValidation],
      audits: [audit(), secondAudit],
      decisions: [],
      checkedAt: '2026-07-02T00:00:00.000Z',
    });
    assert.equal(wrongRefGate.status, 'failed');
    assert.match(wrongRefGate.blocking_reasons.join('\n'), /validation_status_ref/u);

    const passedGate = evaluateAutopilotClosureGate({
      state: twoItemState,
      masterPlan: masterPlan(),
      statuses: [status('implement'), status('validate'), secondValidation],
      audits: [audit(), secondAudit],
      decisions: [],
      checkedAt: '2026-07-02T00:00:00.000Z',
    });
    assert.equal(passedGate.status, 'passed');
  });

  void it('requires final bughunt PASS for high-risk closure', () => {
    const highRiskPlan = masterPlan({ risk_level: 'high' });
    const blockedGate = evaluateAutopilotClosureGate({
      state: state(closedWorkItem()),
      masterPlan: highRiskPlan,
      statuses: [status('implement'), status('validate')],
      audits: [audit()],
      decisions: [],
      checkedAt: '2026-07-02T00:00:00.000Z',
    });
    assert.equal(blockedGate.status, 'failed');
    assert.match(blockedGate.blocking_reasons.join('\n'), /bughunt PASS/u);

    const passedGate = evaluateAutopilotClosureGate({
      state: state(closedWorkItem()),
      masterPlan: highRiskPlan,
      statuses: [status('implement'), status('validate'), status('bughunt')],
      audits: [audit()],
      decisions: [],
      checkedAt: '2026-07-02T00:00:00.000Z',
    });
    assert.equal(passedGate.status, 'passed');
  });
});
