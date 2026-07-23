import type { AutopilotRosterContractBySchemaVersion } from '../contracts/types.ts';
import {
  AutopilotRosterCanonicalizationError,
  parseRosterJsonWithDuplicateKeyRejection,
  sha256Utf8,
} from './canonical.ts';
import {
  AUTOPILOT_ROSTER_PACKAGE_VERSION_TARGET,
  makeAutopilotRosterDiagnostic,
  parseAutopilotHistoricalFixedRosterAdapterAdmission,
  parseAutopilotHistoricalFixedRosterAdapterRequest,
  parseAutopilotHistoricalFixedRosterAdapterResult,
  parseAutopilotRosterContract,
  computeAutopilotRosterContractObjectHash,
} from './contracts.ts';

export const AUTOPILOT_HISTORICAL_FIXED_ROSTER_CHAIN_ID =
  'openai-codex-sol-terra-luna-v1' as const;

export const AUTOPILOT_HISTORICAL_FIXED_ROSTER_SELECTION = Object.freeze({
  selected_scope: 'user',
  selected_roster_id: 'cruise-codex-subscription-bdb4f15f0ff9',
  selected_roster_revision: 1,
  selected_roster_sha256: 'sha256:f3ac0895d9abedfbe3616a79af0c1c3691962d24d5f17d195a78e6ab24d2b4a0',
  assignment_set_sha256: 'sha256:bdb4f15f0ff90aff9d1e46a3a56bfdfddabafcf3c7f5c293a7b558ff2f22a3c4',
  selection_identity_sha256: 'sha256:929e7ab3f4bdfc35a47c071fcdcd51d5d797b88c6a701f1529118492442a5a13',
} as const);

type HistoricalRequest = AutopilotRosterContractBySchemaVersion['autopilot.historical_fixed_roster_adapter_request.v1'];
type HistoricalAdmission = AutopilotRosterContractBySchemaVersion['autopilot.historical_fixed_roster_adapter_admission.v1'];
type HistoricalResult = AutopilotRosterContractBySchemaVersion['autopilot.historical_fixed_roster_adapter_result.v1'];
type HistoricalRole = AutopilotRosterContractBySchemaVersion['autopilot.historical_fixed_roster_role.v1'];
type HistoricalAdmissionReason = HistoricalAdmission['reason'];
type HistoricalDiagnosticCode =
  | 'ROSTER_HISTORICAL_V1_BYTES_PRESERVED'
  | 'ROSTER_HISTORICAL_PROOF_REQUIRED'
  | 'ROSTER_HISTORICAL_SELECTION_PRESENT'
  | 'ROSTER_HISTORICAL_VERSION_UNSUPPORTED'
  | 'ROSTER_HISTORICAL_FIXED_ROSTER_MISMATCH'
  | 'ROSTER_HISTORICAL_CONFLICTING_EVIDENCE';

interface ParsedHistoricalEvidence {
  readonly unit: Readonly<Record<string, unknown>> | null;
  readonly receipt: Readonly<Record<string, unknown>> | null;
  readonly roles: readonly HistoricalRole[];
  readonly proofOk: boolean;
  readonly versionSupported: boolean;
  readonly fixedRosterMatches: boolean;
}

const FIXED_HISTORICAL_ROLES: readonly HistoricalRole[] = Object.freeze([
  historicalRole('parent', 'gpt-5.6-sol', 'xhigh'),
  historicalRole('strategy', 'gpt-5.6-sol', 'xhigh'),
  historicalRole('implement', 'gpt-5.6-terra', 'high'),
  historicalRole('validate', 'gpt-5.6-sol', 'xhigh'),
  historicalRole('fix', 'gpt-5.6-terra', 'high'),
  historicalRole('adjudicate', 'gpt-5.6-sol', 'xhigh'),
  historicalRole('bughunt', 'gpt-5.6-sol', 'xhigh'),
  historicalRole('extract', 'gpt-5.6-luna', 'high'),
]);

const UNIT_KEYS = new Set([
  'schema_version',
  'package_version',
  'pi_version',
  'repo_id',
  'workstream_run',
  'fixed_roster_chain_id',
  'fixed_roster',
  'created_at',
]);
const RECEIPT_KEYS = new Set([
  'schema_version',
  'package_version',
  'pi_version',
  'repo_id',
  'workstream_run',
  'unit_spec_sha256',
  'fixed_roster_chain_id',
  'observed_fixed_roster',
  'status',
  'emitted_at',
]);
const ROLE_KEYS = new Set(['role', 'provider_id', 'model_id', 'model', 'api', 'thinking']);
const HISTORICAL_ROLE_NAMES = new Set<HistoricalRole['role']>([
  'parent',
  'strategy',
  'implement',
  'validate',
  'fix',
  'adjudicate',
  'bughunt',
  'extract',
]);
const HISTORICAL_API_VALUES = new Set<HistoricalRole['api']>([
  'openai-codex-responses',
  'anthropic-messages',
  'openai-completions',
]);
const HISTORICAL_THINKING_VALUES = new Set<HistoricalRole['thinking']>(['high', 'xhigh']);
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;

export function adaptHistoricalFixedRosterEvidence(value: unknown): HistoricalResult {
  const request = parseAutopilotHistoricalFixedRosterAdapterRequest(value);
  return adaptHistoricalFixedRosterRequest(request);
}

export function adaptHistoricalFixedRosterRequest(request: HistoricalRequest): HistoricalResult {
  const evidence = parseHistoricalEvidence(request);
  const reason = historicalAdmissionReason(request, evidence);
  const admitted = reason === 'admitted';
  const admission = buildAdmission(request, evidence, reason, admitted);
  const diagnostics = diagnosticCodesForReason(reason).map((code) =>
    makeAutopilotRosterDiagnostic(code, code === 'ROSTER_HISTORICAL_V1_BYTES_PRESERVED' ? 'info' : 'error'),
  );
  const resultRecord: Record<string, unknown> = {
    schema_version: 'autopilot.historical_fixed_roster_adapter_result.v1',
    action: 'historical-adapter',
    ok: admitted,
    status: admitted ? 'inspected' : 'blocked',
    admission,
    selected_scope: admitted ? AUTOPILOT_HISTORICAL_FIXED_ROSTER_SELECTION.selected_scope : null,
    selected_roster_id: admitted ? AUTOPILOT_HISTORICAL_FIXED_ROSTER_SELECTION.selected_roster_id : null,
    selected_roster_revision: admitted ? AUTOPILOT_HISTORICAL_FIXED_ROSTER_SELECTION.selected_roster_revision : null,
    selected_roster_sha256: admitted ? AUTOPILOT_HISTORICAL_FIXED_ROSTER_SELECTION.selected_roster_sha256 : null,
    assignment_set_sha256: admitted ? AUTOPILOT_HISTORICAL_FIXED_ROSTER_SELECTION.assignment_set_sha256 : null,
    selection_identity_sha256: admitted ? AUTOPILOT_HISTORICAL_FIXED_ROSTER_SELECTION.selection_identity_sha256 : null,
    historical_unit_spec_sha256: request.historical_unit_spec_sha256,
    historical_receipt_sha256: request.historical_receipt_sha256,
    historical_bytes_mutated: false,
    diagnostics,
    write_count: 0,
    lock_count: 0,
    files_touched: [],
    result_sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  resultRecord['result_sha256'] = requiredHash(
    'autopilot.historical_fixed_roster_adapter_result.v1',
    resultRecord,
  );
  return parseAutopilotHistoricalFixedRosterAdapterResult(resultRecord);
}

export function historicalFixedRosterRoles(): readonly HistoricalRole[] {
  return FIXED_HISTORICAL_ROLES;
}

function buildAdmission(
  request: HistoricalRequest,
  evidence: ParsedHistoricalEvidence,
  reason: HistoricalAdmissionReason,
  admitted: boolean,
): HistoricalAdmission {
  const admissionRecord: Record<string, unknown> = {
    schema_version: 'autopilot.historical_fixed_roster_adapter_admission.v1',
    admitted,
    reason,
    unit_schema_version: 'autopilot.unit_spec.v1',
    receipt_schema_version: 'autopilot.receipt.v1',
    package_version_upper_bound_exclusive: AUTOPILOT_ROSTER_PACKAGE_VERSION_TARGET,
    historical_unit_spec_sha256: request.historical_unit_spec_sha256,
    historical_receipt_sha256: request.historical_receipt_sha256,
    pre_run_selection_absent: preRunSelectionAbsent(request),
    fixed_roster_chain_id: AUTOPILOT_HISTORICAL_FIXED_ROSTER_CHAIN_ID,
    roles: evidence.roles,
    no_conflicting_evidence: request.conflicting_evidence_sha256s.length === 0,
    historical_bytes_mutated: false,
    admission_sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  admissionRecord['admission_sha256'] = requiredHash(
    'autopilot.historical_fixed_roster_adapter_admission.v1',
    admissionRecord,
  );
  return parseAutopilotHistoricalFixedRosterAdapterAdmission(admissionRecord);
}

function parseHistoricalEvidence(request: HistoricalRequest): ParsedHistoricalEvidence {
  const unitDigest = sha256Utf8(request.historical_unit_spec_bytes_utf8);
  const receiptDigest = sha256Utf8(request.historical_receipt_bytes_utf8);
  if (unitDigest !== request.historical_unit_spec_sha256 || receiptDigest !== request.historical_receipt_sha256) {
    return {
      unit: null,
      receipt: null,
      roles: FIXED_HISTORICAL_ROLES,
      proofOk: false,
      versionSupported: false,
      fixedRosterMatches: false,
    };
  }
  const unit = parseHistoricalJsonObject(request.historical_unit_spec_bytes_utf8);
  const receipt = parseHistoricalJsonObject(request.historical_receipt_bytes_utf8);
  if (unit === null || receipt === null) {
    return {
      unit,
      receipt,
      roles: FIXED_HISTORICAL_ROLES,
      proofOk: false,
      versionSupported: false,
      fixedRosterMatches: false,
    };
  }
  const unitRoles = parseHistoricalRoleArray(unit['fixed_roster']);
  const receiptRoles = parseHistoricalRoleArray(receipt['observed_fixed_roster']);
  const roles = unitRoles ?? receiptRoles ?? FIXED_HISTORICAL_ROLES;
  const proofOk =
    hasOnlyKeys(unit, UNIT_KEYS) &&
    hasOnlyKeys(receipt, RECEIPT_KEYS) &&
    unit['schema_version'] === 'autopilot.unit_spec.v1' &&
    receipt['schema_version'] === 'autopilot.receipt.v1' &&
    receipt['unit_spec_sha256'] === request.historical_unit_spec_sha256 &&
    unit['repo_id'] === request.repo_id &&
    receipt['repo_id'] === request.repo_id &&
    unit['workstream_run'] === request.workstream_run &&
    receipt['workstream_run'] === request.workstream_run;
  const versionSupported =
    typeof unit['package_version'] === 'string' &&
    typeof receipt['package_version'] === 'string' &&
    semverLessThan(unit['package_version'], AUTOPILOT_ROSTER_PACKAGE_VERSION_TARGET) &&
    semverLessThan(receipt['package_version'], AUTOPILOT_ROSTER_PACKAGE_VERSION_TARGET);
  const fixedRosterMatches =
    unit['fixed_roster_chain_id'] === AUTOPILOT_HISTORICAL_FIXED_ROSTER_CHAIN_ID &&
    receipt['fixed_roster_chain_id'] === AUTOPILOT_HISTORICAL_FIXED_ROSTER_CHAIN_ID &&
    unitRoles !== null &&
    receiptRoles !== null &&
    sameHistoricalRoles(unitRoles, FIXED_HISTORICAL_ROLES) &&
    sameHistoricalRoles(receiptRoles, FIXED_HISTORICAL_ROLES) &&
    sameHistoricalRoles(unitRoles, receiptRoles);
  return { unit, receipt, roles, proofOk, versionSupported, fixedRosterMatches };
}

function historicalAdmissionReason(
  request: HistoricalRequest,
  evidence: ParsedHistoricalEvidence,
): HistoricalAdmissionReason {
  if (!evidence.proofOk) return 'proof-required';
  if (!evidence.versionSupported) return 'historical-version-unsupported';
  if (!preRunSelectionAbsent(request)) return 'pre-run-selection-present';
  if (!evidence.fixedRosterMatches) return 'fixed-roster-mismatch';
  if (request.conflicting_evidence_sha256s.length > 0) return 'conflicting-evidence';
  return 'admitted';
}

function diagnosticCodesForReason(reason: HistoricalAdmissionReason): readonly HistoricalDiagnosticCode[] {
  if (reason === 'admitted') return ['ROSTER_HISTORICAL_V1_BYTES_PRESERVED'];
  if (reason === 'proof-required') return ['ROSTER_HISTORICAL_PROOF_REQUIRED'];
  if (reason === 'historical-version-unsupported') {
    return ['ROSTER_HISTORICAL_PROOF_REQUIRED', 'ROSTER_HISTORICAL_VERSION_UNSUPPORTED'];
  }
  if (reason === 'pre-run-selection-present') return ['ROSTER_HISTORICAL_SELECTION_PRESENT'];
  if (reason === 'fixed-roster-mismatch') return ['ROSTER_HISTORICAL_FIXED_ROSTER_MISMATCH'];
  return ['ROSTER_HISTORICAL_CONFLICTING_EVIDENCE'];
}

function preRunSelectionAbsent(request: HistoricalRequest): boolean {
  return request.pre_run_selection_state === 'absent' && request.pre_run_selection_sha256 === null;
}

function parseHistoricalJsonObject(text: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed = parseRosterJsonWithDuplicateKeyRejection(text);
    return recordValue(parsed);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof AutopilotRosterCanonicalizationError) return null;
    throw error;
  }
}

function parseHistoricalRoleArray(value: unknown): readonly HistoricalRole[] | null {
  if (!Array.isArray(value) || value.length !== FIXED_HISTORICAL_ROLES.length) return null;
  const roles: HistoricalRole[] = [];
  const seenRoles = new Set<HistoricalRole['role']>();
  for (const item of value) {
    const record = recordValue(item);
    if (record === null || !hasExactKeys(record, ROLE_KEYS)) return null;
    const parsedRole = parseHistoricalRoleRecord(record);
    if (parsedRole === null || seenRoles.has(parsedRole.role)) return null;
    seenRoles.add(parsedRole.role);
    roles.push(parsedRole);
  }
  return Object.freeze(roles);
}

function parseHistoricalRoleRecord(record: Readonly<Record<string, unknown>>): HistoricalRole | null {
  const role = record['role'];
  const providerId = record['provider_id'];
  const modelId = record['model_id'];
  const model = record['model'];
  const api = record['api'];
  const thinking = record['thinking'];
  if (
    !isHistoricalRoleName(role) ||
    !isProviderId(providerId) ||
    !isModelId(modelId) ||
    model !== `${providerId}/${modelId}` ||
    !isHistoricalApi(api) ||
    !isHistoricalThinking(thinking)
  ) {
    return null;
  }
  return parseAutopilotRosterContract('autopilot.historical_fixed_roster_role.v1', {
    schema_version: 'autopilot.historical_fixed_roster_role.v1',
    role,
    provider_id: providerId,
    model_id: modelId,
    model,
    api,
    thinking,
  });
}

function isHistoricalRoleName(value: unknown): value is HistoricalRole['role'] {
  return typeof value === 'string' && (HISTORICAL_ROLE_NAMES as ReadonlySet<string>).has(value);
}

function isHistoricalApi(value: unknown): value is HistoricalRole['api'] {
  return typeof value === 'string' && (HISTORICAL_API_VALUES as ReadonlySet<string>).has(value);
}

function isHistoricalThinking(value: unknown): value is HistoricalRole['thinking'] {
  return typeof value === 'string' && (HISTORICAL_THINKING_VALUES as ReadonlySet<string>).has(value);
}

function isProviderId(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_ID_PATTERN.test(value);
}

function isModelId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value);
}

function historicalRole(
  role: HistoricalRole['role'],
  modelId: string,
  thinking: HistoricalRole['thinking'],
): HistoricalRole {
  return parseAutopilotRosterContract('autopilot.historical_fixed_roster_role.v1', {
    schema_version: 'autopilot.historical_fixed_roster_role.v1',
    role,
    provider_id: 'openai-codex',
    model_id: modelId,
    model: `openai-codex/${modelId}`,
    api: 'openai-codex-responses',
    thinking,
  });
}

function sameHistoricalRoles(left: readonly HistoricalRole[], right: readonly HistoricalRole[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftRole = left[index];
    const rightRole = right[index];
    if (leftRole === undefined || rightRole === undefined) return false;
    if (
      leftRole.role !== rightRole.role ||
      leftRole.provider_id !== rightRole.provider_id ||
      leftRole.model_id !== rightRole.model_id ||
      leftRole.model !== rightRole.model ||
      leftRole.api !== rightRole.api ||
      leftRole.thinking !== rightRole.thinking
    ) {
      return false;
    }
  }
  return true;
}

function semverLessThan(left: string, right: string): boolean {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  if (leftParts === null || rightParts === null) return false;
  for (let index = 0; index < leftParts.length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined || rightPart === undefined) return false;
    if (leftPart < rightPart) return true;
    if (leftPart > rightPart) return false;
  }
  return false;
}

function parseSemver(value: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) return null;
  return [major, minor, patch];
}

function requiredHash(schemaVersion: Parameters<typeof computeAutopilotRosterContractObjectHash>[0], value: unknown): string {
  const hash = computeAutopilotRosterContractObjectHash(schemaVersion, value);
  if (hash === null) throw new Error(`${schemaVersion} does not carry a hash field`);
  return hash;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function hasOnlyKeys(record: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(record);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}
