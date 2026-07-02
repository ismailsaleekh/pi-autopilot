import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

import {
  AUTOPILOT_JSON_SCHEMAS,
  AUTOPILOT_STATUS_ENTRY_JSON_SCHEMA,
  type JsonMap,
} from './schemas.ts';
import {
  AUTOPILOT_AUDIT_CLASSIFICATION_VALUES,
  AUTOPILOT_CLOSURE_GATE_STATUS_VALUES,
  AUTOPILOT_COMMAND_STATUS_VALUES,
  AUTOPILOT_CONTEXT_GATE_VALUES,
  AUTOPILOT_DECISION_EVENT_VALUES,
  AUTOPILOT_EVENT_TYPE_VALUES,
  AUTOPILOT_EXCEPTION_STATE_VALUES,
  AUTOPILOT_HANDOFF_REASON_VALUES,
  AUTOPILOT_QUALITY_PROFILE_VALUES,
  AUTOPILOT_RISK_LEVEL_VALUES,
  AUTOPILOT_ROLE_VALUES,
  AUTOPILOT_SEVERITY_VALUES,
  AUTOPILOT_TEMPLATE_VALUES,
  AUTOPILOT_THINKING_VALUES,
  AUTOPILOT_UNIT_STATE_VALUES,
  AUTOPILOT_VERDICT_VALUES,
  AUTOPILOT_WORK_ITEM_STATE_VALUES,
  AUTOPILOT_WORKSTREAM_STATUS_VALUES,
  type AutopilotDecisionRow,
  type AutopilotEventRow,
  type AutopilotEvidenceRef,
  type AutopilotExecutionAudit,
  type AutopilotHandoff,
  type AutopilotMasterPlan,
  type AutopilotReceipt,
  type AutopilotRole,
  type AutopilotState,
  type AutopilotStatusEntry,
  type AutopilotUnitSpec,
  type AutopilotVerdict,
  type AutopilotWitnessSpec,
} from './types.ts';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const WORKSTREAM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u;
const NOT_CHAR = '!';
const NEGATIVE_LOOKAHEAD = `(?${NOT_CHAR}`;
const MODEL = new RegExp(
  `^${NEGATIVE_LOOKAHEAD}openrouter/)${NEGATIVE_LOOKAHEAD}.*\\s)[A-Za-z0-9._/-]{3,120}$`,
  'u',
);

type JsonRecord = Readonly<Record<string, unknown>>;
type ValueCheck = (value: unknown, label: string, issues: string[]) => void;

export class AutopilotContractValidationError extends Error {
  public readonly issues: readonly string[];

  constructor(label: string, issues: readonly string[]) {
    super(`${label} failed Autopilot contract validation: ${issues.join('; ')}`);
    this.name = 'AutopilotContractValidationError';
    this.issues = issues;
  }
}

export interface AutopilotValidationOptions {
  readonly artifactRoot?: string;
  readonly unitSpec?: AutopilotUnitSpec;
  readonly statusOutputPath?: string;
  readonly executionAudit?: AutopilotExecutionAudit;
}

export function getAutopilotJsonSchema(name: keyof typeof AUTOPILOT_JSON_SCHEMAS): JsonMap {
  return AUTOPILOT_JSON_SCHEMAS[name];
}

export function autopilotSchemaSha256(name: keyof typeof AUTOPILOT_JSON_SCHEMAS): `sha256:${string}` {
  return sha256String(stableJsonStringify(AUTOPILOT_JSON_SCHEMAS[name]));
}

export function parseAutopilotUnitSpec(value: unknown): AutopilotUnitSpec {
  assertUnitSpecShape(value);
  const spec = value as AutopilotUnitSpec;
  throwIfIssues('AutopilotUnitSpec', semanticUnitSpecIssues(spec));
  return spec;
}

export function parseAutopilotStatusEntry(
  value: unknown,
  options: AutopilotValidationOptions = {},
): AutopilotStatusEntry {
  assertStatusShape(value);
  const status = value as AutopilotStatusEntry;
  throwIfIssues('AutopilotStatusEntry', semanticStatusEntryIssues(status, options));
  return status;
}

export function parseAutopilotEventRow(value: unknown): AutopilotEventRow {
  assertEventShape(value);
  const event = value as AutopilotEventRow;
  throwIfIssues('AutopilotEventRow', semanticEventRowIssues(event));
  return event;
}

export function parseAutopilotState(value: unknown): AutopilotState {
  assertStateShape(value);
  const state = value as AutopilotState;
  throwIfIssues('AutopilotState', semanticStateIssues(state));
  return state;
}

export function parseAutopilotReceipt(
  value: unknown,
  options: AutopilotValidationOptions = {},
): AutopilotReceipt {
  assertReceiptShape(value);
  const receipt = value as AutopilotReceipt;
  throwIfIssues('AutopilotReceipt', semanticReceiptIssues(receipt, options));
  return receipt;
}

export function parseAutopilotHandoff(value: unknown): AutopilotHandoff {
  assertHandoffShape(value);
  const handoff = value as AutopilotHandoff;
  throwIfIssues('AutopilotHandoff', semanticHandoffIssues(handoff));
  return handoff;
}

export function parseAutopilotMasterPlan(value: unknown): AutopilotMasterPlan {
  assertMasterPlanShape(value);
  const masterPlan = value as AutopilotMasterPlan;
  throwIfIssues('AutopilotMasterPlan', semanticMasterPlanIssues(masterPlan));
  return masterPlan;
}

export function parseAutopilotDecisionRow(value: unknown): AutopilotDecisionRow {
  assertDecisionRowShape(value);
  const decision = value as AutopilotDecisionRow;
  throwIfIssues('AutopilotDecisionRow', semanticDecisionRowIssues(decision));
  return decision;
}

export function parseAutopilotExecutionAudit(value: unknown): AutopilotExecutionAudit {
  assertExecutionAuditShape(value);
  const audit = value as AutopilotExecutionAudit;
  throwIfIssues('AutopilotExecutionAudit', semanticExecutionAuditIssues(audit));
  return audit;
}

export function assertAutopilotStatusJsonSchemaCompiles(): void {
  stableJsonStringify(AUTOPILOT_STATUS_ENTRY_JSON_SCHEMA);
}

function assertUnitSpecShape(value: unknown): void {
  const issues: string[] = [];
  const record = requireRecord(value, 'AutopilotUnitSpec', issues);
  if (record !== undefined) {
    checkKnownKeys(record, unitSpecKeys, 'AutopilotUnitSpec', issues);
    checkRequired(record, unitSpecRequired, 'AutopilotUnitSpec', issues);
    expectConst(record['schema_version'], 'autopilot.unit_spec.v1', '/schema_version', issues);
    expectString(record['workstream'], '/workstream', issues, { pattern: WORKSTREAM, max: 128 });
    expectString(record['unit_id'], '/unit_id', issues, { pattern: UNIT_ID, max: 128 });
    expectEnum(record['role'], AUTOPILOT_ROLE_VALUES, '/role', issues);
    expectEnum(record['template'], AUTOPILOT_TEMPLATE_VALUES, '/template', issues);
    expectInteger(record['attempt'], '/attempt', issues, 1, 999);
    expectString(record['objective'], '/objective', issues, { max: 1200 });
    expectString(record['cwd'], '/cwd', issues, { max: 1024 });
    expectString(record['model'], '/model', issues, { pattern: MODEL, min: 3, max: 120 });
    expectEnum(record['thinking'], AUTOPILOT_THINKING_VALUES, '/thinking', issues);
    expectStringArray(record['owned_paths'], '/owned_paths', issues, 120);
    expectStringArray(record['read_only_paths'], '/read_only_paths', issues, 200);
    expectStringArray(record['untouchable_paths'], '/untouchable_paths', issues, 200);
    expectArray(record['context_refs'], '/context_refs', issues, 80, 0, checkContextRef);
    expectStringArray(record['validation_commands'], '/validation_commands', issues, 40, 0, 800);
    expectString(record['status_output'], '/status_output', issues, { max: 1024 });
    expectString(record['receipt_output'], '/receipt_output', issues, { max: 1024 });
    expectString(record['evidence_dir'], '/evidence_dir', issues, { max: 1024 });
    expectString(record['stop_boundary'], '/stop_boundary', issues, { max: 1200 });
    optionalEnum(record, 'quality_profile', AUTOPILOT_QUALITY_PROFILE_VALUES, '/quality_profile', issues);
    optionalEnum(record, 'risk_level', AUTOPILOT_RISK_LEVEL_VALUES, '/risk_level', issues);
    if (hasKey(record, 'acceptance_criteria')) {
      expectStringArray(record['acceptance_criteria'], '/acceptance_criteria', issues, 80, 0, 500);
    }
    if (hasKey(record, 'verification_plan')) {
      checkVerificationPlan(record['verification_plan'], '/verification_plan', issues);
    }
    if (hasKey(record, 'closure_criteria')) {
      expectStringArray(record['closure_criteria'], '/closure_criteria', issues, 80, 0, 500);
    }
    if (hasKey(record, 'upstream_refs')) {
      expectArray(record['upstream_refs'], '/upstream_refs', issues, 80, 0, checkUpstreamRef);
    }
    if (hasKey(record, 'timeout_seconds')) {
      expectInteger(record['timeout_seconds'], '/timeout_seconds', issues, 60, 86_400);
    }
    if (hasKey(record, 'render_prompt_snapshot')) {
      expectBoolean(record['render_prompt_snapshot'], '/render_prompt_snapshot', issues);
    }
  }
  throwIfIssues('AutopilotUnitSpec', issues);
}

function assertStatusShape(value: unknown): void {
  const issues: string[] = [];
  const record = requireRecord(value, 'AutopilotStatusEntry', issues);
  if (record !== undefined) {
    checkKnownKeys(record, statusKeys, 'AutopilotStatusEntry', issues);
    checkRequired(record, statusRequired, 'AutopilotStatusEntry', issues);
    expectConst(record['schema_version'], 'autopilot.status.v1', '/schema_version', issues);
    expectString(record['workstream'], '/workstream', issues, { pattern: WORKSTREAM, max: 128 });
    expectString(record['unit_id'], '/unit_id', issues, { pattern: UNIT_ID, max: 128 });
    expectEnum(record['role'], AUTOPILOT_ROLE_VALUES, '/role', issues);
    expectInteger(record['attempt'], '/attempt', issues, 1, 999);
    expectEnum(record['verdict'], AUTOPILOT_VERDICT_VALUES, '/verdict', issues);
    expectEnum(record['severity'], AUTOPILOT_SEVERITY_VALUES, '/severity', issues);
    expectString(record['summary'], '/summary', issues, { max: 360 });
    expectStringArray(record['changed_paths'], '/changed_paths', issues, 120);
    expectArray(record['findings'], '/findings', issues, 80, 0, checkFinding);
    expectArray(record['commands'], '/commands', issues, 80, 0, checkCommandSummary);
    expectArray(record['evidence_refs'], '/evidence_refs', issues, 80, 0, checkEvidenceRef);
    if (record['report_ref'] !== null) checkEvidenceRef(record['report_ref'], '/report_ref', issues);
    if (hasKey(record, 'covered_witness_ids')) {
      expectStringArray(record['covered_witness_ids'], '/covered_witness_ids', issues, 200, 0, 96, FINDING_ID);
    }
    expectString(record['next_action'], '/next_action', issues, { max: 360 });
  }
  throwIfIssues('AutopilotStatusEntry', issues);
}

function assertEventShape(value: unknown): void {
  const issues: string[] = [];
  const record = requireRecord(value, 'AutopilotEventRow', issues);
  if (record !== undefined) {
    checkKnownKeys(record, eventKeys, 'AutopilotEventRow', issues);
    checkRequired(record, eventRequired, 'AutopilotEventRow', issues);
    expectConst(record['schema_version'], 'autopilot.event.v1', '/schema_version', issues);
    expectInteger(record['id'], '/id', issues, 1, 9_000_000_000_000_000);
    expectString(record['ts'], '/ts', issues, { pattern: ISO_TIMESTAMP });
    expectEnum(record['event'], AUTOPILOT_EVENT_TYPE_VALUES, '/event', issues);
    expectString(record['workstream'], '/workstream', issues, { pattern: WORKSTREAM, max: 128 });
    optionalString(record, 'unit_id', '/unit_id', issues, { pattern: UNIT_ID, max: 128 });
    optionalEnum(record, 'role', AUTOPILOT_ROLE_VALUES, '/role', issues);
    optionalEnum(record, 'verdict', AUTOPILOT_VERDICT_VALUES, '/verdict', issues);
    optionalEnum(record, 'severity', AUTOPILOT_SEVERITY_VALUES, '/severity', issues);
    optionalString(record, 'spec_ref', '/spec_ref', issues, { max: 512 });
    optionalString(record, 'status_ref', '/status_ref', issues, { max: 512 });
    optionalString(record, 'receipt_ref', '/receipt_ref', issues, { max: 512 });
    optionalString(record, 'evidence_ref', '/evidence_ref', issues, { max: 512 });
    expectString(record['summary'], '/summary', issues, { max: 360 });
  }
  throwIfIssues('AutopilotEventRow', issues);
}

function assertStateShape(value: unknown): void {
  const issues: string[] = [];
  const record = requireRecord(value, 'AutopilotState', issues);
  if (record !== undefined) {
    checkKnownKeys(record, stateKeys, 'AutopilotState', issues);
    checkRequired(record, stateRequired, 'AutopilotState', issues);
    expectConst(record['schema_version'], 'autopilot.state.v1', '/schema_version', issues);
    expectString(record['workstream'], '/workstream', issues, { pattern: WORKSTREAM, max: 128 });
    expectString(record['updated_at'], '/updated_at', issues, { pattern: ISO_TIMESTAMP });
    expectEnum(record['status'], AUTOPILOT_WORKSTREAM_STATUS_VALUES, '/status', issues);
    checkContextGate(record['context_gate'], '/context_gate', issues);
    expectInteger(record['last_event_id'], '/last_event_id', issues, 0, 9_000_000_000_000_000);
    expectStringArray(record['ready_queue'], '/ready_queue', issues, 500, 0, 128, UNIT_ID);
    expectStringArray(record['running'], '/running', issues, 500, 0, 128, UNIT_ID);
    expectStringArray(record['blocked'], '/blocked', issues, 500, 0, 128, UNIT_ID);
    expectStringArray(record['completed'], '/completed', issues, 500, 0, 128, UNIT_ID);
    checkUnits(record['units'], '/units', issues);
    expectStringArray(record['operator_questions'], '/operator_questions', issues, 80, 0, 500);
    expectStringArray(record['next_actions'], '/next_actions', issues, 80, 0, 500);
    if (hasKey(record, 'work_items')) checkWorkItems(record['work_items'], '/work_items', issues);
    if (hasKey(record, 'audit_review_queue')) {
      expectStringArray(record['audit_review_queue'], '/audit_review_queue', issues, 500, 0, 128, UNIT_ID);
    }
    if (hasKey(record, 'validation_ready_queue')) {
      expectStringArray(record['validation_ready_queue'], '/validation_ready_queue', issues, 500, 0, 128, UNIT_ID);
    }
    if (hasKey(record, 'scope_exceptions')) {
      expectArray(record['scope_exceptions'], '/scope_exceptions', issues, 500, 0, checkScopeException);
    }
    if (hasKey(record, 'protected_path_exceptions')) {
      expectArray(record['protected_path_exceptions'], '/protected_path_exceptions', issues, 500, 0, checkProtectedPathException);
    }
    if (hasKey(record, 'closure_gate')) checkClosureGate(record['closure_gate'], '/closure_gate', issues);
  }
  throwIfIssues('AutopilotState', issues);
}

function assertReceiptShape(value: unknown): void {
  const issues: string[] = [];
  const record = requireRecord(value, 'AutopilotReceipt', issues);
  if (record !== undefined) {
    checkKnownKeys(record, receiptKeys, 'AutopilotReceipt', issues);
    checkRequired(record, receiptRequired, 'AutopilotReceipt', issues);
    expectConst(record['schema_version'], 'autopilot.receipt.v1', '/schema_version', issues);
    expectConst(record['tool_name'], 'autopilot_emit_status', '/tool_name', issues);
    expectString(record['workstream'], '/workstream', issues, { pattern: WORKSTREAM, max: 128 });
    expectString(record['unit_id'], '/unit_id', issues, { pattern: UNIT_ID, max: 128 });
    expectEnum(record['role'], AUTOPILOT_ROLE_VALUES, '/role', issues);
    expectInteger(record['attempt'], '/attempt', issues, 1, 999);
    expectString(record['emitted_at'], '/emitted_at', issues, { pattern: ISO_TIMESTAMP });
    expectString(record['status_output'], '/status_output', issues, { max: 1024 });
    expectString(record['status_sha256'], '/status_sha256', issues, { pattern: SHA256 });
    expectString(record['schema_sha256'], '/schema_sha256', issues, { pattern: SHA256 });
    expectString(record['tool_call_id'], '/tool_call_id', issues, { max: 200 });
    checkProviderIdentity(record['provider_identity'], '/provider_identity', issues);
    expectString(record['expected_identity_hash'], '/expected_identity_hash', issues, { pattern: SHA256 });
  }
  throwIfIssues('AutopilotReceipt', issues);
}

function assertHandoffShape(value: unknown): void {
  const issues: string[] = [];
  const record = requireRecord(value, 'AutopilotHandoff', issues);
  if (record !== undefined) {
    checkKnownKeys(record, handoffKeys, 'AutopilotHandoff', issues);
    checkRequired(record, handoffRequired, 'AutopilotHandoff', issues);
    expectConst(record['schema_version'], 'autopilot.handoff.v1', '/schema_version', issues);
    expectString(record['workstream'], '/workstream', issues, { pattern: WORKSTREAM, max: 128 });
    expectString(record['written_at'], '/written_at', issues, { pattern: ISO_TIMESTAMP });
    expectEnum(record['reason'], AUTOPILOT_HANDOFF_REASON_VALUES, '/reason', issues);
    expectString(record['mission_ref'], '/mission_ref', issues, { max: 512 });
    expectString(record['master_plan_ref'], '/master_plan_ref', issues, { max: 512 });
    if (record['decision_tail_ref'] !== null) {
      expectString(record['decision_tail_ref'], '/decision_tail_ref', issues, { max: 512 });
    }
    expectInteger(record['latest_decision_id'], '/latest_decision_id', issues, 0, 9_000_000_000_000_000);
    expectString(record['state_ref'], '/state_ref', issues, { max: 512 });
    if (record['event_tail_ref'] !== null) {
      expectString(record['event_tail_ref'], '/event_tail_ref', issues, { max: 512 });
    }
    expectStringArray(record['status_refs'], '/status_refs', issues, 500);
    expectStringArray(record['audit_refs'], '/audit_refs', issues, 500);
    expectString(record['summary'], '/summary', issues, { max: 1000 });
    expectStringArray(record['open_blockers'], '/open_blockers', issues, 80, 0, 500);
    expectStringArray(record['next_actions'], '/next_actions', issues, 80, 0, 500);
  }
  throwIfIssues('AutopilotHandoff', issues);
}

function assertMasterPlanShape(value: unknown): void {
  const issues: string[] = [];
  const record = requireRecord(value, 'AutopilotMasterPlan', issues);
  if (record !== undefined) {
    checkKnownKeys(record, masterPlanKeys, 'AutopilotMasterPlan', issues);
    checkRequired(record, masterPlanRequired, 'AutopilotMasterPlan', issues);
    expectConst(record['schema_version'], 'autopilot.master_plan.v1', '/schema_version', issues);
    expectString(record['workstream'], '/workstream', issues, { pattern: WORKSTREAM, max: 128 });
    expectString(record['mission_ref'], '/mission_ref', issues, { max: 512 });
    expectString(record['goal_summary'], '/goal_summary', issues, { max: 1000 });
    expectStringArray(record['non_goals'], '/non_goals', issues, 80, 0, 500);
    expectStringArray(record['definition_of_done'], '/definition_of_done', issues, 80, 0, 500);
    expectEnum(record['risk_level'], AUTOPILOT_RISK_LEVEL_VALUES, '/risk_level', issues);
    expectArray(record['lanes'], '/lanes', issues, 500, 0, checkMasterPlanLane);
    checkMasterPlanUnits(record['units'], '/units', issues);
    checkOwnershipMatrix(record['ownership_matrix'], '/ownership_matrix', issues);
    checkVerificationPlan(record['verification_matrix'], '/verification_matrix', issues);
    expectStringArray(record['closure_criteria'], '/closure_criteria', issues, 120, 0, 500);
    expectString(record['current_focus'], '/current_focus', issues, { max: 500 });
    expectInteger(record['last_decision_id'], '/last_decision_id', issues, 0, 9_000_000_000_000_000);
    expectInteger(record['last_event_id'], '/last_event_id', issues, 0, 9_000_000_000_000_000);
    expectString(record['updated_at'], '/updated_at', issues, { pattern: ISO_TIMESTAMP });
  }
  throwIfIssues('AutopilotMasterPlan', issues);
}

function assertDecisionRowShape(value: unknown): void {
  const issues: string[] = [];
  const record = requireRecord(value, 'AutopilotDecisionRow', issues);
  if (record !== undefined) {
    checkKnownKeys(record, decisionRowKeys, 'AutopilotDecisionRow', issues);
    checkRequired(record, decisionRowRequired, 'AutopilotDecisionRow', issues);
    expectConst(record['schema_version'], 'autopilot.decision.v1', '/schema_version', issues);
    expectInteger(record['id'], '/id', issues, 1, 9_000_000_000_000_000);
    expectString(record['ts'], '/ts', issues, { pattern: ISO_TIMESTAMP });
    expectEnum(record['event'], AUTOPILOT_DECISION_EVENT_VALUES, '/event', issues);
    expectString(record['workstream'], '/workstream', issues, { pattern: WORKSTREAM, max: 128 });
    expectString(record['summary'], '/summary', issues, { max: 500 });
    expectString(record['decision'], '/decision', issues, { max: 1000 });
    optionalString(record, 'unit_id', '/unit_id', issues, { pattern: UNIT_ID, max: 128 });
    optionalString(record, 'master_plan_ref', '/master_plan_ref', issues, { max: 512 });
    if (hasKey(record, 'evidence_refs')) {
      expectArray(record['evidence_refs'], '/evidence_refs', issues, 80, 0, checkEvidenceRef);
    }
  }
  throwIfIssues('AutopilotDecisionRow', issues);
}

function assertExecutionAuditShape(value: unknown): void {
  const issues: string[] = [];
  const record = requireRecord(value, 'AutopilotExecutionAudit', issues);
  if (record !== undefined) {
    checkKnownKeys(record, executionAuditKeys, 'AutopilotExecutionAudit', issues);
    checkRequired(record, executionAuditRequired, 'AutopilotExecutionAudit', issues);
    expectConst(record['schema_version'], 'autopilot.execution_audit.v1', '/schema_version', issues);
    expectString(record['workstream'], '/workstream', issues, { pattern: WORKSTREAM, max: 128 });
    expectString(record['unit_id'], '/unit_id', issues, { pattern: UNIT_ID, max: 128 });
    expectEnum(record['role'], AUTOPILOT_ROLE_VALUES, '/role', issues);
    expectInteger(record['attempt'], '/attempt', issues, 1, 999);
    expectString(record['audited_at'], '/audited_at', issues, { pattern: ISO_TIMESTAMP });
    expectString(record['cwd'], '/cwd', issues, { max: 1024 });
    if (record['git_head'] !== null) expectString(record['git_head'], '/git_head', issues, { max: 80 });
    if (record['dirty_baseline'] !== null) expectBoolean(record['dirty_baseline'], '/dirty_baseline', issues);
    expectStringArray(record['dirty_baseline_paths'], '/dirty_baseline_paths', issues, 500);
    expectStringArray(record['dirty_relevant_paths'], '/dirty_relevant_paths', issues, 500);
    expectStringArray(record['actual_changed_paths'], '/actual_changed_paths', issues, 500);
    expectStringArray(record['status_reported_changed_paths'], '/status_reported_changed_paths', issues, 500);
    expectStringArray(record['omitted_status_changes'], '/omitted_status_changes', issues, 500);
    expectStringArray(record['reported_but_not_actual_changes'], '/reported_but_not_actual_changes', issues, 500);
    expectStringArray(record['outside_owned_paths'], '/outside_owned_paths', issues, 500);
    expectStringArray(record['read_only_touched_paths'], '/read_only_touched_paths', issues, 500);
    expectStringArray(record['untouchable_touched_paths'], '/untouchable_touched_paths', issues, 500);
    expectStringArray(record['declared_validation_commands'], '/declared_validation_commands', issues, 120, 0, 800);
    expectStringArray(record['status_reported_commands'], '/status_reported_commands', issues, 120, 0, 800);
    expectStringArray(record['command_coverage_gaps'], '/command_coverage_gaps', issues, 120, 0, 800);
    expectEnum(record['classification'], AUTOPILOT_AUDIT_CLASSIFICATION_VALUES, '/classification', issues);
    expectArray(record['evidence_refs'], '/evidence_refs', issues, 80, 0, checkEvidenceRef);
    expectString(record['summary'], '/summary', issues, { max: 1000 });
  }
  throwIfIssues('AutopilotExecutionAudit', issues);
}

function checkContextRef(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, contextRefKeys, label, issues);
  checkRequired(record, contextRefRequired, label, issues);
  expectString(record['path'], `${label}/path`, issues, { max: 512 });
  expectString(record['purpose'], `${label}/purpose`, issues, { max: 240 });
  optionalString(record, 'sha256', `${label}/sha256`, issues, { pattern: SHA256 });
  optionalInteger(record, 'byte_count', `${label}/byte_count`, issues, 0, 1_000_000_000);
}

function checkEvidenceRef(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, evidenceRefKeys, label, issues);
  checkRequired(record, evidenceRefRequired, label, issues);
  expectString(record['path'], `${label}/path`, issues, { max: 512 });
  optionalString(record, 'sha256', `${label}/sha256`, issues, { pattern: SHA256 });
  optionalInteger(record, 'byte_count', `${label}/byte_count`, issues, 0, 1_000_000_000);
  optionalString(record, 'description', `${label}/description`, issues, { max: 240 });
}

function checkCommandSummary(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, commandKeys, label, issues);
  checkRequired(record, commandRequired, label, issues);
  expectString(record['command'], `${label}/command`, issues, { max: 800 });
  expectEnum(record['status'], AUTOPILOT_COMMAND_STATUS_VALUES, `${label}/status`, issues);
  if (record['exit_code'] !== null) expectInteger(record['exit_code'], `${label}/exit_code`, issues, -1, 255);
  expectString(record['summary'], `${label}/summary`, issues, { max: 360 });
  optionalString(record, 'evidence_ref', `${label}/evidence_ref`, issues, { max: 512 });
}

function checkWitnessSpec(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, witnessSpecKeys, label, issues);
  checkRequired(record, witnessSpecRequired, label, issues);
  expectString(record['id'], `${label}/id`, issues, { pattern: FINDING_ID, max: 96 });
  expectString(record['expected_signal'], `${label}/expected_signal`, issues, { max: 500 });
  expectBoolean(record['required'], `${label}/required`, issues);
  optionalString(record, 'command', `${label}/command`, issues, { max: 800 });
  optionalString(record, 'inspection_target', `${label}/inspection_target`, issues, { max: 500 });
  optionalString(record, 'blocker_reason', `${label}/blocker_reason`, issues, { max: 500 });
}

function checkVerificationPlan(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, verificationPlanKeys, label, issues);
  checkRequired(record, verificationPlanRequired, label, issues);
  for (const key of verificationPlanRequired) {
    expectArray(record[key], `${label}/${key}`, issues, 80, 0, checkWitnessSpec);
  }
}

function checkUpstreamRef(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, upstreamRefKeys, label, issues);
  checkRequired(record, upstreamRefRequired, label, issues);
  expectString(record['unit_id'], `${label}/unit_id`, issues, { pattern: UNIT_ID, max: 128 });
  expectString(record['purpose'], `${label}/purpose`, issues, { max: 360 });
  optionalString(record, 'status_ref', `${label}/status_ref`, issues, { max: 512 });
  optionalString(record, 'audit_ref', `${label}/audit_ref`, issues, { max: 512 });
}

function checkMasterPlanLane(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, masterPlanLaneKeys, label, issues);
  checkRequired(record, masterPlanLaneRequired, label, issues);
  expectString(record['lane_id'], `${label}/lane_id`, issues, { pattern: UNIT_ID, max: 128 });
  expectString(record['summary'], `${label}/summary`, issues, { max: 360 });
  expectStringArray(record['unit_ids'], `${label}/unit_ids`, issues, 500, 0, 128, UNIT_ID);
}

function checkMasterPlanUnits(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  const keys = Object.keys(record);
  if (keys.length > 2_000) issues.push(`${label} must contain at most 2000 entries`);
  for (const key of keys) {
    if (!UNIT_ID.test(key)) issues.push(`${label} key ${JSON.stringify(key)} is invalid`);
    checkMasterPlanUnit(record[key], `${label}/${key}`, issues);
  }
}

function checkMasterPlanUnit(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, masterPlanUnitKeys, label, issues);
  checkRequired(record, masterPlanUnitRequired, label, issues);
  expectString(record['unit_id'], `${label}/unit_id`, issues, { pattern: UNIT_ID, max: 128 });
  expectEnum(record['role'], AUTOPILOT_ROLE_VALUES, `${label}/role`, issues);
  expectEnum(record['state'], AUTOPILOT_UNIT_STATE_VALUES, `${label}/state`, issues);
  expectStringArray(record['dependencies'], `${label}/dependencies`, issues, 200, 0, 128, UNIT_ID);
  expectString(record['summary'], `${label}/summary`, issues, { max: 360 });
}

function checkOwnershipMatrix(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, ownershipMatrixKeys, label, issues);
  checkRequired(record, ownershipMatrixRequired, label, issues);
  expectStringArray(record['owned_paths'], `${label}/owned_paths`, issues, 500);
  expectStringArray(record['read_only_paths'], `${label}/read_only_paths`, issues, 500);
  expectStringArray(record['untouchable_paths'], `${label}/untouchable_paths`, issues, 500);
  expectStringArray(record['held_paths'], `${label}/held_paths`, issues, 500);
}

function checkFinding(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, findingKeys, label, issues);
  checkRequired(record, findingRequired, label, issues);
  expectString(record['id'], `${label}/id`, issues, { pattern: FINDING_ID, max: 96 });
  expectEnum(record['severity'], ['minor-local', 'major-local', 'critical'], `${label}/severity`, issues);
  optionalString(record, 'path', `${label}/path`, issues, { max: 512 });
  expectString(record['summary'], `${label}/summary`, issues, { max: 500 });
  if (hasKey(record, 'evidence_refs')) {
    expectArray(record['evidence_refs'], `${label}/evidence_refs`, issues, 12, 0, checkEvidenceRef);
  }
}

function checkContextGate(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, contextGateKeys, label, issues);
  checkRequired(record, contextGateRequired, label, issues);
  expectEnum(record['gate'], AUTOPILOT_CONTEXT_GATE_VALUES, `${label}/gate`, issues);
  if (record['percent'] !== null) expectNumber(record['percent'], `${label}/percent`, issues, 0, 100);
}

function checkUnits(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  const keys = Object.keys(record);
  if (keys.length > 2_000) issues.push(`${label} must contain at most 2000 entries`);
  for (const key of keys) {
    if (!UNIT_ID.test(key)) issues.push(`${label} key ${JSON.stringify(key)} is invalid`);
    checkStateUnit(record[key], `${label}/${key}`, issues);
  }
}

function checkStateUnit(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, stateUnitKeys, label, issues);
  checkRequired(record, stateUnitRequired, label, issues);
  expectString(record['unit_id'], `${label}/unit_id`, issues, { pattern: UNIT_ID, max: 128 });
  expectEnum(record['role'], AUTOPILOT_ROLE_VALUES, `${label}/role`, issues);
  expectEnum(record['state'], AUTOPILOT_UNIT_STATE_VALUES, `${label}/state`, issues);
  expectInteger(record['attempt'], `${label}/attempt`, issues, 1, 999);
  optionalString(record, 'spec_ref', `${label}/spec_ref`, issues, { max: 512 });
  optionalString(record, 'status_ref', `${label}/status_ref`, issues, { max: 512 });
  optionalString(record, 'receipt_ref', `${label}/receipt_ref`, issues, { max: 512 });
  expectString(record['summary'], `${label}/summary`, issues, { max: 360 });
}

function checkWorkItems(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  for (const [key, item] of Object.entries(record)) {
    if (!UNIT_ID.test(key)) issues.push(`${label} key ${JSON.stringify(key)} is invalid`);
    checkWorkItem(item, `${label}/${key}`, issues);
  }
}

function checkWorkItem(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, workItemKeys, label, issues);
  checkRequired(record, workItemRequired, label, issues);
  expectString(record['work_item_id'], `${label}/work_item_id`, issues, { pattern: UNIT_ID, max: 128 });
  expectEnum(record['state'], AUTOPILOT_WORK_ITEM_STATE_VALUES, `${label}/state`, issues);
  expectBoolean(record['source_changing'], `${label}/source_changing`, issues);
  expectStringArray(record['unit_ids'], `${label}/unit_ids`, issues, 500, 0, 128, UNIT_ID);
  optionalString(record, 'implementation_unit_id', `${label}/implementation_unit_id`, issues, { pattern: UNIT_ID, max: 128 });
  optionalString(record, 'validation_unit_id', `${label}/validation_unit_id`, issues, { pattern: UNIT_ID, max: 128 });
  optionalString(record, 'audit_ref', `${label}/audit_ref`, issues, { max: 512 });
  optionalString(record, 'status_ref', `${label}/status_ref`, issues, { max: 512 });
  optionalString(record, 'validation_status_ref', `${label}/validation_status_ref`, issues, { max: 512 });
  expectString(record['summary'], `${label}/summary`, issues, { max: 360 });
}

function checkScopeException(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, scopeExceptionKeys, label, issues);
  checkRequired(record, scopeExceptionRequired, label, issues);
  expectString(record['exception_id'], `${label}/exception_id`, issues, { pattern: UNIT_ID, max: 128 });
  expectString(record['unit_id'], `${label}/unit_id`, issues, { pattern: UNIT_ID, max: 128 });
  expectString(record['audit_ref'], `${label}/audit_ref`, issues, { max: 512 });
  expectStringArray(record['paths'], `${label}/paths`, issues, 500, 1);
  expectEnum(record['state'], AUTOPILOT_EXCEPTION_STATE_VALUES, `${label}/state`, issues);
  optionalString(record, 'decision_ref', `${label}/decision_ref`, issues, { max: 512 });
  expectString(record['summary'], `${label}/summary`, issues, { max: 500 });
}

function checkProtectedPathException(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, protectedPathExceptionKeys, label, issues);
  checkRequired(record, protectedPathExceptionRequired, label, issues);
  expectString(record['exception_id'], `${label}/exception_id`, issues, { pattern: UNIT_ID, max: 128 });
  expectString(record['unit_id'], `${label}/unit_id`, issues, { pattern: UNIT_ID, max: 128 });
  expectString(record['audit_ref'], `${label}/audit_ref`, issues, { max: 512 });
  expectStringArray(record['read_only_paths'], `${label}/read_only_paths`, issues, 500);
  expectStringArray(record['untouchable_paths'], `${label}/untouchable_paths`, issues, 500);
  expectEnum(record['state'], AUTOPILOT_EXCEPTION_STATE_VALUES, `${label}/state`, issues);
  optionalString(record, 'decision_ref', `${label}/decision_ref`, issues, { max: 512 });
  expectString(record['summary'], `${label}/summary`, issues, { max: 500 });
}

function checkClosureGate(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, closureGateKeys, label, issues);
  checkRequired(record, closureGateRequired, label, issues);
  expectEnum(record['status'], AUTOPILOT_CLOSURE_GATE_STATUS_VALUES, `${label}/status`, issues);
  optionalString(record, 'checked_at', `${label}/checked_at`, issues, { pattern: ISO_TIMESTAMP });
  expectStringArray(record['blocking_reasons'], `${label}/blocking_reasons`, issues, 200, 0, 500);
  optionalString(record, 'bughunt_status_ref', `${label}/bughunt_status_ref`, issues, { max: 512 });
  optionalString(record, 'decision_ref', `${label}/decision_ref`, issues, { max: 512 });
  expectString(record['summary'], `${label}/summary`, issues, { max: 500 });
}

function checkProviderIdentity(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, providerKeys, label, issues);
  checkRequired(record, providerRequired, label, issues);
  expectString(record['provider_id'], `${label}/provider_id`, issues, { max: 120 });
  expectString(record['requested_model_id'], `${label}/requested_model_id`, issues, { max: 120 });
  expectString(record['executed_model_id'], `${label}/executed_model_id`, issues, { max: 120 });
  expectString(record['api'], `${label}/api`, issues, { max: 120 });
  expectString(record['thinking_level'], `${label}/thinking_level`, issues, { max: 40 });
}

function semanticUnitSpecIssues(spec: AutopilotUnitSpec): string[] {
  const issues: string[] = [];
  if (spec.template !== spec.role) {
    issues.push(
      `template ${JSON.stringify(spec.template)} must equal role ${JSON.stringify(spec.role)}`,
    );
  }
  if ((spec.role === 'implement' || spec.role === 'fix') && spec.owned_paths.length === 0) {
    issues.push(`${spec.role} unit specs require at least one owned path`);
  }
  if (
    (spec.role === 'validate' || spec.role === 'bughunt') &&
    spec.validation_commands.length === 0
  ) {
    issues.push(`${spec.role} unit specs require at least one validation command`);
  }
  if (spec.status_output === spec.receipt_output) {
    issues.push('status_output and receipt_output must be distinct absolute paths');
  }
  issues.push(...duplicateIssues('owned_paths', spec.owned_paths));
  issues.push(...duplicateIssues('read_only_paths', spec.read_only_paths));
  issues.push(...duplicateIssues('untouchable_paths', spec.untouchable_paths));
  issues.push(
    ...intersectionIssues('owned_paths', spec.owned_paths, 'read_only_paths', spec.read_only_paths),
  );
  issues.push(
    ...intersectionIssues(
      'owned_paths',
      spec.owned_paths,
      'untouchable_paths',
      spec.untouchable_paths,
    ),
  );
  for (const path of spec.owned_paths) issues.push(...relativePathIssues(path, 'owned_paths entry'));
  for (const path of spec.read_only_paths) {
    issues.push(...relativePathIssues(path, 'read_only_paths entry'));
  }
  for (const path of spec.untouchable_paths) {
    issues.push(...relativePathIssues(path, 'untouchable_paths entry'));
  }
  for (const ref of spec.context_refs) {
    issues.push(...relativePathIssues(ref.path, `context_refs ${ref.path}`));
  }
  for (const ref of spec.upstream_refs ?? []) {
    if (ref.status_ref !== undefined) {
      issues.push(...relativePathIssues(ref.status_ref, `upstream_refs ${ref.unit_id} status_ref`));
    }
    if (ref.audit_ref !== undefined) {
      issues.push(...relativePathIssues(ref.audit_ref, `upstream_refs ${ref.unit_id} audit_ref`));
    }
  }
  issues.push(...duplicateIssues('acceptance_criteria', spec.acceptance_criteria ?? []));
  issues.push(...duplicateIssues('closure_criteria', spec.closure_criteria ?? []));
  issues.push(...verificationPlanIssues(spec.verification_plan, 'verification_plan'));
  for (const [field, path] of [
    ['cwd', spec.cwd],
    ['status_output', spec.status_output],
    ['receipt_output', spec.receipt_output],
    ['evidence_dir', spec.evidence_dir],
  ] as const) {
    issues.push(...absolutePathIssues(path, field));
  }
  issues.push(...unitSpecArtifactPathIssues(spec));
  return issues;
}

function semanticStatusEntryIssues(
  status: AutopilotStatusEntry,
  options: AutopilotValidationOptions,
): string[] {
  const issues: string[] = [];
  issues.push(...roleVerdictIssues(status.role, status.verdict));
  if ((status.verdict === 'PASS' || status.verdict === 'DONE') && status.severity !== 'clean') {
    issues.push(`${status.verdict} statuses must have severity clean`);
  }
  if ((status.verdict === 'PASS' || status.verdict === 'DONE') && status.findings.length !== 0) {
    issues.push(`${status.verdict} statuses must not carry findings`);
  }
  if (
    (status.verdict === 'NEEDS_FIX' || status.verdict === 'BLOCKED') &&
    status.severity === 'clean'
  ) {
    issues.push(`${status.verdict} statuses must classify non-clean severity`);
  }
  if (status.verdict === 'NEEDS_FIX' && status.findings.length === 0) {
    issues.push('NEEDS_FIX statuses require at least one finding');
  }
  if (isSuccessVerdict(status.verdict) && status.commands.some((command) => command.status === 'failed')) {
    issues.push(`${status.verdict} statuses must not include failed commands`);
  }
  if (isSuccessVerdict(status.verdict) && status.commands.some((command) => command.status !== 'passed')) {
    issues.push(`${status.verdict} statuses must report passed for every command summary`);
  }
  if (
    isSuccessVerdict(status.verdict) &&
    status.commands.some((command) => command.exit_code !== null && command.exit_code !== 0)
  ) {
    issues.push(`${status.verdict} statuses must not include non-zero command exit codes`);
  }
  issues.push(...duplicateIssues('covered_witness_ids', status.covered_witness_ids ?? []));
  for (const path of status.changed_paths) {
    issues.push(...relativePathIssues(path, 'changed_paths entry'));
  }
  for (const [index, command] of status.commands.entries()) {
    if (command.evidence_ref !== undefined) {
      issues.push(...relativePathIssues(command.evidence_ref, `commands[${index}].evidence_ref`));
    }
  }
  for (const ref of status.evidence_refs) {
    issues.push(...evidenceRefIssues(ref, options.artifactRoot, 'evidence_refs'));
  }
  if (status.report_ref !== null) {
    issues.push(...evidenceRefIssues(status.report_ref, options.artifactRoot, 'report_ref'));
  }
  for (const finding of status.findings) {
    if (finding.path !== undefined) {
      issues.push(...relativePathIssues(finding.path, `finding ${finding.id} path`));
    }
    for (const ref of finding.evidence_refs ?? []) {
      issues.push(
        ...evidenceRefIssues(ref, options.artifactRoot, `finding ${finding.id} evidence_refs`),
      );
    }
  }
  if (options.unitSpec !== undefined) {
    issues.push(...statusMatchesUnitSpecIssues(status, options.unitSpec));
  }
  if (options.executionAudit !== undefined) {
    issues.push(...statusMatchesExecutionAuditIssues(status, options.executionAudit));
  }
  return issues;
}

function roleVerdictIssues(role: AutopilotRole, verdict: AutopilotVerdict): string[] {
  const sourceRoles: readonly AutopilotRole[] = [
    'strategy',
    'implement',
    'fix',
    'adjudicate',
    'extract',
  ];
  if (sourceRoles.includes(role)) {
    return verdict === 'DONE' || verdict === 'BLOCKED'
      ? []
      : [`role ${role} may only emit DONE or BLOCKED, not ${verdict}`];
  }
  return verdict === 'PASS' || verdict === 'NEEDS_FIX' || verdict === 'BLOCKED'
    ? []
    : [`role ${role} may only emit PASS, NEEDS_FIX, or BLOCKED, not ${verdict}`];
}

function isSuccessVerdict(verdict: AutopilotVerdict): boolean {
  return verdict === 'DONE' || verdict === 'PASS';
}

function statusMatchesUnitSpecIssues(
  status: AutopilotStatusEntry,
  spec: AutopilotUnitSpec,
): string[] {
  const issues: string[] = [];
  if (status.workstream !== spec.workstream) issues.push('status workstream does not match unit spec');
  if (status.unit_id !== spec.unit_id) issues.push('status unit_id does not match unit spec');
  if (status.role !== spec.role) issues.push('status role does not match unit spec');
  if (status.attempt !== spec.attempt) issues.push('status attempt does not match unit spec');
  if (status.role !== 'implement' && status.role !== 'fix' && status.changed_paths.length > 0) {
    issues.push(
      `${status.role} statuses may not report changed_paths; only implement/fix units may change owned paths`,
    );
  }
  if (status.role === 'implement' || status.role === 'fix') {
    for (const changedPath of status.changed_paths) {
      if (!isUnderOwnedPath(changedPath, spec.owned_paths)) {
        issues.push(`changed path ${JSON.stringify(changedPath)} is outside unit owned_paths`);
      }
    }
  }
  if (isSuccessVerdict(status.verdict)) {
    for (const command of spec.validation_commands) {
      if (!status.commands.some((reported) => reported.command === command)) {
        issues.push(`success status must report declared validation command ${JSON.stringify(command)}`);
      }
    }
  }
  const knownWitnessIds = allWitnessIds(spec);
  for (const coveredWitnessId of status.covered_witness_ids ?? []) {
    if (!knownWitnessIds.includes(coveredWitnessId)) {
      issues.push(`covered_witness_ids contains unknown witness id ${JSON.stringify(coveredWitnessId)}`);
    }
  }
  if (status.verdict === 'PASS') {
    const missingWitnessIds = requiredWitnessIds(spec).filter(
      (witnessId) => !(status.covered_witness_ids ?? []).includes(witnessId),
    );
    for (const witnessId of missingWitnessIds) {
      issues.push(`PASS status must cover required witness id ${JSON.stringify(witnessId)}`);
    }
    if (!isMechanicalEvidenceFreePass(spec) && status.evidence_refs.length === 0 && status.report_ref === null) {
      issues.push('PASS status for non-mechanical validation requires evidence_refs or report_ref');
    }
  }
  if (
    status.verdict === 'DONE' &&
    spec.quality_profile === 'strategy' &&
    status.evidence_refs.length === 0 &&
    status.report_ref === null
  ) {
    issues.push('strategy DONE status requires evidence_refs or report_ref for the produced plan');
  }
  return issues;
}

function statusMatchesExecutionAuditIssues(
  status: AutopilotStatusEntry,
  audit: AutopilotExecutionAudit,
): string[] {
  const issues: string[] = [];
  if (status.workstream !== audit.workstream) issues.push('status workstream does not match execution audit');
  if (status.unit_id !== audit.unit_id) issues.push('status unit_id does not match execution audit');
  if (status.role !== audit.role) issues.push('status role does not match execution audit');
  if (status.attempt !== audit.attempt) issues.push('status attempt does not match execution audit');
  if ((status.role === 'implement' || status.role === 'fix') && isSuccessVerdict(status.verdict)) {
    for (const changedPath of audit.actual_changed_paths) {
      if (!status.changed_paths.includes(changedPath)) {
        issues.push(`success status omitted actual changed path ${JSON.stringify(changedPath)}`);
      }
    }
    for (const reportedPath of audit.reported_but_not_actual_changes) {
      issues.push(`success status reported unchanged path ${JSON.stringify(reportedPath)}`);
    }
  }
  return issues;
}

function requiredWitnessIds(spec: AutopilotUnitSpec): readonly string[] {
  const plan = spec.verification_plan;
  if (plan === undefined) return [];
  return Object.freeze(allWitnesses(plan).filter((witness) => witness.required).map((witness) => witness.id));
}

function allWitnessIds(spec: AutopilotUnitSpec): readonly string[] {
  const plan = spec.verification_plan;
  if (plan === undefined) return [];
  return Object.freeze(allWitnesses(plan).map((witness) => witness.id));
}

function isMechanicalEvidenceFreePass(spec: AutopilotUnitSpec): boolean {
  if (spec.quality_profile !== 'validation-only' || spec.risk_level !== 'low') return false;
  const plan = spec.verification_plan;
  if (plan === undefined) return false;
  const required = allWitnesses(plan).filter((witness) => witness.required);
  if (required.length === 0) return false;
  return required.every(
    (witness) => witness.command !== undefined && witness.inspection_target === undefined,
  );
}

function allWitnesses(
  plan: NonNullable<AutopilotUnitSpec['verification_plan']>,
): readonly AutopilotWitnessSpec[] {
  return Object.freeze([
    ...plan.positive_witnesses,
    ...plan.negative_witnesses,
    ...plan.regression_witnesses,
    ...plan.real_boundary_witnesses,
    ...plan.blast_radius_checks,
    ...plan.docs_schema_prompt_checks,
    ...plan.dirty_tree_checks,
  ]);
}

function semanticEventRowIssues(event: AutopilotEventRow): string[] {
  const issues: string[] = [];
  if (event.event === 'agent_completed') {
    if (event.unit_id === undefined) issues.push('agent_completed event requires unit_id');
    if (event.role === undefined) issues.push('agent_completed event requires role');
    if (event.verdict === undefined) issues.push('agent_completed event requires verdict');
    if (event.status_ref === undefined) issues.push('agent_completed event requires status_ref');
  }
  if (event.role !== undefined && event.verdict !== undefined) {
    issues.push(...roleVerdictIssues(event.role, event.verdict));
  }
  for (const [field, path] of [
    ['spec_ref', event.spec_ref],
    ['status_ref', event.status_ref],
    ['receipt_ref', event.receipt_ref],
    ['evidence_ref', event.evidence_ref],
  ] as const) {
    if (path !== undefined) issues.push(...relativePathIssues(path, field));
  }
  return issues;
}

function semanticStateIssues(state: AutopilotState): string[] {
  const issues: string[] = [];
  const seenQueues = new Set<string>();
  for (const [field, unitIds] of [
    ['ready_queue', state.ready_queue],
    ['running', state.running],
    ['blocked', state.blocked],
    ['completed', state.completed],
  ] as const) {
    issues.push(...duplicateIssues(field, unitIds));
    for (const unitId of unitIds) {
      if (seenQueues.has(unitId)) {
        issues.push(`unit ${JSON.stringify(unitId)} appears in more than one queue`);
      }
      seenQueues.add(unitId);
      if (state.units[unitId] === undefined) {
        issues.push(`${field} references missing units entry ${JSON.stringify(unitId)}`);
      }
    }
  }
  for (const [unitId, unit] of Object.entries(state.units)) {
    if (unit.unit_id !== unitId) {
      issues.push(
        `units entry key ${JSON.stringify(unitId)} does not match unit_id ${JSON.stringify(unit.unit_id)}`,
      );
    }
    for (const [field, path] of [
      ['spec_ref', unit.spec_ref],
      ['status_ref', unit.status_ref],
      ['receipt_ref', unit.receipt_ref],
    ] as const) {
      if (path !== undefined) issues.push(...relativePathIssues(path, `units.${unitId}.${field}`));
    }
  }
  if (state.work_items !== undefined) {
    issues.push(...workItemStateIssues(state));
  }
  issues.push(...duplicateIssues('audit_review_queue', state.audit_review_queue ?? []));
  issues.push(...duplicateIssues('validation_ready_queue', state.validation_ready_queue ?? []));
  for (const ref of state.audit_review_queue ?? []) {
    issues.push(...relativePathIssues(ref, 'audit_review_queue entry'));
  }
  for (const unitId of state.validation_ready_queue ?? []) {
    if (state.work_items?.[unitId] === undefined && state.units[unitId] === undefined) {
      issues.push(`validation_ready_queue references missing unit/work item ${JSON.stringify(unitId)}`);
    }
  }
  for (const exception of state.scope_exceptions ?? []) {
    issues.push(...relativePathIssues(exception.audit_ref, `scope_exceptions ${exception.exception_id} audit_ref`));
    for (const path of exception.paths) {
      issues.push(...relativePathIssues(path, `scope_exceptions ${exception.exception_id} paths entry`));
    }
    if (exception.decision_ref !== undefined) {
      issues.push(...relativePathIssues(exception.decision_ref, `scope_exceptions ${exception.exception_id} decision_ref`));
    }
  }
  for (const exception of state.protected_path_exceptions ?? []) {
    issues.push(...relativePathIssues(exception.audit_ref, `protected_path_exceptions ${exception.exception_id} audit_ref`));
    if (exception.read_only_paths.length === 0 && exception.untouchable_paths.length === 0) {
      issues.push(`protected_path_exceptions ${exception.exception_id} must include read_only_paths or untouchable_paths`);
    }
    for (const path of exception.read_only_paths) {
      issues.push(...relativePathIssues(path, `protected_path_exceptions ${exception.exception_id} read_only_paths entry`));
    }
    for (const path of exception.untouchable_paths) {
      issues.push(...relativePathIssues(path, `protected_path_exceptions ${exception.exception_id} untouchable_paths entry`));
    }
    if (exception.decision_ref !== undefined) {
      issues.push(...relativePathIssues(exception.decision_ref, `protected_path_exceptions ${exception.exception_id} decision_ref`));
    }
  }
  const closureGate = state.closure_gate;
  if (closureGate !== undefined) {
    for (const [field, path] of [
      ['bughunt_status_ref', closureGate.bughunt_status_ref],
      ['decision_ref', closureGate.decision_ref],
    ] as const) {
      if (path !== undefined) issues.push(...relativePathIssues(path, `closure_gate.${field}`));
    }
    if (closureGate.status === 'passed' && closureGate.blocking_reasons.length > 0) {
      issues.push('closure_gate passed must not include blocking_reasons');
    }
    if (closureGate.status === 'failed' && closureGate.blocking_reasons.length === 0) {
      issues.push('closure_gate failed must include blocking_reasons');
    }
  }
  return issues;
}

function workItemStateIssues(state: AutopilotState): string[] {
  const issues: string[] = [];
  for (const [workItemId, workItem] of Object.entries(state.work_items ?? {})) {
    if (workItem.work_item_id !== workItemId) {
      issues.push(`work_items entry key ${JSON.stringify(workItemId)} does not match work_item_id ${JSON.stringify(workItem.work_item_id)}`);
    }
    issues.push(...duplicateIssues(`work_items ${workItemId} unit_ids`, workItem.unit_ids));
    for (const unitId of workItem.unit_ids) {
      if (state.units[unitId] === undefined) {
        issues.push(`work_items ${workItemId} references missing unit ${JSON.stringify(unitId)}`);
      }
    }
    for (const [field, unitId] of [
      ['implementation_unit_id', workItem.implementation_unit_id],
      ['validation_unit_id', workItem.validation_unit_id],
    ] as const) {
      if (unitId !== undefined && state.units[unitId] === undefined) {
        issues.push(`work_items ${workItemId}.${field} references missing unit ${JSON.stringify(unitId)}`);
      }
    }
    for (const [field, path] of [
      ['audit_ref', workItem.audit_ref],
      ['status_ref', workItem.status_ref],
      ['validation_status_ref', workItem.validation_status_ref],
    ] as const) {
      if (path !== undefined) issues.push(...relativePathIssues(path, `work_items.${workItemId}.${field}`));
    }
    if (workItem.state === 'closed' && workItem.source_changing && workItem.validation_status_ref === undefined) {
      issues.push(`source-changing work item ${workItemId} cannot be closed without validation_status_ref`);
    }
  }
  return issues;
}

function semanticReceiptIssues(
  receipt: AutopilotReceipt,
  options: AutopilotValidationOptions,
): string[] {
  const issues: string[] = [];
  issues.push(...absolutePathIssues(receipt.status_output, 'status_output'));
  if (options.unitSpec !== undefined) {
    if (receipt.workstream !== options.unitSpec.workstream) {
      issues.push('receipt workstream does not match unit spec');
    }
    if (receipt.unit_id !== options.unitSpec.unit_id) {
      issues.push('receipt unit_id does not match unit spec');
    }
    if (receipt.role !== options.unitSpec.role) issues.push('receipt role does not match unit spec');
    if (receipt.attempt !== options.unitSpec.attempt) {
      issues.push('receipt attempt does not match unit spec');
    }
    if (receipt.status_output !== options.unitSpec.status_output) {
      issues.push('receipt status_output does not match unit spec');
    }
  }
  const statusOutputPath = options.statusOutputPath ?? receipt.status_output;
  if (existsSync(statusOutputPath)) {
    const stats = statSync(statusOutputPath);
    if (!stats.isFile()) {
      issues.push(
        `receipt status_output ${JSON.stringify(statusOutputPath)} exists but is not a file`,
      );
    } else {
      const actualHash = sha256File(statusOutputPath);
      if (receipt.status_sha256 !== actualHash) {
        issues.push(
          `receipt status_sha256 ${receipt.status_sha256} does not match status file ${actualHash}`,
        );
      }
    }
  }
  return issues;
}

function semanticHandoffIssues(handoff: AutopilotHandoff): string[] {
  const issues: string[] = [];
  issues.push(...relativePathIssues(handoff.mission_ref, 'mission_ref'));
  issues.push(...relativePathIssues(handoff.master_plan_ref, 'master_plan_ref'));
  if (handoff.decision_tail_ref !== null) {
    issues.push(...relativePathIssues(handoff.decision_tail_ref, 'decision_tail_ref'));
  }
  issues.push(...relativePathIssues(handoff.state_ref, 'state_ref'));
  if (handoff.event_tail_ref !== null) {
    issues.push(...relativePathIssues(handoff.event_tail_ref, 'event_tail_ref'));
  }
  for (const statusRef of handoff.status_refs) {
    issues.push(...relativePathIssues(statusRef, 'status_refs entry'));
  }
  for (const auditRef of handoff.audit_refs) {
    issues.push(...relativePathIssues(auditRef, 'audit_refs entry'));
  }
  if (
    handoff.reason === 'context-halt' &&
    handoff.open_blockers.length === 0 &&
    handoff.next_actions.length === 0
  ) {
    issues.push('context-halt handoff must include an open blocker or next action');
  }
  return issues;
}

function semanticMasterPlanIssues(masterPlan: AutopilotMasterPlan): string[] {
  const issues: string[] = [];
  issues.push(...relativePathIssues(masterPlan.mission_ref, 'mission_ref'));
  issues.push(...duplicateIssues('non_goals', masterPlan.non_goals));
  issues.push(...duplicateIssues('definition_of_done', masterPlan.definition_of_done));
  issues.push(...duplicateIssues('closure_criteria', masterPlan.closure_criteria));
  for (const lane of masterPlan.lanes) {
    issues.push(...duplicateIssues(`lanes ${lane.lane_id} unit_ids`, lane.unit_ids));
    for (const unitId of lane.unit_ids) {
      if (masterPlan.units[unitId] === undefined) {
        issues.push(`lane ${lane.lane_id} references missing unit ${JSON.stringify(unitId)}`);
      }
    }
  }
  for (const [unitId, unit] of Object.entries(masterPlan.units)) {
    if (unit.unit_id !== unitId) {
      issues.push(`units entry key ${JSON.stringify(unitId)} does not match unit_id ${JSON.stringify(unit.unit_id)}`);
    }
    issues.push(...duplicateIssues(`unit ${unitId} dependencies`, unit.dependencies));
    for (const dependency of unit.dependencies) {
      if (masterPlan.units[dependency] === undefined) {
        issues.push(`unit ${unitId} dependency ${JSON.stringify(dependency)} is missing from units`);
      }
    }
  }
  issues.push(...ownershipMatrixPathIssues(masterPlan.ownership_matrix));
  issues.push(...verificationPlanIssues(masterPlan.verification_matrix, 'verification_matrix'));
  return issues;
}

function semanticDecisionRowIssues(decision: AutopilotDecisionRow): string[] {
  const issues: string[] = [];
  if (decision.master_plan_ref !== undefined) {
    issues.push(...relativePathIssues(decision.master_plan_ref, 'master_plan_ref'));
  }
  for (const ref of decision.evidence_refs ?? []) {
    issues.push(...evidenceRefIssues(ref, undefined, 'evidence_refs'));
  }
  return issues;
}

function semanticExecutionAuditIssues(audit: AutopilotExecutionAudit): string[] {
  const issues: string[] = [];
  issues.push(...absolutePathIssues(audit.cwd, 'cwd'));
  for (const [field, paths] of [
    ['dirty_baseline_paths', audit.dirty_baseline_paths],
    ['dirty_relevant_paths', audit.dirty_relevant_paths],
    ['actual_changed_paths', audit.actual_changed_paths],
    ['status_reported_changed_paths', audit.status_reported_changed_paths],
    ['omitted_status_changes', audit.omitted_status_changes],
    ['reported_but_not_actual_changes', audit.reported_but_not_actual_changes],
    ['outside_owned_paths', audit.outside_owned_paths],
    ['read_only_touched_paths', audit.read_only_touched_paths],
    ['untouchable_touched_paths', audit.untouchable_touched_paths],
  ] as const) {
    issues.push(...duplicateIssues(field, paths));
    for (const path of paths) issues.push(...relativePathIssues(path, `${field} entry`));
  }
  issues.push(...duplicateIssues('declared_validation_commands', audit.declared_validation_commands));
  issues.push(...duplicateIssues('status_reported_commands', audit.status_reported_commands));
  issues.push(...duplicateIssues('command_coverage_gaps', audit.command_coverage_gaps));
  if (audit.dirty_baseline === null && audit.dirty_baseline_paths.length > 0) {
    issues.push('dirty_baseline null requires empty dirty_baseline_paths');
  }
  if (audit.dirty_baseline === false && audit.dirty_baseline_paths.length > 0) {
    issues.push('dirty_baseline false requires empty dirty_baseline_paths');
  }
  if (audit.dirty_baseline === true && audit.dirty_baseline_paths.length === 0) {
    issues.push('dirty_baseline true requires dirty_baseline_paths');
  }
  if (audit.dirty_baseline === null && audit.dirty_relevant_paths.length > 0) {
    issues.push('dirty_baseline null requires empty dirty_relevant_paths');
  }
  for (const dirtyRelevantPath of audit.dirty_relevant_paths) {
    if (!audit.dirty_baseline_paths.includes(dirtyRelevantPath)) {
      issues.push(`dirty_relevant_paths entry ${JSON.stringify(dirtyRelevantPath)} must be present in dirty_baseline_paths`);
    }
  }
  if (audit.classification !== 'audit-unavailable') {
    const expectedOmitted = sortedDifference(audit.actual_changed_paths, audit.status_reported_changed_paths);
    if (!sameStringSet(audit.omitted_status_changes, expectedOmitted)) {
      issues.push('omitted_status_changes must equal actual_changed_paths minus status_reported_changed_paths');
    }
    const expectedReportedButNotActual = sortedDifference(
      audit.status_reported_changed_paths,
      audit.actual_changed_paths,
    );
    if (!sameStringSet(audit.reported_but_not_actual_changes, expectedReportedButNotActual)) {
      issues.push('reported_but_not_actual_changes must equal status_reported_changed_paths minus actual_changed_paths');
    }
  }
  const expectedCommandGaps = sortedDifference(
    audit.declared_validation_commands,
    audit.status_reported_commands,
  );
  if (!sameStringSet(audit.command_coverage_gaps, expectedCommandGaps)) {
    issues.push('command_coverage_gaps must equal declared_validation_commands minus status_reported_commands');
  }
  const expectedClassification = expectedExecutionAuditClassification(audit);
  if (audit.classification !== expectedClassification) {
    issues.push(
      `classification ${audit.classification} does not match audit facts; expected ${expectedClassification}`,
    );
  }
  for (const ref of audit.evidence_refs) {
    issues.push(...evidenceRefIssues(ref, undefined, 'evidence_refs'));
  }
  return issues;
}

function ownershipMatrixPathIssues(matrix: AutopilotMasterPlan['ownership_matrix']): string[] {
  const issues: string[] = [];
  for (const [field, paths] of [
    ['owned_paths', matrix.owned_paths],
    ['read_only_paths', matrix.read_only_paths],
    ['untouchable_paths', matrix.untouchable_paths],
    ['held_paths', matrix.held_paths],
  ] as const) {
    issues.push(...duplicateIssues(field, paths));
    for (const path of paths) issues.push(...relativePathIssues(path, `${field} entry`));
  }
  issues.push(...intersectionIssues('owned_paths', matrix.owned_paths, 'read_only_paths', matrix.read_only_paths));
  issues.push(...intersectionIssues('owned_paths', matrix.owned_paths, 'untouchable_paths', matrix.untouchable_paths));
  return issues;
}

function verificationPlanIssues(plan: AutopilotUnitSpec['verification_plan'], label: string): string[] {
  if (plan === undefined) return [];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const [field, witnesses] of [
    ['positive_witnesses', plan.positive_witnesses],
    ['negative_witnesses', plan.negative_witnesses],
    ['regression_witnesses', plan.regression_witnesses],
    ['real_boundary_witnesses', plan.real_boundary_witnesses],
    ['blast_radius_checks', plan.blast_radius_checks],
    ['docs_schema_prompt_checks', plan.docs_schema_prompt_checks],
    ['dirty_tree_checks', plan.dirty_tree_checks],
  ] as const) {
    for (const witness of witnesses) {
      if (seen.has(witness.id)) issues.push(`${label}.${field} duplicates witness id ${JSON.stringify(witness.id)}`);
      seen.add(witness.id);
      if (witness.command === undefined && witness.inspection_target === undefined) {
        issues.push(`${label}.${field} witness ${witness.id} requires command or inspection_target`);
      }
      if (!witness.required && witness.blocker_reason === undefined) {
        issues.push(`${label}.${field} optional witness ${witness.id} requires blocker_reason`);
      }
    }
  }
  return issues;
}

function requireRecord(value: unknown, label: string, issues: string[]): JsonRecord | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  issues.push(`${label} must be an object`);
  return undefined;
}

function checkKnownKeys(
  record: JsonRecord,
  allowed: ReadonlySet<string>,
  label: string,
  issues: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) issues.push(`${label} has unexpected property ${JSON.stringify(key)}`);
  }
}

function checkRequired(
  record: JsonRecord,
  required: readonly string[],
  label: string,
  issues: string[],
): void {
  for (const key of required) {
    if (!hasKey(record, key)) issues.push(`${label} missing required property ${JSON.stringify(key)}`);
  }
}

function hasKey(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function expectConst(value: unknown, expected: string, label: string, issues: string[]): void {
  if (value !== expected) issues.push(`${label} must equal ${JSON.stringify(expected)}`);
}

function expectBoolean(value: unknown, label: string, issues: string[]): void {
  if (typeof value !== 'boolean') issues.push(`${label} must be boolean`);
}

function expectString(
  value: unknown,
  label: string,
  issues: string[],
  options: { readonly min?: number; readonly max?: number; readonly pattern?: RegExp } = {},
): void {
  if (typeof value !== 'string') {
    issues.push(`${label} must be string`);
    return;
  }
  const min = options.min ?? 1;
  if (value.length < min) issues.push(`${label} must contain at least ${String(min)} character(s)`);
  if (options.max !== undefined && value.length > options.max) {
    issues.push(`${label} must contain at most ${String(options.max)} character(s)`);
  }
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    issues.push(`${label} has invalid format`);
  }
}

function optionalString(
  record: JsonRecord,
  key: string,
  label: string,
  issues: string[],
  options: { readonly min?: number; readonly max?: number; readonly pattern?: RegExp } = {},
): void {
  if (hasKey(record, key)) expectString(record[key], label, issues, options);
}

function expectNumber(
  value: unknown,
  label: string,
  issues: string[],
  min: number,
  max: number,
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(`${label} must be number`);
    return;
  }
  if (value < min || value > max) {
    issues.push(`${label} must be between ${String(min)} and ${String(max)}`);
  }
}

function expectInteger(
  value: unknown,
  label: string,
  issues: string[],
  min: number,
  max: number,
): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    issues.push(`${label} must be integer`);
    return;
  }
  if (value < min || value > max) {
    issues.push(`${label} must be between ${String(min)} and ${String(max)}`);
  }
}

function optionalInteger(
  record: JsonRecord,
  key: string,
  label: string,
  issues: string[],
  min: number,
  max: number,
): void {
  if (hasKey(record, key)) expectInteger(record[key], label, issues, min, max);
}

function expectEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
  issues: string[],
): void {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    issues.push(`${label} must be one of ${values.join(', ')}`);
  }
}

function optionalEnum<T extends string>(
  record: JsonRecord,
  key: string,
  values: readonly T[],
  label: string,
  issues: string[],
): void {
  if (hasKey(record, key)) expectEnum(record[key], values, label, issues);
}

function expectArray(
  value: unknown,
  label: string,
  issues: string[],
  maxItems: number,
  minItems: number,
  checkItem: ValueCheck,
): void {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be array`);
    return;
  }
  if (value.length < minItems) {
    issues.push(`${label} must contain at least ${String(minItems)} item(s)`);
  }
  if (value.length > maxItems) {
    issues.push(`${label} must contain at most ${String(maxItems)} item(s)`);
  }
  value.forEach((item, index) => checkItem(item, `${label}/${String(index)}`, issues));
}

function expectStringArray(
  value: unknown,
  label: string,
  issues: string[],
  maxItems: number,
  minItems = 0,
  maxLength = 512,
  pattern?: RegExp,
): void {
  expectArray(value, label, issues, maxItems, minItems, (item, itemLabel, itemIssues) => {
    const options = pattern === undefined ? { max: maxLength } : { max: maxLength, pattern };
    expectString(item, itemLabel, itemIssues, options);
  });
}

function throwIfIssues(label: string, issues: readonly string[]): void {
  if (issues.length === 0) return;
  throw new AutopilotContractValidationError(label, issues);
}

function duplicateIssues(label: string, values: readonly string[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) issues.push(`${label} contains duplicate value ${JSON.stringify(value)}`);
    seen.add(value);
  }
  return issues;
}

function sortedDifference(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return Object.freeze(sortedUnique(left.filter((value) => !rightSet.has(value))));
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = sortedUnique(left);
  const rightSorted = sortedUnique(right);
  if (leftSorted.length !== rightSorted.length) return false;
  for (let index = 0; index < leftSorted.length; index += 1) {
    const leftValue = leftSorted[index];
    const rightValue = rightSorted[index];
    if (leftValue === undefined || rightValue === undefined || leftValue !== rightValue) return false;
  }
  return true;
}

function expectedExecutionAuditClassification(audit: AutopilotExecutionAudit): AutopilotExecutionAudit['classification'] {
  if (audit.untouchable_touched_paths.length > 0) return 'critical-protected-path-violation';
  if (audit.read_only_touched_paths.length > 0) return 'protected-path-review-required';
  if (audit.dirty_baseline === null || audit.dirty_relevant_paths.length > 0) return 'audit-unavailable';
  if (
    audit.outside_owned_paths.length > 0 ||
    audit.omitted_status_changes.length > 0 ||
    audit.reported_but_not_actual_changes.length > 0 ||
    audit.command_coverage_gaps.length > 0
  ) {
    return 'scope-review-required';
  }
  return 'clean';
}

function intersectionIssues(
  leftLabel: string,
  leftValues: readonly string[],
  rightLabel: string,
  rightValues: readonly string[],
): string[] {
  const right = new Set(rightValues);
  return leftValues
    .filter((value) => right.has(value))
    .map((value) => `${leftLabel} conflicts with ${rightLabel} at ${JSON.stringify(value)}`);
}

function relativePathIssues(pathValue: string, label: string): string[] {
  const issues: string[] = [];
  if (pathValue.includes('\0')) issues.push(`${label} must not contain NUL`);
  if (pathValue.includes('\\')) issues.push(`${label} must use POSIX separators, not backslashes`);
  if (isAbsolute(pathValue) || /^[A-Za-z]:/u.test(pathValue)) {
    issues.push(`${label} must be repo/runtime relative, not absolute`);
  }
  if (pathValue.trim() !== pathValue) {
    issues.push(`${label} must not have leading/trailing whitespace`);
  }
  if (pathValue.length === 0) issues.push(`${label} must not be empty`);
  const segments = pathValue.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    issues.push(`${label} must not contain parent/current traversal segments`);
  }
  return issues;
}

function absolutePathIssues(pathValue: string, label: string): string[] {
  const issues: string[] = [];
  if (pathValue.includes('\0')) issues.push(`${label} must not contain NUL`);
  if (!isAbsolute(pathValue)) issues.push(`${label} must be absolute`);
  if (pathValue.includes('\\')) issues.push(`${label} must use POSIX separators, not backslashes`);
  if (pathValue.trim() !== pathValue) {
    issues.push(`${label} must not have leading/trailing whitespace`);
  }
  const segments = pathValue.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    issues.push(`${label} must not contain parent/current traversal segments`);
  }
  return issues;
}

function unitSpecArtifactPathIssues(spec: AutopilotUnitSpec): string[] {
  const issues: string[] = [];
  if (absolutePathIssues(spec.cwd, 'cwd').length > 0) return issues;
  const runtimeRoot = resolve(spec.cwd, '.pi', 'autopilot', spec.workstream);
  for (const [field, pathValue, artifactDir] of [
    ['status_output', spec.status_output, resolve(runtimeRoot, 'statuses')],
    ['receipt_output', spec.receipt_output, resolve(runtimeRoot, 'receipts')],
    ['evidence_dir', spec.evidence_dir, resolve(runtimeRoot, 'evidence')],
  ] as const) {
    if (absolutePathIssues(pathValue, field).length > 0) continue;
    if (!isPathWithinRoot(artifactDir, pathValue)) {
      issues.push(`${field} must be under runtime artifact root ${JSON.stringify(artifactDir)}`);
    }
  }
  return issues;
}

function evidenceRefIssues(
  ref: AutopilotEvidenceRef,
  artifactRoot: string | undefined,
  label: string,
): string[] {
  const issues = relativePathIssues(ref.path, `${label} path`);
  if (artifactRoot === undefined) return issues;
  issues.push(...absolutePathIssues(artifactRoot, 'artifactRoot'));
  if (issues.length > 0) return issues;
  const resolved = resolve(artifactRoot, ref.path);
  if (!isPathWithinRoot(artifactRoot, resolved)) {
    issues.push(`${label} path ${JSON.stringify(ref.path)} escapes artifact root`);
    return issues;
  }
  if (!existsSync(resolved)) return issues;
  const stats = statSync(resolved);
  if (!stats.isFile()) {
    issues.push(`${label} ${JSON.stringify(ref.path)} exists but is not a file`);
    return issues;
  }
  if (ref.sha256 === undefined) {
    issues.push(`${label} ${JSON.stringify(ref.path)} exists and therefore requires sha256`);
  } else {
    const actualHash = sha256File(resolved);
    if (ref.sha256 !== actualHash) {
      issues.push(
        `${label} ${JSON.stringify(ref.path)} sha256 mismatch: expected ${actualHash}, got ${ref.sha256}`,
      );
    }
  }
  if (ref.byte_count === undefined) {
    issues.push(`${label} ${JSON.stringify(ref.path)} exists and therefore requires byte_count`);
  } else {
    const actualSize = stats.size;
    if (ref.byte_count !== actualSize) {
      issues.push(
        `${label} ${JSON.stringify(ref.path)} byte_count mismatch: expected ${String(actualSize)}, got ${String(ref.byte_count)}`,
      );
    }
  }
  return issues;
}

function isUnderOwnedPath(changedPath: string, ownedPaths: readonly string[]): boolean {
  return ownedPaths.some(
    (ownedPath) => changedPath === ownedPath || changedPath.startsWith(`${ownedPath}/`),
  );
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  return (
    rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'))
  );
}

function sha256File(pathValue: string): `sha256:${string}` {
  return sha256Buffer(readFileSync(pathValue));
}

function sha256String(value: string): `sha256:${string}` {
  return sha256Buffer(Buffer.from(value, 'utf8'));
}

function sha256Buffer(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableJsonStringify(item)).join(',')}]`;
  const record = value as JsonRecord;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

const unitSpecRequired = [
  'schema_version',
  'workstream',
  'unit_id',
  'role',
  'template',
  'attempt',
  'objective',
  'cwd',
  'model',
  'thinking',
  'owned_paths',
  'read_only_paths',
  'untouchable_paths',
  'context_refs',
  'validation_commands',
  'status_output',
  'receipt_output',
  'evidence_dir',
  'stop_boundary',
] as const;
const unitSpecKeys = new Set([
  ...unitSpecRequired,
  'quality_profile',
  'risk_level',
  'acceptance_criteria',
  'verification_plan',
  'closure_criteria',
  'upstream_refs',
  'timeout_seconds',
  'render_prompt_snapshot',
]);
const contextRefRequired = ['path', 'purpose'] as const;
const contextRefKeys = new Set([...contextRefRequired, 'sha256', 'byte_count']);
const evidenceRefRequired = ['path'] as const;
const evidenceRefKeys = new Set([...evidenceRefRequired, 'sha256', 'byte_count', 'description']);
const commandRequired = ['command', 'status', 'exit_code', 'summary'] as const;
const commandKeys = new Set([...commandRequired, 'evidence_ref']);
const witnessSpecRequired = ['id', 'expected_signal', 'required'] as const;
const witnessSpecKeys = new Set([
  ...witnessSpecRequired,
  'command',
  'inspection_target',
  'blocker_reason',
]);
const verificationPlanRequired = [
  'positive_witnesses',
  'negative_witnesses',
  'regression_witnesses',
  'real_boundary_witnesses',
  'blast_radius_checks',
  'docs_schema_prompt_checks',
  'dirty_tree_checks',
] as const;
const verificationPlanKeys = new Set(verificationPlanRequired);
const upstreamRefRequired = ['unit_id', 'purpose'] as const;
const upstreamRefKeys = new Set([...upstreamRefRequired, 'status_ref', 'audit_ref']);
const findingRequired = ['id', 'severity', 'summary'] as const;
const findingKeys = new Set([...findingRequired, 'path', 'evidence_refs']);
const statusRequired = [
  'schema_version',
  'workstream',
  'unit_id',
  'role',
  'attempt',
  'verdict',
  'severity',
  'summary',
  'changed_paths',
  'findings',
  'commands',
  'evidence_refs',
  'report_ref',
  'next_action',
] as const;
const statusKeys = new Set([...statusRequired, 'covered_witness_ids']);
const eventRequired = ['schema_version', 'id', 'ts', 'event', 'workstream', 'summary'] as const;
const eventKeys = new Set([
  ...eventRequired,
  'unit_id',
  'role',
  'verdict',
  'severity',
  'spec_ref',
  'status_ref',
  'receipt_ref',
  'evidence_ref',
]);
const contextGateRequired = ['gate', 'percent'] as const;
const contextGateKeys = new Set(contextGateRequired);
const stateUnitRequired = ['unit_id', 'role', 'state', 'attempt', 'summary'] as const;
const stateUnitKeys = new Set([...stateUnitRequired, 'spec_ref', 'status_ref', 'receipt_ref']);
const workItemRequired = ['work_item_id', 'state', 'source_changing', 'unit_ids', 'summary'] as const;
const workItemKeys = new Set([
  ...workItemRequired,
  'implementation_unit_id',
  'validation_unit_id',
  'audit_ref',
  'status_ref',
  'validation_status_ref',
]);
const scopeExceptionRequired = ['exception_id', 'unit_id', 'audit_ref', 'paths', 'state', 'summary'] as const;
const scopeExceptionKeys = new Set([...scopeExceptionRequired, 'decision_ref']);
const protectedPathExceptionRequired = [
  'exception_id',
  'unit_id',
  'audit_ref',
  'read_only_paths',
  'untouchable_paths',
  'state',
  'summary',
] as const;
const protectedPathExceptionKeys = new Set([...protectedPathExceptionRequired, 'decision_ref']);
const closureGateRequired = ['status', 'blocking_reasons', 'summary'] as const;
const closureGateKeys = new Set([
  ...closureGateRequired,
  'checked_at',
  'bughunt_status_ref',
  'decision_ref',
]);
const stateRequired = [
  'schema_version',
  'workstream',
  'updated_at',
  'status',
  'context_gate',
  'last_event_id',
  'ready_queue',
  'running',
  'blocked',
  'completed',
  'units',
  'operator_questions',
  'next_actions',
] as const;
const stateKeys = new Set([
  ...stateRequired,
  'work_items',
  'audit_review_queue',
  'validation_ready_queue',
  'scope_exceptions',
  'protected_path_exceptions',
  'closure_gate',
]);
const providerRequired = [
  'provider_id',
  'requested_model_id',
  'executed_model_id',
  'api',
  'thinking_level',
] as const;
const providerKeys = new Set(providerRequired);
const receiptRequired = [
  'schema_version',
  'tool_name',
  'workstream',
  'unit_id',
  'role',
  'attempt',
  'emitted_at',
  'status_output',
  'status_sha256',
  'schema_sha256',
  'tool_call_id',
  'provider_identity',
  'expected_identity_hash',
] as const;
const receiptKeys = new Set(receiptRequired);
const handoffRequired = [
  'schema_version',
  'workstream',
  'written_at',
  'reason',
  'mission_ref',
  'master_plan_ref',
  'decision_tail_ref',
  'latest_decision_id',
  'state_ref',
  'event_tail_ref',
  'status_refs',
  'audit_refs',
  'summary',
  'open_blockers',
  'next_actions',
] as const;
const handoffKeys = new Set(handoffRequired);
const masterPlanLaneRequired = ['lane_id', 'summary', 'unit_ids'] as const;
const masterPlanLaneKeys = new Set(masterPlanLaneRequired);
const masterPlanUnitRequired = ['unit_id', 'role', 'state', 'dependencies', 'summary'] as const;
const masterPlanUnitKeys = new Set(masterPlanUnitRequired);
const ownershipMatrixRequired = [
  'owned_paths',
  'read_only_paths',
  'untouchable_paths',
  'held_paths',
] as const;
const ownershipMatrixKeys = new Set(ownershipMatrixRequired);
const masterPlanRequired = [
  'schema_version',
  'workstream',
  'mission_ref',
  'goal_summary',
  'non_goals',
  'definition_of_done',
  'risk_level',
  'lanes',
  'units',
  'ownership_matrix',
  'verification_matrix',
  'closure_criteria',
  'current_focus',
  'last_decision_id',
  'last_event_id',
  'updated_at',
] as const;
const masterPlanKeys = new Set(masterPlanRequired);
const decisionRowRequired = [
  'schema_version',
  'id',
  'ts',
  'event',
  'workstream',
  'summary',
  'decision',
] as const;
const decisionRowKeys = new Set([
  ...decisionRowRequired,
  'unit_id',
  'master_plan_ref',
  'evidence_refs',
]);
const executionAuditRequired = [
  'schema_version',
  'workstream',
  'unit_id',
  'role',
  'attempt',
  'audited_at',
  'cwd',
  'git_head',
  'dirty_baseline',
  'dirty_baseline_paths',
  'dirty_relevant_paths',
  'actual_changed_paths',
  'status_reported_changed_paths',
  'omitted_status_changes',
  'reported_but_not_actual_changes',
  'outside_owned_paths',
  'read_only_touched_paths',
  'untouchable_touched_paths',
  'declared_validation_commands',
  'status_reported_commands',
  'command_coverage_gaps',
  'classification',
  'evidence_refs',
  'summary',
] as const;
const executionAuditKeys = new Set(executionAuditRequired);

