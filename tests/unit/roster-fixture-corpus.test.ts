import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  PHASE37_W0_FIXTURE_CANONICAL_VECTOR_COUNT,
  PHASE37_W0_FIXTURE_CASE_COUNT,
  PHASE37_W0_FIXTURE_CORPUS_SHA256,
  RosterFixtureCorpusError,
  loadPhase37W0FixtureCorpus,
  parsePhase37W0FixtureCorpusText,
  type JsonObject,
} from '../../src/core/roster/fixture-corpus.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const reusableFixturePath = resolve(repoRoot, 'tests', 'fixtures', 'roster', 'phase37-w0-acceptance.v1.json');
const sealedAuthorityPath = resolve(repoRoot, 'design', 'phase37', 'roster-acceptance-fixtures.v1.json');

function sha256Text(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function mutateCorpus(mutator: (corpus: Record<string, unknown>) => void): string {
  const parsed = JSON.parse(readFileSync(reusableFixturePath, 'utf8')) as Record<string, unknown>;
  mutator(parsed);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function expectCorpusError(action: () => unknown, code: string, messagePattern: RegExp): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof RosterFixtureCorpusError && error.code === code && messagePattern.test(error.message),
  );
}

function objectValue(object: JsonObject, key: string): JsonObject {
  const value = object[key];
  assert.ok(value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as JsonObject;
}

void describe('Phase 37 W1 fixture corpus loader', () => {
  void it('loads the exact promoted W0 acceptance authority and freezes a synthetic-only corpus', () => {
    const promotedBytes = readFileSync(reusableFixturePath);
    const authorityBytes = readFileSync(sealedAuthorityPath);
    assert.equal(createHash('sha256').update(promotedBytes).digest('hex'), PHASE37_W0_FIXTURE_CORPUS_SHA256.slice('sha256:'.length));
    assert.deepEqual([...promotedBytes], [...authorityBytes], 'reusable fixture path must be byte-identical to sealed authority');

    const loaded = loadPhase37W0FixtureCorpus({ path: reusableFixturePath });
    assert.equal(loaded.sha256, PHASE37_W0_FIXTURE_CORPUS_SHA256);
    assert.equal(loaded.syntheticOnly, true);
    assert.equal(loaded.providerEvidenceCertifying, false);
    assert.equal(loaded.fixtureIds.length, PHASE37_W0_FIXTURE_CASE_COUNT);
    assert.equal(loaded.canonicalVectorIds.length, PHASE37_W0_FIXTURE_CANONICAL_VECTOR_COUNT);
    assert.equal(Object.isFrozen(loaded.corpus), true);
    assert.equal(Object.isFrozen(loaded.corpus.fixture_cases[0]), true);

    const firstCase = loaded.corpus.fixture_cases[0];
    assert.ok(firstCase);
    assert.throws(() => {
      Object.defineProperty(firstCase, 'fixture_id', { value: 'mutated' });
    }, TypeError, 'loaded fixtures must fail loudly on mutation');

    const routeVector = loaded.getCanonicalVector('route-policy.codex-subscription-v1');
    assert.equal(
      routeVector.canonical_json_utf8,
      '{"allowed_apis":["openai-codex-responses"],"allowed_auth_classes":["oauth"],"allowed_auth_sources":["runtime","stored"],"allowed_cache_policies":["provider-default"],"allowed_service_tiers":[null,"priority"],"allowed_system_prompt_profiles":["pi-default.v1"],"billing_class":"plan-backed-subscription","billing_route_class":"subscription-oauth","forbidden_gateways":["arbitrary-api-key","metered-frontier","openrouter"],"non_certifying_seed":true,"policy_state":"unqualified-seed","provider_id":"openai-codex","qualification_state":"unqualified-non-certifying-seed","requires_live_billing_proof":true,"revision":1,"route_policy_id":"codex-subscription-v1","schema_version":"autopilot.route_policy.v1"}\n',
    );
    assert.equal(routeVector.sha256, 'sha256:1a23f607a9fce47701ee5e7576205d29c7cb8451bc9186190ea4e9e550e60ccc');

    const registry = loaded.corpus.object_registry;
    assert.equal(objectValue(registry, 'synthetic_config')['config_sha256'], 'sha256:1d8a144806f7bd3df23724eb702223c7180b4d160cb09fc8cff5cbc77a1e3a38');
    assert.equal(objectValue(registry, 'synthetic_receipt')['receipt_sha256'], 'sha256:e9496daad0eede5aa932271547d7d4054edb88ca6087762b9a4a86d4b03757ba');
    assert.equal(objectValue(registry, 'synthetic_pre_run_selection')['selection_sha256'], 'sha256:96c3625fddc6d43145ca5c6dece482e97fba78ad01c333e6aa3382fbe40d1878');

    const fixed = loaded.corpus.fixed_values;
    assert.equal(fixed['clock'], '2026-07-22T12:00:00.000Z');
    assert.equal(fixed['clock_later'], '2026-07-22T12:00:05.000Z');
    assert.equal(fixed['clock_transition'], '2026-07-22T12:01:00.000Z');

    const saveSuccess = loaded.getCase('save.config-last.success');
    assert.equal(saveSuccess.expected['write_count'], 3);
    assert.equal(saveSuccess.expected['lock_count'], 1);
    assert.deepEqual(saveSuccess.expected['files_touched'], [
      '~/.pi/agent/autopilot/rosters/cruise-codex-subscription-bdb4f15f0ff9/revision-1.json',
      '~/.pi/agent/autopilot/rosters/precision-codex-subscription-bdb4f15f0ff9/revision-1.json',
      '~/.pi/agent/autopilot/config.json',
    ]);
    assert.equal(saveSuccess.expected['receipt_sha256'], 'sha256:e9496daad0eede5aa932271547d7d4054edb88ca6087762b9a4a86d4b03757ba');

    const historical = loaded.getCase('historical.v1.bytes-preserved');
    assert.equal(historical.expected['historical_bytes_mutated'], false);
    assert.equal(historical.expected['historical_unit_spec_sha256'], 'sha256:65cbd5ad70645406adad2aceea695a1ab2a1b8a7f51d33de4b4b321e1a61fada');
    assert.equal(historical.expected['historical_receipt_sha256'], 'sha256:1914276a05a76d9fa688c535e90460bd802802bd6cf903a3a9e253aa876684fb');
  });

  void it('rejects sealed corpus digest drift before parsing', () => {
    const corrupted = readFileSync(reusableFixturePath, 'utf8').replace('w1-ready-fixture-authority', 'w1-ready-fixture-authority-mutated');
    expectCorpusError(
      () => parsePhase37W0FixtureCorpusText(corrupted, { source: 'mutated digest', expectedSha256: PHASE37_W0_FIXTURE_CORPUS_SHA256 }),
      'digest-drift',
      /digest drift/u,
    );
  });

  void it('rejects duplicate object keys and unknown closed fields without fallback', () => {
    const duplicate = '{"schema_version":"one","schema_version":"two"}\n';
    expectCorpusError(
      () => parsePhase37W0FixtureCorpusText(duplicate, { source: 'duplicate-key fixture', expectedSha256: sha256Text(duplicate) }),
      'invalid-json',
      /duplicate object key/u,
    );

    const unknownField = mutateCorpus((corpus) => {
      corpus['unexpected_runtime_default'] = true;
    });
    expectCorpusError(
      () => parsePhase37W0FixtureCorpusText(unknownField, { source: 'unknown-field fixture', expectedSha256: sha256Text(unknownField) }),
      'closed-field-violation',
      /unknown, missing, or reordered fields/u,
    );

    const reorderedCases = mutateCorpus((corpus) => {
      const cases = corpus['fixture_cases'] as Record<string, unknown>[];
      const first = cases[0];
      const second = cases[1];
      if (first === undefined || second === undefined) throw new Error('fixture cases missing');
      cases[0] = second;
      cases[1] = first;
    });
    expectCorpusError(
      () => parsePhase37W0FixtureCorpusText(reorderedCases, { source: 'reordered-cases fixture', expectedSha256: sha256Text(reorderedCases) }),
      'fixture-contract-violation',
      /fixture case id\/order drift/u,
    );
  });

  void it('rejects canonical fixture-case/object-registry drift when bytes are otherwise digest-bound', () => {
    const hashDrift = mutateCorpus((corpus) => {
      const cases = corpus['fixture_cases'] as Record<string, unknown>[];
      const first = cases[0];
      if (first === undefined) throw new Error('fixture case missing');
      const expected = first['expected'] as Record<string, unknown>;
      expected['write_count'] = 1;
    });
    expectCorpusError(
      () => parsePhase37W0FixtureCorpusText(hashDrift, { source: 'case-hash-drift fixture', expectedSha256: sha256Text(hashDrift) }),
      'canonical-drift',
      /fixture_case_sha256 digest drift/u,
    );

    const vectorDrift = mutateCorpus((corpus) => {
      const vectors = corpus['canonical_vectors'] as Record<string, unknown>[];
      const first = vectors[0];
      if (first === undefined) throw new Error('canonical vector missing');
      first['canonical_json_utf8'] = '{"mutated":true}\n';
    });
    expectCorpusError(
      () => parsePhase37W0FixtureCorpusText(vectorDrift, { source: 'vector-drift fixture', expectedSha256: sha256Text(vectorDrift) }),
      'canonical-drift',
      /literal canonical vector digest drift/u,
    );
  });

  void it('rejects certification, secret, and historical byte-faithfulness corruption', () => {
    const certifying = mutateCorpus((corpus) => {
      const notice = corpus['evidence_notice'] as Record<string, unknown>;
      notice['provider_evidence_is_certifying'] = true;
    });
    expectCorpusError(
      () => parsePhase37W0FixtureCorpusText(certifying, { source: 'certifying fixture', expectedSha256: sha256Text(certifying) }),
      'fixture-contract-violation',
      /non-certifying/u,
    );

    const historicalByteDrift = mutateCorpus((corpus) => {
      const registry = corpus['object_registry'] as Record<string, unknown>;
      const artifacts = registry['historical_artifacts'] as Record<string, unknown>[];
      const unit = artifacts[0];
      if (unit === undefined) throw new Error('historical artifact missing');
      unit['bytes_utf8'] = `${String(unit['bytes_utf8'])} `;
    });
    expectCorpusError(
      () => parsePhase37W0FixtureCorpusText(historicalByteDrift, { source: 'historical-byte-drift fixture', expectedSha256: sha256Text(historicalByteDrift) }),
      'canonical-drift',
      /artifact_sha256 digest drift/u,
    );
  });
});
