import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  acceptHistoricalFixedRosterV1Request,
  artifactSchemaVersionFromBytes,
  assertHistoricalV1ArtifactAcceptedOnlyThroughAdapter,
  assertHistoricalV1BytesNotRelabeled,
  assertRetryResumeArtifactCompatibility,
  parseNewRunReceiptV2ArtifactBytes,
  parseNewRunUnitSpecV2ArtifactBytes,
  validateReceiptV2TerminalCompatibility,
} from '../../src/core/roster/artifact-compatibility.ts';
import {
  materializeNewRunUnitSpecV2,
  materializeObservedProfile,
  materializeReceiptV2,
  requestProfileFromAssignment,
  resolvePinnedRoleRuntimeFacts,
  type AutopilotReceiptV2MaterializationInput,
  type AutopilotRosterReceiptV2,
  type AutopilotRosterUnitSpecV2,
  type AutopilotUnitSpecV2MaterializationInput,
} from '../../src/core/roster/runtime-spec.ts';
import { computeAutopilotRosterContractObjectHash } from '../../src/core/roster/contracts.ts';
import { sha256Utf8 } from '../../src/core/roster/canonical.ts';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..', '..');
const FIXTURES = readJsonObject(resolve(REPO_ROOT, 'design/phase37/roster-acceptance-fixtures.v1.json'));
const MANIFEST = readJsonObject(resolve(REPO_ROOT, 'design/phase37/roster-contract-freeze.v1.json'));
const REGISTRY = objectAt(FIXTURES, 'object_registry');

void describe('D69 W3 roster artifact compatibility lane', () => {
  void it('materializes new-run unit_spec.v2 and receipt.v2 from pinned selection, role assignment, and exact request profile', () => {
    const { selection, roster, requestProfile } = pinnedInput();
    const unit = materializeNewRunUnitSpecV2(unitInput());
    assert.equal(unit.schema_version, 'autopilot.unit_spec.v2');
    assert.equal(unit.roster_id, selection['roster_id']);
    assert.equal(unit.roster_sha256, selection['roster_sha256']);
    assert.equal(unit.pre_run_selection_sha256, selection['selection_sha256']);
    assert.deepEqual(unit.request_profile, requestProfile);
    assert.equal(unit.model, requestProfile.model);
    assert.equal(unit.thinking, requestProfile.thinking);

    const receipt = materializeReceiptV2(receiptInput(unit));
    assert.equal(receipt.schema_version, 'autopilot.receipt.v2');
    assert.equal(receipt.roster_id, unit.roster_id);
    assert.equal(receipt.assignment_sha256, unit.assignment_sha256);
    assert.deepEqual(receipt.request_profile, requestProfile);
    assert.equal(receipt.observed_profile.request_profile_sha256, requestProfile.request_profile_sha256);
    assert.equal(receipt.provider_identity.api, requestProfile.api);
    assert.equal(receipt.provider_identity.thinking_level, requestProfile.thinking);

    assert.equal(parseNewRunUnitSpecV2ArtifactBytes(jsonBytes(unit)).schema_version, 'autopilot.unit_spec.v2');
    assert.equal(parseNewRunReceiptV2ArtifactBytes(jsonBytes(receipt)).schema_version, 'autopilot.receipt.v2');
    assert.equal(roster['roster_id'], selection['roster_id']);
  });

  void it('rejects new-run v1 creation, unknown schemas, and missing explicit-null v2 facts', () => {
    const historical = historicalRequest();
    assert.equal(artifactSchemaVersionFromBytes('unit-spec', stringAt(historical, 'historical_unit_spec_bytes_utf8')), 'autopilot.unit_spec.v1');
    assert.throws(
      () => parseNewRunUnitSpecV2ArtifactBytes(stringAt(historical, 'historical_unit_spec_bytes_utf8')),
      /unit_spec\.v1 creation is forbidden/u,
    );

    const unit = materializeNewRunUnitSpecV2(unitInput());
    assert.throws(
      () => artifactSchemaVersionFromBytes('unit-spec', jsonBytes({ ...unit, schema_version: 'autopilot.unit_spec.v3' })),
      /schema_version/u,
    );

    const missing = cloneRecord(unitInput()) as Record<string, unknown>;
    delete missing['quality_profile'];
    assert.throws(
      () => Reflect.apply(materializeNewRunUnitSpecV2, undefined, [missing]),
      /quality_profile/u,
    );
  });

  void it('rejects request-profile hash drift and assignment fact drift before v2 materialization', () => {
    const badHash = cloneRecord(unitInput()) as Record<string, unknown>;
    const profile = cloneRecord(objectAtValue(badHash['request_profile']));
    profile['request_profile_sha256'] = 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    badHash['request_profile'] = profile;
    assert.throws(
      () => Reflect.apply(materializeNewRunUnitSpecV2, undefined, [badHash]),
      /request_profile_sha256 hash mismatch/u,
    );

    const drift = cloneRecord(unitInput()) as Record<string, unknown>;
    const driftProfile = cloneRecord(objectAtValue(drift['request_profile']));
    driftProfile['cache_policy'] = 'none';
    driftProfile['request_profile_sha256'] = requiredHash('autopilot.request_profile.v1', driftProfile);
    drift['request_profile'] = driftProfile;
    assert.throws(
      () => Reflect.apply(materializeNewRunUnitSpecV2, undefined, [drift]),
      /request_profile\.cache_policy/u,
    );
  });

  void it('validates receipt.v2 requested/observed facts and terminal acceptance compatibility without defaults', () => {
    const unit = materializeNewRunUnitSpecV2(unitInput());
    const receipt = materializeReceiptV2(receiptInput(unit));
    const unitBytes = jsonBytes(unit);
    const receiptBytes = jsonBytes(receipt);
    const terminal = terminalAcceptance(unit, unitBytes, receipt, receiptBytes);

    const ok = validateReceiptV2TerminalCompatibility({
      unit_spec_bytes_utf8: unitBytes,
      receipt_bytes_utf8: receiptBytes,
      terminal_acceptance: terminal,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 'inspected');
    assert.deepEqual(ok.diagnostics, []);

    const driftedReceipt = cloneRecord(receipt) as Record<string, unknown>;
    const driftedObserved = cloneRecord(objectAtValue(driftedReceipt['observed_profile']));
    driftedObserved['executed_model_id'] = 'gpt-5.6-sol';
    driftedObserved['observed_profile_sha256'] = requiredHash('autopilot.observed_profile.v1', driftedObserved);
    driftedReceipt['observed_profile'] = driftedObserved;
    const driftResult = validateReceiptV2TerminalCompatibility({
      unit_spec_bytes_utf8: unitBytes,
      receipt_bytes_utf8: jsonBytes(driftedReceipt),
      terminal_acceptance: terminalAcceptance(unit, unitBytes, driftedReceipt, jsonBytes(driftedReceipt)),
    });
    assert.equal(driftResult.ok, false);
    assert.ok(driftResult.diagnostics.some((diagnostic) => diagnostic.code === 'ROSTER_OBSERVED_MODEL_MISMATCH'));

    const missingReceipt = cloneRecord(receipt);
    const missingObserved = mutableObjectAtValue(missingReceipt['observed_profile']);
    delete missingObserved['system_prompt_sha256'];
    const missingResult = validateReceiptV2TerminalCompatibility({
      unit_spec_bytes_utf8: unitBytes,
      receipt_bytes_utf8: jsonBytes(missingReceipt),
      terminal_acceptance: terminalAcceptance(unit, unitBytes, missingReceipt, jsonBytes(missingReceipt)),
    });
    assert.equal(missingResult.ok, false);
    assert.ok(missingResult.diagnostics.some((diagnostic) => diagnostic.code === 'ROSTER_ARTIFACT_MISSING_FACT'));

    const terminalDrift = cloneRecord(terminal) as Record<string, unknown>;
    terminalDrift['carrier_status_sha256'] = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const terminalResult = validateReceiptV2TerminalCompatibility({
      unit_spec_bytes_utf8: unitBytes,
      receipt_bytes_utf8: receiptBytes,
      terminal_acceptance: terminalDrift,
    });
    assert.equal(terminalResult.ok, false);
    assert.ok(terminalResult.diagnostics.some((diagnostic) => diagnostic.code === 'ROSTER_TERMINAL_ACCEPTANCE_INCOMPATIBLE'));
  });

  void it('preserves v2 schema and pinned selection across retry/resume while rejecting selection drift', () => {
    const original = materializeNewRunUnitSpecV2(unitInput({ attempt: 1 }));
    const retry = materializeNewRunUnitSpecV2(unitInput({ attempt: 2 }));
    assert.doesNotThrow(() => assertRetryResumeArtifactCompatibility({
      kind: 'unit-spec',
      original_bytes_utf8: jsonBytes(original),
      next_bytes_utf8: jsonBytes(retry),
    }));

    const drift = cloneRecord(retry) as Record<string, unknown>;
    drift['pre_run_selection_sha256'] = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    assert.throws(
      () => assertRetryResumeArtifactCompatibility({
        kind: 'unit-spec',
        original_bytes_utf8: jsonBytes(original),
        next_bytes_utf8: jsonBytes(drift),
      }),
      /pre_run_selection_sha256/u,
    );
  });

  void it('accepts historical v1 golden bytes only through the byte-proven adapter and forbids relabel/enrichment', () => {
    const request = historicalRequest();
    const unitBytes = stringAt(request, 'historical_unit_spec_bytes_utf8');
    const receiptBytes = stringAt(request, 'historical_receipt_bytes_utf8');
    assert.equal(sha256Utf8(unitBytes), request['historical_unit_spec_sha256']);
    assert.equal(sha256Utf8(receiptBytes), request['historical_receipt_sha256']);

    const adapterResult = acceptHistoricalFixedRosterV1Request(request);
    assert.equal(adapterResult.ok, true);
    assert.equal(adapterResult.historical_bytes_mutated, false);
    assert.deepEqual(assertHistoricalV1ArtifactAcceptedOnlyThroughAdapter({
      kind: 'unit-spec',
      bytes_utf8: unitBytes,
      adapter_result: adapterResult,
    }), {
      kind: 'unit-spec',
      schema_version: 'autopilot.unit_spec.v1',
      bytes_sha256: request['historical_unit_spec_sha256'],
      historical_bytes_mutated: false,
    });

    assert.throws(
      () => assertHistoricalV1ArtifactAcceptedOnlyThroughAdapter({
        kind: 'receipt',
        bytes_utf8: '{"schema_version":"autopilot.receipt.v1"}',
        adapter_result: adapterResult,
      }),
      /digest does not match adapter proof/u,
    );

    const relabeled = JSON.stringify({
      ...JSON.parse(unitBytes) as Record<string, unknown>,
      schema_version: 'autopilot.unit_spec.v2',
      roster_id: adapterResult.selected_roster_id,
    });
    assert.throws(
      () => assertHistoricalV1BytesNotRelabeled({
        kind: 'unit-spec',
        historical_bytes_utf8: unitBytes,
        candidate_bytes_utf8: relabeled,
      }),
      /byte-immutable/u,
    );

    assert.throws(
      () => assertRetryResumeArtifactCompatibility({
        kind: 'unit-spec',
        original_bytes_utf8: unitBytes,
        next_bytes_utf8: jsonBytes(materializeNewRunUnitSpecV2(unitInput())),
        historical_adapter_result: adapterResult,
      }),
      /historical v1 artifacts must preserve/u,
    );
  });
});

function unitInput(overrides: Partial<AutopilotUnitSpecV2MaterializationInput> = {}): AutopilotUnitSpecV2MaterializationInput {
  const { selection, roster, requestProfile } = pinnedInput();
  return {
    selection,
    roster,
    role: 'implement',
    request_profile: requestProfile,
    workstream: 'phase37w3',
    unit_id: 'w3compatunit',
    attempt: 1,
    objective: 'Prove W3 v2 artifact compatibility.',
    cwd: '/tmp/phase37-w3-worktree',
    owned_paths: ['src/core/roster/artifact-compatibility.ts'],
    read_only_paths: ['PHASE37_ROSTER_CONTRACT_FREEZE.md'],
    untouchable_paths: ['private/**'],
    context_refs: [{ path: 'PHASE37_ROSTER_CONTRACT_FREEZE.md', purpose: 'W0 prose', sha256: null, byte_count: null }],
    validation_commands: ['npm run typecheck'],
    status_output: '/tmp/phase37-w3/statuses/w3compatunit.implement.attempt-1.json',
    receipt_output: '/tmp/phase37-w3/receipts/w3compatunit.implement.attempt-1.receipt.json',
    evidence_dir: '/tmp/phase37-w3/evidence/w3compatunit',
    stop_boundary: 'Stop after focused W3 compatibility validation.',
    quality_profile: 'source-change',
    risk_level: 'medium',
    acceptance_criteria: ['v2 artifacts validate'],
    verification_plan: null,
    closure_criteria: ['focused tests pass'],
    upstream_refs: [],
    timeout_seconds: 600,
    render_prompt_snapshot: false,
    ...overrides,
  };
}

function receiptInput(unit: AutopilotRosterUnitSpecV2): AutopilotReceiptV2MaterializationInput {
  const { selection, roster, assignment, requestProfile } = pinnedInput();
  const observed = materializeObservedProfile({
    request_profile: requestProfile,
    provider_id: assignment.provider_id,
    requested_model_id: assignment.model_id,
    executed_model_id: assignment.model_id,
    api: assignment.api,
    thinking: assignment.thinking,
    service_tier: assignment.service_tier,
    cache_policy: assignment.cache_policy,
    system_prompt_profile: assignment.system_prompt_profile,
    system_prompt_sha256: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    route_policy_id: assignment.route_policy_id,
    route_policy_revision: assignment.route_policy_revision,
  });
  return {
    unit_spec: unit,
    selection,
    roster,
    request_profile: requestProfile,
    observed_profile: observed,
    emitted_at: '2026-07-23T12:00:00.000Z',
    status_sha256: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    schema_sha256: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    tool_call_id: 'call-w3-compat-1',
    provider_identity: {
      provider_id: assignment.provider_id,
      requested_model_id: assignment.model_id,
      executed_model_id: assignment.model_id,
      api: assignment.api,
      thinking_level: assignment.thinking,
    },
    expected_identity_hash: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
  };
}

function pinnedInput() {
  const selection = cloneRecord(objectAt(REGISTRY, 'synthetic_pre_run_selection'));
  const roster = cloneRecord(generatedRoster(1));
  const assignment = arrayAt(roster, 'assignments').map(objectAtValue).find((entry) => entry['role'] === 'implement');
  if (assignment === undefined) throw new Error('missing implement assignment');
  const requestProfile = requestProfileFromAssignment(assignment);
  const facts = resolvePinnedRoleRuntimeFacts({ selection, roster, role: 'implement', request_profile: requestProfile });
  return { selection, roster, assignment: facts.assignment, requestProfile };
}

function terminalAcceptance(
  unit: AutopilotRosterUnitSpecV2,
  unitBytes: string,
  receiptValue: Readonly<Record<string, unknown>> | AutopilotRosterReceiptV2,
  receiptBytes: string,
): Record<string, unknown> {
  return {
    schema_version: 'autopilot.child_terminal_acceptance.v1',
    repo_id: 'repo-phase37-w0-fixtures',
    autopilot_id: 'autopilot-phase37-w3',
    workstream: unit.workstream,
    workstream_run: 'phase37-w0-run-001',
    unit_id: unit.unit_id,
    role: unit.role,
    attempt: unit.attempt,
    child_lease_id: 'child-w3-compat-1',
    verdict: 'DONE',
    transport_result: 'accepted',
    spec: { ref: 'unit-specs/w3compatunit.implement.attempt-1.json', sha256: sha256Utf8(unitBytes) },
    status: { ref: 'statuses/w3compatunit.implement.attempt-1.json', sha256: stringAt(receiptValue, 'status_sha256') },
    receipt: { ref: 'receipts/w3compatunit.implement.attempt-1.receipt.json', sha256: sha256Utf8(receiptBytes) },
    audit: { ref: 'audits/w3compatunit.implement.attempt-1.audit.json', sha256: sha256Utf8('audit') },
    tool_call_id: stringAt(receiptValue, 'tool_call_id'),
    carrier_status_sha256: stringAt(receiptValue, 'status_sha256'),
    audit_disposition: 'accounted-changes',
    created_at: '2026-07-23T12:00:01.000Z',
  };
}

function historicalRequest(): Readonly<Record<string, unknown>> {
  return objectAt(REGISTRY, 'historical_adapter_request');
}

function generatedRoster(index: number): Readonly<Record<string, unknown>> {
  return objectAt(arrayAt(MANIFEST, 'generated_rosters'), String(index));
}

function requiredHash(schemaVersion: Parameters<typeof computeAutopilotRosterContractObjectHash>[0], value: unknown): string {
  const hash = computeAutopilotRosterContractObjectHash(schemaVersion, value);
  if (hash === null) throw new Error(`${schemaVersion} has no hash field`);
  return hash;
}

function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function readJsonObject(path: string): Readonly<Record<string, unknown>> {
  return objectAtValue(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function objectAt(record: unknown, key: string): Readonly<Record<string, unknown>> {
  if (Array.isArray(record)) return objectAtValue(record[Number(key)]);
  return objectAtValue(objectAtValue(record)[key]);
}

function objectAtValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
  throw new Error('expected object fixture value');
}

function mutableObjectAtValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error('expected mutable object value');
}

function arrayAt(record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
  const value = record[key];
  if (Array.isArray(value)) return value;
  throw new Error(`expected array fixture value at ${key}`);
}

function stringAt(record: unknown, key: string): string {
  const value = objectAtValue(record)[key];
  if (typeof value === 'string') return value;
  throw new Error(`expected string value at ${key}`);
}
