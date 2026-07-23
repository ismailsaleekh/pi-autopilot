// Phase 37 W0 — contract-freeze validator.
//
// This is the independent PASS gate named by decision D69. It validates the
// final W0 authority split: manifest/seeds/ownership, definitions DSL, fixture
// corpus, sidecars, and subordinate prose. It is deterministic and offline; it
// reads bytes only and does not import production code.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it as test } from 'node:test';
import assert from 'node:assert/strict';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
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

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const manifestPath = resolve(repoRoot, 'design', 'phase37', 'roster-contract-freeze.v1.json');
const definitionsPath = resolve(repoRoot, 'design', 'phase37', 'roster-contract-definitions.v1.json');
const fixturesPath = resolve(repoRoot, 'design', 'phase37', 'roster-acceptance-fixtures.v1.json');
const manifestSidecarPath = resolve(repoRoot, 'design', 'phase37', 'roster-contract-freeze.v1.sha256');
const definitionsSidecarPath = resolve(repoRoot, 'design', 'phase37', 'roster-contract-definitions.v1.sha256');
const fixturesSidecarPath = resolve(repoRoot, 'design', 'phase37', 'roster-acceptance-fixtures.v1.sha256');
const freezeDocPath = resolve(repoRoot, 'PHASE37_ROSTER_CONTRACT_FREEZE.md');

const FREEZE_ID = 'phase37-roster-w0-2026-07-22';
const CANONICAL_ALGORITHM = 'autopilot.phase37.canonical-json.sha256.v1';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const UTC_MS_Z_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

const MANIFEST_TOP_LEVEL_KEYS = [
  'schema_version',
  'freeze_id',
  'status',
  'artifact_authority',
  'target',
  'profiles',
  'roles',
  'schema_authority',
  'canonicalization_authority',
  'seed_readiness_policy',
  'route_policies',
  'provider_recipes',
  'generated_rosters',
  'seed_candidates',
  'seed_registries',
  'resolution_summary',
  'storage_summary',
  'compatibility',
  'w1_lanes',
  'hot_surface_owners',
  'acceptance_fixture_authority',
  'forbidden_shapes',
  'amendment_policy',
] as const;

const DEFINITIONS_TOP_LEVEL_KEYS = [
  'schema_version',
  'freeze_id',
  'status',
  'not_provider_certification',
  'authority_boundary',
  'current_v1_source_pins',
  'constants',
  'canonical_hash_algorithm',
  'schemas',
  'route_recipe_candidate_contract',
  'storage_protocols',
  'resolution',
  'inventory_api',
  'operations',
  'diagnostic_code_registry',
  'acceptance_fixture_requirements',
  'forbidden_shapes',
] as const;

const FIXTURES_TOP_LEVEL_KEYS = [
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

const EXPECTED_PROFILES = ['precision', 'cruise', 'afterburner'] as const;
const EXPECTED_ROLES = [
  'parent',
  'strategy',
  'implement',
  'validate',
  'fix',
  'adjudicate',
  'bughunt',
  'extract',
] as const;
const EXPECTED_CHILD_ROLES = ['strategy', 'implement', 'validate', 'fix', 'adjudicate', 'bughunt', 'extract'] as const;
const EXPECTED_PROVIDERS = ['anthropic', 'openai-codex', 'kimi-coding', 'opencode-go', 'zai'] as const;
const EXPECTED_ROUTE_POLICY_IDS = [
  'anthropic-sanitized-v1',
  'codex-subscription-v1',
  'kimi-coding-plan-v1',
  'opencode-go-plan-v1',
  'zai-coding-plan-v1',
] as const;
const EXPECTED_RECIPE_IDS = [
  'anthropic-sanitized',
  'codex-subscription',
  'kimi-coding-plan',
  'opencode-go-plan',
  'zai-coding-plan',
] as const;
const EXPECTED_FORBIDDEN_GATEWAYS = ['arbitrary-api-key', 'metered-frontier', 'openrouter'] as const;
const FIXTURE_OBJECT_REGISTRY_KEYS = [
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
const FIXTURE_CASE_KEYS = [
  'fixture_id',
  'description',
  'tags',
  'inputs',
  'expected',
  'filesystem_postconditions',
  'fixture_case_sha256',
] as const;
const EXPECTED_SCHEMA_VERSIONS = [
  'autopilot.assignment.v1',
  'autopilot.auth_summary.v1',
  'autopilot.billing_summary.v1',
  'autopilot.capability_summary.v1',
  'autopilot.certification_manifest.v1',
  'autopilot.certification_role_result.v1',
  'autopilot.context_ref.v2',
  'autopilot.evidence_ref.v1',
  'autopilot.existing_run_resolution_request.v1',
  'autopilot.existing_run_resolution_result.v1',
  'autopilot.historical_fixed_roster_adapter_admission.v1',
  'autopilot.historical_fixed_roster_adapter_request.v1',
  'autopilot.historical_fixed_roster_adapter_result.v1',
  'autopilot.historical_fixed_roster_artifact.v1',
  'autopilot.historical_fixed_roster_role.v1',
  'autopilot.inventory_model.v1',
  'autopilot.inventory_provider.v1',
  'autopilot.observed_profile.v1',
  'autopilot.pre_run_selection.v1',
  'autopilot.pre_run_selection_publish_request.v1',
  'autopilot.pre_run_selection_publish_result.v1',
  'autopilot.profile_template.v1',
  'autopilot.provider_recipe.v1',
  'autopilot.receipt.v2',
  'autopilot.receipt_validation_request.v1',
  'autopilot.receipt_validation_result.v1',
  'autopilot.recipe_resolution_request.v1',
  'autopilot.recipe_resolution_result.v1',
  'autopilot.request_profile.v1',
  'autopilot.role_template.v1',
  'autopilot.roster.v1',
  'autopilot.roster_candidate.v1',
  'autopilot.roster_candidate_set.v1',
  'autopilot.roster_config.v1',
  'autopilot.roster_diagnostic.v1',
  'autopilot.roster_doctor_result.v1',
  'autopilot.roster_inventory.v1',
  'autopilot.roster_setup_receipt.v1',
  'autopilot.roster_tool_request.v1',
  'autopilot.roster_tool_result.v1',
  'autopilot.roster_transition.v1',
  'autopilot.route_policy.v1',
  'autopilot.route_resolution_request.v1',
  'autopilot.route_resolution_result.v1',
  'autopilot.saved_roster_ref.v1',
  'autopilot.unit_spec.v2',
] as const;

const manifestText = readFileSync(manifestPath, 'utf8');
const definitionsText = readFileSync(definitionsPath, 'utf8');
const fixturesText = readFileSync(fixturesPath, 'utf8');
const manifestSidecarText = readFileSync(manifestSidecarPath, 'utf8').trim();
const definitionsSidecarText = readFileSync(definitionsSidecarPath, 'utf8').trim();
const fixturesSidecarText = readFileSync(fixturesSidecarPath, 'utf8').trim();
const freezeDocText = readFileSync(freezeDocPath, 'utf8');

const manifest = parseJsonObject(manifestText, 'manifest');
const definitions = parseJsonObject(definitionsText, 'definitions');
const fixtures = parseJsonObject(fixturesText, 'fixtures');
const schemas = objectAt(definitions, 'schemas', 'definitions');

function fail(message: string): never {
  throw new Error(message);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    return valueType !== 'number' || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry));
  if (valueType !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (Object.getPrototypeOf(record) !== Object.prototype) return false;
  return Object.values(record).every((entry) => isJsonValue(entry));
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string, path: string): JsonObject {
  assertNoDuplicateObjectKeys(text, path);
  const parsed: unknown = JSON.parse(text);
  if (!isJsonValue(parsed)) fail(`${path} is not a JSON value`);
  return asObject(parsed, path);
}

function skipWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/u.test(text[cursor] ?? '')) cursor += 1;
  return cursor;
}

function lastFrame(stack: readonly ScanFrame[]): ScanFrame | undefined {
  return stack[stack.length - 1];
}

function assertCanStartValue(stack: readonly ScanFrame[], rootSeen: boolean, path: string, index: number): void {
  const frame = lastFrame(stack);
  if (frame === undefined) {
    if (rootSeen) fail(`${path} has trailing root value at byte ${index}`);
    return;
  }
  if (frame.kind === 'object' && frame.expect === 'value') return;
  if (frame.kind === 'array' && frame.expect === 'valueOrEnd') return;
  fail(`${path} has unexpected value at byte ${index}`);
}

function markValueComplete(stack: readonly ScanFrame[], rootSeen: boolean, path: string, index: number): boolean {
  const frame = lastFrame(stack);
  if (frame === undefined) {
    if (rootSeen) fail(`${path} has multiple root values at byte ${index}`);
    return true;
  }
  if (frame.kind === 'object') {
    if (frame.expect !== 'value') fail(`${path} has object value in ${frame.expect} state at byte ${index}`);
    frame.expect = 'commaOrEnd';
    return rootSeen;
  }
  if (frame.expect !== 'valueOrEnd') fail(`${path} has array value in ${frame.expect} state at byte ${index}`);
  frame.expect = 'commaOrEnd';
  return rootSeen;
}

function parseStringToken(text: string, index: number, path: string): { readonly value: string; readonly next: number } {
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
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'string') fail(`${path} string token did not parse as a string`);
      return { value: parsed, next: cursor + 1 };
    }
    cursor += 1;
  }
  fail(`${path} has unterminated string at byte ${index}`);
}

function skipNumberToken(text: string, index: number, path: string): number {
  const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(index));
  if (match === null) fail(`${path} has invalid number at byte ${index}`);
  return index + match[0].length;
}

function assertNoDuplicateObjectKeys(text: string, path: string): void {
  const stack: ScanFrame[] = [];
  let rootSeen = false;
  let index = 0;
  while (index < text.length) {
    index = skipWhitespace(text, index);
    if (index >= text.length) break;
    const char = text[index];
    if (char === undefined) fail(`${path} scanner reached an impossible byte`);
    const frame = lastFrame(stack);
    if (char === '{') {
      assertCanStartValue(stack, rootSeen, path, index);
      stack.push({ kind: 'object', keys: new Set<string>(), expect: 'keyOrEnd' });
      index += 1;
      continue;
    }
    if (char === '[') {
      assertCanStartValue(stack, rootSeen, path, index);
      stack.push({ kind: 'array', expect: 'valueOrEnd' });
      index += 1;
      continue;
    }
    if (char === '}') {
      if (frame === undefined || frame.kind !== 'object') fail(`${path} has unmatched } at byte ${index}`);
      if (frame.expect !== 'keyOrEnd' && frame.expect !== 'commaOrEnd') {
        fail(`${path} closes object while expecting ${frame.expect} at byte ${index}`);
      }
      stack.pop();
      rootSeen = markValueComplete(stack, rootSeen, path, index);
      index += 1;
      continue;
    }
    if (char === ']') {
      if (frame === undefined || frame.kind !== 'array') fail(`${path} has unmatched ] at byte ${index}`);
      if (frame.expect !== 'valueOrEnd' && frame.expect !== 'commaOrEnd') {
        fail(`${path} closes array while expecting ${frame.expect} at byte ${index}`);
      }
      stack.pop();
      rootSeen = markValueComplete(stack, rootSeen, path, index);
      index += 1;
      continue;
    }
    if (char === ':') {
      if (frame === undefined || frame.kind !== 'object' || frame.expect !== 'colon') {
        fail(`${path} has unexpected colon at byte ${index}`);
      }
      frame.expect = 'value';
      index += 1;
      continue;
    }
    if (char === ',') {
      if (frame === undefined || frame.expect !== 'commaOrEnd') fail(`${path} has unexpected comma at byte ${index}`);
      frame.expect = frame.kind === 'object' ? 'keyOrEnd' : 'valueOrEnd';
      index += 1;
      continue;
    }
    if (char === '"') {
      const token = parseStringToken(text, index, path);
      if (frame !== undefined && frame.kind === 'object' && frame.expect === 'keyOrEnd') {
        if (frame.keys.has(token.value)) fail(`${path} has duplicate object key ${token.value}`);
        frame.keys.add(token.value);
        frame.expect = 'colon';
      } else {
        assertCanStartValue(stack, rootSeen, path, index);
        rootSeen = markValueComplete(stack, rootSeen, path, index);
      }
      index = token.next;
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      assertCanStartValue(stack, rootSeen, path, index);
      index = skipNumberToken(text, index, path);
      rootSeen = markValueComplete(stack, rootSeen, path, index);
      continue;
    }
    if (text.startsWith('true', index) || text.startsWith('null', index)) {
      assertCanStartValue(stack, rootSeen, path, index);
      index += 4;
      rootSeen = markValueComplete(stack, rootSeen, path, index);
      continue;
    }
    if (text.startsWith('false', index)) {
      assertCanStartValue(stack, rootSeen, path, index);
      index += 5;
      rootSeen = markValueComplete(stack, rootSeen, path, index);
      continue;
    }
    fail(`${path} has unexpected token ${char} at byte ${index}`);
  }
  if (stack.length !== 0) fail(`${path} has unclosed JSON containers`);
  if (!rootSeen) fail(`${path} contains no JSON root value`);
}

function at(object: JsonObject, key: string, path: string): JsonValue {
  const value = object[key];
  if (value === undefined) fail(`${path}.${key} is missing`);
  return value;
}

function asObject(value: JsonValue, path: string): JsonObject {
  if (!isJsonObject(value)) fail(`${path} must be an object`);
  return value;
}

function objectAt(object: JsonObject, key: string, path: string): JsonObject {
  return asObject(at(object, key, path), `${path}.${key}`);
}

function asArray(value: JsonValue, path: string): readonly JsonValue[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value;
}

function arrayAt(object: JsonObject, key: string, path: string): readonly JsonValue[] {
  return asArray(at(object, key, path), `${path}.${key}`);
}

function asString(value: JsonValue, path: string): string {
  if (typeof value !== 'string') fail(`${path} must be a string`);
  return value;
}

function stringAt(object: JsonObject, key: string, path: string): string {
  return asString(at(object, key, path), `${path}.${key}`);
}

function asBoolean(value: JsonValue, path: string): boolean {
  if (typeof value !== 'boolean') fail(`${path} must be a boolean`);
  return value;
}

function booleanAt(object: JsonObject, key: string, path: string): boolean {
  return asBoolean(at(object, key, path), `${path}.${key}`);
}

function asInteger(value: JsonValue, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(`${path} must be an integer`);
  return value;
}

function integerAt(object: JsonObject, key: string, path: string): number {
  return asInteger(at(object, key, path), `${path}.${key}`);
}

function stringsAt(object: JsonObject, key: string, path: string): readonly string[] {
  return asArray(at(object, key, path), `${path}.${key}`).map((value, index) => asString(value, `${path}.${key}[${index}]`));
}

function objectsAt(object: JsonObject, key: string, path: string): readonly JsonObject[] {
  return asArray(at(object, key, path), `${path}.${key}`).map((value, index) => asObject(value, `${path}.${key}[${index}]`));
}

function exactKeys(object: JsonObject, expected: readonly string[], path: string): void {
  assert.deepEqual(Object.keys(object), [...expected], `${path} keys must be exact and ordered`);
}

function sameStringSet(actual: readonly string[], expected: readonly string[], path: string): void {
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${path} set mismatch`);
  assert.equal(new Set(actual).size, actual.length, `${path} contains duplicate values`);
}

function requireUnique(values: readonly string[], path: string): void {
  assert.equal(new Set(values).size, values.length, `${path} values must be unique`);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireSorted(keys: readonly string[], path: string): void {
  for (let index = 1; index < keys.length; index += 1) {
    const previous = keys[index - 1];
    const current = keys[index];
    if (previous === undefined || current === undefined) fail(`${path} sort index escaped array bounds`);
    assert.ok(compareStrings(previous, current) <= 0, `${path} must be sorted: ${previous} > ${current}`);
  }
}

function canonicalJson(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical JSON refuses non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const object = asObject(value, 'canonical JSON object');
  const keys = Object.keys(object).sort(compareStrings);
  return `{${keys
    .map((key) => {
      const entry = object[key];
      if (entry === undefined) fail(`canonical JSON found undefined at key ${key}`);
      return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
    })
    .join(',')}}`;
}

function sha256Text(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function sha256Bytes(text: string): string {
  return sha256Text(text);
}

function omitField(object: JsonObject, field: string): JsonObject {
  const result: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(object)) {
    if (key === field) continue;
    const value = object[key];
    if (value === undefined) fail(`cannot omit ${field}; ${key} is undefined`);
    result[key] = value;
  }
  return result;
}

function hashObject(object: JsonObject, hashField: string): string {
  return sha256Text(`${canonicalJson(omitField(object, hashField))}\n`);
}

function assertHashObject(object: JsonObject, hashField: string, path: string): void {
  assert.equal(hashObject(object, hashField), stringAt(object, hashField, path), `${path}.${hashField} mismatch`);
}

function selectionIdentityHash(
  scope: string,
  rosterId: string,
  rosterRevision: number,
  rosterSha256: string,
  assignmentSetSha256: string,
  historicalUnitSpecSha256: string,
  historicalReceiptSha256: string,
): string {
  return sha256Text(`${canonicalJson({
    schema_version: 'autopilot.historical_fixed_roster_selection_identity.v1',
    scope,
    roster_id: rosterId,
    roster_revision: rosterRevision,
    roster_sha256: rosterSha256,
    assignment_set_sha256: assignmentSetSha256,
    historical_unit_spec_sha256: historicalUnitSpecSha256,
    historical_receipt_sha256: historicalReceiptSha256,
  })}\n`);
}

function assertDefaultTupleMatches(container: JsonObject, rostersKey: string, path: string): void {
  const rosterId = stringAt(container, 'default_roster_id', path);
  const rosterRevision = integerAt(container, 'default_roster_revision', path);
  const rosterSha256 = stringAt(container, 'default_roster_sha256', path);
  const matches = objectsAt(container, rostersKey, path).filter((roster) => (
    stringAt(roster, 'roster_id', `${path}.${rostersKey}`) === rosterId
    && integerAt(roster, 'roster_revision', `${path}.${rostersKey}`) === rosterRevision
    && stringAt(roster, 'roster_sha256', `${path}.${rostersKey}`) === rosterSha256
  ));
  assert.equal(matches.length, 1, `${path} default tuple must match exactly one ${rostersKey} entry`);
}

function assertDigest(value: string, path: string): void {
  assert.match(value, DIGEST_PATTERN, `${path} must use sha256:<64 lowercase hex>`);
}

function jsonKey(value: JsonValue): string {
  return canonicalJson(value);
}

function jsonArrayIncludes(values: readonly JsonValue[], expected: JsonValue): boolean {
  const expectedKey = jsonKey(expected);
  return values.some((value) => jsonKey(value) === expectedKey);
}

function mapBy(objects: readonly JsonObject[], key: string, path: string): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  for (const object of objects) {
    const id = stringAt(object, key, path);
    if (result.has(id)) fail(`${path} duplicates ${key}=${id}`);
    result.set(id, object);
  }
  return result;
}

function getMapEntry(map: ReadonlyMap<string, JsonObject>, key: string, path: string): JsonObject {
  const value = map.get(key);
  if (value === undefined) fail(`${path} missing ${key}`);
  return value;
}

function roleIndex(role: string): number {
  return EXPECTED_ROLES.indexOf(role as (typeof EXPECTED_ROLES)[number]);
}

function childRoleIndex(role: string): number {
  return EXPECTED_CHILD_ROLES.indexOf(role as (typeof EXPECTED_CHILD_ROLES)[number]);
}

function arrayItemIdentity(value: JsonValue, uniqueBy: string, path: string): string {
  const object = asObject(value, path);
  if (uniqueBy === 'role') return stringAt(object, 'role', path);
  if (uniqueBy === 'profile_id') return stringAt(object, 'profile_id', path);
  if (uniqueBy === 'provider_id') return stringAt(object, 'provider_id', path);
  if (uniqueBy === 'candidate_id') return stringAt(object, 'candidate_id', path);
  if (uniqueBy === 'code') return stringAt(object, 'code', path);
  if (uniqueBy === 'evidence_id') return stringAt(object, 'evidence_id', path);
  if (uniqueBy === 'result_sha256') return stringAt(object, 'result_sha256', path);
  if (uniqueBy === 'model_id+api') return `${stringAt(object, 'model_id', path)}\0${stringAt(object, 'api', path)}`;
  if (uniqueBy === 'roster_id+revision') return `${stringAt(object, 'roster_id', path)}\0${integerAt(object, 'roster_revision', path)}`;
  fail(`${path} uses unsupported uniqueBy ${uniqueBy}`);
}

function orderedArrayKey(value: JsonValue, orderedBy: string, path: string): string {
  if (orderedBy === 'lexicographic') return asString(value, path);
  if (orderedBy === 'lexicographic-null-first') {
    if (value === null) return '\0';
    return asString(value, path);
  }
  const object = asObject(value, path);
  if (orderedBy === 'role_order') {
    const index = roleIndex(stringAt(object, 'role', path));
    if (index < 0) fail(`${path} has unknown role`);
    return String(index).padStart(2, '0');
  }
  if (orderedBy === 'profile_id') return stringAt(object, 'profile_id', path);
  if (orderedBy === 'provider_id') return stringAt(object, 'provider_id', path);
  if (orderedBy === 'candidate_sort_key') return stringAt(object, 'candidate_sort_key', path);
  if (orderedBy === 'code') return stringAt(object, 'code', path);
  if (orderedBy === 'evidence_id') return stringAt(object, 'evidence_id', path);
  if (orderedBy === 'result_sha256') return stringAt(object, 'result_sha256', path);
  if (orderedBy === 'model_id,api') return `${stringAt(object, 'model_id', path)}\0${stringAt(object, 'api', path)}`;
  if (orderedBy === 'roster_id,roster_revision') {
    return `${stringAt(object, 'roster_id', path)}\0${String(integerAt(object, 'roster_revision', path)).padStart(12, '0')}`;
  }
  fail(`${path} uses unsupported orderedBy ${orderedBy}`);
}

function validateItemSpec(spec: JsonObject, value: JsonValue, path: string, refStack: readonly string[]): void {
  const type = stringAt(spec, 'type', path);
  const required = booleanAt(spec, 'required', path);
  const nullable = booleanAt(spec, 'nullable', path);
  assert.equal(required, true, `${path}.required for array items must be true`);
  if (value === null) {
    assert.equal(nullable, true, `${path} must declare nullable true before accepting null`);
    return;
  }
  if (type === 'enum') {
    exactAllowedKeys(spec, ['type', 'required', 'nullable', 'values'], path);
    const values = arrayAt(spec, 'values', path);
    assert.ok(jsonArrayIncludes(values, value), `${path} enum does not include ${canonicalJson(value)}`);
    return;
  }
  if (type === 'string') {
    validateStringSpec(spec, value, path);
    return;
  }
  if (type === 'object') {
    exactAllowedKeys(spec, ['type', 'required', 'nullable', 'ref', 'note'], path);
    if (spec['ref'] !== undefined) validateSchemaObject(value, stringAt(spec, 'ref', path), path, refStack);
    else asObject(value, path);
    return;
  }
  fail(`${path} unsupported array item type ${type}`);
}

function exactAllowedKeys(object: JsonObject, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  assert.deepEqual(unknown, [], `${path} has unknown DSL keys`);
}

function validateStringSpec(spec: JsonObject, value: JsonValue, path: string): void {
  exactAllowedKeys(spec, ['type', 'required', 'nullable', 'minLength', 'maxLength', 'pattern', 'format', 'relation'], path);
  const text = asString(value, path);
  const minLength = spec['minLength'];
  const maxLength = spec['maxLength'];
  if (minLength !== undefined) assert.ok(text.length >= asInteger(minLength, `${path}.minLength`), `${path} is shorter than minLength`);
  if (maxLength !== undefined) assert.ok(text.length <= asInteger(maxLength, `${path}.maxLength`), `${path} is longer than maxLength`);
  const pattern = spec['pattern'];
  if (pattern !== undefined) assert.match(text, new RegExp(asString(pattern, `${path}.pattern`), 'u'), `${path} does not match pattern`);
  const format = spec['format'];
  if (format !== undefined) {
    assert.equal(asString(format, `${path}.format`), 'utc-ms-z');
    assert.match(text, UTC_MS_Z_PATTERN, `${path} must be UTC millisecond Z`);
  }
}

function validateFieldValue(spec: JsonObject, value: JsonValue, path: string, refStack: readonly string[]): void {
  const type = stringAt(spec, 'type', path);
  const nullable = booleanAt(spec, 'nullable', path);
  if (value === null) {
    assert.equal(nullable, true, `${path} cannot be null unless nullable is true`);
    return;
  }
  if (type === 'integer') {
    exactAllowedKeys(spec, ['type', 'required', 'nullable', 'minimum', 'maximum'], path);
    const integer = asInteger(value, path);
    const minimum = spec['minimum'];
    const maximum = spec['maximum'];
    if (minimum !== undefined) assert.ok(integer >= asInteger(minimum, `${path}.minimum`), `${path} below minimum`);
    if (maximum !== undefined) assert.ok(integer <= asInteger(maximum, `${path}.maximum`), `${path} above maximum`);
    return;
  }
  if (type === 'array') {
    exactAllowedKeys(spec, ['type', 'required', 'nullable', 'items', 'minItems', 'maxItems', 'uniqueItems', 'uniqueBy', 'orderedBy'], path);
    const array = asArray(value, path);
    const minItems = spec['minItems'];
    const maxItems = spec['maxItems'];
    if (minItems !== undefined) assert.ok(array.length >= asInteger(minItems, `${path}.minItems`), `${path} has too few items`);
    if (maxItems !== undefined) assert.ok(array.length <= asInteger(maxItems, `${path}.maxItems`), `${path} has too many items`);
    const itemSpec = objectAt(spec, 'items', path);
    array.forEach((entry, index) => validateItemSpec(itemSpec, entry, `${path}[${index}]`, refStack));
    if (spec['uniqueItems'] !== undefined) {
      assert.equal(asBoolean(spec['uniqueItems'], `${path}.uniqueItems`), true);
      requireUnique(array.map((entry) => canonicalJson(entry)), path);
    }
    if (spec['uniqueBy'] !== undefined) {
      const uniqueBy = asString(spec['uniqueBy'], `${path}.uniqueBy`);
      requireUnique(array.map((entry, index) => arrayItemIdentity(entry, uniqueBy, `${path}[${index}]`)), path);
    }
    if (spec['orderedBy'] !== undefined) {
      const orderedBy = asString(spec['orderedBy'], `${path}.orderedBy`);
      if (orderedBy !== 'roster_id,roster_revision presentation order') {
        requireSorted(array.map((entry, index) => orderedArrayKey(entry, orderedBy, `${path}[${index}]`)), path);
      }
    }
    return;
  }
  if (type === 'enum') {
    exactAllowedKeys(spec, ['type', 'required', 'nullable', 'values'], path);
    const values = arrayAt(spec, 'values', path);
    assert.ok(values.length > 0, `${path}.values must not be empty`);
    requireUnique(values.map((entry) => canonicalJson(entry)), `${path}.values`);
    assert.ok(jsonArrayIncludes(values, value), `${path} enum does not include ${canonicalJson(value)}`);
    return;
  }
  if (type === 'boolean') {
    exactAllowedKeys(spec, ['type', 'required', 'nullable'], path);
    asBoolean(value, path);
    return;
  }
  if (type === 'string') {
    validateStringSpec(spec, value, path);
    return;
  }
  if (type === 'object') {
    exactAllowedKeys(spec, ['type', 'required', 'nullable', 'ref', 'note'], path);
    if (spec['ref'] !== undefined) validateSchemaObject(value, stringAt(spec, 'ref', path), path, refStack);
    else asObject(value, path);
    return;
  }
  fail(`${path} unsupported field type ${type}`);
}

function validateSchemaObject(value: JsonValue, schemaName: string, path: string, refStack: readonly string[] = []): void {
  if (refStack.includes(schemaName)) fail(`${path} schema reference cycle: ${[...refStack, schemaName].join(' -> ')}`);
  const schema = objectAt(schemas, schemaName, 'definitions.schemas');
  const object = asObject(value, path);
  const fieldOrder = stringsAt(schema, 'field_order', `definitions.schemas.${schemaName}`);
  const required = stringsAt(schema, 'required', `definitions.schemas.${schemaName}`);
  const optional = stringsAt(schema, 'optional', `definitions.schemas.${schemaName}`);
  const fields = objectAt(schema, 'fields', `definitions.schemas.${schemaName}`);
  exactKeys(object, fieldOrder, path);
  assert.deepEqual([...required, ...optional], fieldOrder, `${schemaName} field_order must be required followed by optional`);
  for (const field of fieldOrder) {
    const fieldSpec = objectAt(fields, field, `definitions.schemas.${schemaName}.fields`);
    const expectedRequired = required.includes(field);
    assert.equal(booleanAt(fieldSpec, 'required', `definitions.schemas.${schemaName}.fields.${field}`), expectedRequired);
    const entry = object[field];
    if (entry === undefined) {
      if (expectedRequired) fail(`${path}.${field} required by ${schemaName}`);
      continue;
    }
    validateFieldValue(fieldSpec, entry, `${path}.${field}`, [...refStack, schemaName]);
  }
}

function validateSchemaDsl(): void {
  const schemaNames = Object.keys(schemas);
  sameStringSet(schemaNames, [...EXPECTED_SCHEMA_VERSIONS], 'definitions.schemas');
  const refGraph = new Map<string, string[]>();
  for (const schemaName of schemaNames) {
    const schema = objectAt(schemas, schemaName, 'definitions.schemas');
    const hasHash = schema['hash_field'] !== undefined;
    exactKeys(
      schema,
      hasHash
        ? ['closed', 'field_order', 'required', 'optional', 'fields', 'hash_field', 'semantic_rules']
        : ['closed', 'field_order', 'required', 'optional', 'fields', 'semantic_rules'],
      `definitions.schemas.${schemaName}`,
    );
    assert.equal(booleanAt(schema, 'closed', `definitions.schemas.${schemaName}`), true);
    const fieldOrder = stringsAt(schema, 'field_order', `definitions.schemas.${schemaName}`);
    const required = stringsAt(schema, 'required', `definitions.schemas.${schemaName}`);
    const optional = stringsAt(schema, 'optional', `definitions.schemas.${schemaName}`);
    assert.ok(fieldOrder.length > 0, `${schemaName} must have fields`);
    requireUnique(fieldOrder, `${schemaName}.field_order`);
    requireUnique(required, `${schemaName}.required`);
    requireUnique(optional, `${schemaName}.optional`);
    assert.deepEqual([...required, ...optional], fieldOrder, `${schemaName} required/optional must compose field_order`);
    const fields = objectAt(schema, 'fields', `definitions.schemas.${schemaName}`);
    exactKeys(fields, fieldOrder, `definitions.schemas.${schemaName}.fields`);
    const refs: string[] = [];
    for (const field of fieldOrder) {
      const fieldSpec = objectAt(fields, field, `definitions.schemas.${schemaName}.fields`);
      const type = stringAt(fieldSpec, 'type', `definitions.schemas.${schemaName}.fields.${field}`);
      assert.ok(['integer', 'array', 'enum', 'boolean', 'string', 'object'].includes(type), `${schemaName}.${field} has unknown type`);
      assert.equal(typeof booleanAt(fieldSpec, 'required', `definitions.schemas.${schemaName}.fields.${field}`), 'boolean');
      assert.equal(typeof booleanAt(fieldSpec, 'nullable', `definitions.schemas.${schemaName}.fields.${field}`), 'boolean');
      assert.equal(booleanAt(fieldSpec, 'required', `definitions.schemas.${schemaName}.fields.${field}`), required.includes(field));
      if (type === 'object' && fieldSpec['ref'] !== undefined) refs.push(stringAt(fieldSpec, 'ref', `definitions.schemas.${schemaName}.fields.${field}`));
      if (type === 'array') {
        const itemSpec = objectAt(fieldSpec, 'items', `definitions.schemas.${schemaName}.fields.${field}`);
        const itemType = stringAt(itemSpec, 'type', `definitions.schemas.${schemaName}.fields.${field}.items`);
        assert.ok(['enum', 'string', 'object'].includes(itemType), `${schemaName}.${field} has unknown item type`);
        if (itemType === 'object' && itemSpec['ref'] !== undefined) refs.push(stringAt(itemSpec, 'ref', `definitions.schemas.${schemaName}.fields.${field}.items`));
        if (fieldSpec['uniqueItems'] !== undefined) assert.equal(fieldSpec['uniqueBy'], undefined, `${schemaName}.${field} cannot mix uniqueItems and uniqueBy`);
      }
      if (type === 'enum') requireUnique(arrayAt(fieldSpec, 'values', `definitions.schemas.${schemaName}.fields.${field}`).map(canonicalJson), `${schemaName}.${field}.values`);
      if (type === 'string' && fieldSpec['pattern'] !== undefined) {
        const pattern = asString(fieldSpec['pattern'], `definitions.schemas.${schemaName}.fields.${field}.pattern`);
        assert.doesNotThrow(() => new RegExp(pattern, 'u'), `${schemaName}.${field}.pattern must compile`);
      }
      if (field.endsWith('sha256') || field === 'sha256') {
        assert.equal(type, 'string', `${schemaName}.${field} digest field must be string`);
        assert.equal(fieldSpec['pattern'], '^sha256:[a-f0-9]{64}$', `${schemaName}.${field} digest field must pin digest pattern`);
      }
      if (field === 'schema_version') {
        const values = arrayAt(fieldSpec, 'values', `definitions.schemas.${schemaName}.fields.schema_version`);
        assert.deepEqual(values, [schemaName], `${schemaName}.schema_version enum must name the schema exactly`);
      }
    }
    if (hasHash) {
      const hashField = stringAt(schema, 'hash_field', `definitions.schemas.${schemaName}`);
      assert.equal(fieldOrder[fieldOrder.length - 1], hashField, `${schemaName} hash field must be last`);
      assert.ok(required.includes(hashField), `${schemaName} hash field must be required`);
      const hashSpec = objectAt(fields, hashField, `definitions.schemas.${schemaName}.fields`);
      assert.equal(stringAt(hashSpec, 'type', `definitions.schemas.${schemaName}.fields.${hashField}`), 'string');
      assert.equal(booleanAt(hashSpec, 'nullable', `definitions.schemas.${schemaName}.fields.${hashField}`), false);
      assert.equal(hashSpec['pattern'], '^sha256:[a-f0-9]{64}$');
    }
    assert.ok(stringsAt(schema, 'semantic_rules', `definitions.schemas.${schemaName}`).length > 0, `${schemaName} needs semantic rules`);
    refGraph.set(schemaName, refs);
  }
  for (const [schemaName, refs] of refGraph) {
    for (const ref of refs) assert.ok(refGraph.has(ref), `${schemaName} references missing schema ${ref}`);
  }
  for (const schemaName of schemaNames) detectRefCycles(refGraph, schemaName, []);
}

function detectRefCycles(graph: ReadonlyMap<string, readonly string[]>, schemaName: string, stack: readonly string[]): void {
  if (stack.includes(schemaName)) fail(`schema ref cycle ${[...stack, schemaName].join(' -> ')}`);
  const refs = graph.get(schemaName);
  if (refs === undefined) fail(`missing ref graph node ${schemaName}`);
  for (const ref of refs) detectRefCycles(graph, ref, [...stack, schemaName]);
}

function validateSourcePins(): void {
  const pins = objectAt(definitions, 'current_v1_source_pins', 'definitions');
  exactKeys(pins, ['types_ts', 'schemas_ts', 'validate_ts', 'v1_immutability'], 'definitions.current_v1_source_pins');
  for (const key of ['types_ts', 'schemas_ts', 'validate_ts']) {
    const pin = objectAt(pins, key, 'definitions.current_v1_source_pins');
    exactKeys(pin, ['path', 'sha256'], `definitions.current_v1_source_pins.${key}`);
    const relativePath = stringAt(pin, 'path', `definitions.current_v1_source_pins.${key}`);
    assert.ok(relativePath.startsWith('src/core/contracts/'), `${key} must pin the current contracts source`);
    const digest = sha256Text(readFileSync(resolve(repoRoot, relativePath), 'utf8'));
    assert.equal(digest, stringAt(pin, 'sha256', `definitions.current_v1_source_pins.${key}`));
  }
  const immutability = stringAt(pins, 'v1_immutability', 'definitions.current_v1_source_pins');
  assert.match(immutability, /autopilot\.unit_spec\.v1/u);
  assert.match(immutability, /autopilot\.receipt\.v1/u);
  assert.match(immutability, /v2 is additive only/u);

  const unitSpec = objectAt(schemas, 'autopilot.unit_spec.v2', 'definitions.schemas');
  const receipt = objectAt(schemas, 'autopilot.receipt.v2', 'definitions.schemas');
  assert.ok(stringsAt(unitSpec, 'field_order', 'definitions.schemas.autopilot.unit_spec.v2').length >= 30);
  assert.ok(stringsAt(receipt, 'field_order', 'definitions.schemas.autopilot.receipt.v2').length >= 20);
  const unitFields = objectAt(unitSpec, 'fields', 'definitions.schemas.autopilot.unit_spec.v2');
  const receiptFields = objectAt(receipt, 'fields', 'definitions.schemas.autopilot.receipt.v2');
  assert.equal(stringAt(objectAt(unitFields, 'request_profile', 'unit_spec.v2.fields'), 'ref', 'unit_spec.v2.request_profile'), 'autopilot.request_profile.v1');
  assert.equal(stringAt(objectAt(receiptFields, 'request_profile', 'receipt.v2.fields'), 'ref', 'receipt.v2.request_profile'), 'autopilot.request_profile.v1');
  assert.equal(stringAt(objectAt(receiptFields, 'observed_profile', 'receipt.v2.fields'), 'ref', 'receipt.v2.observed_profile'), 'autopilot.observed_profile.v1');
  const contextRefs = objectAt(objectAt(unitFields, 'context_refs', 'unit_spec.v2.fields'), 'items', 'unit_spec.v2.context_refs');
  assert.equal(stringAt(contextRefs, 'ref', 'unit_spec.v2.context_refs.items'), 'autopilot.context_ref.v2');
}

function assignmentSetHash(assignments: readonly JsonObject[]): string {
  const assignmentSha256s = assignments.map((assignment) => stringAt(assignment, 'assignment_sha256', 'assignment'));
  return sha256Text(`${canonicalJson({
    schema_version: 'autopilot.assignment_set.v1',
    role_order: [...EXPECTED_ROLES],
    assignment_sha256s: assignmentSha256s,
  })}\n`);
}

function candidateSetId(candidateSet: JsonObject): string {
  return `candidate-set-${sha256Text(`${canonicalJson(omitField(omitField(candidateSet, 'candidate_set_sha256'), 'candidate_set_id'))}\n`).slice(7, 23)}`;
}

function serviceTierSortKey(value: JsonValue): string {
  if (value === null) return '\0';
  return asString(value, 'service_tier');
}

function uniqueJsonValues(values: readonly JsonValue[]): readonly JsonValue[] {
  const seen = new Set<string>();
  const result: JsonValue[] = [];
  for (const value of values) {
    const key = canonicalJson(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function routePolicyById(): Map<string, JsonObject> {
  return mapBy(objectsAt(manifest, 'route_policies', 'manifest'), 'route_policy_id', 'manifest.route_policies');
}

function recipeById(): Map<string, JsonObject> {
  return mapBy(objectsAt(manifest, 'provider_recipes', 'manifest'), 'recipe_id', 'manifest.provider_recipes');
}

function rosterById(): Map<string, JsonObject> {
  return mapBy(objectsAt(manifest, 'generated_rosters', 'manifest'), 'roster_id', 'manifest.generated_rosters');
}

function profileTemplateFor(recipe: JsonObject, profileId: string): JsonObject {
  const templates = objectsAt(recipe, 'profile_templates', `recipe.${stringAt(recipe, 'recipe_id', 'recipe')}`);
  const found = templates.find((template) => stringAt(template, 'profile_id', 'profile_template') === profileId);
  if (found === undefined) fail(`recipe ${stringAt(recipe, 'recipe_id', 'recipe')} lacks profile ${profileId}`);
  return found;
}

function roleTemplateFor(profileTemplate: JsonObject, role: string): JsonObject {
  const templates = objectsAt(profileTemplate, 'role_templates', 'profile_template');
  const found = templates.find((template) => stringAt(template, 'role', 'role_template') === role);
  if (found === undefined) fail(`profile_template lacks role ${role}`);
  return found;
}

function assertArrayContains(values: readonly JsonValue[], expected: JsonValue, path: string): void {
  assert.ok(jsonArrayIncludes(values, expected), `${path} must contain ${canonicalJson(expected)}`);
}

function assertNoSeedReadyContradiction(object: JsonValue, path: string): void {
  if (typeof object === 'string') {
    const lower = object.toLowerCase();
    if (path.includes('.forbidden_shapes') || path.includes('seed_readiness_policy.launch_ready_values_forbidden_in_manifest')) return;
    if (path.includes('fixture') || path.includes('fixtures')) return;
    assert.equal(lower.includes('seed-ready'), false, `${path} must not assert seed-ready`);
    assert.equal(lower.includes('certified'), false, `${path} must not assert certification`);
    return;
  }
  if (Array.isArray(object)) {
    object.forEach((entry, index) => assertNoSeedReadyContradiction(entry, `${path}[${index}]`));
    return;
  }
  if (isJsonObject(object)) {
    for (const key of Object.keys(object)) {
      const value = object[key];
      if (value === undefined) fail(`${path}.${key} unexpectedly undefined`);
      assertNoSeedReadyContradiction(value, `${path}.${key}`);
    }
  }
}

function validateRoutePolicies(): void {
  const routePolicies = objectsAt(manifest, 'route_policies', 'manifest');
  assert.equal(routePolicies.length, EXPECTED_ROUTE_POLICY_IDS.length);
  const byId = routePolicyById();
  sameStringSet([...byId.keys()], [...EXPECTED_ROUTE_POLICY_IDS], 'manifest.route_policies.route_policy_id');
  sameStringSet(routePolicies.map((policy) => stringAt(policy, 'provider_id', 'route_policy')), [...EXPECTED_PROVIDERS], 'route policy providers');
  for (const policy of routePolicies) {
    validateSchemaObject(policy, 'autopilot.route_policy.v1', `manifest.route_policy.${stringAt(policy, 'route_policy_id', 'route_policy')}`);
    assert.equal(hashObject(policy, 'route_policy_sha256'), stringAt(policy, 'route_policy_sha256', 'route_policy'));
    assert.equal(integerAt(policy, 'revision', 'route_policy'), 1);
    assert.deepEqual(stringsAt(policy, 'forbidden_gateways', 'route_policy'), [...EXPECTED_FORBIDDEN_GATEWAYS]);
    assert.equal(booleanAt(policy, 'requires_live_billing_proof', 'route_policy'), true);
    assert.equal(booleanAt(policy, 'non_certifying_seed', 'route_policy'), true);
    assert.notEqual(stringAt(policy, 'qualification_state', 'route_policy'), 'w4-certified-ready');
    assert.notEqual(stringAt(policy, 'policy_state', 'route_policy'), 'seed-ready');
    assert.equal(stringsAt(policy, 'allowed_apis', 'route_policy').includes('openrouter'), false);
  }
}

function validateRecipesAndRosters(): void {
  const routePolicies = routePolicyById();
  const recipes = objectsAt(manifest, 'provider_recipes', 'manifest');
  const rosters = objectsAt(manifest, 'generated_rosters', 'manifest');
  assert.equal(recipes.length, EXPECTED_RECIPE_IDS.length);
  assert.equal(rosters.length, 7);
  sameStringSet(recipes.map((recipe) => stringAt(recipe, 'recipe_id', 'provider_recipe')), [...EXPECTED_RECIPE_IDS], 'provider recipes');
  const recipeProfiles = new Set<string>();
  for (const recipe of recipes) {
    validateSchemaObject(recipe, 'autopilot.provider_recipe.v1', `manifest.provider_recipe.${stringAt(recipe, 'recipe_id', 'recipe')}`);
    assert.equal(hashObject(recipe, 'recipe_sha256'), stringAt(recipe, 'recipe_sha256', 'recipe'));
    assert.equal(booleanAt(recipe, 'non_certifying_seed', 'recipe'), true);
    assert.equal(at(recipe, 'certification_manifest_id', 'recipe'), null);
    assert.equal(at(recipe, 'certification_manifest_sha256', 'recipe'), null);
    const policy = getMapEntry(routePolicies, stringAt(recipe, 'route_policy_id', 'recipe'), 'route policies');
    assert.equal(integerAt(recipe, 'route_policy_revision', 'recipe'), integerAt(policy, 'revision', 'route_policy'));
    assert.equal(stringAt(recipe, 'provider_family', 'recipe'), stringAt(policy, 'provider_id', 'route_policy'));
    assert.equal(stringAt(recipe, 'qualification_state', 'recipe'), stringAt(policy, 'qualification_state', 'route_policy'));
    for (const profileTemplate of objectsAt(recipe, 'profile_templates', 'recipe')) {
      const profileId = stringAt(profileTemplate, 'profile_id', 'profile_template');
      recipeProfiles.add(`${profileId}:${stringAt(recipe, 'recipe_id', 'recipe')}`);
      assert.ok(EXPECTED_PROFILES.includes(profileId as (typeof EXPECTED_PROFILES)[number]), `unknown profile ${profileId}`);
      assert.equal(stringAt(profileTemplate, 'route_policy_id', 'profile_template'), stringAt(policy, 'route_policy_id', 'route_policy'));
      assert.equal(integerAt(profileTemplate, 'route_policy_revision', 'profile_template'), integerAt(policy, 'revision', 'route_policy'));
      const selectedByDefault = booleanAt(profileTemplate, 'selected_by_default', 'profile_template');
      assert.equal(selectedByDefault, profileId === 'cruise' && stringAt(recipe, 'recipe_id', 'recipe') === 'codex-subscription');
      const roleTemplates = objectsAt(profileTemplate, 'role_templates', 'profile_template');
      assert.deepEqual(roleTemplates.map((roleTemplate) => stringAt(roleTemplate, 'role', 'role_template')), [...EXPECTED_ROLES]);
      for (const roleTemplate of roleTemplates) {
        assertArrayContains(arrayAt(policy, 'allowed_apis', 'route_policy'), stringAt(roleTemplate, 'api', 'role_template'), 'policy.allowed_apis');
        assertArrayContains(arrayAt(policy, 'allowed_service_tiers', 'route_policy'), at(roleTemplate, 'service_tier', 'role_template'), 'policy.allowed_service_tiers');
        assertArrayContains(arrayAt(policy, 'allowed_cache_policies', 'route_policy'), stringAt(roleTemplate, 'cache_policy', 'role_template'), 'policy.allowed_cache_policies');
        assertArrayContains(arrayAt(policy, 'allowed_system_prompt_profiles', 'route_policy'), stringAt(roleTemplate, 'system_prompt_profile', 'role_template'), 'policy.allowed_system_prompt_profiles');
      }
    }
  }
  sameStringSet([...recipeProfiles], [
    'precision:anthropic-sanitized',
    'afterburner:codex-subscription',
    'cruise:codex-subscription',
    'precision:codex-subscription',
    'precision:kimi-coding-plan',
    'precision:opencode-go-plan',
    'precision:zai-coding-plan',
  ], 'profile x recipe seeds');

  const recipesById = recipeById();
  for (const roster of rosters) {
    validateSchemaObject(roster, 'autopilot.roster.v1', `manifest.generated_roster.${stringAt(roster, 'roster_id', 'roster')}`);
    assert.equal(at(roster, 'certification_manifest_id', 'roster'), null);
    assert.equal(at(roster, 'certification_manifest_sha256', 'roster'), null);
    assert.equal(stringAt(roster, 'generation_source', 'roster'), 'w0-non-certifying-seed');
    const assignments = objectsAt(roster, 'assignments', 'roster');
    assert.deepEqual(assignments.map((assignment) => stringAt(assignment, 'role', 'assignment')), [...EXPECTED_ROLES]);
    for (const assignment of assignments) {
      assert.equal(hashObject(assignment, 'assignment_sha256'), stringAt(assignment, 'assignment_sha256', 'assignment'));
    }
    assert.equal(assignmentSetHash(assignments), stringAt(roster, 'assignment_set_sha256', 'roster'));
    const expectedRosterId = `${stringAt(roster, 'profile_id', 'roster')}-${stringAt(roster, 'recipe_id', 'roster')}-${stringAt(roster, 'assignment_set_sha256', 'roster').slice(7, 19)}`;
    assert.equal(stringAt(roster, 'roster_id', 'roster'), expectedRosterId);
    const recipe = getMapEntry(recipesById, stringAt(roster, 'recipe_id', 'roster'), 'recipes');
    const profileTemplate = profileTemplateFor(recipe, stringAt(roster, 'profile_id', 'roster'));
    const routePolicy = getMapEntry(routePolicies, stringAt(recipe, 'route_policy_id', 'recipe'), 'route policies');
    assert.deepEqual(stringsAt(roster, 'route_policy_ids', 'roster'), [stringAt(routePolicy, 'route_policy_id', 'route_policy')]);
    assertRosterAssignments(roster, assignments, profileTemplate, routePolicy);
    assertRosterSummaries(roster, assignments, routePolicy);
    assert.equal(hashObject(roster, 'roster_sha256'), stringAt(roster, 'roster_sha256', 'roster'));
  }
}

function assertRosterAssignments(roster: JsonObject, assignments: readonly JsonObject[], profileTemplate: JsonObject, routePolicy: JsonObject): void {
  for (const assignment of assignments) {
    const role = stringAt(assignment, 'role', 'assignment');
    const roleTemplate = roleTemplateFor(profileTemplate, role);
    for (const key of [
      'model_id',
      'api',
      'thinking',
      'service_tier',
      'cache_policy',
      'system_prompt_profile',
      'context_window',
      'max_output_tokens',
      'input_modalities',
      'output_modalities',
      'reasoning_capability',
      'tool_capability',
    ]) {
      assert.deepEqual(at(assignment, key, 'assignment'), at(roleTemplate, key, 'role_template'), `${stringAt(roster, 'roster_id', 'roster')} ${role} tuple mismatch at ${key}`);
    }
    assert.equal(stringAt(assignment, 'provider_id', 'assignment'), stringAt(routePolicy, 'provider_id', 'route_policy'));
    assert.equal(stringAt(assignment, 'model', 'assignment'), `${stringAt(routePolicy, 'provider_id', 'route_policy')}/${stringAt(assignment, 'model_id', 'assignment')}`);
    assert.equal(stringAt(assignment, 'route_policy_id', 'assignment'), stringAt(routePolicy, 'route_policy_id', 'route_policy'));
    assert.equal(integerAt(assignment, 'route_policy_revision', 'assignment'), integerAt(routePolicy, 'revision', 'route_policy'));
    assert.equal(stringAt(assignment, 'billing_class', 'assignment'), stringAt(routePolicy, 'billing_class', 'route_policy'));
    assert.equal(stringAt(assignment, 'billing_route_class', 'assignment'), stringAt(routePolicy, 'billing_route_class', 'route_policy'));
    assertArrayContains(arrayAt(routePolicy, 'allowed_auth_classes', 'route_policy'), stringAt(assignment, 'auth_class', 'assignment'), 'route_policy.allowed_auth_classes');
    assertArrayContains(arrayAt(routePolicy, 'allowed_auth_sources', 'route_policy'), stringAt(assignment, 'auth_source', 'assignment'), 'route_policy.allowed_auth_sources');
    assert.equal(stringAt(assignment, 'qualification_state', 'assignment'), stringAt(routePolicy, 'qualification_state', 'route_policy'));
    assert.equal(stringAt(assignment, 'system_prompt_profile', 'assignment') === 'anthropic-autopilot-sanitized.v1', stringAt(routePolicy, 'provider_id', 'route_policy') === 'anthropic');
  }
}

function assertRosterSummaries(roster: JsonObject, assignments: readonly JsonObject[], routePolicy: JsonObject): void {
  const contexts = assignments.map((assignment) => integerAt(assignment, 'context_window', 'assignment'));
  const outputs = assignments.map((assignment) => integerAt(assignment, 'max_output_tokens', 'assignment'));
  const inputModalities = uniqueJsonValues(assignments.flatMap((assignment) => arrayAt(assignment, 'input_modalities', 'assignment'))).map((value) => asString(value, 'input modality')).sort(compareStrings);
  const outputModalities = uniqueJsonValues(assignments.flatMap((assignment) => arrayAt(assignment, 'output_modalities', 'assignment'))).map((value) => asString(value, 'output modality')).sort(compareStrings);
  const capability = objectAt(roster, 'capability_summary', 'roster');
  assert.equal(integerAt(capability, 'min_context_window', 'capability'), Math.min(...contexts));
  assert.equal(integerAt(capability, 'min_max_output_tokens', 'capability'), Math.min(...outputs));
  assert.deepEqual(stringsAt(capability, 'input_modalities', 'capability'), inputModalities);
  assert.deepEqual(stringsAt(capability, 'output_modalities', 'capability'), outputModalities);
  assert.equal(stringAt(capability, 'reasoning_capability', 'capability'), 'reasoning-supported');
  assert.equal(stringAt(capability, 'tool_capability', 'capability'), 'tool-use-supported');

  const billing = objectAt(roster, 'billing_summary', 'roster');
  assert.equal(stringAt(billing, 'billing_class', 'billing'), stringAt(routePolicy, 'billing_class', 'route_policy'));
  assert.equal(stringAt(billing, 'billing_route_class', 'billing'), stringAt(routePolicy, 'billing_route_class', 'route_policy'));
  assert.deepEqual(stringsAt(billing, 'route_policy_ids', 'billing'), [stringAt(routePolicy, 'route_policy_id', 'route_policy')]);
  const serviceTiers = [...uniqueJsonValues(assignments.map((assignment) => at(assignment, 'service_tier', 'assignment')))].sort((left, right) => compareStrings(serviceTierSortKey(left), serviceTierSortKey(right)));
  assert.deepEqual(arrayAt(billing, 'service_tiers', 'billing'), serviceTiers);

  const auth = objectAt(roster, 'auth_summary', 'roster');
  assert.deepEqual(stringsAt(auth, 'auth_classes', 'auth'), uniqueJsonValues(assignments.map((assignment) => stringAt(assignment, 'auth_class', 'assignment'))).map((value) => asString(value, 'auth class')).sort(compareStrings));
  assert.deepEqual(stringsAt(auth, 'auth_sources', 'auth'), uniqueJsonValues(assignments.map((assignment) => stringAt(assignment, 'auth_source', 'assignment'))).map((value) => asString(value, 'auth source')).sort(compareStrings));
  assert.equal(booleanAt(auth, 'secret_fields_present', 'auth'), false);
}

function validateCandidatesAndRegistries(): void {
  const routePolicies = routePolicyById();
  const recipes = recipeById();
  const rosters = rosterById();
  const candidates = objectsAt(manifest, 'seed_candidates', 'manifest');
  assert.equal(candidates.length, 7);
  assert.deepEqual(candidates.map((candidate) => stringAt(candidate, 'candidate_sort_key', 'candidate')), [...candidates.map((candidate) => stringAt(candidate, 'candidate_sort_key', 'candidate'))].sort(compareStrings));
  for (const candidate of candidates) {
    validateSchemaObject(candidate, 'autopilot.roster_candidate.v1', `manifest.seed_candidate.${stringAt(candidate, 'candidate_id', 'candidate')}`);
    assert.equal(booleanAt(candidate, 'non_certifying_seed', 'candidate'), true);
    assert.equal(booleanAt(candidate, 'synthetic_fixture_ready_only', 'candidate'), false);
    assert.notEqual(stringAt(candidate, 'candidate_state', 'candidate'), 'synthetic-fixture-ready');
    assert.notEqual(stringAt(candidate, 'launch_readiness', 'candidate'), 'synthetic-fixture-only');
    assert.notEqual(stringAt(candidate, 'qualification_state', 'candidate'), 'w4-certified-ready');
    assert.notEqual(stringAt(candidate, 'qualification_state', 'candidate'), 'synthetic-test-ready');
    const recipe = getMapEntry(recipes, stringAt(candidate, 'recipe_id', 'candidate'), 'recipes');
    assert.equal(integerAt(candidate, 'recipe_revision', 'candidate'), integerAt(recipe, 'recipe_revision', 'recipe'));
    const policy = getMapEntry(routePolicies, stringAt(candidate, 'route_policy_id', 'candidate'), 'route policies');
    assert.equal(stringAt(candidate, 'route_policy_id', 'candidate'), stringAt(recipe, 'route_policy_id', 'recipe'));
    assert.equal(integerAt(candidate, 'route_policy_revision', 'candidate'), integerAt(policy, 'revision', 'policy'));
    const roster = getMapEntry(rosters, stringAt(candidate, 'roster_id', 'candidate'), 'rosters');
    assert.equal(stringAt(candidate, 'profile_id', 'candidate'), stringAt(roster, 'profile_id', 'roster'));
    assert.equal(stringAt(candidate, 'recipe_id', 'candidate'), stringAt(roster, 'recipe_id', 'roster'));
    assert.equal(stringAt(candidate, 'assignment_set_sha256', 'candidate'), stringAt(roster, 'assignment_set_sha256', 'roster'));
    assert.equal(stringAt(candidate, 'roster_sha256', 'candidate'), stringAt(roster, 'roster_sha256', 'roster'));
    const state = stringAt(candidate, 'candidate_state', 'candidate');
    if (stringAt(policy, 'policy_state', 'policy') === 'blocked-live-certification') {
      assert.equal(state, 'blocked-live-certification');
      assert.equal(stringAt(candidate, 'launch_readiness', 'candidate'), 'blocked');
    } else {
      assert.equal(state, 'qualification-required');
      assert.equal(stringAt(candidate, 'launch_readiness', 'candidate'), 'not-ready-until-w4');
    }
    assert.equal(hashObject(candidate, 'candidate_sha256'), stringAt(candidate, 'candidate_sha256', 'candidate'));
  }
  const cruise = candidates.find((candidate) => stringAt(candidate, 'candidate_id', 'candidate') === 'codex-cruise-v1');
  const precision = candidates.find((candidate) => stringAt(candidate, 'candidate_id', 'candidate') === 'codex-precision-v1');
  if (cruise === undefined || precision === undefined) fail('codex convergence candidates missing');
  assert.equal(stringAt(cruise, 'converges_with', 'candidate'), stringAt(precision, 'candidate_id', 'candidate'));
  assert.equal(stringAt(cruise, 'assignment_set_sha256', 'candidate'), stringAt(precision, 'assignment_set_sha256', 'candidate'));

  const registries = objectAt(manifest, 'seed_registries', 'manifest');
  exactKeys(registries, ['route_policy_registry', 'provider_recipe_registry', 'seed_candidate_registry'], 'manifest.seed_registries');
  validateRegistry(
    objectAt(registries, 'route_policy_registry', 'manifest.seed_registries'),
    'autopilot.route_policy_registry.v1',
    'route_policies',
    'route_policy_id',
    'revision',
    'route_policy_sha256',
    'route_policy_registry_sha256',
    objectsAt(manifest, 'route_policies', 'manifest').map((policy) => [stringAt(policy, 'route_policy_id', 'policy'), integerAt(policy, 'revision', 'policy'), stringAt(policy, 'route_policy_sha256', 'policy')]),
  );
  validateRegistry(
    objectAt(registries, 'provider_recipe_registry', 'manifest.seed_registries'),
    'autopilot.provider_recipe_registry.v1',
    'recipes',
    'recipe_id',
    'recipe_revision',
    'recipe_sha256',
    'recipe_registry_sha256',
    objectsAt(manifest, 'provider_recipes', 'manifest').map((recipe) => [stringAt(recipe, 'recipe_id', 'recipe'), integerAt(recipe, 'recipe_revision', 'recipe'), stringAt(recipe, 'recipe_sha256', 'recipe')]),
  );
  validateCandidateRegistry(objectAt(registries, 'seed_candidate_registry', 'manifest.seed_registries'), candidates);
}

function validateRegistry(
  registry: JsonObject,
  schemaVersion: string,
  arrayKey: string,
  idKey: string,
  revisionKey: string,
  digestKey: string,
  registryDigestKey: string,
  expected: readonly (readonly [string, number, string])[],
): void {
  exactKeys(registry, ['schema_version', 'freeze_id', arrayKey, registryDigestKey], `registry.${schemaVersion}`);
  assert.equal(stringAt(registry, 'schema_version', 'registry'), schemaVersion);
  assert.equal(stringAt(registry, 'freeze_id', 'registry'), FREEZE_ID);
  const entries = objectsAt(registry, arrayKey, 'registry');
  assert.deepEqual(entries.map((entry) => [stringAt(entry, idKey, 'registry entry'), integerAt(entry, revisionKey, 'registry entry'), stringAt(entry, digestKey, 'registry entry')]), expected);
  assert.equal(hashObject(registry, registryDigestKey), stringAt(registry, registryDigestKey, 'registry'));
}

function validateCandidateRegistry(registry: JsonObject, candidates: readonly JsonObject[]): void {
  exactKeys(registry, ['schema_version', 'freeze_id', 'candidates', 'candidate_registry_sha256'], 'seed_candidate_registry');
  assert.equal(stringAt(registry, 'schema_version', 'candidate_registry'), 'autopilot.seed_candidate_registry.v1');
  assert.equal(stringAt(registry, 'freeze_id', 'candidate_registry'), FREEZE_ID);
  const entries = objectsAt(registry, 'candidates', 'candidate_registry');
  assert.deepEqual(
    entries.map((entry) => [stringAt(entry, 'candidate_id', 'candidate_registry'), stringAt(entry, 'candidate_sort_key', 'candidate_registry'), stringAt(entry, 'candidate_sha256', 'candidate_registry')]),
    candidates.map((candidate) => [stringAt(candidate, 'candidate_id', 'candidate'), stringAt(candidate, 'candidate_sort_key', 'candidate'), stringAt(candidate, 'candidate_sha256', 'candidate')]),
  );
  assert.equal(hashObject(registry, 'candidate_registry_sha256'), stringAt(registry, 'candidate_registry_sha256', 'candidate_registry'));
}

function validateFixtureObjects(): void {
  const registry = objectAt(fixtures, 'object_registry', 'fixtures');
  exactKeys(registry, [...FIXTURE_OBJECT_REGISTRY_KEYS], 'fixtures.object_registry');
  const fixturePolicy = objectsAt(registry, 'route_policies', 'fixture.object_registry');
  const fixtureRecipe = objectsAt(registry, 'provider_recipes', 'fixture.object_registry');
  assert.equal(fixturePolicy.length, 1);
  assert.equal(fixtureRecipe.length, 1);
  assert.deepEqual(fixturePolicy[0], getMapEntry(routePolicyById(), 'codex-subscription-v1', 'manifest.route_policies'));
  assert.deepEqual(fixtureRecipe[0], getMapEntry(recipeById(), 'codex-subscription', 'manifest.provider_recipes'));
  for (const inventory of objectsAt(registry, 'inventories', 'fixture.object_registry')) {
    validateSchemaObject(inventory, 'autopilot.roster_inventory.v1', `fixture.inventory.${stringAt(inventory, 'inventory_id', 'inventory')}`);
    assert.equal(stringAt(inventory, 'source', 'inventory'), 'synthetic-fixture');
    assert.equal(hashObject(inventory, 'inventory_sha256'), stringAt(inventory, 'inventory_sha256', 'inventory'));
    for (const provider of objectsAt(inventory, 'providers', 'inventory')) {
      assert.equal(booleanAt(provider, 'auth_configured', 'inventory_provider') && at(provider, 'auth_class', 'inventory_provider') === null, false);
    }
  }
  const candidateSet = objectAt(registry, 'synthetic_candidate_set', 'fixtures.object_registry');
  validateSchemaObject(candidateSet, 'autopilot.roster_candidate_set.v1', 'fixtures.synthetic_candidate_set');
  assert.equal(candidateSetId(candidateSet), stringAt(candidateSet, 'candidate_set_id', 'candidate_set'));
  assert.equal(hashObject(candidateSet, 'candidate_set_sha256'), stringAt(candidateSet, 'candidate_set_sha256', 'candidate_set'));
  for (const candidate of objectsAt(candidateSet, 'candidates', 'candidate_set')) {
    assert.equal(stringAt(candidate, 'candidate_state', 'candidate'), 'synthetic-fixture-ready');
    assert.equal(stringAt(candidate, 'launch_readiness', 'candidate'), 'synthetic-fixture-only');
    assert.equal(stringAt(candidate, 'qualification_state', 'candidate'), 'synthetic-test-ready');
    assert.equal(booleanAt(candidate, 'non_certifying_seed', 'candidate'), true);
    assert.equal(booleanAt(candidate, 'synthetic_fixture_ready_only', 'candidate'), true);
    assert.equal(hashObject(candidate, 'candidate_sha256'), stringAt(candidate, 'candidate_sha256', 'candidate'));
  }
  const config = objectAt(registry, 'synthetic_config', 'fixtures.object_registry');
  const receipt = objectAt(registry, 'synthetic_receipt', 'fixtures.object_registry');
  const selection = objectAt(registry, 'synthetic_pre_run_selection', 'fixtures.object_registry');
  validateSchemaObject(config, 'autopilot.roster_config.v1', 'fixtures.synthetic_config');
  validateSchemaObject(receipt, 'autopilot.roster_setup_receipt.v1', 'fixtures.synthetic_receipt');
  validateSchemaObject(selection, 'autopilot.pre_run_selection.v1', 'fixtures.synthetic_pre_run_selection');
  assert.equal(hashObject(config, 'config_sha256'), stringAt(config, 'config_sha256', 'config'));
  assert.equal(hashObject(receipt, 'receipt_sha256'), stringAt(receipt, 'receipt_sha256', 'receipt'));
  assert.equal(hashObject(selection, 'selection_sha256'), stringAt(selection, 'selection_sha256', 'selection'));
  assertDefaultTupleMatches(config, 'rosters', 'fixtures.synthetic_config');
  assertDefaultTupleMatches(receipt, 'saved_rosters', 'fixtures.synthetic_receipt');
  assert.equal(stringAt(receipt, 'default_roster_id', 'receipt'), stringAt(config, 'default_roster_id', 'config'));
  assert.equal(integerAt(receipt, 'default_roster_revision', 'receipt'), integerAt(config, 'default_roster_revision', 'config'));
  assert.equal(stringAt(receipt, 'default_roster_sha256', 'receipt'), stringAt(config, 'default_roster_sha256', 'config'));
  assert.equal(stringAt(receipt, 'approved_candidate_set_sha256', 'receipt'), stringAt(candidateSet, 'candidate_set_sha256', 'candidate_set'));
  assert.deepEqual(arrayAt(receipt, 'approved_roster_sha256s', 'receipt'), objectsAt(receipt, 'saved_rosters', 'receipt').map((saved) => stringAt(saved, 'roster_sha256', 'saved_roster')));

  validateHistoricalFixtureObjects(registry);

  const fixtureRegistry = objectAt(registry, 'fixture_registry', 'fixture.object_registry');
  exactKeys(fixtureRegistry, ['schema_version', 'freeze_id', 'fixture_case_sha256s', 'fixture_registry_sha256'], 'fixture_registry');
  assert.equal(stringAt(fixtureRegistry, 'schema_version', 'fixture_registry'), 'autopilot.fixture_registry.v1');
  assert.equal(stringAt(fixtureRegistry, 'freeze_id', 'fixture_registry'), FREEZE_ID);
  assert.deepEqual(stringsAt(fixtureRegistry, 'fixture_case_sha256s', 'fixture_registry'), objectsAt(fixtures, 'fixture_cases', 'fixtures').map((fixtureCase) => stringAt(fixtureCase, 'fixture_case_sha256', 'fixture_case')).sort(compareStrings));
  assert.equal(hashObject(fixtureRegistry, 'fixture_registry_sha256'), stringAt(fixtureRegistry, 'fixture_registry_sha256', 'fixture_registry'));
}

function validateHistoricalFixtureObjects(registry: JsonObject): void {
  const artifacts = objectsAt(registry, 'historical_artifacts', 'fixture.object_registry');
  assert.equal(artifacts.length, 2, 'historical artifacts must include unit and receipt bytes');
  const unit = artifacts.find((artifact) => stringAt(artifact, 'artifact_kind', 'historical_artifact') === 'unit-spec');
  const receipt = artifacts.find((artifact) => stringAt(artifact, 'artifact_kind', 'historical_artifact') === 'receipt');
  if (unit === undefined || receipt === undefined) fail('valid historical unit/receipt artifacts missing');
  for (const artifact of artifacts) {
    validateSchemaObject(artifact, 'autopilot.historical_fixed_roster_artifact.v1', `fixture.historical_artifact.${stringAt(artifact, 'artifact_id', 'historical_artifact')}`);
    assert.equal(sha256Text(stringAt(artifact, 'bytes_utf8', 'historical_artifact')), stringAt(artifact, 'bytes_sha256', 'historical_artifact'), 'historical byte digest must be literal');
    assertHashObject(artifact, 'artifact_sha256', 'historical_artifact');
  }
  const unitBytes = stringAt(unit, 'bytes_utf8', 'historical.unit');
  const receiptBytes = stringAt(receipt, 'bytes_utf8', 'historical.receipt');
  assert.ok(unitBytes.endsWith('\n'), 'historical unit bytes must preserve terminal LF');
  assert.ok(receiptBytes.endsWith('\n'), 'historical receipt bytes must preserve terminal LF');
  const parsedUnit = JSON.parse(unitBytes) as JsonObject;
  const parsedReceipt = JSON.parse(receiptBytes) as JsonObject;
  assert.equal(stringAt(parsedUnit, 'schema_version', 'historical.unit.bytes'), 'autopilot.unit_spec.v1');
  assert.equal(stringAt(parsedReceipt, 'schema_version', 'historical.receipt.bytes'), 'autopilot.receipt.v1');
  assert.equal(stringAt(parsedUnit, 'package_version', 'historical.unit.bytes'), '1.2.9');
  assert.equal(stringAt(parsedReceipt, 'package_version', 'historical.receipt.bytes'), '1.2.9');
  assert.equal(stringAt(parsedReceipt, 'unit_spec_sha256', 'historical.receipt.bytes'), stringAt(unit, 'bytes_sha256', 'historical.unit'));

  const request = objectAt(registry, 'historical_adapter_request', 'fixture.object_registry');
  const admission = objectAt(registry, 'historical_adapter_admission', 'fixture.object_registry');
  const result = objectAt(registry, 'historical_adapter_result', 'fixture.object_registry');
  validateSchemaObject(request, 'autopilot.historical_fixed_roster_adapter_request.v1', 'fixture.historical_adapter_request');
  validateSchemaObject(admission, 'autopilot.historical_fixed_roster_adapter_admission.v1', 'fixture.historical_adapter_admission');
  validateSchemaObject(result, 'autopilot.historical_fixed_roster_adapter_result.v1', 'fixture.historical_adapter_result');
  assertHashObject(request, 'request_sha256', 'historical.request');
  assertHashObject(admission, 'admission_sha256', 'historical.admission');
  assertHashObject(result, 'result_sha256', 'historical.result');
  assert.equal(stringAt(request, 'historical_unit_spec_sha256', 'historical.request'), stringAt(unit, 'bytes_sha256', 'historical.unit'));
  assert.equal(stringAt(request, 'historical_receipt_sha256', 'historical.request'), stringAt(receipt, 'bytes_sha256', 'historical.receipt'));
  assert.equal(stringAt(request, 'historical_unit_spec_bytes_utf8', 'historical.request'), unitBytes);
  assert.equal(stringAt(request, 'historical_receipt_bytes_utf8', 'historical.request'), receiptBytes);
  assert.equal(stringAt(request, 'pre_run_selection_state', 'historical.request'), 'absent');
  assert.equal(at(request, 'pre_run_selection_sha256', 'historical.request'), null);
  assert.deepEqual(arrayAt(request, 'conflicting_evidence_sha256s', 'historical.request'), []);
  assert.equal(booleanAt(admission, 'admitted', 'historical.admission'), true);
  assert.equal(booleanAt(admission, 'pre_run_selection_absent', 'historical.admission'), true);
  assert.equal(booleanAt(admission, 'no_conflicting_evidence', 'historical.admission'), true);
  assert.equal(booleanAt(admission, 'historical_bytes_mutated', 'historical.admission'), false);
  const roles = objectsAt(admission, 'roles', 'historical.admission');
  assert.deepEqual(roles.map((role) => stringAt(role, 'role', 'historical.role')), [...EXPECTED_ROLES]);
  const solRoles = new Set(['parent', 'strategy', 'validate', 'adjudicate', 'bughunt']);
  for (const role of roles) {
    const roleName = stringAt(role, 'role', 'historical.role');
    assert.equal(stringAt(role, 'provider_id', 'historical.role'), 'openai-codex');
    assert.equal(stringAt(role, 'api', 'historical.role'), 'openai-codex-responses');
    if (solRoles.has(roleName)) {
      assert.equal(stringAt(role, 'model_id', 'historical.role'), 'gpt-5.6-sol');
      assert.equal(stringAt(role, 'thinking', 'historical.role'), 'xhigh');
    } else if (roleName === 'implement' || roleName === 'fix') {
      assert.equal(stringAt(role, 'model_id', 'historical.role'), 'gpt-5.6-terra');
      assert.equal(stringAt(role, 'thinking', 'historical.role'), 'high');
    } else {
      assert.equal(roleName, 'extract');
      assert.equal(stringAt(role, 'model_id', 'historical.role'), 'gpt-5.6-luna');
      assert.equal(stringAt(role, 'thinking', 'historical.role'), 'high');
    }
  }
  assert.equal(booleanAt(result, 'ok', 'historical.result'), true);
  assert.equal(booleanAt(result, 'historical_bytes_mutated', 'historical.result'), false);
  assert.equal(integerAt(result, 'write_count', 'historical.result'), 0);
  assert.equal(integerAt(result, 'lock_count', 'historical.result'), 0);
  assert.deepEqual(arrayAt(result, 'files_touched', 'historical.result'), []);
  const expectedSelectionIdentity = selectionIdentityHash(
    asString(at(result, 'selected_scope', 'historical.result'), 'historical.result.selected_scope'),
    asString(at(result, 'selected_roster_id', 'historical.result'), 'historical.result.selected_roster_id'),
    asInteger(at(result, 'selected_roster_revision', 'historical.result'), 'historical.result.selected_roster_revision'),
    asString(at(result, 'selected_roster_sha256', 'historical.result'), 'historical.result.selected_roster_sha256'),
    asString(at(result, 'assignment_set_sha256', 'historical.result'), 'historical.result.assignment_set_sha256'),
    stringAt(result, 'historical_unit_spec_sha256', 'historical.result'),
    stringAt(result, 'historical_receipt_sha256', 'historical.result'),
  );
  assert.equal(stringAt(result, 'selection_identity_sha256', 'historical.result'), expectedSelectionIdentity);
}

function vectorObject(vectorId: string): JsonObject {
  const objectRegistry = objectAt(fixtures, 'object_registry', 'fixtures');
  if (vectorId === 'route-policy.codex-subscription-v1') return objectsAt(objectRegistry, 'route_policies', 'fixture.object_registry')[0] ?? fail('missing fixture route policy');
  if (vectorId === 'provider-recipe.codex-subscription-v1') return objectsAt(objectRegistry, 'provider_recipes', 'fixture.object_registry')[0] ?? fail('missing fixture recipe');
  if (vectorId === 'registry.provider-recipes.v1') return objectAt(objectAt(manifest, 'seed_registries', 'manifest'), 'provider_recipe_registry', 'manifest.seed_registries');
  const cruiseRoster = objectsAt(manifest, 'generated_rosters', 'manifest').find((roster) => stringAt(roster, 'roster_id', 'roster').startsWith('cruise-codex-subscription-'));
  if (cruiseRoster === undefined) fail('missing cruise roster');
  if (vectorId === 'roster.cruise-codex.synthetic.v1') return cruiseRoster;
  if (vectorId === 'assignment.parent.codex-sol-xhigh.v1') return roleAssignmentFromRoster(cruiseRoster, 'parent');
  if (vectorId === 'assignment.implement.codex-terra-high.v1') return roleAssignmentFromRoster(cruiseRoster, 'implement');
  if (vectorId === 'assignment.extract.codex-luna-high.v1') return roleAssignmentFromRoster(cruiseRoster, 'extract');
  for (const inventory of objectsAt(objectRegistry, 'inventories', 'fixture.object_registry')) {
    if (vectorId === 'inventory.qualified-codex.synthetic.v1' && stringAt(inventory, 'inventory_id', 'inventory') === 'inventory-qualified-codex-synthetic') return inventory;
    if (vectorId === 'inventory.codex-no-auth.synthetic.v1' && stringAt(inventory, 'inventory_id', 'inventory') === 'inventory-codex-no-auth-synthetic') return inventory;
  }
  if (vectorId === 'candidate-set.qualified-codex.synthetic.v1') return objectAt(objectRegistry, 'synthetic_candidate_set', 'fixture.object_registry');
  if (vectorId === 'config.success.synthetic.v1') return objectAt(objectRegistry, 'synthetic_config', 'fixture.object_registry');
  if (vectorId === 'receipt.success.synthetic.v1') return objectAt(objectRegistry, 'synthetic_receipt', 'fixture.object_registry');
  if (vectorId === 'pre-run-selection.success.synthetic.v1') return objectAt(objectRegistry, 'synthetic_pre_run_selection', 'fixture.object_registry');
  if (vectorId === 'historical-artifact.valid-v1-unit-spec') {
    const artifact = objectsAt(objectRegistry, 'historical_artifacts', 'fixture.object_registry').find((entry) => stringAt(entry, 'artifact_kind', 'historical_artifact') === 'unit-spec');
    if (artifact !== undefined) return artifact;
  }
  if (vectorId === 'historical-artifact.valid-v1-receipt') {
    const artifact = objectsAt(objectRegistry, 'historical_artifacts', 'fixture.object_registry').find((entry) => stringAt(entry, 'artifact_kind', 'historical_artifact') === 'receipt');
    if (artifact !== undefined) return artifact;
  }
  if (vectorId === 'historical-adapter.request.valid-v1') return objectAt(objectRegistry, 'historical_adapter_request', 'fixture.object_registry');
  if (vectorId === 'historical-adapter.admission.valid-v1') return objectAt(objectRegistry, 'historical_adapter_admission', 'fixture.object_registry');
  if (vectorId === 'historical-adapter.result.valid-v1') return objectAt(objectRegistry, 'historical_adapter_result', 'fixture.object_registry');
  if (vectorId === 'registry.fixture-cases.v1') return objectAt(objectRegistry, 'fixture_registry', 'fixture.object_registry');
  if (vectorId.startsWith('fixture-case.')) {
    const fixtureId = vectorId.slice('fixture-case.'.length);
    const fixtureCase = objectsAt(fixtures, 'fixture_cases', 'fixtures').find((entry) => stringAt(entry, 'fixture_id', 'fixture_case') === fixtureId);
    if (fixtureCase !== undefined) return fixtureCase;
  }
  fail(`missing canonical vector object for ${vectorId}`);
}

function roleAssignmentFromRoster(roster: JsonObject, role: string): JsonObject {
  const assignment = objectsAt(roster, 'assignments', 'roster').find((entry) => stringAt(entry, 'role', 'assignment') === role);
  if (assignment === undefined) fail(`missing roster assignment ${role}`);
  return assignment;
}

function validateCanonicalVectors(): void {
  const vectors = objectsAt(fixtures, 'canonical_vectors', 'fixtures');
  assert.equal(vectors.length, integerAt(objectAt(manifest, 'acceptance_fixture_authority', 'manifest'), 'canonical_vector_count', 'manifest.acceptance_fixture_authority'));
  requireUnique(vectors.map((vector) => stringAt(vector, 'vector_id', 'canonical_vector')), 'canonical vector ids');
  for (const vector of vectors) {
    exactKeys(vector, ['vector_id', 'hash_omission_field', 'canonical_json_utf8', 'sha256'], 'canonical_vector');
    const vectorId = stringAt(vector, 'vector_id', 'canonical_vector');
    const hashField = stringAt(vector, 'hash_omission_field', 'canonical_vector');
    const object = vectorObject(vectorId);
    const expectedCanonical = `${canonicalJson(omitField(object, hashField))}\n`;
    const canonical = stringAt(vector, 'canonical_json_utf8', 'canonical_vector');
    assert.equal(canonical, expectedCanonical, `${vectorId} canonical bytes mismatch`);
    assert.equal(sha256Text(canonical), stringAt(vector, 'sha256', 'canonical_vector'), `${vectorId} vector digest mismatch`);
    assert.equal(stringAt(vector, 'sha256', 'canonical_vector'), stringAt(object, hashField, `vector.${vectorId}`), `${vectorId} digest must equal object hash field`);
  }
}

function assertSchemaHashIfPresent(object: JsonObject, schemaName: string, path: string): void {
  const schema = objectAt(schemas, schemaName, 'definitions.schemas');
  const hashField = schema['hash_field'];
  if (hashField !== undefined) assertHashObject(object, asString(hashField, `${schemaName}.hash_field`), path);
}

function diagnosticCodesAt(object: JsonObject, key: string, path: string): readonly string[] {
  return arrayAt(object, key, path).map((entry, index) => {
    if (typeof entry === 'string') return entry;
    return stringAt(asObject(entry, `${path}.${key}[${index}]`), 'code', `${path}.${key}[${index}]`);
  });
}

function validateRuntimeEnvelope(fixtureId: string, inputs: JsonObject, expected: JsonObject): void {
  const action = stringAt(inputs, 'action', `${fixtureId}.inputs`);
  const runtimeInterface = stringAt(inputs, 'runtime_interface', `${fixtureId}.inputs`);
  const manageActions = ['inspect', 'propose', 'save', 'reject', 'doctor'];
  const runtimeActions = new Map<string, readonly [string, string, string]>([
    ['resolve-existing-run', ['resolve_existing_run', 'autopilot.existing_run_resolution_request.v1', 'autopilot.existing_run_resolution_result.v1']],
    ['publish-pre-run-selection', ['publish_pre_run_selection', 'autopilot.pre_run_selection_publish_request.v1', 'autopilot.pre_run_selection_publish_result.v1']],
    ['validate-receipt', ['validate_receipt', 'autopilot.receipt_validation_request.v1', 'autopilot.receipt_validation_result.v1']],
    ['historical-adapter', ['historical_adapter', 'autopilot.historical_fixed_roster_adapter_request.v1', 'autopilot.historical_fixed_roster_adapter_result.v1']],
  ]);
  if (manageActions.includes(action)) {
    assert.equal(runtimeInterface, 'autopilot_manage_rosters', `${fixtureId} manage action must declare autopilot_manage_rosters`);
    assert.equal(objectAt(objectAt(definitions, 'operations', 'definitions'), 'autopilot_manage_rosters', 'definitions.operations')['request_schema'], 'autopilot.roster_tool_request.v1');
    return;
  }
  const runtime = runtimeActions.get(action);
  if (runtime === undefined) fail(`${fixtureId} uses unfrozen fixture action ${action}`);
  const [expectedRuntime, requestSchema, resultSchema] = runtime;
  assert.equal(runtimeInterface, expectedRuntime, `${fixtureId} runtime interface mismatch`);
  assert.equal(stringAt(inputs, 'request_schema', `${fixtureId}.inputs`), requestSchema);
  assert.equal(stringAt(expected, 'result_schema', `${fixtureId}.expected`), resultSchema);
  const operation = objectAt(objectAt(definitions, 'operations', 'definitions'), expectedRuntime, 'definitions.operations');
  assert.equal(stringAt(operation, 'action', `definitions.operations.${expectedRuntime}`), action);
  assert.equal(stringAt(operation, 'request_schema', `definitions.operations.${expectedRuntime}`), requestSchema);
  assert.equal(stringAt(operation, 'result_schema', `definitions.operations.${expectedRuntime}`), resultSchema);
  const request = objectAt(inputs, 'request', `${fixtureId}.inputs`);
  const result = objectAt(expected, 'result', `${fixtureId}.expected`);
  validateSchemaObject(request, requestSchema, `${fixtureId}.inputs.request`);
  validateSchemaObject(result, resultSchema, `${fixtureId}.expected.result`);
  assertSchemaHashIfPresent(request, requestSchema, `${fixtureId}.inputs.request`);
  assertSchemaHashIfPresent(result, resultSchema, `${fixtureId}.expected.result`);
  assert.equal(booleanAt(result, 'ok', `${fixtureId}.expected.result`), booleanAt(expected, 'ok', `${fixtureId}.expected`));
  assert.equal(stringAt(result, 'status', `${fixtureId}.expected.result`), stringAt(expected, 'status', `${fixtureId}.expected`));
  assert.deepEqual(diagnosticCodesAt(result, 'diagnostics', `${fixtureId}.expected.result`), stringsAt(expected, 'diagnostics', `${fixtureId}.expected`));
  assert.equal(integerAt(result, 'write_count', `${fixtureId}.expected.result`), integerAt(expected, 'write_count', `${fixtureId}.expected`));
  assert.equal(integerAt(result, 'lock_count', `${fixtureId}.expected.result`), integerAt(expected, 'lock_count', `${fixtureId}.expected`));
  assert.deepEqual(stringsAt(result, 'files_touched', `${fixtureId}.expected.result`), stringsAt(expected, 'files_touched', `${fixtureId}.expected`));
}

function validateFixtureCases(): void {
  const fixtureCases = objectsAt(fixtures, 'fixture_cases', 'fixtures');
  const requirements = objectAt(definitions, 'acceptance_fixture_requirements', 'definitions');
  assert.equal(fixtureCases.length, integerAt(objectAt(manifest, 'acceptance_fixture_authority', 'manifest'), 'fixture_case_count', 'manifest.acceptance_fixture_authority'));
  assert.deepEqual(stringsAt(requirements, 'exact_fixture_fields', 'definitions.acceptance_fixture_requirements'), [...FIXTURE_CASE_KEYS]);
  requireUnique(fixtureCases.map((fixtureCase) => stringAt(fixtureCase, 'fixture_id', 'fixture_case')), 'fixture ids');
  const allTags: string[] = [];
  const diagnostics = new Set(stringsAt(definitions, 'diagnostic_code_registry', 'definitions'));
  for (const fixtureCase of fixtureCases) {
    exactKeys(fixtureCase, [...FIXTURE_CASE_KEYS], `fixture_case.${stringAt(fixtureCase, 'fixture_id', 'fixture_case')}`);
    const fixtureId = stringAt(fixtureCase, 'fixture_id', 'fixture_case');
    assert.ok(stringAt(fixtureCase, 'description', 'fixture_case').length > 0, `${fixtureId} must describe intent`);
    const tags = stringsAt(fixtureCase, 'tags', 'fixture_case');
    requireUnique(tags, `${fixtureId}.tags`);
    allTags.push(...tags);
    const inputs = objectAt(fixtureCase, 'inputs', 'fixture_case');
    assert.ok(Object.keys(inputs).length > 0, `${fixtureId} inputs must be structured`);
    const expected = objectAt(fixtureCase, 'expected', 'fixture_case');
    for (const key of ['ok', 'status', 'diagnostics', 'write_count', 'lock_count', 'files_touched']) assert.notEqual(expected[key], undefined, `${fixtureId}.expected.${key} missing`);
    validateRuntimeEnvelope(fixtureId, inputs, expected);
    const expectedDiagnostics = stringsAt(expected, 'diagnostics', `${fixtureId}.expected`);
    for (const diagnostic of expectedDiagnostics) assert.ok(diagnostics.has(diagnostic), `${fixtureId} has unknown diagnostic ${diagnostic}`);
    assert.ok(integerAt(expected, 'write_count', `${fixtureId}.expected`) >= 0);
    assert.ok(integerAt(expected, 'lock_count', `${fixtureId}.expected`) >= 0);
    const filesTouched = stringsAt(expected, 'files_touched', `${fixtureId}.expected`);
    requireUnique(filesTouched, `${fixtureId}.expected.files_touched`);
    if (stringAt(inputs, 'action', `${fixtureId}.inputs`) === 'save') {
      assert.equal(integerAt(expected, 'write_count', `${fixtureId}.expected`), filesTouched.length, `${fixtureId} write_count counts visible authority files only`);
      if (filesTouched.length > 0) assert.equal(integerAt(expected, 'lock_count', `${fixtureId}.expected`), 1, `${fixtureId} visible save writes require one writer lock`);
    }
    const postconditions = objectsAt(fixtureCase, 'filesystem_postconditions', 'fixture_case');
    assert.ok(postconditions.length > 0, `${fixtureId} needs filesystem postconditions`);
    for (const postcondition of postconditions) {
      assert.ok(stringAt(postcondition, 'path', `${fixtureId}.postcondition`).length > 0);
      assert.ok(stringAt(postcondition, 'state', `${fixtureId}.postcondition`).length > 0);
      if (postcondition['sha256'] !== undefined) assertDigest(asString(postcondition['sha256'], `${fixtureId}.postcondition.sha256`), `${fixtureId}.postcondition.sha256`);
      if (postcondition['count'] !== undefined) assert.ok(asInteger(postcondition['count'], `${fixtureId}.postcondition.count`) >= 0);
    }
    if (tags.some((tag) => tag.endsWith('zero-write')) || tags.includes('proposal-zero-write') || tags.includes('reject-zero-write')) {
      assert.equal(integerAt(expected, 'write_count', `${fixtureId}.expected`), 0, `${fixtureId} must be zero-write`);
      assert.equal(integerAt(expected, 'lock_count', `${fixtureId}.expected`), 0, `${fixtureId} must be zero-lock`);
      assert.deepEqual(filesTouched, [], `${fixtureId} must touch no files`);
    }
    if (tags.includes('config-last-success')) {
      assert.equal(booleanAt(expected, 'ok', `${fixtureId}.expected`), true);
      assert.equal(stringAt(expected, 'status', `${fixtureId}.expected`), 'saved');
      assert.equal(integerAt(expected, 'write_count', `${fixtureId}.expected`), 3, 'save success counts only two roster files plus config.json');
      assert.equal(integerAt(expected, 'write_count', `${fixtureId}.expected`), filesTouched.length);
      assert.equal(integerAt(expected, 'lock_count', `${fixtureId}.expected`), 1);
      assert.equal(stringAt(postconditions[0] ?? fail(`${fixtureId} missing config postcondition`), 'state', `${fixtureId}.postcondition`), 'exists-last');
      const rosterCount = postconditions.find((postcondition) => stringAt(postcondition, 'path', `${fixtureId}.postcondition`) === '~/.pi/agent/autopilot/rosters/*/revision-1.json');
      if (rosterCount === undefined) fail(`${fixtureId} lacks roster count postcondition`);
      assert.equal(asInteger(rosterCount['count'] ?? fail(`${fixtureId} roster count missing`), `${fixtureId}.count`), 2);
    }
    if (tags.includes('crash-before-config')) {
      const configPost = postconditions.find((postcondition) => stringAt(postcondition, 'path', `${fixtureId}.postcondition`) === '~/.pi/agent/autopilot/config.json');
      if (configPost === undefined) fail(`${fixtureId} lacks config absence postcondition`);
      assert.equal(stringAt(configPost, 'state', `${fixtureId}.config_postcondition`), 'absent');
      const orphanPost = postconditions.find((postcondition) => stringAt(postcondition, 'state', `${fixtureId}.postcondition`) === 'orphan-not-default');
      if (orphanPost === undefined) fail(`${fixtureId} lacks orphan roster postcondition`);
      assert.equal(asInteger(orphanPost['count'] ?? fail(`${fixtureId} orphan count missing`), `${fixtureId}.orphan_count`), 2);
    }
    if (stringAt(inputs, 'action', `${fixtureId}.inputs`) === 'historical-adapter') {
      assert.equal(integerAt(expected, 'write_count', `${fixtureId}.expected`), 0, `${fixtureId} historical adapter is zero-write`);
      assert.equal(integerAt(expected, 'lock_count', `${fixtureId}.expected`), 0, `${fixtureId} historical adapter is zero-lock`);
      assert.deepEqual(filesTouched, [], `${fixtureId} historical adapter touches no authority files`);
      const request = objectAt(inputs, 'request', `${fixtureId}.inputs`);
      assert.equal(sha256Text(stringAt(request, 'historical_unit_spec_bytes_utf8', `${fixtureId}.request`)), stringAt(request, 'historical_unit_spec_sha256', `${fixtureId}.request`));
      assert.equal(sha256Text(stringAt(request, 'historical_receipt_bytes_utf8', `${fixtureId}.request`)), stringAt(request, 'historical_receipt_sha256', `${fixtureId}.request`));
      const result = objectAt(expected, 'result', `${fixtureId}.expected`);
      const admission = objectAt(result, 'admission', `${fixtureId}.result`);
      assert.equal(booleanAt(result, 'historical_bytes_mutated', `${fixtureId}.result`), false);
      assert.equal(booleanAt(admission, 'historical_bytes_mutated', `${fixtureId}.admission`), false);
      if (booleanAt(expected, 'ok', `${fixtureId}.expected`)) {
        assert.equal(booleanAt(admission, 'admitted', `${fixtureId}.admission`), true);
        assert.equal(stringAt(result, 'selection_identity_sha256', `${fixtureId}.result`), selectionIdentityHash(
          asString(at(result, 'selected_scope', `${fixtureId}.result`), `${fixtureId}.result.selected_scope`),
          asString(at(result, 'selected_roster_id', `${fixtureId}.result`), `${fixtureId}.result.selected_roster_id`),
          asInteger(at(result, 'selected_roster_revision', `${fixtureId}.result`), `${fixtureId}.result.selected_roster_revision`),
          asString(at(result, 'selected_roster_sha256', `${fixtureId}.result`), `${fixtureId}.result.selected_roster_sha256`),
          asString(at(result, 'assignment_set_sha256', `${fixtureId}.result`), `${fixtureId}.result.assignment_set_sha256`),
          stringAt(result, 'historical_unit_spec_sha256', `${fixtureId}.result`),
          stringAt(result, 'historical_receipt_sha256', `${fixtureId}.result`),
        ));
      } else {
        assert.equal(booleanAt(admission, 'admitted', `${fixtureId}.admission`), false);
        assert.equal(at(result, 'selected_roster_id', `${fixtureId}.result`), null);
        assert.equal(at(result, 'selection_identity_sha256', `${fixtureId}.result`), null);
      }
    }
    assert.equal(hashObject(fixtureCase, 'fixture_case_sha256'), stringAt(fixtureCase, 'fixture_case_sha256', 'fixture_case'));
  }
  const requiredTags = stringsAt(requirements, 'required_tags', 'definitions.acceptance_fixture_requirements');
  const manifestTags = stringsAt(objectAt(manifest, 'acceptance_fixture_authority', 'manifest'), 'required_tags', 'manifest.acceptance_fixture_authority');
  assert.deepEqual(manifestTags, requiredTags);
  for (const tag of requiredTags) assert.ok(allTags.includes(tag), `fixtures must cover tag ${tag}`);
  for (const requiredDiagnostic of stringsAt(fixtures, 'diagnostic_code_registry', 'fixtures')) assert.ok(diagnostics.has(requiredDiagnostic));
}

function validateStorageResolutionCompatibilityAndOwnership(): void {
  const resolutionSummary = objectAt(manifest, 'resolution_summary', 'manifest');
  const resolution = objectAt(definitions, 'resolution', 'definitions');
  assert.deepEqual(resolutionSummary, resolution);
  assert.deepEqual(stringsAt(resolution, 'new_run_precedence', 'definitions.resolution'), ['explicit-roster', 'trusted-project-default', 'user-default', 'agent-first-onboarding']);
  assert.deepEqual(stringsAt(resolution, 'existing_run_precedence', 'definitions.resolution'), ['immutable-pre-run-selection', 'runtime-mirror-byte-equal-selection']);
  assert.equal(stringAt(resolution, 'fallback', 'definitions.resolution'), 'forbidden');
  assert.equal(stringAt(resolution, 'unavailable_existing_run_behavior', 'definitions.resolution'), 'explicit-roster-transition-required');

  const storage = objectAt(definitions, 'storage_protocols', 'definitions');
  const storageSummary = objectAt(manifest, 'storage_summary', 'manifest');
  assert.equal(stringAt(storageSummary, 'default_user_state_root', 'manifest.storage_summary'), '~/.pi/agent/autopilot/');
  assert.equal(stringAt(objectAt(storage, 'user_paths', 'definitions.storage_protocols'), 'state_root', 'definitions.storage_protocols.user_paths'), '~/.pi/agent/autopilot/');
  assert.equal(booleanAt(storageSummary, 'constructor_injected_state_root_for_tests', 'manifest.storage_summary'), true);
  for (const key of ['trust', 'config_cas', 'immutable_revision', 'pre_run_selection', 'lock', 'no_follow', 'temp_and_fsync', 'readback_and_crash', 'read_concurrency']) {
    const text = stringAt(storage, key, 'definitions.storage_protocols');
    assert.ok(text.length > 20, `storage ${key} must be explicit`);
  }
  assert.match(stringAt(storage, 'trust', 'definitions.storage_protocols'), /reads and true again for writes\/save/u);
  assert.match(stringAt(storage, 'config_cas', 'definitions.storage_protocols'), /no merge is allowed/u);
  assert.match(stringAt(storage, 'immutable_revision', 'definitions.storage_protocols'), /create-only/u);
  assert.match(stringAt(storage, 'pre_run_selection', 'definitions.storage_protocols'), /before worktree mutation\/spend/u);
  assert.match(stringAt(storage, 'lock', 'definitions.storage_protocols'), /pid\/start-time\/executable\/root identity/u);
  assert.match(stringAt(storage, 'temp_and_fsync', 'definitions.storage_protocols'), /config is published last/u);
  assert.match(stringAt(storage, 'readback_and_crash', 'definitions.storage_protocols'), /recompute every hash before receipt/u);

  const compatibility = objectAt(manifest, 'compatibility', 'manifest');
  assert.equal(stringAt(compatibility, 'new_run_specs', 'manifest.compatibility'), 'autopilot.unit_spec.v2');
  assert.equal(stringAt(compatibility, 'new_run_receipts', 'manifest.compatibility'), 'autopilot.receipt.v2');
  assert.match(stringAt(compatibility, 'historical_specs', 'manifest.compatibility'), /immutable/u);
  assert.match(stringAt(compatibility, 'historical_receipts', 'manifest.compatibility'), /immutable/u);
  assert.match(stringAt(compatibility, 'legacy_fixed_roster_adapter', 'manifest.compatibility'), /W1/u);
  assert.equal(booleanAt(compatibility, 'existing_snapshot_wins', 'manifest.compatibility'), true);
  assert.equal(booleanAt(compatibility, 'default_change_affects_existing_runs', 'manifest.compatibility'), false);

  const lanes = objectsAt(manifest, 'w1_lanes', 'manifest');
  assert.equal(lanes.length, 5);
  const exclusive = new Map<string, string>();
  for (const lane of lanes) {
    const laneId = stringAt(lane, 'lane_id', 'w1_lane');
    assert.ok(stringAt(lane, 'consumer', 'w1_lane').length > 0, `${laneId} needs production consumer`);
    for (const path of stringsAt(lane, 'exclusive_paths', 'w1_lane')) {
      if (exclusive.has(path)) fail(`${path} is claimed by both ${exclusive.get(path)} and ${laneId}`);
      exclusive.set(path, laneId);
    }
  }
  const contractsLane = lanes.find((lane) => stringAt(lane, 'lane_id', 'w1_lane') === 'w1-contracts');
  if (contractsLane === undefined) fail('w1-contracts lane missing');
  const contractPaths = stringsAt(contractsLane, 'exclusive_paths', 'w1_lane');
  for (const path of ['src/core/contracts/types.ts', 'src/core/contracts/schemas.ts', 'src/core/contracts/validate.ts', 'src/core/roster/historical-adapter.ts']) {
    assert.ok(contractPaths.includes(path), `w1-contracts must own ${path}`);
  }
  const fixtureLane = lanes.find((lane) => stringAt(lane, 'lane_id', 'w1_lane') === 'w1-fixtures');
  if (fixtureLane === undefined) fail('w1-fixtures lane missing');
  assert.ok(stringsAt(fixtureLane, 'exclusive_paths', 'w1_lane').includes('src/core/roster/fixture-corpus.ts'));
  const hotOwners = objectAt(manifest, 'hot_surface_owners', 'manifest');
  assert.equal(stringAt(hotOwners, 'src/core/model-roster.ts', 'manifest.hot_surface_owners'), 'immutable-during-w1');
  assert.equal(stringAt(hotOwners, 'src/extension.ts', 'manifest.hot_surface_owners'), 'post-w1-onboarding-owner');
  assert.equal(exclusive.has('src/core/model-roster.ts'), false);
  assert.equal(exclusive.has('src/extension.ts'), false);
}

test('raw authorities are duplicate-free, closed, digest-sealed, and non-circular', () => {
  exactKeys(manifest, [...MANIFEST_TOP_LEVEL_KEYS], 'manifest');
  exactKeys(definitions, [...DEFINITIONS_TOP_LEVEL_KEYS], 'definitions');
  exactKeys(fixtures, [...FIXTURES_TOP_LEVEL_KEYS], 'fixtures');
  assert.equal(stringAt(manifest, 'schema_version', 'manifest'), 'autopilot.phase37_w0_contract_freeze.v1');
  assert.equal(stringAt(definitions, 'schema_version', 'definitions'), 'autopilot.phase37_w0_contract_definitions.v1');
  assert.equal(stringAt(fixtures, 'schema_version', 'fixtures'), 'autopilot.phase37_w0_roster_acceptance_fixtures.v1');
  assert.equal(stringAt(manifest, 'freeze_id', 'manifest'), FREEZE_ID);
  assert.equal(stringAt(definitions, 'freeze_id', 'definitions'), FREEZE_ID);
  assert.equal(stringAt(fixtures, 'freeze_id', 'fixtures'), FREEZE_ID);
  const manifestDigest = sha256Bytes(manifestText);
  const definitionsDigest = sha256Bytes(definitionsText);
  const fixturesDigest = sha256Bytes(fixturesText);
  assert.equal(manifestSidecarText, manifestDigest);
  assert.equal(definitionsSidecarText, definitionsDigest);
  assert.equal(fixturesSidecarText, fixturesDigest);
  assertDigest(manifestSidecarText, 'manifest sidecar');
  assertDigest(definitionsSidecarText, 'definitions sidecar');
  assertDigest(fixturesSidecarText, 'fixtures sidecar');

  const artifactAuthority = objectAt(manifest, 'artifact_authority', 'manifest');
  assert.equal(stringAt(objectAt(artifactAuthority, 'definitions', 'manifest.artifact_authority'), 'sha256', 'manifest.artifact_authority.definitions'), definitionsDigest);
  assert.equal(stringAt(objectAt(artifactAuthority, 'fixtures', 'manifest.artifact_authority'), 'sha256', 'manifest.artifact_authority.fixtures'), fixturesDigest);
  assert.equal(stringAt(objectAt(manifest, 'schema_authority', 'manifest'), 'sha256', 'manifest.schema_authority'), definitionsDigest);
  assert.equal(stringAt(objectAt(manifest, 'canonicalization_authority', 'manifest'), 'sha256', 'manifest.canonicalization_authority'), definitionsDigest);
  assert.equal(stringAt(objectAt(manifest, 'acceptance_fixture_authority', 'manifest'), 'sha256', 'manifest.acceptance_fixture_authority'), fixturesDigest);
  assert.equal(definitionsText.includes(manifestDigest), false, 'definitions must not bind manifest digest');
  assert.equal(fixturesText.includes(manifestDigest), false, 'fixtures must not bind manifest digest');
  assert.equal(definitionsText.includes('PHASE37_ROSTER_CONTRACT_FREEZE.md'), false, 'definitions must not bind prose');
  assert.equal(fixturesText.includes('PHASE37_ROSTER_CONTRACT_FREEZE.md'), false, 'fixtures must not bind prose');
});

test('definitions DSL grammar, nested schemas, operations, and v2 source pins are complete', () => {
  assert.equal(stringAt(definitions, 'status', 'definitions'), 'w1-ready-schema-authority');
  assert.equal(booleanAt(definitions, 'not_provider_certification', 'definitions'), true);
  const constants = objectAt(definitions, 'constants', 'definitions');
  assert.deepEqual(stringsAt(constants, 'role_order', 'definitions.constants'), [...EXPECTED_ROLES]);
  assert.deepEqual(stringsAt(constants, 'child_role_order', 'definitions.constants'), [...EXPECTED_CHILD_ROLES]);
  assert.equal(stringAt(constants, 'default_user_state_root', 'definitions.constants'), '~/.pi/agent/autopilot/');
  assert.match(stringAt(constants, 'test_state_root_rule', 'definitions.constants'), /tests/u);
  const manifestSchemaVersions = stringsAt(objectAt(manifest, 'schema_authority', 'manifest'), 'schema_versions', 'manifest.schema_authority');
  assert.deepEqual(manifestSchemaVersions, [...EXPECTED_SCHEMA_VERSIONS]);
  validateSchemaDsl();
  validateSourcePins();
  const canonical = objectAt(definitions, 'canonical_hash_algorithm', 'definitions');
  assert.equal(stringAt(canonical, 'algorithm_id', 'definitions.canonical_hash_algorithm'), CANONICAL_ALGORITHM);
  assert.match(stringAt(canonical, 'canonical_json', 'definitions.canonical_hash_algorithm'), /RFC-8785/u);
  assert.equal(stringAt(canonical, 'digest_format', 'definitions.canonical_hash_algorithm'), 'sha256:<64 lowercase hex>');
  assert.match(stringAt(canonical, 'own_hash_omission', 'definitions.canonical_hash_algorithm'), /omit only that object's hash_field/u);
  assert.match(stringAt(canonical, 'approval_binding', 'definitions.canonical_hash_algorithm'), /stale, reordered, partial, extra, or duplicate approvals reject before lock acquisition/u);
  const operations = objectAt(definitions, 'operations', 'definitions');
  exactKeys(operations, [
    'autopilot_manage_rosters',
    'resolve_existing_run',
    'publish_pre_run_selection',
    'validate_receipt',
    'historical_adapter',
    'route_resolver',
    'recipe_resolver',
    'doctor',
  ], 'definitions.operations');
  const runtimeContracts = [
    ['resolve_existing_run', 'resolve-existing-run', 'autopilot.existing_run_resolution_request.v1', 'autopilot.existing_run_resolution_result.v1'],
    ['publish_pre_run_selection', 'publish-pre-run-selection', 'autopilot.pre_run_selection_publish_request.v1', 'autopilot.pre_run_selection_publish_result.v1'],
    ['validate_receipt', 'validate-receipt', 'autopilot.receipt_validation_request.v1', 'autopilot.receipt_validation_result.v1'],
    ['historical_adapter', 'historical-adapter', 'autopilot.historical_fixed_roster_adapter_request.v1', 'autopilot.historical_fixed_roster_adapter_result.v1'],
  ] as const;
  for (const [key, action, requestSchema, resultSchema] of runtimeContracts) {
    const contract = objectAt(operations, key, 'definitions.operations');
    assert.equal(stringAt(contract, 'action', `definitions.operations.${key}`), action);
    assert.equal(stringAt(contract, 'request_schema', `definitions.operations.${key}`), requestSchema);
    assert.equal(stringAt(contract, 'result_schema', `definitions.operations.${key}`), resultSchema);
    assert.notEqual(schemas[requestSchema], undefined, `${requestSchema} must exist`);
    assert.notEqual(schemas[resultSchema], undefined, `${resultSchema} must exist`);
  }
  const manage = objectAt(operations, 'autopilot_manage_rosters', 'definitions.operations');
  assert.deepEqual(stringsAt(manage, 'actions', 'definitions.operations.autopilot_manage_rosters'), ['inspect', 'propose', 'save', 'reject', 'doctor']);
  const accounting = objectAt(manage, 'accounting', 'definitions.operations.autopilot_manage_rosters');
  assert.equal(integerAt(accounting, 'save_success_write_count', 'definitions.operations.accounting'), 3);
  assert.match(stringAt(accounting, 'write_count', 'definitions.operations.accounting'), /temp files.*receipt.*lock files do not increment write_count/u);
  assert.match(stringAt(accounting, 'receipt_count', 'definitions.operations.accounting'), /increments neither write_count nor files_touched/u);
  const doctor = objectAt(schemas, 'autopilot.roster_doctor_result.v1', 'definitions.schemas');
  const doctorFields = objectAt(doctor, 'fields', 'definitions.schemas.autopilot.roster_doctor_result.v1');
  assert.equal(stringAt(objectAt(doctorFields, 'route_results', 'doctor.fields'), 'uniqueBy', 'doctor.route_results'), 'result_sha256');
  assert.equal(stringAt(objectAt(doctorFields, 'route_results', 'doctor.fields'), 'orderedBy', 'doctor.route_results'), 'result_sha256');
  assert.equal(stringAt(objectAt(doctorFields, 'recipe_results', 'doctor.fields'), 'uniqueBy', 'doctor.recipe_results'), 'result_sha256');
  assert.equal(stringAt(objectAt(doctorFields, 'recipe_results', 'doctor.fields'), 'orderedBy', 'doctor.recipe_results'), 'result_sha256');
  const historicalContract = objectAt(operations, 'historical_adapter', 'definitions.operations');
  assert.equal(stringAt(historicalContract, 'admission_schema', 'definitions.operations.historical_adapter'), 'autopilot.historical_fixed_roster_adapter_admission.v1');
  const proofAlgorithm = stringsAt(historicalContract, 'proof_algorithm', 'definitions.operations.historical_adapter').join('\n');
  for (const requiredProof of ['pre-run selection', 'strictly less than 1.3.0', 'Sol/Terra/Luna', 'conflicting_evidence_sha256s to be empty', 'never mutate historical bytes', 'fail closed']) {
    assert.ok(proofAlgorithm.includes(requiredProof), `historical proof must include ${requiredProof}`);
  }
  const diagnostics = stringsAt(definitions, 'diagnostic_code_registry', 'definitions');
  assert.equal(diagnostics.length, 31);
  requireUnique(diagnostics, 'diagnostic_code_registry');
  for (const historicalCode of ['ROSTER_HISTORICAL_PROOF_REQUIRED', 'ROSTER_HISTORICAL_SELECTION_PRESENT', 'ROSTER_HISTORICAL_VERSION_UNSUPPORTED', 'ROSTER_HISTORICAL_FIXED_ROSTER_MISMATCH', 'ROSTER_HISTORICAL_CONFLICTING_EVIDENCE']) {
    assert.ok(diagnostics.includes(historicalCode), `diagnostic ${historicalCode} missing`);
  }
  assert.deepEqual(stringsAt(fixtures, 'diagnostic_code_registry', 'fixtures'), diagnostics);
});

test('manifest target, storage, resolution, compatibility, W1 ownership, and prose summaries are frozen', () => {
  const target = objectAt(manifest, 'target', 'manifest');
  assert.equal(stringAt(target, 'package_version', 'manifest.target'), '1.3.0');
  assert.equal(stringAt(target, 'pi_contract_baseline', 'manifest.target'), '0.80.6');
  assert.equal(stringAt(target, 'coordinator_protocol', 'manifest.target'), '1.6');
  assert.equal(integerAt(target, 'coordinator_api_schema', 'manifest.target'), 12);
  assert.equal(integerAt(target, 'coordinator_store_schema', 'manifest.target'), 13);
  assert.equal(booleanAt(target, 'coordinator_schema_change', 'manifest.target'), false);
  assert.equal(at(target, 'new_install_default_roster', 'manifest.target'), null);
  assert.equal(stringAt(target, 'default_user_state_root', 'manifest.target'), '~/.pi/agent/autopilot/');
  assert.equal(booleanAt(target, 'live_provider_certification_asserted', 'manifest.target'), false);
  const profileObjects = objectsAt(manifest, 'profiles', 'manifest');
  assert.deepEqual(profileObjects.map((profile) => stringAt(profile, 'profile_id', 'profile')), [...EXPECTED_PROFILES]);
  assert.equal(profileObjects.filter((profile) => booleanAt(profile, 'recommended_by_default', 'profile')).map((profile) => stringAt(profile, 'profile_id', 'profile')).join(','), 'cruise');
  assert.deepEqual(stringsAt(manifest, 'roles', 'manifest'), [...EXPECTED_ROLES]);
  validateStorageResolutionCompatibilityAndOwnership();
  const forbiddenShapes = stringsAt(manifest, 'forbidden_shapes', 'manifest');
  sameStringSet(forbiddenShapes, stringsAt(definitions, 'forbidden_shapes', 'definitions'), 'forbidden_shapes');
  for (const text of ['implicit package default', 'XDG default state root', 'OpenRouter', 'thinking clamping', 'same-session auto-start', 'overlapping hot-file ownership']) {
    assert.ok(forbiddenShapes.join('\n').includes(text), `forbidden shapes must include ${text}`);
  }
  const manifestDigest = manifestSidecarText;
  assert.ok(freezeDocText.includes(FREEZE_ID));
  assert.ok(freezeDocText.includes(manifestDigest));
  assert.ok(freezeDocText.includes(definitionsSidecarText));
  assert.ok(freezeDocText.includes(fixturesSidecarText));
  assert.ok(freezeDocText.includes('W1-READY'));
  assert.ok(freezeDocText.includes('NON-CERTIFYING SEEDS'));
  assert.ok(freezeDocText.includes('authority is non-circular'));
  for (const lane of objectsAt(manifest, 'w1_lanes', 'manifest')) assert.ok(freezeDocText.includes(stringAt(lane, 'lane_id', 'w1_lane')));
});

test('manifest route policies, recipes, rosters, candidates, registries, and seed-readiness semantics conform', () => {
  const readiness = objectAt(manifest, 'seed_readiness_policy', 'manifest');
  assert.equal(booleanAt(readiness, 'live_provider_certification_asserted', 'manifest.seed_readiness_policy'), false);
  assert.equal(stringAt(readiness, 'w0_seed_state', 'manifest.seed_readiness_policy'), 'unqualified-non-certifying until W4');
  assert.deepEqual(stringsAt(readiness, 'launch_ready_values_forbidden_in_manifest', 'manifest.seed_readiness_policy'), ['ready', 'seed-ready', 'certified']);
  validateRoutePolicies();
  validateRecipesAndRosters();
  validateCandidatesAndRegistries();
  assertNoSeedReadyContradiction(at(manifest, 'route_policies', 'manifest'), 'manifest.route_policies');
  assertNoSeedReadyContradiction(at(manifest, 'provider_recipes', 'manifest'), 'manifest.provider_recipes');
  assertNoSeedReadyContradiction(at(manifest, 'generated_rosters', 'manifest'), 'manifest.generated_rosters');
  assertNoSeedReadyContradiction(at(manifest, 'seed_candidates', 'manifest'), 'manifest.seed_candidates');
});

test('acceptance fixtures validate object registry, canonical vectors, case coverage, and write/lock/filesystem expectations', () => {
  assert.equal(stringAt(fixtures, 'status', 'fixtures'), 'w1-ready-fixture-authority');
  const boundary = objectAt(fixtures, 'authority_boundary', 'fixtures');
  assert.equal(stringAt(boundary, 'binds_to', 'fixtures.authority_boundary'), 'freeze_id only');
  assert.deepEqual(stringsAt(boundary, 'forbidden_bindings', 'fixtures.authority_boundary'), ['machine manifest digest', 'prose digest']);
  const evidence = objectAt(fixtures, 'evidence_notice', 'fixtures');
  assert.equal(stringAt(evidence, 'all_provider_inventory_auth_and_certification_facts_are', 'fixtures.evidence_notice'), 'synthetic');
  assert.equal(booleanAt(evidence, 'provider_evidence_is_certifying', 'fixtures.evidence_notice'), false);
  assert.equal(booleanAt(evidence, 'secrets_included', 'fixtures.evidence_notice'), false);
  assert.equal(booleanAt(evidence, 'live_provider_calls_required', 'fixtures.evidence_notice'), false);
  const canonicalization = objectAt(fixtures, 'canonicalization', 'fixtures');
  assert.equal(stringAt(canonicalization, 'algorithm_id', 'fixtures.canonicalization'), CANONICAL_ALGORITHM);
  assert.equal(stringAt(canonicalization, 'definition_freeze_id', 'fixtures.canonicalization'), FREEZE_ID);
  assert.equal(booleanAt(canonicalization, 'terminal_lf', 'fixtures.canonicalization'), true);
  assert.equal(stringAt(canonicalization, 'digest_encoding', 'fixtures.canonicalization'), 'sha256:<64 lowercase hex>');
  assert.equal(stringAt(objectAt(fixtures, 'fixed_values', 'fixtures'), 'production_default_user_state_root', 'fixtures.fixed_values'), '~/.pi/agent/autopilot/');
  validateFixtureObjects();
  validateCanonicalVectors();
  validateFixtureCases();
});

test('credential, gateway, fallback, and certification contradictions are absent from launch authority', () => {
  const inventoryApi = objectAt(definitions, 'inventory_api', 'definitions');
  assert.equal(stringAt(inventoryApi, 'credential_resolution_during_inspection', 'definitions.inventory_api'), 'forbidden');
  assert.deepEqual(arrayAt(inventoryApi, 'secret_fields_allowed', 'definitions.inventory_api'), []);
  assert.equal(stringAt(inventoryApi, 'project_trust_method', 'definitions.inventory_api'), 'ctx.isProjectTrusted');
  const routeContract = objectAt(definitions, 'route_recipe_candidate_contract', 'definitions');
  assert.match(stringAt(routeContract, 'direct_reference_rule', 'definitions.route_recipe_candidate_contract'), /never derive a provider from recipe\/model names/u);
  assert.match(stringAt(routeContract, 'seed_readiness_rule', 'definitions.route_recipe_candidate_contract'), /not launch-ready until W4/u);
  for (const policy of objectsAt(manifest, 'route_policies', 'manifest')) {
    assert.deepEqual(stringsAt(policy, 'forbidden_gateways', 'route_policy'), [...EXPECTED_FORBIDDEN_GATEWAYS]);
    assert.equal(stringsAt(policy, 'allowed_apis', 'route_policy').some((api) => /openrouter/iu.test(api)), false);
  }
  assert.equal(stringAt(objectAt(manifest, 'resolution_summary', 'manifest'), 'fallback', 'manifest.resolution_summary'), 'forbidden');
  assert.equal(booleanAt(objectAt(manifest, 'target', 'manifest'), 'live_provider_certification_asserted', 'manifest.target'), false);
  for (const roster of objectsAt(manifest, 'generated_rosters', 'manifest')) {
    assert.equal(at(roster, 'certification_manifest_id', 'roster'), null);
    assert.equal(at(roster, 'certification_manifest_sha256', 'roster'), null);
    for (const assignment of objectsAt(roster, 'assignments', 'roster')) {
      assert.equal(stringAt(assignment, 'auth_source', 'assignment') === 'environment', false, 'persisted launch seeds must not bind env credentials');
    }
  }
  assert.equal(freezeDocText.includes('All manifest seeds are unqualified, non-certifying, and not launch-ready until W4 qualification.'), true);
});
