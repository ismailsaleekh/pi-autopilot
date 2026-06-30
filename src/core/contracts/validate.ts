import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

import {
  AUTOPILOT_JSON_SCHEMAS,
  AUTOPILOT_STATUS_ENTRY_JSON_SCHEMA,
  type JsonMap,
} from './schemas.ts';
import {
  AUTOPILOT_COMMAND_STATUS_VALUES,
  AUTOPILOT_CONTEXT_GATE_VALUES,
  AUTOPILOT_EVENT_TYPE_VALUES,
  AUTOPILOT_HANDOFF_REASON_VALUES,
  AUTOPILOT_ROLE_VALUES,
  AUTOPILOT_SEVERITY_VALUES,
  AUTOPILOT_TEMPLATE_VALUES,
  AUTOPILOT_THINKING_VALUES,
  AUTOPILOT_UNIT_STATE_VALUES,
  AUTOPILOT_VERDICT_VALUES,
  AUTOPILOT_WORKSTREAM_STATUS_VALUES,
  type AutopilotEventRow,
  type AutopilotEvidenceRef,
  type AutopilotHandoff,
  type AutopilotReceipt,
  type AutopilotRole,
  type AutopilotState,
  type AutopilotStatusEntry,
  type AutopilotUnitSpec,
  type AutopilotVerdict,
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
    expectString(record['state_ref'], '/state_ref', issues, { max: 512 });
    if (record['event_tail_ref'] !== null) {
      expectString(record['event_tail_ref'], '/event_tail_ref', issues, { max: 512 });
    }
    expectStringArray(record['status_refs'], '/status_refs', issues, 500);
    expectString(record['summary'], '/summary', issues, { max: 1000 });
    expectStringArray(record['open_blockers'], '/open_blockers', issues, 80, 0, 500);
    expectStringArray(record['next_actions'], '/next_actions', issues, 80, 0, 500);
  }
  throwIfIssues('AutopilotHandoff', issues);
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
  if (status.verdict === 'PASS' && status.commands.some((command) => command.status === 'failed')) {
    issues.push('PASS statuses must not include failed commands');
  }
  if (
    status.verdict === 'PASS' &&
    status.commands.some((command) => command.exit_code !== null && command.exit_code !== 0)
  ) {
    issues.push('PASS statuses must not include non-zero command exit codes');
  }
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
  return issues;
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
  issues.push(...relativePathIssues(handoff.state_ref, 'state_ref'));
  if (handoff.event_tail_ref !== null) {
    issues.push(...relativePathIssues(handoff.event_tail_ref, 'event_tail_ref'));
  }
  for (const statusRef of handoff.status_refs) {
    issues.push(...relativePathIssues(statusRef, 'status_refs entry'));
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
const unitSpecKeys = new Set([...unitSpecRequired, 'timeout_seconds', 'render_prompt_snapshot']);
const contextRefRequired = ['path', 'purpose'] as const;
const contextRefKeys = new Set([...contextRefRequired, 'sha256', 'byte_count']);
const evidenceRefRequired = ['path'] as const;
const evidenceRefKeys = new Set([...evidenceRefRequired, 'sha256', 'byte_count', 'description']);
const commandRequired = ['command', 'status', 'exit_code', 'summary'] as const;
const commandKeys = new Set([...commandRequired, 'evidence_ref']);
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
const statusKeys = new Set(statusRequired);
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
const stateKeys = new Set(stateRequired);
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
  'state_ref',
  'event_tail_ref',
  'status_refs',
  'summary',
  'open_blockers',
  'next_actions',
] as const;
const handoffKeys = new Set(handoffRequired);

