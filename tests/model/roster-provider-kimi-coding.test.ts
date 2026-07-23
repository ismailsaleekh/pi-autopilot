import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { parseAutopilotRosterContract } from '../../src/core/roster/contracts.ts';
import { ROSTER_ROLE_ORDER, canonicalSha256, type Digest, type RosterRole } from '../../src/core/roster/route-policies.ts';
import {
  KIMI_CODING_API,
  KIMI_CODING_AUTH_CLASS,
  KIMI_CODING_AUTH_MATERIAL_SHAPE,
  KIMI_CODING_BILLING_ROUTE_CLASS,
  KIMI_CODING_EXPIRES_AT,
  KIMI_CODING_ISSUED_AT,
  KIMI_CODING_LABELS,
  KIMI_CODING_PENDING_LIVE_POST_W3_WITNESSES,
  KIMI_CODING_PROVIDER_ID,
  KIMI_CODING_PROVIDER_RECIPE,
  KIMI_CODING_RECIPE_ID,
  KIMI_CODING_REQUIRED_EVIDENCE_REFS,
  KIMI_CODING_ROLE_TEMPLATES,
  KIMI_CODING_ROUTE_FACTS,
  KIMI_CODING_ROUTE_POLICY_ID,
  KIMI_CODING_SYSTEM_PROMPT_PROFILE,
  allKimiCodingRequestProfiles,
  assertKimiCodingRoleTemplateCompleteness,
  buildKimiCodingOfflineQualificationReport,
  buildKimiCodingQualificationManifestCandidate,
  evaluateKimiCodingQualification,
  exactKimiCodingRouteObservation,
  kimiCodingRequestProfileForRole,
  makeKimiCodingObservedEvidence,
  makeKimiCodingSyntheticQualificationInput,
  verifyKimiCodingOfflineQualificationReport,
  type KimiCodingOfflineQualificationReport,
  type KimiCodingQualificationInput,
  type KimiCodingQualificationIssueCode,
} from '../../src/core/roster/providers/kimi-coding.ts';

interface ProviderFixture {
  readonly qualification_input: KimiCodingQualificationInput;
  readonly evaluation: unknown;
  readonly manifest_candidate: unknown;
  readonly negative_cases: readonly {
    readonly case_id: string;
    readonly role?: string;
    readonly expected_issue_codes: readonly KimiCodingQualificationIssueCode[];
  }[];
}

void describe('D69 W4 Kimi Coding provider pack offline model', () => {
  void it('binds exactly to W0 kimi-coding-plan-v1 route and role facts', () => {
    assert.equal(KIMI_CODING_PROVIDER_ID, 'kimi-coding');
    assert.equal(KIMI_CODING_RECIPE_ID, 'kimi-coding-plan');
    assert.equal(KIMI_CODING_ROUTE_POLICY_ID, 'kimi-coding-plan-v1');
    assert.equal(KIMI_CODING_API, 'openai-completions');
    assert.equal(KIMI_CODING_SYSTEM_PROMPT_PROFILE, 'pi-default.v1');
    assert.equal(KIMI_CODING_AUTH_CLASS, 'api-key-plan-token');
    assert.equal(KIMI_CODING_AUTH_MATERIAL_SHAPE, 'api-key-shaped-plan-token');
    assert.equal(KIMI_CODING_BILLING_ROUTE_CLASS, 'plan-api-token');
    assert.deepEqual(KIMI_CODING_ROUTE_FACTS.allowed_apis, ['openai-completions']);
    assert.deepEqual(KIMI_CODING_ROUTE_FACTS.allowed_system_prompt_profiles, ['pi-default.v1']);
    assert.deepEqual(KIMI_CODING_ROUTE_FACTS.allowed_auth_classes, ['api-key-plan-token']);
    assert.equal(KIMI_CODING_ROUTE_FACTS.allowed_auth_classes.includes('api-key' as never), false);
    assert.equal(KIMI_CODING_ROUTE_FACTS.plan_token_grants_generic_api_key, false);
    assert.deepEqual(KIMI_CODING_ROUTE_FACTS.forbidden_gateways, ['arbitrary-api-key', 'metered-frontier', 'openrouter']);

    assertKimiCodingRoleTemplateCompleteness();
    assert.equal(Object.isFrozen(KIMI_CODING_ROLE_TEMPLATES), true);
    assert.deepEqual(KIMI_CODING_ROLE_TEMPLATES, mustPrecisionProfile().role_templates);
    assert.deepEqual(
      KIMI_CODING_ROLE_TEMPLATES.map((template) => ({
        role: template.role,
        model_id: template.model_id,
        api: template.api,
        thinking: template.thinking,
        context_window: template.context_window,
        max_output_tokens: template.max_output_tokens,
        input_modalities: template.input_modalities,
        output_modalities: template.output_modalities,
        system_prompt_profile: template.system_prompt_profile,
      })),
      [
        { role: 'parent', model_id: 'kimi-k3', api: 'openai-completions', thinking: 'xhigh', context_window: 256000, max_output_tokens: 32768, input_modalities: ['text'], output_modalities: ['text'], system_prompt_profile: 'pi-default.v1' },
        { role: 'strategy', model_id: 'kimi-k3', api: 'openai-completions', thinking: 'xhigh', context_window: 256000, max_output_tokens: 32768, input_modalities: ['text'], output_modalities: ['text'], system_prompt_profile: 'pi-default.v1' },
        { role: 'implement', model_id: 'kimi-for-coding', api: 'openai-completions', thinking: 'high', context_window: 256000, max_output_tokens: 32768, input_modalities: ['text'], output_modalities: ['text'], system_prompt_profile: 'pi-default.v1' },
        { role: 'validate', model_id: 'kimi-k3', api: 'openai-completions', thinking: 'xhigh', context_window: 256000, max_output_tokens: 32768, input_modalities: ['text'], output_modalities: ['text'], system_prompt_profile: 'pi-default.v1' },
        { role: 'fix', model_id: 'kimi-for-coding', api: 'openai-completions', thinking: 'high', context_window: 256000, max_output_tokens: 32768, input_modalities: ['text'], output_modalities: ['text'], system_prompt_profile: 'pi-default.v1' },
        { role: 'adjudicate', model_id: 'kimi-k3', api: 'openai-completions', thinking: 'xhigh', context_window: 256000, max_output_tokens: 32768, input_modalities: ['text'], output_modalities: ['text'], system_prompt_profile: 'pi-default.v1' },
        { role: 'bughunt', model_id: 'kimi-k3', api: 'openai-completions', thinking: 'xhigh', context_window: 256000, max_output_tokens: 32768, input_modalities: ['text'], output_modalities: ['text'], system_prompt_profile: 'pi-default.v1' },
        { role: 'extract', model_id: 'kimi-for-coding-highspeed', api: 'openai-completions', thinking: 'high', context_window: 128000, max_output_tokens: 16384, input_modalities: ['text'], output_modalities: ['text'], system_prompt_profile: 'pi-default.v1' },
      ],
    );

    assert.deepEqual(KIMI_CODING_LABELS.model_labels, ['kimi-k3', 'kimi-for-coding', 'kimi-for-coding-highspeed']);
    assert.equal(Object.hasOwn(KIMI_CODING_LABELS, 'rank'), false);
  });

  void it('deletes highspeed-to-base alias/substitution authority and keeps extract exact', async () => {
    const source = await readText('../../src/core/roster/providers/kimi-coding.ts');
    assert.equal(/substituteKimiCodingHighspeedModel/u.test(source), false);
    assert.equal(/highspeed_substitution/u.test(source), false);
    assert.equal(/declared_model_id/u.test(source), false);
    assert.equal(/request_model_id/u.test(source), false);
    assert.equal(/['"]highspeed['"]/u.test(source), false);
    assert.equal(/['"]K3['"]/u.test(source), false);

    const extractProfile = kimiCodingRequestProfileForRole('extract');
    assert.equal(extractProfile.model_id, 'kimi-for-coding-highspeed');
    assert.equal(extractProfile.model, 'kimi-coding/kimi-for-coding-highspeed');
    const extractObserved = makeKimiCodingObservedEvidence(extractProfile);
    assert.equal(extractObserved.requested_model_id, 'kimi-for-coding-highspeed');
    assert.equal(extractObserved.executed_model_id, 'kimi-for-coding-highspeed');
    assert.equal(extractObserved.requested_model_id, extractObserved.executed_model_id);

    for (const profile of allKimiCodingRequestProfiles()) {
      assert.equal(profile.api, 'openai-completions');
      assert.deepEqual(profile.input_modalities, ['text']);
      assert.deepEqual(profile.output_modalities, ['text']);
      assert.equal(profile.system_prompt_profile, 'pi-default.v1');
      assert.equal(profile.cache_policy, 'provider-default');
    }
  });

  void it('keeps synthetic fixture and current artifact blocked/non-certifying with explicit pending evidence', async () => {
    const fixture = await readFixture();
    const input = fixture.qualification_input;
    const evaluation = evaluateKimiCodingQualification(input);
    const manifestCandidate = buildKimiCodingQualificationManifestCandidate(input);
    const artifact = await readArtifact();

    assert.equal((await readJson('../fixtures/roster/providers/kimi-coding.v1.json'))['status'], 'synthetic-non-certifying');
    assert.deepEqual(fixture.evaluation, evaluation);
    assert.deepEqual(fixture.manifest_candidate, manifestCandidate);
    assert.deepEqual(artifact, buildKimiCodingOfflineQualificationReport(input));
    assert.deepEqual(verifyKimiCodingOfflineQualificationReport(artifact), []);
    assert.equal(evaluation.structural_pass, true);
    assert.equal(evaluation.certification_ready, false);
    assert.equal(evaluation.qualification_state, 'qualification-required');
    assert.equal(evaluation.synthetic_fixture_non_certifying, true);
    assert.deepEqual(evaluation.issues, []);
    assert.deepEqual(evaluation.pending_live_post_w3_witnesses, KIMI_CODING_PENDING_LIVE_POST_W3_WITNESSES);

    const manifest = manifestCandidate.certification_manifest;
    parseAutopilotRosterContract('autopilot.certification_manifest.v1', manifest);
    assert.equal(manifest.subject_id, 'kimi-coding-plan');
    assert.equal(manifest.subject_sha256, KIMI_CODING_PROVIDER_RECIPE.recipe_sha256);
    assert.equal(manifest.package_version, '1.3.0');
    assert.equal(manifest.pi_version, '0.80.6');
    assert.equal(manifest.issued_at, KIMI_CODING_ISSUED_AT);
    assert.equal(manifest.expires_at, KIMI_CODING_EXPIRES_AT);
    assert.equal(manifest.qualification_state, 'qualification-required');
    assert.deepEqual(manifest.live_evidence, []);
    assert.equal(manifest.role_results.every((result) => result.state === 'synthetic-pass'), true);
    assert.deepEqual(manifest.required_evidence, KIMI_CODING_REQUIRED_EVIDENCE_REFS);
    assert.equal(artifact.network_calls, 0);
    assert.equal(artifact.live_provider_certification_asserted, false);
    assert.equal(artifact.synthetic_fixtures_certifying, false);
    assert.equal(artifact.model_substitution_allowed, false);
    assert.equal(artifact.pending_live_post_w3_witnesses.length > 0, true);
  });

  void it('does not certify caller-supplied live-looking structs without trusted W3 evidence refs/digests', () => {
    const sourceOnlyLiveInput: KimiCodingQualificationInput = { ...makeKimiCodingSyntheticQualificationInput(), evidence_source: 'live-post-w3-witness' };
    const sourceOnlyEvaluation = evaluateKimiCodingQualification(sourceOnlyLiveInput);
    assert.equal(sourceOnlyEvaluation.certification_ready, false);
    assert.equal(sourceOnlyEvaluation.qualification_state, 'qualification-required');
    assertIncludesAll(issueCodes(sourceOnlyEvaluation), [
      'KIMI_CODING_EVIDENCE_DIGEST_REQUIRED',
      'KIMI_CODING_LIVE_W3_EVIDENCE_REQUIRED',
      'KIMI_CODING_EVIDENCE_REF_UNTRUSTED',
    ]);

    const liveInput = makeTrustedLiveW3Input();
    const liveEvaluation = evaluateKimiCodingQualification(liveInput);
    const liveCandidate = buildKimiCodingQualificationManifestCandidate(liveInput);
    assert.equal(liveEvaluation.certification_ready, true);
    assert.equal(liveCandidate.certification_ready, true);
    assert.equal(liveCandidate.qualification_state, 'w4-certified-ready');
    assert.equal(liveCandidate.certification_manifest.role_results.every((result) => result.state === 'pass'), true);
    assert.equal(liveCandidate.certification_manifest.live_evidence.length, 10);
    assert.equal(liveCandidate.certification_manifest.subject_sha256, KIMI_CODING_PROVIDER_RECIPE.recipe_sha256);
    assert.equal(liveCandidate.certification_manifest.package_version, '1.3.0');
    assert.equal(liveCandidate.certification_manifest.pi_version, '0.80.6');
    assert.equal(liveCandidate.certification_manifest.issued_at, KIMI_CODING_ISSUED_AT);
    assert.equal(liveCandidate.certification_manifest.expires_at, KIMI_CODING_EXPIRES_AT);

    const missingProofs: KimiCodingQualificationInput = {
      ...liveInput,
      entitlement_proof: null,
      role_witnesses: liveInput.role_witnesses.filter((witness) => witness.role !== 'extract'),
    };
    const blocked = evaluateKimiCodingQualification(missingProofs);
    assert.equal(blocked.certification_ready, false);
    assertIncludesAll(issueCodes(blocked), ['KIMI_CODING_ENTITLEMENT_EVIDENCE_REQUIRED', 'KIMI_CODING_MISSING_ROLE']);
  });

  void it('rejects substitution, old divergent profile, route-token forgery, OpenRouter, and fallback negatives', async () => {
    const fixture = await readFixture();
    const fixtureCases = new Map(fixture.negative_cases.map((entry) => [entry.case_id, entry]));

    const substitutionInput = makeTrustedLiveW3Input();
    const extract = mustRole(substitutionInput, 'extract');
    setField(extract, 'observed_profile', makeKimiCodingObservedEvidence(extract.request_profile, {
      requested_model_id: 'kimi-for-coding',
      executed_model_id: 'kimi-for-coding',
      system_prompt_sha256: extract.observed_profile.system_prompt_sha256,
    }));
    assertIncludesFixtureCase(fixtureCases, 'substitution-extract-base', issueCodes(evaluateKimiCodingQualification(substitutionInput)));

    const divergentInput = makeTrustedLiveW3Input();
    const parent = mustRole(divergentInput, 'parent');
    setField(divergentInput.route, 'api', 'anthropic-messages');
    setField(divergentInput.route, 'system_prompt_profile', 'anthropic-autopilot-sanitized.v1');
    setField(parent.request_profile, 'model_id', 'K3');
    setField(parent.request_profile, 'model', 'kimi-coding/K3');
    setField(parent.request_profile, 'api', 'anthropic-messages');
    setField(parent.request_profile, 'system_prompt_profile', 'anthropic-autopilot-sanitized.v1');
    setField(parent.request_profile, 'context_window', 262144);
    setField(parent.request_profile, 'input_modalities', ['image', 'text']);
    setField(parent.observed_profile, 'requested_model_id', 'K3');
    setField(parent.observed_profile, 'executed_model_id', 'K3');
    setField(parent.observed_profile, 'api', 'anthropic-messages');
    setField(parent.observed_profile, 'system_prompt_profile', 'anthropic-autopilot-sanitized.v1');
    assertIncludesFixtureCase(fixtureCases, 'old-divergent-anthropic-profile', issueCodes(evaluateKimiCodingQualification(divergentInput)));

    const tokenShapeInput = makeTrustedLiveW3Input();
    setField(tokenShapeInput.route, 'auth_class', 'api-key');
    if (tokenShapeInput.entitlement_proof !== null) setField(tokenShapeInput.entitlement_proof, 'auth_class', 'api-key');
    if (tokenShapeInput.billing_route_proof !== null) setField(tokenShapeInput.billing_route_proof, 'auth_class', 'api-key');
    assertIncludesAll(issueCodes(evaluateKimiCodingQualification(tokenShapeInput)), [
      'KIMI_CODING_GENERIC_API_KEY_FORBIDDEN',
      'KIMI_CODING_PLAN_TOKEN_PROOF_REQUIRED',
    ]);

    const openRouterInput = makeTrustedLiveW3Input();
    setField(openRouterInput, 'gateway_id', 'openrouter');
    setField(openRouterInput, 'no_fallback', false);
    setField(openRouterInput.route, 'auth_source', 'environment');
    assertIncludesAll(issueCodes(evaluateKimiCodingQualification(openRouterInput)), [
      'KIMI_CODING_AUTH_SOURCE_FORBIDDEN',
      'KIMI_CODING_NO_FALLBACK_REQUIRED',
      'KIMI_CODING_ROUTE_FORBIDDEN',
    ]);
  });

  void it('rejects wrong API/model/thinking/context/tool, evidence-ref, expiry, and hash forgeries', async () => {
    const cases: readonly {
      readonly name: string;
      readonly mutate: (input: KimiCodingQualificationInput) => void;
      readonly expected: readonly KimiCodingQualificationIssueCode[];
    }[] = [
      {
        name: 'wrong API',
        mutate: (input) => setField(mustRole(input, 'parent').request_profile, 'api', 'anthropic-messages'),
        expected: ['KIMI_CODING_API_MISMATCH', 'KIMI_CODING_OLD_DIVERGENT_PROFILE_FORBIDDEN'],
      },
      {
        name: 'wrong model',
        mutate: (input) => {
          const witness = mustRole(input, 'implement');
          setField(witness.request_profile, 'model_id', 'kimi-k3');
          setField(witness.request_profile, 'model', 'kimi-coding/kimi-k3');
          setField(witness.observed_profile, 'executed_model_id', 'kimi-k3');
        },
        expected: ['KIMI_CODING_OBSERVED_MODEL_MISMATCH'],
      },
      {
        name: 'wrong thinking',
        mutate: (input) => setField(mustRole(input, 'implement').request_profile, 'thinking', 'xhigh'),
        expected: ['KIMI_CODING_THINKING_MISMATCH'],
      },
      {
        name: 'wrong context',
        mutate: (input) => setField(mustRole(input, 'extract').request_profile, 'context_window', 256000),
        expected: ['KIMI_CODING_CONTEXT_MISMATCH'],
      },
      {
        name: 'wrong tool',
        mutate: (input) => setField(mustRole(input, 'fix').request_profile, 'tool_capability', 'tool-use-unsupported'),
        expected: ['KIMI_CODING_TOOL_MISMATCH'],
      },
      {
        name: 'missing digest',
        mutate: (input) => setField(mustRole(input, 'bughunt').evidence_refs[0] as object, 'sha256', null),
        expected: ['KIMI_CODING_EVIDENCE_DIGEST_REQUIRED'],
      },
      {
        name: 'untrusted evidence ref',
        mutate: (input) => setField(mustRole(input, 'validate').evidence_refs[0] as object, 'uri', 'file://phase37/kimi-coding/live/execution/validate.json'),
        expected: ['KIMI_CODING_EVIDENCE_REF_UNTRUSTED'],
      },
      {
        name: 'unauthenticated witness',
        mutate: (input) => setField(mustRole(input, 'adjudicate'), 'authenticated', false),
        expected: ['KIMI_CODING_AUTHENTICATED_W3_EXECUTION_REQUIRED'],
      },
    ];

    for (const testCase of cases) {
      const input = makeTrustedLiveW3Input();
      testCase.mutate(input);
      const evaluation = evaluateKimiCodingQualification(input);
      assert.equal(evaluation.certification_ready, false, testCase.name);
      assert.equal(evaluation.qualification_state, 'qualification-required', testCase.name);
      assertIncludesAll(issueCodes(evaluation), testCase.expected);
    }

    const artifact = await readArtifact();
    const expired = cloneReport(artifact);
    setField(expired.manifest_candidate.certification_manifest, 'expires_at', '2026-08-23T00:00:00.000Z');
    assertIncludesAll(reportIssueCodes(verifyKimiCodingOfflineQualificationReport(expired)), [
      'KIMI_CODING_MANIFEST_BINDING_MISMATCH',
      'KIMI_CODING_MANIFEST_HASH_MISMATCH',
      'KIMI_CODING_REPORT_HASH_MISMATCH',
    ]);

    const hashForgery = cloneReport(artifact);
    setField(hashForgery, 'report_sha256', digest('forged-report-hash'));
    assertIncludesAll(reportIssueCodes(verifyKimiCodingOfflineQualificationReport(hashForgery)), ['KIMI_CODING_REPORT_HASH_MISMATCH']);

    const requiredEvidenceForgery = cloneReport(artifact);
    setField(requiredEvidenceForgery.manifest_candidate.certification_manifest.required_evidence[0] as object, 'uri', 'witness-required://phase37/kimi-coding/forged');
    assertIncludesAll(reportIssueCodes(verifyKimiCodingOfflineQualificationReport(requiredEvidenceForgery)), [
      'KIMI_CODING_REQUIRED_EVIDENCE_MISMATCH',
      'KIMI_CODING_MANIFEST_HASH_MISMATCH',
      'KIMI_CODING_REPORT_HASH_MISMATCH',
    ]);
  });

  void it('contains no network authority and no secret-bearing fixture or artifact data', async () => {
    const source = await readText('../../src/core/roster/providers/kimi-coding.ts');
    assert.equal(/\bfetch\s*\(/u.test(source), false);
    assert.equal(/from ['"]node:https?['"]/u.test(source), false);
    assert.equal(/from ['"]undici['"]/u.test(source), false);
    assert.equal(/process\.env/u.test(source), false);

    const fixture = await readFixture();
    const artifact = await readArtifact();
    assertSecretFree(fixture, 'fixture');
    assertSecretFree(artifact, 'artifact');
    assertNoHttpEvidenceUris(fixture, 'fixture');
    assertNoHttpEvidenceUris(artifact, 'artifact');
  });
});

function mustPrecisionProfile(): typeof KIMI_CODING_PROVIDER_RECIPE.profile_templates[number] {
  const profile = KIMI_CODING_PROVIDER_RECIPE.profile_templates.find((candidate) => candidate.profile_id === 'precision');
  if (profile === undefined) throw new Error('missing precision profile');
  return profile;
}

async function readFixture(): Promise<ProviderFixture> {
  return JSON.parse(await readText('../fixtures/roster/providers/kimi-coding.v1.json')) as ProviderFixture;
}

async function readArtifact(): Promise<KimiCodingOfflineQualificationReport> {
  return JSON.parse(await readText('../../artifacts/qualification/phase37/kimi-coding.json')) as KimiCodingOfflineQualificationReport;
}

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readText(relativePath)) as Record<string, unknown>;
}

async function readText(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

function cloneInput(input: KimiCodingQualificationInput): KimiCodingQualificationInput {
  return structuredClone(input) as KimiCodingQualificationInput;
}

function cloneReport(report: KimiCodingOfflineQualificationReport): KimiCodingOfflineQualificationReport {
  return structuredClone(report) as KimiCodingOfflineQualificationReport;
}

function mustRole(input: KimiCodingQualificationInput, role: RosterRole): KimiCodingQualificationInput['role_witnesses'][number] {
  const witness = input.role_witnesses.find((candidate) => candidate.role === role);
  if (witness === undefined) throw new Error(`missing role witness ${role}`);
  return witness;
}

function makeTrustedLiveW3Input(): KimiCodingQualificationInput {
  const input = cloneInput(makeKimiCodingSyntheticQualificationInput());
  setField(input, 'evidence_source', 'live-post-w3-witness');
  if (input.entitlement_proof !== null) {
    setField(input.entitlement_proof, 'proof_id', 'w3-kimi-coding-plan-entitlement-proof');
    setField(input.entitlement_proof, 'evidence_ref', {
      ...input.entitlement_proof.evidence_ref,
      evidence_id: 'w3-kimi-coding-plan-entitlement-proof',
      uri: 'w3-evidence://phase37/kimi-coding/plan-entitlement/receipt.json',
      sha256: digest('w3-plan-entitlement'),
      byte_count: 4096,
    });
  }
  if (input.billing_route_proof !== null) {
    setField(input.billing_route_proof, 'proof_id', 'w3-kimi-coding-billing-route-proof');
    setField(input.billing_route_proof, 'evidence_ref', {
      ...input.billing_route_proof.evidence_ref,
      evidence_id: 'w3-kimi-coding-billing-route-proof',
      uri: 'w3-evidence://phase37/kimi-coding/billing-route/receipt.json',
      sha256: digest('w3-billing-route'),
      byte_count: 4096,
    });
  }
  for (const witness of input.role_witnesses) {
    setField(witness, 'witness_id', `w3-kimi-coding-${witness.role}-execution`);
    setField(witness, 'evidence_refs', witness.evidence_refs.map((ref) => ({
      ...ref,
      evidence_id: `w3-kimi-coding-exec-${witness.role}-proof`,
      uri: `w3-evidence://phase37/kimi-coding/execution/${witness.role}/receipt.json`,
      sha256: digest(`w3-exec-${witness.role}`),
      byte_count: 8192,
    })));
  }
  return input;
}

function setField(target: object, key: string, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

function digest(label: string): Digest {
  return canonicalSha256({ label });
}

function issueCodes(evaluation: ReturnType<typeof evaluateKimiCodingQualification>): readonly KimiCodingQualificationIssueCode[] {
  return evaluation.issues.map((issue) => issue.code);
}

function reportIssueCodes(issues: readonly ReturnType<typeof verifyKimiCodingOfflineQualificationReport>[number][]): readonly KimiCodingQualificationIssueCode[] {
  return issues.map((issue) => issue.code);
}

function assertIncludesAll(actual: readonly KimiCodingQualificationIssueCode[], expected: readonly KimiCodingQualificationIssueCode[]): void {
  for (const code of expected) {
    assert.equal(actual.includes(code), true, `expected ${code} in ${JSON.stringify(actual)}`);
  }
}

function assertIncludesFixtureCase(
  fixtureCases: ReadonlyMap<string, ProviderFixture['negative_cases'][number]>,
  caseId: string,
  actual: readonly KimiCodingQualificationIssueCode[],
): void {
  const fixtureCase = fixtureCases.get(caseId);
  if (fixtureCase === undefined) throw new Error(`missing fixture negative case ${caseId}`);
  assertIncludesAll(actual, fixtureCase.expected_issue_codes);
}

function assertSecretFree(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSecretFree(entry, `${path}[${String(index)}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/secret|password|credential/i.test(key) && key !== 'secret_free' && key !== 'secret_fields_present' && key !== 'secrets_included') {
      throw new Error(`secret-bearing key ${path}.${key}`);
    }
    assertSecretFree(nested, `${path}.${key}`);
  }
}

function assertNoHttpEvidenceUris(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoHttpEvidenceUris(entry, `${path}[${String(index)}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'uri' && typeof nested === 'string') {
      assert.equal(/^https?:\/\//u.test(nested), false, `${path}.uri must not require network`);
    }
    assertNoHttpEvidenceUris(nested, `${path}.${key}`);
  }
}
