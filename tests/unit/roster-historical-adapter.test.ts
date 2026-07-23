import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  adaptHistoricalFixedRosterEvidence,
  AUTOPILOT_HISTORICAL_FIXED_ROSTER_SELECTION,
  computeAutopilotRosterContractObjectHash,
  parseAutopilotReceipt,
  parseAutopilotUnitSpec,
  sha256Utf8,
  type AutopilotRosterContractBySchemaVersion,
  type AutopilotRosterContractSchemaVersion,
} from '../../src/core/contracts/index.ts';

type HistoricalAdapterResult = AutopilotRosterContractBySchemaVersion['autopilot.historical_fixed_roster_adapter_result.v1'];
type HistoricalAdmissionReason = HistoricalAdapterResult['admission']['reason'];
type HistoricalBytesMutator = (unit: Record<string, unknown>, receipt: Record<string, unknown>) => void;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..', '..');
const FIXTURES = readJsonObject(resolve(REPO_ROOT, 'design/phase37/roster-acceptance-fixtures.v1.json'));
const REGISTRY = objectAt(FIXTURES, 'object_registry');

void describe('Phase 37 historical fixed-roster adapter', () => {
  void it('admits only the sealed pre-1.3.0 v1 Sol/Terra/Luna evidence and returns the frozen selection identity', () => {
    const request = objectAt(REGISTRY, 'historical_adapter_request');
    const expected = objectAt(REGISTRY, 'historical_adapter_result');
    const result = adaptHistoricalFixedRosterEvidence(request);
    assert.deepEqual(result, expected);
    assert.equal(result.selected_roster_id, AUTOPILOT_HISTORICAL_FIXED_ROSTER_SELECTION.selected_roster_id);
    assert.equal(result.write_count, 0);
    assert.equal(result.lock_count, 0);
    assert.deepEqual(result.files_touched, []);
    assert.equal(result.historical_bytes_mutated, false);
  });

  void it('matches every sealed historical fail-closed fixture exactly', () => {
    for (const fixtureCase of historicalCases()) {
      const expected = objectAt(objectAt(fixtureCase, 'expected'), 'result');
      const request = objectAt(objectAt(fixtureCase, 'inputs'), 'request');
      assert.deepEqual(adaptHistoricalFixedRosterEvidence(request), expected, String(fixtureCase['fixture_id']));
    }
  });

  void it('fails closed when literal byte digests are not proven', () => {
    const request = cloneRecord(objectAt(REGISTRY, 'historical_adapter_request'));
    request['historical_unit_spec_sha256'] = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    request['request_sha256'] = requiredHash('autopilot.historical_fixed_roster_adapter_request.v1', request);
    const result = adaptHistoricalFixedRosterEvidence(request);
    assert.equal(result.ok, false);
    assert.equal(result.admission.reason, 'proof-required');
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ['ROSTER_HISTORICAL_PROOF_REQUIRED'],
    );
    assert.equal(result.historical_bytes_mutated, false);
  });

  void it('does not mutate or reinterpret historical v1 unit and receipt bytes', () => {
    const request = objectAt(REGISTRY, 'historical_adapter_request');
    const unitBytes = stringAt(request, 'historical_unit_spec_bytes_utf8');
    const receiptBytes = stringAt(request, 'historical_receipt_bytes_utf8');
    assert.equal(sha256Utf8(unitBytes), request['historical_unit_spec_sha256']);
    assert.equal(sha256Utf8(receiptBytes), request['historical_receipt_sha256']);
    assert.throws(() => parseAutopilotUnitSpec(JSON.parse(unitBytes) as unknown), /failed Autopilot contract validation/u);
    assert.throws(() => parseAutopilotReceipt(JSON.parse(receiptBytes) as unknown), /failed Autopilot contract validation/u);
    const result = adaptHistoricalFixedRosterEvidence(request);
    assert.equal(stringAt(request, 'historical_unit_spec_bytes_utf8'), unitBytes);
    assert.equal(stringAt(request, 'historical_receipt_bytes_utf8'), receiptBytes);
    assert.equal(result.historical_bytes_mutated, false);
  });

  void it('fails closed deterministically without parser escapes for malformed digest-proven role bytes', () => {
    const malformedCases: readonly {
      readonly fixture_id: string;
      readonly mutate: HistoricalBytesMutator;
    }[] = [
      {
        fixture_id: 'malformed-unit-role-enum',
        mutate: (unit) => {
          mutableRoleAt(unit, 'fixed_roster', 0)['role'] = 'operator';
        },
      },
      {
        fixture_id: 'malformed-receipt-model-relation',
        mutate: (_unit, receipt) => {
          mutableRoleAt(receipt, 'observed_fixed_roster', 0)['model'] = 'openai-codex/gpt-5.6-terra';
        },
      },
      {
        fixture_id: 'malformed-receipt-thinking-enum',
        mutate: (_unit, receipt) => {
          mutableRoleAt(receipt, 'observed_fixed_roster', 0)['thinking'] = 'medium';
        },
      },
      {
        fixture_id: 'malformed-receipt-duplicate-role',
        mutate: (_unit, receipt) => {
          mutableRoleAt(receipt, 'observed_fixed_roster', 1)['role'] = 'parent';
        },
      },
      {
        fixture_id: 'malformed-receipt-missing-field',
        mutate: (_unit, receipt) => {
          delete mutableRoleAt(receipt, 'observed_fixed_roster', 0)['model_id'];
        },
      },
      {
        fixture_id: 'malformed-receipt-fixed-roster-shape',
        mutate: (_unit, receipt) => {
          receipt['observed_fixed_roster'] = { not: 'an-array' };
        },
      },
    ];

    for (const fixtureCase of malformedCases) {
      const request = historicalRequestWithMutatedBytes(fixtureCase.mutate);
      const unitBytes = stringAt(request, 'historical_unit_spec_bytes_utf8');
      const receiptBytes = stringAt(request, 'historical_receipt_bytes_utf8');
      assert.equal(sha256Utf8(unitBytes), request['historical_unit_spec_sha256'], fixtureCase.fixture_id);
      assert.equal(sha256Utf8(receiptBytes), request['historical_receipt_sha256'], fixtureCase.fixture_id);

      const result = adaptHistoricalFixedRosterEvidence(request);
      const repeated = adaptHistoricalFixedRosterEvidence(request);
      assert.deepEqual(repeated, result, fixtureCase.fixture_id);
      assertBoundedHistoricalRejection(result, request, 'fixed-roster-mismatch', fixtureCase.fixture_id);
      assert.equal(stringAt(request, 'historical_unit_spec_bytes_utf8'), unitBytes, fixtureCase.fixture_id);
      assert.equal(stringAt(request, 'historical_receipt_bytes_utf8'), receiptBytes, fixtureCase.fixture_id);
    }
  });
});

function historicalCases(): readonly Readonly<Record<string, unknown>>[] {
  return arrayAt(FIXTURES, 'fixture_cases')
    .map((entry) => objectAtValue(entry))
    .filter((entry) => typeof entry['fixture_id'] === 'string' && entry['fixture_id'].startsWith('historical.v1.'));
}

function requiredHash(schemaVersion: AutopilotRosterContractSchemaVersion, value: unknown): string {
  const hash = computeAutopilotRosterContractObjectHash(schemaVersion, value);
  if (hash === null) throw new Error(`${schemaVersion} has no hash field`);
  return hash;
}

function stringAt(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value === 'string') return value;
  throw new Error(`expected string fixture value at ${key}`);
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

function historicalRequestWithMutatedBytes(mutator: HistoricalBytesMutator): Record<string, unknown> {
  const request = cloneRecord(objectAt(REGISTRY, 'historical_adapter_request'));
  const unit = mutableJsonObject(stringAt(request, 'historical_unit_spec_bytes_utf8'));
  const receipt = mutableJsonObject(stringAt(request, 'historical_receipt_bytes_utf8'));
  mutator(unit, receipt);
  const unitBytes = JSON.stringify(unit);
  receipt['unit_spec_sha256'] = sha256Utf8(unitBytes);
  const receiptBytes = JSON.stringify(receipt);
  request['historical_unit_spec_bytes_utf8'] = unitBytes;
  request['historical_unit_spec_sha256'] = sha256Utf8(unitBytes);
  request['historical_receipt_bytes_utf8'] = receiptBytes;
  request['historical_receipt_sha256'] = sha256Utf8(receiptBytes);
  request['request_sha256'] = requiredHash('autopilot.historical_fixed_roster_adapter_request.v1', request);
  return request;
}

function mutableJsonObject(text: string): Record<string, unknown> {
  return mutableObjectAtValue(JSON.parse(text) as unknown);
}

function mutableRoleAt(record: Record<string, unknown>, key: string, index: number): Record<string, unknown> {
  return mutableObjectAtValue(mutableArrayAt(record, key)[index]);
}

function mutableArrayAt(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (Array.isArray(value)) return value;
  throw new Error(`expected mutable array value at ${key}`);
}

function mutableObjectAtValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error('expected mutable object value');
}

function assertBoundedHistoricalRejection(
  result: HistoricalAdapterResult,
  request: Readonly<Record<string, unknown>>,
  reason: HistoricalAdmissionReason,
  label: string,
): void {
  assert.equal(result.ok, false, label);
  assert.equal(result.status, 'blocked', label);
  assert.equal(result.admission.admitted, false, label);
  assert.equal(result.admission.reason, reason, label);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    diagnosticCodesForReason(reason),
    label,
  );
  assert.equal(result.selected_scope, null, label);
  assert.equal(result.selected_roster_id, null, label);
  assert.equal(result.selected_roster_revision, null, label);
  assert.equal(result.selected_roster_sha256, null, label);
  assert.equal(result.assignment_set_sha256, null, label);
  assert.equal(result.selection_identity_sha256, null, label);
  assert.equal(result.historical_unit_spec_sha256, request['historical_unit_spec_sha256'], label);
  assert.equal(result.historical_receipt_sha256, request['historical_receipt_sha256'], label);
  assert.equal(result.historical_bytes_mutated, false, label);
  assert.equal(result.write_count, 0, label);
  assert.equal(result.lock_count, 0, label);
  assert.deepEqual(result.files_touched, [], label);
}

function diagnosticCodesForReason(reason: HistoricalAdmissionReason): readonly string[] {
  if (reason === 'proof-required') return ['ROSTER_HISTORICAL_PROOF_REQUIRED'];
  if (reason === 'historical-version-unsupported') {
    return ['ROSTER_HISTORICAL_PROOF_REQUIRED', 'ROSTER_HISTORICAL_VERSION_UNSUPPORTED'];
  }
  if (reason === 'pre-run-selection-present') return ['ROSTER_HISTORICAL_SELECTION_PRESENT'];
  if (reason === 'fixed-roster-mismatch') return ['ROSTER_HISTORICAL_FIXED_ROSTER_MISMATCH'];
  if (reason === 'conflicting-evidence') return ['ROSTER_HISTORICAL_CONFLICTING_EVIDENCE'];
  return ['ROSTER_HISTORICAL_V1_BYTES_PRESERVED'];
}
