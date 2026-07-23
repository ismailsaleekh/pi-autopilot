import type { AutopilotRosterContractBySchemaVersion } from '../contracts/types.ts';
import {
  adaptHistoricalFixedRosterRequest,
} from './historical-adapter.ts';
import {
  computeAutopilotRosterContractObjectHash,
  makeAutopilotRosterDiagnostic,
  parseAutopilotHistoricalFixedRosterAdapterRequest,
  parseAutopilotHistoricalFixedRosterAdapterResult,
  parseAutopilotReceiptV2,
  parseAutopilotRosterContract,
  parseAutopilotUnitSpecV2,
} from './contracts.ts';
import {
  canonicalRosterJson,
  parseRosterJsonWithDuplicateKeyRejection,
  sha256Utf8,
} from './canonical.ts';

export type AutopilotRuntimeArtifactKind = 'unit-spec' | 'receipt';
export type AutopilotUnitSpecArtifactSchemaVersion = 'autopilot.unit_spec.v1' | 'autopilot.unit_spec.v2';
export type AutopilotReceiptArtifactSchemaVersion = 'autopilot.receipt.v1' | 'autopilot.receipt.v2';
export type AutopilotRuntimeArtifactSchemaVersion =
  | AutopilotUnitSpecArtifactSchemaVersion
  | AutopilotReceiptArtifactSchemaVersion;

export type AutopilotRosterReceiptValidationResultV1 = AutopilotRosterContractBySchemaVersion['autopilot.receipt_validation_result.v1'];
export type AutopilotRosterHistoricalAdapterResultV1 = AutopilotRosterContractBySchemaVersion['autopilot.historical_fixed_roster_adapter_result.v1'];
export type AutopilotRosterUnitSpecV2 = AutopilotRosterContractBySchemaVersion['autopilot.unit_spec.v2'];
export type AutopilotRosterReceiptV2 = AutopilotRosterContractBySchemaVersion['autopilot.receipt.v2'];

export class AutopilotRosterArtifactCompatibilityError extends Error {
  public readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'AutopilotRosterArtifactCompatibilityError';
    this.reason = reason;
  }
}

export interface AutopilotHistoricalV1ArtifactAdmissionInput {
  readonly kind: AutopilotRuntimeArtifactKind;
  readonly bytes_utf8: string;
  readonly adapter_result: unknown;
}

export interface AutopilotHistoricalV1ArtifactAdmission {
  readonly kind: AutopilotRuntimeArtifactKind;
  readonly schema_version: 'autopilot.unit_spec.v1' | 'autopilot.receipt.v1';
  readonly bytes_sha256: string;
  readonly historical_bytes_mutated: false;
}

export interface AutopilotRetryResumeArtifactCompatibilityInput {
  readonly kind: AutopilotRuntimeArtifactKind;
  readonly original_bytes_utf8: string;
  readonly next_bytes_utf8: string;
  readonly historical_adapter_result?: unknown;
}

export interface AutopilotReceiptV2TerminalCompatibilityInput {
  readonly unit_spec_bytes_utf8: string;
  readonly receipt_bytes_utf8: string;
  readonly terminal_acceptance: unknown;
}

interface TerminalAcceptanceFacts {
  readonly schema_version: 'autopilot.child_terminal_acceptance.v1';
  readonly workstream: string;
  readonly unit_id: string;
  readonly role: string;
  readonly attempt: number;
  readonly transport_result: 'accepted';
  readonly spec: EvidenceRef;
  readonly receipt: EvidenceRef;
  readonly tool_call_id: string;
  readonly carrier_status_sha256: string;
}

interface EvidenceRef {
  readonly ref: string;
  readonly sha256: string;
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const UNIT_SPEC_V2_SELECTION_FIELDS = [
  'roster_id',
  'roster_revision',
  'roster_sha256',
  'assignment_sha256',
  'pre_run_selection_sha256',
] as const;
const V2_RETRY_IDENTITY_FIELDS = ['workstream', 'unit_id', 'role'] as const;
const TERMINAL_ACCEPTANCE_FIELDS = [
  'schema_version',
  'repo_id',
  'autopilot_id',
  'workstream',
  'workstream_run',
  'unit_id',
  'role',
  'attempt',
  'child_lease_id',
  'verdict',
  'transport_result',
  'spec',
  'status',
  'receipt',
  'audit',
  'tool_call_id',
  'carrier_status_sha256',
  'audit_disposition',
  'created_at',
] as const;

export function artifactSchemaVersionFromBytes(
  kind: AutopilotRuntimeArtifactKind,
  bytesUtf8: string,
): AutopilotRuntimeArtifactSchemaVersion {
  const record = parseArtifactJsonRecord(bytesUtf8, `${kind} artifact`);
  const schemaVersion = record['schema_version'];
  if (kind === 'unit-spec') {
    if (schemaVersion === 'autopilot.unit_spec.v1' || schemaVersion === 'autopilot.unit_spec.v2') return schemaVersion;
  } else if (schemaVersion === 'autopilot.receipt.v1' || schemaVersion === 'autopilot.receipt.v2') {
    return schemaVersion;
  }
  throw new AutopilotRosterArtifactCompatibilityError(`${kind} artifact schema_version is not compatible with ${kind}`);
}

export function parseNewRunUnitSpecV2ArtifactBytes(bytesUtf8: string): AutopilotRosterUnitSpecV2 {
  const schemaVersion = artifactSchemaVersionFromBytes('unit-spec', bytesUtf8);
  if (schemaVersion !== 'autopilot.unit_spec.v2') {
    throw new AutopilotRosterArtifactCompatibilityError('new-run unit_spec.v1 creation is forbidden; v1 is historical evidence only');
  }
  return parseAutopilotUnitSpecV2(parseArtifactJsonRecord(bytesUtf8, 'new-run unit_spec.v2'));
}

export function parseNewRunReceiptV2ArtifactBytes(bytesUtf8: string): AutopilotRosterReceiptV2 {
  const schemaVersion = artifactSchemaVersionFromBytes('receipt', bytesUtf8);
  if (schemaVersion !== 'autopilot.receipt.v2') {
    throw new AutopilotRosterArtifactCompatibilityError('new-run receipt.v1 creation is forbidden; v1 is historical evidence only');
  }
  return parseAutopilotReceiptV2(parseArtifactJsonRecord(bytesUtf8, 'new-run receipt.v2'));
}

export function inspectHistoricalFixedRosterV1Request(requestValue: unknown): AutopilotRosterHistoricalAdapterResultV1 {
  const request = parseAutopilotHistoricalFixedRosterAdapterRequest(requestValue);
  const unitBytesBefore = request.historical_unit_spec_bytes_utf8;
  const receiptBytesBefore = request.historical_receipt_bytes_utf8;
  const result = adaptHistoricalFixedRosterRequest(request);
  if (request.historical_unit_spec_bytes_utf8 !== unitBytesBefore || request.historical_receipt_bytes_utf8 !== receiptBytesBefore) {
    throw new AutopilotRosterArtifactCompatibilityError('historical adapter mutated supplied v1 bytes');
  }
  return result;
}

export function acceptHistoricalFixedRosterV1Request(requestValue: unknown): AutopilotRosterHistoricalAdapterResultV1 {
  const request = parseAutopilotHistoricalFixedRosterAdapterRequest(requestValue);
  const result = inspectHistoricalFixedRosterV1Request(request);
  assertHistoricalAdapterResultMatchesBytes(result, request.historical_unit_spec_bytes_utf8, request.historical_receipt_bytes_utf8);
  if (result.ok !== true || result.admission.admitted !== true || result.admission.reason !== 'admitted') {
    throw new AutopilotRosterArtifactCompatibilityError('historical v1 artifacts were not admitted by the proven adapter');
  }
  return result;
}

export function assertHistoricalAdapterResultMatchesBytes(
  resultValue: unknown,
  unitSpecBytesUtf8: string,
  receiptBytesUtf8: string,
): asserts resultValue is AutopilotRosterHistoricalAdapterResultV1 {
  const result = parseAutopilotHistoricalFixedRosterAdapterResult(resultValue);
  const unitDigest = sha256Utf8(unitSpecBytesUtf8);
  const receiptDigest = sha256Utf8(receiptBytesUtf8);
  if (result.historical_unit_spec_sha256 !== unitDigest || result.admission.historical_unit_spec_sha256 !== unitDigest) {
    throw new AutopilotRosterArtifactCompatibilityError('historical adapter unit_spec byte digest does not match supplied bytes');
  }
  if (result.historical_receipt_sha256 !== receiptDigest || result.admission.historical_receipt_sha256 !== receiptDigest) {
    throw new AutopilotRosterArtifactCompatibilityError('historical adapter receipt byte digest does not match supplied bytes');
  }
  if (result.historical_bytes_mutated !== false || result.admission.historical_bytes_mutated !== false) {
    throw new AutopilotRosterArtifactCompatibilityError('historical adapter result relabeled or mutated v1 bytes');
  }
}

export function assertHistoricalV1ArtifactAcceptedOnlyThroughAdapter(
  input: AutopilotHistoricalV1ArtifactAdmissionInput,
): AutopilotHistoricalV1ArtifactAdmission {
  const schemaVersion = artifactSchemaVersionFromBytes(input.kind, input.bytes_utf8);
  const expectedSchema = input.kind === 'unit-spec' ? 'autopilot.unit_spec.v1' : 'autopilot.receipt.v1';
  if (schemaVersion !== expectedSchema) {
    throw new AutopilotRosterArtifactCompatibilityError(`${input.kind} historical admission requires ${expectedSchema} bytes`);
  }
  const result = parseAutopilotHistoricalFixedRosterAdapterResult(input.adapter_result);
  if (result.ok !== true || result.admission.admitted !== true || result.admission.reason !== 'admitted') {
    throw new AutopilotRosterArtifactCompatibilityError('historical v1 bytes require a proven admitted adapter result');
  }
  const digest = sha256Utf8(input.bytes_utf8);
  const adapterDigest = input.kind === 'unit-spec' ? result.historical_unit_spec_sha256 : result.historical_receipt_sha256;
  if (adapterDigest !== digest) {
    throw new AutopilotRosterArtifactCompatibilityError(`${input.kind} historical byte digest does not match adapter proof`);
  }
  if (result.historical_bytes_mutated !== false || result.admission.historical_bytes_mutated !== false) {
    throw new AutopilotRosterArtifactCompatibilityError('historical v1 adapter proof indicates byte mutation');
  }
  return Object.freeze({
    kind: input.kind,
    schema_version: expectedSchema,
    bytes_sha256: digest,
    historical_bytes_mutated: false as const,
  });
}

export function assertHistoricalV1BytesNotRelabeled(input: {
  readonly kind: AutopilotRuntimeArtifactKind;
  readonly historical_bytes_utf8: string;
  readonly candidate_bytes_utf8: string;
}): void {
  const schemaVersion = artifactSchemaVersionFromBytes(input.kind, input.historical_bytes_utf8);
  const expectedSchema = input.kind === 'unit-spec' ? 'autopilot.unit_spec.v1' : 'autopilot.receipt.v1';
  if (schemaVersion !== expectedSchema) {
    throw new AutopilotRosterArtifactCompatibilityError('historical v1 byte immutability check requires v1 source bytes');
  }
  if (input.historical_bytes_utf8 !== input.candidate_bytes_utf8) {
    throw new AutopilotRosterArtifactCompatibilityError('historical v1 artifacts must remain byte-immutable; relabeling or enrichment is forbidden');
  }
}

export function assertRetryResumeArtifactCompatibility(
  input: AutopilotRetryResumeArtifactCompatibilityInput,
): void {
  const originalSchema = artifactSchemaVersionFromBytes(input.kind, input.original_bytes_utf8);
  const nextSchema = artifactSchemaVersionFromBytes(input.kind, input.next_bytes_utf8);
  if (originalSchema === 'autopilot.unit_spec.v1' || originalSchema === 'autopilot.receipt.v1') {
    if (input.historical_adapter_result === undefined) {
      throw new AutopilotRosterArtifactCompatibilityError('retry/resume of historical v1 artifacts requires proven adapter admission');
    }
    assertHistoricalV1ArtifactAcceptedOnlyThroughAdapter({
      kind: input.kind,
      bytes_utf8: input.original_bytes_utf8,
      adapter_result: input.historical_adapter_result,
    });
    if (nextSchema !== originalSchema || input.next_bytes_utf8 !== input.original_bytes_utf8) {
      throw new AutopilotRosterArtifactCompatibilityError('retry/resume of historical v1 artifacts must preserve the original schema and exact bytes');
    }
    return;
  }
  if (nextSchema !== originalSchema) {
    throw new AutopilotRosterArtifactCompatibilityError('retry/resume must preserve the original artifact schema_version');
  }
  if (input.kind === 'unit-spec') {
    const original = parseAutopilotUnitSpecV2(parseArtifactJsonRecord(input.original_bytes_utf8, 'original unit_spec.v2'));
    const next = parseAutopilotUnitSpecV2(parseArtifactJsonRecord(input.next_bytes_utf8, 'next unit_spec.v2'));
    assertV2UnitSpecRetryPreservesSelection(original, next);
    return;
  }
  const original = parseAutopilotReceiptV2(parseArtifactJsonRecord(input.original_bytes_utf8, 'original receipt.v2'));
  const next = parseAutopilotReceiptV2(parseArtifactJsonRecord(input.next_bytes_utf8, 'next receipt.v2'));
  assertV2ReceiptRetryPreservesSelection(original, next);
}

export function validateReceiptV2TerminalCompatibility(
  input: AutopilotReceiptV2TerminalCompatibilityInput,
): AutopilotRosterReceiptValidationResultV1 {
  const codes: string[] = [];
  const specSha256 = sha256Utf8(input.unit_spec_bytes_utf8);
  const receiptSha256 = sha256Utf8(input.receipt_bytes_utf8);
  const spec = parseUnitSpecV2ForValidation(input.unit_spec_bytes_utf8, codes);
  const receipt = parseReceiptV2ForValidation(input.receipt_bytes_utf8, codes);
  const terminalAcceptance = parseTerminalAcceptanceForValidation(input.terminal_acceptance, codes);

  if (spec !== null && receipt !== null) {
    compareSpecAndReceipt(spec, receipt, codes);
  }
  if (spec !== null && receipt !== null && terminalAcceptance !== null) {
    compareTerminalAcceptance(spec, specSha256, receipt, receiptSha256, terminalAcceptance, codes);
  }
  return materializeReceiptValidationResult(codes);
}

function parseUnitSpecV2ForValidation(bytesUtf8: string, codes: string[]): AutopilotRosterUnitSpecV2 | null {
  try {
    const schemaVersion = artifactSchemaVersionFromBytes('unit-spec', bytesUtf8);
    if (schemaVersion !== 'autopilot.unit_spec.v2') {
      codes.push('ROSTER_ARTIFACT_SCHEMA_UNSUPPORTED');
      return null;
    }
    return parseAutopilotUnitSpecV2(parseArtifactJsonRecord(bytesUtf8, 'unit_spec.v2 validation'));
  } catch (error) {
    codes.push(...diagnosticCodesForArtifactError(error));
    return null;
  }
}

function parseReceiptV2ForValidation(bytesUtf8: string, codes: string[]): AutopilotRosterReceiptV2 | null {
  try {
    const schemaVersion = artifactSchemaVersionFromBytes('receipt', bytesUtf8);
    if (schemaVersion !== 'autopilot.receipt.v2') {
      codes.push('ROSTER_ARTIFACT_SCHEMA_UNSUPPORTED');
      return null;
    }
    return parseAutopilotReceiptV2(parseArtifactJsonRecord(bytesUtf8, 'receipt.v2 validation'));
  } catch (error) {
    codes.push(...diagnosticCodesForArtifactError(error));
    return null;
  }
}

function parseTerminalAcceptanceForValidation(value: unknown, codes: string[]): TerminalAcceptanceFacts | null {
  try {
    return parseTerminalAcceptanceFacts(value);
  } catch (_error) {
    codes.push('ROSTER_TERMINAL_ACCEPTANCE_INCOMPATIBLE');
    return null;
  }
}

function compareSpecAndReceipt(
  spec: AutopilotRosterUnitSpecV2,
  receipt: AutopilotRosterReceiptV2,
  codes: string[],
): void {
  for (const field of ['workstream', 'unit_id', 'role', 'attempt', 'status_output'] as const) {
    if (receipt[field] !== spec[field]) codes.push('ROSTER_TERMINAL_ACCEPTANCE_INCOMPATIBLE');
  }
  for (const field of UNIT_SPEC_V2_SELECTION_FIELDS) {
    if (receipt[field] !== spec[field]) codes.push('ROSTER_PINNED_SELECTION_UNAVAILABLE');
  }
  if (!jsonEqual(receipt.request_profile, spec.request_profile)) codes.push('ROSTER_REQUEST_PROFILE_DRIFT');
  if (receipt.request_profile.request_profile_sha256 !== spec.request_profile.request_profile_sha256) {
    codes.push('ROSTER_REQUEST_PROFILE_DRIFT');
  }
  if (receipt.request_profile.model_id !== spec.request_profile.model_id) codes.push('ROSTER_OBSERVED_MODEL_MISMATCH');
  if (receipt.request_profile.thinking !== spec.request_profile.thinking) codes.push('ROSTER_OBSERVED_THINKING_MISMATCH');
}

function compareTerminalAcceptance(
  spec: AutopilotRosterUnitSpecV2,
  specSha256: string,
  receipt: AutopilotRosterReceiptV2,
  receiptSha256: string,
  terminalAcceptance: TerminalAcceptanceFacts,
  codes: string[],
): void {
  if (terminalAcceptance.transport_result !== 'accepted') codes.push('ROSTER_TERMINAL_ACCEPTANCE_INCOMPATIBLE');
  for (const field of ['workstream', 'unit_id', 'role', 'attempt'] as const) {
    if (terminalAcceptance[field] !== spec[field] || terminalAcceptance[field] !== receipt[field]) {
      codes.push('ROSTER_TERMINAL_ACCEPTANCE_INCOMPATIBLE');
    }
  }
  if (terminalAcceptance.tool_call_id !== receipt.tool_call_id) codes.push('ROSTER_TERMINAL_ACCEPTANCE_INCOMPATIBLE');
  if (terminalAcceptance.carrier_status_sha256 !== receipt.status_sha256) codes.push('ROSTER_TERMINAL_ACCEPTANCE_INCOMPATIBLE');
  if (terminalAcceptance.spec.sha256 !== specSha256 || terminalAcceptance.receipt.sha256 !== receiptSha256) {
    codes.push('ROSTER_READBACK_MISMATCH');
  }
}

function assertV2UnitSpecRetryPreservesSelection(
  original: AutopilotRosterUnitSpecV2,
  next: AutopilotRosterUnitSpecV2,
): void {
  for (const field of V2_RETRY_IDENTITY_FIELDS) {
    if (next[field] !== original[field]) {
      throw new AutopilotRosterArtifactCompatibilityError(`retry/resume unit_spec.v2 ${field} changed`);
    }
  }
  for (const field of UNIT_SPEC_V2_SELECTION_FIELDS) {
    if (next[field] !== original[field]) {
      throw new AutopilotRosterArtifactCompatibilityError(`retry/resume unit_spec.v2 ${field} changed`);
    }
  }
  if (next.request_profile.request_profile_sha256 !== original.request_profile.request_profile_sha256) {
    throw new AutopilotRosterArtifactCompatibilityError('retry/resume unit_spec.v2 request_profile_sha256 changed');
  }
}

function assertV2ReceiptRetryPreservesSelection(
  original: AutopilotRosterReceiptV2,
  next: AutopilotRosterReceiptV2,
): void {
  for (const field of V2_RETRY_IDENTITY_FIELDS) {
    if (next[field] !== original[field]) {
      throw new AutopilotRosterArtifactCompatibilityError(`retry/resume receipt.v2 ${field} changed`);
    }
  }
  for (const field of UNIT_SPEC_V2_SELECTION_FIELDS) {
    if (next[field] !== original[field]) {
      throw new AutopilotRosterArtifactCompatibilityError(`retry/resume receipt.v2 ${field} changed`);
    }
  }
  if (next.request_profile.request_profile_sha256 !== original.request_profile.request_profile_sha256) {
    throw new AutopilotRosterArtifactCompatibilityError('retry/resume receipt.v2 request_profile_sha256 changed');
  }
}

function parseTerminalAcceptanceFacts(value: unknown): TerminalAcceptanceFacts {
  const record = recordValue(value, 'terminal acceptance');
  assertExactKeys(record, TERMINAL_ACCEPTANCE_FIELDS, 'terminal acceptance');
  if (record['schema_version'] !== 'autopilot.child_terminal_acceptance.v1') {
    throw new AutopilotRosterArtifactCompatibilityError('terminal acceptance schema_version is incompatible');
  }
  if (record['transport_result'] !== 'accepted') {
    throw new AutopilotRosterArtifactCompatibilityError('terminal acceptance transport_result is not accepted');
  }
  const attempt = record['attempt'];
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new AutopilotRosterArtifactCompatibilityError('terminal acceptance attempt must be positive integer');
  }
  const carrierStatusSha256 = stringField(record, 'carrier_status_sha256', 'terminal acceptance');
  if (!SHA256_PATTERN.test(carrierStatusSha256)) {
    throw new AutopilotRosterArtifactCompatibilityError('terminal acceptance carrier_status_sha256 is invalid');
  }
  return Object.freeze({
    schema_version: 'autopilot.child_terminal_acceptance.v1' as const,
    workstream: stringField(record, 'workstream', 'terminal acceptance'),
    unit_id: stringField(record, 'unit_id', 'terminal acceptance'),
    role: stringField(record, 'role', 'terminal acceptance'),
    attempt,
    transport_result: 'accepted' as const,
    spec: evidenceRef(record['spec'], 'terminal acceptance spec'),
    receipt: evidenceRef(record['receipt'], 'terminal acceptance receipt'),
    tool_call_id: stringField(record, 'tool_call_id', 'terminal acceptance'),
    carrier_status_sha256: carrierStatusSha256,
  });
}

function evidenceRef(value: unknown, label: string): EvidenceRef {
  const record = recordValue(value, label);
  assertExactKeys(record, ['ref', 'sha256'], label);
  const sha256 = stringField(record, 'sha256', label);
  if (!SHA256_PATTERN.test(sha256)) throw new AutopilotRosterArtifactCompatibilityError(`${label} sha256 is invalid`);
  return Object.freeze({ ref: stringField(record, 'ref', label), sha256 });
}

function materializeReceiptValidationResult(codes: readonly string[]): AutopilotRosterReceiptValidationResultV1 {
  const uniqueCodes = [...new Set(codes)].sort((left, right) => left.localeCompare(right));
  const record: Record<string, unknown> = {
    schema_version: 'autopilot.receipt_validation_result.v1',
    action: 'validate-receipt',
    ok: uniqueCodes.length === 0,
    status: uniqueCodes.length === 0 ? 'inspected' : 'failed',
    diagnostics: uniqueCodes.map((code) => makeAutopilotRosterDiagnostic(code, 'error')),
    write_count: 0,
    lock_count: 0,
    files_touched: [],
    result_sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  record['result_sha256'] = requiredHash('autopilot.receipt_validation_result.v1', record);
  return parseAutopilotRosterContract('autopilot.receipt_validation_result.v1', record);
}

function diagnosticCodesForArtifactError(error: unknown): readonly string[] {
  const message = error instanceof Error ? error.message : String(error);
  const codes: string[] = [];
  if (/unexpected property|duplicate object member/u.test(message)) codes.push('ROSTER_ARTIFACT_UNKNOWN_FIELD');
  if (/schema_version|compatible|unsupported/u.test(message)) codes.push('ROSTER_ARTIFACT_SCHEMA_UNSUPPORTED');
  if (/missing required property|must not be null|must be string|must be integer|must be array|must be an object|undefined/u.test(message)) {
    codes.push('ROSTER_ARTIFACT_MISSING_FACT');
  }
  if (/hash mismatch|sha256|digest/u.test(message)) codes.push('ROSTER_READBACK_MISMATCH');
  if (/executed_model_id|requested_model_id|model must equal|provider_identity requested_model_id|provider_identity executed_model_id/u.test(message)) {
    codes.push('ROSTER_OBSERVED_MODEL_MISMATCH');
  }
  if (/thinking/u.test(message)) codes.push('ROSTER_OBSERVED_THINKING_MISMATCH');
  if (/request_profile|observed_profile|api|service_tier|cache_policy|system_prompt_profile|route_policy/u.test(message)) {
    codes.push('ROSTER_REQUEST_PROFILE_DRIFT');
  }
  if (codes.length === 0) codes.push('ROSTER_ARTIFACT_MISSING_FACT');
  return codes;
}

function parseArtifactJsonRecord(bytesUtf8: string, label: string): Readonly<Record<string, unknown>> {
  try {
    return recordValue(parseRosterJsonWithDuplicateKeyRejection(bytesUtf8), label);
  } catch (error) {
    if (error instanceof AutopilotRosterArtifactCompatibilityError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new AutopilotRosterArtifactCompatibilityError(`${label} is not duplicate-safe JSON object: ${detail}`);
  }
}

function recordValue(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return value as Readonly<Record<string, unknown>>;
  }
  throw new AutopilotRosterArtifactCompatibilityError(`${label} must be a JSON object`);
}

function assertExactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[], label: string): void {
  const expected = [...keys].sort((left, right) => left.localeCompare(right));
  const actual = Object.keys(record).sort((left, right) => left.localeCompare(right));
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new AutopilotRosterArtifactCompatibilityError(`${label} fields are not exact`);
  }
}

function stringField(record: Readonly<Record<string, unknown>>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length < 1) {
    throw new AutopilotRosterArtifactCompatibilityError(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function requiredHash(
  schemaVersion: Parameters<typeof computeAutopilotRosterContractObjectHash>[0],
  value: unknown,
): string {
  const hash = computeAutopilotRosterContractObjectHash(schemaVersion, value);
  if (hash === null) throw new AutopilotRosterArtifactCompatibilityError(`${schemaVersion} does not carry a hash field`);
  return hash;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalRosterJson(left) === canonicalRosterJson(right);
}
