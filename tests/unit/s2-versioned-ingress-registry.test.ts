import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { AUTOPILOT_SCHEMA_NAMES } from '../../src/core/names.ts';
import { AUTOPILOT_COORDINATION_JSON_SCHEMAS } from '../../src/core/coordination/schemas.ts';
import { COORDINATOR_IMPLEMENTATION_BUILD } from '../../src/core/coordination/runtime-constants.ts';
import {
  BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS,
  VERSIONED_PERSISTED_ARTIFACT_FAMILY_IDS,
  VERSIONED_PERSISTED_ARTIFACT_FAMILY_REGISTRY,
  assertPersistedArtifactFamilyRegistryWellFormed,
  parseVersionedPersistedArtifact,
  parseVersionedUnitFailureIngress,
  persistedArtifactFamily,
  roundTripPersistedArtifactIngress,
  selectVersionedIngressProducer,
  type PersistedArtifactFamilyDefinition,
  type VersionedIngressProducerRange,
} from '../../src/core/coordination/versioned-ingress-registry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const bug177CaptureCommitFixture = join(here, '..', 'fixtures', 'bug-177', 'historical-reset-unit-failure.bug177.json');
const bug177Phase2InitialFixture = join(here, '..', 'fixtures', 'bug-177', 'historical-reset-unit-failure-phase2-initial.bug177.json');
const currentUnitFailureFixture = join(here, '..', 'fixtures', 's2-ingress', 'current-unit-failure-reset.json');

const identity = (unitId: string) => ({
  workstream: 'workstream-bug177',
  workstreamRun: 'workstream-run-bug177',
  unitId,
  attempt: 1,
});

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function fixture(path: string): Promise<Uint8Array> {
  const bytes = await readFile(path);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function parseObject(bytes: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('fixture is not a JSON object');
  return { ...parsed };
}

function bytesFromObject(value: Readonly<Record<string, unknown>>): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function isReadonlyRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaVersionFromCoordinationSchema(name: string): string {
  const schema = AUTOPILOT_COORDINATION_JSON_SCHEMAS[name as keyof typeof AUTOPILOT_COORDINATION_JSON_SCHEMAS];
  assert.notEqual(schema, undefined, `missing coordination schema ${name}`);
  const properties = schema['properties'];
  if (isReadonlyRecord(properties)) {
    const schemaVersion = properties['schema_version'];
    if (isReadonlyRecord(schemaVersion)) {
      const value = schemaVersion['const'];
      if (typeof value === 'string') return value;
    }
  }
  if (name === 'coordinator_mailbox_page') return 'autopilot.coordinator_mailbox_page.v1';
  throw new Error(`coordination schema ${name} lacks schema_version const`);
}

void describe('S2-A versioned ingress persisted-artifact registry', () => {
  void it('inventory is package-owned and includes every known persisted artifact family surface', () => {
    assertPersistedArtifactFamilyRegistryWellFormed();
    assert.equal(new Set(VERSIONED_PERSISTED_ARTIFACT_FAMILY_IDS).size, VERSIONED_PERSISTED_ARTIFACT_FAMILY_IDS.length);
    for (const schemaName of AUTOPILOT_SCHEMA_NAMES) assert.ok(VERSIONED_PERSISTED_ARTIFACT_FAMILY_IDS.includes(schemaName), `missing package contract ${schemaName}`);
    for (const name of Object.keys(AUTOPILOT_COORDINATION_JSON_SCHEMAS)) {
      const schemaVersion = schemaVersionFromCoordinationSchema(name);
      assert.ok(VERSIONED_PERSISTED_ARTIFACT_FAMILY_IDS.includes(schemaVersion), `missing coordination schema ${schemaVersion}`);
    }
    const requiredFamilies: readonly string[] = [
      'autopilot.active_parent.v2', 'autopilot.authority.v1', 'autopilot.checkout_profile.v1', 'autopilot.claim_event.v1',
      'autopilot.close_result.v1', 'autopilot.coordinator_cursor.v1', 'autopilot.coordinator_lock.v1', 'autopilot.coordinator_lock.v2',
      'autopilot.coordinator_session_context.v1', 'autopilot.coordinator_store_generation.v1', 'autopilot.coordinator_store_pointer.v1',
      'autopilot.coordinator_upgrade_intent.v1', 'autopilot.graph_publication.v1', 'autopilot.identity_fault_resolution_evidence.v1',
      'autopilot.launch_policy.v1', 'autopilot.materialized_paths.v1', 'autopilot.reconciliation_intent.v1',
      'autopilot.reconciliation_intent_supersession.v1', 'autopilot.reservation_integration.v1', 'autopilot.run_scoped_fault.v1',
      'autopilot.run_terminal.v1', 'autopilot.run_terminal_intent.v2', 'autopilot.semantic_graph.v1', 'autopilot.semantic_graph_bootstrap.v1',
      'autopilot.subscription_probe.v1', 'autopilot.task_info.v2', 'autopilot.unit_failure.v1', 'autopilot.unit_info.v1',
      'autopilot.unit_merge.v1', 'autopilot.validation_evidence.v1', 'autopilot.validation_staleness.v2', 'autopilot.worktree_operation_evidence.v1',
    ];
    for (const family of requiredFamilies) assert.ok(VERSIONED_PERSISTED_ARTIFACT_FAMILY_IDS.includes(family), `missing persisted family ${family}`);
  });

  void it('unit_failure ranges are exact, contiguous, non-overlapping, generation-fenced, and current-strict', () => {
    const family = persistedArtifactFamily('autopilot.unit_failure.v1');
    assert.deepEqual(family.producer_ranges.map((range) => [range.first_generation, range.last_generation, range.producer_build, range.current]), [
      [1, 1, BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS.phase2Initial, false],
      [2, 2, BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS.captureCommitOnly, false],
      [3, 3, COORDINATOR_IMPLEMENTATION_BUILD, true],
    ]);
    assert.throws(() => selectVersionedIngressProducer({ family: 'autopilot.unit_failure.v1', producer_build: '1.2.0' }), /unsupported persisted artifact producer_build/u);
    assert.throws(() => selectVersionedIngressProducer({ family: 'autopilot.unit_failure.v1', producer_build: BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS.phase2Initial, producer_generation: 2 }), /outside its exact producer_build fence/u);
  });

  void it('BUG-177 consumer admits only explicit historical reset producer generations and applies absent-field defaults without rewriting bytes', async () => {
    const initial = await fixture(bug177Phase2InitialFixture);
    const captureOnly = await fixture(bug177CaptureCommitFixture);
    const parsedInitial = parseVersionedUnitFailureIngress({ bytes: initial, producer_build: BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS.phase2Initial, identity: identity('unit-bug177-initial') });
    assert.equal(parsedInitial.ingress.producer_generation, 1);
    assert.equal(parsedInitial.facts.captureCommitSha, null);
    assert.equal(parsedInitial.facts.captureRef, null);
    assert.deepEqual(parsedInitial.facts.appliedDefaults.map((entry) => entry.field), ['capture_commit_sha', 'capture_ref']);
    assert.equal(sha256(roundTripPersistedArtifactIngress(parsedInitial.ingress)), sha256(initial));
    assert.equal(parsedInitial.facts.originalSha256, sha256(initial));

    const parsedCapture = parseVersionedUnitFailureIngress({ bytes: captureOnly, producer_build: BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS.captureCommitOnly, identity: identity('unit-bug177') });
    assert.equal(parsedCapture.ingress.producer_generation, 2);
    assert.deepEqual(parsedCapture.facts.appliedDefaults.map((entry) => entry.field), ['capture_ref']);
    assert.equal(sha256(roundTripPersistedArtifactIngress(parsedCapture.ingress)), sha256(captureOnly));
  });

  void it('BUG-177 consumer rejects historical shapes without explicit build provenance, quarantine/preserve actions, and unknown fields loudly', async () => {
    const captureOnly = await fixture(bug177CaptureCommitFixture);
    assert.throws(() => parseVersionedUnitFailureIngress({ bytes: captureOnly, producer_build: COORDINATOR_IMPLEMENTATION_BUILD, identity: identity('unit-bug177') }), /unknown fields|missing a required field/u);
    const quarantine = parseObject(captureOnly);
    quarantine.action = 'quarantine';
    assert.throws(() => parseVersionedUnitFailureIngress({ bytes: bytesFromObject(quarantine), producer_build: BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS.captureCommitOnly, identity: identity('unit-bug177') }), /historical quarantine\/preserve/u);
    const unknown = parseObject(captureOnly);
    unknown.injected_field = 'forged';
    assert.throws(() => parseVersionedUnitFailureIngress({ bytes: bytesFromObject(unknown), producer_build: BUG_177_HISTORICAL_UNIT_FAILURE_PRODUCERS.captureCommitOnly, identity: identity('unit-bug177') }), /unknown fields/u);
  });

  void it('current unit_failure producer is strict and does not inherit historical absent-field defaults', async () => {
    const current = await fixture(currentUnitFailureFixture);
    const parsed = parseVersionedUnitFailureIngress({ bytes: current, producer_build: COORDINATOR_IMPLEMENTATION_BUILD, identity: identity('unit-current') });
    assert.equal(parsed.ingress.current, true);
    assert.deepEqual(parsed.facts.appliedDefaults, []);
    assert.equal(sha256(roundTripPersistedArtifactIngress(parsed.ingress)), sha256(current));

    const missingCaptureRef = parseObject(current);
    delete missingCaptureRef.capture_ref;
    assert.throws(() => parseVersionedUnitFailureIngress({ bytes: bytesFromObject(missingCaptureRef), producer_build: COORDINATOR_IMPLEMENTATION_BUILD, identity: identity('unit-current') }), /missing a required field/u);
    const extra = parseObject(current);
    extra.future_field = 'not accepted from current producers';
    assert.throws(() => parseVersionedUnitFailureIngress({ bytes: bytesFromObject(extra), producer_build: COORDINATOR_IMPLEMENTATION_BUILD, identity: identity('unit-current') }), /unknown fields/u);
  });

  void it('registry validator rejects gaps, overlaps, and ambiguous producer_build ranges', () => {
    const baseRange: VersionedIngressProducerRange = {
      first_generation: 1,
      last_generation: 1,
      producer_build: 'build-a',
      exact_fields: ['schema_version'],
      required_fields: ['schema_version'],
      absent_field_defaults: [],
      unknown_field_policy: 'reject',
      current: false,
    };
    const gapRegistry: readonly PersistedArtifactFamilyDefinition[] = [{ family: 'test.gap.v1', schema_version: 'test.gap.v1', persistence: 'runtime-evidence', notes: 'gap fixture', producer_ranges: [baseRange, { ...baseRange, first_generation: 3, last_generation: 3, producer_build: 'build-b' }] }];
    assert.throws(() => assertPersistedArtifactFamilyRegistryWellFormed(gapRegistry), /gap or overlap/u);
    const overlapRegistry: readonly PersistedArtifactFamilyDefinition[] = [{ family: 'test.overlap.v1', schema_version: 'test.overlap.v1', persistence: 'runtime-evidence', notes: 'overlap fixture', producer_ranges: [{ ...baseRange, last_generation: 2 }, { ...baseRange, first_generation: 2, last_generation: 2, producer_build: 'build-b' }] }];
    assert.throws(() => assertPersistedArtifactFamilyRegistryWellFormed(overlapRegistry), /gap or overlap/u);
    const ambiguousRegistry: readonly PersistedArtifactFamilyDefinition[] = [{ family: 'test.ambiguous.v1', schema_version: 'test.ambiguous.v1', persistence: 'runtime-evidence', notes: 'ambiguous fixture', producer_ranges: [baseRange, { ...baseRange, first_generation: 2, last_generation: 2 }] }];
    assert.throws(() => assertPersistedArtifactFamilyRegistryWellFormed(ambiguousRegistry), /ambiguous producer_build/u);
  });

  void it('preserve policy retains unknown fields and byte-for-byte round trips for explicitly selected non-current generations', () => {
    const preserveRegistry: readonly PersistedArtifactFamilyDefinition[] = [{
      family: 'test.preserve.v1',
      schema_version: 'test.preserve.v1',
      persistence: 'runtime-evidence',
      notes: 'unknown preservation fixture',
      producer_ranges: [{
        first_generation: 1,
        last_generation: 1,
        producer_build: 'explicit-preserve-build',
        exact_fields: ['known', 'schema_version'],
        required_fields: ['schema_version'],
        absent_field_defaults: [{ field: 'known', value: 'defaulted' }],
        unknown_field_policy: 'preserve',
        current: false,
      }],
    }];
    assertPersistedArtifactFamilyRegistryWellFormed(preserveRegistry);
    const bytes = bytesFromObject({ schema_version: 'test.preserve.v1', future_field: { preserved: true } });
    const parsed = parseVersionedPersistedArtifact({ family: 'test.preserve.v1', producer_build: 'explicit-preserve-build', bytes, registry: preserveRegistry });
    assert.deepEqual(parsed.unknown_fields, ['future_field']);
    assert.deepEqual(parsed.applied_defaults, [{ field: 'known', value: 'defaulted' }]);
    assert.equal(sha256(roundTripPersistedArtifactIngress(parsed)), sha256(bytes));
  });

  void it('property checks every registry family has one exact current producer and no semver-derived alternate current build', () => {
    for (const family of VERSIONED_PERSISTED_ARTIFACT_FAMILY_REGISTRY) {
      const currentRanges = family.producer_ranges.filter((range) => range.current);
      assert.equal(currentRanges.length, 1, `family ${family.family} must have exactly one current range`);
      const current = currentRanges[0];
      assert.notEqual(current, undefined);
      assert.equal(current.producer_build, COORDINATOR_IMPLEMENTATION_BUILD);
      assert.equal(current.unknown_field_policy, 'reject');
      assert.throws(() => selectVersionedIngressProducer({ family: family.family, producer_build: COORDINATOR_IMPLEMENTATION_BUILD.replace('-s1', '') }), /unsupported persisted artifact producer_build/u);
    }
  });
});
