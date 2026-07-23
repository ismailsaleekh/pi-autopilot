import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyW4ProviderRegistryReadinessToCandidateSet,
  verifyW4ProviderManifestForCandidate,
} from '../../src/core/roster/providers/index.ts';
import { proposeRosterCandidates, type QualificationManifest } from '../../src/core/roster/provider-recipes.ts';
import { canonicalSha256 } from '../../src/core/roster/route-policies.ts';
import { kimiRosterInventory } from '../helpers/roster-setup-harness.ts';
import {
  w5KimiCandidate,
  w5SelfHashedKimiManifest,
} from '../helpers/w5-roster-fixtures.ts';

void describe('Phase37 W5 provider registry forgery negatives', () => {
  void it('rejects recomputed self-hash manifests that are expired or lack all-role W3 execution evidence', () => {
    const candidate = w5KimiCandidate();
    const expiredMissingRole = rehashManifest({
      ...w5SelfHashedKimiManifest(),
      role_results: w5SelfHashedKimiManifest().role_results.map((result) =>
        result.role === 'extract' ? withWrongEvidenceId(result, 'kimi-coding-exec-parent-proof') : result,
      ),
      expires_at: '2026-07-23T12:00:00.000Z',
    });

    const result = verifyW4ProviderManifestForCandidate({
      candidate,
      manifest: expiredMissingRole,
      options: { now: new Date('2026-07-23T12:00:00.000Z') },
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((issue) => issue.code), [
      'W4_CERTIFIED_ROSTER_HASH_MISMATCH',
      'W4_MANIFEST_HASH_UNTRUSTED',
      'W4_MANIFEST_ROLE_COVERAGE_MISMATCH',
      'W4_MANIFEST_TIME_INVALID',
    ]);
    assert.match(result.certified_roster_sha256 ?? '', /^sha256:[a-f0-9]{64}$/u);
  });

  void it('rejects cross-provider manifest binding even when the forged manifest hash is recomputed', () => {
    const candidate = w5KimiCandidate();
    const forged = rehashManifest({
      ...w5SelfHashedKimiManifest(),
      subject_id: 'opencode-go-plan',
      manifest_id: 'opencode-go-plan-w4-qualified-v1',
      live_evidence: w5SelfHashedKimiManifest().live_evidence.map((ref) => ({
        ...ref,
        uri: ref.uri.replace('phase37/kimi-coding/', 'phase37/opencode-go/'),
      })),
    });

    const result = verifyW4ProviderManifestForCandidate({
      candidate,
      manifest: forged,
      options: { now: new Date('2026-07-23T12:00:00.000Z') },
    });

    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === 'W4_MANIFEST_BINDING_MISMATCH'));
    assert.ok(result.issues.some((issue) => issue.code === 'W4_MANIFEST_HASH_UNTRUSTED'));
    assert.ok(result.issues.some((issue) => issue.code === 'W4_MANIFEST_LIVE_EVIDENCE_UNTRUSTED'));
  });

  void it('does not let forged manifests mutate candidate-set readiness or default launch authority', () => {
    const proposal = proposeRosterCandidates({ inventory: kimiRosterInventory(), include_unready: true });
    const forgedManifests = [
      rehashManifest({
        ...w5SelfHashedKimiManifest(),
        expires_at: '2026-07-23T12:00:00.000Z',
      }),
      rehashManifest({
        ...w5SelfHashedKimiManifest(),
        role_results: w5SelfHashedKimiManifest().role_results.map((result, index) =>
          index === 0 ? withWrongEvidenceId(result, 'kimi-coding-exec-extract-proof') : result,
        ),
      }),
    ];

    const after = applyW4ProviderRegistryReadinessToCandidateSet({
      candidateSet: proposal.candidate_set,
      manifests: forgedManifests,
      options: { now: new Date('2026-07-23T12:00:00.000Z') },
    });

    assert.equal(after.candidates.some((candidate) => candidate.launch_readiness === 'w4-certified-ready'), false);
    assert.equal(after.candidates.some((candidate) => candidate.readiness_authority === 'w4-provider-registry.v1'), false);
    assert.deepEqual(
      after.candidates.map((candidate) => ({ id: candidate.candidate_id, readiness: candidate.launch_readiness, roster: candidate.roster_sha256 })),
      proposal.candidate_set.candidates.map((candidate) => ({ id: candidate.candidate_id, readiness: candidate.launch_readiness, roster: candidate.roster_sha256 })),
    );
  });
});

function withWrongEvidenceId(
  result: QualificationManifest['role_results'][number],
  evidenceId: string,
): QualificationManifest['role_results'][number] {
  const [first] = result.evidence_refs;
  if (first === undefined) throw new Error(`missing evidence ref for ${result.role}`);
  return { ...result, evidence_refs: [{ ...first, evidence_id: evidenceId }] };
}

function rehashManifest(input: Omit<QualificationManifest, 'manifest_sha256'> | QualificationManifest): QualificationManifest {
  const { manifest_sha256: _old, ...withoutHash } = input as QualificationManifest;
  return { ...withoutHash, manifest_sha256: canonicalSha256(withoutHash) } as QualificationManifest;
}
