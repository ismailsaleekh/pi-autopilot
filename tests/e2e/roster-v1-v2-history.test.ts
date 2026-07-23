import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  acceptHistoricalFixedRosterV1Request,
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
import { sha256Utf8 } from '../../src/core/roster/canonical.ts';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..', '..');
const FIXTURES = readJsonObject(resolve(REPO_ROOT, 'design/phase37/roster-acceptance-fixtures.v1.json'));
const MANIFEST = readJsonObject(resolve(REPO_ROOT, 'design/phase37/roster-contract-freeze.v1.json'));
const REGISTRY = objectAt(FIXTURES, 'object_registry');

void describe('D69 W3 roster v1/v2 history compatibility e2e', () => {
  void it('keeps historical v1 bytes immutable while new runs emit only v2 artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roster-w3-history-'));
    try {
      const historical = historicalRequest();
      const historicalUnitBytes = stringAt(historical, 'historical_unit_spec_bytes_utf8');
      const historicalReceiptBytes = stringAt(historical, 'historical_receipt_bytes_utf8');
      const v1Dir = join(root, 'historical-v1');
      await mkdir(v1Dir, { recursive: true });
      const v1UnitPath = join(v1Dir, 'unit.json');
      const v1ReceiptPath = join(v1Dir, 'receipt.json');
      await writeFile(v1UnitPath, historicalUnitBytes, 'utf8');
      await writeFile(v1ReceiptPath, historicalReceiptBytes, 'utf8');

      const readHistoricalUnitBytes = await readFile(v1UnitPath, 'utf8');
      const readHistoricalReceiptBytes = await readFile(v1ReceiptPath, 'utf8');
      assert.equal(readHistoricalUnitBytes, historicalUnitBytes);
      assert.equal(readHistoricalReceiptBytes, historicalReceiptBytes);
      const adapterResult = acceptHistoricalFixedRosterV1Request(historical);
      assertHistoricalV1ArtifactAcceptedOnlyThroughAdapter({
        kind: 'unit-spec',
        bytes_utf8: readHistoricalUnitBytes,
        adapter_result: adapterResult,
      });
      assertHistoricalV1ArtifactAcceptedOnlyThroughAdapter({
        kind: 'receipt',
        bytes_utf8: readHistoricalReceiptBytes,
        adapter_result: adapterResult,
      });

      const unit = materializeNewRunUnitSpecV2(unitInput({ attempt: 1 }));
      const receipt = materializeReceiptV2(receiptInput(unit));
      const v2Dir = join(root, 'new-run-v2');
      await mkdir(v2Dir, { recursive: true });
      const v2UnitPath = join(v2Dir, 'unit.json');
      const v2ReceiptPath = join(v2Dir, 'receipt.json');
      const unitBytes = jsonBytes(unit);
      const receiptBytes = jsonBytes(receipt);
      await writeFile(v2UnitPath, unitBytes, 'utf8');
      await writeFile(v2ReceiptPath, receiptBytes, 'utf8');

      assert.equal(parseNewRunUnitSpecV2ArtifactBytes(await readFile(v2UnitPath, 'utf8')).schema_version, 'autopilot.unit_spec.v2');
      assert.equal(parseNewRunReceiptV2ArtifactBytes(await readFile(v2ReceiptPath, 'utf8')).schema_version, 'autopilot.receipt.v2');
      const validation = validateReceiptV2TerminalCompatibility({
        unit_spec_bytes_utf8: unitBytes,
        receipt_bytes_utf8: receiptBytes,
        terminal_acceptance: terminalAcceptance(unit, unitBytes, receipt, receiptBytes),
      });
      assert.equal(validation.ok, true);

      const retry = materializeNewRunUnitSpecV2(unitInput({ attempt: 2 }));
      assertRetryResumeArtifactCompatibility({
        kind: 'unit-spec',
        original_bytes_utf8: unitBytes,
        next_bytes_utf8: jsonBytes(retry),
      });

      const relabeledHistorical = JSON.stringify({
        ...JSON.parse(historicalUnitBytes) as Record<string, unknown>,
        schema_version: 'autopilot.unit_spec.v2',
        roster_id: unit.roster_id,
        roster_revision: unit.roster_revision,
        roster_sha256: unit.roster_sha256,
        assignment_sha256: unit.assignment_sha256,
        pre_run_selection_sha256: unit.pre_run_selection_sha256,
        request_profile: unit.request_profile,
      });
      assert.throws(
        () => assertHistoricalV1BytesNotRelabeled({
          kind: 'unit-spec',
          historical_bytes_utf8: historicalUnitBytes,
          candidate_bytes_utf8: relabeledHistorical,
        }),
        /byte-immutable/u,
      );
      assert.throws(
        () => assertRetryResumeArtifactCompatibility({
          kind: 'unit-spec',
          original_bytes_utf8: historicalUnitBytes,
          next_bytes_utf8: unitBytes,
          historical_adapter_result: adapterResult,
        }),
        /preserve the original schema and exact bytes/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('fails closed when v2 receipt bytes drift after terminal acceptance has pinned their hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roster-w3-drift-'));
    try {
      const unit = materializeNewRunUnitSpecV2(unitInput());
      const receipt = materializeReceiptV2(receiptInput(unit));
      const unitBytes = jsonBytes(unit);
      const receiptBytes = jsonBytes(receipt);
      const acceptance = terminalAcceptance(unit, unitBytes, receipt, receiptBytes);
      const tamperedReceipt = { ...receipt, status_sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
      const tamperedBytes = jsonBytes(tamperedReceipt);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'unit.json'), unitBytes, 'utf8');
      await writeFile(join(root, 'receipt.json'), tamperedBytes, 'utf8');

      const result = validateReceiptV2TerminalCompatibility({
        unit_spec_bytes_utf8: await readFile(join(root, 'unit.json'), 'utf8'),
        receipt_bytes_utf8: await readFile(join(root, 'receipt.json'), 'utf8'),
        terminal_acceptance: acceptance,
      });
      assert.equal(result.ok, false);
      assert.deepEqual(
        result.diagnostics.map((diagnostic) => diagnostic.code),
        ['ROSTER_READBACK_MISMATCH', 'ROSTER_TERMINAL_ACCEPTANCE_INCOMPATIBLE'],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    unit_id: 'w3historyunit',
    attempt: 1,
    objective: 'Prove W3 v1/v2 history compatibility.',
    cwd: '/tmp/phase37-w3-history-worktree',
    owned_paths: ['src/core/roster/runtime-spec.ts'],
    read_only_paths: ['PHASE37_ROSTER_CONTRACT_FREEZE.md'],
    untouchable_paths: ['private/**'],
    context_refs: [{ path: 'PHASE37_ROSTER_CONTRACT_FREEZE.md', purpose: 'W0 prose', sha256: null, byte_count: null }],
    validation_commands: ['npm run typecheck'],
    status_output: '/tmp/phase37-w3-history/statuses/w3historyunit.implement.attempt-1.json',
    receipt_output: '/tmp/phase37-w3-history/receipts/w3historyunit.implement.attempt-1.receipt.json',
    evidence_dir: '/tmp/phase37-w3-history/evidence/w3historyunit',
    stop_boundary: 'Stop after W3 history validation.',
    quality_profile: 'source-change',
    risk_level: 'medium',
    acceptance_criteria: ['history lane validates'],
    verification_plan: null,
    closure_criteria: ['e2e history test passes'],
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
    emitted_at: '2026-07-23T12:05:00.000Z',
    status_sha256: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    schema_sha256: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    tool_call_id: 'call-w3-history-1',
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
  receipt: AutopilotRosterReceiptV2 | Readonly<Record<string, unknown>>,
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
    child_lease_id: 'child-w3-history-1',
    verdict: 'DONE',
    transport_result: 'accepted',
    spec: { ref: 'unit-specs/w3historyunit.implement.attempt-1.json', sha256: sha256Utf8(unitBytes) },
    status: { ref: 'statuses/w3historyunit.implement.attempt-1.json', sha256: stringAt(receipt, 'status_sha256') },
    receipt: { ref: 'receipts/w3historyunit.implement.attempt-1.receipt.json', sha256: sha256Utf8(receiptBytes) },
    audit: { ref: 'audits/w3historyunit.implement.attempt-1.audit.json', sha256: sha256Utf8('audit') },
    tool_call_id: stringAt(receipt, 'tool_call_id'),
    carrier_status_sha256: stringAt(receipt, 'status_sha256'),
    audit_disposition: 'accounted-changes',
    created_at: '2026-07-23T12:05:01.000Z',
  };
}

function historicalRequest(): Readonly<Record<string, unknown>> {
  return objectAt(REGISTRY, 'historical_adapter_request');
}

function generatedRoster(index: number): Readonly<Record<string, unknown>> {
  return objectAt(arrayAt(MANIFEST, 'generated_rosters'), String(index));
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
