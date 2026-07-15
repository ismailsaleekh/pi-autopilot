import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

import { CoordinationRuntimeError } from '../../src/core/coordination/failures.ts';
import {
  HISTORICAL_UNIT_FAILURE_GENERATIONS,
  classifyHistoricalUnitFailureEvidenceGeneration,
  parseHistoricalUnitFailureEvidenceFacts,
  parseUnitFailureEvidenceFacts,
  parseUnitFailureEvidenceIngress,
  validateReconciliationEvidenceDocument,
  type HistoricalUnitFailureEvidenceProvenance,
  type ReconciliationEvidenceIdentity,
} from '../../src/core/coordination/terminal-evidence.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureCaptureCommit = join(here, '..', 'fixtures', 'bug-177', 'historical-reset-unit-failure.bug177.json');
const fixturePhase2Initial = join(here, '..', 'fixtures', 'bug-177', 'historical-reset-unit-failure-phase2-initial.bug177.json');

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
}

async function readFixture(path: string): Promise<Uint8Array> {
  const buffer = await readFile(path);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

const identity = (unitId: string): ReconciliationEvidenceIdentity => ({
  repoKey: 'repo-bug177',
  autopilotId: 'autopilot-bug177',
  workstream: 'workstream-bug177',
  workstreamRun: 'workstream-run-bug177',
  source: 'attempt-reset',
  targetId: `${unitId}:1`,
  unitId,
  attempt: 1,
});

function provenance(bytes: Uint8Array, ref: string, unitId: string): HistoricalUnitFailureEvidenceProvenance {
  return {
    kind: 'coordinator-accepted-before-schema10',
    evidenceRef: ref,
    evidenceSha256: digest(bytes),
    reconciliationEvidenceId: `reconciliation-evidence-bug177-${unitId}`,
    acceptedEventSeq: 40_259,
    acceptedAt: '2026-07-14T14:00:58.597Z',
    schema10AppliedAt: '2026-07-14T22:13:51.203Z',
  };
}

// BUG-177: retained historical autopilot.unit_failure.v1 evidence (produced by
// the pre-schema-10 generators 653f660e/9bbfa0d2) carries no capture_ref and a
// null/absent capture_commit_sha. The current strict parser fails closed at
// `nullableText('capture_ref')`. The historical-ingress adapter admits ONLY an
// exact, corpus-proven reset/abort generation with trusted pre-schema10
// coordinator acceptance provenance; quarantine/preserve and unproven/malformed
// evidence remains invalid and routes to loud owned recovery. Original immutable
// bytes/digests are never rewritten.

void it('BUG-177 classifies the exact historical reset generations and rejects unknown field sets', async () => {
  const captureCommit = await readFixture(fixtureCaptureCommit);
  const phase2Initial = await readFixture(fixturePhase2Initial);
  assert.equal(classifyHistoricalUnitFailureEvidenceGeneration(captureCommit), HISTORICAL_UNIT_FAILURE_GENERATIONS.captureCommitOnly);
  assert.equal(classifyHistoricalUnitFailureEvidenceGeneration(phase2Initial), HISTORICAL_UNIT_FAILURE_GENERATIONS.phase2Initial);
  const current = new TextEncoder().encode(`${JSON.stringify({
    schema_version: 'autopilot.unit_failure.v1', action: 'reset', workstream: 'w', workstream_run: 'r', unit_id: 'u', attempt: 1, unit_worktree_path: '/tmp/u', dirty_paths: [],
    capture_commit_sha: null, capture_ref: null, git_head_before: 'a'.repeat(40), git_head_after: 'a'.repeat(40), git_common_dir: '/tmp/.git', branch: 'b', postcondition_worktree_clean: true, summary: 's', created_at: '2026-07-14T00:00:00.000Z',
  }, null, 2)}\n`);
  assert.equal(classifyHistoricalUnitFailureEvidenceGeneration(current), null, 'current-generation evidence must not classify as historical');
});

void it('BUG-177 pre-fix strict parser rejects the historical reset fixture at capture_ref', async () => {
  const bytes = await readFixture(fixtureCaptureCommit);
  assert.throws(() => parseUnitFailureEvidenceFacts(bytes, identity('unit-bug177')), /capture_ref must be bounded text or null|fields are incompatible/u, 'the strict current parser must fail closed on the historical shape');
});

void it('BUG-177 historical adapter admits the exact reset generation with trusted provenance and preserves original bytes', async () => {
  for (const [label, path, unitId] of [['capture-commit', fixtureCaptureCommit, 'unit-bug177'], ['phase2-initial', fixturePhase2Initial, 'unit-bug177-initial']] as const) {
    const bytes = await readFixture(path);
    const ref = `.pi/autopilot/workstream-bug177/quarantine/${unitId}.attempt-1.reset.json`;
    const facts = parseHistoricalUnitFailureEvidenceFacts(bytes, identity(unitId), provenance(bytes, ref, unitId));
    assert.equal(facts.action, 'reset');
    assert.equal(facts.captureCommitSha, null);
    assert.equal(facts.captureRef, null);
    assert.equal(facts.originalSha256, digest(bytes), 'original digest is preserved');
    const ingress = parseUnitFailureEvidenceIngress(bytes, identity(unitId), provenance(bytes, ref, unitId));
    assert.equal(ingress.kind, 'historical');
    validateReconciliationEvidenceDocument(bytes, identity(unitId), provenance(bytes, ref, unitId));
    void label;
  }
});

void it('BUG-177 rejects historical quarantine/preserve, forged digest, and unproven evidence loudly without releasing authority', async () => {
  const bytes = await readFixture(fixtureCaptureCommit);
  const ref = '.pi/autopilot/workstream-bug177/quarantine/unit-bug177.attempt-1.reset.json';
  const quarantineBytes = new TextEncoder().encode(`${JSON.stringify({ ...JSON.parse(new TextDecoder().decode(bytes)), action: 'quarantine' }, null, 2)}\n`);
  assert.throws(() => parseHistoricalUnitFailureEvidenceFacts(quarantineBytes, identity('unit-bug177'), provenance(quarantineBytes, ref, 'unit-bug177')), /capture ref|recovery-required/u);
  const forgedProvenance: HistoricalUnitFailureEvidenceProvenance = { ...provenance(bytes, ref, 'unit-bug177'), evidenceSha256: `sha256:${'0'.repeat(64)}` };
  assert.throws(() => parseHistoricalUnitFailureEvidenceFacts(bytes, identity('unit-bug177'), forgedProvenance), /differs from its accepted coordinator provenance/u);
  const lateProvenance: HistoricalUnitFailureEvidenceProvenance = { ...provenance(bytes, ref, 'unit-bug177'), acceptedAt: '2026-07-15T00:00:00.000Z', schema10AppliedAt: '2026-07-14T22:13:51.203Z' };
  assert.throws(() => parseHistoricalUnitFailureEvidenceFacts(bytes, identity('unit-bug177'), lateProvenance), /trusted pre-schema10 coordinator acceptance fence/u);
  assert.throws(() => parseUnitFailureEvidenceIngress(bytes, identity('unit-bug177'), null), /capture_ref must be bounded text or null|fields are incompatible/u);
});

void it('BUG-177 current missing-capture_ref reset and quarantine-without-capture evidence still fail closed', () => {
  const base = { schema_version: 'autopilot.unit_failure.v1', workstream: 'workstream-bug177', workstream_run: 'workstream-run-bug177', unit_id: 'unit-current', attempt: 1, unit_worktree_path: '/tmp/u', dirty_paths: [], capture_commit_sha: null, git_head_before: 'a'.repeat(40), git_head_after: 'a'.repeat(40), git_common_dir: '/tmp/.git', branch: 'b', postcondition_worktree_clean: true, summary: 's', created_at: '2026-07-14T00:00:00.000Z' } as const;
  const missingRefReset = new TextEncoder().encode(`${JSON.stringify({ ...base, capture_ref: undefined, action: 'reset' }, null, 2)}\n`);
  assert.throws(() => parseUnitFailureEvidenceFacts(missingRefReset, identity('unit-current')), /fields are incompatible|capture_ref/u);
  const quarantineNoCapture = new TextEncoder().encode(`${JSON.stringify({ ...base, action: 'quarantine', capture_commit_sha: null, capture_ref: null }, null, 2)}\n`);
  assert.throws(() => parseUnitFailureEvidenceFacts(quarantineNoCapture, identity('unit-current')), /quarantine.*requires an immutable capture commit and ref/u);
  const resetWithCapture = new TextEncoder().encode(`${JSON.stringify({ ...base, action: 'reset', capture_commit_sha: 'a'.repeat(40), capture_ref: 'autopilot/archive/workstream-run-bug177/unit/unit-current/attempt-1/reset-capture' }, null, 2)}\n`);
  assert.throws(() => parseUnitFailureEvidenceFacts(resetWithCapture, identity('unit-current')), /clean reset\/abort evidence cannot claim quarantine capture fields/u);
});

void it('BUG-177 rejects oversized, non-string, and extra-field historical evidence', async () => {
  const bytes = await readFixture(fixtureCaptureCommit);
  const ref = '.pi/autopilot/workstream-bug177/quarantine/unit-bug177.attempt-1.reset.json';
  const extraField = new TextEncoder().encode(`${JSON.stringify({ ...JSON.parse(new TextDecoder().decode(bytes)), injected_field: 'forged' }, null, 2)}\n`);
  assert.throws(() => parseHistoricalUnitFailureEvidenceFacts(extraField, identity('unit-bug177'), provenance(extraField, ref, 'unit-bug177')), /not an enumerated historical producer generation/u);
  const wrongUnit = new TextEncoder().encode(`${JSON.stringify({ ...JSON.parse(new TextDecoder().decode(bytes)), unit_id: 'unit-other' }, null, 2)}\n`);
  assert.throws(() => parseHistoricalUnitFailureEvidenceFacts(wrongUnit, identity('unit-bug177'), provenance(wrongUnit, ref, 'unit-bug177')), /unit_id does not match|differs from its accepted coordinator provenance/u);
});
