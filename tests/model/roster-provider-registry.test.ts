import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  applyW4ProviderRegistryReadinessToCandidateSet,
  KIMI_CODING_W4_TRUSTED_CERTIFIED_ROSTER_SHA256,
  KIMI_CODING_W4_TRUSTED_MANIFEST_SHA256,
  verifyW4ProviderManifestForCandidate,
  W4_PROVIDER_PACK_REGISTRY,
} from '../../src/core/roster/providers/index.ts';
import {
  proposeRosterCandidates,
  seedRosterByCandidate,
  type QualificationManifest,
} from '../../src/core/roster/provider-recipes.ts';
import { canonicalSha256 } from '../../src/core/roster/route-policies.ts';
import {
  kimiRosterInventory,
  trustedKimiW4ManifestFixture,
} from '../helpers/roster-setup-harness.ts';

const OFFLINE_REPORT_PATHS = [
  'artifacts/qualification/phase37/anthropic.json',
  'artifacts/qualification/phase37/codex.json',
  'artifacts/qualification/phase37/kimi-coding.json',
  'artifacts/qualification/phase37/opencode-go.json',
  'artifacts/qualification/phase37/zai.json',
] as const;

void describe('Phase37 central W4 provider registry', () => {
  void it('integrates all provider packs without treating pack presence as readiness', () => {
    assert.deepEqual(
      W4_PROVIDER_PACK_REGISTRY.map((entry) => entry.provider_id).sort(),
      ['anthropic', 'kimi-coding', 'openai-codex', 'opencode-go', 'zai'].sort(),
    );
    assert.equal(W4_PROVIDER_PACK_REGISTRY.some((entry) => entry.readiness === 'blocked-current-pack'), true);
  });

  void it('keeps all current offline qualification reports blocked', () => {
    for (const path of OFFLINE_REPORT_PATHS) {
      const report = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      const states = collectStringFields(report, 'qualification_state');
      assert.equal(states.includes('w4-certified-ready'), false, path);
      const readinessFlags = collectBooleanFields(report, new Set(['ready', 'launch_ready', 'certification_ready']));
      assert.equal(readinessFlags.some((value) => value === true), false, path);
    }
  });

  void it('promotes a candidate only with the exact trusted W3 provider manifest and materializes a W4 roster', () => {
    const proposal = proposeRosterCandidates({ inventory: kimiRosterInventory(), include_unready: true });
    const candidate = proposal.candidate_set.candidates.find((entry) => entry.recipe_id === 'kimi-coding-plan');
    if (candidate === undefined) throw new Error('missing Kimi candidate');
    assert.equal(candidate.launch_readiness, 'not-ready-until-w4');

    const trusted = trustedKimiW4ManifestFixture();
    assert.equal(trusted.manifest.manifest_sha256, KIMI_CODING_W4_TRUSTED_MANIFEST_SHA256);

    const expired = verifyW4ProviderManifestForCandidate({
      candidate,
      manifest: trusted.manifest,
      options: { now: new Date('2026-09-23T12:00:00.000Z') },
    });
    assert.equal(expired.ok, false);
    assert.ok(expired.issues.some((issue) => issue.code === 'W4_MANIFEST_TIME_INVALID'));

    const verified = verifyW4ProviderManifestForCandidate({
      candidate,
      manifest: trusted.manifest,
      options: { now: new Date('2026-07-23T12:00:00.000Z') },
    });
    assert.equal(verified.ok, true);

    const certifiedSet = applyW4ProviderRegistryReadinessToCandidateSet({
      candidateSet: proposal.candidate_set,
      manifests: [trusted.manifest],
      options: { now: new Date('2026-07-23T12:00:00.000Z') },
    });
    const ready = certifiedSet.candidates.find((entry) => entry.recipe_id === 'kimi-coding-plan');
    if (ready === undefined) throw new Error('missing ready Kimi candidate');
    assert.equal(ready.candidate_state, 'w4-certified-ready');
    assert.equal(ready.launch_readiness, 'w4-certified-ready');
    assert.equal(ready.qualification_state, 'w4-certified-ready');
    assert.equal(ready.readiness_authority, 'w4-provider-registry.v1');
    assert.equal(ready.synthetic_fixture_ready_only, false);
    assert.equal(ready.non_certifying_seed, false);
    assert.equal(ready.certification_manifest_sha256, trusted.manifest.manifest_sha256);

    const roster = seedRosterByCandidate(ready);
    if (roster === null) throw new Error('ready candidate must materialize through certified roster path');
    assert.equal(roster.generation_source, 'w4-certified-recipe');
    assert.equal(roster.certification_manifest_sha256, trusted.manifest.manifest_sha256);
    assert.equal(roster.roster_sha256, ready.roster_sha256);
    assert.equal(roster.roster_sha256, KIMI_CODING_W4_TRUSTED_CERTIFIED_ROSTER_SHA256);
    assert.equal(roster.assignments.every((assignment) => assignment.qualification_state === 'w4-certified-ready'), true);
  });

  void it('rejects recomputed self-hashes when live W3 evidence is fixture or untrusted', () => {
    const proposal = proposeRosterCandidates({ inventory: kimiRosterInventory(), include_unready: true });
    const candidate = proposal.candidate_set.candidates.find((entry) => entry.recipe_id === 'kimi-coding-plan');
    if (candidate === undefined) throw new Error('missing Kimi candidate');
    const trusted = trustedKimiW4ManifestFixture();
    const badRef = { ...trusted.manifest.live_evidence[0], uri: 'fixture://phase37/kimi-coding/not-live' };
    const withoutHash = {
      ...trusted.manifest,
      live_evidence: [badRef, ...trusted.manifest.live_evidence.slice(1)],
    };
    const { manifest_sha256: _old, ...tamperedPreimage } = withoutHash;
    const tampered = { ...tamperedPreimage, manifest_sha256: canonicalSha256(tamperedPreimage) } as QualificationManifest;

    const selfTrusted = verifyW4ProviderManifestForCandidate({
      candidate,
      manifest: tampered,
      options: { now: new Date('2026-07-23T12:00:00.000Z') },
    });
    assert.equal(selfTrusted.ok, false);
    assert.ok(selfTrusted.issues.some((issue) => issue.code === 'W4_MANIFEST_LIVE_EVIDENCE_UNTRUSTED'));
    assert.ok(selfTrusted.issues.some((issue) => issue.code === 'W4_MANIFEST_HASH_UNTRUSTED'));
  });
});

function collectStringFields(value: unknown, field: string): readonly string[] {
  const output: string[] = [];
  visitJson(value, (record) => {
    const candidate = record[field];
    if (typeof candidate === 'string') output.push(candidate);
  });
  return output;
}

function collectBooleanFields(value: unknown, fields: ReadonlySet<string>): readonly boolean[] {
  const output: boolean[] = [];
  visitJson(value, (record) => {
    for (const field of fields) {
      const candidate = record[field];
      if (typeof candidate === 'boolean') output.push(candidate);
    }
  });
  return output;
}

function visitJson(value: unknown, visitor: (record: Readonly<Record<string, unknown>>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, visitor);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Readonly<Record<string, unknown>>;
  visitor(record);
  for (const item of Object.values(record)) visitJson(item, visitor);
}
