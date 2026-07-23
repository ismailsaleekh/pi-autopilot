import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AUTOPILOT_JSON_SCHEMAS,
  AUTOPILOT_ROSTER_CONTRACT_SCHEMA_DEFINITIONS,
  AUTOPILOT_ROSTER_SCHEMA_VERSION_VALUES,
  AutopilotRosterContractValidationError,
  computeAutopilotRosterContractObjectHash,
  parseAutopilotReceipt,
  parseAutopilotReceiptV2,
  parseAutopilotRoster,
  parseAutopilotRosterCandidateSet,
  parseAutopilotRosterConfig,
  parseAutopilotRosterContract,
  parseAutopilotRosterContractJson,
  parseAutopilotUnitSpec,
  parseAutopilotUnitSpecV2,
  type AutopilotReceipt,
  type AutopilotRosterContractSchemaVersion,
  type AutopilotUnitSpec,
} from '../../src/core/contracts/index.ts';
import { AUTOPILOT_SCHEMA_NAMES } from '../../src/core/names.ts';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..', '..');
const FIXTURES = readJsonObject(resolve(REPO_ROOT, 'design/phase37/roster-acceptance-fixtures.v1.json'));
const MANIFEST = readJsonObject(resolve(REPO_ROOT, 'design/phase37/roster-contract-freeze.v1.json'));
const REGISTRY = objectAt(FIXTURES, 'object_registry');

void describe('Phase 37 roster contract parsers', () => {
  void it('exports every W0 roster schema through names and JSON schema descriptors', () => {
    assert.equal(AUTOPILOT_ROSTER_SCHEMA_VERSION_VALUES.length, 46);
    for (const schemaVersion of AUTOPILOT_ROSTER_SCHEMA_VERSION_VALUES) {
      assert.ok(AUTOPILOT_SCHEMA_NAMES.includes(schemaVersion));
      assert.ok(AUTOPILOT_ROSTER_CONTRACT_SCHEMA_DEFINITIONS[schemaVersion].closed);
    }
    assert.equal(
      objectAt(AUTOPILOT_JSON_SCHEMAS.rosterContracts, 'autopilot.unit_spec.v2')['additionalProperties'],
      false,
    );
    assert.equal(objectAt(AUTOPILOT_JSON_SCHEMAS.unitSpecV2, 'properties')['schema_version'] !== undefined, true);
    assert.equal(objectAt(AUTOPILOT_JSON_SCHEMAS.receiptV2, 'properties')['schema_version'] !== undefined, true);
  });

  void it('deep-freezes exported roster contract and JSON schema authority', () => {
    const schemaVersion = 'autopilot.roster_candidate_set.v1';
    const definition = AUTOPILOT_ROSTER_CONTRACT_SCHEMA_DEFINITIONS[schemaVersion];
    const jsonSchema = objectAt(AUTOPILOT_JSON_SCHEMAS.rosterContracts, schemaVersion);
    const jsonProperties = objectAt(jsonSchema, 'properties');
    const jsonRequired = arrayAt(jsonSchema, 'required');

    assert.equal(Object.isFrozen(AUTOPILOT_ROSTER_SCHEMA_VERSION_VALUES), true);
    assert.equal(Object.isFrozen(definition.required), true);
    assert.equal(Object.isFrozen(definition.fields), true);
    assert.equal(Object.isFrozen(definition.fields['candidates']), true);
    assert.equal(Object.isFrozen(jsonProperties), true);
    assert.equal(Object.isFrozen(jsonRequired), true);

    assert.throws(() => {
      Reflect.apply(Array.prototype.push, AUTOPILOT_ROSTER_SCHEMA_VERSION_VALUES, ['autopilot.forged.v1']);
    }, TypeError);
    assert.throws(() => {
      Reflect.apply(Array.prototype.push, definition.required, ['forged']);
    }, TypeError);
    assert.throws(() => {
      Object.defineProperty(definition.fields, 'forged', { value: { type: 'string' } });
    }, TypeError);
    assert.throws(() => {
      Object.defineProperty(jsonProperties, 'forged', { value: { type: 'string' } });
    }, TypeError);
    assert.throws(() => {
      Reflect.apply(Array.prototype.push, jsonRequired, ['forged']);
    }, TypeError);
  });

  void it('keeps v1 unit spec and receipt contracts stable while W1 roster contracts are additive', () => {
    const unitSpecProperties = objectAt(objectAt(AUTOPILOT_JSON_SCHEMAS.unitSpec, 'properties'), 'schema_version');
    assert.deepEqual(unitSpecProperties, { const: 'autopilot.unit_spec.v1' });
    assert.equal(AUTOPILOT_JSON_SCHEMAS.unitSpec['additionalProperties'], false);
    assert.deepEqual(arrayAt(AUTOPILOT_JSON_SCHEMAS.unitSpec, 'required'), [
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
    ]);
    assert.equal(objectAt(AUTOPILOT_JSON_SCHEMAS.unitSpec, 'properties')['request_profile'], undefined);
    assert.equal(objectAt(AUTOPILOT_JSON_SCHEMAS.unitSpec, 'properties')['roster_id'], undefined);

    const receiptSchemaVersion = objectAt(objectAt(AUTOPILOT_JSON_SCHEMAS.receipt, 'properties'), 'schema_version');
    assert.deepEqual(receiptSchemaVersion, { const: 'autopilot.receipt.v1' });
    assert.equal(AUTOPILOT_JSON_SCHEMAS.receipt['additionalProperties'], false);
    assert.deepEqual(arrayAt(AUTOPILOT_JSON_SCHEMAS.receipt, 'required'), [
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
    ]);
    assert.equal(objectAt(AUTOPILOT_JSON_SCHEMAS.receipt, 'properties')['request_profile'], undefined);
    assert.equal(objectAt(AUTOPILOT_JSON_SCHEMAS.receipt, 'properties')['observed_profile'], undefined);
    assert.equal(objectAt(AUTOPILOT_JSON_SCHEMAS.receipt, 'properties')['roster_id'], undefined);

    const unitV1 = legacyUnitSpecV1();
    assert.equal(parseAutopilotUnitSpec(unitV1).schema_version, 'autopilot.unit_spec.v1');
    assert.throws(() => parseAutopilotUnitSpec({ ...unitV1, request_profile: {} }), /unexpected property "request_profile"/u);
    assert.throws(() => parseAutopilotUnitSpec({ ...unitV1, roster_id: 'roster-1' }), /unexpected property "roster_id"/u);

    const receiptV1 = legacyReceiptV1();
    assert.equal(parseAutopilotReceipt(receiptV1).schema_version, 'autopilot.receipt.v1');
    assert.throws(() => parseAutopilotReceipt({ ...receiptV1, request_profile: {} }), /unexpected property "request_profile"/u);
    assert.throws(() => parseAutopilotReceipt({ ...receiptV1, observed_profile: {} }), /unexpected property "observed_profile"/u);

    assert.ok(AUTOPILOT_ROSTER_SCHEMA_VERSION_VALUES.includes('autopilot.unit_spec.v2'));
    assert.ok(AUTOPILOT_ROSTER_SCHEMA_VERSION_VALUES.includes('autopilot.receipt.v2'));
    assert.equal(objectAt(AUTOPILOT_JSON_SCHEMAS.unitSpecV2, 'properties')['request_profile'] !== undefined, true);
    assert.equal(objectAt(AUTOPILOT_JSON_SCHEMAS.receiptV2, 'properties')['observed_profile'] !== undefined, true);
  });

  void it('accepts sealed positive objects across route, recipe, roster, setup, config, selection, and candidate contracts', () => {
    for (const routePolicy of arrayAt(REGISTRY, 'route_policies')) {
      assert.equal(parseAutopilotRosterContract('autopilot.route_policy.v1', routePolicy)['schema_version'], 'autopilot.route_policy.v1');
    }
    for (const providerRecipe of arrayAt(REGISTRY, 'provider_recipes')) {
      assert.equal(
        parseAutopilotRosterContract('autopilot.provider_recipe.v1', providerRecipe)['schema_version'],
        'autopilot.provider_recipe.v1',
      );
    }
    assert.equal(parseAutopilotRosterCandidateSet(objectAt(REGISTRY, 'synthetic_candidate_set'))['candidate_set_id'], 'candidate-set-83d587fc3f2d7cf2');
    assert.equal(parseAutopilotRosterConfig(objectAt(REGISTRY, 'synthetic_config')).config_sha256, 'sha256:1d8a144806f7bd3df23724eb702223c7180b4d160cb09fc8cff5cbc77a1e3a38');
    assert.equal(parseAutopilotRosterContract('autopilot.roster_setup_receipt.v1', objectAt(REGISTRY, 'synthetic_receipt')).fresh_session_required, true);
    assert.equal(parseAutopilotRosterContract('autopilot.pre_run_selection.v1', objectAt(REGISTRY, 'synthetic_pre_run_selection'))['scope'], 'user');
    assert.equal(parseAutopilotRoster(generatedRoster(0))['schema_version'], 'autopilot.roster.v1');
  });

  void it('fails closed on unknown, missing, nullability, order, duplicate, and hash drift defects', () => {
    const candidateSet = objectAt(REGISTRY, 'synthetic_candidate_set');
    assertRosterThrows('autopilot.roster_candidate_set.v1', { ...candidateSet, unexpected: true }, /unexpected property/u);

    const missingScope = cloneRecord(candidateSet);
    delete missingScope['scope'];
    assertRosterThrows('autopilot.roster_candidate_set.v1', missingScope, /missing required property "scope"/u);

    assertRosterThrows('autopilot.roster_candidate_set.v1', { ...candidateSet, scope: null }, /scope must not be null/u);

    const reordered = cloneRecord(candidateSet);
    reordered['candidates'] = [...arrayAt(reordered, 'candidates')].reverse();
    reordered['candidate_set_id'] = 'candidate-set-0000000000000000';
    reordered['candidate_set_sha256'] = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    assertRosterThrows('autopilot.roster_candidate_set.v1', reordered, /ordered by candidate_sort_key/u);

    const duplicated = cloneRecord(candidateSet);
    const [firstCandidate] = arrayAt(duplicated, 'candidates');
    duplicated['candidates'] = [firstCandidate, firstCandidate];
    duplicated['candidate_set_id'] = 'candidate-set-0000000000000000';
    duplicated['candidate_set_sha256'] = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    assertRosterThrows('autopilot.roster_candidate_set.v1', duplicated, /duplicates candidate_id/u);

    assertRosterThrows(
      'autopilot.roster.v1',
      { ...generatedRoster(0), roster_sha256: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
      /roster_sha256 hash mismatch/u,
    );

    const secretDiagnostic = {
      code: 'ROSTER_AUTH_REQUIRED',
      severity: 'error',
      message: 'secret leaked',
      remediation: 'remove it',
      secret_free: false,
    };
    assertRosterThrows('autopilot.roster_diagnostic.v1', secretDiagnostic, /secret_free must be true/u);
  });

  void it('adds v2 unit spec and receipt contracts without reinterpreting v1 bytes', () => {
    const { requestProfile, observedProfile, assignment, roster } = buildProfilePair();
    const unitV2 = buildUnitSpecV2(roster, assignment, requestProfile);
    assert.equal(parseAutopilotUnitSpecV2(unitV2)['schema_version'], 'autopilot.unit_spec.v2');
    assert.throws(() => parseAutopilotUnitSpec(unitV2), /schema_version/u);

    const receiptV2 = buildReceiptV2(unitV2, assignment, requestProfile, observedProfile);
    assert.equal(parseAutopilotReceiptV2(receiptV2)['schema_version'], 'autopilot.receipt.v2');

    assertRosterThrows('autopilot.unit_spec.v2', { ...unitV2, model: 'openai-codex/gpt-5.6-sol' }, /model must equal request_profile\.model/u);
    assertRosterThrows(
      'autopilot.receipt.v2',
      {
        ...receiptV2,
        observed_profile: { ...observedProfile, executed_model_id: 'gpt-5.6-sol' },
      },
      /executed_model_id must equal request_profile\.model_id/u,
    );
  });

  void it('rejects duplicate JSON object members before parsing', () => {
    const candidateSet = objectAt(REGISTRY, 'synthetic_candidate_set');
    const text = JSON.stringify(candidateSet).replace(
      '"schema_version":"autopilot.roster_candidate_set.v1"',
      '"schema_version":"autopilot.roster_candidate_set.v1","schema_version":"autopilot.roster_candidate_set.v1"',
    );
    assert.throws(
      () => parseAutopilotRosterContractJson('autopilot.roster_candidate_set.v1', text),
      /duplicate object member/u,
    );
  });
});

function legacyUnitSpecV1(): AutopilotUnitSpec {
  return {
    schema_version: 'autopilot.unit_spec.v1',
    workstream: 'phase37-w1',
    unit_id: 'legacy-v1-validate',
    role: 'validate',
    template: 'validate',
    attempt: 1,
    objective: 'Validate that v1 unit specs remain frozen.',
    cwd: '/tmp/phase37-w1-worktree',
    model: 'openai-codex/gpt-5.6-sol',
    thinking: 'xhigh',
    owned_paths: [],
    read_only_paths: ['src/core/contracts/types.ts'],
    untouchable_paths: [],
    context_refs: [],
    validation_commands: ['npm run typecheck'],
    status_output: '/tmp/phase37-w1-worktree/.pi/autopilot/phase37-w1/statuses/legacy-v1-validate.json',
    receipt_output: '/tmp/phase37-w1-worktree/.pi/autopilot/phase37-w1/receipts/legacy-v1-validate.json',
    evidence_dir: '/tmp/phase37-w1-worktree/.pi/autopilot/phase37-w1/evidence/legacy-v1-validate',
    stop_boundary: 'Stop after focused validation.',
  };
}

function legacyReceiptV1(): AutopilotReceipt {
  return {
    schema_version: 'autopilot.receipt.v1',
    tool_name: 'autopilot_emit_status',
    workstream: 'phase37-w1',
    unit_id: 'legacy-v1-validate',
    role: 'validate',
    attempt: 1,
    emitted_at: '2026-07-22T12:00:00.000Z',
    status_output: '/tmp/phase37-w1-worktree/.pi/autopilot/phase37-w1/statuses/legacy-v1-validate.json',
    status_sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    schema_sha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    tool_call_id: 'call-legacy-v1-validate',
    provider_identity: {
      provider_id: 'openai-codex',
      requested_model_id: 'gpt-5.6-sol',
      executed_model_id: 'gpt-5.6-sol',
      api: 'openai-codex-responses',
      thinking_level: 'xhigh',
    },
    expected_identity_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  };
}

function buildProfilePair(): {
  readonly requestProfile: Record<string, unknown>;
  readonly observedProfile: Record<string, unknown>;
  readonly assignment: Readonly<Record<string, unknown>>;
  readonly roster: Readonly<Record<string, unknown>>;
} {
  const roster = generatedRoster(1);
  const assignment = arrayAt(roster, 'assignments')
    .map((entry) => objectAtValue(entry))
    .find((entry) => entry['role'] === 'implement');
  if (assignment === undefined) throw new Error('missing implement assignment');
  const requestProfile: Record<string, unknown> = {
    provider_id: assignment['provider_id'],
    model_id: assignment['model_id'],
    model: assignment['model'],
    api: assignment['api'],
    thinking: assignment['thinking'],
    service_tier: assignment['service_tier'],
    cache_policy: assignment['cache_policy'],
    system_prompt_profile: assignment['system_prompt_profile'],
    context_window: assignment['context_window'],
    max_output_tokens: assignment['max_output_tokens'],
    input_modalities: assignment['input_modalities'],
    output_modalities: assignment['output_modalities'],
    reasoning_capability: assignment['reasoning_capability'],
    tool_capability: assignment['tool_capability'],
    route_policy_id: assignment['route_policy_id'],
    route_policy_revision: assignment['route_policy_revision'],
    request_profile_sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  requestProfile['request_profile_sha256'] = requiredHash('autopilot.request_profile.v1', requestProfile);
  const observedProfile: Record<string, unknown> = {
    provider_id: assignment['provider_id'],
    requested_model_id: assignment['model_id'],
    executed_model_id: assignment['model_id'],
    api: assignment['api'],
    thinking: assignment['thinking'],
    service_tier: assignment['service_tier'],
    cache_policy: assignment['cache_policy'],
    system_prompt_profile: assignment['system_prompt_profile'],
    system_prompt_sha256: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    route_policy_id: assignment['route_policy_id'],
    route_policy_revision: assignment['route_policy_revision'],
    request_profile_sha256: requestProfile['request_profile_sha256'],
    observed_profile_sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  observedProfile['observed_profile_sha256'] = requiredHash('autopilot.observed_profile.v1', observedProfile);
  return { requestProfile, observedProfile, assignment, roster };
}

function buildUnitSpecV2(
  roster: Readonly<Record<string, unknown>>,
  assignment: Readonly<Record<string, unknown>>,
  requestProfile: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    schema_version: 'autopilot.unit_spec.v2',
    workstream: 'phase37',
    unit_id: 'unit-001',
    role: 'implement',
    template: 'implement',
    attempt: 1,
    objective: 'Implement roster contracts',
    cwd: '/tmp/work',
    model: assignment['model'],
    thinking: assignment['thinking'],
    owned_paths: ['src/core/roster/contracts.ts'],
    read_only_paths: [],
    untouchable_paths: [],
    context_refs: [{ path: 'docs/read-before-edit.md', purpose: 'read gate', sha256: null, byte_count: null }],
    validation_commands: ['npm run typecheck'],
    status_output: '/tmp/work/.pi/autopilot/phase37/statuses/unit.json',
    receipt_output: '/tmp/work/.pi/autopilot/phase37/receipts/unit.json',
    evidence_dir: '/tmp/work/.pi/autopilot/phase37/evidence/unit',
    stop_boundary: 'stop after focused tests',
    quality_profile: 'source-change',
    risk_level: 'medium',
    acceptance_criteria: ['contracts parse'],
    verification_plan: null,
    closure_criteria: ['focused tests pass'],
    upstream_refs: [],
    timeout_seconds: 600,
    render_prompt_snapshot: false,
    roster_id: roster['roster_id'],
    roster_revision: roster['roster_revision'],
    roster_sha256: roster['roster_sha256'],
    assignment_sha256: assignment['assignment_sha256'],
    pre_run_selection_sha256: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    request_profile: requestProfile,
  };
}

function buildReceiptV2(
  unitV2: Readonly<Record<string, unknown>>,
  assignment: Readonly<Record<string, unknown>>,
  requestProfile: Readonly<Record<string, unknown>>,
  observedProfile: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    schema_version: 'autopilot.receipt.v2',
    tool_name: 'autopilot_emit_status',
    workstream: unitV2['workstream'],
    unit_id: unitV2['unit_id'],
    role: unitV2['role'],
    attempt: unitV2['attempt'],
    emitted_at: '2026-07-22T12:00:00.000Z',
    status_output: unitV2['status_output'],
    status_sha256: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    schema_sha256: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
    tool_call_id: 'tool-call-1',
    provider_identity: {
      provider_id: assignment['provider_id'],
      requested_model_id: assignment['model_id'],
      executed_model_id: assignment['model_id'],
      api: assignment['api'],
      thinking_level: assignment['thinking'],
    },
    expected_identity_hash: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
    roster_id: unitV2['roster_id'],
    roster_revision: unitV2['roster_revision'],
    roster_sha256: unitV2['roster_sha256'],
    assignment_sha256: assignment['assignment_sha256'],
    pre_run_selection_sha256: unitV2['pre_run_selection_sha256'],
    request_profile: requestProfile,
    observed_profile: observedProfile,
  };
}

function assertRosterThrows(
  schemaVersion: AutopilotRosterContractSchemaVersion,
  value: unknown,
  pattern: RegExp,
): void {
  assert.throws(
    () => parseAutopilotRosterContract(schemaVersion, value),
    (error: unknown) => error instanceof AutopilotRosterContractValidationError && pattern.test(error.message),
  );
}

function generatedRoster(index: number): Readonly<Record<string, unknown>> {
  return objectAt(arrayAt(MANIFEST, 'generated_rosters'), String(index));
}

function requiredHash(schemaVersion: AutopilotRosterContractSchemaVersion, value: unknown): string {
  const hash = computeAutopilotRosterContractObjectHash(schemaVersion, value);
  if (hash === null) throw new Error(`${schemaVersion} has no hash field`);
  return hash;
}

function cloneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function readJsonObject(path: string): Readonly<Record<string, unknown>> {
  return objectAtValue(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function objectAt(record: Readonly<Record<string, unknown>> | readonly unknown[], key: string): Readonly<Record<string, unknown>> {
  if (isReadonlyUnknownArray(record)) return objectAtValue(record[Number(key)]);
  return objectAtValue(record[key]);
}

function isReadonlyUnknownArray(value: Readonly<Record<string, unknown>> | readonly unknown[]): value is readonly unknown[] {
  return Array.isArray(value);
}

function objectAtValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
  throw new Error('expected object fixture value');
}

function arrayAt(record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
  const value = record[key];
  if (Array.isArray(value)) return value;
  throw new Error(`expected array fixture value at ${key}`);
}
