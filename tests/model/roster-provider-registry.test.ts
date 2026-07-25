import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  applyW4ProviderRegistryReadinessToCandidateSet,
  isCentrallyTrustedW4CertifiedRoster,
  verifyW4ProviderManifestForCandidate,
  W4_PROVIDER_PACK_REGISTRY,
} from '../../src/core/roster/providers/index.ts';
import { loadPackagedLiveCertificationManifests } from '../../src/core/roster/live-certification-manifests.ts';
import {
  buildW4CertifiedRosterForCandidate,
  proposeRosterCandidates,
  type QualificationManifest,
} from '../../src/core/roster/provider-recipes.ts';
import { canonicalSha256 } from '../../src/core/roster/route-policies.ts';
import {
  codexRosterInventory,
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
      ['anthropic', 'anthropic', 'kimi-coding', 'openai-codex', 'openai-codex', 'opencode-go', 'zai'].sort(),
    );
    assert.deepEqual(
      W4_PROVIDER_PACK_REGISTRY.map((entry) => entry.provider_pack_id),
      W4_PROVIDER_PACK_REGISTRY.map((entry) => entry.provider_pack_id).sort((left, right) => left.localeCompare(right)),
    );
    assert.equal(W4_PROVIDER_PACK_REGISTRY.some((entry) => entry.readiness === 'blocked-current-pack'), true);
    const opus5Sonnet5 = W4_PROVIDER_PACK_REGISTRY.find((entry) => entry.provider_pack_id === 'anthropic-opus5-sonnet5-subscription-w4');
    assert.notEqual(opus5Sonnet5, undefined);
    assert.deepEqual(opus5Sonnet5?.ready_profiles, ['precision']);
    assert.equal(opus5Sonnet5?.certification_pi_version, '0.82.0');
    assert.equal(opus5Sonnet5?.required_evidence.length, 10);
    const gpt55Heavy = W4_PROVIDER_PACK_REGISTRY.find((entry) => entry.provider_pack_id === 'codex-gpt55-heavy-sol-terra-w4');
    assert.notEqual(gpt55Heavy, undefined);
    assert.deepEqual(gpt55Heavy?.ready_profiles, ['cruise']);
    assert.equal(gpt55Heavy?.certification_pi_version, '0.82.0');
    assert.equal(gpt55Heavy?.required_evidence.length, 10);
    assert.deepEqual(gpt55Heavy?.trusted_manifest_ids, ['codex-gpt55-heavy-sol-terra-w4-live-20260724']);
    assert.deepEqual(gpt55Heavy?.trusted_manifest_sha256s, ['sha256:9c8a852f64f06951b00bea59c1e137ea0066b293fb2dc836aded72f3c2c93b03']);
    assert.deepEqual(gpt55Heavy?.trusted_certified_roster_sha256s, ['sha256:7adf4b920818facf754ff67b63ccb8239b5b29ecb7352d78c09417a3824fc537']);
    const unpinned = W4_PROVIDER_PACK_REGISTRY.filter((entry) => entry.provider_pack_id !== 'codex-gpt55-heavy-sol-terra-w4');
    assert.equal(unpinned.every((entry) => entry.trusted_manifest_ids.length === 0), true);
    assert.equal(unpinned.every((entry) => entry.trusted_manifest_sha256s.length === 0), true);
    assert.equal(unpinned.every((entry) => entry.trusted_certified_roster_sha256s.length === 0), true);
  });

  void it('promotes the exact reviewed Codex live manifest and no other candidate', () => {
    const manifests = loadPackagedLiveCertificationManifests();
    assert.equal(manifests.length, 1);
    const manifest = manifests[0] as QualificationManifest;
    const baseInventory = codexRosterInventory();
    const inventory = {
      ...baseInventory,
      providers: baseInventory.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, service_tiers: [null, ...model.service_tiers.filter((tier) => tier !== null)] })),
      })),
    };
    const proposal = proposeRosterCandidates({ inventory, include_unready: true });
    const candidate = proposal.candidate_set.candidates.find((entry) => entry.recipe_id === 'codex-gpt55-heavy-subscription');
    if (candidate === undefined) throw new Error('missing Codex GPT-5.5 Heavy candidate');

    const verified = verifyW4ProviderManifestForCandidate({
      candidate,
      manifest,
      options: { now: new Date('2026-07-25T00:00:00.000Z') },
    });
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.issues, []);
    assert.equal(verified.certified_roster_sha256, 'sha256:7adf4b920818facf754ff67b63ccb8239b5b29ecb7352d78c09417a3824fc537');

    const certifiedSet = applyW4ProviderRegistryReadinessToCandidateSet({
      candidateSet: proposal.candidate_set,
      manifests: [manifest],
      options: { now: new Date('2026-07-25T00:00:00.000Z') },
    });
    const ready = certifiedSet.candidates.filter((entry) => entry.launch_readiness === 'w4-certified-ready');
    assert.equal(ready.length, 1);
    assert.equal(ready[0]?.candidate_id, 'codex-gpt55-heavy-sol-terra-v1');
    assert.equal(ready[0]?.provider_pack_id, 'codex-gpt55-heavy-sol-terra-w4');
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
