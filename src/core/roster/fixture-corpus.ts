import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

export type RosterFixtureCorpusErrorCode =
  | 'digest-drift'
  | 'invalid-json'
  | 'closed-field-violation'
  | 'canonical-drift'
  | 'fixture-contract-violation'
  | 'mutation-guard';

export class RosterFixtureCorpusError extends Error {
  public readonly code: RosterFixtureCorpusErrorCode;
  public readonly details: readonly string[];

  public constructor(code: RosterFixtureCorpusErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'RosterFixtureCorpusError';
    this.code = code;
    this.details = details;
  }
}

export interface Phase37CanonicalVector extends JsonObject {
  readonly vector_id: string;
  readonly hash_omission_field: string;
  readonly canonical_json_utf8: string;
  readonly sha256: string;
}

export interface Phase37FixtureCase extends JsonObject {
  readonly fixture_id: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly inputs: JsonObject;
  readonly expected: JsonObject;
  readonly filesystem_postconditions: readonly JsonObject[];
  readonly fixture_case_sha256: string;
}

export interface Phase37W0AcceptanceCorpus extends JsonObject {
  readonly schema_version: 'autopilot.phase37_w0_roster_acceptance_fixtures.v1';
  readonly freeze_id: 'phase37-roster-w0-2026-07-22';
  readonly fixture_id: 'phase37-roster-w0-acceptance-fixtures-v1';
  readonly status: 'w1-ready-fixture-authority';
  readonly authority_boundary: JsonObject;
  readonly evidence_notice: JsonObject;
  readonly canonicalization: JsonObject;
  readonly fixed_values: JsonObject;
  readonly diagnostic_code_registry: readonly string[];
  readonly object_registry: JsonObject;
  readonly canonical_vectors: readonly Phase37CanonicalVector[];
  readonly fixture_cases: readonly Phase37FixtureCase[];
}

export interface Phase37W0FixtureCorpusLoadResult {
  readonly source: string;
  readonly sha256: string;
  readonly syntheticOnly: true;
  readonly providerEvidenceCertifying: false;
  readonly corpus: Phase37W0AcceptanceCorpus;
  readonly fixtureIds: readonly string[];
  readonly canonicalVectorIds: readonly string[];
  readonly diagnosticCodes: readonly string[];
  readonly getCase: (fixtureId: string) => Phase37FixtureCase;
  readonly getCanonicalVector: (vectorId: string) => Phase37CanonicalVector;
}

interface LoadOptions {
  readonly path: string | URL;
  readonly expectedSha256?: string;
  readonly maximumBytes?: number;
}

interface ParseOptions {
  readonly source: string;
  readonly expectedSha256: string;
}

type ObjectExpect = 'keyOrEnd' | 'colon' | 'value' | 'commaOrEnd';
type ArrayExpect = 'valueOrEnd' | 'commaOrEnd';
interface ObjectScanFrame {
  readonly kind: 'object';
  readonly keys: Set<string>;
  expect: ObjectExpect;
}
interface ArrayScanFrame {
  readonly kind: 'array';
  expect: ArrayExpect;
}
type ScanFrame = ObjectScanFrame | ArrayScanFrame;

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const UTF8_ENCODER = new TextEncoder();

const MAXIMUM_CORPUS_BYTES = 1_000_000;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const UTC_MS_Z_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

export const PHASE37_W0_FIXTURE_CORPUS_SHA256 = 'sha256:7cec874aaeb4b8bec699e0b0f0a9968b39ef925e859a99ad6b9f0f357fba1b73';
export const PHASE37_W0_FIXTURE_CORPUS_SCHEMA_VERSION = 'autopilot.phase37_w0_roster_acceptance_fixtures.v1';
export const PHASE37_W0_FIXTURE_CORPUS_FREEZE_ID = 'phase37-roster-w0-2026-07-22';
export const PHASE37_W0_FIXTURE_CORPUS_ID = 'phase37-roster-w0-acceptance-fixtures-v1';
export const PHASE37_W0_FIXTURE_CORPUS_CANONICAL_ALGORITHM = 'autopilot.phase37.canonical-json.sha256.v1';
export const PHASE37_W0_FIXTURE_CASE_COUNT = 25;
export const PHASE37_W0_FIXTURE_CANONICAL_VECTOR_COUNT = 44;

const TOP_LEVEL_KEYS = [
  'schema_version',
  'freeze_id',
  'fixture_id',
  'status',
  'authority_boundary',
  'evidence_notice',
  'canonicalization',
  'fixed_values',
  'diagnostic_code_registry',
  'object_registry',
  'canonical_vectors',
  'fixture_cases',
] as const;

const AUTHORITY_BOUNDARY_KEYS = ['binds_to', 'forbidden_bindings', 'synthetic_ready_rule'] as const;
const EVIDENCE_NOTICE_KEYS = [
  'all_provider_inventory_auth_and_certification_facts_are',
  'provider_evidence_is_certifying',
  'secrets_included',
  'live_provider_calls_required',
] as const;
const CANONICALIZATION_KEYS = ['algorithm_id', 'definition_freeze_id', 'terminal_lf', 'digest_encoding'] as const;
const FIXED_VALUES_KEYS = [
  'clock',
  'clock_later',
  'clock_transition',
  'repo_id',
  'workstream',
  'workstream_run',
  'state_root_kind',
  'state_root',
  'production_default_user_state_root',
  'trusted_project',
  'untrusted_project',
] as const;
const OBJECT_REGISTRY_KEYS = [
  'route_policies',
  'provider_recipes',
  'inventories',
  'synthetic_candidate_set',
  'synthetic_config',
  'synthetic_receipt',
  'synthetic_pre_run_selection',
  'historical_artifacts',
  'historical_adapter_request',
  'historical_adapter_admission',
  'historical_adapter_result',
  'fixture_registry',
] as const;
const CANONICAL_VECTOR_KEYS = ['vector_id', 'hash_omission_field', 'canonical_json_utf8', 'sha256'] as const;
const FIXTURE_CASE_KEYS = [
  'fixture_id',
  'description',
  'tags',
  'inputs',
  'expected',
  'filesystem_postconditions',
  'fixture_case_sha256',
] as const;

const EXPECTED_DIAGNOSTIC_CODES = [
  'ROSTER_AUTH_REQUIRED',
  'ROSTER_AUTH_CHANNEL_FORBIDDEN',
  'ROSTER_ROUTE_FORBIDDEN',
  'ROSTER_PROJECT_UNTRUSTED',
  'ROSTER_PROPOSAL_REJECTED',
  'ROSTER_APPROVAL_STALE_CANDIDATE_SET',
  'ROSTER_APPROVAL_STALE_CONFIG',
  'ROSTER_PRIORITY_PROOF_REQUIRED',
  'ROSTER_PUBLICATION_INTERRUPTED_CONFIG_MISSING',
  'ROSTER_RECEIPT_REPLAY_REQUIRED',
  'ROSTER_CONVERGED_ASSIGNMENT_SET',
  'ROSTER_EXPLICIT_CHOICE_REQUIRED',
  'ROSTER_RECOMMENDED_PROFILE_BLOCKED',
  'ROSTER_TRANSITION_REQUIRED',
  'ROSTER_PINNED_SELECTION_UNAVAILABLE',
  'ROSTER_HISTORICAL_V1_BYTES_PRESERVED',
  'ROSTER_REQUEST_PROFILE_DRIFT',
  'ROSTER_OBSERVED_MODEL_MISMATCH',
  'ROSTER_OBSERVED_THINKING_MISMATCH',
  'ROSTER_QUALIFICATION_REQUIRED',
  'ROSTER_CREATE_ONLY_CONFLICT',
  'ROSTER_SELECTION_IDEMPOTENT_REPLAY',
  'ROSTER_STORAGE_TRUST_REQUIRED',
  'ROSTER_CONFIG_CAS_MISMATCH',
  'ROSTER_READBACK_MISMATCH',
  'ROSTER_LOCK_STALE_PROCESS_UNPROVEN',
  'ROSTER_HISTORICAL_PROOF_REQUIRED',
  'ROSTER_HISTORICAL_SELECTION_PRESENT',
  'ROSTER_HISTORICAL_VERSION_UNSUPPORTED',
  'ROSTER_HISTORICAL_FIXED_ROSTER_MISMATCH',
  'ROSTER_HISTORICAL_CONFLICTING_EVIDENCE',
] as const;

const REQUIRED_TAGS = [
  'no-auth',
  'forbidden-route',
  'untrusted-project-read',
  'untrusted-project-write',
  'proposal-zero-write',
  'reject-zero-write',
  'stale-candidate-hash',
  'stale-config-cas',
  'config-last-success',
  'crash-before-config',
  'convergence',
  'blocked-cruise-explicit-choice',
  'existing-selection-default-drift',
  'unavailable-pinned-transition',
  'historical-v1-preserved',
  'request-profile-drift',
  'observed-model-mismatch',
  'create-only-selection-conflict',
  'idempotent-selection-replay',
  'storage-readback-mismatch',
  'historical-selection-present-rejected',
  'historical-version-unsupported-rejected',
  'historical-fixed-roster-mismatch-rejected',
  'historical-conflicting-evidence-rejected',
] as const;

const EXPECTED_VECTOR_IDS = [
  'route-policy.codex-subscription-v1',
  'provider-recipe.codex-subscription-v1',
  'assignment.parent.codex-sol-xhigh.v1',
  'assignment.implement.codex-terra-high.v1',
  'assignment.extract.codex-luna-high.v1',
  'registry.provider-recipes.v1',
  'inventory.qualified-codex.synthetic.v1',
  'inventory.codex-no-auth.synthetic.v1',
  'candidate-set.qualified-codex.synthetic.v1',
  'roster.cruise-codex.synthetic.v1',
  'config.success.synthetic.v1',
  'receipt.success.synthetic.v1',
  'pre-run-selection.success.synthetic.v1',
  'historical-artifact.valid-v1-unit-spec',
  'historical-artifact.valid-v1-receipt',
  'historical-adapter.request.valid-v1',
  'historical-adapter.admission.valid-v1',
  'historical-adapter.result.valid-v1',
  'fixture-case.inspect.no-auth.zero-write',
  'fixture-case.propose.openrouter.forbidden',
  'fixture-case.inspect.untrusted-project.read-fails',
  'fixture-case.save.untrusted-project.write-fails',
  'fixture-case.propose.qualified-codex.zero-write',
  'fixture-case.reject.proposal.zero-write',
  'fixture-case.save.stale-candidate-hash.before-lock',
  'fixture-case.save.stale-config-cas.before-lock',
  'fixture-case.save.config-last.success',
  'fixture-case.save.crash-before-config.no-default',
  'fixture-case.propose.converged.precision-cruise',
  'fixture-case.propose.cruise-blocked.explicit-choice',
  'fixture-case.resolve.existing-selection.default-drift-ignored',
  'fixture-case.resolve.unavailable-pinned-transition-required',
  'fixture-case.historical.v1.bytes-preserved',
  'fixture-case.historical.v1.selection-present.fail-closed',
  'fixture-case.historical.v1.version-unsupported.fail-closed',
  'fixture-case.historical.v1.fixed-roster-mismatch.fail-closed',
  'fixture-case.historical.v1.conflicting-evidence.fail-closed',
  'fixture-case.receipt.request-profile-drift',
  'fixture-case.receipt.observed-model-mismatch',
  'fixture-case.receipt.observed-thinking-mismatch',
  'fixture-case.selection.create-only.conflict',
  'fixture-case.selection.create-only.idempotent-replay',
  'fixture-case.save.readback-mismatch.rollback-required',
  'registry.fixture-cases.v1',
] as const;

const EXPECTED_FIXTURE_IDS = [
  'inspect.no-auth.zero-write',
  'propose.openrouter.forbidden',
  'inspect.untrusted-project.read-fails',
  'save.untrusted-project.write-fails',
  'propose.qualified-codex.zero-write',
  'reject.proposal.zero-write',
  'save.stale-candidate-hash.before-lock',
  'save.stale-config-cas.before-lock',
  'save.config-last.success',
  'save.crash-before-config.no-default',
  'propose.converged.precision-cruise',
  'propose.cruise-blocked.explicit-choice',
  'resolve.existing-selection.default-drift-ignored',
  'resolve.unavailable-pinned-transition-required',
  'historical.v1.bytes-preserved',
  'historical.v1.selection-present.fail-closed',
  'historical.v1.version-unsupported.fail-closed',
  'historical.v1.fixed-roster-mismatch.fail-closed',
  'historical.v1.conflicting-evidence.fail-closed',
  'receipt.request-profile-drift',
  'receipt.observed-model-mismatch',
  'receipt.observed-thinking-mismatch',
  'selection.create-only.conflict',
  'selection.create-only.idempotent-replay',
  'save.readback-mismatch.rollback-required',
] as const;

const FIXED_VALUES: Readonly<Record<(typeof FIXED_VALUES_KEYS)[number], string>> = {
  clock: '2026-07-22T12:00:00.000Z',
  clock_later: '2026-07-22T12:00:05.000Z',
  clock_transition: '2026-07-22T12:01:00.000Z',
  repo_id: 'repo-phase37-w0-fixtures',
  workstream: 'phase37',
  workstream_run: 'phase37-w0-run-001',
  state_root_kind: 'constructor-injected-test-root',
  state_root: '/tmp/phase37-w0-fixtures/state',
  production_default_user_state_root: '~/.pi/agent/autopilot/',
  trusted_project: '/tmp/phase37-w0-fixtures/trusted-project',
  untrusted_project: '/tmp/phase37-w0-fixtures/untrusted-project',
};

const HASH_FIELD_TO_SCHEMA_VECTOR_PREFIX: Readonly<Record<string, string>> = {
  route_policy_sha256: 'route-policy.',
  recipe_sha256: 'provider-recipe.',
  inventory_sha256: 'inventory.',
  candidate_set_sha256: 'candidate-set.',
  config_sha256: 'config.',
  receipt_sha256: 'receipt.',
  selection_sha256: 'pre-run-selection.',
  artifact_sha256: 'historical-artifact.',
  request_sha256: 'historical-adapter.request.',
  admission_sha256: 'historical-adapter.admission.',
  result_sha256: 'historical-adapter.result.',
  fixture_registry_sha256: 'registry.fixture-cases.',
  fixture_case_sha256: 'fixture-case.',
};

const EXPECTED_SAVE_ACCOUNTING: Readonly<Record<string, { readonly writeCount: number; readonly lockCount: number; readonly fileCount: number }>> = {
  'save.config-last.success': { writeCount: 3, lockCount: 1, fileCount: 3 },
  'save.crash-before-config.no-default': { writeCount: 2, lockCount: 1, fileCount: 2 },
  'save.readback-mismatch.rollback-required': { writeCount: 3, lockCount: 1, fileCount: 3 },
};

function fail(code: RosterFixtureCorpusErrorCode, message: string, details: readonly string[] = []): never {
  throw new RosterFixtureCorpusError(code, message, details);
}

function assertCondition(condition: boolean, code: RosterFixtureCorpusErrorCode, message: string, details: readonly string[] = []): void {
  if (!condition) fail(code, message, details);
}

function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sha256Utf8(text: string): string {
  return sha256Bytes(UTF8_ENCODER.encode(text));
}

function assertDigest(value: string, path: string): void {
  assertCondition(DIGEST_PATTERN.test(value), 'fixture-contract-violation', `${path} must be sha256:<64 lowercase hex>`, [value]);
}

function assertUtcMs(value: string, path: string): void {
  assertCondition(UTC_MS_Z_PATTERN.test(value), 'fixture-contract-violation', `${path} must be a fixed UTC millisecond timestamp`, [value]);
}

function decodeUtf8(bytes: Uint8Array, source: string): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    fail('invalid-json', `${source} is not fatal UTF-8`, [error instanceof Error ? error.message : String(error)]);
  }
}

function readImmutableBoundedBytes(path: string | URL, maximumBytes: number, source: string): Uint8Array {
  let descriptor: number | null = null;
  try {
    const before = lstatSync(path);
    assertCondition(before.isFile() && !before.isSymbolicLink(), 'fixture-contract-violation', `${source} must be a regular non-symbolic fixture file`);
    assertCondition(before.size > 0 && before.size <= maximumBytes, 'fixture-contract-violation', `${source} fixture byte size is outside the deterministic loader bound`, [`size=${String(before.size)}`, `maximum=${String(maximumBytes)}`]);
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    assertCondition(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, 'fixture-contract-violation', `${source} fixture identity changed while opening`);
    const bytes = new Uint8Array(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const readCount = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (readCount === 0) break;
      offset += readCount;
    }
    const after = fstatSync(descriptor);
    assertCondition(offset === bytes.byteLength && after.isFile() && after.dev === opened.dev && after.ino === opened.ino && after.size === opened.size, 'fixture-contract-violation', `${source} fixture identity changed during read`);
    return bytes;
  } catch (error) {
    if (error instanceof RosterFixtureCorpusError) throw error;
    fail('fixture-contract-violation', `${source} fixture could not be read deterministically`, [error instanceof Error ? error.message : String(error)]);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  fail('fixture-contract-violation', `${source} fixture read reached an unreachable state`);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'boolean') return true;
  if (valueType === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !isJsonValue(value[index])) return false;
    }
    return true;
  }
  if (valueType !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return Object.values(record).every((entry) => isJsonValue(entry));
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function skipWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/u.test(text[cursor] ?? '')) cursor += 1;
  return cursor;
}

function lastFrame(stack: readonly ScanFrame[]): ScanFrame | undefined {
  return stack[stack.length - 1];
}

function assertCanStartValue(stack: readonly ScanFrame[], rootSeen: boolean, source: string, index: number): void {
  const frame = lastFrame(stack);
  if (frame === undefined) {
    if (rootSeen) fail('invalid-json', `${source} has trailing root value`, [`index=${String(index)}`]);
    return;
  }
  if (frame.kind === 'object' && frame.expect === 'value') return;
  if (frame.kind === 'array' && frame.expect === 'valueOrEnd') return;
  fail('invalid-json', `${source} has unexpected value`, [`index=${String(index)}`]);
}

function markValueComplete(stack: readonly ScanFrame[], rootSeen: boolean, source: string, index: number): boolean {
  const frame = lastFrame(stack);
  if (frame === undefined) {
    if (rootSeen) fail('invalid-json', `${source} has multiple root values`, [`index=${String(index)}`]);
    return true;
  }
  if (frame.kind === 'object') {
    if (frame.expect !== 'value') fail('invalid-json', `${source} has object value in ${frame.expect} state`, [`index=${String(index)}`]);
    frame.expect = 'commaOrEnd';
    return rootSeen;
  }
  if (frame.expect !== 'valueOrEnd') fail('invalid-json', `${source} has array value in ${frame.expect} state`, [`index=${String(index)}`]);
  frame.expect = 'commaOrEnd';
  return rootSeen;
}

function parseStringToken(text: string, index: number, source: string): { readonly value: string; readonly next: number } {
  let cursor = index + 1;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === undefined) break;
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (char === '"') {
      const raw = text.slice(index, cursor + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        fail('invalid-json', `${source} has invalid string token`, [error instanceof Error ? error.message : String(error), `index=${String(index)}`]);
      }
      if (typeof parsed !== 'string') fail('invalid-json', `${source} string token did not parse as a string`);
      return { value: parsed, next: cursor + 1 };
    }
    cursor += 1;
  }
  fail('invalid-json', `${source} has unterminated string token`, [`index=${String(index)}`]);
}

function skipNumberToken(text: string, index: number, source: string): number {
  const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(index));
  if (match === null) fail('invalid-json', `${source} has invalid number token`, [`index=${String(index)}`]);
  return index + match[0].length;
}

function assertNoDuplicateObjectKeys(text: string, source: string): void {
  const stack: ScanFrame[] = [];
  let rootSeen = false;
  let index = 0;
  while (index < text.length) {
    index = skipWhitespace(text, index);
    if (index >= text.length) break;
    const char = text[index];
    if (char === undefined) fail('invalid-json', `${source} scanner reached an impossible byte`);
    const frame = lastFrame(stack);
    if (char === '{') {
      assertCanStartValue(stack, rootSeen, source, index);
      stack.push({ kind: 'object', keys: new Set<string>(), expect: 'keyOrEnd' });
      index += 1;
      continue;
    }
    if (char === '[') {
      assertCanStartValue(stack, rootSeen, source, index);
      stack.push({ kind: 'array', expect: 'valueOrEnd' });
      index += 1;
      continue;
    }
    if (char === '}') {
      if (frame === undefined || frame.kind !== 'object') fail('invalid-json', `${source} has unmatched }`, [`index=${String(index)}`]);
      if (frame.expect !== 'keyOrEnd' && frame.expect !== 'commaOrEnd') fail('invalid-json', `${source} closes object while expecting ${frame.expect}`, [`index=${String(index)}`]);
      stack.pop();
      rootSeen = markValueComplete(stack, rootSeen, source, index);
      index += 1;
      continue;
    }
    if (char === ']') {
      if (frame === undefined || frame.kind !== 'array') fail('invalid-json', `${source} has unmatched ]`, [`index=${String(index)}`]);
      if (frame.expect !== 'valueOrEnd' && frame.expect !== 'commaOrEnd') fail('invalid-json', `${source} closes array while expecting ${frame.expect}`, [`index=${String(index)}`]);
      stack.pop();
      rootSeen = markValueComplete(stack, rootSeen, source, index);
      index += 1;
      continue;
    }
    if (char === ':') {
      if (frame === undefined || frame.kind !== 'object' || frame.expect !== 'colon') fail('invalid-json', `${source} has unexpected colon`, [`index=${String(index)}`]);
      frame.expect = 'value';
      index += 1;
      continue;
    }
    if (char === ',') {
      if (frame === undefined || frame.expect !== 'commaOrEnd') fail('invalid-json', `${source} has unexpected comma`, [`index=${String(index)}`]);
      frame.expect = frame.kind === 'object' ? 'keyOrEnd' : 'valueOrEnd';
      index += 1;
      continue;
    }
    if (char === '"') {
      const token = parseStringToken(text, index, source);
      if (frame !== undefined && frame.kind === 'object' && frame.expect === 'keyOrEnd') {
        if (frame.keys.has(token.value)) fail('invalid-json', `${source} has duplicate object key`, [token.value]);
        frame.keys.add(token.value);
        frame.expect = 'colon';
      } else {
        assertCanStartValue(stack, rootSeen, source, index);
        rootSeen = markValueComplete(stack, rootSeen, source, index);
      }
      index = token.next;
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      assertCanStartValue(stack, rootSeen, source, index);
      index = skipNumberToken(text, index, source);
      rootSeen = markValueComplete(stack, rootSeen, source, index);
      continue;
    }
    if (text.startsWith('true', index) || text.startsWith('null', index)) {
      assertCanStartValue(stack, rootSeen, source, index);
      index += 4;
      rootSeen = markValueComplete(stack, rootSeen, source, index);
      continue;
    }
    if (text.startsWith('false', index)) {
      assertCanStartValue(stack, rootSeen, source, index);
      index += 5;
      rootSeen = markValueComplete(stack, rootSeen, source, index);
      continue;
    }
    fail('invalid-json', `${source} has unexpected token`, [`token=${char}`, `index=${String(index)}`]);
  }
  if (stack.length !== 0) fail('invalid-json', `${source} has unclosed JSON containers`);
  if (!rootSeen) fail('invalid-json', `${source} contains no JSON root value`);
}

function parseJsonObject(text: string, source: string): JsonObject {
  assertNoDuplicateObjectKeys(text, source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail('invalid-json', `${source} is not valid JSON`, [error instanceof Error ? error.message : String(error)]);
  }
  if (!isJsonValue(parsed)) fail('invalid-json', `${source} is not an RFC-8259 JSON value`);
  if (!isJsonObject(parsed)) fail('invalid-json', `${source} root must be an object`);
  return parsed;
}

function at(object: JsonObject, key: string, path: string): JsonValue {
  const value = object[key];
  if (value === undefined) fail('closed-field-violation', `${path}.${key} is missing`);
  return value;
}

function requireJsonObjectValue(value: JsonValue, path: string): JsonObject {
  if (!isJsonObject(value)) fail('fixture-contract-violation', `${path} must be an object`);
  return value;
}

function objectAt(object: JsonObject, key: string, path: string): JsonObject {
  return requireJsonObjectValue(at(object, key, path), `${path}.${key}`);
}

function asArray(value: JsonValue, path: string): readonly JsonValue[] {
  if (!Array.isArray(value)) fail('fixture-contract-violation', `${path} must be an array`);
  return value;
}

function arrayAt(object: JsonObject, key: string, path: string): readonly JsonValue[] {
  return asArray(at(object, key, path), `${path}.${key}`);
}

function asString(value: JsonValue, path: string): string {
  if (typeof value !== 'string') fail('fixture-contract-violation', `${path} must be a string`);
  return value;
}

function stringAt(object: JsonObject, key: string, path: string): string {
  return asString(at(object, key, path), `${path}.${key}`);
}

function asBoolean(value: JsonValue, path: string): boolean {
  if (typeof value !== 'boolean') fail('fixture-contract-violation', `${path} must be a boolean`);
  return value;
}

function booleanAt(object: JsonObject, key: string, path: string): boolean {
  return asBoolean(at(object, key, path), `${path}.${key}`);
}

function asInteger(value: JsonValue, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('fixture-contract-violation', `${path} must be a safe integer`);
  return value;
}

function integerAt(object: JsonObject, key: string, path: string): number {
  return asInteger(at(object, key, path), `${path}.${key}`);
}

function optionalIntegerAt(object: JsonObject, key: string, path: string): number | null {
  const value = object[key];
  if (value === undefined || value === null) return null;
  return asInteger(value, `${path}.${key}`);
}

function stringsAt(object: JsonObject, key: string, path: string): readonly string[] {
  return arrayAt(object, key, path).map((entry, index) => asString(entry, `${path}.${key}[${String(index)}]`));
}

function objectsAt(object: JsonObject, key: string, path: string): readonly JsonObject[] {
  return arrayAt(object, key, path).map((entry, index) => requireJsonObjectValue(entry, `${path}.${key}[${String(index)}]`));
}

function exactKeys(object: JsonObject, expected: readonly string[], path: string): void {
  const actual = Object.keys(object);
  const sameLength = actual.length === expected.length;
  const sameOrder = sameLength && actual.every((key, index) => key === expected[index]);
  if (!sameOrder) fail('closed-field-violation', `${path} has unknown, missing, or reordered fields`, [`actual=${actual.join(',')}`, `expected=${expected.join(',')}`]);
}

function assertUnique(values: readonly string[], path: string): void {
  assertCondition(new Set(values).size === values.length, 'fixture-contract-violation', `${path} must not contain duplicate values`);
}

function assertStringSet(actual: readonly string[], expected: readonly string[], path: string): void {
  assertUnique(actual, path);
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  assertCondition(actualSorted.length === expectedSorted.length && actualSorted.every((value, index) => value === expectedSorted[index]), 'fixture-contract-violation', `${path} set does not match the sealed authority`, [`actual=${actualSorted.join(',')}`, `expected=${expectedSorted.join(',')}`]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalEncode(value: JsonValue, ancestors: WeakSet<object>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical-drift', 'canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') fail('canonical-drift', 'canonical JSON accepts only JSON values');
  if (ancestors.has(value)) fail('canonical-drift', 'canonical JSON rejects cyclic values');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) fail('canonical-drift', 'canonical JSON rejects sparse arrays');
        entries.push(canonicalEncode(value[index] as JsonValue, ancestors));
      }
      return `[${entries.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('canonical-drift', 'canonical JSON rejects non-plain objects');
    const object = value as JsonObject;
    const keys = Object.keys(object).sort(compareStrings);
    const pairs = keys.map((key) => {
      const entry = object[key];
      if (entry === undefined) fail('canonical-drift', 'canonical JSON rejects undefined values', [key]);
      return `${JSON.stringify(key)}:${canonicalEncode(entry, ancestors)}`;
    });
    return `{${pairs.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJsonForRosterFixture(value: JsonValue): string {
  return canonicalEncode(value, new WeakSet<object>());
}

function canonicalPreimageWithTerminalLf(object: JsonObject, omittedHashField: string): string {
  const copy: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(object)) {
    if (key === omittedHashField) continue;
    if (value === undefined) fail('canonical-drift', 'canonical JSON preimage rejects undefined values', [key]);
    copy[key] = value;
  }
  return `${canonicalJsonForRosterFixture(copy)}\n`;
}

function assertCanonicalHash(object: JsonObject, hashField: string, path: string, vectors: ReadonlyMap<string, Phase37CanonicalVector>, vectorId?: string): void {
  const expectedHash = stringAt(object, hashField, path);
  assertDigest(expectedHash, `${path}.${hashField}`);
  const canonical = canonicalPreimageWithTerminalLf(object, hashField);
  const actualHash = sha256Utf8(canonical);
  assertCondition(actualHash === expectedHash, 'canonical-drift', `${path}.${hashField} digest drift`, [`actual=${actualHash}`, `expected=${expectedHash}`]);
  if (vectorId !== undefined) {
    const vector = vectors.get(vectorId);
    if (vector !== undefined) {
      assertCondition(vector.hash_omission_field === hashField, 'canonical-drift', `${path} vector hash omission field drift`, [vectorId]);
      assertCondition(vector.canonical_json_utf8 === canonical, 'canonical-drift', `${path} canonical vector literal drift`, [vectorId]);
      assertCondition(vector.sha256 === expectedHash, 'canonical-drift', `${path} canonical vector digest does not match object hash`, [vectorId]);
    }
  } else {
    const prefix = HASH_FIELD_TO_SCHEMA_VECTOR_PREFIX[hashField];
    if (prefix !== undefined) {
      const matchingVectors = [...vectors.values()].filter((vector) => vector.hash_omission_field === hashField && vector.sha256 === expectedHash && vector.vector_id.startsWith(prefix));
      for (const vector of matchingVectors) {
        assertCondition(vector.canonical_json_utf8 === canonical, 'canonical-drift', `${path} canonical vector literal drift`, [vector.vector_id]);
      }
    }
  }
}

function typedVector(object: JsonObject, path: string): Phase37CanonicalVector {
  exactKeys(object, CANONICAL_VECTOR_KEYS, path);
  const vectorId = stringAt(object, 'vector_id', path);
  const hashOmissionField = stringAt(object, 'hash_omission_field', path);
  const canonicalJson = stringAt(object, 'canonical_json_utf8', path);
  const sha256 = stringAt(object, 'sha256', path);
  assertCondition(vectorId.length > 0, 'fixture-contract-violation', `${path}.vector_id must be non-empty`);
  assertCondition(hashOmissionField.length > 0, 'fixture-contract-violation', `${path}.hash_omission_field must be non-empty`);
  assertCondition(canonicalJson.endsWith('\n'), 'fixture-contract-violation', `${path}.canonical_json_utf8 must include exactly the terminal LF preimage`);
  assertDigest(sha256, `${path}.sha256`);
  const actual = sha256Utf8(canonicalJson);
  assertCondition(actual === sha256, 'canonical-drift', `${path} literal canonical vector digest drift`, [`actual=${actual}`, `expected=${sha256}`, vectorId]);
  return object as Phase37CanonicalVector;
}

function typedFixtureCase(object: JsonObject, path: string): Phase37FixtureCase {
  exactKeys(object, FIXTURE_CASE_KEYS, path);
  const fixtureId = stringAt(object, 'fixture_id', path);
  const description = stringAt(object, 'description', path);
  const tags = stringsAt(object, 'tags', path);
  objectAt(object, 'inputs', path);
  objectAt(object, 'expected', path);
  objectsAt(object, 'filesystem_postconditions', path);
  assertDigest(stringAt(object, 'fixture_case_sha256', path), `${path}.fixture_case_sha256`);
  assertCondition(fixtureId.length > 0, 'fixture-contract-violation', `${path}.fixture_id must be non-empty`);
  assertCondition(description.length > 0, 'fixture-contract-violation', `${path}.description must be non-empty`);
  assertUnique(tags, `${path}.tags`);
  return object as Phase37FixtureCase;
}

function validateTopLevel(corpus: JsonObject): void {
  exactKeys(corpus, TOP_LEVEL_KEYS, 'corpus');
  assertCondition(stringAt(corpus, 'schema_version', 'corpus') === PHASE37_W0_FIXTURE_CORPUS_SCHEMA_VERSION, 'fixture-contract-violation', 'fixture corpus schema_version drift');
  assertCondition(stringAt(corpus, 'freeze_id', 'corpus') === PHASE37_W0_FIXTURE_CORPUS_FREEZE_ID, 'fixture-contract-violation', 'fixture corpus freeze_id drift');
  assertCondition(stringAt(corpus, 'fixture_id', 'corpus') === PHASE37_W0_FIXTURE_CORPUS_ID, 'fixture-contract-violation', 'fixture corpus id drift');
  assertCondition(stringAt(corpus, 'status', 'corpus') === 'w1-ready-fixture-authority', 'fixture-contract-violation', 'fixture corpus status drift');
}

function validateAuthorityBoundary(corpus: JsonObject): void {
  const boundary = objectAt(corpus, 'authority_boundary', 'corpus');
  exactKeys(boundary, AUTHORITY_BOUNDARY_KEYS, 'corpus.authority_boundary');
  assertCondition(stringAt(boundary, 'binds_to', 'corpus.authority_boundary') === 'freeze_id only', 'fixture-contract-violation', 'fixture corpus binds to more than the freeze id');
  assertStringSet(stringsAt(boundary, 'forbidden_bindings', 'corpus.authority_boundary'), ['machine manifest digest', 'prose digest'], 'corpus.authority_boundary.forbidden_bindings');
  assertCondition(/non-certifying/u.test(stringAt(boundary, 'synthetic_ready_rule', 'corpus.authority_boundary')), 'fixture-contract-violation', 'synthetic ready rule must remain explicitly non-certifying');
}

function validateEvidenceNotice(corpus: JsonObject): void {
  const notice = objectAt(corpus, 'evidence_notice', 'corpus');
  exactKeys(notice, EVIDENCE_NOTICE_KEYS, 'corpus.evidence_notice');
  assertCondition(stringAt(notice, 'all_provider_inventory_auth_and_certification_facts_are', 'corpus.evidence_notice') === 'synthetic', 'fixture-contract-violation', 'fixture provider evidence must remain synthetic');
  assertCondition(booleanAt(notice, 'provider_evidence_is_certifying', 'corpus.evidence_notice') === false, 'fixture-contract-violation', 'fixture provider evidence must remain non-certifying');
  assertCondition(booleanAt(notice, 'secrets_included', 'corpus.evidence_notice') === false, 'fixture-contract-violation', 'fixture corpus must remain secret-free');
  assertCondition(booleanAt(notice, 'live_provider_calls_required', 'corpus.evidence_notice') === false, 'fixture-contract-violation', 'fixture corpus must not require live provider calls');
}

function validateCanonicalizationBlock(corpus: JsonObject): void {
  const block = objectAt(corpus, 'canonicalization', 'corpus');
  exactKeys(block, CANONICALIZATION_KEYS, 'corpus.canonicalization');
  assertCondition(stringAt(block, 'algorithm_id', 'corpus.canonicalization') === PHASE37_W0_FIXTURE_CORPUS_CANONICAL_ALGORITHM, 'canonical-drift', 'canonical algorithm drift');
  assertCondition(stringAt(block, 'definition_freeze_id', 'corpus.canonicalization') === PHASE37_W0_FIXTURE_CORPUS_FREEZE_ID, 'canonical-drift', 'canonical definition freeze id drift');
  assertCondition(booleanAt(block, 'terminal_lf', 'corpus.canonicalization') === true, 'canonical-drift', 'canonical terminal LF rule drift');
  assertCondition(stringAt(block, 'digest_encoding', 'corpus.canonicalization') === 'sha256:<64 lowercase hex>', 'canonical-drift', 'canonical digest encoding drift');
}

function validateFixedValues(corpus: JsonObject): void {
  const fixed = objectAt(corpus, 'fixed_values', 'corpus');
  exactKeys(fixed, FIXED_VALUES_KEYS, 'corpus.fixed_values');
  for (const key of FIXED_VALUES_KEYS) {
    const value = stringAt(fixed, key, 'corpus.fixed_values');
    assertCondition(value === FIXED_VALUES[key], 'fixture-contract-violation', `fixed value ${key} drift`, [`actual=${value}`, `expected=${FIXED_VALUES[key]}`]);
    if (key.startsWith('clock')) assertUtcMs(value, `corpus.fixed_values.${key}`);
  }
}

function validateDiagnosticRegistry(corpus: JsonObject): readonly string[] {
  const registry = stringsAt(corpus, 'diagnostic_code_registry', 'corpus');
  assertStringSet(registry, EXPECTED_DIAGNOSTIC_CODES, 'corpus.diagnostic_code_registry');
  return registry;
}

function validateCanonicalVectors(corpus: JsonObject): ReadonlyMap<string, Phase37CanonicalVector> {
  const entries = objectsAt(corpus, 'canonical_vectors', 'corpus');
  assertCondition(entries.length === PHASE37_W0_FIXTURE_CANONICAL_VECTOR_COUNT, 'fixture-contract-violation', 'canonical vector count drift', [`actual=${String(entries.length)}`]);
  const vectors: Phase37CanonicalVector[] = [];
  for (const [index, entry] of entries.entries()) vectors.push(typedVector(entry, `corpus.canonical_vectors[${String(index)}]`));
  const vectorIds = vectors.map((vector) => vector.vector_id);
  assertCondition(vectorIds.length === EXPECTED_VECTOR_IDS.length && vectorIds.every((value, index) => value === EXPECTED_VECTOR_IDS[index]), 'canonical-drift', 'canonical vector id/order drift', [`actual=${vectorIds.join(',')}`]);
  assertUnique(vectorIds, 'corpus.canonical_vectors.vector_id');
  return new Map(vectors.map((vector) => [vector.vector_id, vector]));
}

function validateFixtureCases(corpus: JsonObject, vectors: ReadonlyMap<string, Phase37CanonicalVector>, diagnosticRegistry: readonly string[]): ReadonlyMap<string, Phase37FixtureCase> {
  const entries = objectsAt(corpus, 'fixture_cases', 'corpus');
  assertCondition(entries.length === PHASE37_W0_FIXTURE_CASE_COUNT, 'fixture-contract-violation', 'fixture case count drift', [`actual=${String(entries.length)}`]);
  const cases: Phase37FixtureCase[] = [];
  for (const [index, entry] of entries.entries()) {
    const fixtureCase = typedFixtureCase(entry, `corpus.fixture_cases[${String(index)}]`);
    validateFixtureCase(fixtureCase, vectors, diagnosticRegistry, `corpus.fixture_cases[${String(index)}]`);
    cases.push(fixtureCase);
  }
  const fixtureIds = cases.map((fixtureCase) => fixtureCase.fixture_id);
  assertCondition(fixtureIds.length === EXPECTED_FIXTURE_IDS.length && fixtureIds.every((value, index) => value === EXPECTED_FIXTURE_IDS[index]), 'fixture-contract-violation', 'fixture case id/order drift', [`actual=${fixtureIds.join(',')}`]);
  assertUnique(fixtureIds, 'corpus.fixture_cases.fixture_id');
  const actualTags = [...new Set(cases.flatMap((fixtureCase) => fixtureCase.tags))];
  for (const tag of REQUIRED_TAGS) assertCondition(actualTags.includes(tag), 'fixture-contract-violation', 'fixture corpus missing required tag', [tag]);
  return new Map(cases.map((fixtureCase) => [fixtureCase.fixture_id, fixtureCase]));
}

function validateFixtureCase(fixtureCase: Phase37FixtureCase, vectors: ReadonlyMap<string, Phase37CanonicalVector>, diagnosticRegistry: readonly string[], path: string): void {
  assertCanonicalHash(fixtureCase, 'fixture_case_sha256', path, vectors, `fixture-case.${fixtureCase.fixture_id}`);
  const inputs = objectAt(fixtureCase, 'inputs', path);
  const expected = objectAt(fixtureCase, 'expected', path);
  const postconditions = objectsAt(fixtureCase, 'filesystem_postconditions', path);
  assertCondition(postconditions.length > 0, 'fixture-contract-violation', `${path}.filesystem_postconditions must not be empty`);
  for (const [index, postcondition] of postconditions.entries()) validateFilesystemPostcondition(postcondition, `${path}.filesystem_postconditions[${String(index)}]`);

  const runtimeInterface = stringAt(inputs, 'runtime_interface', `${path}.inputs`);
  assertCondition(['autopilot_manage_rosters', 'resolve_existing_run', 'historical_adapter', 'validate_receipt', 'publish_pre_run_selection'].includes(runtimeInterface), 'fixture-contract-violation', `${path}.inputs.runtime_interface is not recognized`, [runtimeInterface]);
  const action = stringAt(inputs, 'action', `${path}.inputs`);
  assertCondition(action.length > 0, 'fixture-contract-violation', `${path}.inputs.action must be non-empty`);

  const diagnostics = stringsAt(expected, 'diagnostics', `${path}.expected`);
  assertUnique(diagnostics, `${path}.expected.diagnostics`);
  for (const code of diagnostics) assertCondition(diagnosticRegistry.includes(code), 'fixture-contract-violation', `${path}.expected.diagnostics contains unknown code`, [code]);
  const ok = asBoolean(at(expected, 'ok', `${path}.expected`), `${path}.expected.ok`);
  const status = stringAt(expected, 'status', `${path}.expected`);
  assertCondition(status.length > 0, 'fixture-contract-violation', `${path}.expected.status must be non-empty`);
  const writeCount = integerAt(expected, 'write_count', `${path}.expected`);
  const lockCount = integerAt(expected, 'lock_count', `${path}.expected`);
  const filesTouched = stringsAt(expected, 'files_touched', `${path}.expected`);
  assertUnique(filesTouched, `${path}.expected.files_touched`);
  validateAccounting(fixtureCase.fixture_id, action, ok, status, writeCount, lockCount, filesTouched, path);
  validateExpectedNestedResult(expected, diagnostics, diagnosticRegistry, path);
}

function validateFilesystemPostcondition(postcondition: JsonObject, path: string): void {
  const keys = Object.keys(postcondition);
  const allowedKeys = ['path', 'state', 'sha256', 'count'];
  for (const key of keys) assertCondition(allowedKeys.includes(key), 'closed-field-violation', `${path} has an unknown filesystem postcondition field`, [key]);
  const postconditionPath = stringAt(postcondition, 'path', path);
  const state = stringAt(postcondition, 'state', path);
  assertCondition(postconditionPath.length > 0 && state.length > 0, 'fixture-contract-violation', `${path} path/state must be non-empty`);
  const sha = postcondition['sha256'];
  if (sha !== undefined) assertDigest(asString(sha, `${path}.sha256`), `${path}.sha256`);
  const count = optionalIntegerAt(postcondition, 'count', path);
  if (count !== null) assertCondition(count >= 0, 'fixture-contract-violation', `${path}.count must be non-negative`);
}

function validateAccounting(fixtureId: string, action: string, ok: boolean, status: string, writeCount: number, lockCount: number, filesTouched: readonly string[], path: string): void {
  assertCondition(writeCount >= 0 && lockCount >= 0, 'fixture-contract-violation', `${path} counters must be non-negative`);
  for (const file of filesTouched) {
    assertCondition(!/[.]tmp|temp|fsync|receipt|[.]lock/u.test(file), 'fixture-contract-violation', `${path}.expected.files_touched incorrectly counts temp/fsync/receipt/lock artifacts`, [file]);
  }
  const saveAccounting = EXPECTED_SAVE_ACCOUNTING[fixtureId];
  if (saveAccounting !== undefined) {
    assertCondition(action === 'save', 'fixture-contract-violation', `${path} save accounting fixture must use save action`);
    assertCondition(writeCount === saveAccounting.writeCount && lockCount === saveAccounting.lockCount && filesTouched.length === saveAccounting.fileCount, 'fixture-contract-violation', `${path} save write/lock/files accounting drift`, [`write=${String(writeCount)}`, `lock=${String(lockCount)}`, `files=${String(filesTouched.length)}`]);
    if (fixtureId === 'save.config-last.success' || fixtureId === 'save.readback-mismatch.rollback-required') {
      const last = filesTouched[filesTouched.length - 1];
      assertCondition(last === '~/.pi/agent/autopilot/config.json', 'fixture-contract-violation', `${path} config.json must be the last visible authority write`, [last ?? '<missing>']);
      assertCondition(!filesTouched.some((file) => /receipt/u.test(file)), 'fixture-contract-violation', `${path} receipt emission must not be persisted/counted`);
    }
    if (fixtureId === 'save.crash-before-config.no-default') {
      assertCondition(!filesTouched.includes('~/.pi/agent/autopilot/config.json'), 'fixture-contract-violation', `${path} crash-before-config must not publish config`);
    }
    return;
  }
  assertCondition(writeCount === 0 && lockCount === 0 && filesTouched.length === 0, 'fixture-contract-violation', `${path} non-save fixture must remain zero-write/zero-lock`, [`action=${action}`, `ok=${String(ok)}`, `status=${status}`]);
}

function validateExpectedNestedResult(expected: JsonObject, expectedDiagnosticCodes: readonly string[], diagnosticRegistry: readonly string[], path: string): void {
  const result = expected['result'];
  if (result === undefined) return;
  const resultObject = requireJsonObjectValue(result, `${path}.expected.result`);
  const nestedWriteCount = integerAt(resultObject, 'write_count', `${path}.expected.result`);
  const nestedLockCount = integerAt(resultObject, 'lock_count', `${path}.expected.result`);
  const nestedFilesTouched = stringsAt(resultObject, 'files_touched', `${path}.expected.result`);
  assertCondition(nestedWriteCount === 0 && nestedLockCount === 0 && nestedFilesTouched.length === 0, 'fixture-contract-violation', `${path}.expected.result must remain zero-write/zero-lock`);
  const diagnostics = objectsAt(resultObject, 'diagnostics', `${path}.expected.result`);
  const nestedCodes = diagnostics.map((diagnostic) => stringAt(diagnostic, 'code', `${path}.expected.result.diagnostics`));
  assertCondition(nestedCodes.length === expectedDiagnosticCodes.length && nestedCodes.every((code, index) => code === expectedDiagnosticCodes[index]), 'fixture-contract-violation', `${path}.expected.result diagnostics drift`);
  for (const [index, diagnostic] of diagnostics.entries()) validateDiagnosticObject(diagnostic, diagnosticRegistry, `${path}.expected.result.diagnostics[${String(index)}]`);
}

function validateDiagnosticObject(diagnostic: JsonObject, diagnosticRegistry: readonly string[], path: string): void {
  exactKeys(diagnostic, ['code', 'severity', 'message', 'remediation', 'secret_free'], path);
  const code = stringAt(diagnostic, 'code', path);
  assertCondition(diagnosticRegistry.includes(code), 'fixture-contract-violation', `${path}.code is not in the diagnostic registry`, [code]);
  assertCondition(['info', 'warning', 'error', 'fatal'].includes(stringAt(diagnostic, 'severity', path)), 'fixture-contract-violation', `${path}.severity is invalid`);
  assertCondition(stringAt(diagnostic, 'message', path).length > 0, 'fixture-contract-violation', `${path}.message must be non-empty`);
  assertCondition(stringAt(diagnostic, 'remediation', path).length > 0, 'fixture-contract-violation', `${path}.remediation must be non-empty`);
  assertCondition(booleanAt(diagnostic, 'secret_free', path) === true, 'fixture-contract-violation', `${path} diagnostic must be secret-free`);
}

function validateObjectRegistry(corpus: JsonObject, vectors: ReadonlyMap<string, Phase37CanonicalVector>, cases: ReadonlyMap<string, Phase37FixtureCase>): void {
  const registry = objectAt(corpus, 'object_registry', 'corpus');
  exactKeys(registry, OBJECT_REGISTRY_KEYS, 'corpus.object_registry');
  const routePolicies = objectsAt(registry, 'route_policies', 'corpus.object_registry');
  assertCondition(routePolicies.length === 1, 'fixture-contract-violation', 'fixture object registry route policy count drift');
  for (const routePolicy of routePolicies) {
    assertCanonicalHash(routePolicy, 'route_policy_sha256', 'corpus.object_registry.route_policies[]', vectors, `route-policy.${stringAt(routePolicy, 'route_policy_id', 'route_policy')}`);
    assertCondition(booleanAt(routePolicy, 'non_certifying_seed', 'route_policy') === true, 'fixture-contract-violation', 'fixture route policy must remain non-certifying');
  }

  const recipes = objectsAt(registry, 'provider_recipes', 'corpus.object_registry');
  assertCondition(recipes.length === 1, 'fixture-contract-violation', 'fixture object registry provider recipe count drift');
  for (const recipe of recipes) {
    assertCanonicalHash(recipe, 'recipe_sha256', 'corpus.object_registry.provider_recipes[]', vectors, `provider-recipe.${stringAt(recipe, 'recipe_id', 'recipe')}-v${String(integerAt(recipe, 'recipe_revision', 'recipe'))}`);
    assertCondition(booleanAt(recipe, 'non_certifying_seed', 'recipe') === true, 'fixture-contract-violation', 'fixture provider recipe must remain non-certifying');
  }

  const inventories = objectsAt(registry, 'inventories', 'corpus.object_registry');
  assertCondition(inventories.length === 3, 'fixture-contract-violation', 'fixture object registry inventory count drift');
  for (const inventory of inventories) {
    const inventoryId = stringAt(inventory, 'inventory_id', 'inventory');
    assertCanonicalHash(inventory, 'inventory_sha256', `corpus.object_registry.inventories.${inventoryId}`, vectors);
    assertCondition(stringAt(inventory, 'source', 'inventory') === 'synthetic-fixture', 'fixture-contract-violation', 'fixture inventories must remain synthetic');
    assertCondition(stringAt(inventory, 'created_at', 'inventory') === FIXED_VALUES.clock, 'fixture-contract-violation', 'inventory created_at fixed clock drift', [inventoryId]);
  }

  const candidateSet = objectAt(registry, 'synthetic_candidate_set', 'corpus.object_registry');
  for (const candidate of objectsAt(candidateSet, 'candidates', 'corpus.object_registry.synthetic_candidate_set')) {
    assertCanonicalHash(candidate, 'candidate_sha256', 'corpus.object_registry.synthetic_candidate_set.candidates[]', vectors);
    assertCondition(booleanAt(candidate, 'non_certifying_seed', 'candidate') === true, 'fixture-contract-violation', 'fixture candidates must remain non-certifying');
    assertCondition(booleanAt(candidate, 'synthetic_fixture_ready_only', 'candidate') === true, 'fixture-contract-violation', 'synthetic ready candidate must remain fixture-only');
    assertCondition(stringAt(candidate, 'launch_readiness', 'candidate') === 'synthetic-fixture-only', 'fixture-contract-violation', 'ready candidate launch readiness must remain synthetic-only');
  }
  assertCanonicalHash(candidateSet, 'candidate_set_sha256', 'corpus.object_registry.synthetic_candidate_set', vectors, 'candidate-set.qualified-codex.synthetic.v1');
  assertCondition(stringAt(candidateSet, 'created_at', 'corpus.object_registry.synthetic_candidate_set') === FIXED_VALUES.clock, 'fixture-contract-violation', 'candidate set fixed clock drift');

  const config = objectAt(registry, 'synthetic_config', 'corpus.object_registry');
  assertCanonicalHash(config, 'config_sha256', 'corpus.object_registry.synthetic_config', vectors, 'config.success.synthetic.v1');
  assertCondition(stringAt(config, 'updated_at', 'corpus.object_registry.synthetic_config') === FIXED_VALUES.clock_later, 'fixture-contract-violation', 'config fixed clock drift');

  const receipt = objectAt(registry, 'synthetic_receipt', 'corpus.object_registry');
  assertCanonicalHash(receipt, 'receipt_sha256', 'corpus.object_registry.synthetic_receipt', vectors, 'receipt.success.synthetic.v1');
  assertCondition(booleanAt(receipt, 'fresh_session_required', 'corpus.object_registry.synthetic_receipt') === true, 'fixture-contract-violation', 'setup receipt must require a fresh Pi session');
  assertCondition(booleanAt(receipt, 'zero_secrets', 'corpus.object_registry.synthetic_receipt') === true, 'fixture-contract-violation', 'setup receipt must remain secret-free');
  assertCondition(stringAt(receipt, 'issued_at', 'corpus.object_registry.synthetic_receipt') === FIXED_VALUES.clock_later, 'fixture-contract-violation', 'receipt fixed clock drift');

  const selection = objectAt(registry, 'synthetic_pre_run_selection', 'corpus.object_registry');
  assertCanonicalHash(selection, 'selection_sha256', 'corpus.object_registry.synthetic_pre_run_selection', vectors, 'pre-run-selection.success.synthetic.v1');
  assertCondition(stringAt(selection, 'selected_at', 'corpus.object_registry.synthetic_pre_run_selection') === FIXED_VALUES.clock_transition, 'fixture-contract-violation', 'pre-run selection fixed clock drift');

  const historicalArtifacts = objectsAt(registry, 'historical_artifacts', 'corpus.object_registry');
  assertCondition(historicalArtifacts.length === 2, 'fixture-contract-violation', 'historical artifact count drift');
  for (const artifact of historicalArtifacts) validateHistoricalArtifact(artifact, vectors);

  const historicalRequest = objectAt(registry, 'historical_adapter_request', 'corpus.object_registry');
  assertCanonicalHash(historicalRequest, 'request_sha256', 'corpus.object_registry.historical_adapter_request', vectors, 'historical-adapter.request.valid-v1');
  validateHistoricalRequestBytes(historicalRequest, 'corpus.object_registry.historical_adapter_request');

  const historicalAdmission = objectAt(registry, 'historical_adapter_admission', 'corpus.object_registry');
  assertCanonicalHash(historicalAdmission, 'admission_sha256', 'corpus.object_registry.historical_adapter_admission', vectors, 'historical-adapter.admission.valid-v1');
  assertCondition(booleanAt(historicalAdmission, 'historical_bytes_mutated', 'corpus.object_registry.historical_adapter_admission') === false, 'fixture-contract-violation', 'historical admission must never mutate bytes');

  const historicalResult = objectAt(registry, 'historical_adapter_result', 'corpus.object_registry');
  assertCanonicalHash(historicalResult, 'result_sha256', 'corpus.object_registry.historical_adapter_result', vectors, 'historical-adapter.result.valid-v1');
  assertCondition(booleanAt(historicalResult, 'historical_bytes_mutated', 'corpus.object_registry.historical_adapter_result') === false, 'fixture-contract-violation', 'historical result must never mutate bytes');

  const fixtureRegistry = objectAt(registry, 'fixture_registry', 'corpus.object_registry');
  assertCanonicalHash(fixtureRegistry, 'fixture_registry_sha256', 'corpus.object_registry.fixture_registry', vectors, 'registry.fixture-cases.v1');
  const registryCaseHashes = stringsAt(fixtureRegistry, 'fixture_case_sha256s', 'corpus.object_registry.fixture_registry');
  const actualCaseHashes = [...cases.values()].map((fixtureCase) => fixtureCase.fixture_case_sha256).sort(compareStrings);
  assertCondition(registryCaseHashes.length === actualCaseHashes.length && registryCaseHashes.every((hash, index) => hash === actualCaseHashes[index]), 'fixture-contract-violation', 'fixture registry case hash list drift');
}

function validateHistoricalArtifact(artifact: JsonObject, vectors: ReadonlyMap<string, Phase37CanonicalVector>): void {
  const artifactId = stringAt(artifact, 'artifact_id', 'historical_artifact');
  assertCanonicalHash(artifact, 'artifact_sha256', `corpus.object_registry.historical_artifacts.${artifactId}`, vectors, artifactId === 'historical-valid-v1-unit-spec' ? 'historical-artifact.valid-v1-unit-spec' : 'historical-artifact.valid-v1-receipt');
  const bytesUtf8 = stringAt(artifact, 'bytes_utf8', `historical_artifact.${artifactId}`);
  const expectedBytesSha = stringAt(artifact, 'bytes_sha256', `historical_artifact.${artifactId}`);
  assertDigest(expectedBytesSha, `historical_artifact.${artifactId}.bytes_sha256`);
  assertCondition(sha256Utf8(bytesUtf8) === expectedBytesSha, 'canonical-drift', `historical artifact ${artifactId} byte-faithful digest drift`);
  assertCondition(bytesUtf8.endsWith('\n'), 'fixture-contract-violation', `historical artifact ${artifactId} must preserve terminal LF bytes`);
  const parsedHistorical = parseJsonObject(bytesUtf8, `historical artifact ${artifactId} bytes`);
  assertCondition(stringAt(parsedHistorical, 'schema_version', `historical artifact ${artifactId}`) === stringAt(artifact, 'parsed_schema_version', `historical_artifact.${artifactId}`), 'fixture-contract-violation', `historical artifact ${artifactId} parsed schema drift`);
  assertCondition(stringAt(parsedHistorical, 'package_version', `historical artifact ${artifactId}`) === stringAt(artifact, 'package_version', `historical_artifact.${artifactId}`), 'fixture-contract-violation', `historical artifact ${artifactId} parsed package drift`);
}

function validateHistoricalRequestBytes(request: JsonObject, path: string): void {
  assertCondition(stringAt(request, 'requested_at', path) === FIXED_VALUES.clock, 'fixture-contract-violation', `${path}.requested_at fixed clock drift`);
  const unitBytes = stringAt(request, 'historical_unit_spec_bytes_utf8', path);
  const receiptBytes = stringAt(request, 'historical_receipt_bytes_utf8', path);
  assertCondition(sha256Utf8(unitBytes) === stringAt(request, 'historical_unit_spec_sha256', path), 'canonical-drift', `${path} historical unit bytes digest drift`);
  assertCondition(sha256Utf8(receiptBytes) === stringAt(request, 'historical_receipt_sha256', path), 'canonical-drift', `${path} historical receipt bytes digest drift`);
  assertCondition(unitBytes.endsWith('\n') && receiptBytes.endsWith('\n'), 'fixture-contract-violation', `${path} historical bytes must preserve terminal LF`);
}

function validateHistoricalFixtureCases(cases: ReadonlyMap<string, Phase37FixtureCase>): void {
  for (const fixtureCase of cases.values()) {
    if (!fixtureCase.fixture_id.startsWith('historical.')) continue;
    const request = objectAt(objectAt(fixtureCase, 'inputs', fixtureCase.fixture_id), 'request', fixtureCase.fixture_id);
    validateHistoricalRequestBytes(request, `fixture ${fixtureCase.fixture_id}.inputs.request`);
    const expected = objectAt(fixtureCase, 'expected', fixtureCase.fixture_id);
    assertCondition(booleanAt(expected, 'historical_bytes_mutated', `fixture ${fixtureCase.fixture_id}.expected`) === false, 'fixture-contract-violation', `fixture ${fixtureCase.fixture_id} must preserve historical bytes`);
    const resultValue = expected['result'];
    if (resultValue !== undefined) assertCondition(booleanAt(requireJsonObjectValue(resultValue, `fixture ${fixtureCase.fixture_id}.expected.result`), 'historical_bytes_mutated', `fixture ${fixtureCase.fixture_id}.expected.result`) === false, 'fixture-contract-violation', `fixture ${fixtureCase.fixture_id} result must preserve historical bytes`);
    for (const postcondition of objectsAt(fixtureCase, 'filesystem_postconditions', fixtureCase.fixture_id)) {
      const state = stringAt(postcondition, 'state', `fixture ${fixtureCase.fixture_id}.filesystem_postconditions`);
      if (state === 'byte-equal-preserved') assertDigest(stringAt(postcondition, 'sha256', `fixture ${fixtureCase.fixture_id}.filesystem_postconditions`), `fixture ${fixtureCase.fixture_id}.filesystem_postconditions.sha256`);
    }
  }
}

function validateSecretFreeAndSynthetic(value: JsonValue, path: string): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) validateSecretFreeAndSynthetic(value[index] as JsonValue, `${path}[${String(index)}]`);
    return;
  }
  if (!isJsonObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (key === 'secret_free') assertCondition(entry === true, 'fixture-contract-violation', `${path}.${key} must remain true`);
    if (key === 'secret_fields_present') assertCondition(entry === false, 'fixture-contract-violation', `${path}.${key} must remain false`);
    if (key === 'zero_secrets') assertCondition(entry === true, 'fixture-contract-violation', `${path}.${key} must remain true`);
    if (key === 'secrets_included') assertCondition(entry === false, 'fixture-contract-violation', `${path}.${key} must remain false`);
    if (key === 'provider_evidence_is_certifying') assertCondition(entry === false, 'fixture-contract-violation', `${path}.${key} must remain false`);
    if (key === 'live_provider_calls_required') assertCondition(entry === false, 'fixture-contract-violation', `${path}.${key} must remain false`);
    if (key === 'non_certifying_seed') assertCondition(entry === true, 'fixture-contract-violation', `${path}.${key} must remain true`);
    if (key === 'candidate_state' && entry === 'synthetic-fixture-ready') {
      assertCondition(value['synthetic_fixture_ready_only'] === true && value['launch_readiness'] === 'synthetic-fixture-only' && value['qualification_state'] === 'synthetic-test-ready', 'fixture-contract-violation', `${path} synthetic readiness escaped fixture-only boundaries`);
    }
    validateSecretFreeAndSynthetic(entry, `${path}.${key}`);
  }
}

function buildLoadResult(source: string, sha256: string, corpus: JsonObject, caseMap: ReadonlyMap<string, Phase37FixtureCase>, vectorMap: ReadonlyMap<string, Phase37CanonicalVector>, diagnosticCodes: readonly string[]): Phase37W0FixtureCorpusLoadResult {
  const frozenCorpus = deepFreezeJson(corpus) as Phase37W0AcceptanceCorpus;
  const fixtureIds = Object.freeze([...caseMap.keys()]);
  const canonicalVectorIds = Object.freeze([...vectorMap.keys()]);
  const frozenDiagnostics = Object.freeze([...diagnosticCodes]);
  const result: Phase37W0FixtureCorpusLoadResult = {
    source,
    sha256,
    syntheticOnly: true,
    providerEvidenceCertifying: false,
    corpus: frozenCorpus,
    fixtureIds,
    canonicalVectorIds,
    diagnosticCodes: frozenDiagnostics,
    getCase(fixtureId: string): Phase37FixtureCase {
      const fixtureCase = caseMap.get(fixtureId);
      if (fixtureCase === undefined) fail('fixture-contract-violation', 'unknown Phase 37 W0 fixture case requested', [fixtureId]);
      return fixtureCase;
    },
    getCanonicalVector(vectorId: string): Phase37CanonicalVector {
      const vector = vectorMap.get(vectorId);
      if (vector === undefined) fail('fixture-contract-violation', 'unknown Phase 37 W0 canonical vector requested', [vectorId]);
      return vector;
    },
  };
  return Object.freeze(result);
}

function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === 'object') {
    if (Object.isFrozen(value)) return value;
    if (Array.isArray(value)) {
      for (const entry of value) deepFreezeJson(entry);
    } else {
      for (const entry of Object.values(value)) {
        if (entry !== undefined) deepFreezeJson(entry);
      }
    }
    Object.freeze(value);
  }
  return value;
}

function validateParsedCorpus(corpus: JsonObject, source: string): { readonly cases: ReadonlyMap<string, Phase37FixtureCase>; readonly vectors: ReadonlyMap<string, Phase37CanonicalVector>; readonly diagnosticCodes: readonly string[] } {
  validateTopLevel(corpus);
  validateAuthorityBoundary(corpus);
  validateEvidenceNotice(corpus);
  validateCanonicalizationBlock(corpus);
  validateFixedValues(corpus);
  const diagnosticCodes = validateDiagnosticRegistry(corpus);
  const vectors = validateCanonicalVectors(corpus);
  const cases = validateFixtureCases(corpus, vectors, diagnosticCodes);
  validateObjectRegistry(corpus, vectors, cases);
  validateHistoricalFixtureCases(cases);
  validateSecretFreeAndSynthetic(corpus, source);
  return { cases, vectors, diagnosticCodes };
}

export function parsePhase37W0FixtureCorpusText(text: string, options: ParseOptions): Phase37W0FixtureCorpusLoadResult {
  assertDigest(options.expectedSha256, 'expectedSha256');
  const actualSha256 = sha256Utf8(text);
  if (actualSha256 !== options.expectedSha256) fail('digest-drift', 'Phase 37 W0 fixture corpus digest drift', [`source=${options.source}`, `actual=${actualSha256}`, `expected=${options.expectedSha256}`]);
  const corpus = parseJsonObject(text, options.source);
  const validation = validateParsedCorpus(corpus, options.source);
  return buildLoadResult(options.source, actualSha256, corpus, validation.cases, validation.vectors, validation.diagnosticCodes);
}

/**
 * Explicit synthetic-fixture loader for Phase 37 W1/W2 tests. This module has no
 * top-level filesystem reads and is not imported by normal runtime paths. Callers
 * must explicitly import it and provide the fixture file path; the default digest
 * is the sealed W0 acceptance authority digest and never silently falls back.
 */
export function loadPhase37W0FixtureCorpus(options: LoadOptions): Phase37W0FixtureCorpusLoadResult {
  const expectedSha256 = options.expectedSha256 ?? PHASE37_W0_FIXTURE_CORPUS_SHA256;
  assertDigest(expectedSha256, 'expectedSha256');
  const maximumBytes = options.maximumBytes ?? MAXIMUM_CORPUS_BYTES;
  assertCondition(Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= MAXIMUM_CORPUS_BYTES, 'fixture-contract-violation', 'fixture corpus maximum byte bound is invalid', [`maximum=${String(maximumBytes)}`]);
  const source = options.path instanceof URL ? options.path.href : options.path;
  const bytes = readImmutableBoundedBytes(options.path, maximumBytes, source);
  const actualSha256 = sha256Bytes(bytes);
  if (actualSha256 !== expectedSha256) fail('digest-drift', 'Phase 37 W0 fixture corpus digest drift', [`source=${source}`, `actual=${actualSha256}`, `expected=${expectedSha256}`]);
  const text = decodeUtf8(bytes, source);
  const corpus = parseJsonObject(text, source);
  const validation = validateParsedCorpus(corpus, source);
  return buildLoadResult(source, actualSha256, corpus, validation.cases, validation.vectors, validation.diagnosticCodes);
}
