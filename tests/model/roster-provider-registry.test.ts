import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  applyW4ProviderRegistryReadinessToCandidateSet,
  isCentrallyTrustedW4CertifiedRoster,
  verifyW4ProviderManifestForCandidate,
  W4_PROVIDER_PACK_REGISTRY,
} from '../../src/core/roster/providers/index.ts';
import {
  buildW4CertifiedRosterForCandidate,
  proposeRosterCandidates,
  type QualificationManifest,
} from '../../src/core/roster/provider-recipes.ts';
import { canonicalSha256 } from '../../src/core/roster/route-policies.ts';
import {
  kimiRosterInventory,
  selfHashedKimiW4ManifestFixture,
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
    assert.equal(W4_PROVIDER_PACK_REGISTRY.every((entry) => entry.trusted_manifest_ids.length === 0), true);
    assert.equal(W4_PROVIDER_PACK_REGISTRY.every((entry) => entry.trusted_manifest_sha256s.length === 0), true);
    assert.equal(W4_PROVIDER_PACK_REGISTRY.every((entry) => entry.trusted_certified_roster_sha256s.length === 0), true);
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

  void it('blocks a perfectly shaped self-hashed Kimi W3 manifest because current registry pins are empty', () => {
    const proposal = proposeRosterCandidates({ inventory: kimiRosterInventory(), include_unready: true });
    const candidate = proposal.candidate_set.candidates.find((entry) => entry.recipe_id === 'kimi-coding-plan');
    if (candidate === undefined) throw new Error('missing Kimi candidate');
    assert.equal(candidate.launch_readiness, 'not-ready-until-w4');

    const fixture = selfHashedKimiW4ManifestFixture();
    const { manifest_sha256: _manifestSha, ...manifestPreimage } = fixture.manifest;
    assert.equal(fixture.manifest.manifest_sha256, canonicalSha256(manifestPreimage));

    const selfCertifiedRoster = buildW4CertifiedRosterForCandidate({ candidate, certification_manifest_id: fixture.manifest.manifest_id, certification_manifest_sha256: fixture.manifest.manifest_sha256 });
    assert.notEqual(selfCertifiedRoster, null);
    if (selfCertifiedRoster === null) throw new Error('missing self-certified roster');
    assert.equal(isCentrallyTrustedW4CertifiedRoster(selfCertifiedRoster), false);

    const verified = verifyW4ProviderManifestForCandidate({
      candidate,
      manifest: fixture.manifest,
      options: { now: new Date('2026-07-23T12:00:00.000Z') },
    });
    assert.equal(verified.ok, false);
    assert.deepEqual(verified.issues.map((issue) => issue.code), [
      'W4_CERTIFIED_ROSTER_HASH_MISMATCH',
      'W4_MANIFEST_HASH_UNTRUSTED',
    ]);

    const certifiedSet = applyW4ProviderRegistryReadinessToCandidateSet({
      candidateSet: proposal.candidate_set,
      manifests: [fixture.manifest],
      options: { now: new Date('2026-07-23T12:00:00.000Z') },
    });
    const stillBlocked = certifiedSet.candidates.find((entry) => entry.recipe_id === 'kimi-coding-plan');
    if (stillBlocked === undefined) throw new Error('missing Kimi candidate');
    assert.notEqual(stillBlocked.candidate_state, 'w4-certified-ready');
    assert.equal(stillBlocked.launch_readiness, 'not-ready-until-w4');
    assert.notEqual(stillBlocked.qualification_state, 'w4-certified-ready');
    assert.equal(stillBlocked.readiness_authority ?? null, null);
    assert.equal(certifiedSet.candidates.some((entry) => entry.launch_readiness === 'w4-certified-ready'), false);
  });

  void it('rejects recomputed self-hashes when live W3 evidence is fixture or untrusted', () => {
    const proposal = proposeRosterCandidates({ inventory: kimiRosterInventory(), include_unready: true });
    const candidate = proposal.candidate_set.candidates.find((entry) => entry.recipe_id === 'kimi-coding-plan');
    if (candidate === undefined) throw new Error('missing Kimi candidate');
    const fixture = selfHashedKimiW4ManifestFixture();
    const badRef = { ...fixture.manifest.live_evidence[0], uri: 'fixture://phase37/kimi-coding/not-live' };
    const withoutHash = {
      ...fixture.manifest,
      live_evidence: [badRef, ...fixture.manifest.live_evidence.slice(1)],
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
