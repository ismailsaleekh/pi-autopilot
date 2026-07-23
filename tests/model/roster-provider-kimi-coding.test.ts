import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { ROSTER_ROLE_ORDER, type RosterRole } from '../../src/core/roster/route-policies.ts';
import {
  KIMI_CODING_API,
  KIMI_CODING_AUTH_CLASS,
  KIMI_CODING_BASE_URL,
  KIMI_CODING_CACHE_POLICY,
  KIMI_CODING_LABELS,
  KIMI_CODING_PROVIDER_ID,
  KIMI_CODING_ROLE_TEMPLATES,
  KIMI_CODING_ROUTE_FACTS,
  KIMI_CODING_ROUTE_POLICY_ID,
  KIMI_CODING_ROUTE_POLICY_REVISION,
  KIMI_CODING_SYSTEM_PROMPT_PROFILE,
  allKimiCodingRequestProfiles,
  assertKimiCodingRoleTemplateCompleteness,
  buildKimiCodingQualification,
  exactKimiCodingRouteObservation,
  kimiCodingRequestProfileForRole,
  makeKimiCodingObservedEvidence,
  makeKimiCodingRoleEntitlementEvidence,
  substituteKimiCodingHighspeedModel,
  validateKimiCodingRouteObservation,
  type KimiCodingDiagnosticCode,
  type KimiCodingObservedRequestEvidence,
  type KimiCodingQualificationInput,
  type KimiCodingRouteObservation,
} from '../../src/core/roster/providers/kimi-coding.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '../fixtures/roster/providers/kimi-coding.v1.json');
const artifactPath = join(here, '../../artifacts/qualification/phase37/kimi-coding.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
const issuedAt = '2026-07-23T00:00:00.000Z';

void describe('D69 W4 Kimi Coding offline provider pack', () => {
  void it('admits only the exact Kimi Coding plan-token Anthropic-compatible route', () => {
    assert.equal(KIMI_CODING_ROUTE_FACTS.provider_id, KIMI_CODING_PROVIDER_ID);
    assert.equal(KIMI_CODING_ROUTE_FACTS.route_policy_id, KIMI_CODING_ROUTE_POLICY_ID);
    assert.equal(KIMI_CODING_ROUTE_FACTS.route_policy_revision, KIMI_CODING_ROUTE_POLICY_REVISION);
    assert.equal(KIMI_CODING_ROUTE_FACTS.base_url, KIMI_CODING_BASE_URL);
    assert.equal(KIMI_CODING_ROUTE_FACTS.api, KIMI_CODING_API);
    assert.equal(KIMI_CODING_ROUTE_FACTS.auth_class, KIMI_CODING_AUTH_CLASS);
    assert.deepEqual(KIMI_CODING_ROUTE_FACTS.allowed_auth_classes, ['api-key-plan-token']);
    assert.equal(KIMI_CODING_ROUTE_FACTS.allowed_auth_classes.includes('api-key' as never), false);
    assert.equal(KIMI_CODING_ROUTE_FACTS.plan_token_grants_generic_api_key, false);
    assert.equal(KIMI_CODING_ROUTE_FACTS.cache_policy, KIMI_CODING_CACHE_POLICY);
    assert.equal(KIMI_CODING_ROUTE_FACTS.system_prompt_profile, KIMI_CODING_SYSTEM_PROMPT_PROFILE);
    assert.deepEqual(KIMI_CODING_ROUTE_FACTS.request_headers, [{ name: 'User-Agent', value: 'KimiCLI/1.5' }]);
    assert.deepEqual(validateKimiCodingRouteObservation(exactKimiCodingRouteObservation()), []);

    assertIncludes(validateKimiCodingRouteObservation({ ...exactKimiCodingRouteObservation(), provider_id: 'openrouter' }), 'KIMI_CODING_ROUTE_FORBIDDEN');
    assertIncludes(validateKimiCodingRouteObservation({ ...exactKimiCodingRouteObservation(), provider_id: 'arbitrary-api-key' }), 'KIMI_CODING_ROUTE_FORBIDDEN');
    assertIncludes(validateKimiCodingRouteObservation({ ...exactKimiCodingRouteObservation(), base_url: 'https://openrouter.ai/api/v1' }), 'KIMI_CODING_ROUTE_FORBIDDEN');
    assertIncludes(validateKimiCodingRouteObservation({ ...exactKimiCodingRouteObservation(), api: 'openai-completions' }), 'KIMI_CODING_API_MISMATCH');
    assertIncludes(validateKimiCodingRouteObservation({ ...exactKimiCodingRouteObservation(), auth_class: 'api-key' }), 'KIMI_CODING_AUTH_FORBIDDEN');
    assertIncludes(validateKimiCodingRouteObservation({ ...exactKimiCodingRouteObservation(), auth_source: 'environment' }), 'KIMI_CODING_AUTH_FORBIDDEN');
    assertIncludes(validateKimiCodingRouteObservation({ ...exactKimiCodingRouteObservation(), cache_policy: 'none' }), 'KIMI_CODING_CACHE_MISMATCH');
    assertIncludes(validateKimiCodingRouteObservation({ ...exactKimiCodingRouteObservation(), system_prompt_profile: 'pi-default.v1' }), 'KIMI_CODING_PROMPT_MISMATCH');
  });

  void it('freezes K3/kimi-for-coding/highspeed role templates and substitutes highspeed only in the request profile', () => {
    assertKimiCodingRoleTemplateCompleteness();
    assert.equal(Object.isFrozen(KIMI_CODING_ROLE_TEMPLATES), true);
    assert.deepEqual(KIMI_CODING_ROLE_TEMPLATES.map((template) => template.role), ROSTER_ROLE_ORDER);
    assert.deepEqual(KIMI_CODING_ROLE_TEMPLATES.map((template) => template.api), ROSTER_ROLE_ORDER.map(() => 'anthropic-messages'));
    assert.equal(KIMI_CODING_LABELS.labels_rank_candidates, false);
    assert.equal(Object.hasOwn(KIMI_CODING_LABELS, 'rank'), false);

    const byRole = new Map(KIMI_CODING_ROLE_TEMPLATES.map((template) => [template.role, template]));
    assert.equal(must(byRole.get('parent')).declared_model_id, 'K3');
    assert.equal(must(byRole.get('implement')).declared_model_id, 'kimi-for-coding');
    assert.equal(must(byRole.get('extract')).declared_model_id, 'highspeed');
    assert.equal(substituteKimiCodingHighspeedModel('highspeed'), 'kimi-for-coding');
    assert.equal(substituteKimiCodingHighspeedModel('K3'), 'K3');

    const extractProfile = kimiCodingRequestProfileForRole('extract');
    assert.equal(extractProfile.declared_model_id, 'highspeed');
    assert.equal(extractProfile.model_id, 'kimi-for-coding');
    assert.equal(extractProfile.model, 'kimi-coding/kimi-for-coding');
    assert.equal(extractProfile.highspeed_substitution, true);

    for (const profile of allKimiCodingRequestProfiles()) {
      assert.equal(profile.api, 'anthropic-messages');
      assert.equal(profile.context_window, 262144);
      assert.equal(profile.max_output_tokens, 32768);
      assert.deepEqual(profile.input_modalities, ['image', 'text']);
      assert.deepEqual(profile.output_modalities, ['text']);
      assert.equal(profile.reasoning_capability, 'reasoning-supported');
      assert.equal(profile.tool_capability, 'tool-use-supported');
      assert.equal(profile.cache_policy, 'provider-default');
      assert.equal(profile.system_prompt_profile, 'anthropic-autopilot-sanitized.v1');
    }
  });

  void it('keeps the synthetic fixture and offline artifact non-certifying', () => {
    assert.equal(fixture['schema_version'], 'autopilot.kimi_coding_provider_fixture.v1');
    assert.equal(fixture['status'], 'synthetic-non-certifying');
    assert.deepEqual(fixture['route_facts'], KIMI_CODING_ROUTE_FACTS);
    assert.deepEqual(fixture['role_templates'], KIMI_CODING_ROLE_TEMPLATES);
    const fixtureReport = mustObject(fixture['synthetic_qualification_report']);
    assert.equal(fixtureReport['qualification_state'], 'qualification-required');
    assert.equal(fixtureReport['certifying'], false);
    assert.equal(fixtureReport['network_calls_performed'], false);
    assertIncludes(fixtureReport['diagnostics'] as readonly KimiCodingDiagnosticCode[], 'KIMI_CODING_SYNTHETIC_NON_CERTIFYING');

    assert.equal(artifact['schema_version'], 'autopilot.kimi_coding_qualification_artifact.v1');
    assert.equal(artifact['provider_id'], 'kimi-coding');
    assert.equal(artifact['qualification_state'], 'qualification-required');
    assert.equal(artifact['certifying'], false);
    assert.equal(artifact['launch_ready'], false);
    assert.equal(artifact['network_calls_performed'], false);
    assert.equal(artifact['synthetic_fixture_non_certifying'], true);
    const requiredLiveEvidence = artifact['required_live_evidence'] as readonly Record<string, unknown>[];
    assert.equal(requiredLiveEvidence.length, ROSTER_ROLE_ORDER.length * 2);
    assert.equal(requiredLiveEvidence.every((entry) => entry['accepted_synthetic_substitute'] === false), true);
    const offlineBuilderReport = mustObject(artifact['offline_builder_report']);
    assert.equal(offlineBuilderReport['qualification_state'], 'qualification-required');
    assertIncludes(offlineBuilderReport['diagnostics'] as readonly KimiCodingDiagnosticCode[], 'KIMI_CODING_MISSING_ROLE');
  });

  void it('requires role-complete live entitlement/billing and observed request/executed-model evidence', () => {
    const live = buildKimiCodingQualification(liveInput());
    assert.equal(live.qualification_state, 'w4-certified-ready');
    assert.equal(live.certifying, true);
    assert.equal(live.live_evidence_complete, true);
    assert.deepEqual(live.diagnostics, []);

    const synthetic = buildKimiCodingQualification({
      ...liveInput(),
      synthetic_fixture: true,
      observed_requests: liveInput().observed_requests.map((observed) => ({ ...observed, evidence_kind: 'synthetic-fixture' as const, observed_profile_sha256: observed.observed_profile_sha256 })),
      entitlements: liveInput().entitlements.map((entitlement) => ({ ...entitlement, evidence_kind: 'synthetic-fixture' as const })),
    });
    assert.equal(synthetic.qualification_state, 'qualification-required');
    assert.equal(synthetic.certifying, false);
    assertIncludes(synthetic.diagnostics, 'KIMI_CODING_SYNTHETIC_NON_CERTIFYING');
  });

  void it('fails closed for wrong route/API/thinking/context/auth/cache/prompt/tool facts and missing roles', () => {
    const cases: readonly {
      readonly name: string;
      readonly input: KimiCodingQualificationInput;
      readonly diagnostic: KimiCodingDiagnosticCode;
    }[] = [
      {
        name: 'wrong route',
        input: liveInput({ route: { ...exactKimiCodingRouteObservation(), route_policy_id: 'opencode-go-plan-v1' } }),
        diagnostic: 'KIMI_CODING_ROUTE_FORBIDDEN',
      },
      {
        name: 'wrong API',
        input: liveInput({ route: { ...exactKimiCodingRouteObservation(), api: 'openai-completions' } }),
        diagnostic: 'KIMI_CODING_API_MISMATCH',
      },
      {
        name: 'wrong thinking',
        input: liveInput({ observed_requests: replaceObserved('implement', { thinking: 'xhigh' }) }),
        diagnostic: 'KIMI_CODING_THINKING_MISMATCH',
      },
      {
        name: 'wrong context',
        input: liveInput({ observed_requests: replaceObserved('parent', { context_window: 128000 }) }),
        diagnostic: 'KIMI_CODING_CONTEXT_MISMATCH',
      },
      {
        name: 'wrong auth',
        input: liveInput({ route: { ...exactKimiCodingRouteObservation(), auth_class: 'api-key' } }),
        diagnostic: 'KIMI_CODING_AUTH_FORBIDDEN',
      },
      {
        name: 'wrong cache',
        input: liveInput({ observed_requests: replaceObserved('fix', { cache_policy: 'none' }) }),
        diagnostic: 'KIMI_CODING_CACHE_MISMATCH',
      },
      {
        name: 'wrong prompt',
        input: liveInput({ observed_requests: replaceObserved('validate', { system_prompt_profile: 'pi-default.v1' }) }),
        diagnostic: 'KIMI_CODING_PROMPT_MISMATCH',
      },
      {
        name: 'wrong tool facts',
        input: liveInput({ observed_requests: replaceObserved('bughunt', { tool_capability: 'tool-use-unsupported' }) }),
        diagnostic: 'KIMI_CODING_TOOL_MISMATCH',
      },
      {
        name: 'highspeed alias leaked into observed model',
        input: liveInput({ observed_requests: replaceObserved('extract', { requested_model_id: 'highspeed', executed_model_id: 'highspeed' }) }),
        diagnostic: 'KIMI_CODING_OBSERVED_MODEL_MISMATCH',
      },
      {
        name: 'missing role',
        input: liveInput({
          observed_requests: baseObserved().filter((observed) => observed.role !== 'adjudicate'),
          entitlements: baseEntitlements().filter((entitlement) => entitlement.role !== 'adjudicate'),
        }),
        diagnostic: 'KIMI_CODING_MISSING_ROLE',
      },
    ];

    for (const testCase of cases) {
      const report = buildKimiCodingQualification(testCase.input);
      assert.equal(report.qualification_state, 'qualification-required', testCase.name);
      assert.equal(report.certifying, false, testCase.name);
      assertIncludes(report.diagnostics, testCase.diagnostic, testCase.name);
    }
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected test value to exist');
  }
  return value;
}

function mustObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected object fixture value');
  }
  return value as Record<string, unknown>;
}

function assertIncludes(values: readonly KimiCodingDiagnosticCode[], expected: KimiCodingDiagnosticCode, message?: string): void {
  assert.equal(values.includes(expected), true, message ?? `expected ${expected}`);
}

function baseObserved(): readonly KimiCodingObservedRequestEvidence[] {
  return allKimiCodingRequestProfiles().map((profile) => makeKimiCodingObservedEvidence(profile));
}

function baseEntitlements(): ReturnType<typeof makeKimiCodingRoleEntitlementEvidence>[] {
  return ROSTER_ROLE_ORDER.map((role) => makeKimiCodingRoleEntitlementEvidence(role));
}

function liveInput(overrides: Partial<KimiCodingQualificationInput> = {}): KimiCodingQualificationInput {
  return {
    route: overrides.route ?? exactKimiCodingRouteObservation(),
    observed_requests: overrides.observed_requests ?? baseObserved(),
    entitlements: overrides.entitlements ?? baseEntitlements(),
    synthetic_fixture: overrides.synthetic_fixture ?? false,
    issued_at: overrides.issued_at ?? issuedAt,
  };
}

function replaceObserved(
  role: RosterRole,
  patch: Partial<Omit<KimiCodingObservedRequestEvidence, 'role' | 'observed_profile_sha256'>>,
): readonly KimiCodingObservedRequestEvidence[] {
  return baseObserved().map((observed) => {
    if (observed.role !== role) {
      return observed;
    }
    return makeKimiCodingObservedEvidence(kimiCodingRequestProfileForRole(role), patch);
  });
}
